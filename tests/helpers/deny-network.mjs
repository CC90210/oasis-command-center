/** Fail closed before a mail fixture could contact any real provider. */
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";

const blocked = () => { throw new Error("fixture_network_forbidden"); };
net.connect = net.createConnection = tls.connect = blocked;
net.Socket.prototype.connect = blocked;
http.request = http.get = https.request = https.get = blocked;
globalThis.fetch = blocked;
for (const target of [dns, dns.promises]) {
  for (const key of Object.keys(target)) {
    if (key === "lookup" || key === "lookupService" || key === "reverse" || key.startsWith("resolve")) target[key] = blocked;
  }
}
syncBuiltinESMExports();
