/** Holds the code to the frozen record of the signing format, and of how repos are named, which tags are found and what an agent is told. A change to what is signed has to change the record as well, so it cannot happen by accident. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { z } from "zod";

import { agentPrompt, mentions, NOT_INSTRUCTIONS } from "../src/core/chat.ts";
import type { Message } from "../src/core/chat.ts";
import { parseRemote, prefixKey } from "../src/core/remotes.ts";
import { authClaim, authHeader, authIsValid, eventIsAuthentic, loadKey, privateHex, publicHex, signEvent } from "../src/core/sign.ts";
import { eventSchema } from "../src/core/wire.ts";
import type { Event } from "../src/core/wire.ts";

// The record, written by scripts/make-vectors.ts. Every teammate's client and the hub must agree with it byte for byte, so it changes only on purpose, in the commit that changes the format.
const vectors = z
  .strictObject({
    private_key: z.string(),
    public_key: z.string(),
    ts: z.int(),
    events: z.array(eventSchema),
    auth: z.strictObject({ method: z.string(), path: z.string(), header: z.string() }),
    remotes: z.array(z.tuple([z.string(), z.strictObject({ key: z.string(), name: z.string(), url: z.string() }).nullable()])),
    prefixes: z.array(z.tuple([z.string(), z.string()])),
    mentions: z.array(z.tuple([z.string(), z.array(z.tuple([z.string(), z.string()]))])),
    prompts: z.array(z.strictObject({ review: z.boolean(), mcp: z.boolean().optional(), grant: z.boolean().optional(), prompt: z.string() }))
  })
  .parse(JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "signing-vectors.json"), "utf8")));

const key = loadKey(vectors.private_key);

/** A message as the fold would leave it, or with `agent` an agent's answer: all an agent's prompt reads of one. */
function shown(seq: number, author: string, to: string, text: string, agent: string | null = null): Message {
  const event = signEvent(key, { author, to, kind: agent === null ? "message" : "job.result", content: "{}", ts: vectors.ts, refs: [] });
  return { entry: { seq, event, trusted: true }, agent, answers: agent === null ? null : event.id, branch: "", root: null, text, edited: false, deleted: false, reactions: new Map(), replies: [] };
}

await test("a key loads from its hex and gives the same public key", () => {
  assert.equal(privateHex(key), vectors.private_key);
  assert.equal(publicHex(key), vectors.public_key);
});

await test("every event signs again to the id and signature on record, and the one on record holds", () => {
  for (const event of vectors.events) {
    assert.deepEqual(signEvent(key, event, event.nonce), event, event.content);
    assert.ok(eventIsAuthentic(event, vectors.public_key), event.content);
  }
});

await test("an event's id is the hash of what it signs, and changing any signed field breaks it", () => {
  const fields = { author: "jacob", to: "#backend", kind: "message", content: '{"text":"hi","via":"cli"}', ts: vectors.ts, refs: [] };
  const event = signEvent(key, fields);
  const changes: readonly Partial<Event>[] = [
    { author: "bob" },
    { to: "bob" },
    { kind: "message.edit" },
    { content: '{"text":"bye","via":"cli"}' },
    { ts: vectors.ts + 1 },
    { refs: [event.id] },
    { nonce: "00".repeat(8) },
    { id: "00".repeat(32) } // The signature still holds, but the id is not the hash of the fields.
  ];

  assert.ok(eventIsAuthentic(event, vectors.public_key));
  assert.notEqual(signEvent(key, fields).id, event.id); // Each gets a nonce of its own, so the same words twice are two events.
  for (const change of changes) {
    assert.ok(!eventIsAuthentic({ ...event, ...change }, vectors.public_key), JSON.stringify(change));
  }
  assert.ok(!eventIsAuthentic(event, publicHex(loadKey("22".repeat(32)))));
});

await test("the auth header signs the request it is for, and no other", () => {
  const { method, path, header } = vectors.auth;
  const claim = authClaim(header);
  assert.ok(claim !== null);
  assert.equal(authHeader(key, "jacob", vectors.ts, method, path), header);
  assert.ok(authIsValid(claim, vectors.public_key, vectors.ts, method, path));
  assert.ok(!authIsValid(claim, vectors.public_key, vectors.ts, "POST", path));
  assert.ok(!authIsValid(claim, vectors.public_key, vectors.ts, method, `${path}&tail=1`));
});

await test("every remote names the repo on record", () => {
  for (const [remote, expected] of vectors.remotes) {
    assert.deepEqual(parseRemote(remote), expected, remote);
  }
  for (const [url, expected] of vectors.prefixes) {
    assert.equal(prefixKey(url), expected, url);
  }
});

await test("the same tags are found in a message's text", () => {
  for (const [body, expected] of vectors.mentions) {
    assert.deepEqual(mentions(body), expected, body);
  }
});

await test("an agent is told what is on record", () => {
  const earlier = [shown(1, "bob", "#backend", "it was the connection pool"), shown(2, "carol", "#backend", "Retries live in queue.py", "uploader")];
  const ask = "@jacob/uploader where do we retry?";
  const prompts = [
    agentPrompt(shown(3, "bob", "#backend", ask), "jacob", "uploader", earlier, true),
    agentPrompt(shown(3, "bob", "jacob", ask), "jacob", "uploader", [], false),
    agentPrompt(shown(3, "jacob", "bob", ask), "jacob", "uploader", [], false),
    agentPrompt(shown(3, "bob", "#backend", ask), "jacob", "uploader", earlier, true, "mcp"),
    agentPrompt(shown(3, "bob", "#backend", ask), "jacob", "uploader", earlier, false, "none")
  ];
  assert.deepEqual(
    prompts,
    vectors.prompts.map((expected) => expected.prompt)
  );
  // What search and read hand back is data, and may come from chats that whoever the answer goes to cannot see. A run under a grant is not told of them at all.
  assert.deepEqual(
    prompts.map((prompt) => prompt.includes(NOT_INSTRUCTIONS)),
    [true, true, true, true, false]
  );
  assert.deepEqual(
    prompts.map((prompt) => /some of which (.+) cannot see/.exec(prompt)?.[1]),
    ["the members of #backend", "bob", "bob", "the members of #backend", undefined]
  );
  assert.ok(!/player-two|note/.test(prompts[4] ?? "player-two"));
});
