# Protocol reference

The project is called deskmate in the code until task P0-E4 of phase 0 renames it to Player Two. This file uses the new name.

What the pieces say to each other. The phase files say when each part is built; this file says what it is. Where this file and the code disagree after a phase is done, fix whichever is wrong in the same commit.

## The pieces

```text
Windows                                   WSL (Ubuntu)                         AKS
┌──────────────────────┐  JSON lines   ┌───────────────────────────┐  HTTPS  ┌──────────┐
│ window               │◄─────────────►│ desk                      │◄───────►│ hub      │
│ Electron + React     │  over stdio   │ identity, session, repos, │         │ Node +   │
│ draws, notifies      │  (wsl.exe)    │ agents, git               │         │ SQLite   │
└──────────────────────┘               └───────────┬───────────────┘         └──────────┘
                                                   │ stdio (ACP or one-shot)        ▲
                                         ┌─────────▼─────────┐   `player-two` command │
                                         │ agent CLI         │──────────────────────┘
                                         │ Cursor / Copilot  │   and `player-two mcp`
                                         └───────────────────┘
```

On Linux and macOS the window starts the desk directly instead of through `wsl.exe`. Everything else is the same.

## Names and addresses

| Thing | Form | Example |
|---|---|---|
| Person | `[a-z0-9][a-z0-9_-]{0,31}` | `jacob` |
| Channel | `#` and a name | `#backend` |
| Repo name | `[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?` | `acme.billing.api` |
| Agent | person, `/`, repo name | `jacob/uploader` |
| A workflow, as a grant names it (phase 7 on) | `workflow:` and a name like a person's | `workflow:ci-failure` |
| Everyone on the hub (phase 4 on) | `*` | |
| The hub itself (phase 7 on) | `hub`, which nobody may join under | |

These patterns live in `src/core/wire.ts` and nowhere else.

## Signing

Ed25519, raw 32-byte keys in lowercase hex. Everything signed is the UTF-8 bytes of `JSON.stringify` of an array of fixed positions, so there is exactly one encoding. `test/fixtures/signing-vectors.json` pins the bytes; a change to what is signed must change that file in the same commit.

### Auth header

Proves who is asking. Sent on every request except `POST /join`, `GET /healthz` and the download routes.

```text
Authorization: PlayerTwo <name>:<ts>:<sig>
```

| Version | Signed text | From |
|---|---|---|
| 1 | `deskmate-auth-v1:<name>:<ts>` | today, with the scheme `Deskmate` |
| 2 | `player-two-auth-v2:<name>:<ts>:<METHOD>:<path and query exactly as sent>` | phase 0 |

`ts` is Unix seconds and must be within 300 seconds of the hub's clock. Version 2 stops a captured header being replayed against another route. The ingress must not rewrite paths.

`<name>` is a person, or from phase 4 one of their agents, `owner/repo`, signing with its own registered key; nothing else is read as a header. The hub answers an agent's request as it answers its owner's, so its reads see what the owner sees, except that an agent cannot replace the repos its owner shares (`PUT /repos` is `403`), and its requests do not count as its owner being here.

### Notes (until phase 1)

What 0.4 signed for a note: `["player-two-note-v3", sender, to, kind, body, ts, agent, re]`, `deskmate-note-v3` before task P0-E4 renamed it. Phase 1 removed notes, and nothing signs or checks one now.

### Events (phase 1 on)

```ts
interface Event {
  id: string; // 64 hex: sha256 of the signed bytes
  author: string; // a person; from phase 4 also an agent
  to: string; // a person, a channel, or "*"
  kind: string; // dotted lowercase words: ^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$, at most 64 characters
  content: string; // JSON text of an object; its shape depends on the kind
  ts: number; // Unix seconds
  refs: string[]; // ids of the events this one is about; at most 8; the first is the main one
  nonce: string; // 16 hex, random, so two identical messages in one second are two events
  sig: string; // 128 hex
}
```

