# Phase 3: agents over ACP, permission modes, and a live activity feed

Goal: the owner can see what their agent is doing while it does it, and can hold it to a level of access. A teammate's request no longer means "run with whatever the command line allows".

Depends on: phase 2. Read "Permission modes" in [`protocol.md`](protocol.md) first.

Borrowed from Buzz: the Agent Client Protocol in place of a command that prints once, and a feed that reads as verb, object, outcome. Borrowed from T3 Code: named permission modes, and the rule that a run started for someone else never exceeds the mode its owner chose.

## What ACP is, briefly

A JSON-RPC conversation over the agent's standard input and output. The desk is the client. The parts used here:

| Call | Direction | Used for |
|---|---|---|
| `initialize` | desk to agent | Agree a protocol version; say what the client offers. |
| `authenticate` | desk to agent | Only if the agent says it needs it. |
| `session/new` | desk to agent | Start a session in a folder, with MCP servers attached. |
| `session/prompt` | desk to agent | Send the request; resolves when the turn ends. |
| `session/update` | agent to desk | Streamed: message text, thoughts, tool calls and their updates, plans. |
| `session/request_permission` | agent to desk | The agent asks before acting. The desk answers by the mode. |
| `session/cancel` | desk to agent | Stop the turn. |

Use the protocol's TypeScript SDK, `@agentclientprotocol/sdk`. Read its types before writing against it; do not guess a method's shape. The two agents the team uses start like this:

| Agent | Command | Arguments |
|---|---|---|
| Cursor | `agent` | `acp` |
| GitHub Copilot | `copilot` | `--acp --stdio` |

Copilot's ACP mode is a public preview. Do not use Cursor's SDK.

## A. Agents in the configuration

- [ ] **P3-A1** `configSchema` in `src/core/wire.ts` replaces `agent: string` with:

  ```ts
  agents: { id: string; label: string; protocol: "acp" | "oneshot"; command: string; args: string[] }[];
  defaultAgent: string; // an id in `agents`
  ownMode: PermissionMode; // for requests I make of my own agents; starts as "auto-edits"
  ```

  A `config.json` that still has `agent` loads as one `oneshot` agent made by splitting that string, and is written back in the new shape.
- [ ] **P3-A2** Built-in presets in `src/desk/agents/presets.ts`: Cursor and Copilot, each in an ACP form and a one-shot form (the one-shot commands from task P0-H4). The join form and a new "Agents" part of the setup page choose among them or define a custom command and arguments, one argument per row. No shell ever expands them.
- [ ] **P3-A3** `src/desk/permissions.ts`: the `PermissionMode` type, `atMost(a, b)` for the ordering, and `decide(mode, action)` returning `"allow"`, `"ask"` or `"refuse"` for an action that is one of ACP's tool kinds: `read`, `search`, `think`, `edit`, `delete`, `move`, `execute`, `fetch`, `other`. The table is in the protocol reference; `delete` and `move` follow `edit` except in `auto-edits`, where they ask. One test walks the whole table.

## B. Running an agent

- [ ] **P3-B1** `src/desk/agents/runner.ts`: the one shape both kinds of agent present to the session.

  ```ts
  interface RunHandlers {
    activity(item: ActivityItem): void; // new, or a newer version of one with the same id
    permission(ask: PermissionAsk): Promise<"allow-once" | "allow-run" | "refuse">;
  }
  interface AgentRunner {
    readonly restrictable: boolean; // false means modes cannot be enforced on it
    run(prompt: string, cwd: string, mode: PermissionMode, handlers: RunHandlers, cancel: AbortSignal): Promise<string>;
  }
  ```

  The existing one-shot runner in `src/desk/agents/oneshot.ts` becomes an `AgentRunner` with `restrictable: false`, with one exception below.
- [ ] **P3-B2** One-shot commands and modes. A one-shot agent takes no questions, so:

  | Agent | `read-only` | Anything else |
  |---|---|---|
  | Cursor one-shot | Run without `--force`; it then only proposes changes. | Add `--force`. This is `full`, whatever was chosen. |
  | Copilot one-shot | Not possible: it needs `--allow-all-tools` to run at all. | `full`. |
  | Custom one-shot | Not possible. | `full`. |

  Where a mode cannot be honoured the runner says so before it starts and the session refuses the run with a notice, unless the mode asked for was `full`.
- [ ] **P3-B3** `src/desk/agents/acp.ts`: the ACP runner. Start the command in the checkout with the resolved `PATH`; `initialize`; `authenticate` if required, and if that fails, end with a problem that names the agent's own sign-in command; `session/new` with the checkout as its folder and deskmate's MCP server attached without `--allow-send`; `session/prompt`; collect the agent's message text as the answer. Its own process group, killed on every way out, as the one-shot runner does.
- [ ] **P3-B4** Permission requests: map the request's tool kind through `decide`. `allow` and `refuse` are answered at once with the agent's matching option. `ask` goes to `handlers.permission` and waits. "Allow for this run" is remembered for that kind of action until the run ends, and never beyond it. If the agent offers no option that matches the decision, refuse.
- [ ] **P3-B5** Stopping: send `session/cancel`, wait two seconds, then kill the process group. The run ends as cancelled either way. The 900-second limit stays, and time spent waiting on a permission card does not count towards it.
- [ ] **P3-B6** Follow-ups: keep a finished ACP session open for 30 idle minutes, keyed by thread root, asker and agent. A reply in that thread from the same asker that tags the same agent goes to the same session as a new prompt, with only the new text. Anything else starts a fresh session with the usual context. Closing the desk closes them all.
- [ ] **P3-B7** `test/fixtures/fake-acp-agent.ts`: a scripted ACP agent built on the SDK's agent side, run with `node`. What it does depends on words in the prompt: `read` reports a read tool call; `edit` asks permission to edit, and writes a file only if allowed; `run` asks permission to execute; `slow` waits until cancelled; it always streams a short message in two chunks. `test/acp.test.ts` runs it through the ACP runner under each mode and checks what was allowed, asked and refused, that cancel ends `slow` within three seconds, and that a follow-up reuses the session.

