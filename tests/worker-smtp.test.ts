/**
 * tests/worker-smtp.test.ts — the Workers SMTP transport (lib/email/worker-smtp.ts).
 *
 * 2026-11-03: every SMTP send from the Worker had failed since nodemailer 10
 * (PR #796). nodemailer still composes; the bytes go out over a wire
 * (cloudflare:sockets on Workers). These tests drive the transport against an
 * in-memory SMTP server through that wire:
 *   1. implicit TLS (465) and STARTTLS (587, with the upgrade on the same wire);
 *   2. AUTH PLAIN, and AUTH LOGIN when that is all the server offers;
 *   3. dot-stuffing, multi-line replies, partial and total recipient rejection;
 *   4. errors keep nodemailer's shape, so smtpFailureReason still separates a
 *      refused send (send_failed) from one the server may already hold
 *      (delivery_unknown, the connection dropped after the body went out);
 *   5. a server that never greets times out instead of hanging the route;
 *   6. outside Workers, createSmtpTransport is nodemailer's own transport;
 *   7. no mail path builds an SMTP transport with nodemailer directly any more.
 *
 * Run: node --conditions=react-server --import tsx tests/worker-smtp.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createWireTransport, createSmtpTransport, dotStuff, isWorkersRuntime, type SmtpWire, type WireFactory } from "../lib/email/worker-smtp";
import { smtpFailureReason } from "../lib/integrations/email-delivery-safety";

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${String((error as Error).stack || error).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

type ServerOptions = {
  starttls?: boolean;
  auth?: "PLAIN" | "LOGIN";
  password?: string;
  rejectRecipients?: string[];
  dropAfterData?: boolean;
  silent?: boolean;
};

/** An in-memory SMTP server behind the wire interface. */
class FakeServer {
  readonly commands: string[] = [];
  readonly events: string[] = [];
  data = "";
  tls = false;
  private inbox: Uint8Array[] = [];
  private waiting: ((chunk: Uint8Array | null) => void) | null = null;
  private closed = false;
  private pending = "";
  private inData = false;
  private loginStep = 0;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  constructor(private readonly opts: ServerOptions, secure: boolean) {
    this.tls = secure;
    if (!opts.silent) this.say("220 fixture.example ESMTP ready");
  }
  private say(text: string) {
    const chunk = this.encoder.encode(`${text}\r\n`);
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w(chunk);
    } else this.inbox.push(chunk);
  }
  private hangUp() {
    this.closed = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w(null);
    }
  }
  private ehlo() {
    const caps = ["250-fixture.example", "250-SIZE 35882577"];
    if (this.opts.starttls && !this.tls) caps.push("250-STARTTLS");
    caps.push(`250 AUTH ${this.opts.auth === "LOGIN" ? "LOGIN" : "LOGIN PLAIN XOAUTH2"}`);
    this.say(caps.join("\r\n"));
  }
  private line(line: string) {
    if (this.inData) {
      if (line === ".") {
        this.inData = false;
        if (this.opts.dropAfterData) return this.hangUp();
        this.say("250 2.0.0 OK fixture-queued");
      } else this.data += `${line}\r\n`;
      return;
    }
    if (this.loginStep === 1) {
      this.loginStep = 2;
      this.events.push(`login-user:${Buffer.from(line, "base64").toString()}`);
      return this.say("334 UGFzc3dvcmQ6");
    }
    if (this.loginStep === 2) {
      this.loginStep = 0;
      const ok = Buffer.from(line, "base64").toString() === (this.opts.password ?? "right");
      return this.say(ok ? "235 2.7.0 Accepted" : "535-5.7.8 Username and Password not accepted.\r\n535 5.7.8 https://support.example");
    }
    const verb = line.split(" ", 1)[0].toUpperCase();
    this.commands.push(verb === "AUTH" ? line.split(" ").slice(0, 2).join(" ") : verb);
    if (verb === "EHLO") return this.ehlo();
    if (verb === "STARTTLS") return this.say("220 2.0.0 Ready to start TLS");
    if (verb === "AUTH") {
      const [, mech, payload] = line.split(" ");
      if (mech === "LOGIN") {
        this.loginStep = 1;
        return this.say("334 VXNlcm5hbWU6");
      }
      const [, user, pass] = Buffer.from(payload, "base64").toString().split("\u0000");
      this.events.push(`plain-user:${user}`);
      return this.say(pass === (this.opts.password ?? "right") ? "235 2.7.0 Accepted" : "535-5.7.8 Username and Password not accepted.\r\n535 5.7.8 https://support.example");
    }
    if (verb === "MAIL") return this.say("250 2.1.0 OK");
    if (verb === "RCPT") {
      const to = line.slice(line.indexOf("<") + 1, line.indexOf(">"));
      return this.say((this.opts.rejectRecipients || []).includes(to) ? "550 5.1.1 No such user" : "250 2.1.5 OK");
    }
    if (verb === "DATA") {
      this.inData = true;
      return this.say("354 Go ahead");
    }
    if (verb === "QUIT") {
      this.say("221 2.0.0 closing");
      return this.hangUp();
    }
    this.say("502 5.5.1 Unrecognized command");
  }
  wire(): SmtpWire {
    return {
      read: () =>
        new Promise((resolve) => {
          if (this.inbox.length) return resolve(this.inbox.shift()!);
          if (this.closed) return resolve(null);
          this.waiting = resolve;
        }),
      write: async (bytes) => {
        this.pending += this.decoder.decode(bytes);
        for (let end; (end = this.pending.indexOf("\r\n")) >= 0; ) {
          const line = this.pending.slice(0, end);
          this.pending = this.pending.slice(end + 2);
          this.line(line);
        }
      },
      startTls: async () => {
        this.events.push("startTls");
        this.tls = true;
      },
      close: async () => {
        this.events.push("close");
        this.closed = true;
      },
    };
  }
}