Signed bytes: `JSON.stringify(["player-two-event-v1", author, to, kind, content, ts, refs, nonce])`.

`content` travels as a string so nobody has to agree on a canonical form for objects. It is at most 64,000 characters, except for `patch`, which may be 512,000.

The hub accepts an event when all of these hold, and checks nothing else about it:

1. It matches the envelope schema, and `id` is the hash of its signed bytes.
2. `sig` verifies against the author's key: a person's, from joining; from phase 4 an agent's, `owner/repo`, from its owner's newest `agent.register`. Nothing posted is accepted as the hub's own, `hub`, from phase 7, whatever key signed it: the hub stores the events it signs itself.
3. `ts` is within 300 seconds of the hub's clock, and `id` has not been seen.
4. The author may write to `to`: a channel they are in (or the event is `channel.join`), a person who has joined, or `*` for the kinds marked public below. An agent may write only `job.progress`, `job.result`, `job.error` and `job.cancelled`, and from phase 6 `patch`, only about its own repo, and from phase 5 `job.request`, only as the last agent in its `chain`, and `job.withdrawn`, which counts only from whoever asked, and only where its owner may: anything else from one is refused with words saying agents cannot send it, content its kind does not hold with `422`, and a report whose `repo` is not the agent's own, a `patch` whose `repo.key` is not the one its owner shares under that name (`PUT /repos`), a `job.request` whose `chain` does not end with it, or a `job.result` saying `reviewed: true`, with `403`.

The hub stores and relays kinds it has never heard of. A client skips kinds it does not know and shows the rest. This is what lets later phases add kinds without breaking older clients.

The hub gives each stored event a sequence number, `seq`, and a chain value: `chain = sha256(previous chain + id)`, with 64 zeros before the first event. `seq` orders and pages; `id` is how events refer to each other.

## Kinds

`content` shapes are zod schemas in `src/core/kinds.ts`, one per kind. "Structural" kinds are the few the hub acts on as well as stores.

