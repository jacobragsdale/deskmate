/**
 * Azure DevOps in the chat, through sessions against a real hub and the fake Azure DevOps of test/fakeAzure.ts, which the desk is pointed at by the smoke test's address:
 * pull requests a message refers to. The home folder and git's configuration are the test's own.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { Client } from "../src/desk/client.ts";
import { Session } from "../src/desk/session.ts";
import type { Options } from "../src/desk/session.ts";
import type { MessageView, Notice } from "../src/shared/ipc.ts";
import { fakeAzure, platform } from "./fakeAzure.ts";
import type { Call, Project } from "./fakeAzure.ts";
import { ownHome, startHub, TEAM_REPOS } from "./startHub.ts";

ownHome();
const PAT = "a-personal-access-token";
const UPLOADER = { name: "uploader", key: "dev.azure.com/acme/platform/uploader", url: `${TEAM_REPOS}Platform/_git/uploader` };

/** Try `find` every 50 ms, for ten seconds, until it finds something. */
async function until<T>(what: string, find: () => T | undefined | false | Promise<T | undefined | false>): Promise<T> {
  for (let tries = 0; tries < 200; tries += 1) {
    const found = await find();
    if (found !== undefined && found !== false) {
      return found;
    }
    await delay(50);
  }
  throw new Error(`never happened: ${what}`);
}

/** The fake Azure DevOps, which every session made after this asks, with a token for it in the environment. */
async function azure(t: TestContext): Promise<{ readonly calls: Call[]; readonly project: Project }> {
  const { project, answer } = platform(PAT);
  const fake = await fakeAzure(t, answer);
  process.env["PLAYER_TWO_TEST_AZURE"] = fake.base;
  process.env["AZURE_DEVOPS_EXT_PAT"] = PAT;
  return { calls: fake.calls, project };
}

interface Desk {
  readonly session: Session;
  readonly notices: Notice[];
}

/** A session of `client`'s, with its checkouts in `dev`, started and stopped when the test ends, once it has loaded what was there and opened `chat`. */
async function deskOf(t: TestContext, client: Client, dev: string, chat: string, options: Options = {}): Promise<Desk> {
  const notices: Notice[] = [];
  const hooks = {
    changed: () => undefined,
    notice: (notice: Notice) => {
      notices.push(notice);
    },
    arrived: () => undefined,
    confirmClone: () => Promise.resolve(false)
  };
  const session = new Session(client, dev, hooks, { presence: 1, ...options });
  session.start();
  t.after(() => session.stop());
  await until("the chats loaded", () => session.view().loaded && session.view().rows.some((row) => row.chat === chat));
  await session.handle({ do: "open", chat });
  return { session, notices };
}

/** What a session shows of a message, once it is there. */
function shownTo(session: Session, id: string): MessageView | undefined {
  return session.view().current?.messages.find((message) => message.id === id);
}

/** The pull requests the fake was asked for one by one, as repo and id. */
function asked(calls: readonly Call[]): string[] {
  return calls.flatMap((call) => {
    const found = /\/repositories\/([^/]+)\/pullrequests\/([0-9]+)$/.exec(call.path);
    return found === null ? [] : [`${found[1] ?? ""} ${found[2] ?? ""}`];
  });
}

await test("!123 in a channel pinned to a repo on Azure DevOps, and a pasted address in any chat, are looked up once a minute, five a message at most, and shown as Azure DevOps answered; what it cannot find is left as text", async (t) => {
  const { calls } = await azure(t);
  const hub = await startHub(t, () => Date.now() / 1000);
  const [bob, jacob] = [await hub.join("bob"), await hub.join("jacob")];
  for (const person of [bob, jacob]) {
    await person.publish("#team", "channel.join", {});
  }
  await bob.publish("#team", "channel.pin", { repo: UPLOADER, branch: null });
  const { session } = await deskOf(t, jacob, join(hub.dir, "dev-jacob"), "#team");

  const pasted = "https://dev.azure.com/acme/Platform/_git/api/pullrequest/20";
  const said = await bob.publish("#team", "message", { text: `see !22 and !999, ${pasted} and https://dev.azure.com.example.com/acme/Platform/_git/api/pullrequest/21`, via: "cli" });
  const shown = await until("both found", () => (shownTo(session, said.event.id)?.pulls.length === 2 ? shownTo(session, said.event.id) : undefined));
  assert.deepEqual(
    shown.pulls.map(({ ref, pull }) => [ref, pull.id, pull.title, pull.status, pull.web]),
    [
      ["!22", 22, "A new feature", "active", "https://dev.azure.com/acme/platform/_git/uploader/pullrequest/22"],
      [pasted, 20, "Updated pull request title", "completed", "https://dev.azure.com/acme/platform/_git/api/pullrequest/20"]
    ]
  );
  await until("!999 answered", () => asked(calls).length === 3);
  await delay(200);
  session.view();
  assert.deepEqual(asked(calls), ["uploader 22", "uploader 999", "api 20"]); // Each once, and the address on another host never.
  assert.ok(calls.every((call) => call.authorization === `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`));

  // Six in one message: the first five are looked up. And in a direct chat, which nothing is pinned to, !22 refers to nothing, while an address still does.
  const many = await bob.publish("#team", "message", { text: "!1 !2 !3 !4 !5 !6", via: "cli" });
  await until("the first five asked", () => shownTo(session, many.event.id) !== undefined && asked(calls).length === 8);
  await delay(200);
  assert.deepEqual(asked(calls).slice(3), ["uploader 1", "uploader 2", "uploader 3", "uploader 4", "uploader 5"]);
  assert.deepEqual(
    shownTo(session, many.event.id)?.pulls.map((each) => each.ref),
    ["!1"]
  );
  const direct = await bob.publish("jacob", "message", { text: `!22, or ${pasted}`, via: "cli" });
  await session.handle({ do: "open", chat: "bob" });
  await until("the address in the direct chat", () => shownTo(session, direct.event.id)?.pulls.length === 1);
  assert.deepEqual(shownTo(session, direct.event.id)?.pulls[0]?.ref, pasted);
  assert.equal(asked(calls).length, 8);

  // A minute on, each is asked again as it is drawn, and what was found is shown meanwhile.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 61_000 });
  assert.equal(shownTo(session, direct.event.id)?.pulls[0]?.ref, pasted);
  await until("the address asked again", () => shownTo(session, direct.event.id) !== undefined && asked(calls).length === 9);
  t.mock.timers.reset();
});

await test("no more than a hundred answers are kept fresh at once, and while they are, nothing more is asked", async (t) => {
  const { calls } = await azure(t);
  const hub = await startHub(t, () => Date.now() / 1000);
  const [bob, jacob] = [await hub.join("bob"), await hub.join("jacob")];
  for (const person of [bob, jacob]) {
    await person.publish("#team", "channel.join", {});
  }
  await bob.publish("#team", "channel.pin", { repo: UPLOADER, branch: null });
  for (let message = 0; message < 21; message += 1) {
    await bob.publish("#team", "message", { text: [1, 2, 3, 4, 5].map((each) => `!${String(1000 + message * 5 + each)}`).join(" "), via: "cli" });
  }
  const { session } = await deskOf(t, jacob, join(hub.dir, "dev-jacob"), "#team");
  await until("a hundred asked", () => session.view().current !== null && asked(calls).length === 100);
  await delay(300);
  session.view();
  await delay(300);
  assert.equal(asked(calls).length, 100);
});
