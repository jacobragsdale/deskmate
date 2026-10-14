# Phase 1: one signed event log

Goal: everything that happens is one kind of thing, a signed event with a kind. Notes and status notes go. Approvals become signed records. Later phases add kinds, never a new mechanism.

Depends on: phase 0. Read the "Events", "Kinds", "Jobs" and "After phase 1" parts of [`protocol.md`](protocol.md) first; they are the specification for this phase.

Borrowed from Buzz, which models every action as a signed event in one log.

## What changes

| Today | After |
|---|---|
| A note has a kind of `note` or `status`, an `agent` mark and an `re`. | An event has a `kind`, a `content` string and `refs`. |
| What an agent is doing with a request is a status note whose body is `working\nmain ±`. | `job.*` events with fields. |
| Approving is a click that leaves no record of its own. | `job.accepted` records who allowed which agent to run, for whom, on which branch and commit. |
| Joining, leaving and pinning are calls that change hub tables. | `channel.*` events the hub applies and everyone can see. |
| The hub hands out a note's id, so the sender learns it after sending. | The id is the hash of the signed bytes, known before sending. |
| The client holds a long-poll open. | The hub streams events on one response that stays open. |
| Start-up loads the newest 300 notes across every chat. | Each chat loads its own newest page, and older pages on demand. |

This phase starts a fresh database. Version `0.5.0`, protocol `2`.

## A. The envelope and the kinds

- [ ] **P1-A1** `src/core/wire.ts`: `eventSchema`, strict, with the fields and limits in the protocol reference. Remove `noteSchema`, `deliveredSchema` for notes, and `kindSchema`. `deliveredSchema` becomes `{ seq, event }`.
- [ ] **P1-A2** `src/core/sign.ts`: `eventBytes(fields)`, `signEvent(key, fields)` which fills `nonce`, `id` and `sig` and returns a parsed event, `eventIsAuthentic(event, pubkey)` which checks both the id and the signature. Remove the note functions.
- [ ] **P1-A3** `src/core/kinds.ts`: one zod schema per kind in the table for phase 1 (`message`, `message.edit`, `message.delete`, `reaction`, `channel.join`, `channel.leave`, `channel.pin`, `job.accepted`, `job.declined`, `job.result`, `job.error`, `job.cancelled`, `job.withdrawn`), and `readContent(event)` returning a tagged union of the parsed content, or `{ kind: "unknown" }` for a kind it does not know or content that does not parse. `job.accepted.mode` is `"full"` until phase 3 gives it meaning; `channel.pin.branch` is `null` until phase 6.
- [ ] **P1-A4** Regenerate `test/fixtures/signing-vectors.json` from the TypeScript implementation with a small script, `scripts/make-vectors.ts`, covering the awkward text the current vectors cover (quotes, control characters, non-ASCII, line separators). `test/vectors.test.ts` checks the implementation still produces the committed file exactly.

## B. The hub

- [ ] **P1-B1** Schema version 5 in `src/hub/db.ts`. Drop `notes`. Add:

  ```sql
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    author TEXT NOT NULL,
    recipient TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    ts INTEGER NOT NULL,
    refs TEXT NOT NULL,      -- JSON array
    nonce TEXT NOT NULL,
    sig TEXT NOT NULL,
    chain TEXT NOT NULL
  );
  CREATE INDEX events_by_recipient ON events (recipient, seq);
  CREATE INDEX events_by_author ON events (author, seq);
  CREATE TABLE event_refs (ref TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (ref, seq));
  ```

  `members` and `pins` stay; `pins` gains a nullable `branch`.
- [ ] **P1-B2** `POST /events`: the four checks in the protocol reference, in that order, each with its own `detail`. Insert, compute `chain`, write `event_refs`, and apply a structural kind, all in one transaction. Answer `201 { seq }`; `409` for an id already stored.
- [ ] **P1-B3** Structural kinds: `channel.join` and `channel.leave` change `members`; `channel.pin` checks the author is a member and the repo is under the hub's address, then writes or clears `pins`. An event that fails its structural check is refused, not stored.
- [ ] **P1-B4** `GET /events` in its two forms, `chat` with `before`, and `after`. The visibility rule is one SQL fragment used by every read. For a direct chat, `chat=bob` means events between the caller and bob in either direction.
- [ ] **P1-B5** `GET /stream?after=S`: `Content-Type: text/event-stream`, first everything visible after S, then each new visible event as it is stored, and a comment line every 20 seconds. Membership is checked when each event is sent, so leaving a channel stops its events on an open stream. Close the response when the client goes away.
- [ ] **P1-B6** `GET /audit/head`, and `player-two hub verify`, which walks the table and reports the first `seq` whose `chain` does not follow from the one before.
- [ ] **P1-B7** Remove `POST /notes`, `GET /notes`, and the four channel-changing routes. `GET /channels` stays and reports each channel's pinned branch.
- [ ] **P1-B8** In `deploy/k8s.yaml`, on the ingress: a read timeout of an hour and response buffering off for the hub, as annotations for the `nginx` class, with a comment that without them every client's stream drops each minute.
- [ ] **P1-B9** `test/hub.api.test.ts`, rewritten for events. It keeps every guarantee the note tests held: only the author can sign, the freshness window, one delivery for a replay, direct events reach two people only, channel events reach members only, leaving stops them, joining reveals earlier ones. New: an unknown kind is stored and returned; a bad `id` is refused; a non-member cannot pin; the stream delivers an event posted after it opened and stops delivering a channel's events after a leave; `hub verify` passes on a clean database and names the row after one is altered by hand.