| Kind | Phase | `refs[0]` | `content` | Notes |
|---|---|---|---|---|
| `message` | 1 | thread root, if a reply | `{ text, via, workflow }` | `via` is `window`, `cli`, `mcp` or `workflow`. Tags are found in `text`. `workflow`, from phase 7, is in a message the hub posts for a workflow, and names it. |
| `message.edit` | 1 | the message | `{ text }` | Counts only from the message's author. |
| `message.delete` | 1 | the message | `{}` | Counts only from the message's author. |
| `reaction` | 1 | the target | `{ emoji, on }` | `on: false` takes it back. |
| `channel.join` | 1 | | `{}` | Structural: adds the author to the channel in `to`. Creates the channel. |
| `channel.leave` | 1 | | `{}` | Structural. |
| `channel.pin` | 1 | | `{ repo, branch }` | Structural. `repo: null` unpins. `branch` from phase 6, `null` before: a name `git check-ref-format --branch` takes, other than `@`, with no control, formatting character or line separator (`branchNameSchema` in `src/core/wire.ts`). |
| `job.accepted` | 1 | the request | `{ repo, branch, commit, dirty, delivery, mode, by, delegate }` | The owner let it run. `delivery`: `review` or `post`. `mode`: a permission mode. `by`: `"owner"` or `{ grant: id }`. `delegate`, from phase 5: whether the agent may ask other agents in this run; `false` when absent, as in every acceptance from before it. |
| `job.declined` | 1 | the request | `{ repo, reason }` | `reason` may be `""`. |
| `job.progress` | 3 | the request | `{ repo, summary }` | Coarse: no paths, no output. From the owner, or from phase 4 the agent, while the job is working, it is also word that the run goes on (see Jobs). The owner's desk sends it, signed by the agent from phase 4, when the summary changes, at most every ten seconds, and again unchanged every five minutes while the run goes on. |
| `job.result` | 1 | the request | `{ repo, branch, text, reviewed }` | The answer. From phase 4, signed by the agent when it is posted with nobody reviewing it (`reviewed: false`), and by its owner when they reviewed and sent it. One an agent signs saying `reviewed: true` is refused, and counts for nothing. A reader shows it as not reviewed by who signed it, never by `reviewed`. A desk does not post one unreviewed that holds a private key of its user's or their agents', as the key file has it, in hex of either case, base64 or base64url, whitespace aside: it keeps it as a draft, and says why. |
| `job.error` | 1 | the request | `{ repo }` | Only the fact. Why stays with the owner. Signed by the agent from phase 4. |
| `job.cancelled` | 1 | the request | `{ repo }` | The owner stopped it. Signed by the agent from phase 4, as the run's own report. |
| `job.withdrawn` | 1 | the request | `{ agent }` | Counts only from the asker: from phase 5, for an agent's request of another, the agent that asked, whose desk sends it once its run ends. |
| `agent.register` | 4 | | `{ repo, pubkey }` | Public, and sent to `*` only. Structural: the hub learns the key for `author/repo`, the newest registration winning. |
| `grant` | 4 | | `{ agent, askers, mode, delivery, expires, runsPerDay }` | Public. `agent` is one of the author's. `askers`: names, or `"*"` for anyone on the hub, or from phase 7 a workflow, `workflow:<name>`, which `"*"` does not cover. `mode`: a permission mode. `delivery`: `review` or `post`. `expires`: Unix seconds, at most 30 days after the event's own `ts`, or the event is not read as a grant. `runsPerDay`: 1 to 1000. Only a grant sent to `*` counts. The owner's desk lets a teammate's request go under one only as the request arrives on its stream, waiting and signed no more than 600 seconds (twice the clock skew the hub allows) before the desk's own clock; any other waits for the owner's click. From phase 5, an agent's `job.request` of the owner's agent goes under one only when its `askers` name everyone it runs on the say of, whoever asked first and the owner of each agent in its `chain`, the grant's own author aside, and when not all of those are the owner; it then runs at no more than its chain allows, and never asks other agents. |
| `grant.revoke` | 4 | the grant | `{}` | Public. Counts only from the grant's author. |
| `job.request` | 5 | the root request | `{ target, text, chain }` | Authored by the asking agent, the last in `chain`. `refs[1]` is the request the asker is working on: the root again when the asker is the root's agent. `target`: the agent asked. `chain`: the agents it came through, from the root's down to the asker, at least one. |
| `patch` | 6 | the request, if any | `{ repo, base, branch, title, diff }` | `repo` is a `RepoRef`, whose `name` is the last part of its `key`, or the patch is read as nothing. `base` is a commit, `branch` the one it was made on, `title` 1 to 200 characters (its desk takes the answer's first line, cut to 80), `diff` what `git diff --cached --binary` wrote from `base`. What a run on a clean copy changed, sent just before its answer and signed as the answer is: by the agent when nobody reviewed it, by its owner when they reviewed and sent it. From an agent, only about its own repo: `repo.name`, and at the hub `repo.key` the one its owner shares under that name. A desk applies it only to a checkout of that very name and key. Shown where an answer is, its title its text. |
| `patch.applied` | 6 | the patch | `{ branch }` | Its author applied the patch to their checkout, on `branch`. A person's alone: agents cannot send it. |
| `review` | 6 | the patch | `{ verdict, text }` | `verdict`: `approve` or `changes`. `text`: a comment, `""` for none. A person's alone: agents cannot send it. Every one is shown, in order, as who said what. |
| `workflow.define` | 7 | | `{ name, yaml }` | Structural: makes a workflow live for the channel in `to`, in place of any of the same name. `name` is a name like a person's, and must be the one `yaml`, the workflow's file, gives. |
| `workflow.remove` | 7 | | `{ name }` | Structural: takes the channel's workflow of that name away. |
| `workflow.run` | 7 | the trigger | `{ workflow, step, status, detail }` | Authored by the hub's own identity, `hub`, and counts from nobody else. `step` counts from 0. `status`: `done`, `skipped` (its `if` did not hold), `waiting` (on an approval), `approved`, `expired`, `refused`, `failed` or `throttled`. `detail` says why, or is `""`. |

### Jobs

A job is one agent asked to do one thing. Its identity is the request's event id plus the agent, `owner/repo`. The request is a `message` whose text tags the agent, or from phase 5 a `job.request`.

Only the agent's owner (from phase 4, or the agent itself, with a report of its own run about its own repo, which counts exactly as its owner's would) moves a job forward; the same event from anyone else is ignored, and anything else from an agent counts for nothing, there and everywhere else a client shows an event (search, notifications, the command, the MCP server), all of which ask `mayCome` in `src/core/chat.ts`. That file folds a job's events into one state:

