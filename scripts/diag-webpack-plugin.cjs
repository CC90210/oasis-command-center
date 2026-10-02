/* TEMPORARY bundle-composition diagnostic (perf/worker-bundle-diet). Removed before merge.
 *
 * Loaded by next.config.js only when BUNDLE_DIAG=1. Adds a read-only webpack
 * plugin to the Node.js server compiler that records, for every emitted
 * server chunk, which modules (by npm package or source path) and which
 * layer (rsc / ssr / ...) it holds, with each module's pre-minification size.
 * scripts/diag-worker-bundle.mjs joins that with OpenNext's esbuild metafile
 * to attribute the Worker's bytes. It changes no compiler output.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function keyOf(resource) {
  const p = String(resource).split("?")[0].split(path.sep).join("/");
  const i = p.lastIndexOf("/node_modules/");
  if (i >= 0) {
    const rest = p.slice(i + "/node_modules/".length).split("/");
    let name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
    if (name === "next" && rest[1] === "dist") {
      if (rest[2] === "compiled") {
        name = `next/dist/compiled/${rest[3] && rest[3].startsWith("@") ? `${rest[3]}/${rest[4]}` : rest[3]}`;
      } else {
        name = `next/dist/${rest[2]}`;
      }
    }
    return `npm:${name}`;
  }
  const rel = path.relative(ROOT, p).split(path.sep).join("/");
  return `src:${rel}`;
}

class BundleDiagPlugin {
  apply(compiler) {
    compiler.hooks.afterEmit.tap("BundleDiagPlugin", (compilation) => {
      const out = {};
      for (const chunk of compilation.chunks) {
        const files = [...chunk.files].filter((f) => f.endsWith(".js"));
        if (files.length === 0) continue;
        const agg = {};
        for (const m of compilation.chunkGraph.getChunkModulesIterable(chunk)) {
          const inner = m.modules ? [...m.modules] : [m];
          for (const im of inner) {
            const res = im.resource || (im.rootModule && im.rootModule.resource);
            const key = res ? keyOf(res) : `other:${im.constructor && im.constructor.name}`;
            const k = `${key}|${im.layer || m.layer || "-"}`;
            let size = 0;
            try {
              size = im.size();
            } catch {
              size = 0;
            }
            agg[k] = (agg[k] || 0) + size;
          }
        }
        for (const f of files) out[f] = agg;
      }
      const dir = path.join(ROOT, "diag-out");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `server-modules-${compiler.options.name || "server"}.json`), JSON.stringify(out));
    });
  }
}

module.exports = function applyBundleDiag(nextConfig) {
  nextConfig.experimental = { ...(nextConfig.experimental || {}), webpackBuildWorker: true };
  const prev = nextConfig.webpack;
  nextConfig.webpack = (config, ctx) => {
    const cfg = prev ? prev(config, ctx) : config;
    if (ctx.isServer && ctx.nextRuntime === "nodejs") cfg.plugins.push(new BundleDiagPlugin());
    return cfg;
  };
  return nextConfig;
};
