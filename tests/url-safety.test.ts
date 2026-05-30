import { classifyUrlForSsrf } from "../lib/url-safety";

type Case = [url: string, shouldBlock: boolean, label: string];

const cases: Case[] = [
  // Legitimate public webhooks — must pass.
  ["https://hooks.zapier.com/abc", false, "zapier"],
  ["https://n8n.example.com/webhook/foo", false, "n8n cloud"],
  ["http://104.21.34.56/", false, "public IPv4"],
  ["https://api.openai.com/v1/x", false, "well-known API"],

  // Cloud metadata services — hard block.
  ["http://169.254.169.254/latest/meta-data/", true, "AWS IMDS"],
  ["http://metadata.google.internal/computeMetadata/v1/", true, "GCP metadata"],

  // Loopback in every shape.
  ["http://localhost:8080/x", true, "localhost"],
  ["http://127.0.0.1/", true, "127.0.0.1"],
  ["http://127.5.6.7/", true, "127/8"],
  ["http://[::1]/", true, "IPv6 loopback"],

  // IPv4 RFC-1918.
  ["http://10.0.0.5/x", true, "10/8"],
  ["http://172.16.0.1/", true, "172.16/12 low"],
  ["http://172.31.255.255/", true, "172.31/12 high"],
  ["http://172.32.0.1/", false, "172.32 NOT private"],
  ["http://172.15.0.1/", false, "172.15 NOT private"],
  ["http://192.168.1.1/", true, "192.168/16"],
  ["http://192.169.1.1/", false, "192.169 NOT private"],
  ["http://169.254.1.5/", true, "169.254/16 link-local"],
  ["http://0.0.0.0/", true, "0/8"],

  // IPv6 unique-local + link-local.
  ["http://[fc00::1]/", true, "fc00::/7"],
  ["http://[fdab::1]/", true, "fd../7"],
  ["http://[fe80::1]/", true, "fe80::/10 link-local"],
  ["http://[fec0::1]/", false, "fec0 deprecated, NOT in fe80::/10"],

  // Garbage input — refuse.
  ["not-a-url", true, "garbage"],
  ["", true, "empty"],
];

let failed = 0;
for (const [url, shouldBlock, label] of cases) {
  const result = classifyUrlForSsrf(url);
  const blocked = result !== null;
  if (blocked !== shouldBlock) {
    console.error(
      `FAIL [${label}] url=${url} expected blocked=${shouldBlock} got=${blocked} result=${result}`,
    );
    failed++;
  }
}

if (failed) {
  console.error(`url-safety: ${failed} case(s) failed`);
  process.exit(1);
}
console.log(`url-safety ok (${cases.length} cases)`);