```text
waiting ──accepted──► working ──result──► answered
   │                     ├──error──► failed
   ├──declined──► declined  └──cancelled──► stopped
   └──withdrawn──► withdrawn
```

Moves the diagram leaves out, which the window offered before events: the owner may accept a request again after declining it, after a run that failed or was stopped, or while it is still `working`, as when a run never ended because its desk went (the later acceptance replaces the earlier one, branch, commit and all); and may decline one that is working, as when a draft is thrown away. Whoever asked may withdraw one that has been `working` with no word from its owner, neither the acceptance nor a `job.progress`, for more than 960 seconds by the withdrawal's own `ts`, since it is shown as `waiting` by then. `answered` and `withdrawn` are final. From phase 5, whoever asked may also withdraw a job working with `delegate` on, which the fold leaves working: its owner's desk stops the run, which then ends as stopped. A run let ask others takes back, as its agent, every job it asked that is still waiting or working, once it ends however it ended; and a desk stops its run of an agent's request once the agent that asked takes it back, or the log no longer lets it go, as when a job above it has ended. Nothing under a root goes on once 60 minutes (`ROOT_TIME`) have passed since its agent was last accepted: a request sent later is refused by the log, and every desk in the tree, the root's and each one below it, stops its run and starts none once that time has passed by its own clock, whether or not the others are still there.

`working` with no result, and no `job.progress` from its owner, for 960 seconds is shown as `waiting` again, as today. A run waiting on its owner's answer to a permission card can go on for longer than that, since the wait does not count towards its 900 seconds, which is why its desk says what it is doing again every five minutes. A tag counts only in a `message` a person authored, or from phase 7 one the hub authored for a workflow, with `via: "workflow"` and the workflow's name in `workflow`; a `job.result` that contains a tag starts nothing. Such a request asks as `workflow:<name>`, for grants and for who an agent's request of another runs on the say of. Of what the hub signs, nothing but a `message` and a `workflow.run` counts.

## The hub's API

JSON in and out. Errors are `{ "detail": "words for the user" }` with a 4xx status. The hub's responses may gain fields: clients parse them with schemas that ignore keys they do not know. Events themselves stay strict, because every field in them is signed.

### After phase 0

| Route | Auth | Does |
|---|---|---|
| `GET /healthz` | none | `{ ok: true, now }`. `now` is the hub's clock, for the setup check on a machine too far off for `/info` to accept its signature. |
| `GET /info` | yes | `{ version, protocol, repos, now, hubKey }`. `now` is the hub's clock, for the setup check. `hubKey`, from phase 7, is the public half of the key the hub signs its own events with, made when it first starts and kept in its database; a hub before phase 7 does not send it. |
| `POST /join` | join token | Registers a name and key. `201`. `409` if another key holds the name, and for `hub`, the hub's own name. |
| `GET /users` | yes | Everyone, with key and last-seen time. |
| `PUT /repos`, `GET /repos` | yes | Replace my advertised checkouts; list everyone's. |
| `GET /channels` | yes | Channels with members, pinned repo, and (phase 1 on) the branch the pin names, `null` until phase 6. |
| `POST /channels/{name}/join`, `/leave`; `PUT`, `DELETE /channels/{name}/repo` | yes | As today. Removed in phase 1. |
| `POST /notes`, `GET /notes` | signed note; yes | As today. Removed in phase 1. |
| `GET /`, `GET /downloads/{file}`, `GET /install.sh` | none | A page with the install steps, the installers, and a script that installs the Linux runtime. |

