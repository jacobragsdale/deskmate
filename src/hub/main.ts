/** The hub as a program: settings from the environment, where to listen from the arguments, and a line on standard error for each thing worth knowing. */

import type { Server } from "node:http";
import { parseArgs } from "node:util";

import { z } from "zod";

import { createHub } from "./app.ts";
import type { Log } from "./app.ts";

const settingsSchema = z
  .object({
    DESKMATE_JOIN_TOKEN: z.string("is not set").min(16, "must be at least 16 characters"),
    DESKMATE_DB: z.string("is not set").min(1, "is empty"),
    DESKMATE_REPOS: z.string("is not set").min(1, "is empty")
  })
  .transform((env) => ({ joinToken: env.DESKMATE_JOIN_TOKEN, db: env.DESKMATE_DB, repos: env.DESKMATE_REPOS }));
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

// Until the `deskmate` command exists (section D of phase 0), this file is how the hub is started: `node src/hub/main.ts`.
// The command's `hub` then calls runHub, and this goes: bundled into one file, it would start a hub whatever the command was.
if (import.meta.main) {
  try {
    runHub(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(`the hub cannot start: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
