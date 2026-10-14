/** Holds this port to the Python implementation: both must sign the same bytes, name repos the same way, find the same tags and tell agents the same thing. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { z } from "zod";

import { agentPrompt, mentions } from "../src/core/chat.ts";
import type { Entry } from "../src/core/chat.ts";
import { parseRemote, prefixKey } from "../src/core/repos.ts";
import { authHeader, loadKey, noteIsAuthentic, privateHex, publicHex, signNote } from "../src/core/sign.ts";
import { noteSchema } from "../src/core/wire.ts";

// Written by tests/test_app_vectors.py, which fails on the Python side if that implementation stops producing them.
const vectors = z
  .strictObject({
    private_key: z.string(),
    public_key: z.string(),
    ts: z.int(),
    notes: z.array(noteSchema),
    auth: z.string(),
    remotes: z.array(z.tuple([z.string(), z.strictObject({ key: z.string(), name: z.string(), url: z.string() }).nullable()])),
    prefixes: z.array(z.tuple([z.string(), z.string()])),
    mentions: z.array(z.tuple([z.string(), z.array(z.tuple([z.string(), z.string()]))])),
    prompts: z.array(z.strictObject({ review: z.boolean(), prompt: z.string() }))
  })
  .parse(JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "python-vectors.json"), "utf8")));

const key = loadKey(vectors.private_key);

function entry(id: number, sender: string, to: string, body: string, agent: string | null = null): Entry {
  return { id, note: signNote(key, { sender, to, kind: "note", body, ts: vectors.ts, agent, re: null }), trusted: true };
}

await test("a key loads from its hex and gives the same public key", () => {
  assert.equal(privateHex(key), vectors.private_key);
  assert.equal(publicHex(key), vectors.public_key);
});

await test("every note signs to the same signature as in Python, and Python's verifies here", () => {
  for (const note of vectors.notes) {
    assert.equal(signNote(key, note).sig, note.sig, note.body);
    assert.ok(noteIsAuthentic(note, vectors.public_key), note.body);
  }
});

await test("changing a signed field breaks the signature", () => {
  const [note] = vectors.notes;
  assert.ok(note !== undefined);
  assert.ok(!noteIsAuthentic({ ...note, body: "goodbye" }, vectors.public_key));
  assert.ok(!noteIsAuthentic({ ...note, to: "carol" }, vectors.public_key));
  assert.ok(!noteIsAuthentic(note, publicHex(loadKey("22".repeat(32)))));
});

await test("the auth header is the one Python sends", () => {
  assert.equal(authHeader(key, "jacob", vectors.ts), vectors.auth);
});

await test("every remote names the same repo as in Python", () => {
  for (const [remote, expected] of vectors.remotes) {
    assert.deepEqual(parseRemote(remote), expected, remote);
  }
  for (const [url, expected] of vectors.prefixes) {
    assert.equal(prefixKey(url), expected, url);
  }
});

await test("the same tags are found in a note's text", () => {
  for (const [body, expected] of vectors.mentions) {
    assert.deepEqual(mentions(body), expected, body);
  }
});

await test("an agent is told what Python would tell it", () => {
  const earlier = [entry(1, "bob", "#backend", "it was the connection pool"), entry(2, "carol", "#backend", "Retries live in queue.py", "uploader")];
  const ask = "@jacob/uploader where do we retry?";
  const prompts = [
    agentPrompt(entry(3, "bob", "#backend", ask), "jacob", "uploader", earlier, true),
    agentPrompt(entry(3, "bob", "jacob", ask), "jacob", "uploader", [], false),
    agentPrompt(entry(3, "jacob", "bob", ask), "jacob", "uploader", [], false)
  ];
  assert.deepEqual(
    prompts,
    vectors.prompts.map((expected) => expected.prompt)
  );
});
