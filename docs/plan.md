# Plan: one TypeScript codebase, and seven things borrowed from Buzz

Agreed on 2026-10-13. This is the order of work from where the repository stands today to a desktop app that does what the terminal interface does and then goes well past it. Each phase ends in something that runs and has a check that proves it.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Client | TypeScript only. The Python interface and `deskmate` command are deleted. | One implementation of the wire format instead of two that must move together. |
| Hub | Ported to Node and TypeScript. | It then shares its schemas and signing code with the client. It is about 300 lines, and phase 1 rewrites its core anyway. |
| Desktop app | Electron, React, shadcn/ui. | Already built and working without shadcn; the styling moves in phase 0. |
| Where it runs | On each person's cloud workstation, which runs Windows with the repos and the agent CLI inside WSL. | The window is a Windows app; everything that touches `~/dev` runs in WSL. No split between a laptop and a remote machine. |
| Windows and WSL | Two processes: the window, and a headless "desk" that holds the session. The window starts the desk with `wsl.exe` and they exchange JSON lines over standard input and output. | Scanning, cloning and running agents all happen in Linux, where the checkouts are, at native speed and with process groups that can be stopped. The window stays a real Windows app, with Windows notifications, a tray icon and start at login. No network port is opened. |
| Agents that outlive the machine | Not doing. | Workstations are cloud machines that are already always on. |
| Storage | One SQLite file on the hub, as now. | Right for a team. No Postgres, Redis or object store. |

What deskmate keeps as its own: an agent is a person's checkout of a repo, and nothing runs on a machine unless its owner said so. Every phase below must leave that true.

## Where the repository stands

- `src/deskmate`, `tests`: the Python hub, command and terminal interface, version 0.3.0. All of it goes in phase 0.
- `app/`: the Electron app, on the `electron-app` branch and not yet committed. `app/src/core` is the TypeScript client; `app/test/hub.test.ts` runs two sessions against the real hub through tag, approve, review, send, decline, stop and channels.
- That end-to-end test is the acceptance test for the hub port: it must pass unchanged against the Node hub.
- The session already runs without a window (`app/src/core/session.ts`), and what it exchanges with the window is already two schemas in `app/src/shared/ipc.ts`. The desk is that session behind a different pipe.
- Nothing has been run on Windows or in WSL yet. Everything so far was built and checked on macOS.

## Phase 0: one language

Goal: Python leaves the repository and nothing a user can do today is lost.

1. Commit the app on `electron-app` and merge it.
2. Port the hub to Node: the same routes, the same SQLite schema, `async` handlers in place of one thread per waiting client. Use Node's built-in `node:sqlite` if it is stable in the Node version we pin, otherwise `better-sqlite3`. Port the cases in `tests/test_hub.py`.
3. Rebuild the command line in TypeScript on `app/src/core`: `send`, `inbox`, `who`, `repos`, `channel`, `hub`. Every command takes `--json` and keeps the exit codes the README documents. Agents use `deskmate send --wait`, so this cannot be skipped.
4. Reshape the repository into one package with the hub, the desk, the command and the window as entry points of one build. Swap the Dockerfile and the Kubernetes manifest's image for the Node hub.
5. Split the desk from the window. The desk is a headless Node program that owns the identity, the session, the repo scan and the agent runs; it reads commands and writes views as JSON lines. The window starts it as a child process: directly on Linux and macOS, and through `wsl.exe` on Windows, in the default distribution unless a setting names another. Stopping the window stops the desk, and the desk stops its agents.
6. Move the window's styling to shadcn/ui: Vite and Tailwind replace the hand-written stylesheet; shadcn's Dialog, Command, ScrollArea, Tooltip and Sonner replace the native `<dialog>`, the tag list and the home-made toasts. The window keeps its content security policy; check that Radix's positioning works under it before relaxing anything.
7. Package two things. A Windows installer for the window. A WSL-side install, run from the hub's install line inside WSL, that puts the desk and the `deskmate` command there, where agents can call it. The identity in `~/.config/deskmate` lives in WSL only.
8. Keep the development loop inside WSL: `npm start` there runs the Linux build of the window under WSLg and starts the desk directly, so day-to-day work needs no Windows build.
9. Fix what the review found, while the hub is open:
   - `/info` reports a version, and clients ignore fields they do not know, so an update on one side stops breaking the other.
   - The auth header signs the method and path as well as the name and time.
   - Notes can be read one chat at a time, and backwards, so a busy channel no longer empties everyone's direct chats.
10. Delete `src/deskmate`, `tests`, `pyproject.toml`, `uv.lock` and the Python pre-commit hooks. Keep `python-vectors.json` as a frozen record of the signing format.

Done when: the two-session test passes against the Node hub, and the repository holds no Python. On a Windows workstation, the installed window starts its desk in WSL, shows the repos under WSL's `~/dev`, runs an agent there and stops it, and raises a Windows notification for a tagged note.

## Phase 1: one signed event log

Borrowed from Buzz: every action is a signed event with a kind, in one log.

1. Replace the note, whose kind is `note` or `status`, with an event: author, chat, kind, content, time, what it refers to, signature. Kinds are dotted names such as `message`, `message.edit`, `reaction`, `run.approved`, `channel.pin`. The signing stays Ed25519 over the same fixed-position JSON array.
2. The hub checks the envelope, the signature and membership, and nothing else. It stores and relays kinds it does not know, and clients skip them. Later phases then add kinds without breaking older clients.
3. Status notes with `working\nmain` in the body become `run.*` events with fields. An approval becomes a signed record: who let which agent run, for whom, in which repo, on which branch and commit.
4. The hub pushes events over one streaming response in place of long-polling, and chains each stored event to the hash of the one before it, so the log shows if it has been altered.
5. The chat state in `app/src/core/chat.ts` becomes a fold over events.
6. In the window: threads, reactions, editing and deleting your own messages, and a line when someone joins, leaves or pins a repo.

