/**
 * tests/cloud-tool-runner-ssrf.test.ts - the open-web tools (http_get, http_post
 * and Learn from a link, through lib/cloud-tool-runner.ts) never reach an address
 * inside OASIS's own network, by literal or by name.
 *
 * Pins (2026-10-26, a sibling session's review of lib/cloud-tool-runner.ts, then
 * an independent review of the fix):
 *   1. assertSafeUrl refuses every loopback, "this host", link-local, private,
 *      carrier-grade NAT, reserved and multicast literal, in every spelling the
 *      URL parser lets through: dotted, decimal, hex, bracketed IPv6, IPv4-mapped
 *      and NAT64 IPv6, a trailing dot on localhost. A host with an empty label
 *      ("localhost..", ".localhost") is not a name and is refused. Before this it
 *      refused the one string "127.0.0.1" and "::1" without its brackets, so
 *      [::1], 127.0.0.2 and 100.64.0.0/10 all went through.
 *   2. isForbiddenIp is the one range table both guards use. For IPv6 it passes
 *      only global unicast (2000::/3), less 6to4 and Teredo, which tunnel to an
 *      IPv4 address the IPv4 table never sees.
 *   3. assertResolvedIpIsPublic checks every address a name resolves to against
 *      that table, checks a literal host without resolving, and FAILS CLOSED
 *      when no resolver can answer. The old guard returned as if the host were
 *      fine whenever the dns module was missing or threw.
 *   4. resolveAddresses asks the runtime's lookup first (Node's here; on the
 *      Worker, the node:dns workerd provides natively) and confirms over
 *      DNS-over-HTTPS every answer that would leave nothing to check: an error,
 *      "not found" included, or no addresses. DoH's status is read: NOERROR is
 *      the addresses, NXDOMAIN is none, and any other status, like a failed
 *      request, is "dns_check_failed", never a pass.
 *
 * Run: node --conditions=react-server --import tsx tests/cloud-tool-runner-ssrf.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertResolvedIpIsPublic, assertSafeUrl, isForbiddenIp, resolveAddresses, resolveViaDoh } from "../lib/cloud-tool-runner";

const root = join(__dirname, "..");

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

function refused(url: string): string | null {
  try {
    assertSafeUrl(url);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

async function main() {
  console.log("cloud-tool-runner ssrf:");

  await check("isForbiddenIp: one range table, every spelling", () => {
    const forbidden = [
      "127.0.0.1", "127.0.0.2", "127.255.255.255", "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255",
      "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "169.254.0.1",
      "100.64.0.0", "100.64.1.1", "100.127.255.255", "192.0.0.1", "198.18.0.1", "198.19.255.255",
      "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
      "::1", "[::1]", "::", "[::]", "::ffff:127.0.0.1", "::ffff:7f00:1", "[::ffff:7f00:1]", "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe", "::ffff:10.0.0.1", "::ffff:100.64.0.1", "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::127.0.0.1",
      "fe80::1", "fe80::1%eth0", "febf::1", "fec0::1", "fed0::1", "feff::1", "fc00::1", "fd00::1", "fd00:ec2::254", "fdff::1", "ff02::1", "FE80::1",
      // Outside global unicast (2000::/3), refused by default: the compatible form even for a public
      // address, IPv4-translated (::ffff:0:a.b.c.d), local-use NAT64, discard-only, and unassigned blocks.
      "::8.8.8.8", "::2", "::ffff:0:7f00:1", "::ffff:0:808:808", "64:ff9b:1::7f00:1", "64:ff9b:1::808:808", "100::1",
      "1::1", "fb00::1", "fe00::1", "fe7f::1", "4000::1", "e000::1",
      // 6to4 and Teredo tunnel to an IPv4 address, so both are refused whole: 2002:7f00:1:: is 127.0.0.1.
      "2002:7f00:1::1", "2002:a9fe:a9fe::1", "2002:808:808::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001::1",
    ];
    for (const ip of forbidden) assert.equal(isForbiddenIp(ip), true, `${ip} is forbidden`);
    const allowed = [
      "8.8.8.8", "1.1.1.1", "93.184.216.34", "11.0.0.1", "172.32.0.1", "172.15.255.255", "192.167.255.255", "192.169.0.1",
      "100.63.255.255", "100.128.0.0", "198.17.255.255", "198.20.0.1", "223.255.255.255",
      "2606:4700::1111", "2001:db8::1", "2001:4860:4860::8888", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808",
    ];
    for (const ip of allowed) assert.equal(isForbiddenIp(ip), false, `${ip} is public`);
    for (const junk of ["", "not-an-ip", "example.com", "1.2.3", "1.2.3.4.5", "256.1.1.1", ":::", "zz::1"]) {
      assert.equal(isForbiddenIp(junk), false, `${junk} is not an address, so the table says nothing about it`);
    }
  });

  await check("assertSafeUrl: every forbidden literal is refused, however the URL spells it", () => {
    const refusals: Array<[string, string]> = [
      ["http://localhost/", "blocked_host"],
      ["http://LOCALHOST./", "blocked_host"],
      ["http://localhost./", "blocked_host"],
      ["http://metadata.google.internal/", "blocked_host"],
      ["http://metadata.azure.com/", "blocked_host"],
      ["http://foo.internal/", "blocked_host"],
      ["http://foo.local/", "blocked_host"],
      ["http://foo.localhost/", "blocked_host"],
      ["http://127.0.0.1/", "blocked_host"],
      ["http://127.0.0.2/", "blocked_private_ip"],
      ["http://127.1/", "blocked_host"],
      ["http://2130706433/", "blocked_host"],
      ["http://0x7f000001/", "blocked_host"],
      ["http://0/", "blocked_host"],
      ["http://0.1.2.3/", "blocked_private_ip"],
      ["http://10.1.2.3/", "blocked_private_ip"],
      ["http://172.20.0.1/", "blocked_private_ip"],
      ["http://192.168.0.1/", "blocked_private_ip"],
      ["http://169.254.169.254/latest/meta-data/", "blocked_host"],
      ["http://169.254.1.1/", "blocked_private_ip"],
      ["http://100.64.1.1/", "blocked_private_ip"],
      ["http://100.127.255.255/", "blocked_private_ip"],
      ["http://192.0.0.8/", "blocked_private_ip"],
      ["http://198.18.0.1/", "blocked_private_ip"],
      ["http://224.0.0.1/", "blocked_private_ip"],
      ["http://255.255.255.255/", "blocked_private_ip"],
      ["http://[::1]/", "blocked_host"],
      ["http://[::]/", "blocked_private_ip"],
      ["http://[::ffff:127.0.0.1]/", "blocked_private_ip"],
      ["http://[::ffff:7f00:1]/", "blocked_private_ip"],
      ["http://[::ffff:169.254.169.254]/", "blocked_private_ip"],
      ["http://[64:ff9b::7f00:1]/", "blocked_private_ip"],
      ["http://[fe80::1]/", "blocked_private_ip"],
      ["http://[fd00:ec2::254]/", "blocked_host"],
      ["http://[fd12:3456::1]/", "blocked_private_ip"],
      ["http://[fec0::1]/", "blocked_private_ip"],
      ["http://[ff02::1]/", "blocked_private_ip"],
      ["http://[2002:7f00:1::1]/", "blocked_private_ip"],
      ["http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/", "blocked_private_ip"],
      ["http://[64:ff9b:1::7f00:1]/", "blocked_private_ip"],
      // The parser keeps an empty label; a host with one is not a name, so it is refused, not resolved.
      ["http://localhost../", "invalid_url"],
      ["http://127.0.0.1../", "invalid_url"],
      ["http://example.com../", "invalid_url"],
      ["http://.localhost/", "invalid_url"],
      ["http://a..b/", "invalid_url"],
      ["http://./", "invalid_url"],
    ];
    for (const [url, code] of refusals) assert.equal(refused(url), code, url);
    assert.equal(refused("ftp://example.com/"), "unsupported_protocol");
    assert.equal(refused("file:///etc/passwd"), "unsupported_protocol");
    assert.equal(refused("not a url"), "invalid_url");
    for (const url of [
      "https://example.com/",
      "https://example.com./",
      "http://8.8.8.8/",
      "http://11.0.0.1/",
      "http://172.32.0.1/",
      "http://100.63.255.255/",
      "http://100.128.0.0/",
      "http://[2606:4700::1111]/",
      "http://[::ffff:8.8.8.8]/",
      "https://www.tiktok.com/@someone/video/1",
    ]) {
      assert.equal(refused(url), null, `${url} is public`);
      assert.equal(assertSafeUrl(url).toString(), new URL(url).toString());
    }
  });

  await check("assertResolvedIpIsPublic: every resolved address is checked; a literal needs no resolver; nothing resolvable is not a pass", async () => {
    const never = async (): Promise<never> => {
      throw new Error("the resolver must not be called for a literal");
    };
    for (const host of ["127.0.0.1", "127.0.0.2", "[::1]", "::1", "100.64.0.1", "[::ffff:7f00:1]"]) {
      await assert.rejects(assertResolvedIpIsPublic(host, never), /blocked_private_ip/, host);
    }
    for (const host of ["8.8.8.8", "[2606:4700::1111]"]) await assertResolvedIpIsPublic(host, never);

    const answering = (addresses: string[]) => async () => addresses.map((address) => ({ address }));
    for (const addresses of [["127.0.0.1"], ["93.184.216.34", "10.0.0.5"], ["100.64.0.9"], ["::ffff:169.254.169.254"], ["fd00::1"], ["::"]]) {
      await assert.rejects(assertResolvedIpIsPublic("evil.example", answering(addresses)), /blocked_resolved_private_ip/, addresses.join(","));
    }
    await assertResolvedIpIsPublic("example.com", answering(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]));
    // A name with no address: the fetch that follows surfaces the error; nothing to block.
    await assertResolvedIpIsPublic("nxdomain.example", answering([]));
    // A resolver that cannot answer is a failed check, never a pass.
    await assert.rejects(
      assertResolvedIpIsPublic("example.com", async () => {
        throw new Error("dns_check_failed");
      }),
      /dns_check_failed/,
    );
  });

  await check("resolveAddresses: the runtime's lookup when it answers; DNS-over-HTTPS confirms every answer that leaves nothing to check; a resolver that cannot answer is dns_check_failed", async () => {
    let asked = 0;
    /** A DoH resolver: NOERROR for a name it knows (its answers, maybe none of a type), NXDOMAIN otherwise, unless `status` overrides both. */
    const doh = (answers: Record<string, Array<{ type: number; data: string }>>, status?: number) =>
      (async (input: string | URL | Request) => {
        asked += 1;
        const u = new URL(String(input));
        const type = u.searchParams.get("type") === "AAAA" ? 28 : 1;
        const name = u.searchParams.get("name") ?? "";
        const Answer = (answers[name] ?? []).filter((a) => a.type === type || a.type === 5);
        const Status = status ?? (name in answers ? 0 : 3);
        return new Response(JSON.stringify({ Status, Answer }), { status: 200, headers: { "content-type": "application/dns-json" } });
      }) as typeof fetch;
    const failing = (code: string) => async (): Promise<never> => {
      const err = new Error(code) as Error & { code?: string };
      err.code = code;
      throw err;
    };
    const down = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const lookupWorks = async () => [{ address: "93.184.216.34", family: 4 }];
    assert.deepEqual(await resolveAddresses("example.com", { lookup: lookupWorks, fetchImpl: down }), [{ address: "93.184.216.34", family: 4 }], "an answer with addresses needs no second look");

    asked = 0;
    const viaDoh = await resolveAddresses("evil.example", {
      lookup: failing("ERR_METHOD_NOT_IMPLEMENTED"),
      fetchImpl: doh({ "evil.example": [{ type: 5, data: "cname.evil.example." }, { type: 1, data: "127.0.0.1" }, { type: 28, data: "fd00::1" }] }),
    });
    assert.deepEqual(viaDoh.map((a) => a.address).sort(), ["127.0.0.1", "fd00::1"], "A and AAAA, through the CNAME");
    assert.equal(asked, 2, "one DoH question per record type");
    // No runtime lookup at all: straight to DoH. A name with an A record and no AAAA is NOERROR with no answers for AAAA.
    assert.deepEqual(await resolveAddresses("example.com", { lookup: null, fetchImpl: doh({ "example.com": [{ type: 1, data: "93.184.216.34" }] }) }), [{ address: "93.184.216.34", family: 4 }]);

    // "Not found" is confirmed, not believed: whatever code a runtime gives, DoH answers for it.
    for (const code of ["ENOTFOUND", "ENODATA", "EAI_NONAME", "EAI_AGAIN", "ESERVFAIL"]) {
      assert.deepEqual(await resolveAddresses("nxdomain.example", { lookup: failing(code), fetchImpl: doh({}) }), [], `${code}, and DoH says NXDOMAIN: nothing to check`);
      await assert.rejects(
        assertResolvedIpIsPublic("rebind.example", (h) => resolveAddresses(h, { lookup: failing(code), fetchImpl: doh({ "rebind.example": [{ type: 1, data: "127.0.0.1" }] }) })),
        /blocked_resolved_private_ip/,
        `${code} from the lookup, but the name exists and points inside: refused`,
      );
      await assert.rejects(resolveAddresses("example.com", { lookup: failing(code), fetchImpl: down }), /dns_check_failed/, `${code} and DoH down: a failed check, not a pass`);
    }
    asked = 0;
    assert.deepEqual(await resolveAddresses("rebind.example", { lookup: async () => [], fetchImpl: doh({ "rebind.example": [{ type: 1, data: "10.0.0.7" }] }) }), [{ address: "10.0.0.7", family: 4 }], "an empty answer is confirmed too");
    assert.equal(asked, 2);

    // DoH's status is read: only NOERROR and NXDOMAIN are answers.
    for (const status of [1, 2, 4, 5]) {
      await assert.rejects(resolveViaDoh("example.com", doh({ "example.com": [] }, status)), /dns_check_failed/, `Status ${status} is a resolver that did not answer`);
      await assert.rejects(resolveAddresses("example.com", { lookup: failing("ENOTFOUND"), fetchImpl: doh({}, status) }), /dns_check_failed/, `ENOTFOUND, then DoH Status ${status}`);
    }
    const noStatus = (async () => new Response(JSON.stringify({ Answer: [] }), { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(resolveViaDoh("example.com", noStatus), /dns_check_failed/, "an answer with no status is not NOERROR");
    assert.deepEqual(await resolveViaDoh("nxdomain.example", doh({})), [], "NXDOMAIN on both questions: no such name");

    await assert.rejects(resolveAddresses("example.com", { lookup: failing("ERR_METHOD_NOT_IMPLEMENTED"), fetchImpl: down }), /dns_check_failed/, "no resolver could answer");
    const refusing = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await assert.rejects(resolveViaDoh("example.com", refusing), /dns_check_failed/, "a DoH error status is a failed check");
  });

  await check("the capped fetch runs the resolved-address check before every request, and the Worker's redirects stay manual", () => {
    const src = readFileSync(join(root, "lib/cloud-tool-runner.ts"), "utf8");
    const fetchWithCapAt = src.indexOf("export async function fetchWithCap(");
    const checkAt = src.indexOf("await assertResolvedIpIsPublic(url.hostname.toLowerCase(), deps.resolver)", fetchWithCapAt);
    const fetchAt = src.indexOf("await (deps.fetchImpl ?? fetch)(url.toString()", fetchWithCapAt);
    assert.ok(fetchWithCapAt > 0 && checkAt > fetchWithCapAt && fetchAt > checkAt, "the check sits between the function's start and its fetch");
    assert.match(src.slice(fetchWithCapAt, fetchAt + 200), /redirect: "manual"/);
    assert.doesNotMatch(src, /dns module unavailable/, "no silent pass when dns is missing");
    assert.match(src, /export async function assertResolvedIpIsPublic\(host: string, resolver: AddressResolver = resolveAddresses\)/, "the default resolver is the one that falls back to DoH and fails closed");
  });

  console.log(failures ? `cloud-tool-runner ssrf: ${failures} failure(s)` : "cloud-tool-runner ssrf: all passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