## C. The session and the modes

- [ ] **P3-C1** Accepting a teammate's request carries a mode and a delivery. The `run` command gains `mode`; `job.accepted` records it. The default for a teammate's request is `read-only` with review. A request I make of my own agent from the window runs at `ownMode` and posts directly, as now.
- [ ] **P3-C2** The session refuses to start a run whose mode the chosen agent cannot honour (task P3-B2) and says which agent setting would allow it.
- [ ] **P3-C3** A permission ask becomes part of the view: which run, what the agent wants to do in one line, and the detail (the command, or the file and its diff) capped at 8 KB. Commands `permit { ask, answer }`. An arrival is raised so the owner gets a system notification when a card is waiting and they are not looking.
- [ ] **P3-C4** While a run is going the session publishes `job.progress` at most once every ten seconds, and only when the summary changes. The summary is one of a fixed set: `thinking`, `reading`, `editing files`, `running a command`, `waiting for approval`. Never a path, a command or any output.

## D. The activity feed

What the owner sees of their own agent's run. It stays on the owner's machine: it is in the desk's view, never in an event.

- [ ] **P3-D1** `ActivityItem` in `src/shared/ipc.ts`:

  ```ts
  { id, run, kind: "message" | "thought" | "tool" | "plan" | "permission" | "error" | "state",
    title, // verb and object: "Edited src/queue.py", "Ran npm test"
    outcome, // "+12 −3", "exit 0", "refused", "" while running
    status: "running" | "done" | "failed",
    quiet, // reads, searches and thoughts
    detail } // raw input and output, capped at 8 KB, "" when there is none
  ```

- [ ] **P3-D2** `src/desk/agents/activity.ts` turns ACP updates into items. Chunks of one message become one item that grows. A tool call and its later updates are one item that changes in place. Titles name things as a person would: a file's path relative to the checkout, a command's first line. An update it does not recognise becomes a plain item with the tool's own title rather than a guess. A one-shot run produces two items: started, and how it ended.
- [ ] **P3-D3** The session keeps the last 500 items per run in memory, for runs in the open chat, and includes them in the view. Nothing is written to disk.
- [ ] **P3-D4** In the window, a running request has "Show activity", which opens a side panel: one row per item, newest at the bottom; failures and anything that changed a file or ran a command stand out, quiet items are dim; a row opens to show `detail`; "waiting…" appears after ten seconds with no new item, and "timed out" if that is how it ended. It never shows an empty panel for a run that exists.
- [ ] **P3-D5** A permission card appears both in the panel and under the request in the chat, with "Allow once", "Allow for this run" and "Refuse".
- [ ] **P3-D6** For teammates, the request line shows the coarse summary from `job.progress`: "jacob's uploader agent is editing files on main".

## E. Choosing a mode in the window

- [ ] **P3-E1** Under a teammate's request the buttons become: "Run read-only" as the main action, with a menu for the delivery (review first, or post directly) and the mode. The last choice for that asker and repo is offered first next time.
- [ ] **P3-E2** Where the chosen agent is not restrictable, the menu offers `full` only and says why: "this agent runs as a single command and cannot be limited".
- [ ] **P3-E3** A request shows the mode it was accepted at to everyone in the chat.

## F. The setup check

- [ ] **P3-F1** `agent-acp`: for each ACP agent in the configuration, start it and `initialize`, with a ten-second limit. Fail with the agent's own error, and with the sign-in command when it reports it needs authentication.
- [ ] **P3-F2** `agent-permissions`, run only when the user presses "Test permissions", because it costs a model call: in a temporary git folder, ask the agent to create a file under `supervised`, refuse the request, and pass if a permission request arrived and no file was written. Save the result with the agent's version; an agent that fails is treated as not restrictable.
- [ ] **P3-F3** **(workstation)** Run both for Cursor and for Copilot. Record the results, and each tool's exact one-shot flags, in the "Phase 3" part of [`workstation-checklist.md`](workstation-checklist.md). T3 Code moved its Cursor support from ACP to Cursor's SDK; that route is closed here, so if Cursor's ACP mode does not ask before writing, Cursor stays a one-shot agent and the note in P3-B2 applies.

## Done when

1. Every task is ticked except the one marked **(workstation)**, and the checks are green.
2. In the two-session scenario with the scripted agent: a teammate's request accepted `read-only` cannot write a file; accepted `supervised`, it raises a card and proceeds only after "Allow"; the owner's activity panel shows the steps as they happen; the teammate sees only the coarse summary; Stop ends the run within three seconds.
3. No activity item, path or command appears in any event the hub stores. A test reads the hub's table after a run and checks.
