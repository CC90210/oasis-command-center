/**
 * worker-smtp.ts — the one SMTP transport every mail path in the app uses.
 *
 * WHY THIS EXISTS (2026-11-03). Every SMTP send from the Cloudflare Worker had
 * failed since the 2026-11-02 dependency patch (PR #796) moved nodemailer from
 * 9.0.1 to 10.1.7: meeting reminders, host alerts, no-show follow-ups, funnel
 * welcome mail, invoices and e-sign all answered "Connection closed
 * unexpectedly". Probed in the real Workers runtime (a temporary preview
 * account, fake credentials):
 *   - nodemailer 9.0.1 reaches Gmail's AUTH on 587 and 465;
 *   - nodemailer 10.0.6, 10.0.11 and 10.1.7 fail on both ports. On 587 the
 *     STARTTLS upgrade over node:net/node:tls closes the plain socket the way
 *     Workers documents for startTls(); 465 fails to connect at all.
 *   - cloudflare:sockets reaches AUTH on 465 (secureTransport "on") and on 587
 *     (secureTransport "starttls" + startTls()).
 * Every release that fixes GHSA-v53p-9fqp-m79j is 10.0.6 or later, so going
 * back to 9.x would knowingly reopen that advisory on every send.
 *
 * So nodemailer still BUILDS each message (streamTransport, no network: the
 * same headers, encodings and envelope as before), and on Workers the bytes go
 * out over cloudflare:sockets. Under plain Node (tests, local scripts) the
 * transport is nodemailer's own, unchanged, which also keeps every test stub of
 * nodemailer.createTransport working.
 *
 * Errors keep nodemailer's shape (code, command, responseCode, response) so
 * lib/integrations/email-delivery-safety.ts smtpFailureReason still tells a
 * refused send ("send_failed") from one that may have been delivered
 * ("delivery_unknown": the connection dropped after the message body went out).
 */
import "server-only";

export type SmtpOptions = {
  host?: string;
  port?: number;
  /** nodemailer's well-known shorthand; only "gmail" is used here. */
  service?: string;
  secure?: boolean;
  requireTLS?: boolean;
  auth: { user: string; pass: string };
  connectionTimeout?: number;
  greetingTimeout?: number;
  socketTimeout?: number;
  /** EHLO name. */
  name?: string;
  /** Any other nodemailer SMTP option (tls, ...): honoured by nodemailer under
   * Node; cloudflare:sockets has no equivalent, so the Workers path ignores it. */
  [option: string]: unknown;
};

type ResolvedSmtp = SmtpOptions & { host: string; port: number };

/** Fill host/port from the "gmail" shorthand; refuse an options object with neither. */
export function resolveSmtpOptions(opts: SmtpOptions): ResolvedSmtp {
  if (opts.host && opts.port) return opts as ResolvedSmtp;
  if (!opts.host && String(opts.service || "").toLowerCase() === "gmail") {
    return { ...opts, host: "smtp.gmail.com", port: opts.port ?? 465, secure: opts.secure ?? (opts.port ?? 465) === 465 };
  }
  throw new SmtpError("SMTP options need a host and port (or service: gmail)", "ECONFIG", "CONN");
}

// The message options every caller passes straight to nodemailer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SmtpMessage = Record<string, any>;

export type SentInfo = {
  messageId: string;
  envelope: { from: string | false; to: string[] };
  accepted: string[];
  rejected: string[];
  response: string;
};

export type SmtpTransport = {
  sendMail(message: SmtpMessage): Promise<SentInfo>;
  verify(): Promise<true>;
  /** Pooled nodemailer transports need it; each Workers send opens and closes its own wire. */
  close(): void;
};

/** One duplex byte pipe to an SMTP server, with an in-place TLS upgrade. */
export type SmtpWire = {
  read(): Promise<Uint8Array | null>;
  write(bytes: Uint8Array): Promise<void>;
  startTls(): Promise<void>;
  close(): Promise<void>;
};

export type WireFactory = (opts: { host: string; port: number; secure: boolean }) => Promise<SmtpWire>;

