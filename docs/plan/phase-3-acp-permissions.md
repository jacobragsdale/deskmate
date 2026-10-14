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

- [x] **P3-A1** `configSchema` in `src/core/wire.ts` replaces `agent: string` with:

  ```ts
  agents: { id: string; label: string; protocol: "acp" | "oneshot"; command: string; args: string[] }[];
  defaultAgent: string; // an id in `agents`
  ownMode: PermissionMode; // for requests I make of my own agents; starts as "auto-edits"
  ```

  A `config.json` that still has `agent` loads as one `oneshot` agent made by splitting that string, and is written back in the new shape.
- [x] **P3-A2** Built-in presets in `src/desk/agents/presets.ts`: Cursor and Copilot, each in an ACP form and a one-shot form (the one-shot commands from task P0-H4). The join form and a new "Agents" part of the setup page choose among them or define a custom command and arguments, one argument per row. No shell ever expands them.
- [x] **P3-A3** `src/desk/permissions.ts`: the `PermissionMode` type, `atMost(a, b)` for the ordering, and `decide(mode, action)` returning `"allow"`, `"ask"` or `"refuse"` for an action that is one of ACP's tool kinds: `read`, `search`, `think`, `edit`, `delete`, `move`, `execute`, `fetch`, `other`. The table is in the protocol reference; `delete` and `move` follow `edit` except in `auto-edits`, where they ask. One test walks the whole table.

## B. Running an agent

- [x] **P3-B1** `src/desk/agents/runner.ts`: the one shape both kinds of agent present to the session.

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
- [x] **P3-B2** One-shot commands and modes. A one-shot agent takes no questions, so:

  | Agent | `read-only` | Anything else |
  |---|---|---|
  | Cursor one-shot | Run without `--force`; it then only proposes changes. | Add `--force`. This is `full`, whatever was chosen. |
  | Copilot one-shot | Not possible: it needs `--allow-all-tools` to run at all. | `full`. |
  | Custom one-shot | Not possible. | `full`. |

  Where a mode cannot be honoured the runner says so before it starts and the session refuses the run with a notice, unless the mode asked for was `full`.
- [x] **P3-B3** `src/desk/agents/acp.ts`: the ACP runner. Start the command in the checkout with the resolved `PATH`; `initialize`; `authenticate` if required, and if that fails, end with a problem that names the agent's own sign-in command; `session/new` with the checkout as its folder and Player Two's MCP server attached without `--allow-send`; `session/prompt`; collect the agent's message text as the answer. Its own process group, killed on every way out, as the one-shot runner does.
- [x] **P3-B4** Permission requests: map the request's tool kind through `decide`. `allow` and `refuse` are answered at once with the agent's matching option. `ask` goes to `handlers.permission` and waits. "Allow for this run" is remembered for that kind of action until the run ends, and never beyond it. If the agent offers no option that matches the decision, refuse.
- [x] **P3-B5** Stopping: send `session/cancel`, wait two seconds, then kill the process group. The run ends as cancelled either way. The 900-second limit stays, and time spent waiting on a permission card does not count towards it.
- [x] **P3-B6** Follow-ups: keep a finished ACP session open for 30 idle minutes, keyed by thread root, asker and agent. A reply in that thread from the same asker that tags the same agent goes to the same session as a new prompt, with only the new text. Anything else starts a fresh session with the usual context. Closing the desk closes them all.
- [x] **P3-B7** `test/fixtures/fake-acp-agent.ts`: a scripted ACP agent built on the SDK's agent side, run with `node`. What it does depends on words in the prompt: `read` reports a read tool call; `edit` asks permission to edit, and writes a file only if allowed; `run` asks permission to execute; `slow` waits until cancelled; it always streams a short message in two chunks. `test/acp.test.ts` runs it through the ACP runner under each mode and checks what was allowed, asked and refused, that cancel ends `slow` within three seconds, and that a follow-up reuses the session.

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

## Notes