### After phase 1

The `/notes` routes and the four channel-changing routes go. In their place:

| Route | Does |
|---|---|
| `POST /events` | Accepts one signed event. `201 { seq }`. `409` when the id was already stored. |
| `GET /events?chat=A&before=S&limit=N` | One chat's events, newest first, older than `seq` S, or the newest without `before`. `limit` up to 200, and 100 when it is not given. For a direct chat, `chat` is the other person; a channel's `#` is sent as `%23`. From phase 4, `chat=*` is the events to everyone: agents' registrations and grants. |
| `GET /events?after=S&limit=N` | Everything visible to the caller after `seq` S (0 when not given), oldest first. For catching up. `before` and `around` go only with `chat`, and not together, and `after` only without it. |
| `GET /events?chat=A&around=S&limit=N` | Phase 2. A page centred on `seq` S, for opening a search result: up to half of N from before S, and the rest from S on, oldest first. `limit` as for `before`. |
| `GET /events/{id}` | Phase 2. `{ seq, event }` for one event the caller can see. `404` when there is none they can see, whether or not it exists. |
| `GET /stream?after=S` | A `text/event-stream` that never ends: one `data:` line per event as `{ seq, event }`, and a comment line every 20 seconds so proxies keep it open. An event is sent when the caller can see it as the stream reaches it; one passed over is not sent later, when they can. |
| `GET /audit/head` | `{ seq, chain }` for the newest event; `{ seq: 0, chain }` with 64 zeros before the first. |
| `GET /search?q=Q&chat=A&limit=N` | Phase 2. Full-text search over messages and results in chats the caller can see, as last edited, in chat `A` when it is given: `[{ seq, event, snippet }]`, best match first, `limit` up to 50 and 20 when it is not given. A result holds every word of `Q`, each matched as a word and never as query syntax. A word is a run of letters and digits, everything else separating words as it separates the index's tokens; `Q` is at most 200 characters and holds 1 to 8 words, and anything else is `422 invalid q: a search holds 1 to 8 words, in at most 200 characters`. `snippet` is a stretch of the text with each word found between the characters U+0002 and U+0003, which the hub keeps out of what it indexes; the client replaces them. |
| `POST /hooks/{id}` | Phase 7. A workflow's webhook. |

What a caller can see: events to them, events they or their agents wrote, events in channels they are in, and events to `*`. A direct chat holds the events between its two people, either of them or their agents writing.

## The desk's protocol

The window starts the desk and they exchange one JSON object per line: the window writes to the desk's standard input and reads its standard output. The desk logs to standard error only. Both sides parse every line with the schemas in `src/shared/ipc.ts`.

From the desk:

| Line | When |
|---|---|
| `{ "t": "hello", "version", "protocol" }` | First, once. The window refuses a protocol it does not know and says which side to update. |
| `{ "t": "view", "view" }` | Whenever what should be drawn has changed. The whole view each time. |
| `{ "t": "notice", "notice" }` | Something to tell the user that is not part of the picture. |
| `{ "t": "arrival", "arrival" }` | A message, an answer or a draft worth a system notification. |
| `{ "t": "ask", "id", "question" }` | The desk needs a yes or no from the user: a clone, applying a patch, pushing a branch before a pull request is opened from it. The window shows a native dialog. `question` is `{ message, detail, confirm }` in the desk's words; `confirm` is what the button that says yes reads. |
| `{ "t": "reply", "id", "outcome" }` | The answer to a command. `outcome` is `{ ok: true }` or `{ ok: false, problem }`, and may carry `data`. |

