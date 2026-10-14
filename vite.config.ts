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

// Two dependencies write a <style> element as they run, which the page's content security policy refuses: Sonner its whole stylesheet as it loads, and Radix's scroll area a rule that hides the native scroll bars.
// globals.css loads the same CSS from a file, and this takes the two writes out as they are bundled. The build stops if one is no longer there to take out, so a new version is looked at before it meets the policy.
const STYLE_ELEMENTS: readonly { readonly file: string; readonly write: RegExp }[] = [
  { file: "/node_modules/sonner/dist/", write: /^__insertCSS\(".*"\);$/m },
  { file: "/node_modules/@radix-ui/react-scroll-area/dist/", write: /\/\* @__PURE__ \*\/ jsx\(ScrollAreaViewportStyle, \{ nonce \}\),/ }
];
const noStyleElements: Plugin = {
  name: "no-style-elements",
  transform(code, id) {
    const found = STYLE_ELEMENTS.find((each) => id.includes(each.file));
    if (found === undefined) {
      return null;
    }
    if (!found.write.test(code)) {
      throw new Error(`${id} no longer writes its <style> element the way vite.config.ts expects: look at how it does now, before it meets the content security policy`);
    }
    return { code: code.replace(found.write, ""), map: null };
  }
};

export default defineConfig({
  root: renderer,
  base: "./", // The page is opened from a file, so everything it loads is named relative to it.
  plugins: [react(), tailwindcss(), noStyleElements],
  // react-style-singleton writes <style> elements, which the page's content security policy refuses; see styleSingleton.ts.
  resolve: { alias: { "@": renderer, "react-style-singleton": join(renderer, "styleSingleton.ts") } },
  define: { PLAYER_TWO_HUB_URL: JSON.stringify(hub) },
  // The page is read from disk, never downloaded, so one bundle is right and Vite's warning about its size does not apply.
  build: { outDir: join(import.meta.dirname, "dist/renderer"), emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: 2000 }
});
