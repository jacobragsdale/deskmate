/** Standing grants: what a grant and its revocation say, and when a grant lets a request run without its owner. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_GRANT, PUBLIC_KINDS, readContent } from "../src/core/kinds.ts";
import { loadKey, signEvent } from "../src/core/sign.ts";

const NOW = 1_800_000_000;
const key = loadKey("11".repeat(32));
const GRANT = { agent: "jacob/uploader", askers: ["bob"], mode: "read-only", delivery: "review", expires: NOW + 86_400, runsPerDay: 20 };

await test("a grant is read when it lasts at most 30 days from its own time and names an agent, askers, a mode and a daily limit of 1 to 1000; a revocation holds nothing", () => {
  const read = (kind: string, content: unknown, ts = NOW): string => {
    const found = readContent(signEvent(key, { author: "jacob", to: "*", kind, content: JSON.stringify(content), ts, refs: [] }));
    return found.kind === "unknown" ? "unknown" : `${found.kind} ${JSON.stringify(found.content)}`;
  };
  const fits = (changed: Readonly<Record<string, unknown>>, ts = NOW): boolean => read("grant", { ...GRANT, ...changed }, ts) !== "unknown";

  assert.equal(read("grant", GRANT), `grant ${JSON.stringify(GRANT)}`);
  assert.equal(read("grant.revoke", {}), "grant.revoke {}");
  assert.ok(fits({ askers: ["*"], mode: "full", delivery: "post", runsPerDay: 1000 }));
  assert.ok(fits({ expires: NOW + MAX_GRANT, runsPerDay: 1 }));
  assert.ok(!fits({ expires: NOW + MAX_GRANT + 1 })); // Longer than 30 days after the event was signed.
  assert.ok(fits({ expires: NOW + MAX_GRANT + 1 }, NOW + 1)); // The same expiry, signed a second later.
  assert.ok(!fits({ runsPerDay: 0 }));
  assert.ok(!fits({ runsPerDay: 1001 }));
  assert.ok(!fits({ mode: "admin" }));
  assert.ok(!fits({ agent: "uploader" })); // Whose agent it is is part of its name.
  assert.ok(!fits({ askers: ["Bob"] }));
  assert.ok(!fits({ delivery: "email" }));
  assert.deepEqual(PUBLIC_KINDS, new Set(["grant", "grant.revoke"])); // What may be sent to everyone.
});
