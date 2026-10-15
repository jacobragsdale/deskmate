/**
 * Writes test/fixtures/signing-vectors.json: what this code signs, how it names repos, which tags it finds and what it tells an agent, for one fixed key and the inputs below.
 * test/vectors.test.ts holds the code to that file, so run this only when the format is meant to change, and commit the file with the change: `node scripts/make-vectors.ts`.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { agentPrompt, mentions } from "../src/core/chat.ts";
import type { Message } from "../src/core/chat.ts";
import { parseRemote, prefixKey } from "../src/core/remotes.ts";
import { authHeader, loadKey, publicHex, signEvent } from "../src/core/sign.ts";

const PRIVATE_KEY = "11".repeat(32);
const TS = 1_800_000_000;
const AUTH = { method: "GET", path: "/events?chat=%23backend&before=41&limit=50" };
const REF = "0f".repeat(32); // An id for the events below to be about.

// Texts chosen for what an encoder might get wrong: quotes and slashes, every kind of control character, and text outside ASCII and outside the first plane.
const QUOTES = 'quotes " and \\ and / and <tags>';
const CONTROLS = "tab\there, newline\nhere, return\rhere, bell\x07 backspace\x08 formfeed\x0c unit\x1f del\x7f";
const WIDE = "naïve café — 日本語 \u{1f389} \u2028 line and \u2029 paragraph separators, nbsp\u00a0";

function message(text: string): string {
  return JSON.stringify({ text, via: "window" });
}

// A message's text is inside JSON inside the signed JSON, so its control characters reach the signed bytes escaped twice; the last event's content is not JSON at all, which the envelope allows and a reader calls unknown, so they reach them as they are.
const EVENTS: readonly (readonly [to: string, kind: string, content: string, refs: readonly string[]])[] = [
  ["bob", "message", message("hello"), []],
  ["#backend", "message", message(QUOTES), [REF]],
  [
    "bob",
    "job.accepted",
    JSON.stringify({ repo: "acme.billing.api", branch: "feature/retry ±", commit: "0123456789abcdef0123456789abcdef01234567", dirty: true, delivery: "review", mode: "full", by: "owner" }),
    [REF]
  ],
  ["bob", "message", message(CONTROLS), []],
  ["#backend", "message", message(WIDE), [REF, "1e".repeat(32)]],
  ["*", "some.later.kind", `${QUOTES} ${CONTROLS} ${WIDE}`, []]
];

const REMOTES: readonly string[] = [
  "https://dev.azure.com/acme/Platform/_git/uploader",
  "https://acme@dev.azure.com/acme/Platform/_git/uploader",
  "git@ssh.dev.azure.com:v3/acme/Platform/uploader",
  "ssh://git@ssh.dev.azure.com:22/v3/acme/Platform/uploader",
  "https://acme.visualstudio.com/Platform/_git/uploader",
  "https://acme.visualstudio.com/DefaultCollection/Platform/_git/uploader",
  "acme@vs-ssh.visualstudio.com:v3/acme/Platform/uploader",
  "https://dev.azure.com/acme/_git/uploader",
  "git@ssh.dev.azure.com:v3/acme/Billing%20Core/Acme.Billing.Api",
  "https://github.com/acme/uploader.git",
  "https://user:token@github.com/acme/uploader.git/",
  "git@github.com:Acme/Uploader.git",
  "https://gitlab.example.com:8443/group/sub group/it's (new)!*~.git",
  "https://gitlab.example.com:8443/it's (new)!*~/sub group/repo.git",
  "https://github.com/acme/Ünïcode-repo",
  "https://github.com/acme/100%-done",
  "git://github.com/acme/uploader",
  "https://github.com/uploader",
  "https://github.com/acme/-leading-dash",
  "file:///srv/git/uploader.git",
  "/srv/git/uploader.git",
  "not a url",
  ""
];

const PREFIXES: readonly string[] = ["https://example.com/it's (new)!*~/", "https://dev.azure.com/acme/", "https://dev.azure.com/acme/Billing Core", "https://github.com/Acme", "git@github.com:acme"];

const MENTIONS: readonly string[] = [
  "@bob/uploader where do we retry?",
  "@bob/uploader and @carol/uploader, compare. @bob/uploader again",
  "(@bob/up-loader_2)",
  "mail me at jacob@acme/corp or see docs/@bob/uploader",
  "@bob can you look?",
  "@Bob/Uploader. And é@bob/uploader, and 日本@bob/uploader",
  "ask @bob/acme.billing.api.",
  ""
];

const key = loadKey(PRIVATE_KEY);

/** A message as the fold would leave it, or with `agent` an agent's answer: all an agent's prompt reads of one. */
function shown(seq: number, author: string, to: string, text: string, agent: string | null = null): Message {
  const event = signEvent(key, { author, to, kind: agent === null ? "message" : "job.result", content: "{}", ts: TS, refs: [] });
  return { entry: { seq, event, trusted: true }, agent, answers: agent === null ? null : event.id, branch: "", root: null, text, edited: false, deleted: false, reactions: new Map(), replies: [] };
}

const earlier = [shown(1, "bob", "#backend", "it was the connection pool"), shown(2, "carol", "#backend", "Retries live in queue.py", "uploader")];
const ask = "@jacob/uploader where do we retry?";

// Each event's nonce is fixed, its place in the list, so the record can be signed again to the same bytes.
const vectors = {
  private_key: PRIVATE_KEY,
  public_key: publicHex(key),
  ts: TS,
  events: EVENTS.map(([to, kind, content, refs], index) => signEvent(key, { author: "jacob", to, kind, content, ts: TS, refs }, index.toString(16).padStart(16, "0"))),
  auth: { ...AUTH, header: authHeader(key, "jacob", TS, AUTH.method, AUTH.path) },
  remotes: REMOTES.map((remote) => [remote, parseRemote(remote)]),
  prefixes: PREFIXES.map((url) => [url, prefixKey(url)]),
  mentions: MENTIONS.map((body) => [body, mentions(body)]),
  prompts: [
    { review: true, prompt: agentPrompt(shown(3, "bob", "#backend", ask), "jacob", "uploader", earlier, true) },
    { review: false, prompt: agentPrompt(shown(3, "bob", "jacob", ask), "jacob", "uploader", [], false) },
    { review: false, prompt: agentPrompt(shown(3, "jacob", "bob", ask), "jacob", "uploader", [], false) },
    { review: true, mcp: true, prompt: agentPrompt(shown(3, "bob", "#backend", ask), "jacob", "uploader", earlier, true, "mcp") },
    { review: false, grant: true, prompt: agentPrompt(shown(3, "bob", "#backend", ask), "jacob", "uploader", earlier, false, "none") }
  ]
};

writeFileSync(join(import.meta.dirname, "..", "test", "fixtures", "signing-vectors.json"), `${JSON.stringify(vectors, null, 1)}\n`);
