/** The hub running workflows: what sets a run off, each step, approvals across a restart, the webhook allow list and the limits, against a hub in this process on a clock the test moves. */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { scheduledJobs } from "croner";
import { z } from "zod";

import { mentions } from "../src/core/chat.ts";
import { readContent } from "../src/core/kinds.ts";
import { fitText } from "../src/core/wire.ts";
import type { Client } from "../src/desk/client.ts";
import { NOW, startHub } from "./startHub.ts";
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

const LAUNCH = `name: launch
on:
  reaction: { emoji: "🚀" }
steps:
  - post: "{{trigger.author}} launched {{trigger.text}}"
`;

await test("adding a workflow's emoji to a message in its channel sets off a run with the message's text; another emoji, taking one back, or one on anything but a message does not", async (t) => {
  const hub = await startHub(t);
  const [alice, bob] = await team(hub, "alice", "bob");
  assert.ok(alice !== undefined && bob !== undefined);
  const { event: definition } = await alice.publish("#ops", "workflow.define", { name: "launch", yaml: LAUNCH });
  const { event: message } = await bob.publish("#ops", "message", { text: "v2.1", via: "cli" });

  await alice.publish("#ops", "reaction", { emoji: "👀", on: true }, [message.id]);
  await alice.publish("#ops", "reaction", { emoji: "🚀", on: true }, [definition.id]); // Not a message.
  await alice.publish("#ops", "reaction", { emoji: "🚀", on: true }, [message.id]);
  await alice.publish("#ops", "reaction", { emoji: "🚀", on: false }, [message.id]);

  assert.deepEqual((await channel(bob)).slice(-6), ["alice: reaction", "alice: reaction", "alice: reaction", "hub: alice launched v2.1", "hub: launch run 1 step 0 done", "alice: reaction"]);
});

const NIGHTLY = `name: nightly
on:
  schedule: { cron: "0 2 * * 1-5", zone: "Europe/London" }
steps:
  - post: "the nightly build starts"
`;

await test("a workflow on a schedule is timed by croner in its own time zone, sets off a run when its time comes, and is timed no more once it is replaced or removed, or by a hub that has stopped", async (t) => {
  const hub = await startHub(t);
  const [alice] = await team(hub, "alice");
  assert.ok(alice !== undefined);
  const timed = (): string[] => scheduledJobs.filter((job) => job.isRunning()).map((job) => `${job.name ?? ""} ${job.getPattern() ?? ""} ${job.options.timezone ?? ""}`);

  const { event: first } = await alice.publish("#ops", "workflow.define", { name: "nightly", yaml: NIGHTLY });
  assert.deepEqual(timed(), [`${first.id} 0 2 * * 1-5 Europe/London`]);
  const { event: second } = await alice.publish("#ops", "workflow.define", { name: "nightly", yaml: NIGHTLY.replace("0 2", "30 3").replace("Europe/London", "UTC") });
  assert.deepEqual(timed(), [`${second.id} 30 3 * * 1-5 UTC`]);
  await scheduledJobs.find((job) => job.name === second.id)?.trigger(); // Its time come, without waiting for it.
  assert.deepEqual((await channel(alice)).slice(-2), ["hub: the nightly build starts", "hub: nightly run 1 step 0 done"]);

  await alice.publish("#ops", "workflow.remove", { name: "nightly" });
  assert.deepEqual(timed(), []);
  const { event: third } = await alice.publish("#ops", "workflow.define", { name: "nightly", yaml: NIGHTLY });
  await hub.restart(); // The hub that stopped times nothing; the one that started times it again.
  assert.deepEqual(timed(), [`${third.id} 0 2 * * 1-5 Europe/London`]);
});

const CI = `name: ci-failure
on:
  webhook: { secret: "a-secret-for-ci" }
steps:
  - post: "The build failed on {{body.branch}}: {{body.url}}"
`;

