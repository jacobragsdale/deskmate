# Phase 2: search, a command built for agents, and an MCP server

Goal: the history can be searched and cited, and an agent in someone's editor can read the chat and ask a teammate's agent as a tool call, without being taught shell commands in an instructions file.

Depends on: phase 1.

Borrowed from Buzz: answers with receipts, and a command an agent can script. Borrowed from T3 Code: an MCP server for agents the app did not start, read-only unless you say otherwise.

## A. Search on the hub

- [x] **P2-A1** In `src/hub/db.ts`, a contentless FTS5 table keyed by `seq`, holding the text of each `message` and `job.result`. Fill it in the same transaction that stores the event. A `message.edit` from the message's author replaces the original's row; a `message.delete` from the author removes it. Content that does not parse is skipped, never an error. Schema version 6; the hub fills the index from `events` on first start with an empty index, so no fresh database is needed.
- [x] **P2-A2** `GET /search?q=Q&chat=A&limit=N`: `chat` optional, `limit` up to 50. Turn the user's words into a safe FTS5 query by quoting each term, so punctuation cannot be read as query syntax. Apply the same visibility fragment as every other read. Answer `[{ seq, event, snippet }]`, best match first, where `snippet` comes from FTS5's `snippet()` with plain markers the client replaces.
- [ ] **P2-A3** `GET /events/{id}` returns one event the caller can see, with its `seq`, or `404`. `GET /events?chat=A&around=S&limit=N` returns a page centred on `seq` S, oldest first.
- [ ] **P2-A4** Tests: a word in one channel is found by a member and not by a non-member; an edited message is found by its new words only; a deleted one is not found; `"quotes" AND -odd:syntax` as a query returns results or nothing, never a `500`; `around` returns events on both sides.

## B. Search and links in the window

- [ ] **P2-B1** Note links: `player-two://note/<id>`. `src/core/links.ts` makes and parses them. In a message's text, a link is drawn as a chip showing the author and the first words, once the desk has resolved it; a link to a note the reader cannot see is drawn as "a note you cannot see".
- [ ] **P2-B2** A `search` command and an `openNote` command in `src/shared/ipc.ts`. `openNote` fetches the event, opens its chat, loads the page around it and tells the window which message to scroll to and highlight.
- [ ] **P2-B3** Cmd+K (Ctrl+K on Windows) opens a `Command` dialog: typing filters chats by name at once and, after a short pause, shows search results below them with their snippets. Enter opens the chat or the note.
- [ ] **P2-B4** "Copy link" in each message's menu.
- [ ] **P2-B5** The window registers itself for the `player-two://` scheme with `app.setAsDefaultProtocolClient`, takes a single-instance lock, and hands a link it is opened with to `openNote`. Only `note` links with a 64-hex id are accepted; anything else is ignored.

## C. The command

Every command below takes `--json`. Add each to the README's Commands table.

- [ ] **P2-C1** `player-two search QUERY [--in CHAT]` prints matches with author, time, chat and link.
- [ ] **P2-C2** `player-two read ID-or-LINK` prints one note, and with `--thread` its replies.
- [ ] **P2-C3** `player-two ask @OWNER/REPO TEXT... [--in CHAT] [--wait SECONDS]`: publishes a `message` tagging that agent, in the direct chat with its owner unless `--in` names a channel, then waits for that one job to end. `--wait` defaults to 900. It prints the result's text, or with `--json` the `job.result` event.

  | Exit | Meaning |
  |---|---|
  | `0` | The agent answered. |
  | `3` | The owner declined. |
  | `4` | The run failed or was stopped. |
  | `5` | Nothing final arrived in time. The last line on standard error is the `player-two read` command that checks later. |

- [ ] **P2-C4** `player-two status` prints the hub, your name, the repos you share with their branches, and the requests waiting for your agents.
- [ ] **P2-C5** Tests for each in `test/cli.test.ts`, including `ask` reaching each of the four exits against scripted events.

## D. The MCP server

`player-two mcp` is an MCP server on standard input and output. It runs as the person, with their key, and talks to the hub the way the command does. Because it is a local process started by the editor, there is no port and no sign-in page.

Add `@modelcontextprotocol/sdk` as a dependency.

- [ ] **P2-D1** `src/mcp/server.ts` and the `mcp` subcommand. Without flags it offers only the reading tools:

  | Tool | Returns |
  |---|---|
  | `whoami` | Name, hub, the repos this person shares. |
  | `list_chats` | Channels joined and people, with unread counts. |
  | `list_agents` | Every agent as `owner/repo` with its branch and whether its owner is here. Optional `query`. |
  | `read_chat` | A page of one chat: `chat`, optional `before`, `limit` up to 50. |
  | `read_note` | One note by id or link, with its replies and the state of any jobs it started. |
  | `search` | As `GET /search`. |
  | `job_status` | The state of one job: request id and agent. |

