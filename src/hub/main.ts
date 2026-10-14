/** The hub as a program: settings from the environment, where to listen from the arguments, and a line on standard error for each thing worth knowing. */

import type { Server } from "node:http";
import { parseArgs } from "node:util";

import { z } from "zod";

import { createHub } from "./app.ts";
import type { Log } from "./app.ts";

const settingsSchema = z
  .object({
    PLAYER_TWO_JOIN_TOKEN: z.string("is not set").min(16, "must be at least 16 characters"),
    PLAYER_TWO_DB: z.string("is not set").min(1, "is empty"),
    PLAYER_TWO_REPOS: z.string("is not set").min(1, "is empty"),
    PLAYER_TWO_DOWNLOADS: z.string().default("") // Optional: without it the hub serves no installers.
  })
  .transform((env) => ({ joinToken: env.PLAYER_TWO_JOIN_TOKEN, db: env.PLAYER_TWO_DB, repos: env.PLAYER_TWO_REPOS, downloads: env.PLAYER_TWO_DOWNLOADS }));
const portSchema = z.string().regex(/^\d+$/).transform(Number).pipe(z.int().max(65_535));

const log: Log = (event, facts) => {
  console.error([event, ...Object.entries(facts).map(([key, value]) => `${key}=${String(value)}`)].join(" "));
};

/** Start the hub and return its server. Throws, with words for whoever started it, when a setting is missing or wrong. */
export function runHub(args: readonly string[], env: NodeJS.ProcessEnv): Server {
  const { values } = parseArgs({ args: [...args], options: { host: { type: "string", default: "127.0.0.1" }, port: { type: "string", default: "8787" } } });
  const settings = settingsSchema.safeParse(env);
  const port = portSchema.safeParse(values.port);
  if (!settings.success) {
    throw new Error(settings.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; "));
  }
  if (!port.success) {
    throw new Error(`--port ${values.port} is not a port number`);
  }
  const server = createHub(settings.data, undefined, log);
  server.listen(port.data, values.host, () => {
    const address = server.address();
    log("hub listening", { host: values.host, port: address !== null && typeof address === "object" ? address.port : port.data });
  });
  process.once("SIGTERM", () => {
    log("hub stopping", {});
    // Nothing in flight is worth waiting for: a request is answered in one turn of the loop once it has arrived, and a reader holding a long-poll open just asks again.
    server.close();
    server.closeAllConnections();
  });
  return server;
}