function serverWire(opts: ServerOptions): { factory: WireFactory; server: () => FakeServer; asked: Array<{ port: number; secure: boolean }> } {
  let last: FakeServer | null = null;
  const asked: Array<{ port: number; secure: boolean }> = [];
  return {
    factory: async ({ port, secure }) => {
      asked.push({ port, secure });
      last = new FakeServer(opts, secure);
      return last.wire();
    },
    server: () => last!,
    asked,
  };
}

const message = {
  from: '"OASIS" <support@oasisai.work>',
  to: "client@example.test, Second <second@example.test>",
  cc: "approver@example.test",
  replyTo: "cc@oasisai.work",
  subject: "Your meeting reminder",
  text: "Line one\n.leading dot\nLine three",
  html: "<p>Hi</p>",
};
const gmail = (port: number) => ({ host: "smtp.gmail.com", port, secure: port === 465, auth: { user: "support@oasisai.work", pass: "right" } });

async function main() {
  console.log("worker smtp transport:");

  await check("465: implicit TLS, AUTH PLAIN, every recipient, the composed message delivered", async () => {
    const wire = serverWire({});
    const info = await createWireTransport(gmail(465), wire.factory).sendMail(message);
    assert.deepEqual(wire.asked, [{ port: 465, secure: true }]);
    const server = wire.server();
    assert.deepEqual(server.commands, ["EHLO", "AUTH PLAIN", "MAIL", "RCPT", "RCPT", "RCPT", "DATA", "QUIT"]);
    assert.deepEqual(info.accepted, ["client@example.test", "second@example.test", "approver@example.test"]);
    assert.deepEqual(info.rejected, []);
    assert.ok(info.messageId.startsWith("<") && info.messageId.endsWith(">"), "nodemailer still mints the Message-ID");
    assert.match(server.data, /^Subject: Your meeting reminder\r$/m);
    assert.match(server.data, /^Reply-To: cc@oasisai\.work\r$/m);
    assert.equal(server.events.includes("startTls"), false, "no upgrade on implicit TLS");
  });

  await check("587: STARTTLS upgrades the same wire, then EHLO again before AUTH", async () => {
    const wire = serverWire({ starttls: true });
    await createWireTransport(gmail(587), wire.factory).sendMail(message);
    assert.deepEqual(wire.asked, [{ port: 587, secure: false }]);
    assert.deepEqual(wire.server().commands.slice(0, 4), ["EHLO", "STARTTLS", "EHLO", "AUTH PLAIN"]);
    assert.ok(wire.server().events.includes("startTls"));
  });

  await check("587 without STARTTLS on offer is refused, never sent in the clear", async () => {
    const wire = serverWire({ starttls: false });
    await assert.rejects(createWireTransport(gmail(587), wire.factory).sendMail(message), (e: Error & { code?: string }) => {
      assert.equal(e.code, "ETLS");
      assert.equal(smtpFailureReason(e), "send_failed");
      return true;
    });
    assert.equal(wire.server().commands.includes("AUTH PLAIN"), false, "credentials never cross an unencrypted wire");
  });

  await check("AUTH LOGIN when that is the only mechanism offered", async () => {
    const wire = serverWire({ auth: "LOGIN" });
    await createWireTransport(gmail(465), wire.factory).verify();
    assert.ok(wire.server().commands.includes("AUTH LOGIN"));
    assert.ok(wire.server().events.includes("login-user:support@oasisai.work"));
  });

  await check("a wrong password is EAUTH 535 on AUTH: send_failed", async () => {
    const wire = serverWire({ password: "other" });
    await assert.rejects(createWireTransport(gmail(465), wire.factory).sendMail(message), (e: Error & { code?: string; command?: string; responseCode?: number }) => {
      assert.equal(e.code, "EAUTH");
      assert.equal(e.command, "AUTH");
      assert.equal(e.responseCode, 535, "the multi-line 535 reply is read whole");
      assert.equal(smtpFailureReason(e), "send_failed");
      return true;
    });
    assert.ok(wire.server().events.includes("close"), "the wire is closed on failure");
  });

  await check("dot-stuffing: a body line starting with '.' is doubled and the message ends CRLF.CRLF", () => {
    const out = new TextDecoder().decode(dotStuff(new TextEncoder().encode(".first\r\nmid\r\n.second\r\n")));
    assert.equal(out, "..first\r\nmid\r\n..second\r\n.\r\n");
    assert.equal(new TextDecoder().decode(dotStuff(new TextEncoder().encode("no newline"))), "no newline\r\n.\r\n");
  });

  await check("dot-stuffing a 32 MB message allocates one exact-size byte array (CodeRabbit #801)", () => {
    const size = 32 * 1024 * 1024;
    const big = new Uint8Array(size).fill(0x41);
    for (let i = 0; i + 3 < size; i += 76) { big[i] = 0x0d; big[i + 1] = 0x0a; big[i + 2] = 0x2e; }
    let dottedLines = 0;
    for (let i = 0; i < size; i++) {
      if (big[i] === 0x2e && (i === 0 || (i >= 2 && big[i - 1] === 0x0a && big[i - 2] === 0x0d))) dottedLines++;
    }
    const endsWithCrlf = big[size - 2] === 0x0d && big[size - 1] === 0x0a;
    const before = process.memoryUsage().heapUsed;
    const out = dotStuff(big);
    assert.ok(dottedLines > 400_000, "the fixture really has many dotted lines");
    assert.equal(out.length, size + dottedLines + (endsWithCrlf ? 0 : 2) + 3, "one extra dot per dotted line, then CRLF . CRLF");
    assert.ok(process.memoryUsage().heapUsed - before < 64 * 1024 * 1024, "no per-byte JS array on the heap");
  });

  await check("a body line starting with '.' reaches the server dot-stuffed, so it can never end the message early", async () => {
    const wire = serverWire({});
    await createWireTransport(gmail(465), wire.factory).sendMail(message);
    assert.match(wire.server().data, /^\.\.leading dot\r$/m, "the fake keeps raw wire lines: the extra dot is there");
  });

  await check("one rejected recipient: the rest still receive it", async () => {
    const wire = serverWire({ rejectRecipients: ["second@example.test"] });
    const info = await createWireTransport(gmail(465), wire.factory).sendMail(message);
    assert.deepEqual(info.rejected, ["second@example.test"]);
    assert.deepEqual(info.accepted, ["client@example.test", "approver@example.test"]);
  });

  await check("every recipient rejected: EENVELOPE with the server's code, nothing sent", async () => {
    const wire = serverWire({ rejectRecipients: ["client@example.test", "second@example.test", "approver@example.test"] });
    await assert.rejects(createWireTransport(gmail(465), wire.factory).sendMail(message), (e: Error & { code?: string; responseCode?: number }) => {
      assert.equal(e.code, "EENVELOPE");
      assert.equal(e.responseCode, 550);
      assert.equal(smtpFailureReason(e), "send_failed");
      return true;
    });
    assert.equal(wire.server().commands.includes("DATA"), false);
  });

  await check("a drop after the body went out is delivery_unknown, never a retryable refusal", async () => {
    const wire = serverWire({ dropAfterData: true });
    await assert.rejects(createWireTransport(gmail(465), wire.factory).sendMail(message), (e: Error & { code?: string; command?: string; responseCode?: number }) => {
      assert.equal(e.command, "DATA");
      assert.equal(e.responseCode, undefined);
      assert.equal(smtpFailureReason(e), "delivery_unknown", "the server may hold the message: a resend could duplicate it");
      return true;
    });
  });

  await check("a server that never greets times out on CONN: send_failed, no hang", async () => {
    const wire = serverWire({ silent: true });
    const started = Date.now();
    await assert.rejects(
      createWireTransport({ ...gmail(465), greetingTimeout: 150 }, wire.factory).sendMail(message),
      (e: Error & { code?: string; command?: string }) => {
        assert.equal(e.code, "ETIMEDOUT");
        assert.equal(e.command, "CONN");
        assert.equal(smtpFailureReason(e), "send_failed");
        return true;
      },
    );
    assert.ok(Date.now() - started < 2_000);
  });

  await check("outside Workers: nodemailer's own transport, so existing test stubs keep working", async () => {
    assert.equal(isWorkersRuntime(), false);
    const transport = await createSmtpTransport(gmail(587));
    assert.equal(typeof transport.sendMail, "function");
    assert.equal(typeof (transport as unknown as { transporter?: unknown }).transporter, "object", "a nodemailer Mail instance");
  });

  await check("no mail path builds an SMTP transport with nodemailer directly any more", () => {
    const roots = ["lib", "app"];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry) && !path.replace(/\\/g, "/").endsWith("lib/email/worker-smtp.ts")) {
          if (/nodemailer[\w.]*\.createTransport\(/.test(readFileSync(path, "utf8"))) offenders.push(path);
        }
      }
    };
    roots.forEach(walk);
    assert.deepEqual(offenders, [], "every SMTP sender goes through createSmtpTransport");
  });

  console.log(`worker smtp: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