await test("POST /hooks/ID sets off the live webhook workflow whose definition's id starts with ID, with its JSON body, once the secret it names comes in X-Player-Two-Secret; anything else is refused", async (t) => {
  const hub = await startHub(t);
  const [alice] = await team(hub, "alice");
  assert.ok(alice !== undefined);
  const { event: definition } = await alice.publish("#ops", "workflow.define", { name: "ci-failure", yaml: CI });
  const { event: open } = await alice.publish("#ops", "workflow.define", { name: "no-secret", yaml: "name: no-secret\non:\n  webhook: {}\nsteps:\n  - post: called\n" });
  const { event: nightly } = await alice.publish("#ops", "workflow.define", { name: "nightly", yaml: NIGHTLY });
  const hook = (id: string, body: string, secret: string | null = "a-secret-for-ci", method = "POST"): Promise<number> =>
    fetch(`${hub.url}/hooks/${id.slice(0, 32)}`, { method, headers: secret === null ? {} : { "X-Player-Two-Secret": secret }, ...(method === "POST" ? { body } : {}) }).then(async (response) => {
      await response.body?.cancel();
      return response.status;
    });
  const failed = JSON.stringify({ branch: "main", url: "https://ci.example/1" });

  assert.equal(await hook(definition.id, failed), 202);
  assert.deepEqual((await channel(alice)).slice(-2), ["hub: The build failed on main: https://ci.example/1", "hub: ci-failure run 1 step 0 done"]);
  assert.deepEqual(
    await Promise.all([
      hook(definition.id, failed, "a-secret-for-cj"),
      hook(definition.id, failed, null),
      hook(definition.id, failed, "short"),
      hook(definition.id, failed, "a-secret-for-ci".repeat(9))
    ]),
    [403, 403, 403, 403] // Wrong, missing, and of another length, which is refused like any other and not a failure of the comparison.
  );
  assert.deepEqual(
    await Promise.all([hook(nightly.id, failed), hook("0".repeat(32), failed), hook(definition.id, "{", "a-secret-for-ci"), hook(definition.id, failed, "a-secret-for-ci", "GET")]),
    [404, 404, 422, 405] // Not a webhook workflow, nobody's, not JSON, not a POST.
  );
  assert.equal((await fetch(`${hub.url}/hooks/${definition.id.slice(0, 31)}`, { method: "POST", body: failed })).status, 404); // Not an id at all.
  assert.equal(await hook(open.id, "", null), 202); // No body is no values; no secret named is none asked for.

  // At most 256 KB, cut off as it arrives.
  const padded = (bytes: number): string => JSON.stringify({ branch: "x".repeat(bytes - JSON.stringify({ branch: "" }).length) });
  assert.equal(await hook(definition.id, padded(256 * 1024)), 202);
  await assert.rejects(hook(definition.id, padded(256 * 1024 + 1)));
  assert.equal((await fetch(`${hub.url}/healthz`)).status, 200);

  // A definition replaced has a new hook, and the old one is no more.
  const { event: replaced } = await alice.publish("#ops", "workflow.define", { name: "ci-failure", yaml: CI });
  assert.deepEqual([await hook(definition.id, failed), await hook(replaced.id, failed)], [404, 202]);
  assert.deepEqual(runs(hub), ["ci-failure 1 1 ended", "no-secret 2 1 ended", "ci-failure 3 1 ended", "ci-failure 4 1 ended"]);
});

await test("the hook compares the secret it is given with the workflow's by timingSafeEqual over two buffers of the same length, whatever length it was given", async (t) => {
  const hub = await startHub(t);
  const [alice] = await team(hub, "alice");
  assert.ok(alice !== undefined);
  const { event: definition } = await alice.publish("#ops", "workflow.define", { name: "ci-failure", yaml: CI });
  const compared = t.mock.method(crypto, "timingSafeEqual");
  syncBuiltinESMExports(); // So the hub's own import of it is this one.
  t.after(() => {
    compared.mock.restore();
    syncBuiltinESMExports();
  });

  for (const secret of ["no", "a-secret-for-ci", "a much longer secret than the one it names"]) {
    await fetch(`${hub.url}/hooks/${definition.id.slice(0, 32)}`, { method: "POST", headers: { "X-Player-Two-Secret": secret }, body: "{}" });
  }

  assert.deepEqual(
    compared.mock.calls.map((call) => call.arguments.map((buffer) => buffer.byteLength)),
    [
      [32, 32],
      [32, 32],
      [32, 32]
    ]
  );
  assert.deepEqual(
    compared.mock.calls.map((call) => call.result),
    [false, true, false]
  );
});

