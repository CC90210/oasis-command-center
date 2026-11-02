/** Existing transport fixtures mock require.cache. Route only their mail imports
 * through Nodemailer's CJS entry so its new ESM export cannot bypass that mock.
 * Production and real-library compatibility tests do not load this hook. */
import { register } from "node:module";
import "./deny-network.mjs";

register(`data:text/javascript,${encodeURIComponent(`
  import { createRequire } from 'node:module';
  import { pathToFileURL } from 'node:url';
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'nodemailer' && context.parentURL?.startsWith('file:')) {
      const path = createRequire(context.parentURL).resolve(specifier);
      return { url: pathToFileURL(path).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`)}`);