- **P3-A1: where the mode's schema lives, and what an old config becomes.** `MODES` and `permissionModeSchema` are in `src/core/wire.ts` beside `configSchema`, which needs them and cannot import from the desk; `src/desk/permissions.ts` (P3-A3) takes the type from there. An agent's `id` has the form of a name. `readConfig` in `src/desk/client.ts` reads `config.json` for the desk, the command, the MCP server and the setup check alike: one that still has `agent` becomes `{ id: "custom", label: <the line>, protocol: "oneshot", command, args }`, split with `splitCommand`, with `ownMode: "auto-edits"`, and is written back before anything else reads it. A line that will not split, an unclosed quote, now fails when the file is read instead of at each run, as an unreadable `config.json` already did. Until P3-A2, `player-two join --agent` still takes one command line, and every run takes the default agent.
- **P3-A2: how the presets reach the window, what is offered first, and the command that saves.** The presets are in `src/desk/agents/presets.ts`, which the window cannot import, so the desk sends them: the join form's view carries `presets` in place of `defaultAgent`, and the chat view `agents`, `defaultAgent` and `presets` in place of `agent`. `AGENT_CHOICES` is gone from `src/shared/ipc.ts`. Cursor's one-shot command is still offered first and is still `player-two join`'s default, because P3-F3 decides on the workstation whether Cursor's ACP mode asks before it writes; making ACP the default is the order of `PRESETS`. A new command, `agents { agents, defaultAgent }`, replaces the list, checked by `configSchema` and written to `config.json` by `Client.saveAgents`; the setup page sends it on each change, with no Save button, and shows the part only once someone has joined, since before that the join form chooses. A program typed in is labelled with its own name and gets the id `custom`, `custom-2` and so on; a row left empty is an empty argument. `player-two join --agent` takes a preset's id or, as before, a one-shot command line, which becomes the preset when its words are a preset's. `commandLineOf` in `src/core/wire.ts` shows an agent's words as one line, quoted so that `splitCommand` reads the same words back; nothing runs it. `ownMode` is not on the page: no task asks for it.
- **P3-A3: `atMost` is a test, and `think` reads.** `atMost(a, b)` says whether `a` allows no more than `b`, so a ceiling is checked as `atMost(asked, chosen)`; it does not return the lower of the two. The protocol reference's table has no column for `think`; it is allowed in every mode with reading and searching, since thinking touches nothing. `PermissionMode` is defined in `src/core/wire.ts` (see P3-A1) and exported from `permissions.ts` as the task says.
- **P3-B1: `ActivityItem` is defined ahead of P3-D1, and what the session passes for now.** `activityItemSchema` and `ActivityItem` are in `src/shared/ipc.ts` with exactly the fields P3-D1 lists, so the runners can emit items; P3-D1's box is left for whoever builds the feed to tick, with P3-D2's mapping. A runner does not know which run it is part of, so it leaves `run` as `""` for the session to fill in. `PermissionAsk`, which the plan does not spell out, is `{ action, title, detail }` in `src/desk/agents/runner.ts`. Until P3-C1 gives each run its own mode, the session runs every agent at `full`, which is what `job.accepted` records today, with handlers that drop activity and would refuse an ask, which `full` never makes. The session's `runner` option is still the function that starts a one-shot command, which `oneshotRunner` wraps, so the scenario tests drive one-shot runs as before. An agent spoken to over ACP is refused until P3-B3.
- **P3-B2: how the runner says so, which commands are Cursor's, and what changes for Cursor today.** An `AgentRunner` gains `cannotHonour(mode)`, the reason it cannot keep to a mode or `""`, so that P3-C2 can refuse a run before `job.accepted` is published; `run` at such a mode also rejects before anything starts. `restrictable` stays `false` for every one-shot command, Cursor's included: its exception is that `cannotHonour("read-only")` is `""`, which is what P3-E2's menu can read. Cursor's one-shot command is recognised by its words being exactly the preset's (`agent -p --output-format text`), so one with `--force` already among its arguments is a custom command and runs only at `full`. Copilot's and a custom command give the same reason, that the agent runs as a single command and cannot be limited. **Until P3-C1, every run is at `full`, so Cursor's one-shot command is now always given `--force` and may change files, where before it only proposed changes.** That is what the plan's table says `full` is, and what `job.accepted` has recorded all along; P3-C1 makes a teammate's request `read-only` by default.
- **P3-B3: what the runner does that the task leaves open.** `@agentclientprotocol/sdk` 1.8.0 is the new dependency, used through its `client()` app; the classes it marks deprecated are not used. The desk offers the agent no capabilities: the agent reads, writes and runs with its own tools, and asks first. The SDK checks what the agent sends against its own schemas but not what it answers the desk's requests, so the answers to `initialize`, `session/new` and `session/prompt` are parsed with zod for the parts used. Signing in happens only when `session/new` answers ACP's "authentication required" (-32000), with the agent's first method that it carries out itself; when it has none, or that fails, the problem names the command: for a method of type `terminal`, the agent's program with that method's arguments, otherwise `agent login` for Cursor and `copilot`, then `/login` in it, for Copilot, both from their documentation and not tried here (P3-F3). The MCP server is `{ name: "player-two", command: "player-two", args: ["mcp"] }`, found by name on the PATH the desk resolved at start-up, which the agent inherits: the same way the prompt's `player-two search` is found and P2-D5's snippets start it. A run over ACP is told to use the MCP server's tools in place of running `player-two search` and `read`, as P2-E1's comment asked; `signing-vectors.json` gains that prompt, written again with `node scripts/make-vectors.ts`, and the three before it are unchanged. A turn that stops for any reason but `end_turn` fails, naming the reason. Until P3-B4 every permission request is answered `cancelled`, which allows nothing; until P3-B5 a stop or the 900 seconds kills the process group at once. Tool calls become plain activity items, the agent's own title and how the call stands, for P3-D2 to replace. `test/fixtures/fake-acp-agent.ts` and `test/acp.test.ts` start here and grow with each task; P3-B7's box is ticked once they cover what it lists. Every ACP run is still at `full` (P3-B1).
- **P3-B4: which options match, and what an ask carries.** Allowing takes only an option of kind `allow_once`: `allow_always` would outlast the run inside the agent, and a session kept for a follow-up (P3-B6) would carry it into the next run, which the task forbids; the run's own "Allow for this run" is the desk's memory, answered `allow_once` each time. So an agent that offers only `allow_always` is refused. Refusing takes `reject_once`, else `reject_always`; an agent that offers neither is answered `cancelled`, which allows nothing. A request with no kind takes the kind its tool call was announced with, and failing that is `other`, as is ACP's `switch_mode`. A request outside a turn, and one still waiting when the run is stopped or the agent takes it back, is answered `cancelled`. An ask's `detail` is the change to each file the request carries, else its raw input as JSON, cut to 8,000 characters. Each request is reported as a `permission` activity item, running while the owner is asked and then `allowed`, `refused` or `cancelled`.
- **P3-B5: what a stop does before there is a session, and the time limit.** A stop while the agent is still being started, before `session/new` has answered, has no turn to cancel and kills the process group at once. The 900 seconds stop counting while any ask waits for the owner and start again from where they were once every ask is answered; when they run out the group is killed at once, without the grace a stop gets. `acpRunner` takes the limit as a second argument, 900 unless told, so that the test can use one second.
- **P3-B6: who decides what is a follow-up, and how long a runner lives.** The session names a run's key, the thread's root (the request itself when it is not a reply), its asker and the repo, and passes it with the request's own text as a `followUp` to `run`; the runner goes on in a session it kept under that key, in the same folder and with its agent still there, sending only that text, and otherwise starts afresh with the usual prompt. So a follow-up whose session has gone idle starts afresh, as does one whose earlier session is still at work. Only a run that answered keeps its session: a stopped, failed or timed-out one ends its agent. A fresh run under a key replaces what was kept under it. An `AgentRunner` gains `close()`, which ends everything kept; the one-shot runner keeps nothing. The session now keeps one runner for the agent that answers, made afresh, with the old one closed, when the default agent or its settings change, and closes it when the desk closes, before waiting for its runs, so that a run still going keeps nothing. The idle time is the second of `acpRunner`'s limits, for the test. Each run still starts at `full` (P3-B1), and a follow-up's mode is its own run's: what the owner allowed for one run is not carried into the next, since the agent is only ever told `allow_once` (P3-B4).
- **P3-B7: built with the tasks it tests, and what the fake does beyond the list.** The scripted agent and `test/acp.test.ts` were written with P3-B3 and grew with each task to P3-B6; this task's commit leaves the timings the tests rely on some room. Beyond the task's words, the fake answers `deaf` by ignoring a cancel, so that the kill two seconds after a stop is tested; `mcp` with the MCP servers its session was given; and every answer with the number of the turn in its session, which is how a test sees a follow-up go on in the same one. Each `edit` in a prompt asks once, so that "Allow for this run" can be seen to stop a second ask. Started with `--signed-out` it needs signing in and cannot be, and with `--always-only` it offers no option that allows just once. It writes its pid, and its child's, to `pids` in its folder, and every test checks that none is left once the run, the follow-up session or the desk has ended. One test runs it through a session against a real hub, where bob's agent is the fake: a reply in a thread from the same asker goes on in the same session, another asker or another thread starts one, and stopping the session ends every agent.
