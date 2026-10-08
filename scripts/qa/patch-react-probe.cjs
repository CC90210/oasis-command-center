#!/usr/bin/env node
/*
 * H418 PROBE (throwaway): instrument the BUILT React DOM client so a hydration
 * mismatch records which fiber failed, where React's hydration cursor pointed,
 * and what the document looked like at that moment, before React regenerates
 * the tree. Patches .next/static/chunks/*.js in place after `next build`.
 *
 * Usage: node scripts/qa/patch-react-probe.cjs .next/static/chunks
 */
const fs = require("node:fs");
const path = require("node:path");

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) {
  console.error("usage: patch-react-probe.cjs <chunks dir>");
  process.exit(1);
}

function walk(d) {
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const DECL = /var (\w+)=null,(\w+)=null,(\w+)=!1,(\w+)=null,(\w+)=!1,(\w+)=Error\((\w+)\(519\)\);function (\w+)\((\w+)\)\{/;
let patched = 0;
for (const file of walk(dir)) {
  let src = fs.readFileSync(file, "utf8");
  const m = src.match(DECL);
  if (!m) continue;
  const [, P, N, L, T, U, , , D, arg] = m;
  const typeName = (f) =>
    `(${f}?(typeof ${f}.type==="string"?${f}.type:(${f}.type&&(${f}.type.displayName||${f}.type.name))||String(${f}.type&&${f}.type.$$typeof||${f}.type)):null)`;
  const nodeInfo = (n) =>
    `(${n}?{nodeType:${n}.nodeType,nodeName:${n}.nodeName,data:${n}.data,id:${n}.id||null,cls:${n}.className?String(${n}.className).slice(0,80):null,connected:${n}.isConnected,parent:${n}.parentNode?${n}.parentNode.nodeName+"#"+(${n}.parentNode.id||"")+"."+String(${n}.parentNode.className||"").slice(0,40):null,prev:${n}.previousSibling?${n}.previousSibling.nodeName+"|"+String(${n}.previousSibling.data||${n}.previousSibling.className||"").slice(0,40):null,next:${n}.nextSibling?${n}.nextSibling.nodeName+"|"+String(${n}.nextSibling.data||${n}.nextSibling.className||"").slice(0,40):null,outer:${n}.outerHTML?${n}.outerHTML.slice(0,400):String(${n}.data||${n}.textContent||"").slice(0,200)}:null)`;
  const recorder =
    `try{var __c=${N},__a=[],__f=${arg};for(var __i=0;__f&&__i<40;__i++,__f=__f.return){__a.push(__f.tag+":"+${typeName("__f")}+(__f.pendingProps&&__f.pendingProps.className?"."+String(__f.pendingProps.className).slice(0,50):"")+(__f.pendingProps&&__f.pendingProps.id?"#"+__f.pendingProps.id:""))}` +
    `window.__h418Info=window.__h418Info||[];window.__h418Info.push({t:performance.now(),rs:document.readyState,fromText:arguments.length>1&&!!arguments[1],tag:${arg}.tag,type:${typeName(arg)},props:${arg}.pendingProps&&typeof ${arg}.pendingProps==="object"?Object.keys(${arg}.pendingProps).slice(0,15):String(${arg}.pendingProps).slice(0,100),` +
    `hydrationParent:${typeName(P)},hydrationParentTag:${P}?${P}.tag:null,rootOrSingleton:${U},cursor:${nodeInfo("__c")},chain:__a,` +
    `bodyKids:document.body?document.body.childNodes.length:-1,dom:document.body?document.body.outerHTML.slice(0,250000):null})}catch(__e){window.__h418InfoErr=String(__e)}`;
  const before = src;
  src = src.replace(m[0], `${m[0]}${recorder};`);
  // The HostRoot entry into hydration: record when it ran and what body held.
  const rootRe = new RegExp(`(${N}=\\w+\\(\\(\\w+=9===\\(\\w+=(\\w+)\\.stateNode\\.containerInfo\\)\\.nodeType\\?\\w+\\.body:[^)]*?\\)\\.firstChild\\),${P}=\\2,${L}=!0,${T}=null,${U}=!0,)`);
  const rm = src.match(rootRe);
  let rootPatched = false;
  if (rm) {
    src = src.replace(
      rm[1],
      `${rm[1]}(function(){try{window.__h418Root=window.__h418Root||[];window.__h418Root.push({t:performance.now(),rs:document.readyState,bodyKids:document.body?document.body.childNodes.length:-1,first:${nodeInfo(N)},dom:document.body?document.body.outerHTML.slice(0,120000):null})}catch(__e){}})(),`,
    );
    rootPatched = true;
  }
  if (src !== before) {
    fs.writeFileSync(file, src);
    patched += 1;
    console.log(`patched ${file}: throw=${D} cursor=${N} parent=${P} rootEntry=${rootPatched}`);
  }
}
if (patched === 0) {
  console.error("no React DOM client chunk matched; nothing patched");
  process.exit(1);
}
