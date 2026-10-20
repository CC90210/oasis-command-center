/**
 * scripts/qa/egress-guard.cjs - preloaded into every Node process of the QA
 * crawl (NODE_OPTIONS="--require ./scripts/qa/egress-guard.cjs"): the build,
 * the server and the seed.
 *
 * It refuses every outbound TCP connection that is not to the loopback
 * interface, so the app physically cannot reach a real third party (Turso,
 * Stripe, Google, mail servers, the OASIS bridge, oasisai.work...) even when a
 * code path ignores the environment it was given. fetch (undici), http, https,
 * tls and every SDK built on them open their sockets through
 * net.Socket.prototype.connect, which is the one door patched here.
 *
 * Each refused attempt is appended as one JSON line to EGRESS_LOG (when set),
 * so the crawl report can say which features tried to phone out. The refusal
 * looks like a refused connection (ECONNREFUSED), which is how the app already
 * treats an unreachable service.
 */
"use strict";

const net = require("node:net");
const fs = require("node:fs");

const LOG = process.env.EGRESS_LOG || "";
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0", "::ffff:127.0.0.1", "::"]);

function record(host, port) {
  if (!LOG) return;
  try {
    const stack = (new Error().stack || "").split("\n").slice(3, 9).map((s) => s.trim());
    fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), host, port, pid: process.pid, stack }) + "\n");
  } catch (_err) {
    // The log is evidence, not the guard: a failed write must not let the connection through.
  }
}

/** Where a Socket#connect call is headed: an IPC path (local) or a host and port. */
function targetOf(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0]; // Node's internal normalized form
  if (first && typeof first === "object") {
    if (first.path) return { local: true };
    return { host: first.host || "localhost", port: first.port };
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) return { local: true }; // IPC path
  return { host: typeof args[1] === "string" ? args[1] : "localhost", port: first };
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const target = targetOf(args);
  if (!target.local) {
    const host = String(target.host || "").replace(/^\[|\]$/g, "").toLowerCase();
    if (!LOOPBACK.has(host) && !host.startsWith("127.")) {
      record(host, target.port);
      const err = Object.assign(new Error(`egress blocked by the QA crawl: ${host}:${target.port}`), { code: "ECONNREFUSED" });
      process.nextTick(() => this.destroy(err));
      return this;
    }
  }
  return originalConnect.apply(this, args);
};
