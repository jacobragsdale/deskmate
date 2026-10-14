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

- [x] **P1-A1** `src/core/wire.ts`: `eventSchema`, strict, with the fields and limits in the protocol reference. Remove `noteSchema`, `deliveredSchema` for notes, and `kindSchema`. `deliveredSchema` becomes `{ seq, event }`.
- [x] **P1-A2** `src/core/sign.ts`: `eventBytes(fields)`, `signEvent(key, fields)` which fills `nonce`, `id` and `sig` and returns a parsed event, `eventIsAuthentic(event, pubkey)` which checks both the id and the signature. Remove the note functions.
- [x] **P1-A3** `src/core/kinds.ts`: one zod schema per kind in the table for phase 1 (`message`, `message.edit`, `message.delete`, `reaction`, `channel.join`, `channel.leave`, `channel.pin`, `job.accepted`, `job.declined`, `job.result`, `job.error`, `job.cancelled`, `job.withdrawn`), and `readContent(event)` returning a tagged union of the parsed content, or `{ kind: "unknown" }` for a kind it does not know or content that does not parse. `job.accepted.mode` is `"full"` until phase 3 gives it meaning; `channel.pin.branch` is `null` until phase 6.
- [x] **P1-A4** Regenerate `test/fixtures/signing-vectors.json` from the TypeScript implementation with a small script, `scripts/make-vectors.ts`, covering the awkward text the current vectors cover (quotes, control characters, non-ASCII, line separators). `test/vectors.test.ts` checks the implementation still produces the committed file exactly.

## B. The hub

- [x] **P1-B1** Schema version 5 in `src/hub/db.ts`. Drop `notes`. Add:

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
- [x] **P1-B2** `POST /events`: the four checks in the protocol reference, in that order, each with its own `detail`. Insert, compute `chain`, write `event_refs`, and apply a structural kind, all in one transaction. Answer `201 { seq }`; `409` for an id already stored.
- [x] **P1-B3** Structural kinds: `channel.join` and `channel.leave` change `members`; `channel.pin` checks the author is a member and the repo is under the hub's address, then writes or clears `pins`. An event that fails its structural check is refused, not stored.
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

## Notes

- **How the phase stays green at every commit (decided at P1-A1).** Section A takes the note format away from code that sections C to F rewrite, and P1-B7 takes `/notes` away from the desk, the command and their tests before sections C, D and F move them. So the event pieces are added beside the note ones, and each note piece goes in the commit that removes its last user. The hub serves notes and events side by side from P1-B2 until the desk and the command have moved, and `test/hub.test.ts`, `test/desk.test.ts`, `test/cli.test.ts`, `test/hub.main.test.ts` and the smoke test keep running on notes against the real hub, unchanged, until the task that rewrites each. What is left for later, and by whom:
  - `src/core/wire.ts`: `noteSchema`, `kindSchema` and `Kind`, `Note`, `deliveredNoteSchema` and `DeliveredNote`. The last two are the note-era `deliveredSchema` and `Delivered`, renamed in P1-A1 so that the plan's names could mean `{ seq, event }` from the start; no later task has to rename anything. Their last users are the note functions in `src/core/sign.ts`, `src/core/chat.ts` (P1-C3), `src/desk/client.ts` (P1-C1), `src/desk/session.ts` (section D), `src/cli/main.ts` (P1-F1) and the hub's note routes (P1-B7). Whichever of those goes last removes them.
  - `src/core/sign.ts` (P1-A2): `signNote`, `noteIsAuthentic`, `notePayload` and `NoteFields`, with the same last users. `scripts/make-vectors.ts` and `test/vectors.test.ts` also build the entries behind the agent prompts in the record with `signNote`, until P1-C4 gives `agentPrompt` the new shapes; that task changes both and re-runs the script, and the prompts in the record must come out byte for byte the same.
  - `grep -rn "status\b.*note\|kind: \"status\"\|re: " src`, item 4 of "Done when", can never come out empty: `re: ` is inside `more: `, `before: `, `here: ` and `prepare: `, all of which have nothing to do with notes (28 lines at the start of this phase). With word boundaries, `grep -rnE '\bstatus\b.*\bnote|kind: "status"|\bre: ' src` finds exactly the note format's remnants (15 lines at P1-A1) and is the one to hold the phase to.
