/** Real mail libraries, synthetic messages and an in-memory SMTP peer. No network or credentials. */
import assert from "node:assert/strict";
import "./helpers/deny-network.mjs";
import { createRequire } from "node:module";
import { Duplex } from "node:stream";
import { connect, Socket } from "node:net";
import nodemailer, { createTransport } from "nodemailer";
import { simpleParser } from "mailparser";
import { ImapFlow } from "imapflow";

const require = createRequire(import.meta.url);
const message = {
  from: '"OASIS fixture" <sender@example.test>',
  to: "client@example.test",
  cc: "approver@example.test",
  bcc: "archive@example.test",
  replyTo: "support@example.test",
  subject: "Résumé — fixture",
  text: "Synthetic text.\nNo external delivery.",
  html: "<p>Synthetic text.</p>",
  headers: { "List-Unsubscribe": "<https://example.test/unsubscribe?fixture=1>" },
  attachments: [{ filename: "fixture.pdf", content: Buffer.from("%PDF-fixture-only"), contentType: "application/pdf" }],
};

class SmtpPeer extends Duplex {
  buffer = "";
  inData = false;
  data = "";
  commands = [];
  constructor(rejectRecipient = false) { super(); this.rejectRecipient = rejectRecipient; }
  _read() {}
  answer(text) { queueMicrotask(() => this.push(`${text}\r\n`)); }
  _write(chunk, _encoding, callback) {
    this.buffer += chunk.toString();
    for (let end; (end = this.buffer.indexOf("\r\n")) >= 0;) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      if (this.inData) {
        if (line === ".") { this.inData = false; this.answer("250 2.0.0 fixture-accepted"); }
        else this.data += `${line}\r\n`;
        continue;
      }
      const verb = line.split(" ", 1)[0];
      this.commands.push(verb);
      if (verb === "EHLO") this.answer("250-fixture\r\n250 PIPELINING");
      else if (verb === "MAIL") this.answer("250 2.1.0 sender accepted");
      else if (verb === "RCPT") this.answer(this.rejectRecipient ? "550 5.1.1 fixture rejected" : "250 2.1.5 recipient accepted");
      else if (verb === "DATA") { this.inData = true; this.answer("354 send fixture"); }
      else if (verb === "QUIT") { this.answer("221 bye"); queueMicrotask(() => this.push(null)); }
      else { callback(new Error(`unexpected fixture SMTP command: ${verb}`)); return; }
    }
    callback();
  }
  setTimeout() { return this; }
  setKeepAlive() { return this; }
  setNoDelay() { return this; }
}

function smtpTransport(rejectRecipient = false) {
  const peer = new SmtpPeer(rejectRecipient);
  let sockets = 0;
  const transport = createTransport({
    host: "smtp.fixture.invalid", port: 2525, secure: false, ignoreTLS: true,
    connectionTimeout: 1000, greetingTimeout: 1000, socketTimeout: 1000,
    getSocket(_options, callback) {
      sockets++;
      callback(null, { connection: peer });
      setImmediate(() => peer.answer("220 fixture ESMTP"));
    },
  });
  return { peer, transport, sockets: () => sockets };
}

async function main() {
  assert.throws(() => connect({ host: "smtp.fixture.invalid", port: 25 }), /fixture_network_forbidden/);
  assert.throws(() => new Socket().connect({ host: "smtp.fixture.invalid", port: 25 }), /fixture_network_forbidden/);
  const cjs = require("nodemailer");
  assert.equal(typeof cjs.createTransport, "function");
  assert.equal(typeof nodemailer.createTransport, "function");
  const dynamic = await import("nodemailer");
  assert.equal(typeof dynamic.createTransport, "function", "the app's dynamic named import remains available");
  const stream = createTransport({ streamTransport: true, buffer: true });
  const mime = await stream.sendMail(message);
  assert.deepEqual(mime.envelope.to.sort(), ["approver@example.test", "archive@example.test", "client@example.test"]);
  const parsed = await simpleParser(mime.message);
  assert.equal(parsed.subject, message.subject);
  assert.equal(parsed.from.value[0].address, "sender@example.test");
  assert.equal(parsed.to.value[0].address, message.to);
  assert.equal(parsed.cc.value[0].address, message.cc);
  assert.equal(parsed.replyTo.value[0].address, message.replyTo);
  assert.equal(parsed.bcc.value[0].address, message.bcc, "stream transport keeps Bcc for local archival");
  assert.equal(parsed.text.trim(), message.text);
  assert.equal(parsed.html, message.html);
  assert.ok(parsed.headerLines.some(header => header.key === "list-unsubscribe" && header.line.includes(message.headers["List-Unsubscribe"])));
  assert.equal(parsed.attachments[0].filename, "fixture.pdf");
  assert.deepEqual(parsed.attachments[0].content, message.attachments[0].content);
  assert.equal(require.resolve("nodemailer"), createRequire(require.resolve("mailparser")).resolve("nodemailer"), "mailparser uses the same patched copy");
  console.log("ok real ESM/CJS MIME compose and parse preserve identities, copies, unsubscribe and attachment");

  const good = smtpTransport();
  try {
    const receipt = await good.transport.sendMail(message);
    assert.deepEqual(receipt.accepted.sort(), [message.cc, message.bcc, message.to].sort());
    assert.deepEqual(receipt.rejected, []);
    assert.equal(good.sockets(), 1, "SMTP uses only the supplied in-memory socket");
    assert.ok(good.peer.commands.includes("DATA"));
    const delivered = await simpleParser(good.peer.data);
    assert.equal(delivered.subject, message.subject);
    assert.equal(delivered.bcc, undefined, "SMTP never discloses the Bcc header");
  } finally { good.transport.close(); good.peer.destroy(); }
  const refused = smtpTransport(true);
  try {
    await assert.rejects(refused.transport.sendMail({ ...message, cc: undefined, bcc: undefined }), error => error.code === "EENVELOPE" && error.responseCode === 550);
    assert.equal(refused.sockets(), 1);
    assert.equal(refused.peer.data, "", "pipelined DATA can be queued, but a rejected recipient receives no body");
  } finally { refused.transport.close(); refused.peer.destroy(); }
  console.log("ok real SMTP transport distinguishes accepted and refused receipts without network");

  const commented = await simpleParser("From: sender@example.test\r\nTo: client@example.test (outer (inner) hidden@example.test)\r\nSubject: comment fixture\r\n\r\nbody");
  assert.deepEqual(commented.to.value.map(item => item.address), ["client@example.test"], "nested comments cannot inject an envelope recipient");
  const client = new ImapFlow({ host: "imap.fixture.invalid", port: 993, secure: true, logger: false, auth: { user: "fixture@example.test", pass: "synthetic-only" } });
  for (const method of ["connect", "search", "fetch", "getMailboxLock", "logout"]) assert.equal(typeof client[method], "function");
  assert.equal(client.usable, false, "constructing the IMAP client does not open a mailbox");
  console.log("ok incoming parser ignores comment recipients and IMAP reader API remains available");
  console.log("production-mail-dependencies: 3 passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