From the window:

| Line | When |
|---|---|
| `{ "t": "command", "id", "command" }` | The user did something. Every command gets exactly one reply. |
| `{ "t": "answer", "id", "ok" }` | The answer to an `ask`. |
| `{ "t": "attend", "attentive" }` | The window gained or lost focus. |

Closing the desk's standard input means quit: the desk stops its agents, declines every draft not sent (as throwing one away does), tells the chat, and exits within three seconds. If it has not, the window kills it.

The desk never opens a network port.

## Permission modes

What an agent may do without asking. Named after T3 Code's, plus `read-only`.

| Mode | Reading and searching | Editing files | Running commands, fetching, anything else |
|---|---|---|---|
| `read-only` | allowed | refused | refused |
| `supervised` | allowed | asks | asks |
| `auto-edits` | allowed | allowed | asks |
| `full` | allowed | allowed | allowed |

Rules:

1. A run started for someone else never exceeds the mode its owner chose when they accepted it. The mode is written in `job.accepted`.
2. A grant names a mode. A delegated job's mode is at most its parent's.
3. The order is `read-only` < `supervised` < `auto-edits` < `full`.
4. Enforcement is the desk answering the agent's permission requests over ACP. An agent that never asks cannot be held to a mode. The setup check tests each configured agent for this, and an agent that fails it, or runs as a one-shot command, is labelled "cannot be restricted" wherever a mode is chosen.
5. Below `full`, a run changes files only in the folder it runs in: an edit, deletion or move is allowed or asked about only when the request names at least one file and every file it names, with links followed, is inside that folder and in no `.git` folder there, whatever its case. Any other is refused without asking, as is the agent switching its own mode: an "Allow" would lift the run above its mode.
6. With nobody watching, an agent over ACP is not taken at its word: a grant below `full` lets it run only once it has passed that test, and, when the test recorded a version, only while the agent says it is that version as the run is let go. Otherwise the request waits for its owner, who is told to test it. A run its owner starts by hand is theirs to watch, and the window says the agent is untested.

`src/desk/permissions.ts` holds the table as one pure function from mode and kind of action to `allow`, `ask` or `refuse`.

## Files on disk

Inside WSL (or the home folder on Linux and macOS):

| Path | Holds |
|---|---|
| `~/.config/player-two/config.json` | Hub address, name, agents, and from phase 4 the repos held back. |
| `~/.config/player-two/key` | The person's private key. Mode `0600`. |
| `~/.config/player-two/known.json` | The key first seen for each teammate, and the user's own, written when they join; from phase 7 also the hub's own, under `hub`, as `/info`'s `hubKey` gave it when an event the hub signed was first checked, never from anyone `/users` lists by that name. The hub's events are checked against it, as a teammate's are against theirs. The user's own events, their agents' registrations among them, are checked against the key in `key`, never one the hub lists; a hub that lists another for them is not believed, and the desk tells them so. An agent's key is not kept here: it is learned from its owner's registrations, which that pinned key vouches for, each time a client starts. |
| `~/.config/player-two/app-state.json` | Read marks, last open chat, and the mode and delivery each asker's requests of each repo were last run at, with the agent that ran them (phase 3), and the branch rooms the user said not to suggest (phase 6). Safe to delete. |
| `~/.config/player-two/agent-permissions.json` | Phase 3. How each agent over ACP did in the permission test, by its command line, with its version. Deleting it makes every agent untested again, which holds back every grant below `full` (see Permission modes). |
| `~/.config/player-two/agents/<repo>.key` | Phase 4. One key per checkout's agent. Mode `0600`, in a folder of mode `0700`: a key whose file or folder other users can get at is refused, and not made private behind its owner's back. Replacing the file rotates the key: the desk registers the new one on its next beat, or before its next run if that is sooner. |
| `~/.config/player-two/azure.json` | Phase 6. An Azure DevOps token, if one was saved. Mode `0600`. |
| `~/.player-two/runtime/sha256-<digest>/` | The Linux runtime the window unpacked. `~/.player-two/current` links to the one in use, and `~/.player-two/previous` to the one before it; any other is removed. |
| `~/.player-two/worktrees/` | Phase 6. Throwaway git worktrees for runs that change files. |

