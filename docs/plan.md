# Plan: one TypeScript codebase, and what we are borrowing

Agreed on 2026-10-13. This page is the overview and the record of decisions. The work itself, task by task, is in [`plan/`](plan/README.md): start there to build.

## What Player Two keeps as its own

An agent is a person's checkout of a repo, and nothing runs on a machine unless its owner said so. Every phase must leave that true.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Name | Player Two. The command, the package and the folders are `player-two`. | Renamed from deskmate on 2026-10-13. The code changes in task P0-E4, after Python is deleted. |
| Client | TypeScript only. The Python interface and command are deleted. | One implementation of the wire format instead of two that must move together. |
| Hub | Ported to Node and TypeScript. | It then shares its schemas and signing code with the client. It is about 300 lines, and phase 1 rewrites its core anyway. |
| Desktop app | Electron, React, shadcn/ui. | The app exists and works; the styling moves in phase 0. |
| Where it runs | On each person's cloud workstation: Windows 11, with the repos and the agent CLI inside WSL2 Ubuntu. | The window is a Windows app; everything that touches `~/dev` runs in WSL. |
| Windows and WSL | Two processes: the window, and a headless "desk" that holds the session. The window starts the desk with `wsl.exe` and they exchange JSON lines over standard input and output. | Scanning, cloning and running agents happen in Linux, where the checkouts are. The window stays a real Windows app. No network port is opened. |
| Agents | Cursor's command line and GitHub Copilot's, both inside WSL, driven over ACP: `agent acp` and `copilot --acp --stdio`. | They are what the team uses. |
| Cursor's SDK | Not used, anywhere. | It does not work behind the team's proxy. Cursor is driven only through its command line. |
| Hub deployment | One Docker container on AKS, one replica, the SQLite file on an Azure Disk volume. | The manifest already has this shape. A file share is not safe for SQLite. |
| Source control | Azure DevOps, through its REST API, called from each person's desk with their own token. | The team's repos live there. The hub never holds a token. |
| Storage | One SQLite file on the hub. | Right for a team. No Postgres, Redis or object store. |

## The phases

| Phase | What it delivers | File |
|---|---|---|
| 0. One language | Node hub, TypeScript command, desk and window split, WSL, the setup check, shadcn, a Windows installer, Python deleted | [`phase-0-one-language.md`](plan/phase-0-one-language.md) |
| 1. Event log | Every action is a signed event with a kind; jobs; approvals become signed records; threads, reactions, edits; paging | [`phase-1-event-log.md`](plan/phase-1-event-log.md) |
| 2. Search, command, MCP | Full-text search, Cmd+K, note links, `player-two ask`, an MCP server for agents in the editor | [`phase-2-search-cli-mcp.md`](plan/phase-2-search-cli-mcp.md) |
| 3. ACP and permissions | Agents over ACP, permission modes, a live activity feed, permission cards | [`phase-3-acp-permissions.md`](plan/phase-3-acp-permissions.md) |
| 4. Agent keys and grants | Agents sign their own answers; expiring standing approvals; tray and start at login | [`phase-4-agent-keys-grants.md`](plan/phase-4-agent-keys-grants.md) |
| 5. Delegation | Agents can ask agents, with an owner or a grant at every hop | [`phase-5-delegation.md`](plan/phase-5-delegation.md) |
| 6. Branch rooms and Azure DevOps | A room per branch; patches you apply after a confirmation; pull requests and builds | [`phase-6-branch-rooms-azure-devops.md`](plan/phase-6-branch-rooms-azure-devops.md) |
| 7. Workflows | YAML triggers from messages, reactions, schedules and webhooks, gated by the normal approval queue | [`phase-7-workflows.md`](plan/phase-7-workflows.md) |

[`plan/protocol.md`](plan/protocol.md) is the reference for the event format, the hub's API, the desk's protocol and the permission modes. [`plan/workstation-checklist.md`](plan/workstation-checklist.md) lists what only a Windows workstation can prove.

## Where each borrowed idea went

| Idea | From | Phase |
|---|---|---|
| The Linux runtime carried inside the Windows installer | T3 Code | 0 |
| A setup check that gives the fixing command | T3 Code | 0 |
| One signed event log, and a job lifecycle | Buzz | 1 |
| Search with receipts, a command built for agents | Buzz | 2 |
| An MCP server for agents the app did not start | T3 Code | 2 |
| Agents over ACP, a verb-object-outcome activity feed | Buzz | 3 |
| Named permission modes, and a ceiling on runs started for others | T3 Code | 3 |
| Agent keys with owner attestation | Buzz | 4 |
| Delegation between agents | Buzz | 5 |
| Branch as room, patches as messages | Buzz | 6 |
| Azure DevOps pull requests and builds | T3 Code | 6 |
| YAML workflows | Buzz | 7 |

## Changed since the first version of this plan

- Reading one chat's history a page at a time moved from phase 0 to phase 1, where the store it reads from is rebuilt. Doing it in phase 0 would have meant writing it twice.
- The job lifecycle is defined once, in phase 1. Phase 5 adds only delegation.

## Not doing

- Remote agents and replaceable agent bodies: the workstations are cloud machines that are already always on.
- Queueing and steering messages to a running agent.
- Git hosting, issues and a forge.
- Nostr compatibility, several teams on one hub, voice, pooled GPU compute, a mobile app.

## Not decided

Raised from T3 Code and neither accepted nor declined. Do not build these without asking:

- Showing only what one run changed, with a way to revert it.
- Links that open a draft and never run anything.
- Quoting part of an answer, with a comment, in a follow-up.
- Folding consecutive tool calls into one line in the activity feed.
- What teammates' requests cost the owner's quota.
- Recording real agent sessions and replaying them in tests.
