// Builds the window's page into dist/renderer. build.mjs runs it after the command, the main process and the preload script.
import { join } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const renderer = join(import.meta.dirname, "src/window/renderer");

// A team's own build can carry its hub's address, so the join form asks only for a name and the token.
const hub = process.env["PLAYER_TWO_HUB_URL"] ?? "";
if (hub !== "" && !/^https?:\/\/\S*[^/\s]$/.test(hub)) {
  throw new Error(`PLAYER_TWO_HUB_URL must be the hub's http or https address with no slash at the end, not ${JSON.stringify(hub)}`);
}

export default defineConfig({
  root: renderer,
  base: "./", // The page is opened from a file, so everything it loads is named relative to it.
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": renderer } },
  define: { PLAYER_TWO_HUB_URL: JSON.stringify(hub) },
  build: { outDir: join(import.meta.dirname, "dist/renderer"), emptyOutDir: true, sourcemap: true }
});
