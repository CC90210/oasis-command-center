/**
 * Does .rpc() survive the methods callers chain onto it?
 *
 * The Turso proxy returned a bare Promise, so `.rpc(...).abortSignal(sig)` threw
 * a TypeError inside the caller's try block and every TextTorrent SMS path
 * reported 503 "rate_limiter_unavailable" — indistinguishable from a vendor
 * outage. tsc cannot catch this: getServiceSupabase() is typed as SupabaseClient,
 * which HAS those methods.
 *
 * So the guarantee has to be checked at runtime. This exercises the chainable
 * wrapper directly — no database, no credentials.
 *
 *   node scripts/verify-rpc-chainable.mjs
 */
let failures = 0;
const check = (name, ok, detail = "") => {
    if (!ok) failures++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// Mirror of chainableRpc in lib/supabase-server.ts. Kept in step by the
// source-fragment assertions at the bottom.
function chainableRpc(promise) {
    const api = {
        then: (...a) => promise.then(...a),
        catch: (...a) => promise.catch(...a),
        finally: (...a) => promise.finally(...a),
        abortSignal(signal) {
            return chainableRpc(new Promise((resolve, reject) => {
                if (signal.aborted) {
                    reject(new DOMException("The operation was aborted.", "AbortError"));
                    return;
                }
                const onAbort = () =>
                    reject(new DOMException("The operation was aborted.", "AbortError"));
                signal.addEventListener("abort", onAbort, { once: true });
                promise.then(
                    (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
                    (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
                );
            }));
        },
        single() {
            return chainableRpc(promise.then((r) => ({
                ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data,
            })));
        },
        maybeSingle() { return api.single(); },
        select() { return api; },
        throwOnError() {
            return chainableRpc(promise.then((r) => {
                if (r.error) throw new Error(r.error.message);
                return r;
            }));
        },
    };
    return api;
}

const okResult = (data) => Promise.resolve(
    { data, error: null, count: null, status: 200, statusText: "OK" });

console.log("chained methods do not throw");
for (const m of ["abortSignal", "single", "maybeSingle", "select", "throwOnError"]) {
    check(`.${m}() exists`, typeof chainableRpc(okResult(1))[m] === "function");
}

console.log("\nbehaviour");
{
    // The exact shape texttorrent.ts uses — the call that was 503-ing.
    const controller = new AbortController();
    const r = await chainableRpc(okResult({ allowed: true })).abortSignal(controller.signal);
    check("await .rpc(...).abortSignal(sig) resolves", r?.data?.allowed === true,
          JSON.stringify(r?.data));
}
{
    const r = await chainableRpc(okResult([{ id: "a" }, { id: "b" }])).single();
    check(".single() unwraps the first row", r?.data?.id === "a", JSON.stringify(r?.data));
}
{
    const r = await chainableRpc(okResult([])).maybeSingle();
    check(".maybeSingle() gives null on empty", r?.data === null);
}
{
    // abortSignal must be HONOURED, not accepted-and-ignored — the caller uses
    // it as a timeout, and swallowing it turns a fast failure into a hang.
    const controller = new AbortController();
    const slow = new Promise((res) => setTimeout(() => res(okResult(1)), 5000));
    const p = chainableRpc(slow).abortSignal(controller.signal);
    controller.abort();
    let aborted = false;
    try { await p; } catch (e) { aborted = e?.name === "AbortError"; }
    check("an aborted signal rejects rather than hanging", aborted);
}
{
    let threw = false;
    try {
        await chainableRpc(Promise.resolve({
            data: null, error: { message: "boom" }, count: null,
            status: 400, statusText: "Bad Request",
        })).throwOnError();
    } catch (e) { threw = e.message === "boom"; }
    check(".throwOnError() throws on an error result", threw);
}
{
    const r = await chainableRpc(okResult(7));
    check("plain await still works (no chain)", r?.data === 7);
}

// The wrapper above is a copy, so a passing test would prove nothing if the
// real module drifted. Assert the source still carries the same construction.
console.log("\nlib/supabase-server.ts still uses this wrapper");
const { readFileSync } = await import("node:fs");
const src = readFileSync(new URL("../lib/supabase-server.ts", import.meta.url), "utf8");
for (const frag of [
    "function chainableRpc(",
    "return chainableRpc(shimmed(getTursoClient()",
    "chainableRpc(Promise.resolve({",
    'new DOMException("The operation was aborted.", "AbortError")',
]) {
    check(`source contains: ${frag.slice(0, 46)}`, src.includes(frag));
}
// Both proxy branches must route through it, not just the first.
const wrapped = (src.match(/return chainableRpc\(shimmed\(/g) || []).length;
check("BOTH proxy branches wrapped (service + authed)", wrapped === 2, `found ${wrapped}`);

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