`PLAYER_TWO_HOME` moves `~/.config/player-two`; `PLAYER_TWO_DEV` moves `~/dev`. From phase 4, during a run the agent's process, and the MCP server it is given over ACP, also get `PLAYER_TWO_AGENT`, its name as `owner/repo`, and `PLAYER_TWO_AGENT_KEY_FILE`, the path of its key: with both set, the `player-two` command and `player-two mcp` sign as that agent, and read as its owner. A run its owner let ask other agents, `delegate` in its acceptance, is given that MCP server started with `--job` and the id of the request it was asked: it then also offers `ask_agent`, which sends a `job.request` under that request, and no other sending tool. Such a run alone is also told that id, `PLAYER_TWO_JOB`, and `player-two mcp --job` refuses to start, as `ask_agent` refuses to ask, unless `--job` names the request `PLAYER_TWO_JOB` does: so no other run of the same agent, one under a grant, one its owner let go without asking others, or a one-shot command, can ask under that request, and with it leave whoever asked it out of the people the request runs on the say of. With `PLAYER_TWO_ONLY_CHAT` set, `PLAYER_TWO_JOB` counts for nothing. A run under a grant gets both, so what it sends through the command is the agent's (and a message is refused), and also `PLAYER_TWO_ONLY_CHAT`, the chat its request is in: with it set, the command and `player-two mcp` read that chat, and the events to everyone, and nothing of any other (a search looks in that chat alone, a note in another is one the agent cannot see, and pages, catching up and the stream pass over the rest). It gets no MCP server, never asks other agents, its prompt says nothing of looking at earlier notes, and it never goes on in a session a run its owner let go left open: nothing on the honest path hands whoever asked what the owner's other chats hold. It runs as the owner's user all the same, which is the honest edge: it could read any chat, or the owner's key, if it went looking, and with the agent's key sign a request under another run of it. The window keeps one file of its own, `settings.json` in Electron's user-data folder, with the name of the WSL distribution on Windows, and from phase 4 whether it starts at login and whether it has said, once, that closing it hid it to the tray.

## Versions

| Version | Protocol | What changed |
|---|---|---|
| 0.3 | | Python hub and client. Today. |
| 0.4 | 1 | Phase 0. Auth header version 2. `/info` reports version and protocol. |
| 0.5 | 2 | Phase 1. Events replace notes. Fresh database. |
| 0.6 | 3 | Phase 4. An event's author may be an agent, `owner/repo`, which a client of protocol 2 cannot read. Schema 7. |

From 0.6 the `player-two` command and `player-two mcp` ask `/info` for the hub's protocol before their first request, and while it is another than theirs fail that request with `this hub speaks protocol N; this command speaks protocol M: update` and which side; the window's desk has done the same since 0.4. From 0.5 on, a new kind is not a protocol change, and neither was phase 6's branch on `channel.pin`: a reader before it reads a pin that names a branch as content it does not know and draws no line for it, while `GET /channels` has reported a pin's branch since phase 1; a hub before it refuses such a pin with `422`. The hub refuses to start on a database made by another schema version, except 0.5's (schema 5), phase 2's (schema 6) and phase 4's (schema 7): to 5 it adds the search index of phase 2, filled from the events it holds; to 5 and 6 the agents table of phase 4 (schema 7), empty; and to all three the `meta` table of phase 7 (schema 8), in which it then makes its own key. It refuses one of those in which someone joined as `hub`, since that is now the hub's own name.
