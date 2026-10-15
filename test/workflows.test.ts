/** The hub running workflows: what sets a run off, each step, approvals across a restart, the webhook allow list and the limits, against a hub in this process on a clock the test moves. */

import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { z } from "zod";

import { readContent } from "../src/core/kinds.ts";
import type { Client } from "../src/desk/client.ts";
import { startHub } from "./startHub.ts";
import type { Hub } from "./startHub.ts";

/** A channel as one member reads it, oldest first: each message as its author and text, each step of a run as the hub reported it, anything else as its kind; `!` before an author whose signature fails. */
async function channel(client: Client, chat = "#ops"): Promise<string[]> {
  const events = (await client.events({ chat, limit: 200 })).reverse();
  return Promise.all(
    events.map(async (delivered) => {
      const { author } = delivered.event;
      const who = (await client.isTrusted(delivered)) ? author : `!${author}`;
      const said = readContent(delivered.event);
      if (said.kind === "message") {
        return `${who}: ${said.content.text}`;
      }
      if (said.kind === "workflow.run") {
        const { workflow, run, step, status, detail } = said.content;
        return `${who}: ${workflow} run ${String(run)} step ${String(step)} ${status}${detail === "" ? "" : `: ${detail}`}`;
      }
      return `${who}: ${delivered.event.kind}`;
    })
  );
}

/** Each run the hub keeps, as `name run step state`. */
function runs(hub: Hub): string[] {
  const db = new DatabaseSync(join(hub.dir, "hub.db"), { readOnly: true });
  try {
    return z
      .array(z.object({ name: z.string(), run: z.int(), step: z.int(), state: z.string() }))
      .parse(db.prepare("SELECT name, run, step, state FROM workflow_runs ORDER BY run").all())
      .map((row) => `${row.name} ${String(row.run)} ${String(row.step)} ${row.state}`);
  } finally {
    db.close();
  }
}

/** People who joined the hub and #ops, in that order. */
async function team(hub: Hub, ...names: readonly string[]): Promise<Client[]> {
  const clients: Client[] = [];
  for (const name of names) {
    const client = await hub.join(name);
    await client.publish("#ops", "channel.join", {});
    clients.push(client);
  }
  return clients;
}

const P1 = `name: p1
on:
  message: { contains: "P1" }
steps:
  - post: "{{trigger.author}} said: {{trigger.text}}"
  - post: "nobody said it"
    if: { equals: ["{{trigger.author}}", "nobody"] }
  - post: "and {{body.nothing}} is left as written"
`;

await test("a person's message holding a workflow's words sets off a run: its steps taken in turn, each followed by the hub's signed workflow.run, and the run kept as a row", async (t) => {
  const hub = await startHub(t);
  const [alice, bob] = await team(hub, "alice", "bob");
  assert.ok(alice !== undefined && bob !== undefined);
  const { event: definition } = await alice.publish("#ops", "workflow.define", { name: "p1", yaml: P1 });

  await bob.publish("#ops", "message", { text: "a P1 in prod", via: "cli" });
  await bob.publish("#ops", "message", { text: "a p1 in staging", via: "cli" }); // The words are matched as written.

  assert.deepEqual((await channel(alice)).slice(3), [
    "bob: a P1 in prod",
    "hub: bob said: a P1 in prod",
    "hub: p1 run 1 step 0 done",
    "hub: p1 run 1 step 1 skipped",
    "hub: and {{body.nothing}} is left as written",
    "hub: p1 run 1 step 2 done",
    "bob: a p1 in staging"
  ]);
  assert.deepEqual(runs(hub), ["p1 1 3 ended"]);
  // Each report names the definition it ran and the message its step posted.
  const reports = (await alice.events({ chat: "#ops" })).filter(({ event }) => event.kind === "workflow.run").reverse();
  const posted = (await alice.events({ chat: "#ops" })).filter(({ event }) => event.author === "hub" && event.kind === "message").reverse();
  assert.deepEqual(
    reports.map(({ event }) => event.refs),
    [[definition.id, posted[0]?.event.id], [definition.id], [definition.id, posted[1]?.event.id]]
  );
  assert.deepEqual(
    posted.map(({ event }) => readContent(event)),
    [
      { kind: "message", content: { text: "bob said: a P1 in prod", via: "workflow", workflow: "p1" } },
      { kind: "message", content: { text: "and {{body.nothing}} is left as written", via: "workflow", workflow: "p1" } }
    ]
  );
});
