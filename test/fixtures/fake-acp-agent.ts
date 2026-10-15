/**
 * A scripted ACP agent for the tests, built on the SDK's agent side and run with `node`. What it does depends on words in the prompt:
 * `twice` says something in a message of its own first, with a step after it; `read` reports reading README.md in its folder, by its path; `many` reports 600 reads;
 * `switch` asks to switch its session to a mode in which it edits without asking, as ACP lets an agent's modes differ in what they ask; each `edit` asks to edit and writes edited.txt only if allowed;
 * `run` asks to run `npm test` in its folder; `takeback` asks to edit and takes the request back 300 ms later; `leave` asks to edit and ends its turn without waiting for the answer;
 * `stray` asks under another session's id; `long` asks to edit under a title of two lines and over 300 characters; `mcp` says which MCP servers its session has; `whoami` says the agent its environment names in PLAYER_TWO_AGENT;
 * `slow` waits until cancelled, with a child process of its own; `deaf` does the same but takes no notice of a cancel.
 * Whatever it did, it says so in a short message streamed in two chunks, after the number of the turn in its session. Told while it asks that its turn is cancelled, it ends the turn as cancelled, as ACP asks. Started with --signed-out it says it needs signing in, and signing in fails; with --always-only it offers no way to be allowed just once;
 * with --no-asking it edits without asking first, as an agent that cannot be limited would; with --deaf every prompt is also `deaf`. It says it is version 1.2.3, or with --version-file=FILE what FILE holds, as an agent updated in place would.
 * It adds its pid, and its child's, to `pids` in its folder, or to the file --pids=FILE names, unless started with --no-pids, for a test of what it writes there.
 */

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import * as acp from "@agentclientprotocol/sdk";

interface Session {
  readonly cwd: string;
  readonly servers: string;
  turns: number;
  cancelled: () => void; // Ends the turn that is waiting, if one is.
}

const sessions = new Map<string, Session>();
const unasking = new Set<string>(); // Sessions switched to a mode in which they edit without asking.
const OPTIONS: acp.PermissionOption[] = [
  { optionId: "yes", name: "Allow", kind: "allow_once" },
  { optionId: "no", name: "Reject", kind: "reject_once" }
];

/** The client answered a request to act as cancelled: its turn is over. */
class Cancelled extends Error {}
const signedOut = process.argv.includes("--signed-out");
const alwaysOnly = process.argv.includes("--always-only"); // Offers to be allowed only always, never once.
const noAsking = process.argv.includes("--no-asking");
const deaf = process.argv.includes("--deaf");
const versionFile = process.argv.find((arg) => arg.startsWith("--version-file="))?.slice("--version-file=".length);
const pids = process.argv.includes("--no-pids") ? null : (process.argv.find((arg) => arg.startsWith("--pids="))?.slice("--pids=".length) ?? "pids"); // From its folder, the session's.
if (pids !== null) {
  appendFileSync(pids, `${String(process.pid)}\n`);
}

/** Ask to do something, as a tool call that waits for the client's answer, and report how it went. Resolves with whether it was allowed; rejects with Cancelled when the turn is. */
async function permitted(client: acp.AgentContext, sessionId: string, toolCallId: string, kind: acp.ToolKind, title: string, rawInput: unknown = { title }): Promise<boolean> {
  await client.notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId, title, kind, status: "pending", rawInput } });
  const answer = await client.request("session/request_permission", {
    sessionId,
    toolCall: { toolCallId, title, kind, rawInput },
    options: [
      ...(alwaysOnly ? [] : [{ optionId: "yes", name: "Allow", kind: "allow_once" } as const]),
      { optionId: "always", name: "Always allow", kind: "allow_always" },
      { optionId: "no", name: "Reject", kind: "reject_once" }
    ]
  });
  if (answer.outcome.outcome === "cancelled") {
    throw new Cancelled();
  }
  const allowed = answer.outcome.optionId !== "no";
  await client.notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId, status: allowed ? "completed" : "failed" } });
  return allowed;
}

/** Ask to switch the session to a mode in which it edits without asking, and switch it if allowed. */
async function switchMode(client: acp.AgentContext, sessionId: string, turn: number): Promise<string> {
  if (await permitted(client, sessionId, `switch-${String(turn)}`, "switch_mode", "Switch to editing without asking")) {
    unasking.add(sessionId);
    return "switched";
  }
  return "switch refused";
}

/** The `index`th edit of a turn: ask, unless it does not, and write edited.txt if allowed. */
async function edit(client: acp.AgentContext, sessionId: string, session: Session, index: number): Promise<string> {
  const allowed = noAsking || unasking.has(sessionId) || (await permitted(client, sessionId, `edit-${String(session.turns)}-${String(index)}`, "edit", "Edit edited.txt"));
  if (allowed) {
    writeFileSync(join(session.cwd, "edited.txt"), "edited\n");
  }
  return allowed ? "edit allowed" : "edit refused";
}

/** Ask to edit, and take the request back 300 ms later, as an agent that thinks better of it may. */
async function takeBack(client: acp.AgentContext, sessionId: string): Promise<string> {
  const toolCall = { toolCallId: "takeback", title: "Edit taken-back.txt", kind: "edit" } as const;
  await client.notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", ...toolCall, status: "pending" } });
  const answered = await client.request("session/request_permission", { sessionId, toolCall, options: OPTIONS }, { cancellationSignal: AbortSignal.timeout(300) }).then(
    () => true,
    () => false
  );
  return answered ? "answered" : "took it back";
}

