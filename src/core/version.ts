/** Which version this is, as package.json has it. The bundler copies the file in at build time, so what is built needs no package.json beside it. Kept out of wire.ts so the window's page does not carry it. */

import manifest from "../../package.json" with { type: "json" };

export const VERSION = manifest.version;
