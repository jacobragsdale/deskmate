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
| Everyone on the hub (phase 4 on) | `*` | |

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
2. `sig` verifies against the author's key.
3. `ts` is within 300 seconds of the hub's clock, and `id` has not been seen.
4. The author may write to `to`: a channel they are in (or the event is `channel.join`), a person who has joined, or `*` for the kinds marked public below.

The hub stores and relays kinds it has never heard of. A client skips kinds it does not know and shows the rest. This is what lets later phases add kinds without breaking older clients.

The hub gives each stored event a sequence number, `seq`, and a chain value: `chain = sha256(previous chain + id)`, with 64 zeros before the first event. `seq` orders and pages; `id` is how events refer to each other.

## Kinds

`content` shapes are zod schemas in `src/core/kinds.ts`, one per kind. "Structural" kinds are the few the hub acts on as well as stores.

| Kind | Phase | `refs[0]` | `content` | Notes |
|---|---|---|---|---|
| `message` | 1 | thread root, if a reply | `{ text, via }` | `via` is `window`, `cli`, `mcp` or `workflow`. Tags are found in `text`. |
| `message.edit` | 1 | the message | `{ text }` | Counts only from the message's author. |
| `message.delete` | 1 | the message | `{}` | Counts only from the message's author. |
| `reaction` | 1 | the target | `{ emoji, on }` | `on: false` takes it back. |
| `channel.join` | 1 | | `{}` | Structural: adds the author to the channel in `to`. Creates the channel. |
| `channel.leave` | 1 | | `{}` | Structural. |
| `channel.pin` | 1 | | `{ repo, branch }` | Structural. `repo: null` unpins. `branch` from phase 6, `null` before. |
| `job.accepted` | 1 | the request | `{ repo, branch, commit, dirty, delivery, mode, by, delegate }` | The owner let it run. `delivery`: `review` or `post`. `mode`: a permission mode. `by`: `"owner"` or `{ grant: id }`. `delegate`, from phase 5: whether the agent may ask others. |
| `job.declined` | 1 | the request | `{ repo, reason }` | `reason` may be `""`. |
| `job.progress` | 3 | the request | `{ repo, summary }` | Coarse: no paths, no output. |
| `job.result` | 1 | the request | `{ repo, branch, text, reviewed }` | The answer. |
| `job.error` | 1 | the request | `{ repo }` | Only the fact. Why stays with the owner. |
| `job.cancelled` | 1 | the request | `{ repo }` | The owner stopped it. |
| `job.withdrawn` | 1 | the request | `{ agent }` | Counts only from the asker. |
| `agent.register` | 4 | | `{ repo, pubkey }` | Public. Structural: the hub learns the key for `author/repo`. |
| `grant` | 4 | | `{ agent, askers, mode, delivery, expires, runsPerDay }` | Public. |
| `grant.revoke` | 4 | the grant | `{}` | Public. Counts only from the grant's author. |
| `job.request` | 5 | the root request | `{ target, text, chain }` | Authored by an agent. `chain` lists the agents it came through. |
| `patch` | 6 | the request, if any | `{ repo, base, branch, title, diff }` | `repo` is a `RepoRef`. `base` is a commit. |
| `patch.applied` | 6 | the patch | `{ branch }` | |
| `review` | 6 | the patch | `{ verdict, text }` | `verdict`: `approve` or `changes`. |
| `workflow.define` | 7 | | `{ name, yaml }` | Structural: makes a workflow live for the channel in `to`. |
| `workflow.remove` | 7 | | `{ name }` | Structural. |
| `workflow.run` | 7 | the trigger | `{ workflow, step, status, detail }` | Authored by the hub's own identity, `hub`. |

### Jobs

A job is one agent asked to do one thing. Its identity is the request's event id plus the agent, `owner/repo`. The request is a `message` whose text tags the agent, or from phase 5 a `job.request`.

Only the agent's owner (from phase 4, or the agent itself) moves a job forward; the same event from anyone else is ignored. `src/core/chat.ts` folds a job's events into one state:

```text
waiting ──accepted──► working ──result──► answered
   │                     ├──error──► failed
   ├──declined──► declined  └──cancelled──► stopped
   └──withdrawn──► withdrawn
```

Two moves the diagram leaves out, which the window offered before events: the owner may accept a request again after declining it or after a run that failed or was stopped, and may decline one that is working, as when a draft is thrown away. `answered` and `withdrawn` are final.

`working` with no result for 960 seconds is shown as `waiting` again, as today. A tag counts only in a `message` a person authored, or from phase 7 one the hub authored for a workflow; a `job.result` that contains a tag starts nothing.

## The hub's API

JSON in and out. Errors are `{ "detail": "words for the user" }` with a 4xx status. The hub's responses may gain fields: clients parse them with schemas that ignore keys they do not know. Events themselves stay strict, because every field in them is signed.

### After phase 0