const TAGS = `name: ci-failure
on:
  webhook: {}
steps:
  - post: "The build failed on {{body.branch}}, pushed by @{{body.who}}/uploader"
  - tag: "@bob/uploader"
    text: "The build at {{body.url}} failed. What broke? Ask @alice/billing too."
  - post: "{{body.pad}} @bob/uploader {{body.more}}"
`;

await test("post and tag publish the hub's messages, a tag's step ending once its message is stored; an agent is tagged only as the file writes it, never by a value filled in or by cutting a long text short", async (t) => {
  const hub = await startHub(t);
  const [alice] = await team(hub, "alice");
  assert.ok(alice !== undefined);
  const { event: definition } = await alice.publish("#ops", "workflow.define", { name: "ci-failure", yaml: TAGS });
  const cut = fitText("x".repeat(100_000)).length; // Where a long text is cut to fit an event.
  const body = { branch: "main @carol/secrets", who: "carol", url: "https://ci/1 @carol/secrets", pad: "x".repeat(cut - " @bob/u".length), more: "y".repeat(10_000) };

  const answer = await fetch(`${hub.url}/hooks/${definition.id.slice(0, 32)}`, { method: "POST", body: JSON.stringify(body) });

  assert.equal(answer.status, 202);
  const posted = (await alice.events({ chat: "#ops" })).flatMap(({ event }) => {
    const said = readContent(event);
    return event.author === "hub" && said.kind === "message" ? [said.content.text] : [];
  });
  assert.deepEqual(
    posted.reverse().map((text) => [text.length > 200 ? `${String(text.length)} characters` : text, mentions(text).map((tag) => tag.join("/"))]),
    [
      ["The build failed on main ＠carol/secrets, pushed by ＠carol/uploader", []],
      ["@bob/uploader The build at https://ci/1 ＠carol/secrets failed. What broke? Ask @alice/billing too.", ["bob/uploader", "alice/billing"]],
      [`${String(cut)} characters`, []] // It ended "@bob/u", which would tag someone else's agent.
    ]
  );
  assert.deepEqual(
    (await channel(alice)).filter((line) => line.startsWith("hub: ci-failure")),
    ["hub: ci-failure run 1 step 0 done", "hub: ci-failure run 1 step 1 done", "hub: ci-failure run 1 step 2 done"]
  );
  assert.deepEqual(runs(hub), ["ci-failure 1 3 ended"]);
});

/** The id of the newest message the hub posted in #ops, as `client` reads it. */
async function newestFromHub(client: Client): Promise<string> {
  const found = (await client.events({ chat: "#ops" })).find(({ event }) => event.author === "hub" && event.kind === "message");
  assert.ok(found !== undefined);
  return found.event.id;
}

const DEPLOY = `name: deploy
on:
  message: { contains: "ship it" }
steps:
  - approve: { from: jacob, text: "{{trigger.author}} asks: {{trigger.text}}. A 👍 from jacob lets it go.", within: "2h" }
  - post: "shipping"
`;

await test("an approval posts its text and waits, through the hub stopping and starting, for a 👍 on that message from the person it names, ignoring anyone else's, then moves on", async (t) => {
  const hub = await startHub(t);
  const [alice, bob, jacob] = await team(hub, "alice", "bob", "jacob");
  assert.ok(alice !== undefined && bob !== undefined && jacob !== undefined);
  const { event: definition } = await alice.publish("#ops", "workflow.define", { name: "deploy", yaml: DEPLOY });
  const { event: asked } = await bob.publish("#ops", "message", { text: "ship it v2", via: "cli" });
  const approval = await newestFromHub(alice);
  const before = (await channel(alice)).length;

  await hub.restart();
  await bob.publish("#ops", "reaction", { emoji: "👍", on: true }, [approval]); // Not the one it waits for.
  await jacob.publish("#ops", "reaction", { emoji: "👀", on: true }, [approval]); // Not a 👍.
  await jacob.publish("#ops", "reaction", { emoji: "👍", on: false }, [approval]); // Not one added.
  await jacob.publish("#ops", "reaction", { emoji: "👍", on: true }, [asked.id]); // Not on the message it waits on.
  assert.deepEqual(runs(hub), ["deploy 1 0 waiting"]);
  await jacob.publish("#ops", "reaction", { emoji: "👍", on: true }, [approval]);
  await jacob.publish("#ops", "reaction", { emoji: "👍", on: true }, [approval]); // Once it has moved on, another changes nothing.

  assert.deepEqual((await channel(alice)).slice(before - 3), [
    "bob: ship it v2",
    "hub: bob asks: ship it v2. A 👍 from jacob lets it go.",
    "hub: deploy run 1 step 0 waiting: for a 👍 from jacob",
    "bob: reaction",
    "jacob: reaction",
    "jacob: reaction",
    "jacob: reaction",
    "jacob: reaction",
    "hub: deploy run 1 step 0 approved: by jacob",
    "hub: shipping",
    "hub: deploy run 1 step 1 done",
    "jacob: reaction"
  ]);
  assert.deepEqual(runs(hub), ["deploy 1 2 ended"]);
  const steps = (await alice.events({ chat: "#ops" })).filter(({ event }) => event.kind === "workflow.run").map(({ event }) => event.refs);
  assert.deepEqual(steps.slice(1).reverse(), [
    [definition.id, approval],
    [definition.id, approval]
  ]); // The wait and its approval both name the message waited on.
});