- **P1-A2: two things beyond the three functions.** `signEvent` takes the nonce as an optional third argument, random when it is left out, because the vectors (P1-A4) have to be signed again to the same bytes. `eventId(fields)` is exported beside `eventBytes`, since the hub refuses a wrong id with words of its own before it looks at the signature (P1-B2), and `player-two hub verify` works an event's id out again from its stored row (P1-B6).
- **P1-A3: how the kinds read what a later phase adds.** The content schemas are `z.object`, not `z.strictObject`: content travels as a string and its signature covers the string, so passing over a field nobody here knows changes nothing signed, and a later phase can add a field to a kind (`delegate` in `job.accepted`, phase 5) without older readers losing the kind. Values follow the task: `job.accepted.mode` is the literal `"full"`, `by` the literal `"owner"`, and `channel.pin.branch` the literal `null`. A phase that widens one of these is therefore a change older readers see as `unknown`, and should say so when it comes. The kinds are one `contentSchema`, a discriminated union on `kind`, exported so that the client (P1-C1) can check what it is about to sign; `readContent` returns its result, or `{ kind: "unknown" }`. Limits the reference leaves open: a message's and a result's text must not be empty, a reaction's emoji is 1 to 32 UTF-16 units of anything, and a commit is 40 hex digits, or 64 for a repository on SHA-256.
- **P1-A4: what the record holds now.** `notes` became `events`: six events signed by the fixed key with fixed nonces (each its place in the list), carrying the same awkward texts as the notes did. Inside a `message` the text is JSON inside the signed JSON, so its control characters reach the signed bytes escaped twice; the sixth event, of a kind nobody knows yet and sent to `*`, carries all three texts as raw content that is not JSON, which the envelope allows, so they reach the bytes as they are. The test signs each again with its nonce and must get the same id and signature, and checks it with `eventIsAuthentic`. The note signatures left the record although notes still travel until P1-B7: nothing will change how a note is signed before it goes. The auth header's example path is now an event route, `/events?chat=%23backend&before=41&limit=50`, so the record names no route that is going; the header's format did not change. Writing this found that `signEvent` given a whole event as its fields kept the event's old id: it now takes the six signed fields one by one. The remotes, prefixes, tags and agent prompts came out unchanged.
- **P1-B1: `notes` stays in the schema until P1-B7.** Schema version 5 adds `events`, its two indexes, `event_refs` and `pins.branch`, as the task gives them, but keeps the `notes` table, since the hub's note routes keep serving the desk and the command until they move (see the first note). The commit that removes the routes takes `notes` and its two indexes out of `SCHEMA` without changing the version: no hub is released between here and then (0.5.0 is P1-F3), and a database made in between would only keep an empty table nothing reads. The test of the refusal now opens a database that says schema 3, as 0.4's do.
- **P1-B2: what the route does where the task leaves it open.** `POST /events` takes the auth header, as the reference's "Auth header" section says every route does but `POST /join`, `GET /healthz` and the downloads; `POST /notes` took none. Whoever signs the request need not be the event's author (from phase 4 a desk posts its agents' events), so the header gates the request and counts as "here", and the four checks are made of the event alone. Each refusal: the envelope `422 invalid <field>: …`, the id `422 invalid id: not the hash of the event's signed bytes`, the signature (or an author nobody joined as) `401 event is not signed by its author`, the time `400 event timestamp is more than 5 minutes off the hub clock; …`, a stored id `409 this event was already stored`, and then `404 nobody named '<to>' has joined`, `403 join <channel> before posting to it`, or `403 <kind> cannot be sent to everyone`: no kind may be sent to `*` until phase 4 names the public ones. The id is looked up before the insert rather than left to the `UNIQUE` constraint, so that a replay is refused at check 3 and not after check 4; nothing can come between the two, as a request is answered in one turn of the loop once its body has arrived. A refused event takes no `seq`. `Database.transaction` is the one place that begins and commits, and `replaceRepos` now uses it too. The note receipt `{ id }` became `noteReceiptSchema`, so that `receiptSchema` is the event's `{ seq }`; it goes with the other note schemas.
- **P1-B3: B7's second sentence is done here.** `GET /channels` reports each channel's `branch` from this commit, with `branch` added to `channelInfoSchema` (and to the channels the command, core and hub tests expect), since the test of a pin has to see it. P1-B7 is left with its removals. The structural checks come after the four of P1-B2 and before the event is stored, in its transaction: a `channel.*` event sent to a person is `422 <kind> is sent to the channel it is about`, content its kind does not hold is `422 invalid content: not what <kind> holds`, and a repo outside the hub's address is the `422` the pin route gave. That the author of a pin or a leave is in the channel is the fourth check's to refuse, with its `403`. Joining and leaving log the lines the old routes logged. The old pin route stores a `null` branch.