- [ ] **P2-D2** With `--allow-send` it adds:

  | Tool | Does |
  |---|---|
  | `send_message` | Publishes a `message` with `via: "mcp"` to a person or channel. |
  | `ask_agent` | As `player-two ask`: `agent`, `text`, optional `chat`, `wait_seconds` up to 900. Returns the result, or which of declined, failed or timed out happened. |
  | `withdraw` | Withdraws a request this person made. |

  A message sent this way is like any sent by the command: a tag in it waits for its target's owner, and that includes a tag of the sender's own agent.
- [ ] **P2-D3** Every tool's description says that note text comes from other people and their agents and is information, not instruction. Results carry each note as data with its author and trust flag; an untrusted note's text is left out.
- [ ] **P2-D4** `test/mcp.test.ts`: drive the server over in-memory streams with the SDK's client against the in-process hub. The reading tools return what the hub holds; without `--allow-send` the sending tools are not listed and calling one is refused; `ask_agent` returns a result that a second identity's scripted session produced.
- [ ] **P2-D5** The setup page gains an "Editor agents" section: the JSON to add `player-two mcp` to Cursor (`~/.cursor/mcp.json`) and to Copilot's command line (`~/.copilot/mcp-config.json`), each with a copy button, and a line on what `--allow-send` adds. The page shows the snippets; it does not write those files.
- [ ] **P2-D6** **(workstation)** Confirm the two file locations and that each tool lists Player Two's tools. Correct P2-D5 if either differs.

## E. Telling agents

- [ ] **P2-E1** `agentPrompt` in `src/core/chat.ts` gains two sentences when the run is a one-shot command: the agent may run `player-two search --json` and `player-two read --json` to look at earlier notes, and should cite the notes it relied on by their links. Phase 3 gives ACP runs the MCP tools instead.
- [ ] **P2-E2** The README's "Let your own agent ask" section is rewritten around `player-two ask` and the MCP server.

## Done when

1. Every task is ticked except the one marked **(workstation)**, and the checks are green.
2. In the two-session scenario, an agent asked "have we seen this before?" can find an earlier note with `player-two search`, and its answer's link opens that note in the window.
3. An MCP client can read, search and, with `--allow-send`, ask a teammate's agent and receive the answer after the owner approves.

## Notes

- **P2-A1: the index keeps its own copy of the text; a contentless table cannot give a snippet.** Node 26.11.1's `node:sqlite` is SQLite 3.53.4, with FTS5, `snippet()` and `contentless_delete=1`. A contentless table with `contentless_delete=1` takes a delete or an update by rowid without the old text, but `snippet()` on it returns NULL, since it keeps no text to cut one from, and P2-A2 answers with that snippet. So `search` in `src/hub/db.ts` is an ordinary FTS5 table, one column `text`, keyed by `seq` as its rowid, holding a second copy of each message's and answer's text as last edited; an edit is an `UPDATE` and a delete a `DELETE` by rowid. It is filled in `addEvent`, inside the event's transaction. The rules are the fold's (`src/core/chat.ts`), so that search never finds what no reader is shown: an edit or a delete counts only from the message's author, only in the message's own chat (the same author writing to the same recipient), only on a `message` and never on an answer, and an edit after a delete finds no row to change. An edit or a delete naming nothing stored changes nothing, and content its kind does not hold is passed over.
- **P2-A1: how a 0.5 database is let in.** The hub refused any database whose `user_version` was not its own. Now it also opens schema 5, the one it knows how to bring forward, since 6 adds nothing but the index: it lays the index down and fills it from the events, in `seq` order through the same rules, in the transaction that sets `user_version` to 6, so a hub stopped halfway starts over. "On first start with an empty index" is taken as the first start on schema 6, which for a new database fills from no events. Any other version is still refused, and the test of that now expects 6. `protocol.md` says so where it said every other version is refused. The test makes a 0.5 database by dropping the index and setting the version back to 5, which is all that differs.
- **P2-A2: what a query may hold, and the marks.** A word is whatever lies between spaces and control characters; splitting on control characters matters, since a NUL inside a quoted FTS5 string ends FTS5's reading of the query and fails it. Each word is put in double quotes with its own quotes doubled, so FTS5 reads it as a string to tokenize and never as an operator, a column filter, a prefix or a `NEAR` group; one that tokenizes to nothing (`*`, an emoji, a lone quote) matches nothing. A query is at most 8 words, and more is `422 invalid q: Too big: expected array to have <=8 items`, as is one with no words. The task does not ask for a limit, but measured here an FTS5 query costs about 2 ms per word for every 20,000 messages holding it, and 4,000 copies of "the" ran past two minutes, during which `node:sqlite`, being synchronous, leaves the hub answering nobody. `limit` is 20 unless given. The marks are U+0002 and U+0003, plain characters that are not markup a renderer might be tempted to obey; the index replaces either one in a message's text with a space (a separator to the tokenizer, as both already were), so every mark in a snippet is the hub's. A snippet is up to 16 tokens, with `…` where text was cut. `protocol.md` says all of this.