const ANYONE = DEPLOY.replace("from: jacob", "from: anyone").replace('within: "2h"', 'within: "90m"');

await test("an approval from anyone takes any member's 👍; past its time, a 👍 or the hub starting ends it as expired; replacing or removing its workflow cancels it", async (t) => {
  let clock = NOW;
  const hub = await startHub(t, () => clock);
  const [alice, bob] = await team(hub, "alice", "bob");
  assert.ok(alice !== undefined && bob !== undefined);
  await alice.publish("#ops", "workflow.define", { name: "deploy", yaml: ANYONE });
  const waiting = async (text: string): Promise<string> => {
    await bob.publish("#ops", "message", { text, via: "cli" });
    return newestFromHub(alice);
  };
  const thumbsUp = async (on: string, emoji = "👍"): Promise<void> => {
    await bob.publish("#ops", "reaction", { emoji, on: true }, [on]);
  };

  await thumbsUp(await waiting("ship it 1"), "👍🏽"); // Anyone, in any skin tone.
  const late = await waiting("ship it 2");
  clock += 90 * 60;
  await thumbsUp(late); // In time, to the second.
  const later = await waiting("ship it 3");
  clock += 90 * 60 + 1;
  await thumbsUp(later);
  await waiting("ship it 4");
  clock += 90 * 60 + 1;
  await hub.restart();
  await waiting("ship it 5");
  await alice.publish("#ops", "workflow.define", { name: "deploy", yaml: ANYONE.replace("shipping", "shipping now") });
  await waiting("ship it 6");
  await alice.publish("#ops", "workflow.remove", { name: "deploy" });

  assert.deepEqual(
    (await channel(alice)).filter((line) => line.startsWith("hub: deploy") || line === "hub: shipping"),
    [
      "hub: deploy run 1 step 0 waiting: for a 👍 from anyone in #ops",
      "hub: deploy run 1 step 0 approved: by bob",
      "hub: shipping",
      "hub: deploy run 1 step 1 done",
      "hub: deploy run 2 step 0 waiting: for a 👍 from anyone in #ops",
      "hub: deploy run 2 step 0 approved: by bob",
      "hub: shipping",
      "hub: deploy run 2 step 1 done",
      "hub: deploy run 3 step 0 waiting: for a 👍 from anyone in #ops",
      "hub: deploy run 3 step 0 expired: no 👍 came in time",
      "hub: deploy run 4 step 0 waiting: for a 👍 from anyone in #ops",
      "hub: deploy run 4 step 0 expired: no 👍 came in time",
      "hub: deploy run 5 step 0 waiting: for a 👍 from anyone in #ops",
      "hub: deploy run 5 step 0 cancelled: deploy was replaced",
      "hub: deploy run 6 step 0 waiting: for a 👍 from anyone in #ops",
      "hub: deploy run 6 step 0 cancelled: deploy was removed"
    ]
  );
  assert.deepEqual(runs(hub), ["deploy 1 2 ended", "deploy 2 2 ended", "deploy 3 0 ended", "deploy 4 0 ended", "deploy 5 0 ended", "deploy 6 0 ended"]);
});
