/** The hub running workflows: what sets a run off, each step, approvals across a restart, the webhook allow list and the limits, against a hub in this process on a clock the test moves. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import dns from "node:dns";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, setGlobalProxyFromEnv } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Duplex } from "node:stream";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { Cron } from "croner";
import { z } from "zod";

import { mentions } from "../src/core/chat.ts";
import { readContent } from "../src/core/kinds.ts";
import { newKey, signEvent } from "../src/core/sign.ts";
import { fitText } from "../src/core/wire.ts";
import type { Client } from "../src/desk/client.ts";
import { Session } from "../src/desk/session.ts";
import { Database } from "../src/hub/db.ts";
import { allowList, comesRound, lookupWithin, refusal, runWorkflows } from "../src/hub/workflows.ts";
import { checkout, NOW, ownHome, startHub, TEAM_REPOS } from "./startHub.ts";
import type { Hub } from "./startHub.ts";

ownHome(); // git commits in the scenario's checkout as a test identity, never with the user's own configuration.

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

/** Each run the hub keeps, as `name run step state`, or as the columns asked for. */
function runs(hub: Hub, columns = "name, run, step, state"): string[] {
  const db = new DatabaseSync(join(hub.dir, "hub.db"), { readOnly: true });
  try {
    return z
      .array(z.record(z.string(), z.union([z.string(), z.int()])))
      .parse(db.prepare(`SELECT ${columns} FROM workflow_runs ORDER BY run`).all())
      .map((row) => Object.values(row).map(String).join(" "));
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

await test("a workflow on a schedule sets off a run as its line comes round in its own time zone, the hub looking at each minute as it begins by its clock, and no longer once it is replaced or removed", async (t) => {
  let clock = NOW;
  const hub = await startHub(t, () => clock);
  const [alice] = await team(hub, "alice");
  assert.ok(alice !== undefined);
  /** Bring the hub's clock to a moment before `iso` and start the hub again, which looks at the schedules as that minute begins; then give it time to. */
  const comeTo = async (iso: string): Promise<void> => {
    clock = Date.parse(iso) / 1000 - 0.02;
    await hub.restart();
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
  };

  await alice.publish("#ops", "workflow.define", { name: "nightly", yaml: NIGHTLY });
  await alice.publish("#ops", "workflow.define", { name: "nightly", yaml: NIGHTLY.replace("0 2", "30 3").replace("Europe/London", "UTC") });
  await comeTo("2027-01-18T02:00:00Z"); // A Monday, at 02:00 in London: the line replaced comes round no more.
  await comeTo("2027-01-18T03:30:00Z");
  assert.deepEqual((await channel(alice)).slice(-2), ["hub: the nightly build starts", "hub: nightly run 1 step 0 done"]);

  await alice.publish("#ops", "workflow.remove", { name: "nightly" });
  await comeTo("2027-01-19T03:30:00Z");
  await alice.publish("#ops", "workflow.define", { name: "nightly", yaml: NIGHTLY });
  await comeTo("2027-01-20T02:00:00Z");
  assert.deepEqual(runs(hub, "name, run, started"), [`nightly 1 ${String(Date.parse("2027-01-18T03:29:59Z") / 1000)}`, `nightly 2 ${String(Date.parse("2027-01-20T01:59:59Z") / 1000)}`]); // Started by the clock standing just before.
});

await test("where the clocks go back, a line naming a time of day comes round at the first of the two and one with a * in its minute or hour at both; a time the clocks skip never comes round", () => {
  /** The UTC times, as HH:MM, from `from` up to `to`, at which `line` comes round in `zone`. */
  const comes = (line: string, zone: string, from: string, to: string): string[] => {
    const cron = new Cron(line, { timezone: zone, mode: "5-part" });
    const times: string[] = [];
    for (let at = Date.parse(from) / 1000; at < Date.parse(to) / 1000; at += 60) {
      if (comesRound(cron, zone, at)) {
        times.push(new Date(at * 1000).toISOString().slice(11, 16));
      }
    }
    return times;
  };
  // On 25 October 2026 London's clocks go back from 02:00 BST to 01:00 GMT, so 01:00 to 01:59 comes round from 00:00 UTC and again from 01:00 UTC; New York's do on 1 November.
  assert.deepEqual(comes("30 1 * * *", "Europe/London", "2026-10-24T23:00Z", "2026-10-25T03:00Z"), ["00:30"]);
  assert.deepEqual(comes("@daily", "Europe/London", "2026-10-24T22:00Z", "2026-10-25T03:00Z"), ["23:00"]);
  assert.deepEqual(comes("30 1 * * *", "America/New_York", "2026-11-01T04:00Z", "2026-11-01T08:00Z"), ["05:30"]);
  assert.deepEqual(comes("45 1 * * *", "Australia/Lord_Howe", "2027-04-03T14:00Z", "2027-04-03T16:00Z"), ["14:45"]); // Half an hour back, from 02:00 to 01:30.
  assert.equal(comes("* * * * *", "Europe/London", "2026-10-25T00:00Z", "2026-10-25T02:00Z").length, 120);
  assert.deepEqual(comes("30 * * * *", "Europe/London", "2026-10-24T23:00Z", "2026-10-25T03:00Z"), ["23:30", "00:30", "01:30", "02:30"]);
  assert.deepEqual(comes("0,30 1 * * *", "Europe/London", "2026-10-24T23:00Z", "2026-10-25T03:00Z"), ["00:00", "00:30"]);
  // On 28 March 2027 they go forward from 01:00 GMT to 02:00 BST: 01:30 is never the time in London that day.
  assert.deepEqual(comes("30 1 * * *", "Europe/London", "2027-03-27T23:00Z", "2027-03-28T04:00Z"), []);
});

await test("the workflows keep parsed only the files of those live, however often one is replaced or removed", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "player-two-workflows-"));
  const db = new Database(join(dir, "hub.db"));
  const nothing = (): undefined => undefined;
  const flows = runWorkflows(db, db.hubKey(), () => NOW, [], nothing, nothing);
  t.after(() => {
    flows.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const alice = newKey();
  /** Store alice's definition or removal as the hub does, and hand it to the workflows. */
  const publish = (content: { readonly name: string; readonly yaml?: string }): void => {
    const kind = content.yaml === undefined ? "workflow.remove" : "workflow.define";
    const event = signEvent(alice, { author: "alice", to: "#ops", kind, content: JSON.stringify(content), ts: NOW, refs: [] });
    db.transaction(() => {
      db.addEvent(event);
      if (content.yaml === undefined) {
        db.removeWorkflow("#ops", content.name);
      } else {
        db.setWorkflow("#ops", content.name, event.id);
      }
    });
    flows.seen(event);
  };

  publish({ name: "p1", yaml: P1 });
  publish({ name: "nightly", yaml: NIGHTLY });
  for (let n = 0; n < 20; n += 1) {
    publish({ name: "nightly", yaml: NIGHTLY.replace("starts", `starts ${String(n)}`) });
  }
  assert.equal(flows.parsed(), 2);
  publish({ name: "p1" });
  assert.equal(flows.parsed(), 1);
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
  await alice.publish("#ops", "workflow.remove", { name: "ci-failure" });
  assert.deepEqual([await hook(replaced.id, failed), await hook(open.id, "", null)], [404, 202]); // One removed has none, and the others are as they were.
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

await test("a 👍 lets an approval go only in its own channel, and a reaction sets off a workflow only on a message in the workflow's channel", async (t) => {
  const hub = await startHub(t);
  const [alice, bob] = await team(hub, "alice", "bob");
  assert.ok(alice !== undefined && bob !== undefined);
  for (const each of [alice, bob]) {
    await each.publish("#elsewhere", "channel.join", {});
  }
  await alice.publish("#ops", "workflow.define", { name: "deploy", yaml: ANYONE });
  await alice.publish("#elsewhere", "workflow.define", { name: "launch", yaml: LAUNCH });
  const { event: asked } = await bob.publish("#ops", "message", { text: "ship it", via: "cli" });

  // Sent to #elsewhere, each naming a message of #ops: the hub stores both, as it stores any reaction from a member.
  await bob.publish("#elsewhere", "reaction", { emoji: "👍", on: true }, [await newestFromHub(alice)]);
  await bob.publish("#elsewhere", "reaction", { emoji: "🚀", on: true }, [asked.id]);

  assert.deepEqual(runs(hub), ["deploy 1 0 waiting"]);
  assert.deepEqual(await channel(alice, "#elsewhere"), ["alice: channel.join", "bob: channel.join", "alice: workflow.define", "bob: reaction", "bob: reaction"]);
});

await test("the allow list names hosts, each a name and every name under it at a dot, or one IP address; http goes only to a host it names exactly, and nothing at all when it names none", () => {
  const allow = allowList(" Example.COM, ci.corp.internal ,10.0.0.5,[0:0::1], bücher.example,");
  assert.deepEqual(allow, ["example.com", "ci.corp.internal", "10.0.0.5", "[::1]", "xn--bcher-kva.example"]);
  const not = (host: string): string => `${host} is not on PLAYER_TWO_WEBHOOK_ALLOW`;
  const cases = [
    ["https://example.com/retry", ""],
    ["https://ci.example.com:8443/retry?build=7", ""],
    ["https://%65xample.com/", ""], // The host as the address reads, once its percent-encoding is undone.
    ["https://bücher.example/", ""],
    ["https://evil-example.com/", not("evil-example.com")],
    ["https://evilexample.com/", not("evilexample.com")],
    ["https://example.com.evil.com/", not("example.com.evil.com")],
    ["https://example.com./", not("example.com.")],
    ["https://10.0.0.5/", ""],
    ["https://0xa.0.0.5/", ""], // The same address, written another way.
    ["https://10.0.0.6/", not("10.0.0.6")],
    ["https://0.5/", not("0.0.0.5")], // An address is never under a name, here "0.5".
    ["https://2130706433/", not("127.0.0.1")],
    ["https://[::1]/", ""],
    ["https://[::ffff:127.0.0.1]/", not("[::ffff:7f00:1]")],
    ["https://user:secret@example.com/", "an address with a user name or password in it is never called"],
    ["https://example.com@evil.com/", "an address with a user name or password in it is never called"],
    ["http://ci.corp.internal/retry", ""],
    ["http://build.ci.corp.internal/", "http goes only to a host PLAYER_TWO_WEBHOOK_ALLOW names exactly, which build.ci.corp.internal is under; use https"],
    ["http://10.0.0.5/", ""],
    ["ftp://example.com/", "not an https or http address once filled in"],
    ["https://exa mple.com/", "not an https or http address once filled in"]
  ] as const;
  for (const [address, why] of cases) {
    assert.equal(refusal(address, allow), why, address);
  }
  assert.equal(refusal("https://example.com/", []), "PLAYER_TWO_WEBHOOK_ALLOW is not set, so the hub calls no address");
  for (const entry of ["example.com:443", "https://example.com", "example.com/retry", "*.example.com", "user@example.com", "[example]"]) {
    assert.throws(() => allowList(entry), new RegExp(`^Error: ${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not a host name or an IP address`), entry);
  }
  assert.deepEqual(allowList(""), []);
});

/** A server for a webhook step to call, on this machine: each call it took, as its path, content type and body; and how it answers each. */
async function target(
  t: TestContext,
  answer: (response: ServerResponse) => void = (response) => response.end("an answer the chat must never see")
): Promise<{ readonly url: string; readonly calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8").on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      calls.push(`${request.url ?? ""} ${request.headers["content-type"] ?? ""} ${body}`);
      answer(response);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      })
  );
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return { url: `http://127.0.0.1:${String(address.port)}`, calls };
}

