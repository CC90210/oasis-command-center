/** Actual Cloudflare runtime, real mail packages; outbound access is always refused. */
import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

async function main() {
  const bundled = await build({
    stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
      import nodemailer from 'nodemailer';
      import { simpleParser } from 'mailparser';
      import { ImapFlow } from 'imapflow';
      import { loadNativeRaster } from './lib/forms/native-raster';
      export default { async fetch() {
        const dynamic = await import('nodemailer');
        const transport = dynamic.createTransport({streamTransport:true,buffer:true});
        const sent = await transport.sendMail({from:'sender@example.test',to:'recipient@example.test',
          subject:'Worker MIME fixture',text:'synthetic only',headers:{'X-Fixture':'bounded'}});
        const parsed = await simpleParser(sent.message);
        const imap = new ImapFlow({host:'imap.fixture.invalid',port:993,secure:true,logger:false,
          auth:{user:'fixture@example.test',pass:'synthetic-only'}});
        const raster = await loadNativeRaster();
        return Response.json({defaultImport:typeof nodemailer.createTransport,
          subject:parsed.subject,to:parsed.to.value[0].address,text:parsed.text.trim(),
          envelope:sent.envelope.to,imapConnected:imap.usable,nativeAvailable:raster.available});
      }};` },
    bundle: true, write: false, format: "esm", platform: "node", target: "es2022",
    external: ["node:*", ...builtinModules],
    banner: { js: "import { createRequire as fixtureCreateRequire } from 'node:module'; const require = fixtureCreateRequire('/');" },
    plugins: [{ name: "server-only-marker", setup(builder) {
      builder.onResolve({ filter: /^server-only$/ }, () => ({ path: "server-only", namespace: "fixture-marker" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture-marker" }, () => ({ contents: "" }));
    } }],
  });
  let outbound = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: "2026-08-01", compatibilityFlags: ["nodejs_compat"],
    script: bundled.outputFiles[0].text,
    outboundService: () => { outbound++; throw new Error("fixture forbids outbound requests"); },
  }));
  try {
    const response = await mf.dispatchFetch("https://fixture.invalid");
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { defaultImport: "function", subject: "Worker MIME fixture",
      to: "recipient@example.test", text: "synthetic only", envelope: ["recipient@example.test"],
      imapConnected: false, nativeAvailable: false });
    assert.equal(outbound, 0);
    console.log("production-dependencies-worker: real mail compose/parse and native-image refusal passed; no outbound requests");
  } finally { await mf.dispose(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