This phase starts a fresh database, as 0.2 and 0.3 did. It should be the last that has to.

Done when: the two-session test passes on events, and a client built before a new kind existed shows the rest of the chat without an error.

## Phase 2: search and a command built for agents

Borrowed from Buzz: answers with receipts, and a command an agent can script.

1. Full-text search on the hub with SQLite's FTS5, limited to chats the caller is in.
2. Cmd+K in the window; `deskmate search "…" --json` on the command line.
3. Links to a note, `deskmate://note/ID`, that the window opens and the command accepts.
4. `deskmate ask @bob/uploader "…"` waits for that agent's answer and nothing else.
5. The prompt tells an agent it may search the chat's history and should cite the notes it used.

Done when: an agent asked "have we seen this before?" answers with links to earlier notes that open in the window.

## Phase 3: agents over ACP, with a live activity feed

Borrowed from Buzz: the Agent Client Protocol in place of a command that prints once, and a feed that reads as verb, object, outcome.

1. Add a second way to run an agent beside the one-shot command: an ACP session over standard input and output. Claude Code, Codex and Goose speak it; an agent that does not keeps the one-shot path.
2. Show the owner what their agent is doing as it happens: one row per action that updates in place, failures loud and reads quiet, "waiting" and "timed out" shown rather than silence, raw detail one click away.
3. The feed stays on the owner's machine. Teammates see coarse `run.progress` events only, because what an agent reads on the way may not be fit to share.
4. A permission request from the agent becomes a card for the owner: allow once, allow for this run, or deny. For a run a teammate asked for, reading is allowed by default and writing or running commands asks first.
5. A follow-up in the same thread continues the same session rather than starting cold with six earlier notes pasted in.
6. Stop sends ACP's cancel and then kills the process group. The agent always runs in Linux, so this is the same on every machine.

Done when: a real run with Claude Code shows its steps as they happen, an attempted write in a teammate's request raises a card, and Stop ends it within a second.

## Phase 4: agent keys and standing grants

Borrowed from Buzz: an agent has its own key, and its owner signs what it may do. Needs phase 3, which is what makes "read-only" enforceable.

1. Each checkout's agent gets its own key. Its answers are signed with it, so "an agent wrote this" stops being the sender's own claim.
2. An owner signs a grant: which agent, who may ask, read-only or full, reviewed or posted directly, and when it expires. Expiry is required, with a ceiling of thirty days.
3. A request that matches a live grant runs without a click and says so: "ran under jacob's grant, until Friday". Revoking is one event and takes effect at once.
4. A "My agents" page: what I share, which grants are live, revoke, hold a repo back.
5. With a grant an agent can answer while the window is closed, so the window stays in the Windows tray with its desk running, and starts at login.

Done when: bob's request under a read-only grant is answered with nobody at jacob's keyboard, a write attempt in that run is refused, and a revoked grant stops the next request.

## Phase 5: jobs and gated delegation

Borrowed from Buzz: an explicit job lifecycle and delegation trees. Deskmate's addition is a person, or a grant, at every hop.

1. `job.*` events replace the informal run states: requested, accepted or declined, progress, then result, error or cancelled. The asker can withdraw a request.
2. An agent may tag another agent. That creates a child job that carries its chain: who asked first, and through which agents.
3. Every hop needs its own owner's approval or a matching grant. A chain has a depth limit and a fan-out limit, and a job that would revisit an agent already in its chain is refused.
4. The window shows the tree under the note that started it.

Done when: "does this API change break the client?" asked of one agent fans out to two teammates' checkouts, each approved by its owner, and comes back as one answer with the tree visible.

## Phase 6: branch rooms and patches

Borrowed from Buzz: the branch is the room, and a patch is a message. No git hosting: the team's existing forge stays.

1. A channel can be about a repo and a branch. Its header shows who is on that branch and whose copy has uncommitted changes.
2. An agent's answer can carry a patch. Asked to make a change, the agent works in a throwaway git worktree, so its owner's working tree is not touched.
3. The recipient sees the diff and can apply it to their own checkout after a dialog that names the branch and the files. It is checked with `git apply --check` first and never applied without that click. Git runs in the desk, so it is WSL's git and WSL's credentials.
4. Approve and request-changes are signed events in the same room.

Done when: jacob asks bob's agent for a change, bob approves the run, jacob reads the diff in the chat and applies it, and neither person left the window.

## Phase 7: workflows

Borrowed from Buzz: YAML automation triggered by messages, reactions, schedules and webhooks. Buzz's approval gates are not finished; here they are the existing approval queue.

1. Workflows live in a repo under `.deskmate/workflows/`, or on a channel.
2. Triggers: a message, a reaction, a schedule, a webhook with a secret.
3. Actions: post a message, tag an agent, ask a named person to approve, call a webhook.
4. The hub runs triggers and posts events under its own key. It never runs an agent: tagging one creates a job that waits for its owner or a grant, like any other.

Done when: a failing CI run posts to the branch's channel and tags the branch owner's agent, which runs after their thumbs-up and posts what broke.

## Not doing

- Remote agents and replaceable agent bodies.
- Git hosting, issues and a forge.
- Nostr compatibility, several teams on one hub, voice, pooled GPU compute, a mobile app.

## Open questions

1. Which Windows version and WSL distribution do the workstations have, and is Node already in WSL? If not, the WSL-side install has to bring its own.
2. Which agent CLIs does the team use day to day? Phase 3 depends on each one's ACP support.
3. Does the hub stay where it is deployed today? The Node image changes; the single replica and the disk-backed SQLite file do not.
