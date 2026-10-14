// Bundles the four things that are built into dist/: the command, the app's main process, its preload script, and its window.
import { chmod, cp, rm } from "node:fs/promises";

import { build } from "esbuild";

const shared = { bundle: true, sourcemap: true, logLevel: "info" };

await rm("dist", { recursive: true, force: true });
await Promise.all([
  // The command is one file that runs wherever Node does: the hub's image, an agent's shell, and the window starting its desk all use it.
  build({ ...shared, entryPoints: ["src/cli/main.ts"], outfile: "dist/player-two.js", platform: "node", format: "esm", banner: { js: "#!/usr/bin/env node" } }),
  build({ ...shared, entryPoints: ["src/window/main/main.ts"], outfile: "dist/main.js", platform: "node", format: "esm", external: ["electron"] }),
  // A sandboxed preload script cannot be an ES module.
  build({ ...shared, entryPoints: ["src/window/main/preload.ts"], outfile: "dist/preload.cjs", platform: "node", format: "cjs", external: ["electron"] }),
  build({
    ...shared,
    entryPoints: ["src/window/renderer/main.tsx"],
    outfile: "dist/renderer/main.js",
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' }
  })
]);
await Promise.all([cp("src/window/renderer/index.html", "dist/renderer/index.html"), cp("src/window/renderer/styles.css", "dist/renderer/main.css"), chmod("dist/player-two.js", 0o755)]);
