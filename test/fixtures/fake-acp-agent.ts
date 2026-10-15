/**
 * A scripted ACP agent for the tests, built on the SDK's agent side and run with `node`. What it does depends on words in the prompt:
 * `read` reports a read tool call; each `edit` asks to edit and writes edited.txt only if allowed; `run` asks to execute; `switch` asks to switch its session to a mode in which it edits without asking,
 * as ACP lets an agent's modes differ in what they ask; `slow` waits until cancelled, with a child process of its own;
 * `deaf` does the same but takes no notice of a cancel; `mcp` says which MCP servers its session has. Whatever it did, it says so in a short message streamed in two chunks,
 * after the number of the turn in its session. Started with --signed-out it says it needs signing in, and signing in fails; with --always-only it offers no way to be allowed just once;
 * with --no-asking it edits without asking first, as an agent that cannot be limited would; with --deaf every prompt is also `deaf`.
 * It adds its pid, and its child's, to `pids` in its folder, or to the file --pids=FILE names, unless started with --no-pids, for a test of what it writes there.
 */

import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

interface Session {
  readonly cwd: string;
  readonly servers: string;
  turns: number;
  cancelled: () => void; // Ends the turn that is waiting, if one is.
}

const sessions = new Map<string, Session>();
const unasking = new Set<string>(); // Sessions switched to a mode in which they edit without asking.
const signedOut = process.argv.includes("--signed-out");
const alwaysOnly = process.argv.includes("--always-only"); // Offers to be allowed only always, never once.
const noAsking = process.argv.includes("--no-asking");
const deaf = process.argv.includes("--deaf");
const pids = process.argv.includes("--no-pids") ? null : (process.argv.find((arg) => arg.startsWith("--pids="))?.slice("--pids=".length) ?? "pids"); // From its folder, the session's.
if (pids !== null) {
  appendFileSync(pids, `${String(process.pid)}\n`);
}

/** Ask to do something, as a tool call that waits for the client's answer, and report how it went. Resolves with whether it was allowed. */
async function permitted(client: acp.AgentContext, sessionId: string, toolCallId: string, kind: acp.ToolKind, title: string): Promise<boolean> {
  await client.notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId, title, kind, status: "pending", rawInput: { title } } });
  const answer = await client.request("session/request_permission", {
    sessionId,
    toolCall: { toolCallId, title, kind, rawInput: { title } },
    options: [
      ...(alwaysOnly ? [] : [{ optionId: "yes", name: "Allow", kind: "allow_once" } as const]),
      { optionId: "always", name: "Always allow", kind: "allow_always" },
      { optionId: "no", name: "Reject", kind: "reject_once" }
    ]
  });
  const allowed = answer.outcome.outcome === "selected" && answer.outcome.optionId !== "no";
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
  .onRequest("initialize", () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentInfo: { name: "fake-acp-agent", version: "1.2.3" }, authMethods: [{ id: "browser", name: "Sign in with a browser" }] }))
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
    const did: string[] = [];
    if (has("read")) {
      await client.notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "read", title: "Read README.md", kind: "read", status: "in_progress" } });
      await client.notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "read", status: "completed" } });
      did.push("read");
    }
    if (has("switch")) {
      did.push(await switchMode(client, sessionId, session.turns));
    }
    for (const [index] of [...text.matchAll(/\bedit\b/g)].entries()) {
      did.push(await edit(client, sessionId, session, index));
    }
    if (has("run")) {
      did.push((await permitted(client, sessionId, `run-${String(session.turns)}`, "execute", "Run npm test")) ? "run allowed" : "run refused");
    }
    if (has("mcp")) {
      did.push(`servers ${session.servers}`);
    }
    if (has("slow") || has("deaf")) {
      const child = spawn("sleep", ["60"], { stdio: "ignore" });
      if (pids !== null) {
        appendFileSync(pids, `${String(child.pid)}\n`);
      }
      if (has("slow")) {
        await new Promise<void>((resolve) => {
          session.cancelled = resolve;
        });
        return { stopReason: "cancelled" };
      }
      await new Promise<void>(() => {
        // Deaf: it never ends by itself.
      });
    }
    await client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `turn ${String(session.turns)}: ` } } });
    await client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: did.join("; ") } } });
    return { stopReason: "end_turn" };
  })
  .onNotification("session/cancel", ({ params }) => {
    sessions.get(params.sessionId)?.cancelled();
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), input()));
