// Builds the script-tag bundle and a single-file ESM bundle, then publishes
// the script-tag bundle to the desktop app, which serves it as {host}/s98.js.
//
//   dist/signal98.min.js   IIFE, minified, global `signal98`, auto-inits from data-* attributes
//   dist/signal98.esm.js   ESM, for <script type="module"> or bundler-less use

import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const at = (...p) => join(root, ...p);

// The browser bundle has no use for process hooks or Express middleware.
const withoutNode = {
  name: "without-node",
  setup(b) {
    b.onResolve({ filter: /\/node\.js$/ }, () => ({ path: at("src/node.stub.js") }));
  },
};

const common = { bundle: true, target: "es2018", platform: "browser", legalComments: "none", logLevel: "warning" };

await build({
  ...common,
  entryPoints: [at("src/cdn.js")],
  outfile: at("dist/signal98.min.js"),
  format: "iife",
  globalName: "signal98",
  minify: true,
  plugins: [withoutNode],
});

await build({
  ...common,
  entryPoints: [at("src/index.js")],
  outfile: at("dist/signal98.esm.js"),
  format: "esm",
  platform: "neutral",
});

const publicDir = at("..", "desktop", "public");
mkdirSync(publicDir, { recursive: true });
copyFileSync(at("dist/signal98.min.js"), join(publicDir, "s98.js"));

for (const file of ["dist/signal98.min.js", "dist/signal98.esm.js"]) {
  const buf = readFileSync(at(file));
  const kb = (n) => `${(n / 1024).toFixed(2)} KB`;
  console.log(`${file.padEnd(24)} ${kb(buf.length).padStart(10)}   gzip ${kb(gzipSync(buf, { level: 9 }).length)}`);
}
console.log("copied dist/signal98.min.js -> ../desktop/public/s98.js");

// Distribute this checkout's actual package; setup never assumes an npm registry release.
const downloads=join(publicDir,"downloads");
mkdirSync(downloads,{recursive:true});
const packed=JSON.parse(execFileSync("npm",["pack","--json","--ignore-scripts","--pack-destination",downloads],{cwd:root,encoding:"utf8"}));
console.log(`package -> ../desktop/public/downloads/${packed[0].filename}`);