## C. The client and the fold

- [ ] **P1-C1** `src/desk/client.ts`: `publish(to, kind, content, refs)` signs and posts and returns the event, whose id the caller can use at once; `events({ chat, before, limit })`; `catchUp(after)`; `stream(after, onEvent, signal)` reading the response body line by line, reconnecting from the last `seq` with a growing delay capped at 30 seconds. Remove `send`, `notes`, and the channel calls.
- [ ] **P1-C2** `isTrusted` works on events. Keys are still pinned the first time a name is seen.
- [ ] **P1-C3** Rewrite `src/core/chat.ts` as a fold. `ChatLog.add(delivered[])` applies events in `seq` order and keeps, per chat:
  - messages, each with its current text, whether it was edited or deleted, its reactions as emoji to the set of people, and its replies;
  - jobs, keyed by request id and agent, each with the state from the diagram in the protocol reference, and the `branch`, `commit`, `delivery` and `mode` it was accepted with.

  The rules that keep it honest, each with a test: an edit or delete counts only from the message's author; a `job.*` event counts only from the agent's owner, except `job.withdrawn`, which counts only from the asker; an untrusted event changes nothing and is shown as a warning without its text; an unknown kind changes nothing and breaks nothing; a tag counts only in a `message`.
- [ ] **P1-C4** Keep `mentions`, `candidates`, `continues`, `rings`, `agentPrompt` and `spans` working over the new shapes. `agentPrompt` is unchanged in what it says.
- [ ] **P1-C5** `test/core.test.ts`: rewrite the state tests for events and add one per rule in P1-C3.

## D. The session

- [ ] **P1-D1** `src/desk/session.ts` follows the hub with `catchUp` then `stream`, in place of the poll loop. Presence still needs a signed request now and then: fetch `users`, `channels` and `repos` every 25 seconds, as the repo scan already runs on that beat.
- [ ] **P1-D2** Start-up: for each chat in the list, load its newest 50 events with `events({ chat })`. Add an `older` command that loads the next 50 for the open chat, and `hasOlder` on the current view.
- [ ] **P1-D3** Running an agent publishes `job.accepted` before it starts, with the checkout's branch, `git rev-parse HEAD`, whether the tree is dirty, the delivery, and `by: "owner"`. Then exactly one of `job.result`, `job.error` or `job.cancelled`. Declining publishes `job.declined`; discarding a draft publishes `job.declined` too, as now.
- [ ] **P1-D4** The own-tag rule becomes simpler: the session publishes the `message` with `via: "window"`, already knows its id, and starts its own tagged agents straight away. Delete the `autorun` set. A `message` whose `via` is not `window` never starts the sender's own agents without a click, wherever it came from.
- [ ] **P1-D5** New commands in `src/shared/ipc.ts` and their handlers: `reply` (a message with `refs` to a thread root), `react`, `edit`, `delete`, `withdraw`, `older`. `joinChannel`, `leaveChannel`, `pin` and `unpin` publish `channel.*` events.
- [ ] **P1-D6** The view gains what the window needs to draw these: on each message, `edited`, `deleted`, `reactions`, `replyCount` and `replies`; system lines for join, leave and pin; on each request, the commit it was accepted at.
- [ ] **P1-D7** `test/hub.test.ts`, the two-session scenario, rewritten on events with the same story and the same assertions about what each person sees, plus: bob withdraws a request and jacob's buttons go; a reaction and an edit from one person appear for the other.

## E. The window

- [ ] **P1-E1** Threads: "Reply" on a message opens its replies under it with a small message box; a root shows its reply count and its last reply. Tags work in a reply.
- [ ] **P1-E2** Reactions: a row of a few common emoji on hover plus a field for any other; counts with a tooltip of names; click your own to take it back.
- [ ] **P1-E3** Edit and delete on your own messages, from a menu. An edited message says so; a deleted one leaves "message deleted". Editing a message does not re-run tags in it.
- [ ] **P1-E4** A quiet line in the chat when someone joins, leaves, or pins or unpins a repo.
- [ ] **P1-E5** Scrolling to the top of a chat loads older events, keeping the reading position.
- [ ] **P1-E6** Under a request the owner accepted, show the branch and short commit it ran at. The asker gets "Withdraw" while a request is waiting.

## F. The command

- [ ] **P1-F1** `send` publishes a `message` with `via: "cli"`. `inbox`, `send --wait` and `--json` work on events and print them as the hub delivered them plus `trusted`.
- [ ] **P1-F2** `channel join` and `leave` publish events.
- [ ] **P1-F3** Version `0.5.0`, protocol `2`, in `package.json`, `/info`, the desk's `hello`, and the image tag in `deploy/k8s.yaml`.

## Done when

1. Every task is ticked and the checks are green.
2. The two-session scenario passes on events.
3. A test proves that a client shows a chat correctly when it contains a kind the client has never heard of.
4. `grep -rn "status\b.*note\|kind: \"status\"\|re: " src` finds no trace of the note format.
5. The README's "What Player Two protects" section describes events, ids, the chain and the approval record.
