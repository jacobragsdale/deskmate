// Bundles the three parts of the app into dist/: the main process, the preload script, and the window.
import { cp, rm } from "node:fs/promises";

import { build } from "esbuild";

const shared = { bundle: true, sourcemap: true, logLevel: "info" };

await rm("dist", { recursive: true, force: true });
await Promise.all([
  build({ ...shared, entryPoints: ["src/main/main.ts"], outfile: "dist/main.js", platform: "node", format: "esm", external: ["electron"] }),
  // A sandboxed preload script cannot be an ES module.
  build({ ...shared, entryPoints: ["src/main/preload.ts"], outfile: "dist/preload.cjs", platform: "node", format: "cjs", external: ["electron"] }),
  build({
    ...shared,
    entryPoints: ["src/renderer/main.tsx"],
    outfile: "dist/renderer/main.js",
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' }
  })
]);
await Promise.all([cp("src/renderer/index.html", "dist/renderer/index.html"), cp("src/renderer/styles.css", "dist/renderer/main.css")]);
