// Bundles the four things that are built into dist/: the command, the app's main process and its preload script with esbuild, then the window with Vite (vite.config.ts).
import { chmod, rm } from "node:fs/promises";

import { build } from "esbuild";
import { build as buildWindow } from "vite";

const shared = { bundle: true, sourcemap: true, logLevel: "info" };

await rm("dist", { recursive: true, force: true });
await Promise.all([
  // The command is one file that runs wherever Node does: the hub's image, an agent's shell, and the window starting its desk all use it.
  build({ ...shared, entryPoints: ["src/cli/main.ts"], outfile: "dist/player-two.js", platform: "node", format: "esm", banner: { js: "#!/usr/bin/env node" } }),
  build({ ...shared, entryPoints: ["src/window/main/main.ts"], outfile: "dist/main.js", platform: "node", format: "esm", external: ["electron"] }),
  // A sandboxed preload script cannot be an ES module.
  build({ ...shared, entryPoints: ["src/window/main/preload.ts"], outfile: "dist/preload.cjs", platform: "node", format: "cjs", external: ["electron"] }),
  buildWindow({ configFile: "vite.config.ts" })
]);
await chmod("dist/player-two.js", 0o755);