/** Report reading a file in the session's folder, by its path there, `count` times. */
async function read(client: acp.AgentContext, sessionId: string, session: Session, count: number): Promise<void> {
  const path = join(session.cwd, "README.md");
  for (let index = 0; index < count; index += 1) {
    const toolCallId = count === 1 ? "read" : `read-${String(index)}`;
    await client.notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId, title: "Read README.md", kind: "read", status: "in_progress", locations: [{ path }], rawInput: { path } } });
    await client.notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed" } });
  }
}

/** Ask to edit and go on without waiting for the answer, ending the turn while the client still has the request. */
async function leave(client: acp.AgentContext, sessionId: string): Promise<string> {
  client.request("session/request_permission", { sessionId, toolCall: { toolCallId: "leave", title: "Edit left.txt", kind: "edit" }, options: OPTIONS }).catch(() => undefined);
  await delay(200); // Long enough for the request to reach the owner.
  return "left";
}

/** Ask to edit under another session's id, which no client should allow. */
async function stray(client: acp.AgentContext, sessionId: string): Promise<string> {
  const answer = await client.request("session/request_permission", { sessionId: `${sessionId}-elsewhere`, toolCall: { toolCallId: "stray", title: "Edit stray.txt", kind: "edit" }, options: OPTIONS });
  return `stray ${answer.outcome.outcome}`;
}

/** Ask to edit under a title too long for one line, and on two. */
async function long(client: acp.AgentContext, sessionId: string): Promise<string> {
  return (await permitted(client, sessionId, "long", "edit", `Edit ${"x".repeat(300)}\nand more`)) ? "long allowed" : "long refused";
}

/** Everything the agent does for the words of one prompt, but wait, and what it says it did. */
async function act(client: acp.AgentContext, sessionId: string, session: Session, text: string, has: (word: string) => boolean): Promise<string[]> {
  const did: string[] = [];
  if (has("twice")) {
    await say(client, sessionId, "Looking at it.");
    await client.notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "look", title: "Look around", kind: "think", status: "completed" } });
    did.push("said twice");
  }
  if (has("read")) {
    await read(client, sessionId, session, 1);
    did.push("read");
  }
  if (has("many")) {
    await read(client, sessionId, session, 600);
    did.push("read many");
  }
  if (has("switch")) {
    did.push(await switchMode(client, sessionId, session.turns));
  }
  for (const [index] of [...text.matchAll(/\bedit\b/g)].entries()) {
    did.push(await edit(client, sessionId, session, index));
  }
  if (has("run")) {
    const command = { command: "npm test", cwd: session.cwd };
    did.push((await permitted(client, sessionId, `run-${String(session.turns)}`, "execute", "Run npm test", command)) ? "run allowed" : "run refused");
  }
  for (const [word, step] of [
    ["takeback", takeBack],
    ["leave", leave],
    ["stray", stray],
    ["long", long]
  ] as const) {
    if (has(word)) {
      did.push(await step(client, sessionId));
    }
  }
  if (has("mcp")) {
    did.push(`servers ${session.servers}`);
  }
  if (has("whoami")) {
    did.push(`as ${process.env["PLAYER_TWO_AGENT"] ?? "nobody"}`);
  }
  return did;
}

/** Start a child process of its own, as `slow` and `deaf` do. */
function startChild(): void {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  if (pids !== null) {
    appendFileSync(pids, `${String(child.pid)}\n`);
  }
}

/** One chunk of a message. */
async function say(client: acp.AgentContext, sessionId: string, text: string): Promise<void> {
  await client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
}

/** Standard input as the web stream the SDK reads. */
function input(): ReadableStream<Uint8Array> {
  let done = false;
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      process.stdin.on("data", (chunk: Buffer) => {
        if (!done) {
          controller.enqueue(chunk);
        }
      });
      process.stdin.on("end", () => {
        if (!done) {
          done = true;
          controller.close();
        }
      });
    },
    cancel: () => {
      done = true;
    }
  });
}

acp
  .agent({ name: "fake-acp-agent" })
  .onRequest("initialize", () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentInfo: { name: "fake-acp-agent", version: versionFile === undefined ? "1.2.3" : readFileSync(versionFile, "utf8").trim() }, authMethods: [{ id: "browser", name: "Sign in with a browser" }] }))
  .onRequest("authenticate", () => {
    throw new Error("there is no browser here");
  })
  .onRequest("session/new", ({ params }) => {
    if (signedOut) {
      throw acp.RequestError.authRequired();
    }
    const sessionId = String(sessions.size + 1);
    sessions.set(sessionId, { cwd: params.cwd, servers: JSON.stringify(params.mcpServers), turns: 0, cancelled: () => undefined });
    return { sessionId };
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    const { sessionId } = params;
    const session = sessions.get(sessionId);
    if (session === undefined) {
      throw acp.RequestError.resourceNotFound(sessionId);
    }
    session.turns += 1;
    const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join(" ");
    const has = (word: string): boolean => new RegExp(`\\b${word}\\b`).test(text) || (deaf && word === "deaf");
    let did: string[];
    try {
      did = await act(client, sessionId, session, text, has);
    } catch (error) {
      if (error instanceof Cancelled) {
        return { stopReason: "cancelled" };
      }
      throw error;
    }
    if (has("slow") || has("deaf")) {
      startChild();
      await new Promise<void>((resolve) => {
        if (has("slow")) {
          session.cancelled = resolve; // Deaf, it never ends by itself.
        }
      });
      return { stopReason: "cancelled" };
    }
    await say(client, sessionId, `turn ${String(session.turns)}: `);
    await say(client, sessionId, did.join("; "));
    return { stopReason: "end_turn" };
  })
  .onNotification("session/cancel", ({ params }) => {
    sessions.get(params.sessionId)?.cancelled();
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), input()));
