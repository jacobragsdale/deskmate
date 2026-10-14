// Builds the window's page into dist/renderer. build.mjs runs it after the command, the main process and the preload script.
import { join } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

const renderer = join(import.meta.dirname, "src/window/renderer");

// A team's own build can carry its hub's address, so the join form asks only for a name and the token.
const hub = process.env["PLAYER_TWO_HUB_URL"] ?? "";
if (hub !== "" && !/^https?:\/\/\S*[^/\s]$/.test(hub)) {
  throw new Error(`PLAYER_TWO_HUB_URL must be the hub's http or https address with no slash at the end, not ${JSON.stringify(hub)}`);
}

// Sonner writes its stylesheet into a <style> element as it loads, which the page's content security policy refuses. globals.css imports the same stylesheet from Sonner's own file, so that one call is taken out.
const SONNER_INSERTS_CSS = /^__insertCSS\(".*"\);$/m;
const sonnerStylesFromFile: Plugin = {
  name: "sonner-styles-from-file",
  transform(code, id) {
    if (!id.includes("/node_modules/sonner/dist/")) {
      return null;
    }
    if (!SONNER_INSERTS_CSS.test(code)) {
      throw new Error(`${id} no longer adds its stylesheet the way vite.config.ts expects: look again at how it does, before its <style> element meets the content security policy`);
    }
    return { code: code.replace(SONNER_INSERTS_CSS, ""), map: null };
  }
};

export default defineConfig({
  root: renderer,
  base: "./", // The page is opened from a file, so everything it loads is named relative to it.
  plugins: [react(), tailwindcss(), sonnerStylesFromFile],
  // react-style-singleton writes <style> elements, which the page's content security policy refuses; see styleSingleton.ts.
  resolve: { alias: { "@": renderer, "react-style-singleton": join(renderer, "styleSingleton.ts") } },
  define: { PLAYER_TWO_HUB_URL: JSON.stringify(hub) },
  // The page is read from disk, never downloaded, so one bundle is right and Vite's warning about its size does not apply.
  build: { outDir: join(import.meta.dirname, "dist/renderer"), emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: 2000 }
});
