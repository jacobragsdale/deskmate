/**
 * Writes test/fixtures/signing-vectors.json: what this code signs, how it names repos, which tags it finds and what it tells an agent, for one fixed key and the inputs below.
 * test/vectors.test.ts holds the code to that file, so run this only when the format is meant to change, and commit the file with the change: `node scripts/make-vectors.ts`.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { agentPrompt, mentions } from "../src/core/chat.ts";
import type { Entry } from "../src/core/chat.ts";
import { parseRemote, prefixKey } from "../src/core/remotes.ts";
import { authHeader, loadKey, publicHex, signNote } from "../src/core/sign.ts";
import type { Kind } from "../src/core/wire.ts";

const PRIVATE_KEY = "11".repeat(32);
const TS = 1_800_000_000;
const AUTH = { method: "GET", path: "/notes?after=41&wait=25.0&mine=false&status=true" };

// Bodies chosen for what an encoder might get wrong: quotes and slashes, every kind of control character, and text outside ASCII and outside the first plane.
const NOTES: readonly (readonly [sender: string, to: string, kind: Kind, body: string, agent: string | null, re: number | null])[] = [
  ["jacob", "bob", "note", "hello", null, null],
  ["jacob", "#backend", "note", 'quotes " and \\ and / and <tags>', "uploader", 41],
  ["jacob", "bob", "status", "working\nfeature/retry ±", "acme.billing.api", 7],
  ["jacob", "bob", "note", "tab\there, newline\nhere, return\rhere, bell\x07 backspace\x08 formfeed\x0c unit\x1f del\x7f", null, null],
  ["jacob", "bob", "note", "naïve café — 日本語 \u{1f389}   line and   paragraph separators, nbsp ", null, null]
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

function entry(id: number, sender: string, to: string, body: string, agent: string | null = null): Entry {
  return { id, note: signNote(key, { sender, to, kind: "note", body, ts: TS, agent, re: null }), trusted: true };
}

const earlier = [entry(1, "bob", "#backend", "it was the connection pool"), entry(2, "carol", "#backend", "Retries live in queue.py", "uploader")];
const ask = "@jacob/uploader where do we retry?";

const vectors = {
  private_key: PRIVATE_KEY,
  public_key: publicHex(key),
  ts: TS,
  notes: NOTES.map(([sender, to, kind, body, agent, re]) => signNote(key, { sender, to, kind, body, ts: TS, agent, re })),
  auth: { ...AUTH, header: authHeader(key, "jacob", TS, AUTH.method, AUTH.path) },
  remotes: REMOTES.map((remote) => [remote, parseRemote(remote)]),
  prefixes: PREFIXES.map((url) => [url, prefixKey(url)]),
  mentions: MENTIONS.map((body) => [body, mentions(body)]),
  prompts: [
    { review: true, prompt: agentPrompt(entry(3, "bob", "#backend", ask), "jacob", "uploader", earlier, true) },
    { review: false, prompt: agentPrompt(entry(3, "bob", "jacob", ask), "jacob", "uploader", [], false) },
    { review: false, prompt: agentPrompt(entry(3, "jacob", "bob", ask), "jacob", "uploader", [], false) }
  ]
};

writeFileSync(join(import.meta.dirname, "..", "test", "fixtures", "signing-vectors.json"), `${JSON.stringify(vectors, null, 1)}\n`);