export class SmtpError extends Error {
  code: string;
  command: string;
  responseCode?: number;
  response?: string;
  constructor(message: string, code: string, command: string, responseCode?: number, response?: string) {
    super(message);
    this.name = "SmtpError";
    this.code = code;
    this.command = command;
    if (responseCode !== undefined) this.responseCode = responseCode;
    if (response !== undefined) this.response = response;
  }
}

const CRLF = "\r\n";
const DEFAULT_CONNECTION_TIMEOUT = 10_000;
const DEFAULT_SOCKET_TIMEOUT = 20_000;

/** True inside the Cloudflare Workers runtime. */
export function isWorkersRuntime(): boolean {
  return typeof navigator !== "undefined" && (navigator as { userAgent?: string }).userAgent === "Cloudflare-Workers";
}

/** Bundler-opaque import: neither webpack nor OpenNext's esbuild may try to
 * resolve the Workers built-in at build time (same reason as
 * lib/forms/native-raster.ts). */
async function loadModule(specifier: string): Promise<unknown> {
  return import(/* webpackIgnore: true */ specifier);
}

type CfSocket = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  startTls(): CfSocket;
  close(): Promise<void>;
};

/** The Workers wire: cloudflare:sockets, implicit TLS or STARTTLS. */
export const cloudflareWire: WireFactory = async ({ host, port, secure }) => {
  const { connect } = (await loadModule("cloudflare:sockets")) as {
    connect(address: { hostname: string; port: number }, options: { secureTransport: "on" | "starttls" }): CfSocket;
  };
  let socket = connect({ hostname: host, port }, { secureTransport: secure ? "on" : "starttls" });
  let reader = socket.readable.getReader();
  let writer = socket.writable.getWriter();
  return {
    async read() {
      const { value, done } = await reader.read();
      return done ? null : value ?? new Uint8Array();
    },
    async write(bytes) {
      await writer.write(bytes);
    },
    async startTls() {
      // Workers closes the plain socket as part of startTls(); every reader
      // and writer must be released first and rebuilt on the secure socket.
      reader.releaseLock();
      writer.releaseLock();
      socket = socket.startTls();
      reader = socket.readable.getReader();
      writer = socket.writable.getWriter();
    },
    async close() {
      try {
        await socket.close();
      } catch {
        // already closed by the server: nothing left to release
      }
    },
  };
};

type Reply = { code: number; lines: string[]; text: string };

/** One SMTP session over a wire: line-buffered replies with per-reply timeouts. */
class Session {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  constructor(private readonly wire: SmtpWire, private readonly socketTimeout: number) {}

