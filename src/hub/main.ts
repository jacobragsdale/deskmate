/** The hub as a program: settings from the environment, where to listen from the arguments, and a line on standard error for each thing worth knowing; and checking its log's chain. */

import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { parseArgs } from "node:util";

import { z } from "zod";

import { problemOf } from "../core/text.ts";
import { createHub } from "./app.ts";
import type { Log } from "./app.ts";
import { verifyChain } from "./db.ts";
import { allowList } from "./workflows.ts";

const settingsSchema = z
  .object({
    PLAYER_TWO_JOIN_TOKEN: z.string("is not set").min(16, "must be at least 16 characters"),
    PLAYER_TWO_DB: z.string("is not set").min(1, "is empty"),
    PLAYER_TWO_REPOS: z.string("is not set").min(1, "is empty"),
    PLAYER_TWO_DOWNLOADS: z.string().default(""), // Optional: without it the hub serves no installers.
    // Optional: without it no workflow's webhook step calls anything.
    PLAYER_TWO_WEBHOOK_ALLOW: z
      .string()
      .default("")
      .transform((text, ctx) => {
        try {
          return allowList(text);
        } catch (error) {
          ctx.addIssue({ code: "custom", message: problemOf(error) });
          return z.NEVER;
        }
      })
  })
  .transform((env) => ({ joinToken: env.PLAYER_TWO_JOIN_TOKEN, db: env.PLAYER_TWO_DB, repos: env.PLAYER_TWO_REPOS, downloads: env.PLAYER_TWO_DOWNLOADS, webhooks: env.PLAYER_TWO_WEBHOOK_ALLOW }));
const portSchema = z.string().regex(/^\d+$/).transform(Number).pipe(z.int().max(65_535));
const dbSchema = z.object({ PLAYER_TWO_DB: z.string("is not set").min(1, "is empty") });

const log: Log = (event, facts) => {
  console.error([event, ...Object.entries(facts).map(([key, value]) => `${key}=${String(value)}`)].join(" "));
};

/**
 * Do `work` on the database at `path`, and when SQLite refuses the file, as with "unable to open database file" for a folder the hub cannot write in, "file is not a database" or
 * "attempt to write a readonly database", say which file: SQLite's own words do not. The hub's own refusals of a database name it already.
 */
function onDatabase<T>(path: string, work: () => T): T {
  try {
    return work();
  } catch (error) {
    throw error instanceof Error && "code" in error && error.code === "ERR_SQLITE_ERROR" ? new Error(`${path}: ${error.message}`) : error;
  }
}

/**
 * Start the hub and resolve with its server once it is listening. Rejects, with words for whoever started it, when a setting is missing or wrong, or when it cannot listen where it was
 * told to, as when another program holds the port, and then closes its database first.
 */
export async function runHub(args: readonly string[], env: NodeJS.ProcessEnv): Promise<Server> {
  const { values } = parseArgs({ args: [...args], options: { host: { type: "string", default: "127.0.0.1" }, port: { type: "string", default: "8787" } } });
  const settings = settingsSchema.safeParse(env);
  const port = portSchema.safeParse(values.port);
  if (!settings.success) {
    throw new Error(settings.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; "));
  }
  if (!port.success) {
    throw new Error(`--port ${values.port} is not a port number`);
  }
  const server = onDatabase(settings.data.db, () => createHub(settings.data, undefined, log));
  await new Promise<void>((resolve, reject) => {
    // Only while it starts: an error then is the port or the host, said in one line rather than as Node's unhandled 'error' with its stack.
    const failed = (error: Error): void => {
      server.close(); // Which closes the database.
      reject(new Error(`the hub cannot listen on ${values.host} port ${values.port}: ${problemOf(error)}`));
    };
    server.once("error", failed);
    server.listen(port.data, values.host, () => {
      server.off("error", failed);
      resolve();
    });
  });
  const address = server.address();
  log("hub listening", { host: values.host, port: address !== null && typeof address === "object" ? address.port : port.data });
  const stop = (): void => {
    log("hub stopping", {});
    // Nothing in flight is worth waiting for: a request is answered in one turn of the loop once it has arrived, and a reader holding the stream open opens it again from where it was.
    server.close();
    server.closeAllConnections();
  };
  process.once("SIGTERM", stop);
  // Ctrl-C too, which the hub as a container's first process, with no handler, would never hear: `docker run -it` could not be stopped from its terminal, nor `docker kill -s INT` stop it.
  process.once("SIGINT", stop);
  return server;
}

/** `player-two hub verify`: walk the log in the database PLAYER_TWO_DB names and return what to say when its chain holds. Throws, naming the first seq that breaks it, when it does not, and the first agent whose key in the agents table the log does not give it. */
export function verifyHub(env: NodeJS.ProcessEnv): string {
  const setting = dbSchema.safeParse(env);
  if (!setting.success) {
    throw new Error(`PLAYER_TWO_DB ${setting.error.issues[0]?.message ?? "is not set"}`);
  }
  if (!existsSync(setting.data.PLAYER_TWO_DB)) {
    throw new Error(`there is no database at ${setting.data.PLAYER_TWO_DB}`); // Rather than SQLite's words, which do not say where it looked.
  }
  const { events, head, broken, agents } = onDatabase(setting.data.PLAYER_TWO_DB, () => verifyChain(setting.data.PLAYER_TWO_DB));
  if (broken !== null) {
    throw new Error(`the chain breaks at seq ${String(broken.seq)}: ${broken.why}`);
  }
  if (agents !== null) {
    throw new Error(`the chain holds, but ${agents}`); // The hub would check that agent's events against a key the log does not give it.
  }
  return `the chain holds: ${String(events)} events, the last chain value ${head}`;
}
