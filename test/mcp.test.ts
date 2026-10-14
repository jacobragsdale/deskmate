/** The MCP server, driven over in-memory streams by the SDK's own client, as one person against a hub of the test's own. */

import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { test } from "node:test";

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { noteLink } from "../src/core/links.ts";
import type { Delivered } from "../src/core/wire.ts";
import type { Client } from "../src/desk/client.ts";
import { createServer } from "../src/mcp/server.ts";
import { NOW, startHub } from "./startHub.ts";

const AT = new Date(NOW * 1000).toISOString();
const COMMIT = "c0ffee".padEnd(40, "0");
const resultSchema = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })), isError: z.boolean().optional() });

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

/** An MCP client connected to the server running as `as`. */
async function connect(t: TestContext, as: Client): Promise<McpClient> {
  const [near, far] = InMemoryTransport.createLinkedPair();
  const server = createServer(as);
  await server.connect(far);
  const client = new McpClient({ name: "test", version: "1" });
  await client.connect(near);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

/** Call a tool and return what it handed back, parsed; a refusal fails the test with its words. */
async function call(mcp: McpClient, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = resultSchema.parse(await mcp.callTool({ name, arguments: args }));
  const [first] = result.content;
  assert.ok(first !== undefined && result.isError !== true, `${name} refused: ${first?.text ?? ""}`);
  return parseJson(first.text);
}

await test("the reading tools hand over what the hub holds, folded as the window folds it", async (t) => {
  const hub = await startHub(t);
  const [alice, bob, carol] = [await hub.join("alice"), await hub.join("bob"), await hub.join("carol")];
  await bob.advertise([{ name: "uploader", key: "dev.azure.com/acme/platform/uploader", url: "https://dev.azure.com/acme/Platform/_git/uploader", branch: "main" }]);
  for (const who of [alice, bob]) {
    await who.publish("#backend", "channel.join", {});
  }
  const asked = await alice.publish("#backend", "message", { text: "@bob/uploader where do we retry?", via: "cli" });
  const request = asked.event.id;
  await alice.publish("#backend", "message.edit", { text: "@bob/uploader where do we retry 429s?" }, [request]);
  await bob.publish("#backend", "job.accepted", { repo: "uploader", branch: "main", commit: COMMIT, dirty: false, delivery: "post", mode: "full", by: "owner" }, [request]);
  const answered = await bob.publish("#backend", "job.result", { repo: "uploader", branch: "main", text: "in queue.py", reviewed: false }, [request]);
  const reply = await bob.publish("#backend", "message", { text: "and the tests", via: "cli" }, [request]);
  await carol.publish("alice", "message", { text: "lunch?", via: "cli" });
  const mcp = await connect(t, alice);

  // Where each note came from, as every tool says it; and the rest of each, as read_chat and read_note say it.
  const from = (delivered: Delivered, author: string, agent: string | null): Record<string, unknown> => ({
    link: noteLink(delivered.event.id),
    seq: delivered.seq,
    chat: "#backend",
    author,
    agent,
    at: AT,
    trusted: true
  });
  const the = {
    request: { ...from(asked, "alice", null), text: "@bob/uploader where do we retry 429s?", edited: true, deleted: false, thread: null },
    answer: { ...from(answered, "bob", "uploader"), text: "in queue.py", edited: false, deleted: false, thread: null },
    reply: { ...from(reply, "bob", null), text: "and the tests", edited: false, deleted: false, thread: noteLink(request) }
  };
  assert.deepEqual(
    (await mcp.listTools()).tools.map((tool) => tool.name),
    ["whoami", "list_chats", "list_agents", "read_chat", "read_note", "search", "job_status"]
  );
  assert.deepEqual(await call(mcp, "whoami"), { name: "alice", hub: hub.url, repos: [] });
  assert.deepEqual(await call(mcp, "list_chats"), [
    { chat: "#backend", unread: 2 },
    { chat: "bob", unread: 0 },
    { chat: "carol", unread: 1 }
  ]);
  assert.deepEqual(await call(mcp, "list_agents", { query: "BOB/" }), [{ agent: "bob/uploader", branch: "main", here: true }]);
  assert.deepEqual(await call(mcp, "list_agents", { query: "nobody" }), []);
  assert.deepEqual(await call(mcp, "read_chat", { chat: "#backend" }), { notes: [the.request, the.answer, the.reply], before: null });
  assert.deepEqual(await call(mcp, "read_chat", { chat: "#backend", limit: 3 }), { notes: [the.answer, the.reply], before: answered.seq - 1 }); // The accept is in the page, though not a note.
  assert.deepEqual(await call(mcp, "read_note", { note: noteLink(request) }), { note: the.request, jobs: [{ agent: "bob/uploader", state: "answered" }], answers: [the.answer], replies: [the.reply] });
  assert.deepEqual(await call(mcp, "search", { q: "retry 429s", chat: "#backend" }), [{ ...from(asked, "alice", null), snippet: "@bob/uploader where do we retry 429s?" }]);
  assert.deepEqual(await call(mcp, "job_status", { request, agent: "bob/uploader" }), { agent: "bob/uploader", state: "answered", answer: the.answer });

  const refused = resultSchema.parse(await mcp.callTool({ name: "read_note", arguments: { note: "player-two://note/nothing" } }));
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]?.text ?? "", /a note is its player-two:\/\/note\/ link or its 64-hex id/);
});