  private withTimeout<T>(promise: Promise<T>, ms: number, command: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SmtpError(`Timed out waiting for the server (${command})`, "ETIMEDOUT", command)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  private takeReply(): Reply | null {
    const lines: string[] = [];
    let rest = this.buffer;
    for (;;) {
      const end = rest.indexOf(CRLF);
      if (end < 0) return null;
      const line = rest.slice(0, end);
      rest = rest.slice(end + 2);
      lines.push(line);
      // "250-..." continues a multi-line reply; "250 ..." or a bare "250" ends it.
      if (/^\d{3}(?: |$)/.test(line)) {
        this.buffer = rest;
        return { code: Number(line.slice(0, 3)), lines, text: lines.join("\n") };
      }
    }
  }

  async reply(command: string, ms = this.socketTimeout): Promise<Reply> {
    const read = async (): Promise<Reply> => {
      for (;;) {
        const ready = this.takeReply();
        if (ready) return ready;
        const chunk = await this.wire.read();
        if (chunk === null) throw new SmtpError("Connection closed unexpectedly", "ECONNECTION", command);
        this.buffer += this.decoder.decode(chunk, { stream: true });
      }
    };
    return this.withTimeout(read(), ms, command);
  }

  async send(line: string): Promise<void> {
    await this.wire.write(this.encoder.encode(line + CRLF));
  }

  async command(line: string, command: string, expect: number[], code: string): Promise<Reply> {
    await this.send(line);
    const reply = await this.reply(command);
    if (!expect.includes(reply.code)) {
      throw new SmtpError(`${command} rejected: ${reply.lines[reply.lines.length - 1]}`, code, command, reply.code, reply.text);
    }
    return reply;
  }

  async writeBytes(bytes: Uint8Array): Promise<void> {
    await this.wire.write(bytes);
  }

  async startTls(): Promise<void> {
    this.buffer = "";
    await this.wire.startTls();
  }
}

/** RFC 5321 4.5.2 dot-stuffing on bytes, ending with CRLF . CRLF. */
export function dotStuff(message: Uint8Array): Uint8Array {
  const out: number[] = [];
  let lineStart = true;
  for (let i = 0; i < message.length; i++) {
    const byte = message[i];
    if (lineStart && byte === 0x2e) out.push(0x2e);
    out.push(byte);
    lineStart = byte === 0x0a && i > 0 && message[i - 1] === 0x0d;
  }
  const endsWithCrlf = out.length >= 2 && out[out.length - 2] === 0x0d && out[out.length - 1] === 0x0a;
  if (!endsWithCrlf) out.push(0x0d, 0x0a);
  out.push(0x2e, 0x0d, 0x0a);
  return Uint8Array.from(out);
}

function capabilities(reply: Reply): string[] {
  return reply.lines.slice(1).map((line) => line.slice(4).trim().toUpperCase());
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** Greeting, EHLO, STARTTLS when needed, AUTH. Leaves the session ready for MAIL FROM. */
async function openSession(opts: ResolvedSmtp, wireFactory: WireFactory): Promise<{ session: Session; wire: SmtpWire }> {
  const secure = opts.secure === true || opts.port === 465;
  const connectionTimeout = opts.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT;
  const socketTimeout = opts.socketTimeout ?? DEFAULT_SOCKET_TIMEOUT;
  let wire: SmtpWire;
  try {
    wire = await wireFactory({ host: opts.host, port: opts.port, secure });
  } catch (error) {
    throw new SmtpError(`Could not connect to ${opts.host}:${opts.port}: ${error instanceof Error ? error.message : String(error)}`, "ECONNECTION", "CONN");
  }
  const session = new Session(wire, socketTimeout);
  try {
    const greeting = await session.reply("CONN", opts.greetingTimeout ?? connectionTimeout);
    if (greeting.code !== 220) {
      throw new SmtpError(`Unexpected greeting: ${greeting.lines[0]}`, "EPROTOCOL", "CONN", greeting.code, greeting.text);
    }
    const name = opts.name || "localhost";
    let ehlo = await session.command(`EHLO ${name}`, "EHLO", [250], "EPROTOCOL");
    if (!secure) {
      const offersStartTls = capabilities(ehlo).includes("STARTTLS");
      if (!offersStartTls) {
        if (opts.requireTLS !== false) {
          throw new SmtpError("The server does not offer STARTTLS", "ETLS", "EHLO", ehlo.code, ehlo.text);
        }
      } else {
        await session.command("STARTTLS", "STARTTLS", [220], "ETLS");
        await session.startTls();
        ehlo = await session.command(`EHLO ${name}`, "EHLO", [250], "EPROTOCOL");
      }
    }
    const auth = capabilities(ehlo).find((cap) => cap.startsWith("AUTH")) || "";
    if (auth.includes("PLAIN") || !auth.includes("LOGIN")) {
      await session.command(`AUTH PLAIN ${b64(`\u0000${opts.auth.user}\u0000${opts.auth.pass}`)}`, "AUTH", [235], "EAUTH");
    } else {
      await session.command("AUTH LOGIN", "AUTH", [334], "EAUTH");
      await session.command(b64(opts.auth.user), "AUTH", [334], "EAUTH");
      await session.command(b64(opts.auth.pass), "AUTH", [235], "EAUTH");
    }
    return { session, wire };
  } catch (error) {
    await wire.close();
    throw error;
  }
}

async function quit(session: Session, wire: SmtpWire): Promise<void> {
  try {
    await session.send("QUIT");
  } catch {
    // the server may already have gone; the session is over either way
  }
  await wire.close();
}

type Composed = { envelope: { from: string | false; to: string[] }; raw: Uint8Array; messageId: string };

type NodemailerLike = { createTransport(options: object): unknown };

/** nodemailer's namespace or its default export: tests stub the module as a
 * bare { createTransport } object, real ESM exposes it on both. */
async function loadNodemailer(): Promise<NodemailerLike> {
  const mod = (await import("nodemailer")) as unknown as NodemailerLike & { default?: NodemailerLike };
  return typeof mod.createTransport === "function" ? mod : (mod.default as NodemailerLike);
}

async function compose(message: SmtpMessage): Promise<Composed> {
  const nodemailer = await loadNodemailer();
  const builder = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" }) as {
    sendMail(message: SmtpMessage): Promise<unknown>;
  };
  const info = (await builder.sendMail(message)) as unknown as {
    envelope: { from: string | false; to: string[] };
    message: Buffer;
    messageId: string;
  };
  return {
    envelope: { from: info.envelope.from, to: [...info.envelope.to] },
    raw: new Uint8Array(info.message),
    messageId: info.messageId || "",
  };
}

/** The Workers transport: compose with nodemailer, send over a wire. */
export function createWireTransport(options: SmtpOptions, wireFactory: WireFactory = cloudflareWire): SmtpTransport {
  const opts = resolveSmtpOptions(options);
  return {
    close() {
      // nothing pooled: every send and verify closes its own wire
    },
    async verify() {
      const { session, wire } = await openSession(opts, wireFactory);
      await quit(session, wire);
      return true;
    },
    async sendMail(message) {
      const composed = await compose(message);
      if (!composed.envelope.to.length) {
        throw new SmtpError("No recipients defined", "EENVELOPE", "RCPT TO");
      }
      const { session, wire } = await openSession(opts, wireFactory);
      try {
        await session.command(`MAIL FROM:<${composed.envelope.from || ""}>`, "MAIL FROM", [250], "EENVELOPE");
        const accepted: string[] = [];
        const rejected: string[] = [];
        let lastRejection: Reply | null = null;
        for (const to of composed.envelope.to) {
          await session.send(`RCPT TO:<${to}>`);
          const reply = await session.reply("RCPT TO");
          if (reply.code === 250 || reply.code === 251) accepted.push(to);
          else {
            rejected.push(to);
            lastRejection = reply;
          }
        }
        if (!accepted.length) {
          throw new SmtpError(
            `Every recipient was rejected: ${lastRejection?.lines[lastRejection.lines.length - 1] ?? ""}`,
            "EENVELOPE",
            "RCPT TO",
            lastRejection?.code,
            lastRejection?.text,
          );
        }
        await session.command("DATA", "DATA", [354], "EMESSAGE");
        await session.writeBytes(dotStuff(composed.raw));
        // From here a dropped connection means the server may have the message:
        // command "DATA" without a responseCode reads as delivery_unknown.
        const done = await session.reply("DATA");
        if (done.code !== 250) {
          throw new SmtpError(`Message rejected: ${done.lines[done.lines.length - 1]}`, "EMESSAGE", "DATA", done.code, done.text);
        }
        await quit(session, wire);
        return { messageId: composed.messageId, envelope: composed.envelope, accepted, rejected, response: done.lines[done.lines.length - 1] };
      } catch (error) {
        await wire.close();
        throw error;
      }
    },
  };
}

/**
 * Drop-in for nodemailer.createTransport(smtpOptions): the Workers transport on
 * Cloudflare, nodemailer's own everywhere else.
 */
export async function createSmtpTransport(opts: SmtpOptions): Promise<SmtpTransport> {
  if (isWorkersRuntime()) return createWireTransport(opts);
  const nodemailer = await loadNodemailer();
  return nodemailer.createTransport(opts) as SmtpTransport;
}
