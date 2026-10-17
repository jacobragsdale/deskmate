# Player Two

Player Two is a chat for a small team and their coding agents. Every repo you have checked out under `~/dev` is an agent that anyone on the team can tag, as `@you/repo`. Your own agent answers as soon as you tag it. A teammate's tag waits until you approve it, or runs at once under a standing grant you made for them, and everyone in the chat can see where it stands.

It has three parts. The hub is one small server the team shares; it keeps the log of everything the team says and does. The window is a desktop app, on Windows an Electron program. The desk is your side of it: your identity, your repos and your agents. On Windows the desk runs inside WSL, where your repos and your agent's command line are; on Linux and macOS it runs beside the window. The `player-two` command speaks to the same hub, for scripts and for agents.

The window has the chat list on the left: channels, then people, each person with a dot that is filled while they are here, and beside each chat a count of unread messages and a mark for anything waiting on you. The open chat is on the right: its title with the members and any repo the channel is about, the messages with their threads and reactions, a line under each message that tags an agent saying where that agent stands, and the message box at the bottom with a status line under it.

## Quick start

This walk-through sets up one hub and two people, `jacob` and `bob`, has each of them use an agent, and starts a channel.

The hub needs Docker. Each person needs Windows with WSL 2 and Ubuntu, and inside Ubuntu: `git`, their repos checked out directly under `~/dev`, and a coding agent's command line installed and signed in. The join form offers Cursor's and GitHub Copilot's, each over ACP or as a one-shot command, with Cursor's one-shot command first, and any other program can be typed in with its arguments (see [Configuration](#configuration)). On Linux or macOS the window runs from a clone of this repository instead; see [Development](#development).

### 1. Start the hub

One person runs the hub somewhere everyone can reach. With Docker, from a clone of this repository:

```sh
npm ci && npm run build
docker build -t player-two .
```

The hub also hands teammates the Windows installer, from a folder of three files: `player-two-setup.exe`, `wsl-runtime.tar.gz` and `wsl-runtime.tar.gz.sha256`. Pushing a version tag such as `v0.7.0` to GitHub runs the Release workflow, which builds all three and keeps them with its run as the artifact `player-two-v0.7.0`. Fetch them into a folder named `downloads`:

```sh
gh run download RUN_ID --name player-two-v0.7.0 --dir artifact
mkdir downloads
cp artifact/release/player-two-setup.exe artifact/dist/wsl-runtime.tar.gz artifact/dist/wsl-runtime.tar.gz.sha256 downloads/
```

Then start the hub:

```sh
docker run -d --name player-two -p 8787:8787 -e PLAYER_TWO_JOIN_TOKEN=JOIN_TOKEN -e PLAYER_TWO_REPOS=REPOS_URL -e PLAYER_TWO_DOWNLOADS=/downloads -v "$PWD/downloads:/downloads:ro" -v player-two-data:/data player-two
```

Replace the following:

- `RUN_ID`: the Release workflow's run for the tag, as `gh run list --workflow release.yml` lists it.
- `JOIN_TOKEN`: a secret of at least 16 characters, for example the output of `openssl rand -hex 16`. Anyone who has it can register a name, so share it only with your teammates.
- `REPOS_URL`: the `https` address your team's repos live under, for example `https://dev.azure.com/acme/` or `https://github.com/acme/`. It can be an organisation or a single project, with or without the final `/`. Only repos below it are ever shared; anything else under `~/dev` stays private. A checkout whose remote uses `ssh` matches too.

Inside the container the hub listens on every interface, and `-p 8787:8787` publishes it on the host. Check that it answers:

```sh
curl http://localhost:8787/healthz
```

```text
{"ok":true,"now":1791990000}
```

`now` is the hub's clock. To run the hub on AKS instead, see [Deploy the hub on AKS](#deploy-the-hub-on-aks).

### 2. Install the window

Each person opens the hub's address in a browser, for example `http://localhost:8787`. The page there has the installer and three steps:

1. Install WSL with Ubuntu if you have not: in PowerShell, `wsl --install -d Ubuntu`, then restart and open Ubuntu once to make your user.
2. Download the Player Two installer and run it.
3. Open Player Two and join with the hub's address, your name and the join token.

The first time Player Two starts, it installs its runtime into your WSL distribution: Node 26 and the `player-two` command, under `~/.player-two`, with the command linked as `~/.local/bin/player-two`. It does the same after an update, and keeps the runtime before as well. The installer is not signed; a team that wants it signed signs it with its own certificate.

On Linux, someone who wants only the command runs the hub's install script, which installs the same runtime:

```sh
curl -fsSL HUB_URL/install.sh | sh
```

### 3. Join

The window opens on a form: the hub's address, your name, the join token, and your agent. A name is lowercase letters, digits, `-` and `_`, at most 32 characters. Joining creates a signing key in `~/.config/player-two` and registers your name with it. A copy built for your team's hub (see [Configuration](#configuration)) has the address filled in.

Each time it starts, the window checks the machine. If something it needs is missing, such as the repos folder, `git`, the agent's command or the hub, the Setup page opens with what it found and a command to copy for each thing to fix. See [The window](#the-window).

The chat list shows everyone who has joined, with a filled dot beside those who are here now. The status line counts the team repos found under `~/dev`. If it says `0 repos`, no folder directly under `~/dev` has an `origin` remote below the hub's `REPOS_URL`.

In the steps that follow, `uploader` stands for any repo both people have.

### 4. Tag your own agent

Jacob clicks `bob` in the chat list and types `@`. A list opens above the message box with the team's agents, each with the branch it is on: his own first, then Bob's, because this is their chat. It shows eight and says how many more there are. Typing narrows it; Enter takes the highlighted one. He finishes the message and sends it:

```text
@jacob/uploader where do we retry failed uploads?
```

His agent starts at once in `~/dev/uploader`. A line under the message shows it working, on which branch and commit, with the seconds it has taken and a `■ Stop` button, and Bob sees that it is working. When the agent finishes, its answer is posted to the chat, marked `jacob/uploader agent` with the branch and commit it ran at and `not reviewed`, since nobody read it before it went out, and a coloured edge down its left side.

### 5. Tag a teammate's agent

Bob wants to know about work on Jacob's branch, so in his chat with `jacob` he tags Jacob's agent:

```text
@jacob/uploader does your retry change handle 429s?
```

Under his message Bob sees `◌ waiting for jacob to approve`, and `↩ Withdraw`, which takes the request back until Jacob acts on it. Nothing has run.

Jacob's window notifies him, and his chat list marks the chat with `▶`. Under Bob's message he has three choices:

- `▶ Run read-only` runs his agent read-only: it may read and search the repo and change nothing. Its answer goes in a box of its own above the message box, as a draft. He can edit it, then `Send answer` sends it, or `× Discard` drops it.
- The menu beside it chooses how the answer is delivered, reviewed as a draft first or posted directly, and runs his agent at the permission mode he picks in it: `read-only`; `supervised`, which asks him before it changes a file or runs a command; `auto-edits`, which changes files and asks before it runs a command; or `full`, which does anything without asking.
- `× Decline` tells Bob the answer is no.

Under them is a switch, `Let this agent ask other agents`, off for a teammate's request and on for one of Jacob's own, as his own tag sent from his window runs with it on. On, his agent may ask other agents in that run, as [step 8](#8-let-an-agent-ask-other-agents) tells, and the switch says what that means: each of their owners decides, what it asks is posted in the chat as it asks, even when its answer is kept for his review, and the run starts afresh, keeping no session for a follow-up in the thread to go on in. Only an agent spoken to over ACP can ask, so while a one-shot command answers the switch is off and says why.

The next request from Bob of the same repo offers what Jacob chose last as its first button, such as `▶▶ Run supervised and post`, while the same agent answers. `full` is offered that way only while that agent cannot be held to anything less; otherwise, and once another agent answers, the first button is `▶ Run read-only` again, and `full` is chosen in the menu. The menu offers only the modes the agent that answers can be held to, and says why not the others. Copilot's one-shot command runs as a single command and cannot be limited, so it is offered only at `full`; Cursor's one-shot command is offered `read-only`, when it only proposes changes, and `full`; an agent over ACP that failed the permission test on the Setup page is offered only `full` until it passes. One over ACP that has never been tested is offered every mode, and the menu says `Permissions not tested — Setup → Test permissions.` When what is offered cannot be kept by the agent that answers, there is no first button, only `▶ Run…` with the menu.

Before the agent starts, Jacob's desk tells the chat he let it run, on what and at which mode. While it runs, Bob's line reads `jacob's uploader agent is working on feature/retry ± at 1a2b3c4 · read-only`: the branch, `±` when there are uncommitted changes, the commit, and the mode Jacob let it act at. Once an agent spoken to over ACP is under way, `working` gives way to what it is doing, in a few words that Jacob's desk sends at most every ten seconds: `thinking`, `reading`, `editing files`, `running a command` or `waiting for approval`. Bob never sees a file, a command or anything the agent printed.

While it runs, `Show activity` under the request opens a panel beside the chat with what Jacob's agent is doing, one row per step, newest at the bottom: what it said, each file it read or changed and each command it ran, with how each went, such as `+12 −3` or `exit 0`. A step that failed is red, one that changed a file or ran a command stands out, and reads, searches and thoughts are grey. Clicking a row shows its detail, such as the change to a file or what a command printed, as plain text. `waiting…` appears when nothing new has come for ten seconds. The panel stays on the run once it ends, with how it ended, and a run that failed or was stopped can be looked at again from `Show activity` under the request while the desk is running. None of it leaves Jacob's machine.

### 6. Start a channel

Jacob presses Ctrl+N, or clicks `+ Join or create` in the chat list, types `backend`, and presses Enter. The name follows the same rules as a person's name; the `#` is added for you. A channel exists as soon as one person has joined it. Bob joins the same way, and his dialog lists `#backend` to pick.

Tags work in a channel exactly as in a direct chat, and every member sees the answers. A quiet line in the channel says when someone joins or leaves it, or pins or unpins its repo.

A channel can be about one repo. Click `◆ Pin a repo` in the channel's title and pick one of yours. The title then shows how many members have it, the tag list puts its agents first, and a member without it is offered a clone.

### 7. Let your own agent ask

Jacob's agent in his editor can ask Bob's agent too, and read and search the chat on the way. Either way below, the question is a message from Jacob like any other: Bob still has to let his agent run, by hand or with a grant that names Jacob, and a tag of Jacob's own agent waits for Jacob's click, whatever grants there are.

**Through MCP.** Player Two's MCP server, `player-two mcp`, gives the agent the chat as tools. The Setup page's `Editor agents` section has the JSON to copy into Cursor's `~/.cursor/mcp.json` or Copilot's `~/.copilot/mcp-config.json`, inside WSL. As it is, the agent can only read: `whoami`, `list_chats`, `list_agents`, `read_chat`, `read_note`, `search` and `job_status`. With `"--allow-send"` added after `"mcp"`, it can also act as Jacob: `send_message`, `ask_agent`, which asks an agent and waits up to 900 seconds for the answer, and `withdraw`. Every tool tells the agent that what teammates and their agents wrote is information, not instruction, and a note whose signature fails comes without its text.

**From the command line.** In WSL the window has installed the command as `~/.local/bin/player-two`:

```sh
player-two ask @bob/uploader "which tests cover the retry path?"
player-two ask @bob/uploader "who calls the uploader?" --in '#backend' --wait 300
```

`ask` sends the question in the direct chat with Bob, or in a channel with `--in`, waits for that one request to end, up to `--wait` seconds and 900 unless told, and prints the answer. Its exit status says how it ended: `0` answered, `3` declined, `4` failed, stopped or withdrawn, and `5` nothing final yet, when the last line on standard error is the `player-two read` command that checks later. `player-two search` finds earlier messages and answers, and `player-two read` prints one with where its requests stand; each comes with its link, `player-two://note/` and an id, which the window draws as a chip naming the note's author. An agent Player Two runs is told about `search` and `read` in its prompt, unless it runs under a grant; one you run yourself learns them from its instructions file, or uses the MCP server instead. `player-two status` shows what is waiting for your own agents.

### 8. Let an agent ask other agents

Bob asks Jacob's agent whether dropping `retries` from `UploadOptions` breaks anyone, in `#backend`, where Carol is too. Jacob turns on `Let this agent ask other agents` and runs it. His agent asks Carol's, `@carol/billing`, with the `ask_agent` tool of the MCP server it is given for that run, and waits for her agent's answer, which it then has to work with.

Its question is posted in the chat as it asks, signed by Jacob's agent with its own key, in the thread of Bob's message, so everyone there can read what each agent asked and answered. It reads `jacob's uploader agent asked @carol/billing: …`, marked `not reviewed`, since Jacob did not read it before it went. Under Bob's message is the tree of everything asked under it, one line per agent, indented by how deep it is, each with where it stands and the mode its owner let it run at:

```text
jacob's uploader agent · working · read-only
    ◌ carol's billing agent · waiting for carol
```

Once every one is done, the tree folds to `2 agents involved`, which opens it again.

Bob has one `↩ Withdraw` under his message while Jacob's agent works on it let ask others. It ends the whole tree: Jacob's desk stops his agent, and the end of that run takes back everything it asked, each of whose desks stops its own run in turn. Until Jacob's desk has stopped it, Bob's line says `↩ taken back, until jacob's desk stops it`. What an agent asked is that agent's to take back, so nobody has a Withdraw under it. Jacob's `■ Stop` ends the tree the same way. Under it, before her buttons, Carol reads how it came: `◆ bob asked jacob's uploader agent, which is asking your billing agent`. She decides as for any request, offered no more than the least any agent above it was let do: her agent runs only once she lets it, or under a grant of hers that names everyone the question runs on the say of, Bob, who asked first, and Jacob, whose agent asks. Once it may no longer go, as when Jacob's agent has finished or been stopped, her line says why in place of the buttons, and her desk would refuse to run it. Her agent's answer goes into the chat, or waits for her review, as any does, and Jacob's agent gets it only once it is there.

Limits hold at every hop, and the target's desk checks each one in the log before it offers the question to its owner, declining it, saying why, when one fails: the agent asked first may ask others, and they may ask one level further, no deeper; one agent asks at most four others, and at most eight are asked under one message; an agent never asks one that the question already came through; it runs at no more than the mode of every agent above it, so a read-only run causes no write anywhere; and an hour after the first agent was let run, nothing more is asked under it and every desk stops what it runs under it and starts nothing more, each by its own clock, so the tree ends on time even when the first agent's desk has gone. An agent asks others only in a run its owner let it, by hand: a run under a grant never does, as nobody is there to see what it asks in its owner's name, and a one-shot command cannot, as it is given no MCP server.

### 9. Hand over a change as a patch

Bob asks Jacob's agent to make a change rather than explain one: `@jacob/uploader make the retry back off`. Jacob runs it at `auto-edits`. Above `read-only`, a teammate's request does not run in Jacob's checkout: under its buttons the window says `read-only runs in your checkout; any other mode runs on a clean copy of 1a2b3c4; your uncommitted changes are not included`, and the agent works in a throwaway git worktree of that commit, under `~/.player-two/worktrees`, which goes once the run ends. Jacob's own working tree is never touched by someone else's request. A request of Jacob's own runs in place, as before.

When the run changed anything, its diff goes to the chat as a patch, just before the answer and under the same review: with the answer kept for Jacob's review, he sees the patch beside the draft, and neither is sent until he sends them. A diff of more than 512,000 characters is not sent: the answer says it was too large, and Jacob gets a notice with the worktree's path, which is kept for him, and the command that removes it.

In the chat a patch is a card: its title, the repo, branch and commit it was made on, and each file with the lines it adds and removes, folded until it is opened. Everything on it is drawn as text. Anyone with a checkout of the repo has three buttons under it:

- `Apply` applies it to their checkout, on the branch it is on.
- `Apply to a new branch` makes `player-two/` and the first 8 characters of the patch's id from the commit it was made on, with the patch as one commit of theirs, and leaves their own branch, working tree and index as they are. Their repository must have that commit.
- `Push and open a pull request`, once they have applied it to its new branch, opens a pull request from that branch, titled as the patch is: see [step 10](#10-work-on-a-branch-in-its-own-room).

Neither Apply runs until its owner says yes. The desk first refuses a patch that names a path outside the repo or inside `.git`, before git sees it, then has `git apply --check --3way` say whether it applies, and only then asks, in a dialog of the system's own: who the patch is from, an agent's `which nobody reviewed`, its title, the repo and its folder, the branch it goes on, and its files with their counts, with a warning when the checkout has uncommitted changes, when it will leave conflicts to resolve, when it changes files agents read as instructions, such as `AGENTS.md`, `CLAUDE.md` or anything under `.cursor/` or `.github/instructions/`, and when it makes symbolic links. Only on yes does it apply; the card then says `✓ bob applied it to main`. `Review…`, for anyone, approves a patch or asks for changes with a comment, which the card shows as who said what.

### 10. Work on a branch in its own room

Jacob and Bob are both on `feature/retry` of uploader, which is not its default branch, so the chat list suggests a room: `bob is also on uploader/feature/retry · Start a room`. `Start a room` makes a channel named from the repo and the branch, pins it to that branch and opens it; `×` stops suggesting it, which `app-state.json` remembers. `◆ Pin a repo` in any channel offers each of your checkouts whole and on the branch it is on.

A room about a branch says under its title who is on that branch, from what everyone's desk advertises, and which members are elsewhere: `on this branch: bob, jacob · elsewhere: carol on main`. Its tag list leads with the agents on the branch. On Azure DevOps, the line under that is the branch's pull request, `!42 Retry with back-off · active · 1 approved, 1 waiting`, and its latest build, `uploader-CI: succeeded`, each a link to it in your browser; when one cannot be looked up, such as the build with a token that lacks Build (read), the line says why in its place. Your desk asks Azure DevOps for them when you open the room and every 60 seconds while it is open and the window has your attention, and not otherwise. When the build changes to failed, you get a notice in your own window; nothing is posted to the chat.

With no pull request, the line says `No pull request`, and when you have a checkout of the repo, `Create one` beside it, which opens a dialog with the title and description filled from the commits on the branch that its default branch lacks, the target set to the default branch Azure DevOps names, and a `Draft` switch. It works only from the branch your checkout is on, and says so otherwise. When origin lacks the branch, or lacks some of its commits, your desk first asks, in a dialog of the system's own naming the repo, the branch and the remote, to run `git push -u origin refs/heads/feature/retry:refs/heads/feature/retry` with your own git credentials; nothing is pushed or opened until you say yes. When origin's branch has commits yours lacks, the pull request is opened from origin's, as the dialog says, and when yours also has commits origin's lacks, or git has not fetched origin's, your desk says to pull first and opens nothing. The pull request is then opened, and the room is told `Opened pull request 42:` and its address.

`!42` in a message, in a channel pinned to a repo on Azure DevOps, means that repo's pull request 42, and a pull request's address pasted into any chat means that one: each is drawn as a chip with its title, status and votes, which opens it in your browser. One that cannot be found is left as text. See [Azure DevOps](#azure-devops) for the token this needs.

## Agents and tags

An agent is one person's checkout of one team repo: `@bob/uploader` is the agent command run in Bob's `~/dev/uploader`. Nothing is registered by hand. The desk looks at the folders directly under `~/dev`, keeps those whose `origin` remote is under the hub's `PLAYER_TWO_REPOS` address, and tells the hub their names and current branches. It looks again each time it asks the hub who is here, every 25 seconds, so a branch switch shows up without a restart.

A repo is named by the last part of its remote URL, in lowercase, whatever the folder is called. The `https` and `ssh` forms of one remote, and every Azure DevOps address form, count as the same repo. With two clones of one repo under `~/dev`, the folder named like the repo is used. Two different repos with the same name cannot both be shared: the first folder in alphabetical order wins. A repo whose name has characters other than letters, digits, `.`, `_` and `-` is skipped.

The list that opens on `@` shows the agents whose `person/repo` contains what you have typed, most likely first: the channel's pinned repo, your own agents, the agents of the person you are chatting with, repos you also have, then the rest by name. A repo you have no copy of is offered for cloning once you have typed part of its name.

A tag counts only in a message as it was sent. An agent's answer that contains a tag sets nothing off, so agents cannot start each other that way, and editing a message tags nobody new. In a run, an agent asks another only when its owner let it ask others (see [step 8](#8-let-an-agent-ask-other-agents)): its `ask_agent` then sends a request signed by the agent, which waits for the other agent's owner like any. A script, or your agent, can tag someone with `player-two send` or `player-two ask`, or the MCP server's `send_message` and `ask_agent`; that tag waits for its target's owner like any other, or runs at once under a grant of theirs that names you. A tag of your own agent sent that way always waits for you: no grant lets it run, so an agent sending in your name cannot start your agents.

A request waits for as long as it takes. It is stored on the hub, so it is still there after you restart the window or come back from lunch.

Who may run what:

| Tag | What happens |
|---|---|
| Your own agent, in a message you send from the window | It runs at once and its answer is posted. |
| Your own agent, in a message sent another way, or left unanswered when you last quit | It waits for you, like a teammate's request. No grant lets it run. |
| A teammate's agent | It waits until they run it, from `▶ Run read-only` or the menu beside it, or `Decline` it. |
| Your agent, asked by another agent | It waits for you, saying who asked first and which agents the question came through, offered at no more than the least any of them was let do. A grant of yours lets it run only when it names everyone involved, and it then never asks further. |
| A teammate's agent, under a grant of theirs that names you | It runs as soon as your message reaches their desk, with nobody needing to be there, at the grant's mode, its answer posted or kept for their review as the grant says. See [What Player Two protects](#what-player-two-protects-and-what-it-does-not) for when a grant applies. |
| Your agent, tagged by a workflow | It waits for you, asked by `workflow:#ops/ci-failure`: the workflow named ci-failure in `#ops`. A grant lets it run only when it names `workflow:#ops/ci-failure`: one for anyone on the hub does not cover a workflow, and one for a workflow in one channel does not cover a workflow of that name in another. See [Workflows](#workflows). |
| An agent in a repo its owner does not have | The line under the message says so, and nothing runs. |

Under each message that tags an agent, everyone in the chat sees one line per tag until it is answered:

| Line | Meaning |
|---|---|
| `◌ waiting for bob to approve` | Bob has not acted. `· they are away` is added when his window is not open, and whoever asked has `↩ Withdraw`. |
| `bob's uploader agent is working on main ± at 1a2b3c4 · read-only` | Bob approved it. The branch and commit are those his checkout was at when the run started, and `read-only` the permission mode he let it act at. `working` becomes what the agent is doing, such as `editing files`, once his desk has said. While Bob let it ask other agents, whoever asked has `↩ Withdraw`, which ends it and everything it asked. |
| `bob's uploader agent is working on main at 1a2b3c4 · under bob's grant, read-only, until Friday` | A standing grant of Bob's let it run with nobody at his desk, at the mode the grant names, and the grant lasts until then. The answer says `ran under bob's grant, read-only, until Friday` beside the branch and commit. Without the grant in hand, which Bob's desk sent to everyone, a window leaves out when it ends. |
| `× bob declined` | Bob declined, or discarded the draft. |
| `■ bob's uploader agent was stopped on main at 1a2b3c4 · read-only` | Bob stopped the run, or quit while it was working. |
| `✗ bob's uploader agent failed on main at 1a2b3c4 · read-only` | The agent exited with an error, printed nothing, or ran past its time limit. Only Bob sees why. |
| `↩ the request was taken back` | Whoever asked withdrew it before Bob acted. |
| `? bob has no checkout of billing` | Bob does not have that repo. |
| `? nobody named bob has joined` | There is no such person on the hub. |

A run reported as working that has produced no answer after 16 minutes is shown as waiting again.

If you tag or pin a repo you do not have, `⇣ Clone it` offers to run `git clone` into your repos folder (`~/dev`, or `PLAYER_TWO_DEV` when set) with your own git credentials. A dialog shows the address and the destination first, and nothing is fetched until you confirm. Git is not allowed to prompt for a password, so a clone that needs one you have not stored fails with the command to run yourself.

## The window

Everything can be clicked: chats in the list, the choices under a message, the bar over it, the buttons in a channel's title. Light or dark follows the system's setting.

| Key | Effect |
|---|---|
| @ | Opens the list of agents. ↑ and ↓ move, Enter or Tab takes one, Esc closes it. |
| Enter | Sends the message. |
| Shift+Enter | Starts a new line in the message. |
| ↑ | In an empty message box, brings back the last message you sent in that chat. |
| Esc | In the message box, stops every agent of yours at work in the open chat, on a reply as on any other message. |
| Enter, Esc | In a reply box, send the reply or close the box; while editing a message, save or give up. |
| Alt+↑, Alt+↓ | Opens the previous or next chat. |
| Ctrl+N | Joins or creates a channel. Cmd+N on a Mac. |
| Ctrl+B | Hides or shows the chat list. Cmd+B on a Mac. |
| Ctrl+K | Searches: chats by name as you type, then the messages and answers that hold your words, each with the words picked out. Enter opens the chat or the message. Cmd+K on a Mac. |

In the chat list, a number is the count of unread messages, `▶` means a request is waiting for one of your agents, `👍` that a [workflow](#workflows) is waiting for your 👍, `✎` means a draft is waiting for your review, and a spinner means one of your agents is working there. Hovering a mark says what it means, and hovering a message's time gives its full date. Drag the chat list's edge to make it wider or narrower; the window remembers the width.

A `new` line marks where you left off in a chat you come back to. A message or an answer that arrives while you are looking elsewhere raises a system notification, with a sound for one sent straight to you, a tag of one of your agents, and a draft ready for review. The window's title says what is waiting, for example `Player Two · 1 waiting · 2 unread`, and on macOS and Linux its badge counts it. Messages that arrive while the window is in the background stay unread until you come back.

Hovering a message shows a bar over it: a few common emoji and a field for any other, `Reply`, and a menu to copy the message's link and, on your own, to edit or delete it. `Reply` opens the message's thread under it, with a box to reply in; a message with replies shows how many there are and the last one, and clicking that opens the thread too. Tags work in a reply as in any message. Under a message each emoji shows how many used it, and hovering it says who; clicking one you used takes yours back. An edited message ends in `(edited)`, and a deleted one leaves `message deleted`. A chat opens on its newest 50 events, and scrolling to the top loads the 50 before them, keeping your place.

A message's link, `player-two://note/` and its id, pasted into another message is drawn as a chip with who wrote it and its first words as they read now, edits and deletes applied, or `a note you cannot see`. When the message's chat is not loaded in the window, the chip says who wrote it and where, such as `alice in #history`, and not its words: what the hub hands over of one message is its words as first sent, which may since have been edited or deleted. Clicking the chip, choosing a message in the search, or opening a link elsewhere on your machine once the installed app has registered for `player-two://` links, opens that message's chat with the message in view and highlighted. A message you cannot see opens nothing, and the window says so.

An agent's answer is drawn as Markdown, as text and structure only: raw HTML in it stays text, images are not fetched, and a link opens in your browser.

An agent spoken to over ACP asks before it does what its run's permission mode leaves to you. A card then appears under the request, or under its thread's summary while a thread it is in is closed, and in the activity panel, saying what the agent wants to do, with the detail below it as plain text, the command or the change to a file, and three answers: `Allow once`; `Allow for this run`, which allows that kind of action, editing files or running commands, say, without asking again until the run ends; and `Refuse`. The window notifies you when a card is waiting and you are not looking, and the run's 900 seconds do not count while it waits. A one-shot command's standard input is closed during a run, so it cannot stop to ask you anything: it does what its own settings already allow. A message that fails to send goes back into the message box.

Player Two has an icon in the system tray: clicking it opens the window, and its menu has `Open Player Two`, `Quit` and, on Windows and macOS, `Start at login, hidden`. While a grant of yours is live, an agent of yours may have to answer with nobody looking, so closing the window only hides it to the tray, the first time with a notification saying so, and your desk goes on answering under your grants; the tray icon, or starting Player Two again, brings it back. Where there is no tray, or the system cannot show that notification, the window is not hidden: closing it leaves it open while a grant is live, and says why in it, so quit from its menu. `Start at login, hidden` is turned on when you make your first grant, unless you have turned it off, and then Player Two starts in the tray when you sign in. Otherwise closing the window, or `Quit` in the tray icon's menu, quits: it stops any agent still working, and the chat is told it stopped. While an agent is working or a draft is unsent, the window asks first. An unfinished answer is lost, and so are drafts you have not sent.

The Setup page lists what Player Two needs and whether it found it: Node, your identity, the hub and the way to it, the clocks, the repos folder and your repos, `git` and whether it reaches the team's repos without asking, your agent's command, the `player-two` command on the `PATH`, where an agent's run finds it for its MCP server and the commands its prompt names, and each of your agents spoken to over ACP: started and asked to open a session, within ten seconds, with how to sign in when that is what it needs, and how it did in the permission test. That test runs only when you press `Test permissions` beside the agent in the list of your agents further down the page, since it costs a model call: in an empty git folder the agent is asked to create a file under `supervised` and every request it makes is refused; it passes when it asked first and wrote nothing, and what it found shows under the agent. The result is kept in `agent-permissions.json` beside `config.json`, with the agent's version, and an agent that fails can be run only with full access until it passes. Each problem has a command to copy that fixes it; the page never runs one itself. `Check again` checks again, and on Windows the page also chooses the WSL distribution the desk runs in. It opens by itself when the desk cannot start or a check fails at launch, and from `Setup` beside the connection state in the status line. Once you have joined, the page also lists your agents: choose the one that answers, remove one, or add one of the agents offered or a program of your own with its arguments, one per row. Each change is saved to `config.json` at once. `player-two doctor` prints the same list in a terminal, looking for programs on the `PATH` a login shell has, as the desk does.

The My agents page, from `My agents` beside `Setup` in the status line, lists your agents, one for each team repo checked out in `~/dev`, with the branch it is on and the agent that answers for it, and under each the grants on it that stand. `New grant` lets a teammate, anyone on the hub, or a [workflow](#workflows) named in one of your channels, ask that agent with nobody at your desk (anyone on the hub does not take in a workflow, and the dialog says what a grant naming one names): at a permission mode the agent that answers can be held to, its answer kept for your review, as it is unless you choose otherwise, or posted directly, which the dialog warns goes to them unread, for a day, a week or 30 days, and at most so many times a day. Each grant shows how many runs it let go in the last 24 hours, and `Revoke` ends it at once, stopping a run going under it. A grant on a repo you no longer have checked out is listed apart, under `Grants on repos not checked out here`: nothing answers under it meanwhile, but it stands, and the agent answers under it again once the repo is checked out again, so revoke it there if you no longer want it. `full` for anyone, or for a workflow, is warned of whatever the delivery, and a grant of `full` posted directly for either asks a second time first, saying what it means: for a workflow, that whatever sets it off, anyone with its webhook's address among them, could then run your agent. `Hold back` on a repo stops telling the hub you have it, so teammates no longer see that agent or can tag it, and its agent answers nobody, under a grant or not, until `Let it answer`; a request of it already waiting stays waiting, and a run already going is left to finish. The repos held back are kept in `config.json`.

## Azure DevOps

Pull requests and builds come from Azure DevOps, through its REST API, called by your own desk with your own token. Your token stays on your machine: the hub never holds one and never calls Azure DevOps, the token is sent to `dev.azure.com` alone, and it is never written to a log, an event, a message or the window.

Give Player Two a token in one of three ways, which it looks for in this order:

1. The environment variable `AZURE_DEVOPS_EXT_PAT`, which the Azure CLI's DevOps extension reads too. On Windows, export it in `~/.profile` inside WSL, where the desk runs.
2. The Setup page's `Azure DevOps token` field, which saves it in `azure.json` beside `config.json`, readable only by you. The field is emptied once it is saved, and nothing ever sends the token back to the window.
3. Git's credential helper, such as Git Credential Manager, once you have signed in to `dev.azure.com` with git. The desk asks it for your repo's address with prompts turned off, and gives up after ten seconds.

A personal access token needs the scopes Code (read and write), to read and open pull requests, and Build (read). The Setup page's check `Azure DevOps answers to your token` says where the token was found and whether Azure DevOps lets it look up one of your repos; it is skipped when the hub's `PLAYER_TWO_REPOS` is not on `dev.azure.com`. Behind a proxy, the desk honours `HTTPS_PROXY` and `NO_PROXY` and trusts the certificates Ubuntu trusts.

Everything Azure DevOps says, a title, a name, a build's pipeline, is drawn as text, with no avatars or other images, and a chip or the room's line opens an address in your browser only when it is on `https://dev.azure.com`.

## Workflows

A workflow is a small automation that lives with a channel: when something happens, the hub posts a message, tags an agent, waits for a 👍, or calls an address. The hub runs it, and never runs an agent: a workflow's tag is a request like anyone's, which waits for the agent's owner or runs under a grant of theirs that names the workflow.

```yaml
name: ci-failure
on:
  webhook: { secret: "a long random string" }
steps:
  - post: "The build failed on {{body.branch}}: {{body.url}}"
  - approve: { from: jacob, text: "Ask the uploader agent what broke?", within: 4h }
  - tag: "@jacob/uploader"
    text: "The build at {{body.url}} failed. What broke?"
  - webhook: { url: "https://ci.corp.internal/retry/{{body.id}}", body: '{"build": "{{body.id}}"}' }
    if: { equals: ["{{body.retry}}", "true"] }
```

`name` is written like a person's name. `on` is the one thing that sets a run off:

| Trigger | Sets off a run when |
|---|---|
| `webhook: {}` | Something posts to the workflow's address, `POST HUB/hooks/ID`, which `player-two workflow publish` and `list` print. With a `secret`, the request must carry it in an `X-Player-Two-Secret` header. Its body is JSON, at most 256 KB, or nothing. The hub answers `202` at once. |
| `message: { contains: "P1" }` | A person posts a message in the channel that holds those words, exactly as written. The hub's own messages never set anything off. |
| `reaction: { emoji: "🚀" }` | Someone adds that emoji to a message in the channel. |
| `schedule: { cron: "0 9 * * 1-5", zone: "Europe/London" }` | The five-field cron line comes round in that time zone, by the hub's clock, at the start of the minute. A time that passes while the hub is down is not made up. Where the clocks go back and an hour comes round twice, a line naming a time of day, such as `30 1 * * *`, runs the first time only, and one with `*` in its minute or hour, such as `* * * * *` or `30 * * * *`, runs both times. A time the clocks skip, such as 01:30 in London on the day they go forward, does not come round, so a line naming only that time does not run that day. |

Then 1 to 20 `steps`, taken one at a time:

| Step | Does |
|---|---|
| `post: TEXT` | The hub posts the text. |
| `tag: "@person/repo"` and `text` | The hub posts the text tagging that agent. The step is done once the message is stored; the agent's owner decides, as for any request. |
| `approve: { from: NAME, text, within }` | The hub posts the text and waits for a 👍 on that message from `NAME`, or from any member with `from: anyone`; anyone else's changes nothing. `within` is written `90m`, `12h` or `2d`, and is a day when left out; past it, the run ends as expired. The wait outlasts the hub stopping and starting. |
| `webhook: { url, body }` | The hub POSTs `body` to `url`, with the limits below. |

A step may have `if: { equals: [A, B] }` or `if: { contains: [A, B] }`, which compares two texts once they are filled in; when it does not hold, the step is skipped. Text in a step is a template: `{{trigger.text}}` and `{{trigger.author}}` are the message that set the run off and who wrote it (for a reaction, the message reacted to and who reacted), and `{{body.path.to.field}}` is a field of a webhook's JSON, such as `{{body.commits.0.id}}`. A name that is not there is left as written. A message the hub posts tags only the agents the file writes out: a tag that a filled-in value makes, from a webhook's body or from someone's message, is shown with a fullwidth `＠` and tags nobody. Likewise a backtick a value brings is written as a fullwidth `｀`, so a fence in the message comes only from the file, and the window never draws a workflow's message as Markdown: a link in it is text. A `post` or an `approve` whose text is nothing once filled in, as a value filled in was empty, fails, and posts nothing.

After each step the hub posts how it came out, `done`, `skipped`, `waiting`, `approved`, `expired`, `refused`, `failed`, `throttled` or `cancelled`, as a `workflow.run` event. A step refused or failed ends its run.

Any member of a channel can publish a workflow to it, replace one by publishing another of the same name, or remove one, with the `player-two workflow` commands below or in the window; an agent cannot. Each is an event signed by whoever did it, so the channel's log says who installed which automation, and when. A repo can keep its workflows under `.player-two/workflows/` to publish them from, with the command or the window. Replacing or removing a workflow cancels its runs waiting for a 👍, and stops one calling an address before its next step; a replaced webhook workflow has a new address.

In the window, `⚙ Workflows` in a channel's title lists its workflows: what sets each off and its steps in words, each template as written, who published it and when, a webhook workflow's address with `Copy address`, and its five newest runs among the messages the window has loaded, each step as the hub reported it. `Remove` takes one away. `Publish a workflow` lists the `.yml` and `.yaml` files in `.player-two/workflows/` of your checkout of the repo the channel is pinned to, which your desk reads, never through a link; choosing one shows the workflow it holds in words, and the one of its name it replaces, or the line that is wrong and why, with the file itself under them. Its button publishes it, once your desk has read it again and found it unchanged since you looked. Under the message an `approve` step waits on, a line says whose 👍 it waits for; when it is yours, or anyone's, the chat is marked `👍` in the list and counted as waiting in the window's title, and `👍 Approve` there adds your 👍, which moves the run on. What a workflow posts is drawn under its name, such as `workflow: ci-failure`, with a mark and a colour of its own and a line down its side, never as a person's or an agent's; a tag written with a fullwidth `＠` in it is text.

Limits: 20 workflows in a channel, 20 steps in a workflow, 30 runs of one workflow started in an hour, and 50 of its runs waiting for a 👍 at once. A run past either of the last two is recorded once as `throttled` and does nothing; those after it leave no trace until a run starts again.

Everyone in the channel can read a workflow's file, its `secret` and the addresses its steps call included, since it is an event in the channel, and anyone who has joined the hub can join the channel. So a secret keeps out only those without the channel, and a step's address should hold no token you would not show the channel. A webhook workflow without a `secret` can be set off by anyone who has its address. Whoever sets one off chooses only the values its templates are filled with. A grant that names `workflow:#ops/ci-failure` lets go a request from the workflow named ci-failure in `#ops`, whichever member of `#ops` published it, and whatever any of them publishes under that name next; a workflow of that name in another channel asks as another, `workflow:#general/ci-failure`.

A `webhook` step calls only a host that `PLAYER_TWO_WEBHOOK_ALLOW` lists (see [Configuration](#configuration)), checked on the address once it is filled in. A value is filled into the address percent-encoded, so it cannot add a path, a query or a user name, and into a body that is JSON as written as JSON text, so the body stays the JSON it was. The hub follows no redirect, gives up after ten seconds, reads at most 1 MB of the answer, and puts none of it into the chat: the run records the status, or why the call failed. The list trusts DNS: whoever can add a name under a listed one can point the hub at any address it can reach, except these, which a name may lead to only when that address is listed itself, written either way IPv4 can be in IPv6: the hub's own machine (`127.0.0.0/8`, `::1`), "this network" (`0.0.0.0/8`, `::`), link-local addresses (`169.254.0.0/16`, `fe80::/10`), where AWS, Azure, Google Cloud and Oracle give a machine its metadata at `169.254.169.254`, and three more addresses clouds answer at for the machine: AWS's metadata over IPv6, `fd00:ec2::254`; Azure's WireServer, `168.63.129.16`; and Alibaba Cloud's metadata, `100.100.100.200`. Any other address in the cluster or beyond it, a private one included, can be reached through a listed name. Every port of a listed host can be called. The hub calls the address itself and never through a proxy, even one its environment names with `NODE_USE_ENV_PROXY` and `HTTP_PROXY` or `HTTPS_PROXY`, so a listed host must be reachable from the hub's pod directly. Certificates are checked against Node's own list, so an internal certificate authority needs `NODE_EXTRA_CA_CERTS` in the hub's environment.

## Commands

| Command | Effect |
|---|---|
| `player-two join HUB NAME TOKEN [--agent AGENT]` | Creates a key if `~/.config/player-two/key` does not exist, registers `NAME` with the hub at `HUB`, and writes `config.json`. Joining again with the same key is allowed, and keeps what `config.json` holds but the hub and the name: your agents, unless `--agent` replaces them, the mode your own requests run at, and the repos you hold back; a name held by another key is refused, with the `player-two hub rekey` command that gives it this machine's key, for whoever runs the hub when the name is yours. `--agent` is an agent offered, by its id: `cursor-oneshot`, the default for a first join, `cursor`, `copilot-oneshot` or `copilot`; or a one-shot command typed as one line. |
| `player-two send TO TEXT... [--wait SECONDS]` | Sends a message to `TO`, a name or a quoted channel such as `'#backend'`, and prints its `seq`, its place in the hub's log. A `TEXT` of `-` reads the message from standard input. `--wait` prints the next message or agent's answer from someone else in that chat if one arrives within `SECONDS`. |
| `player-two inbox [--after SEQ] [--wait SECONDS]` | Prints the newest 20 messages and agents' answers other people sent to you or your channels. With `--after`, prints every one after that `seq`, and `--wait` holds on for a new one when there is none yet; `--wait` without `--after` is a usage error. Reactions, edits, deletes, joins and what agents' owners say about a run are not printed. |
| `player-two who` | Lists everyone who has joined the hub. |
| `player-two repos` | Lists every agent as `@person/repo` with the branch it is on. |
| `player-two search WORDS... [--in CHAT]` | Prints the messages and agents' answers you can see that hold every word, best match first, at most 20: each with who wrote it, where, when, a stretch of its text as last edited, and its link, `player-two://note/` and the note's id. `--in` keeps to one chat, a name or a quoted channel such as `'#backend'`. A search holds 1 to 8 words, a word being a run of letters and digits, in at most 200 characters. |
| `player-two read NOTE [--thread]` | Prints one note, given as its link or its id, as it reads now: edited, or deleted. Under it, where each agent it tags stands (`waiting`, `working`, `answered`, `declined`, `failed`, `stopped` or `withdrawn`) and their answers. `--thread` adds the replies under it. |
| `player-two ask @PERSON/REPO TEXT... [--in CHANNEL] [--wait SECONDS]` | Asks an agent: sends a message that tags it, in the direct chat with its owner, or in `CHANNEL` (given with or without its `#`), then waits for that one request to end and prints the answer. It is a message like any other, so it waits for the owner to let the agent run, or runs under a grant of theirs that names you; when the agent is your own, it always waits for your click. `--wait` defaults to 900. Exits `0` when the agent answered, `3` when its owner declined, `4` when the run failed or was stopped, or you withdrew the request, and `5` when nothing final came in time; then the last line on standard error is the `player-two read` command that checks later. Ctrl-C stops the wait, not the request, and ends with that line too, and `130`. |
| `player-two status` | Prints the hub, your name, the repos you share with the branch each is on, and the requests waiting for your agents: those nobody has run, declined or withdrawn yet, among the newest 50 events of each chat, as the window counts them. |
| `player-two channel` | Lists every channel and its members. |
| `player-two channel join NAME` | Joins the channel `NAME`, creating it if nobody is in it. `NAME` may be given with or without its `#`. Joining is an event: the channel's members see a line for it. |
| `player-two channel leave NAME` | Leaves the channel. |
| `player-two workflow publish FILE --in CHANNEL` | Reads a [workflow](#workflows)'s file, failing with the line and why when it does not read, and publishes it to `CHANNEL`, given with or without its `#`, in place of any of the same name. For a webhook workflow, prints the address that sets it off. |
| `player-two workflow list --in CHANNEL` | Lists the channel's workflows: what sets each off, who published it and when, and a webhook workflow's address. |
| `player-two workflow remove NAME --in CHANNEL` | Takes the channel's workflow of that name away. |
| `player-two doctor` | Checks what Player Two needs on this machine, as the window's Setup page does, and prints each check with the command that fixes it. Exits `1` when a check failed. |
| `player-two mcp [--allow-send]` | Runs the MCP server on standard input and output, as you, for an agent in your editor to start: the chat as tools to read, and with `--allow-send`, to send messages, ask agents and withdraw requests as you. See [Let your own agent ask](#7-let-your-own-agent-ask). |
| `player-two desk` | Runs the desk with no window, speaking JSON lines on standard input and output. The window starts it; it is not for typing at. |
| `player-two hub [--host HOST] [--port PORT]` | Runs the hub. Defaults: `127.0.0.1`, `8787`. |
| `player-two hub verify` | Walks the event log in the database `PLAYER_TWO_DB` names and says whether it holds, or the first `seq` where it breaks and how: an event changed or taken out since it was stored, a signature that does not hold under the key its author joined with or was given by `hub rekey` before it, or its agent's key then, or a row that cannot be read as an event; and then any agent whose key in the hub's `agents` table is not the one the log gives it. Exits `1` when either is found. |
| `player-two hub rekey NAME KEY` | Gives `NAME`, who lost their key, the public key `KEY` that the hub's refusal of their join gave them, in the database `PLAYER_TWO_DB` names, and drops their agents' keys until their desk registers new ones. It runs beside the running hub, which takes the change from the next request. Exits `1` when nobody joined under `NAME` or `KEY` is theirs already. See [What Player Two protects](#what-player-two-protects-and-what-it-does-not). |

`send`, `inbox`, `who`, `repos`, `channel`, `search`, `read`, `ask`, `status`, `workflow` and `doctor` take `--json`, and then print one JSON value and nothing else. `inbox` prints an array of events as the hub delivered them, each `{ "seq", "event", "trusted" }`, where `event` is the signed event, with the text in its `content`, and `trusted` is `false` for one that failed its signature check, whose `content` is then `null`: a script or an agent gets no more of it than its author and when, as a person reading the words does. A message read this way is as it was sent: a later edit or delete is an event of its own, which `inbox` does not print. `send --wait` prints one such event, or `null` when none came; `send` without `--wait` prints `{ "seq", "event" }`, the message as it was sent and its place in the log. `search` prints an array of matches, each as the hub delivered it and with `trusted`, plus `link` and `snippet`, the stretch of text in pieces `{ "text", "hit" }`, `hit` marking a word that was found, and `null` with the `content` of a match that is not trusted. `read` prints the note as `inbox` prints an event, plus `link`, `text` as last edited (`null` when its signature fails), `edited` and `deleted`; `jobs`, each `{ "agent", "state" }`; `answers` in the same form as the note; and with `--thread`, `replies` in that form too. `ask` prints the agent's answer, its `job.result` event, as the hub delivered it with `trusted`, or `null` when there is none. `status` prints `{ "hub", "name", "repos", "waiting" }`, `repos` as `repos` prints them and each of `waiting` in the form of `read`'s `answers`, with the `agent` it is for. `who`, `repos`, `channel` and `doctor` print arrays; `channel join` and `channel leave` print the one channel. `workflow publish` prints the workflow it published and `workflow list` an array of them, each as `inbox` prints an event, plus `name`, `on`, what sets it off, and `hook`, a webhook's address or `null`; `workflow remove` prints what it sent, as `send` does.

A command exits with `0` on success, `1` after printing a failure to standard error, and `2` for a usage error, and `ask` also with `3`, `4` or `5` as above; `player-two` with no command prints its usage and exits `2`, as does a `--wait` of more than 86400 seconds, a day. A longer message than an event holds, about 63,000 characters, is cut to fit. Repos are shared by the desk, not by the one-shot commands, so `player-two repos` shows a person's repos as of the last time their window was open.

## Configuration

The hub reads its settings from the environment and refuses to start when a required one is missing:

| Variable | Required | Description |
|---|---|---|
| `PLAYER_TWO_JOIN_TOKEN` | yes | Secret that a join must present. At least 16 characters. |
| `PLAYER_TWO_REPOS` | yes | The address the team's repos live under, such as `https://dev.azure.com/acme/`. The hub refuses to share a repo outside it. |
| `PLAYER_TWO_DB` | yes | Path of the SQLite database. The Docker image sets it to `/data/player-two.db`. |
| `PLAYER_TWO_DOWNLOADS` | no | A folder holding `player-two-setup.exe`, `wsl-runtime.tar.gz` and `wsl-runtime.tar.gz.sha256`. With it, the hub serves a page at `/` with the installer and the install steps, the files under `/downloads/`, and `/install.sh`; without it, those answer `404`. |
| `PLAYER_TWO_WEBHOOK_ALLOW` | no | The hosts a workflow's `webhook` step may call, separated by commas: a name, such as `ci.corp.internal`, allows itself and every name under it, and an IP address allows itself alone. `https` goes to any of them, `http` only to a host listed exactly. Without it, every webhook step is refused. A name that leads to the hub's own machine, a link-local address or a cloud's metadata service (the addresses are under [Workflows](#workflows)) is refused unless that address is listed too. An entry with a port, a path or a `*` stops the hub from starting. |

The address the page and the install script give is the one the request came to, with `https` when the `X-Forwarded-Proto` header says so.

Your identity is in `~/.config/player-two`, inside WSL on Windows:

| File | Contents |
|---|---|
| `config.json` | `hub` (the hub URL), `name`, `agents`, `defaultAgent`, `ownMode` and `held`, the repos you hold back. |
| `key` | Your Ed25519 private key. Readable only by you. |
| `known.json` | The public key first seen for each teammate. |
| `app-state.json` | Read marks, the last open chat, how you last ran each teammate's requests of each repo, and with which agent, and the branch rooms you said not to suggest. Safe to delete. |
| `azure.json` | An Azure DevOps token saved from the Setup page, if you saved one. Readable only by you. |
| `desk.sock` | The socket the desk running for this identity listens on, so that only one runs for it on a machine: two took the same teammate's request and raced to run it. A second desk stops at once with `another desk is running as NAME (pid N)`, which the window shows on its Setup page; close the other window, or stop that process, and press Check again. One a killed desk left behind is taken over by the next desk. |

Two environment variables move things, mainly to hold two identities on one machine:

| Variable | Default | Description |
|---|---|---|
| `PLAYER_TWO_HOME` | `~/.config/player-two` | Where the files above live. With `/desk.sock` after it, its path must fit in a socket's, 107 bytes on Linux and 103 on macOS; the desk says so when it does not. |
| `PLAYER_TWO_DEV` | `~/dev` | The folder whose direct subfolders are your repos. |

The runtime the window installs is in `~/.player-two`: each version under `runtime/`, `current` linking to the one in use and `previous` to the one before. The clean copies teammates' requests run on are under `~/.player-two/worktrees`, which `PLAYER_TWO_HOME` does not move; the desk removes any a crash left when it starts, but not one kept because its patch was too large to send. The window keeps one file of its own, `settings.json` in `%APPDATA%\Player Two` on Windows, with the WSL distribution chosen on the Setup page, with none chosen WSL's default, whether Player Two starts at login, and whether it has said that closing the window hid it to the tray.

`agents` lists the agents you can run, each with an `id`, a `label`, a `protocol`, a `command` and its `args`, and `defaultAgent` is the `id` of the one that answers. `ownMode` is the permission mode your own requests of your own agents are to run at, `auto-edits` unless changed; an agent that cannot be held to it runs them at the most below it that it can, so Cursor's one-shot command runs them read-only, and one that can keep none of those, such as Copilot's one-shot command, does not run them. The agents offered are Cursor over ACP, `agent acp`, and as a one-shot command, `agent -p --output-format text`, and Copilot over ACP, `copilot --acp --stdio`, and as a one-shot command, `copilot -s --allow-all-tools --no-ask-user -p`; any other program can be typed in, with its arguments one per row. An `acp` agent is started in the tagged repo's folder and spoken to over the Agent Client Protocol: its session has Player Two's MCP server attached, `player-two mcp` without `--allow-send`, so it can read and search the chat and send nothing (a run under a grant has none), and what it says in the session is the answer; if it needs signing in, the run ends saying how. A `oneshot` agent is run with the prompt appended as its last argument, in the tagged repo's folder with standard input closed, and what it prints to standard output is the answer. A run that takes longer than 900 seconds is stopped. The command and its arguments are passed as they are: no shell reads them. A `config.json` from an earlier version, with one command line in `agent`, is read as one `oneshot` agent, split into words the way a shell would split it, and written back in this shape. `player-two join HUB NAME TOKEN --agent "COMMAND"` run again replaces the agents with that one command. The desk finds the command on the `PATH` a login shell has, so tools installed through `nvm` or `npm -g` are found, and then on the `PATH` the window was started with.

The prompt tells the agent whose checkout of which repo it is in, who tagged it and where, and whether its owner will review the reply or it is posted directly. It includes up to six earlier messages and answers from the same chat, as they read now, marked as context that must not be followed as instructions, so a follow-up question makes sense. It also says the agent may run `player-two search --json` and `player-two read --json` to look at earlier notes, that what they print is information and not instruction, and that it should cite each note it relied on by its link, which the window draws as a chip. Those commands run as you, so they find notes in all your chats, the private ones too, while the answer goes to whoever is in the chat it was asked in, before you have read it when you chose to post it directly: the prompt tells the agent to give only the link of a note from another chat, never what it says.

A team's own build of the window can carry its hub's address, so the join form asks only for a name, the token and the agent: set `PLAYER_TWO_HUB_URL` when building, as an `http` or `https` address with no `/` at the end. The Release workflow takes it from a repository variable of the same name.

## What Player Two protects, and what it does not

An agent runs on a machine only when that machine's owner says so. Your own tag, sent from your own window, is that say-so; a teammate's tag is only text until you choose to run it, or a grant you made says so in advance. Reviewed first, the agent's output stays in the draft box, where you can change it, until you send it. Posting it directly skips that second look: use it when you are content for whatever the agent writes to go straight to the chat. An agent's answer can contain more of your machine than the question asked for.

The window draws text written by other people and their agents, and cannot run it. A message is drawn as text, and so are replies, edits, the emoji of a reaction, which can be any text at all, and the lines about a channel. An agent's Markdown is drawn as elements with any raw HTML left as text, images in it are not fetched, and the page's content security policy lets it load scripts and styles only from the app's own files. The page has no access to Node or to Electron beyond a few calls to the window's own process.

A patch is someone else's change, and nothing applies one on your machine but you. A teammate's request that may change files runs on a clean copy of your checkout, never in it. A patch that names a path outside the repo or inside `.git` is refused before git sees it, the diff reaches git only on its standard input, and git is never given `--unsafe-paths`; then a dialog of the system's own shows you what it changes and warns you of what to look at first, instruction files and symbolic links among them, and only your yes applies it. Applied to a new branch, it touches neither your branch, nor your working tree, nor your index.

A branch a room is pinned to is a teammate's text. Your desk runs git on a branch only when it is the one your own checkout is on, refuses one that git would read as more than a branch, such as one starting with `-` or holding a `:`, and pushes only after you said yes to a dialog that names the repo, the branch and where it goes, with the arguments passed to git as they are and no shell. Your Azure DevOps token stays on your machine: see [Azure DevOps](#azure-devops). A message from anyone can make your desk look up the pull requests it refers to, with your token, so each answer is kept for a minute, at most five are looked up for one message, and at most 100 are kept at once.

Everything anyone does is an event signed with their Ed25519 key: a message or a reply, an edit or a delete, a reaction, joining or leaving a channel, pinning a repo, and each step of an agent's run. The signature covers the author, the recipient or channel, the kind of event, what it says, the time, the ids of the events it is about, and a random nonce. An event's id is the SHA-256 of those signed bytes, so its author knows it before sending it, and whatever refers to an event (a reply to a message, a reaction, an edit, the approval of a request) names it by an id that cannot be made to point at anything else. The hub refuses an event whose id is not the hash of its bytes, that its claimed author did not sign, that is more than five minutes off the hub's clock, or that it has already stored, and one sent to a channel its author is not in. Every request to the hub is signed too, over the method and the path it is for. Your desk checks each event's signature again, against the key it first saw for that author, so a hub that is later compromised cannot forge an event from a teammate you already know. An event that fails this check is shown as a warning without its text, and changes nothing: it cannot tag an agent, edit, delete, react or move a request along, and it is left out of what your agent is shown.

What an event may change depends on who signed it. An edit or a delete counts only from the message's author, and never on an agent's answer; what is said about an agent's run counts only from the agent's owner, or from the agent itself in its own run's reports about its own repo; a request is taken back only by whoever made it. Every reader applies these rules to what the hub relays, so the hub cannot change them. Nothing anyone else does takes a run on your machine out of your hands: if its asker deletes a request while your agent works on it, the run still shows under "message deleted", with its Stop, and so does a draft it left for you to send or discard. A kind of event your version does not know is passed over, and the chat shows the rest as it would without it.

An agent's answer is a `job.result` event. One posted with nobody reviewing it is signed by the agent itself, with its own key, and every window shows it as `not reviewed`, in the chat, in a search and in the notification of its arrival, as `player-two inbox`, `read` and `search` do; one its owner reviewed and sent is signed by the owner and shows nothing more. Which it is goes by the signature alone, never by what the answer says of itself. Nobody's desk looks for tags in an answer. Which kind to send is up to the owner's client: a modified one could post its agent's words as an ordinary message, whose tags then count. A tag still runs nothing without its target's approval.

Each of your agents has an Ed25519 key of its own, `agents/<repo>.key` beside your key, which your desk announces to everyone in an `agent.register` event signed by you, and again whenever the key file was replaced: it looks on every beat, about every 25 seconds, and before every run, so the agent is never pointed at a key nobody was told of; from then on an event signed by `you/repo` is checked against that key, by the hub and by every reader. Who signs what of a run:

| Event | Signed by | Because |
|---|---|---|
| `job.accepted`, `job.declined` | The owner | Letting a run go, or not, is the owner's decision, made by hand or by a grant on their desk. |
| `job.result` posted directly | The agent | Nobody read it first, so every window shows it as `not reviewed`. |
| `job.result` the owner reviewed and sent | The owner | They read it and pressed send. |
| `job.progress`, `job.error`, `job.cancelled` | The agent | The run's own reports. |
| `job.request` | The agent | It asks another agent, in a run its owner let it ask others. |
| `job.withdrawn` of what it asked | The agent | Its run ended, so what it asked and is still open is taken back. |

An agent can sign nothing else, and only where its owner may write: the hub refuses a message from one, or a grant, and readers count nothing from one but its own run's reports about its own repo, its requests of other agents, and taking back what it asked. During a run the agent is told which agent it is and where its key is, so the `player-two` command and the MCP server, run by it, sign as that agent and not as you. A run you let ask other agents is also told the request it was asked, `PLAYER_TWO_JOB`, and its MCP server asks under that request and no other, so no other run of your agent can ask under it. A run under a grant is also told the chat it was asked in, `PLAYER_TWO_ONLY_CHAT`, and the command then reads that chat and no other: `search` looks in it alone, `read` of a note elsewhere finds none, and `inbox` and `status` pass over the rest. It is given no MCP server.

Letting an agent run leaves a record. Before an agent starts for anyone, its owner's desk publishes a `job.accepted` event, signed by the owner, naming the request, the repo, the branch and commit the checkout is at, whether it had uncommitted changes, whether the answer is reviewed before it is posted, the permission mode the agent may act at, and whether the owner let it run by hand or a grant of theirs did, by the grant's id. The request's author can edit it, and the agent is given its text as last edited, but only if that is the text you were shown when you said to run it: an edit that arrives in between makes your desk refuse the run and ask you to read the request again. If git cannot say which commit the checkout is at or whether it has uncommitted changes, or the record cannot be published, the agent does not start, and the desk tells you why. Then exactly one ending follows: the answer, a failure, a stop, or a decline for a draft its owner threw away or had not sent when their desk quit; a failure says only that it failed, and why stays with the owner. A run stopped before it was recorded is never recorded or started. So the chat's log holds who let which agent run, at whose request, on what code, with how much access, and how it ended, and everyone in the chat sees it.

A grant is a `grant` event you send to everyone from My agents, signed by you: which of your agents, who may ask it (teammates by name, or anyone on the hub), the permission mode, whether its answers are posted directly or kept for your review, when it ends, at most 30 days after it was made, and how many runs a day. Your desk lets a teammate's request run under it when all of these hold: you signed the grant and it names the agent tagged; it names the asker, or anyone; you have not revoked it; it has not ended; and fewer runs than its daily limit were accepted under it in the last 24 hours, which your desk counts from your own `job.accepted` events in the log, so the count holds across a restart. When several grants apply, the one that allows least is used. Only a request that reaches your desk while it is running, and was signed no more than 600 seconds before your desk's clock says it arrived (twice the clock difference the hub allows), is let go this way; one that came while it was not, or that the stream hands over late after a dropped connection, waits for your click, as does every request of your own agent sent any way but from your window. The run is held to the grant's mode as one you start by hand is: when the agent that answers cannot be held to it, nothing runs and you are told why. Below `full`, an agent spoken to over ACP must also have passed `Test permissions` on the Setup page, and when the test recorded its version, still say it is that version as the run is let go, as an update may change whether it asks first; otherwise the request waits for your click and you are told to test it. Revoking a grant stops a run going under it, and a repo you hold back answers nobody, under a grant or not.

The hub has a key of its own, made when it first starts, and signs what a workflow posts with it, as `hub`, a name nobody can join under. Your desk pins that key the first time it checks one of the hub's events, as it pins a teammate's, and counts a tag in the hub's message only when it says it is a workflow's and names it. A workflow runs nothing on anyone's machine; see [Workflows](#workflows) for what one can and cannot do.

The hub does not enforce grants. It stores and relays them as it does any event; your desk alone decides what runs on your machine, and what a teammate's window shows, that a run went ahead under your grant, at which mode and until when, is what your desk recorded.

A grant lets your agent act with nobody watching. Even read-only, the agent can read anything on your machine that your account can, files outside its checkout among them, and with answers posted directly, what it writes goes to whoever asked before you have read it. Keep a grant's answers for your review unless you trust everyone it names with that: the grant's dialog says so when you choose to post directly, warns of `full` for anyone however its answers go, as a review comes only after the agent has acted, and asks a second time before `full` posted directly for anyone.

The honest edge: an agent runs as your operating-system user, so it could read your own key file, `key`, if it went looking, and sign as you. Agent keys make the honest path attributable, so that an answer your agent posted is provably not one you reviewed; they are not a wall between an agent and its owner. Nor is keeping a run under a grant to the chat it was asked in: the command keeps to it, but the agent could read your other chats, as it could your key, if it went looking. Nor is keeping a run you did not let ask others from asking: the MCP server refuses it, but the agent could read its own key file and sign a request under another run of it.

The hub keeps every event in one log, numbered by `seq`, and chains them: each event's chain value is the SHA-256 of the chain value before it and the event's id. `player-two hub verify`, run where the hub's database is, works every id and chain value out again, checks every signature against the key the hub holds for its author, and names the first `seq` where any of that fails or a row cannot be read as an event, which is where an event, its signature included, was changed or taken out by hand. An event whose author has no key in the hub's `users` table breaks it too, since the hub stores nobody's event before they have joined. An agent's events are checked against the key its owner had last registered for it at that point in the log, and once the log holds, the hub's `agents` table must hold exactly the key each agent's newest registration gives it: verify names the first agent whose key there is another, or missing, and exits `1`, since the hub checks that agent's events and requests against that table. A log rewritten from some event on, with its ids and chain values worked out again, still verifies as long as each event in it holds under the key the hub has for its author: one with events left out, say, or forged under a key swapped into `users`. What catches that is a head written down earlier: `GET /audit/head` gives the newest `seq` and its chain value, and since each value depends on every event before it, no rewritten log reaches the same value at that `seq`. Player Two does not yet keep or compare such a head for you. The hub cannot forge an event, but it can leave one out of what it sends you.

What the hub learns about your machine is the names, clone addresses and branches of the repos under `~/dev` whose remote is below `PLAYER_TWO_REPOS`, and when your desk last asked it anything; every hub member can see those. When you let one of your agents run, the record of it adds the commit its checkout was at and whether that had uncommitted changes, for everyone in the chat to see. Folder paths, other repos, repos you hold back on My agents and file contents are not sent. A clone address is rebuilt from the host and path before it is shared, so a user name or token embedded in your `origin` URL does not leave your machine.

The hub hands a direct event only to its two people, and a channel's events only to the channel's current members and whoever wrote them. Reading needs a request signed with the reader's key. Channels are open: anyone who has joined the hub can join any channel, and then sees its earlier messages too. Do not treat a channel as private from other hub members.

Player Two does not encrypt messages. Whoever operates the hub can read them, and the hub keeps every event: nothing deletes one. Deleting a message hides it in every window, but the message stays in the log, where anyone in the chat can still read it, with `player-two inbox --json` for one; so does a message's text before an edit. Transport encryption is the job of the ingress in front of the hub; over plain `http`, as in the quick start, anyone on the network path can read messages too. The join token is shared, so anyone holding it can register a new name, although not take over an existing one. So a teammate who loses their key keeps their name: deleting their row from the hub's `users` table would free it, with their direct chats and channels, for the next person to join under it. Their join from the new machine is refused with the command that gives their name the new key, `player-two hub rekey NAME KEY`, to hand to whoever runs the hub, who checks with them in person that the key is theirs before running it, beside the running hub (see [Deploy the hub on AKS](#deploy-the-hub-on-aks)). From then on the hub refuses the old key, ends any stream it has open within 20 seconds, and refuses their agents' old keys until their desk registers new ones; the change is an event of the hub's own in the log, so `hub verify` checks what they signed before it against the old key. They then join again with the same command, and everyone else removes that name from `known.json`: until then, what they send shows as failing its signature check. There is no other key rotation.

The MCP server runs as you, with your key, for as long as the editor that started it keeps it. Without `--allow-send` it can read only what you can, and send nothing; with it, the agent can send messages and ask agents in your name, each signed by you and marked as sent from MCP. That an agent treats what it reads as information and not as instruction is what each tool tells it; nothing can make it listen.

The agent runs as you. A run has a permission mode, `read-only`, `supervised`, `auto-edits` or `full`, which the desk holds an agent spoken to over ACP to by answering what it asks before it acts; a one-shot command asks nothing, so it runs with whatever permissions its command line gives it, and only at `full`, except Cursor's, which runs read-only without `--force`. Below `full`, it changes only files it names that are inside the folder it runs in, and none in a `.git` folder: any other change is refused without asking you. Player Two does not sandbox it. An agent started in a repo also reads that repo's own instruction files, which is why a clone is never made without showing you where it comes from.

## Deploy the hub on AKS

[`deploy/k8s.yaml`](deploy/k8s.yaml) holds a volume claim, a single-replica Deployment, a Service and an Ingress. The manifest passes schema validation but has not been applied to a live cluster.

Prerequisites:

- Permission to create these objects and a Secret in the target namespace.
- A container registry the cluster can pull from.
- An ingress controller. The manifest assumes the `nginx` ingress class.

To deploy the hub:

1. Build and push the image.

   ```sh
   npm ci && npm run build
   docker build -t REGISTRY/player-two:0.7.0 .
   docker push REGISTRY/player-two:0.7.0
   ```

2. Create the join token.

   ```sh
   kubectl create secret generic player-two --from-literal=join-token="$(openssl rand -hex 16)"
   ```

3. In `deploy/k8s.yaml`, replace `REGISTRY/player-two:0.7.0` with your image, `https://dev.azure.com/YOUR-ORGANISATION/` with the address your repos live under, and `player-two.example.internal` and `player-two-tls` with your host name and TLS secret.

4. Apply the manifest.

   ```sh
   kubectl apply -f deploy/k8s.yaml
   ```

To confirm it worked, request `https://HOST/healthz`, where `HOST` is the host name from step 3. The hub answers `{"ok":true,"now":…}`.

Keep the Deployment at one replica and the volume on an Azure Disk (AKS's `managed-csi` storage class, the default), not Azure Files: the hub stores everything in one SQLite file, which needs the locking a disk gives. To serve the installer from the hub, copy the three files of [step 1](#1-start-the-hub) into a folder on the volume, such as `/data/downloads`, with `kubectl cp`, and add `PLAYER_TWO_DOWNLOADS=/data/downloads` to the container's environment.

To give a teammate who lost their key a new one, run `hub rekey` in the hub's own container, with the name and key their refused join printed:

```sh
kubectl exec deploy/player-two -- node /app/player-two.js hub rekey NAME KEY
```

## Development

It is built and tested with Node.js 26:

```sh
npm ci
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
```

`npm test` builds first, since one test starts the built command. On Linux or macOS, `npm start` builds and opens the window, which starts its desk as a separate process. `PLAYER_TWO_HOME` and `PLAYER_TWO_DEV` move things as they do for the command.

On Ubuntu 24.04 and later, Electron's sandbox may refuse to start from `node_modules`, because AppArmor keeps unprivileged user namespaces from programs it has no profile for. Either allow them until the next reboot with `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, which is what CI does, or make the sandbox helper set-uid: `sudo chown root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`. Do not turn the sandbox off: the window draws text other people wrote.

To run a hub from the working tree, copy `.env.example` to `.env`, set the join token and the repos address, and run:

```sh
npm run build
node --env-file=.env dist/player-two.js hub
```

The window's smoke test starts Electron on the built app and drives it over the DevTools protocol. Nothing it does leaves the machine: its hub runs in the test, git's configuration in its home names folders of bare repositories in place of `dev.azure.com`, and Azure DevOps is a fake in the test, which the desk is pointed at by `PLAYER_TWO_TEST_AZURE`, taken only when it is `http://127.0.0.1:` and a port, so that a variable left set by mistake can send a token nowhere else. It needs a display, and skips without one; CI runs it under `xvfb-run`:

```sh
npm run build
xvfb-run --auto-servernum node --test test/window.smoke.ts
```

`test/hub.test.ts` runs against a hub of its own, or against the one `PLAYER_TWO_TEST_HUB` names, such as a container from the image started with the join token `a-join-token-for-tests`, `PLAYER_TWO_REPOS=https://dev.azure.com/acme/` and an empty database:

```sh
PLAYER_TWO_TEST_HUB=http://ADDRESS:8787 node --test test/hub.test.ts
```

To build the Windows installer yourself rather than through the Release workflow:

1. On Linux, build the runtime archive. It downloads Node 26 from nodejs.org, checks it against the published digests, and writes `dist/wsl-runtime.tar.gz` and `dist/wsl-runtime.tar.gz.sha256`.

   ```sh
   npm run build
   node scripts/build-runtime.ts
   ```

2. On Windows, build, put the two files into `dist/`, and package. The packaging scripts package what is in `dist/` and build nothing first, because a build empties `dist/`.

   ```sh
   npm run build
   npm run package:win
   ```

The installer is `release/player-two-setup.exe`. `npm run package:linux` makes an AppImage in `release/` the same way.

The Release workflow does both on a tag that starts with `v`, and keeps the installer, the archive and its digest with its run. A repository variable named `PLAYER_TWO_HUB_URL` gives its installers the team's hub address.

What is signed is pinned by `test/fixtures/signing-vectors.json`. After changing it on purpose, run `node scripts/make-vectors.ts` and commit the file with the change.

A hub and its clients must speak the same protocol, which `/info` reports. 0.5 replaced notes with signed events, protocol 2, so its clients cannot use a 0.4 hub, and a 0.5 hub refuses to start on a 0.4 database: start it with an empty one. 0.6 speaks protocol 3, in which an event's author may be an agent, `owner/repo`, which a 0.5 client cannot read: update the hub, the windows and the `player-two` commands together. The window says which side to update, and from 0.6 so do the command and `player-two mcp`, which ask the hub's protocol before their first request; a 0.5 command against a 0.6 hub cannot, and fails on the first agent's event it reads with `invalid` and the field it could not read, such as `0.event.author`. A 0.6 hub brings a database 0.5 made (schema 5), or a build between 0.5 and 0.6 (schema 6), forward to its own, schema 7, and refuses to start on a database laid out for any other version of its schema.