| Route | Auth | Does |
|---|---|---|
| `GET /healthz` | none | `{ ok: true, now }`. `now` is the hub's clock, for the setup check on a machine too far off for `/info` to accept its signature. |
| `GET /info` | yes | `{ version, protocol, repos, now }`. `now` is the hub's clock, for the setup check. Phase 7 adds `hubKey`. |
| `POST /join` | join token | Registers a name and key. `201`. `409` if another key holds the name. |
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
| `GET /events?chat=A&before=S&limit=N` | One chat's events, newest first, older than `seq` S, or the newest without `before`. `limit` up to 200, and 100 when it is not given. For a direct chat, `chat` is the other person; a channel's `#` is sent as `%23`. |
| `GET /events?after=S&limit=N` | Everything visible to the caller after `seq` S (0 when not given), oldest first. For catching up. `before` goes only with `chat`, and `after` only without it. |
| `GET /events?chat=A&around=S&limit=N` | Phase 2. A page centred on one event, for opening a search result. |
| `GET /events/{id}` | Phase 2. One event the caller can see, with its `seq`. |
| `GET /stream?after=S` | A `text/event-stream` that never ends: one `data:` line per event as `{ seq, event }`, and a comment line every 20 seconds so proxies keep it open. An event is sent when the caller can see it as the stream reaches it; one passed over is not sent later, when they can. |
| `GET /audit/head` | `{ seq, chain }` for the newest event; `{ seq: 0, chain }` with 64 zeros before the first. |
| `GET /search?q=Q&chat=A&limit=N` | Phase 2. Full-text search over messages and results in chats the caller can see. |
| `POST /hooks/{id}` | Phase 7. A workflow's webhook. |

What a caller can see: events to them, events they wrote, events in channels they are in, and events to `*`.

## The desk's protocol

The window starts the desk and they exchange one JSON object per line: the window writes to the desk's standard input and reads its standard output. The desk logs to standard error only. Both sides parse every line with the schemas in `src/shared/ipc.ts`.

From the desk:

| Line | When |
|---|---|
| `{ "t": "hello", "version", "protocol" }` | First, once. The window refuses a protocol it does not know and says which side to update. |
| `{ "t": "view", "view" }` | Whenever what should be drawn has changed. The whole view each time. |
| `{ "t": "notice", "notice" }` | Something to tell the user that is not part of the picture. |
| `{ "t": "arrival", "arrival" }` | A message, an answer or a draft worth a system notification. |
| `{ "t": "ask", "id", "question" }` | The desk needs a yes or no from the user: a clone, applying a patch. The window shows a native dialog. `question` is `{ message, detail, confirm }` in the desk's words; `confirm` is what the button that says yes reads. |
| `{ "t": "reply", "id", "outcome" }` | The answer to a command. `outcome` is `{ ok: true }` or `{ ok: false, problem }`, and may carry `data`. |

From the window:

| Line | When |
|---|---|
| `{ "t": "command", "id", "command" }` | The user did something. Every command gets exactly one reply. |
| `{ "t": "answer", "id", "ok" }` | The answer to an `ask`. |
| `{ "t": "attend", "attentive" }` | The window gained or lost focus. |

Closing the desk's standard input means quit: the desk stops its agents, tells the chat, and exits within three seconds. If it has not, the window kills it.

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

`src/desk/permissions.ts` holds the table as one pure function from mode and kind of action to `allow`, `ask` or `refuse`.

## Files on disk

Inside WSL (or the home folder on Linux and macOS):

| Path | Holds |
|---|---|
| `~/.config/player-two/config.json` | Hub address, name, agents. |
| `~/.config/player-two/key` | The person's private key. Mode `0600`. |
| `~/.config/player-two/known.json` | The key first seen for each teammate and agent. |
| `~/.config/player-two/app-state.json` | Read marks, last open chat. Safe to delete. |
| `~/.config/player-two/agents/<repo>.key` | Phase 4. One key per checkout's agent. Mode `0600`. |
| `~/.config/player-two/azure.json` | Phase 6. An Azure DevOps token, if one was saved. Mode `0600`. |
| `~/.player-two/runtime/sha256-<digest>/` | The Linux runtime the window unpacked. `~/.player-two/current` links to the one in use, and `~/.player-two/previous` to the one before it; any other is removed. |
| `~/.player-two/worktrees/` | Phase 6. Throwaway git worktrees for runs that change files. |

`PLAYER_TWO_HOME` moves `~/.config/player-two`; `PLAYER_TWO_DEV` moves `~/dev`. On Windows the window keeps one file of its own, `settings.json` in Electron's user-data folder, with the name of the WSL distribution.

## Versions

| Version | Protocol | What changed |
|---|---|---|
| 0.3 | | Python hub and client. Today. |
| 0.4 | 1 | Phase 0. Auth header version 2. `/info` reports version and protocol. |
| 0.5 | 2 | Phase 1. Events replace notes. Fresh database. |

From 0.5 on, a new kind is not a protocol change. The hub refuses to start on a database made by another schema version, as it does today.
