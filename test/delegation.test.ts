/** Delegation: what an agent's request of another agent says, and whether an acceptance lets its agent ask others. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { readContent } from "../src/core/kinds.ts";
import { loadKey, signEvent } from "../src/core/sign.ts";

const NOW = 1_800_000_000;
const key = loadKey("11".repeat(32));

/** What an event of `kind` holding `content` is read as: its kind and content, or "unknown". */
function read(kind: string, content: unknown): string {
  const found = readContent(signEvent(key, { author: "jacob", to: "#backend", kind, content: JSON.stringify(content), ts: NOW, refs: [] }));
  return found.kind === "unknown" ? "unknown" : `${found.kind} ${JSON.stringify(found.content)}`;
}

await test("a job.request names an agent to ask, the text, and the agents it came through; an acceptance says whether its agent may ask others, and one that does not say lets it ask none", () => {
  const request = { target: "bob/billing", text: "Does removing `retries` break your caller?", chain: ["jacob/uploader"] };
  const accepted = { repo: "uploader", branch: "main", commit: "a".repeat(40), dirty: false, delivery: "review", mode: "read-only" };

  assert.equal(read("job.request", request), `job.request ${JSON.stringify(request)}`);
  assert.equal(read("job.request", { ...request, chain: ["jacob/uploader", "bob/client"] }), `job.request ${JSON.stringify({ ...request, chain: ["jacob/uploader", "bob/client"] })}`);
  assert.equal(read("job.request", { ...request, chain: [] }), "unknown"); // Every request comes through the agent that sent it.
  assert.equal(read("job.request", { ...request, target: "billing" }), "unknown"); // Whose agent it is is part of its name.
  assert.equal(read("job.request", { ...request, chain: ["uploader"] }), "unknown");
  assert.equal(read("job.request", { ...request, text: "" }), "unknown");

  assert.equal(read("job.accepted", { ...accepted, delegate: true, by: "owner" }), `job.accepted ${JSON.stringify({ ...accepted, delegate: true, by: "owner" })}`);
  assert.equal(read("job.accepted", { ...accepted, by: "owner" }), `job.accepted ${JSON.stringify({ ...accepted, delegate: false, by: "owner" })}`); // As every acceptance from before phase 5 is.
  assert.equal(read("job.accepted", { ...accepted, delegate: "yes", by: "owner" }), "unknown");
});