/** Wait until the channel as `client` reads it holds a line that `wanted` matches, and return the channel. */
async function until(client: Client, wanted: RegExp): Promise<string[]> {
  for (let tries = 0; tries < 300; tries += 1) {
    const lines = await channel(client);
    if (lines.some((line) => wanted.test(line))) {
      return lines;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(`never came: ${String(wanted)}\n${(await channel(client)).join("\n")}`);
}

/** A webhook workflow, set off by a hook with an empty secret-less body, whose steps are `steps` in YAML. */
const hooked = (name: string, ...steps: readonly string[]): string => `name: ${name}\non:\n  webhook: {}\nsteps:\n${steps.map((step) => `  - ${step}\n`).join("")}`;

/** Set off a webhook workflow published as `definition` with `body`. */
async function setOff(hub: Hub, definition: string, body: unknown = {}): Promise<void> {
  const answer = await fetch(`${hub.url}/hooks/${definition.slice(0, 32)}`, { method: "POST", body: JSON.stringify(body) });
  assert.equal(answer.status, 202);
}

await test("a webhook step POSTs its body to a host on the allow list, each value filled into a JSON body as JSON and into the address percent-encoded, and is done at a 2xx; nothing of the answer reaches the chat", async (t) => {
  const called = await target(t);
  const hub = await startHub(t, () => NOW, "", TEAM_REPOS, ["127.0.0.1"]);
  const [alice] = await team(hub, "alice");
  assert.ok(alice !== undefined);
  const yaml = hooked(
    "retry",
    `webhook: { url: "${called.url}/retry/{{body.path}}?build={{body.id}}", body: '{"build": "{{body.id}}", "note": "{{body.note}}", "missing": "{{body.none}}"}' }`,
    `webhook: { url: "${called.url}/plain" }`,
    `webhook: { url: "${called.url}/text", body: "build {{body.note}}" }`,
    `post: "retried"`
  );
  const { event: definition } = await alice.publish("#ops", "workflow.define", { name: "retry", yaml });

  await setOff(hub, definition.id, { id: 7, path: "../admin?all=1", note: 'a "note", }, {"x": 1' });

  const lines = await until(alice, /retry run 1 step 3 done/);
  assert.deepEqual(lines.slice(-5), ["hub: retry run 1 step 0 done", "hub: retry run 1 step 1 done", "hub: retry run 1 step 2 done", "hub: retried", "hub: retry run 1 step 3 done"]);
  assert.deepEqual(called.calls, [
    '/retry/..%2Fadmin%3Fall%3D1?build=7 application/json {"build": "7", "note": "a \\"note\\", }, {\\"x\\": 1", "missing": "{{body.none}}"}',
    "/plain text/plain; charset=utf-8 ",
    '/text text/plain; charset=utf-8 build a "note", }, {"x": 1'
  ]);
  assert.deepEqual(JSON.parse(called.calls[0]?.split(" application/json ")[1] ?? ""), { build: "7", note: 'a "note", }, {"x": 1', missing: "{{body.none}}" }); // The shape it was written in.
  assert.ok(lines.every((line) => !line.includes("must never see")));
});

await test("a webhook step is refused with the allow list unset, to a host not on it, and to a name that leads to this machine; it fails at an answer that is not 2xx, a redirect, which it does not follow, more than 1 MB, or no connection; each ends its run", async (t) => {
  const redirected = await target(t);
  const answers = new Map<string, (response: ServerResponse) => unknown>([
    ["/500", (response) => response.writeHead(500).end()],
    ["/302", (response) => response.writeHead(302, { Location: `${redirected.url}/followed` }).end()],
    ["/big", (response) => response.end("x".repeat(1024 * 1024 + 1))],
    ["/1mb", (response) => response.end("x".repeat(1024 * 1024))]
  ]);
  const called = await target(t, (response) => {
    const path = called.calls.at(-1)?.split(" ")[0] ?? "";
    (answers.get(path) ?? ((other: ServerResponse): unknown => other.end()))(response);
  });
  const hubs = { unset: await startHub(t), listed: await startHub(t, () => NOW, "", TEAM_REPOS, ["127.0.0.1"]), named: await startHub(t, () => NOW, "", TEAM_REPOS, ["localhost"]) };
  let made = 0;
  /** How a run of a workflow that calls `url` then posts went on the hub `which`: its first step's outcome, and whether it went on. */
  const outcome = async (which: keyof typeof hubs, url: string): Promise<string> => {
    made += 1;
    const name = `w${String(made)}`;
    const [person] = await team(hubs[which], `p${String(made)}`);
    assert.ok(person !== undefined);
    const { event } = await person.publish("#ops", "workflow.define", { name, yaml: hooked(name, `webhook: { url: "${url}" }`, `post: "${name} went on"`) });
    await setOff(hubs[which], event.id);
    const lines = await until(person, new RegExp(`${name} run \\d+ step 0`));
    return `${(lines.find((line) => line.includes(`${name} run`)) ?? "").replace(/^hub: \w+ run \d+ step 0 /, "")}${lines.includes(`hub: ${name} went on`) ? " and went on" : ""}`;
  };

  assert.equal(await outcome("unset", `${called.url}/ok`), "refused: PLAYER_TWO_WEBHOOK_ALLOW is not set, so the hub calls no address");
  assert.equal(await outcome("listed", "https://ci.corp.internal/retry"), "refused: ci.corp.internal is not on PLAYER_TWO_WEBHOOK_ALLOW");
  assert.match(
    await outcome("named", `${called.url.replace("127.0.0.1", "localhost")}/ok`),
    /^refused: localhost is at (127\.0\.0\.1|::1), which the hub calls only when PLAYER_TWO_WEBHOOK_ALLOW names that address$/
  );
  assert.deepEqual(called.calls, []);
  const host = new URL(called.url).host;
  assert.equal(await outcome("listed", `${called.url}/500`), `failed: ${host} answered 500`);
  assert.equal(await outcome("listed", `${called.url}/302`), `failed: ${host} answered 302, and the hub follows no redirect`);
  assert.equal(await outcome("listed", `${called.url}/big`), `failed: ${host} answered with more than 1 MB`);
  assert.equal(await outcome("listed", `${called.url}/1mb`), "done and went on");
  assert.equal(await outcome("listed", "http://127.0.0.1:1/"), "failed: could not call 127.0.0.1:1: ECONNREFUSED"); // Nothing listens there.
  assert.deepEqual(redirected.calls, []);
});

await test("a step the hub cannot take ends its run as failed, a detail is cut to fit an event however long a host filled in, and a run that has ended keeps none of its values", async (t) => {
  const hub = await startHub(t, () => NOW, "", TEAM_REPOS, ["example.test"]);
  const [alice] = await team(hub, "alice");
  assert.ok(alice !== undefined);
  const { event: odd } = await alice.publish("#ops", "workflow.define", { name: "odd", yaml: hooked("odd", 'webhook: { url: "https://example.test/{{body.x}}" }', 'post: "called"') });
  const { event: long } = await alice.publish("#ops", "workflow.define", { name: "long", yaml: hooked("long", 'webhook: { url: "https://{{body.host}}/x" }') });

  const answer = await fetch(`${hub.url}/hooks/${odd.id.slice(0, 32)}`, { method: "POST", body: '{"x": "\\ud800"}' }); // Half a character, which JSON may hold and no address can.
  assert.equal(answer.status, 202);
  await setOff(hub, long.id, { host: "a".repeat(70_000) });

  const reason = " is not on PLAYER_TWO_WEBHOOK_ALLOW";
  const cut = `${"a".repeat(250)}…${"a".repeat(249 - reason.length)}${reason}`; // 500 characters, cut in the middle so the reason still ends as written.
  assert.deepEqual((await until(alice, /long run 2 step 0/)).slice(-2), ["hub: odd run 1 step 0 failed: the hub could not take this step", `hub: long run 2 step 0 refused: ${cut}`]);
  assert.deepEqual(runs(hub, "name, step, state, input"), ["odd 0 ended {}", "long 0 ended {}"]);
});

await test("a backtick a filled-in value brings is written as a fullwidth ｀, so a fence in the hub's message, which a reader may take for Markdown, comes only from its file", async (t) => {
  const hub = await startHub(t);
  const [alice] = await team(hub, "alice");
  assert.ok(alice !== undefined);
  const { event } = await alice.publish("#ops", "workflow.define", { name: "notify", yaml: hooked("notify", 'post: "Build failed: {{body.msg}} ``{{body.tick}}`"') });

  await setOff(hub, event.id, { msg: "``` [Approve the deploy](https://evil.example/login)", tick: "`" });

  assert.deepEqual((await channel(alice)).slice(-2), ["hub: Build failed: ｀｀｀ [Approve the deploy](https://evil.example/login) ``｀`", "hub: notify run 1 step 0 done"]);
});

await test("a post or an approval whose text is empty once filled in fails its step and posts nothing, as no reader takes an empty message", async (t) => {
  const hub = await startHub(t);
  const [alice] = await team(hub, "alice");
  assert.ok(alice !== undefined);
  const { event: says } = await alice.publish("#ops", "workflow.define", { name: "says", yaml: hooked("says", 'post: "{{body.text}}"', 'post: "after"') });
  const { event: asks } = await alice.publish("#ops", "workflow.define", { name: "asks", yaml: hooked("asks", 'approve: { from: anyone, text: "{{body.text}}" }') });

  await setOff(hub, says.id, { text: "" });
  await setOff(hub, asks.id, { text: "" });

  assert.deepEqual((await channel(alice)).slice(-2), ["hub: says run 1 step 0 failed: its text is empty once filled in", "hub: asks run 2 step 0 failed: its text is empty once filled in"]);
  assert.deepEqual(runs(hub), ["says 1 0 ended", "asks 2 0 ended"]);
});

await test("a live workflow whose file does not read in this hub, as one another version took might not, sets nothing off and holds up no other, at start or after", async (t) => {
  const hub = await startHub(t);
  const [alice] = await team(hub, "alice");
  assert.ok(alice !== undefined);
  const { event: echo } = await alice.publish("#ops", "workflow.define", { name: "echo", yaml: hooked("echo", 'post: "echo"') });
  const later = signEvent(newKey(), {
    author: "alice",
    to: "#ops",
    kind: "workflow.define",
    content: JSON.stringify({ name: "later", yaml: "name: later\non:\n  webhook: {}\nsteps: []\n" }),
    ts: NOW,
    refs: []
  });
  const db = new Database(join(hub.dir, "hub.db"));
  db.transaction(() => {
    db.addEvent(later);
    db.setWorkflow("#ops", "later", later.id); // Live, as a hub that read it took it.
  });
  db.close();

  await hub.restart();
  await setOff(hub, echo.id);
  const { event: ci } = await alice.publish("#ops", "workflow.define", { name: "ci", yaml: hooked("ci", 'post: "ci"') });
  await setOff(hub, ci.id);

  assert.equal((await fetch(`${hub.url}/hooks/${later.id.slice(0, 32)}`, { method: "POST", body: "{}" })).status, 404);
  assert.deepEqual(
    (await channel(alice)).filter((line) => line.startsWith("hub:")),
    ["hub: echo", "hub: echo run 1 step 0 done", "hub: ci", "hub: ci run 2 step 0 done"]
  );
});

/**
 * Have every name looked up in this process, until the test ends, answered by `answer` with its addresses or the error the system would give, and no resolver asked: an IP address,
 * which a server listening is looked up by, is itself. The answer comes back as the system's does, with no addresses beside an error.
 */
function resolver(t: TestContext, answer: (hostname: string) => Error | readonly dns.LookupAddress[]): void {
  type Answer = (error: Error | null, address?: string | readonly dns.LookupAddress[], family?: number) => void;
  const mocked = t.mock.method(dns, "lookup", (hostname: string, options: unknown, callback: Answer) => {
    const family = isIP(hostname);
    const answered = family === 0 ? answer(hostname) : [{ address: hostname, family }];
    const all = typeof options === "object" && options !== null && "all" in options && options.all === true;
    process.nextTick(() => {
      if (answered instanceof Error) {
        callback(answered);
      } else if (all) {
        callback(null, answered);
      } else {
        callback(null, answered[0]?.address ?? "", answered[0]?.family ?? 4);
      }
    });
  });
  syncBuiltinESMExports(); // So the hub's own import of it is this one.
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
}

await test("a name that leads to the hub's own machine, a link-local address, \"this network\" or a cloud's service for the machine is refused, unless that address is listed itself", async (t) => {
  resolver(t, (hostname) => {
    const address = hostname.slice(0, hostname.indexOf(".example.test")).replaceAll("_", ":"); // The address a test name leads to is in it: 10.0.0.5.example.test.
    return isIP(address) === 0 ? new Error(`${hostname} is no test name`) : [{ address, family: isIP(address) }];
  });
  /** Where the hub may call a name, looked up under `allow`: its address, or why not. */
  const look = (address: string, allow: readonly string[] = ["example.test"]): Promise<string> =>
    new Promise((resolve) => {
      lookupWithin(allow)(`${address.replaceAll(":", "_")}.example.test`, { all: true }, (error, addresses) => {
        resolve(error !== null ? error.message.replace(/^\S+ is at (\S+), which the hub calls only when PLAYER_TWO_WEBHOOK_ALLOW names that address$/, "refused $1") : JSON.stringify(addresses));
      });
    });
  const refused = [
    "127.0.0.1",
    "127.255.0.9",
    "::1",
    "0.0.0.0",
    "0.1.2.3",
    "::",
    "169.254.169.254", // AWS, Azure, Google Cloud's metadata.google.internal, Oracle.
    "169.254.0.1",
    "::ffff:169.254.169.254",
    "fe80::1",
    "fd00:ec2::254",
    "168.63.129.16",
    "::ffff:168.63.129.16",
    "100.100.100.200"
  ];
  for (const address of refused) {
    assert.equal(await look(address), `refused ${address}`, address);
  }
  for (const address of ["10.0.0.5", "168.63.129.17", "100.100.100.201", "fd00:ec2::253", "169.255.0.1"]) {
    assert.equal(await look(address), JSON.stringify([{ address, family: isIP(address) }]), address);
  }
  assert.equal(await look("168.63.129.16", ["example.test", "168.63.129.16"]), JSON.stringify([{ address: "168.63.129.16", family: 4 }]));
  assert.equal(await look("fd00:ec2::254", ["example.test", "[fd00:ec2::254]"]), JSON.stringify([{ address: "fd00:ec2::254", family: 6 }]));
});

await test("a webhook step goes straight to the address the hub looked up, never through a proxy the hub's environment names", async (t) => {
  const proxied: string[] = [];
  const proxy = createServer((request, response) => {
    proxied.push(`${request.method ?? ""} ${request.url ?? ""}`);
    response.end();
  }).on("connect", (request: IncomingMessage, socket: Duplex) => {
    proxied.push(`CONNECT ${request.url ?? ""}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => {
    proxy.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => proxy.close());
  const address = proxy.address();
  assert.ok(address !== null && typeof address === "object");
  // As NODE_USE_ENV_PROXY with these in the hub's environment would, for Node's own agents; the test's own calls, to 127.0.0.1, go straight.
  t.after(setGlobalProxyFromEnv({ HTTP_PROXY: `http://127.0.0.1:${String(address.port)}`, HTTPS_PROXY: `http://127.0.0.1:${String(address.port)}`, NO_PROXY: "127.0.0.1" }));
  resolver(t, () => [{ address: "127.0.0.1", family: 4 }]);
  const called = await target(t);
  const at = `ci.example.test:${new URL(called.url).port}`;
  const hub = await startHub(t, () => NOW, "", TEAM_REPOS, ["ci.example.test", "127.0.0.1"]); // The address too, as the name leads to this machine.
  const [alice] = await team(hub, "alice");
  assert.ok(alice !== undefined);
  const { event } = await alice.publish("#ops", "workflow.define", { name: "retry", yaml: hooked("retry", `webhook: { url: "http://${at}/plain" }`, `webhook: { url: "https://${at}/tls" }`) });

  await setOff(hub, event.id);

  const lines = await until(alice, /retry run 1 step 1/);
  assert.deepEqual(lines.slice(-2, -1), ["hub: retry run 1 step 0 done"]);
  assert.match(lines.at(-1) ?? "", new RegExp(`^hub: retry run 1 step 1 failed: could not call ${at}: E[A-Z_]+$`)); // Its server speaks no TLS.
  assert.deepEqual(called.calls, ["/plain text/plain; charset=utf-8 "]);
  assert.deepEqual(proxied, []);
});

await test("a webhook step to a name that cannot be looked up fails, saying the system's code alone, and the hub goes on", async (t) => {
  const looked: string[] = [];
  resolver(t, (hostname) => {
    looked.push(hostname);
    return Object.assign(new Error(`getaddrinfo EAI_AGAIN ${hostname}`), { code: "EAI_AGAIN" });
  });
  const hub = await startHub(t, () => NOW, "", TEAM_REPOS, ["example.test"]);
  const [alice] = await team(hub, "alice");
  assert.ok(alice !== undefined);
  const { event } = await alice.publish("#ops", "workflow.define", { name: "retry", yaml: hooked("retry", 'webhook: { url: "https://{{body.host}}.example.test/retry" }') });

  await setOff(hub, event.id, { host: "typo" });

  assert.equal((await until(alice, /retry run 1 step 0/)).at(-1), "hub: retry run 1 step 0 failed: could not call typo.example.test: EAI_AGAIN");
  assert.deepEqual(looked, ["typo.example.test"]);
  assert.equal((await fetch(`${hub.url}/healthz`)).status, 200);
});

await test(
  "a webhook that takes its time holds up nothing else; the hub hangs up on it when it stops, ending its run at that step when it starts again, and after ten seconds; a run whose workflow changed while it called goes no further",
  { timeout: 60_000 },
  async (t) => {
    const held: ServerResponse[] = [];
    let hungUp = 0;
    const slow = await target(t, (response) => {
      held.push(response);
      response.on("close", () => {
        hungUp += response.writableEnded ? 0 : 1;
      });
    });
    const hub = await startHub(t, () => NOW, "", TEAM_REPOS, ["127.0.0.1"]);
    const [alice] = await team(hub, "alice");
    assert.ok(alice !== undefined);
    const waits = hooked("waits", `webhook: { url: "${slow.url}/slow" }`, `post: "after the call"`);
    const { event: first } = await alice.publish("#ops", "workflow.define", { name: "waits", yaml: waits });
    const { event: quick } = await alice.publish("#ops", "workflow.define", { name: "quick", yaml: hooked("quick", `post: "meanwhile"`) });
    const called = async (count: number): Promise<void> => {
      for (let tries = 0; slow.calls.length < count && tries < 100; tries += 1) {
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
      }
      assert.equal(slow.calls.length, count);
    };

    await setOff(hub, first.id);
    await called(1);
    assert.equal((await fetch(`${hub.url}/healthz`)).status, 200);
    await setOff(hub, quick.id);
    await until(alice, /quick run 2 step 0 done/);
    const { event: second } = await alice.publish("#ops", "workflow.define", { name: "waits", yaml: waits });
    held[0]?.end();
    await until(alice, /waits run 1 step 1 cancelled/);

    await setOff(hub, second.id);
    await called(2);
    await hub.restart();
    await until(alice, /waits run 3 step 0 failed/);
    assert.equal(hungUp, 1);

    const started = Date.now();
    await setOff(hub, second.id);
    await until(alice, /waits run 4 step 0 failed/);
    assert.ok(Date.now() - started >= 9_500, String(Date.now() - started));
    assert.equal(hungUp, 2);

    const host = new URL(slow.url).host;
    assert.deepEqual(
      (await channel(alice)).filter((line) => line.startsWith("hub:")),
      [
        "hub: meanwhile",
        "hub: quick run 2 step 0 done",
        "hub: waits run 1 step 0 done",
        "hub: waits run 1 step 1 cancelled: waits was replaced",
        "hub: waits run 3 step 0 failed: the hub stopped during this step",
        `hub: waits run 4 step 0 failed: ${host} did not answer within 10 seconds`
      ]
    );
  }
);

await test("a workflow starts at most 30 runs an hour, not counting those throttled; one past that is recorded as throttled and does nothing, and those after it, until a run starts again, leave no trace", async (t) => {
  let clock = NOW;
  const hub = await startHub(t, () => clock);
  const [alice] = await team(hub, "alice");
  assert.ok(alice !== undefined);
  const { event: often } = await alice.publish("#ops", "workflow.define", { name: "often", yaml: hooked("often", 'post: "ran"') });

  await setOff(hub, often.id);
  clock += 1_800;
  for (let n = 0; n < 32; n += 1) {
    await setOff(hub, often.id);
  }
  clock += 1_800; // The first started an hour ago, to the second, and no longer counts; the 29 after it and the run throttled do, but the throttled one counts for nothing.
  await setOff(hub, often.id);
  await setOff(hub, often.id);

  const lines = (await channel(alice)).filter((line) => line.startsWith("hub: often"));
  assert.equal(lines.length, 33);
  const throttled = "often has started 30 runs in the last hour, the most it may";
  assert.deepEqual(lines.slice(29), [
    "hub: often run 30 step 0 done",
    `hub: often run 31 step 0 throttled: ${throttled}`,
    "hub: often run 32 step 0 done",
    `hub: often run 33 step 0 throttled: ${throttled}`
  ]);
  assert.deepEqual(runs(hub).slice(29), ["often 30 1 ended", "often 31 0 throttled", "often 32 1 ended", "often 33 0 throttled"]);
});

await test("a workflow has at most 50 runs waiting for a 👍; one past that is recorded as throttled and does nothing, until one of them moves on", async (t) => {
  let clock = NOW;
  const hub = await startHub(t, () => clock);
  const [alice, bob] = await team(hub, "alice", "bob");
  assert.ok(alice !== undefined && bob !== undefined);
  const { event: gated } = await alice.publish("#ops", "workflow.define", { name: "gated", yaml: hooked("gated", 'approve: { from: anyone, text: "go?" }', 'post: "went"') });

  for (let n = 0; n < 50; n += 1) {
    clock += n === 30 ? 3_600 : 0; // Not past the hourly limit.
    await setOff(hub, gated.id);
  }
  await setOff(hub, gated.id);
  await setOff(hub, gated.id);
  await bob.publish("#ops", "reaction", { emoji: "👍", on: true }, [await newestFromHub(alice)]);
  await setOff(hub, gated.id);

  const lines = (await channel(alice)).filter((line) => line.startsWith("hub: gated"));
  assert.equal(lines.filter((line) => line.endsWith("waiting: for a 👍 from anyone in #ops")).length, 51);
  assert.deepEqual(lines.slice(49), [
    "hub: gated run 50 step 0 waiting: for a 👍 from anyone in #ops",
    "hub: gated run 51 step 0 throttled: gated has 50 runs waiting for a 👍, the most it may",
    "hub: gated run 50 step 0 approved: by bob",
    "hub: gated run 50 step 1 done",
    "hub: gated run 52 step 0 waiting: for a 👍 from anyone in #ops"
  ]);
});

await test("a waiting run the hub cannot record, as one whose row the database holds damaged, holds up no other: each sweep, and the hub starting, still end the rest", async (t) => {
  let clock = NOW;
  const hub = await startHub(t, () => clock);
  const [alice] = await team(hub, "alice");
  assert.ok(alice !== undefined);
  const gate = 'approve: { from: anyone, text: "go?", within: 1h }';
  for (const name of ["damaged", "b", "c"]) {
    const { event } = await alice.publish("#ops", "workflow.define", { name, yaml: hooked(name, gate) });
    await setOff(hub, event.id);
  }
  const db = new DatabaseSync(join(hub.dir, "hub.db"));
  db.prepare("UPDATE workflow_runs SET approval = 'not an event id' WHERE run = 1").run(); // No event can refer to it, so recording how run 1 ends throws.
  db.close();

  await alice.publish("#ops", "workflow.remove", { name: "b" }); // Sweeps at once, run 1 first.
  clock += 3_600 + 1;
  await hub.restart(); // Sweeps as it starts.

  assert.deepEqual(
    (await channel(alice)).filter((line) => / run \d step 0 (cancelled|expired)/.test(line)),
    ["hub: b run 2 step 0 cancelled: b was removed", "hub: c run 3 step 0 expired: no 👍 came in time"]
  );
  assert.deepEqual(runs(hub), ["damaged 1 0 waiting", "b 2 0 ended", "c 3 0 ended"]);
});

await test("the hub's own messages set nothing off, though they hold a workflow's words", async (t) => {
  const hub = await startHub(t);
  const [alice, bob] = await team(hub, "alice", "bob");
  assert.ok(alice !== undefined && bob !== undefined);
  await alice.publish("#ops", "workflow.define", { name: "echo", yaml: 'name: echo\non:\n  message: { contains: "P1" }\nsteps:\n  - post: "P1 again: {{trigger.text}}"\n' });

  await bob.publish("#ops", "message", { text: "a P1", via: "cli" });

  assert.deepEqual((await channel(alice)).slice(-3), ["bob: a P1", "hub: P1 again: a P1", "hub: echo run 1 step 0 done"]);
  assert.deepEqual(runs(hub), ["echo 1 1 ended"]);
});

await test(
  "a workflow's tag of an agent in a branch room, set off by its hook, waits for the agent's owner and runs once they let it, and runs at once under a grant naming the workflow, each answer posted in the room",
  { timeout: 30_000 },
  async (t) => {
    const hub = await startHub(t);
    const [alice, owner] = await team(hub, "alice", "bob");
    assert.ok(alice !== undefined && owner !== undefined);
    const dev = join(hub.dir, "dev-bob");
    const uploader = checkout(dev, "uploader"); // A real one: a teammate's request above read-only runs on a clean copy of it.
    execFileSync("git", ["-C", uploader, "checkout", "-q", "-b", "fix/retry"]);
    const ran: string[] = [];
    const bob = new Session(
      owner,
      dev,
      { changed: () => undefined, notice: () => undefined, arrived: () => undefined, confirmClone: () => Promise.resolve(false) },
      {
        presence: 1,
        describe: () => Promise.resolve({ branch: "fix/retry", commit: "c0ffee".padEnd(40, "0"), dirty: false }),
        runner: (argv) => {
          ran.push(argv.at(-1) ?? "");
          return Promise.resolve("the cache was cold");
        }
      }
    );
    bob.start();
    t.after(() => bob.stop());
    const shown = async <T>(what: string, found: () => T | undefined | false): Promise<T> => {
      for (let tries = 0; tries < 200; tries += 1) {
        const value = found();
        if (value !== undefined && value !== false) {
          return value;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
      }
      throw new Error(`never shown: ${what}`);
    };
    await shown("bob's checkout", () => bob.view().loaded && bob.view().myRepos.includes("uploader"));
    // #ops is the room of uploader's fix/retry, which bob's checkout is on, and the workflow lives there.
    await alice.publish("#ops", "channel.pin", { repo: { name: "uploader", key: "dev.azure.com/acme/platform/uploader", url: `${TEAM_REPOS}Platform/_git/uploader` }, branch: "fix/retry" });
    await bob.handle({ do: "open", chat: "#ops" });
    await shown("the branch room, with bob on its branch", () => bob.view().current?.pinned?.branch === "fix/retry" && bob.view().current?.pinned?.on.includes("bob"));
    const yaml = hooked("ci-failure", 'tag: "@bob/uploader"\n    text: "The build {{body.id}} failed. What broke?"');
    const { event: definition } = await alice.publish("#ops", "workflow.define", { name: "ci-failure", yaml });
    const request = async (id: number, hook = definition.id): Promise<string> => {
      await setOff(hub, hook, { id });
      return shown(`the request for build ${String(id)}`, () => bob.view().current?.messages.find((message) => message.body.includes(`build ${String(id)} failed`))?.id);
    };
    const status = (id: string): string | undefined => bob.view().current?.messages.find((message) => message.id === id)?.requests[0]?.status.kind;

    const first = await request(1);
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    assert.deepEqual([status(first), ran], ["ready", []]); // Waiting for bob's click.

    await owner.publish("*", "grant", { agent: "bob/uploader", askers: ["workflow:#ops/ci-failure"], mode: "full", delivery: "post", expires: NOW + 3_600, runsPerDay: 10 });
    await shown("the grant", () => bob.view().grants.length === 1);
    await request(2);
    await until(alice, /^bob\/uploader: job\.result$/);

    assert.equal(ran.length, 1);
    assert.match(ran[0] ?? "", /The build 2 failed\. What broke\?/);
    assert.equal(status(first), "ready"); // The grant lets go what comes from now on, not what was waiting.

    // A workflow of the same name in another channel, which whoever is in that one may publish, is another workflow, and the grant does not name it.
    for (const each of [alice, owner]) {
      await each.publish("#general", "channel.join", {});
    }
    const { event: elsewhere } = await alice.publish("#general", "workflow.define", { name: "ci-failure", yaml });
    await shown("#general in bob's list", () => bob.view().rows.some((row) => row.chat === "#general"));
    await bob.handle({ do: "open", chat: "#general" });
    const third = await request(3, elsewhere.id);
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    assert.deepEqual([status(third), ran.length], ["ready", 1]);

    // The first, which waited for bob, runs once he lets it, and its answer is posted in the room too.
    await bob.handle({ do: "open", chat: "#ops" });
    const text = bob.view().current?.messages.find((message) => message.id === first)?.body ?? "";
    await bob.handle({ do: "run", id: first, repo: "uploader", post: true, mode: "full", text });
    await shown("the run bob let go", () => ran.length === 2);
    assert.match(ran[1] ?? "", /The build 1 failed\. What broke\?/);
    let answers = 0;
    for (let tries = 0; tries < 200 && answers === 0; tries += 1) {
      answers = (await alice.events({ chat: "#ops" })).filter(({ event }) => event.kind === "job.result" && event.refs[0] === first).length;
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
    assert.equal(answers, 1);
  }
);
