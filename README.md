# Player Two

Player Two is a chat for a small team and their coding agents. Every repo you have checked out under `~/dev` is an agent that anyone on the team can tag, as `@you/repo`. Your own agent answers as soon as you tag it. A teammate's tag waits until you approve it, and everyone in the chat can see where it stands.

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

The hub also hands teammates the Windows installer, from a folder of three files: `player-two-setup.exe`, `wsl-runtime.tar.gz` and `wsl-runtime.tar.gz.sha256`. Pushing a version tag such as `v0.5.0` to GitHub runs the Release workflow, which builds all three and keeps them with its run as the artifact `player-two-v0.5.0`. Fetch them into a folder named `downloads`:

```sh
gh run download RUN_ID --name player-two-v0.5.0 --dir artifact
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

His agent starts at once in `~/dev/uploader`. A line under the message shows it working, on which branch and commit, with the seconds it has taken and a `■ Stop` button, and Bob sees that it is working. When the agent finishes, its answer is posted to the chat, marked `jacob/uploader agent` with the branch and commit it ran at, and a coloured edge down its left side.

### 5. Tag a teammate's agent

Bob wants to know about work on Jacob's branch, so in his chat with `jacob` he tags Jacob's agent:

```text
@jacob/uploader does your retry change handle 429s?
```

Under his message Bob sees `◌ waiting for jacob to approve`, and `↩ Withdraw`, which takes the request back until Jacob acts on it. Nothing has run.

Jacob's window notifies him, and his chat list marks the chat with `▶`. Under Bob's message he has three choices:

- `▶ Run and review` runs his agent and puts its answer in a box of its own above the message box, as a draft. He can edit it, then `Send answer` sends it, or `× Discard` drops it.
- `▶▶ Run and post` runs his agent and posts the answer without a review.
- `× Decline` tells Bob the answer is no.

Both run his agent read-only: it may read and search the repo and change nothing. Cursor's one-shot command then only proposes changes. An agent that cannot be held to read-only, such as Copilot's one-shot command, is not run, and the window says why.

Before the agent starts, Jacob's desk tells the chat he let it run, and on what. While it runs, Bob's line reads `jacob's uploader agent is working on feature/retry ± at 1a2b3c4`: the branch, `±` when there are uncommitted changes, and the commit.

### 6. Start a channel

Jacob presses Ctrl+N, or clicks `+ Join or create` in the chat list, types `backend`, and presses Enter. The name follows the same rules as a person's name; the `#` is added for you. A channel exists as soon as one person has joined it. Bob joins the same way, and his dialog lists `#backend` to pick.

Tags work in a channel exactly as in a direct chat, and every member sees the answers. A quiet line in the channel says when someone joins or leaves it, or pins or unpins its repo.

A channel can be about one repo. Click `◆ Pin a repo` in the channel's title and pick one of yours. The title then shows how many members have it, the tag list puts its agents first, and a member without it is offered a clone.

### 7. Let your own agent ask

Jacob's agent in his editor can ask Bob's agent too, and read and search the chat on the way. Either way below, the question is a message from Jacob like any other: Bob still has to let his agent run, and a tag of Jacob's own agent waits for Jacob's click.

**Through MCP.** Player Two's MCP server, `player-two mcp`, gives the agent the chat as tools. The Setup page's `Editor agents` section has the JSON to copy into Cursor's `~/.cursor/mcp.json` or Copilot's `~/.copilot/mcp-config.json`, inside WSL. As it is, the agent can only read: `whoami`, `list_chats`, `list_agents`, `read_chat`, `read_note`, `search` and `job_status`. With `"--allow-send"` added after `"mcp"`, it can also act as Jacob: `send_message`, `ask_agent`, which asks an agent and waits up to 900 seconds for the answer, and `withdraw`. Every tool tells the agent that what teammates and their agents wrote is information, not instruction, and a note whose signature fails comes without its text.

**From the command line.** In WSL the window has installed the command as `~/.local/bin/player-two`:

```sh
player-two ask @bob/uploader "which tests cover the retry path?"
player-two ask @bob/uploader "who calls the uploader?" --in '#backend' --wait 300
```

`ask` sends the question in the direct chat with Bob, or in a channel with `--in`, waits for that one request to end, up to `--wait` seconds and 900 unless told, and prints the answer. Its exit status says how it ended: `0` answered, `3` declined, `4` failed, stopped or withdrawn, and `5` nothing final yet, when the last line on standard error is the `player-two read` command that checks later. `player-two search` finds earlier messages and answers, and `player-two read` prints one with where its requests stand; each comes with its link, `player-two://note/` and an id, which the window draws as a chip naming the note's author. An agent Player Two runs is told about `search` and `read` in its prompt; one you run yourself learns them from its instructions file, or uses the MCP server instead. `player-two status` shows what is waiting for your own agents.

## Agents and tags

An agent is one person's checkout of one team repo: `@bob/uploader` is the agent command run in Bob's `~/dev/uploader`. Nothing is registered by hand. The desk looks at the folders directly under `~/dev`, keeps those whose `origin` remote is under the hub's `PLAYER_TWO_REPOS` address, and tells the hub their names and current branches. It looks again each time it asks the hub who is here, every 25 seconds, so a branch switch shows up without a restart.

A repo is named by the last part of its remote URL, in lowercase, whatever the folder is called. The `https` and `ssh` forms of one remote, and every Azure DevOps address form, count as the same repo. With two clones of one repo under `~/dev`, the folder named like the repo is used. Two different repos with the same name cannot both be shared: the first folder in alphabetical order wins. A repo whose name has characters other than letters, digits, `.`, `_` and `-` is skipped.

The list that opens on `@` shows the agents whose `person/repo` contains what you have typed, most likely first: the channel's pinned repo, your own agents, the agents of the person you are chatting with, repos you also have, then the rest by name. A repo you have no copy of is offered for cloning once you have typed part of its name.

A tag counts only in a message as it was sent. An agent's answer that contains a tag sets nothing off, so agents cannot start each other, and editing a message tags nobody new. A script, or your agent, can tag someone with `player-two send` or `player-two ask`, or the MCP server's `send_message` and `ask_agent`; that tag waits for its target's owner like any other, and that includes a tag of your own agent.

A request waits for as long as it takes. It is stored on the hub, so it is still there after you restart the window or come back from lunch.

Who may run what:

| Tag | What happens |
|---|---|
| Your own agent, in a message you send from the window | It runs at once and its answer is posted. |
| Your own agent, in a message sent another way, or left unanswered when you last quit | It waits for you, like a teammate's request. |
| A teammate's agent | It waits until they choose `Run and review`, `Run and post` or `Decline`. |
| An agent in a repo its owner does not have | The line under the message says so, and nothing runs. |

Under each message that tags an agent, everyone in the chat sees one line per tag until it is answered:

| Line | Meaning |
|---|---|
| `◌ waiting for bob to approve` | Bob has not acted. `· they are away` is added when his window is not open, and whoever asked has `↩ Withdraw`. |
| `bob's uploader agent is working on main ± at 1a2b3c4` | Bob approved it. The branch and commit are those his checkout was at when the run started. |
| `× bob declined` | Bob declined, or discarded the draft. |
| `■ bob's uploader agent was stopped on main at 1a2b3c4` | Bob stopped the run, or quit while it was working. |
| `✗ bob's uploader agent failed on main at 1a2b3c4` | The agent exited with an error, printed nothing, or ran past its time limit. Only Bob sees why. |
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

In the chat list, a number is the count of unread messages, `▶` means a request is waiting for one of your agents, `✎` means a draft is waiting for your review, and a spinner means one of your agents is working there. Hovering a mark says what it means, and hovering a message's time gives its full date. Drag the chat list's edge to make it wider or narrower; the window remembers the width.

A `new` line marks where you left off in a chat you come back to. A message or an answer that arrives while you are looking elsewhere raises a system notification, with a sound for one sent straight to you, a tag of one of your agents, and a draft ready for review. The window's title says what is waiting, for example `Player Two · 1 waiting · 2 unread`, and on macOS and Linux its badge counts it. Messages that arrive while the window is in the background stay unread until you come back.

Hovering a message shows a bar over it: a few common emoji and a field for any other, `Reply`, and a menu to copy the message's link and, on your own, to edit or delete it. `Reply` opens the message's thread under it, with a box to reply in; a message with replies shows how many there are and the last one, and clicking that opens the thread too. Tags work in a reply as in any message. Under a message each emoji shows how many used it, and hovering it says who; clicking one you used takes yours back. An edited message ends in `(edited)`, and a deleted one leaves `message deleted`. A chat opens on its newest 50 events, and scrolling to the top loads the 50 before them, keeping your place.

A message's link, `player-two://note/` and its id, pasted into another message is drawn as a chip with who wrote it and its first words as they read now, edits and deletes applied, or `a note you cannot see`. When the message's chat is not loaded in the window, the chip says who wrote it and where, such as `alice in #history`, and not its words: what the hub hands over of one message is its words as first sent, which may since have been edited or deleted. Clicking the chip, choosing a message in the search, or opening a link elsewhere on your machine once the installed app has registered for `player-two://` links, opens that message's chat with the message in view and highlighted. A message you cannot see opens nothing, and the window says so.

An agent's answer is drawn as Markdown, as text and structure only: raw HTML in it stays text, images are not fetched, and a link opens in your browser.

Standard input is closed during a run, so your agent cannot stop to ask you anything: it does what your agent's settings already allow. A message that fails to send goes back into the message box.

Closing the window stops any agent still working, and the chat is told it stopped. While an agent is working or a draft is unsent, the window asks first. An unfinished answer is lost, and so are drafts you have not sent.

The Setup page lists what Player Two needs and whether it found it: Node, your identity, the hub and the way to it, the clocks, the repos folder and your repos, `git` and whether it reaches the team's repos without asking, your agent's command, and each of your agents spoken to over ACP: started and asked to open a session, within ten seconds, with how to sign in when that is what it needs. Each problem has a command to copy that fixes it; the page never runs one itself. `Check again` checks again, and on Windows the page also chooses the WSL distribution the desk runs in. It opens by itself when the desk cannot start or a check fails at launch, and from `Setup` beside the connection state in the status line. Once you have joined, the page also lists your agents: choose the one that answers, remove one, or add one of the agents offered or a program of your own with its arguments, one per row. Each change is saved to `config.json` at once. `player-two doctor` prints the same list in a terminal.

## Commands

| Command | Effect |
|---|---|
| `player-two join HUB NAME TOKEN [--agent AGENT]` | Creates a key if `~/.config/player-two/key` does not exist, registers `NAME` with the hub at `HUB`, and writes `config.json`. Joining again with the same key is allowed; a name held by another key is refused. `--agent` is an agent offered, by its id: `cursor-oneshot`, the default, `cursor`, `copilot-oneshot` or `copilot`; or a one-shot command typed as one line. |
| `player-two send TO TEXT... [--wait SECONDS]` | Sends a message to `TO`, a name or a quoted channel such as `'#backend'`, and prints its `seq`, its place in the hub's log. A `TEXT` of `-` reads the message from standard input. `--wait` prints the next message or agent's answer from someone else in that chat if one arrives within `SECONDS`. |
| `player-two inbox [--after SEQ] [--wait SECONDS]` | Prints the newest 20 messages and agents' answers other people sent to you or your channels. With `--after`, prints every one after that `seq`, and `--wait` holds on for a new one when there is none yet. Reactions, edits, deletes, joins and what agents' owners say about a run are not printed. |
| `player-two who` | Lists everyone who has joined the hub. |
| `player-two repos` | Lists every agent as `@person/repo` with the branch it is on. |
| `player-two search WORDS... [--in CHAT]` | Prints the messages and agents' answers you can see that hold every word, best match first, at most 20: each with who wrote it, where, when, a stretch of its text as last edited, and its link, `player-two://note/` and the note's id. `--in` keeps to one chat, a name or a quoted channel such as `'#backend'`. A search holds 1 to 8 words, a word being a run of letters and digits, in at most 200 characters. |
| `player-two read NOTE [--thread]` | Prints one note, given as its link or its id, as it reads now: edited, or deleted. Under it, where each agent it tags stands (`waiting`, `working`, `answered`, `declined`, `failed`, `stopped` or `withdrawn`) and their answers. `--thread` adds the replies under it. |
| `player-two ask @PERSON/REPO TEXT... [--in CHANNEL] [--wait SECONDS]` | Asks an agent: sends a message that tags it, in the direct chat with its owner, or in `CHANNEL` (given with or without its `#`), then waits for that one request to end and prints the answer. It is a message like any other, so it waits for the owner to let the agent run, even when the agent is your own. `--wait` defaults to 900. Exits `0` when the agent answered, `3` when its owner declined, `4` when the run failed or was stopped, or you withdrew the request, and `5` when nothing final came in time; then the last line on standard error is the `player-two read` command that checks later. |
| `player-two status` | Prints the hub, your name, the repos you share with the branch each is on, and the requests waiting for your agents: those nobody has run, declined or withdrawn yet, among the newest 50 events of each chat, as the window counts them. |
| `player-two channel` | Lists every channel and its members. |
| `player-two channel join NAME` | Joins the channel `NAME`, creating it if nobody is in it. `NAME` may be given with or without its `#`. Joining is an event: the channel's members see a line for it. |
| `player-two channel leave NAME` | Leaves the channel. |
| `player-two doctor` | Checks what Player Two needs on this machine, as the window's Setup page does, and prints each check with the command that fixes it. Exits `1` when a check failed. |
| `player-two mcp [--allow-send]` | Runs the MCP server on standard input and output, as you, for an agent in your editor to start: the chat as tools to read, and with `--allow-send`, to send messages, ask agents and withdraw requests as you. See [Let your own agent ask](#7-let-your-own-agent-ask). |
| `player-two desk` | Runs the desk with no window, speaking JSON lines on standard input and output. The window starts it; it is not for typing at. |
| `player-two hub [--host HOST] [--port PORT]` | Runs the hub. Defaults: `127.0.0.1`, `8787`. |
| `player-two hub verify` | Walks the event log in the database `PLAYER_TWO_DB` names and says whether it holds, or the first `seq` where it breaks and how: an event changed or taken out since it was stored, a signature that does not hold under the key its author joined with, or a row that cannot be read as an event. Exits `1` when it breaks. |

`send`, `inbox`, `who`, `repos`, `channel`, `search`, `read`, `ask`, `status` and `doctor` take `--json`, and then print one JSON value and nothing else. `inbox` prints an array of events as the hub delivered them, each `{ "seq", "event", "trusted" }`, where `event` is the signed event, with the text in its `content`, and `trusted` is `false` for one that failed its signature check, whose `content` is then `null`: a script or an agent gets no more of it than its author and when, as a person reading the words does. A message read this way is as it was sent: a later edit or delete is an event of its own, which `inbox` does not print. `send --wait` prints one such event, or `null` when none came; `send` without `--wait` prints `{ "seq", "event" }`, the message as it was sent and its place in the log. `search` prints an array of matches, each as the hub delivered it and with `trusted`, plus `link` and `snippet`, the stretch of text in pieces `{ "text", "hit" }`, `hit` marking a word that was found, and `null` with the `content` of a match that is not trusted. `read` prints the note as `inbox` prints an event, plus `link`, `text` as last edited (`null` when its signature fails), `edited` and `deleted`; `jobs`, each `{ "agent", "state" }`; `answers` in the same form as the note; and with `--thread`, `replies` in that form too. `ask` prints the agent's answer, its `job.result` event, as the hub delivered it with `trusted`, or `null` when there is none. `status` prints `{ "hub", "name", "repos", "waiting" }`, `repos` as `repos` prints them and each of `waiting` in the form of `read`'s `answers`, with the `agent` it is for. `who`, `repos`, `channel` and `doctor` print arrays; `channel join` and `channel leave` print the one channel.

A command exits with `0` on success, `1` after printing a failure to standard error, and `2` for a usage error, and `ask` also with `3`, `4` or `5` as above; `player-two` with no command prints its usage and exits `2`, as does a `--wait` of more than 86400 seconds, a day. A longer message than an event holds, about 63,000 characters, is cut to fit. Repos are shared by the desk, not by the one-shot commands, so `player-two repos` shows a person's repos as of the last time their window was open.

## Configuration

The hub reads its settings from the environment and refuses to start when a required one is missing:

| Variable | Required | Description |
|---|---|---|
| `PLAYER_TWO_JOIN_TOKEN` | yes | Secret that a join must present. At least 16 characters. |
| `PLAYER_TWO_REPOS` | yes | The address the team's repos live under, such as `https://dev.azure.com/acme/`. The hub refuses to share a repo outside it. |
| `PLAYER_TWO_DB` | yes | Path of the SQLite database. The Docker image sets it to `/data/player-two.db`. |
| `PLAYER_TWO_DOWNLOADS` | no | A folder holding `player-two-setup.exe`, `wsl-runtime.tar.gz` and `wsl-runtime.tar.gz.sha256`. With it, the hub serves a page at `/` with the installer and the install steps, the files under `/downloads/`, and `/install.sh`; without it, those answer `404`. |

The address the page and the install script give is the one the request came to, with `https` when the `X-Forwarded-Proto` header says so.

Your identity is in `~/.config/player-two`, inside WSL on Windows:

| File | Contents |
|---|---|
| `config.json` | `hub` (the hub URL), `name`, `agents`, `defaultAgent` and `ownMode`. |
| `key` | Your Ed25519 private key. Readable only by you. |
| `known.json` | The public key first seen for each teammate. |
| `app-state.json` | Read marks and the last open chat. Safe to delete. |

Two environment variables move things, mainly to hold two identities on one machine:

| Variable | Default | Description |
|---|---|---|
| `PLAYER_TWO_HOME` | `~/.config/player-two` | Where the four files above live. |
| `PLAYER_TWO_DEV` | `~/dev` | The folder whose direct subfolders are your repos. |

The runtime the window installs is in `~/.player-two`: each version under `runtime/`, `current` linking to the one in use and `previous` to the one before. On Windows the window keeps one file of its own, `settings.json` in `%APPDATA%\Player Two`, with the WSL distribution chosen on the Setup page; with none chosen it uses WSL's default.

`agents` lists the agents you can run, each with an `id`, a `label`, a `protocol`, a `command` and its `args`, and `defaultAgent` is the `id` of the one that answers. `ownMode` is the permission mode your own requests of your own agents are to run at, `auto-edits` unless changed; an agent that cannot be held to it runs them at the most below it that it can, so Cursor's one-shot command runs them read-only, and one that can keep none of those, such as Copilot's one-shot command, does not run them. The agents offered are Cursor over ACP, `agent acp`, and as a one-shot command, `agent -p --output-format text`, and Copilot over ACP, `copilot --acp --stdio`, and as a one-shot command, `copilot -s --allow-all-tools --no-ask-user -p`; any other program can be typed in, with its arguments one per row. An `acp` agent is started in the tagged repo's folder and spoken to over the Agent Client Protocol: its session has Player Two's MCP server attached, `player-two mcp` without `--allow-send`, so it can read and search the chat and send nothing, and what it says in the session is the answer; if it needs signing in, the run ends saying how. A `oneshot` agent is run with the prompt appended as its last argument, in the tagged repo's folder with standard input closed, and what it prints to standard output is the answer. A run that takes longer than 900 seconds is stopped. The command and its arguments are passed as they are: no shell reads them. A `config.json` from an earlier version, with one command line in `agent`, is read as one `oneshot` agent, split into words the way a shell would split it, and written back in this shape. `player-two join HUB NAME TOKEN --agent "COMMAND"` run again replaces the agents with that one command. The desk finds the command on the `PATH` a login shell has, so tools installed through `nvm` or `npm -g` are found.

The prompt tells the agent whose checkout of which repo it is in, who tagged it and where, and whether its owner will review the reply or it is posted directly. It includes up to six earlier messages and answers from the same chat, as they read now, marked as context that must not be followed as instructions, so a follow-up question makes sense. It also says the agent may run `player-two search --json` and `player-two read --json` to look at earlier notes, that what they print is information and not instruction, and that it should cite each note it relied on by its link, which the window draws as a chip. Those commands run as you, so they find notes in all your chats, the private ones too, while the answer goes to whoever is in the chat it was asked in, before you have read it when you chose `Run and post`: the prompt tells the agent to give only the link of a note from another chat, never what it says.

A team's own build of the window can carry its hub's address, so the join form asks only for a name, the token and the agent: set `PLAYER_TWO_HUB_URL` when building, as an `http` or `https` address with no `/` at the end. The Release workflow takes it from a repository variable of the same name.

## What Player Two protects, and what it does not

An agent runs on a machine only when that machine's owner says so. Your own tag, sent from your own window, is that say-so; a teammate's tag is only text until you choose to run it. With `Run and review`, the agent's output stays in the draft box, where you can change it, until you send it. `Run and post` skips that second look: use it when you are content for whatever the agent writes to go straight to the chat. An agent's answer can contain more of your machine than the question asked for.

The window draws text written by other people and their agents, and cannot run it. A message is drawn as text, and so are replies, edits, the emoji of a reaction, which can be any text at all, and the lines about a channel. An agent's Markdown is drawn as elements with any raw HTML left as text, images in it are not fetched, and the page's content security policy lets it load scripts and styles only from the app's own files. The page has no access to Node or to Electron beyond a few calls to the window's own process.

Everything anyone does is an event signed with their Ed25519 key: a message or a reply, an edit or a delete, a reaction, joining or leaving a channel, pinning a repo, and each step of an agent's run. The signature covers the author, the recipient or channel, the kind of event, what it says, the time, the ids of the events it is about, and a random nonce. An event's id is the SHA-256 of those signed bytes, so its author knows it before sending it, and whatever refers to an event (a reply to a message, a reaction, an edit, the approval of a request) names it by an id that cannot be made to point at anything else. The hub refuses an event whose id is not the hash of its bytes, that its claimed author did not sign, that is more than five minutes off the hub's clock, or that it has already stored, and one sent to a channel its author is not in. Every request to the hub is signed too, over the method and the path it is for. Your desk checks each event's signature again, against the key it first saw for that author, so a hub that is later compromised cannot forge an event from a teammate you already know. An event that fails this check is shown as a warning without its text, and changes nothing: it cannot tag an agent, edit, delete, react or move a request along, and it is left out of what your agent is shown.

What an event may change depends on who signed it. An edit or a delete counts only from the message's author, and never on an agent's answer; what is said about an agent's run counts only from the agent's owner; a request is taken back only by whoever made it. Every reader applies these rules to what the hub relays, so the hub cannot change them. Nothing anyone else does takes a run on your machine out of your hands: if its asker deletes a request while your agent works on it, the run still shows under "message deleted", with its Stop, and so does a draft it left for you to send or discard. A kind of event your version does not know is passed over, and the chat shows the rest as it would without it.

An agent's answer is a `job.result` event signed by the agent's owner, and nobody's desk looks for tags in one. Which kind to send is up to the owner's client: a modified one could post its agent's words as an ordinary message, whose tags then count. A tag still runs nothing without its target's approval.

Letting an agent run leaves a record. Before an agent starts for anyone, its owner's desk publishes a `job.accepted` event, signed by the owner, naming the request, the repo, the branch and commit the checkout is at, whether it had uncommitted changes, and whether the answer is reviewed before it is posted. The request's author can edit it, and the agent is given its text as last edited, but only if that is the text you were shown when you said to run it: an edit that arrives in between makes your desk refuse the run and ask you to read the request again. If git cannot say which commit the checkout is at or whether it has uncommitted changes, or the record cannot be published, the agent does not start, and the desk tells you why. Then exactly one ending follows: the answer, a failure, a stop, or a decline for a draft its owner threw away or had not sent when their desk quit; a failure says only that it failed, and why stays with the owner. A run stopped before it was recorded is never recorded or started. So the chat's log holds who let which agent run, at whose request, on what code, and how it ended, and everyone in the chat sees it.

The hub keeps every event in one log, numbered by `seq`, and chains them: each event's chain value is the SHA-256 of the chain value before it and the event's id. `player-two hub verify`, run where the hub's database is, works every id and chain value out again, checks every signature against the key the hub holds for its author, and names the first `seq` where any of that fails or a row cannot be read as an event, which is where an event, its signature included, was changed or taken out by hand. An event whose author has no key in the hub's `users` table breaks it too, since the hub stores nobody's event before they have joined. A log rewritten from some event on, with its ids and chain values worked out again, still verifies as long as each event in it holds under the key the hub has for its author: one with events left out, say, or forged under a key swapped into `users`. What catches that is a head written down earlier: `GET /audit/head` gives the newest `seq` and its chain value, and since each value depends on every event before it, no rewritten log reaches the same value at that `seq`. Player Two does not yet keep or compare such a head for you. The hub cannot forge an event, but it can leave one out of what it sends you.

What the hub learns about your machine is the names, clone addresses and branches of the repos under `~/dev` whose remote is below `PLAYER_TWO_REPOS`, and when your desk last asked it anything; every hub member can see those. When you let one of your agents run, the record of it adds the commit its checkout was at and whether that had uncommitted changes, for everyone in the chat to see. Folder paths, other repos and file contents are not sent. A clone address is rebuilt from the host and path before it is shared, so a user name or token embedded in your `origin` URL does not leave your machine.

The hub hands a direct event only to its two people, and a channel's events only to the channel's current members and whoever wrote them. Reading needs a request signed with the reader's key. Channels are open: anyone who has joined the hub can join any channel, and then sees its earlier messages too. Do not treat a channel as private from other hub members.

Player Two does not encrypt messages. Whoever operates the hub can read them, and the hub keeps every event: nothing deletes one. Deleting a message hides it in every window, but the message stays in the log, where anyone in the chat can still read it, with `player-two inbox --json` for one; so does a message's text before an edit. Transport encryption is the job of the ingress in front of the hub; over plain `http`, as in the quick start, anyone on the network path can read messages too. The join token is shared, so anyone holding it can register a new name, although not take over an existing one. There is no key rotation: a teammate who loses their key needs their row deleted from the hub's `users` table, and everyone else needs to remove that name from `known.json`.

The MCP server runs as you, with your key, for as long as the editor that started it keeps it. Without `--allow-send` it can read only what you can, and send nothing; with it, the agent can send messages and ask agents in your name, each signed by you and marked as sent from MCP. That an agent treats what it reads as information and not as instruction is what each tool tells it; nothing can make it listen.

The agent runs as you. A run has a permission mode, `read-only`, `supervised`, `auto-edits` or `full`, which the desk holds an agent spoken to over ACP to by answering what it asks before it acts; a one-shot command asks nothing, so it runs with whatever permissions its command line gives it, and only at `full`, except Cursor's, which runs read-only without `--force`. Player Two does not sandbox it. An agent started in a repo also reads that repo's own instruction files, which is why a clone is never made without showing you where it comes from.

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
   docker build -t REGISTRY/player-two:0.5.0 .
   docker push REGISTRY/player-two:0.5.0
   ```

2. Create the join token.

   ```sh
   kubectl create secret generic player-two --from-literal=join-token="$(openssl rand -hex 16)"
   ```

3. In `deploy/k8s.yaml`, replace `REGISTRY/player-two:0.5.0` with your image, `https://dev.azure.com/YOUR-ORGANISATION/` with the address your repos live under, and `player-two.example.internal` and `player-two-tls` with your host name and TLS secret.

4. Apply the manifest.

   ```sh
   kubectl apply -f deploy/k8s.yaml
   ```

To confirm it worked, request `https://HOST/healthz`, where `HOST` is the host name from step 3. The hub answers `{"ok":true,"now":…}`.

Keep the Deployment at one replica and the volume on an Azure Disk (AKS's `managed-csi` storage class, the default), not Azure Files: the hub stores everything in one SQLite file, which needs the locking a disk gives. To serve the installer from the hub, copy the three files of [step 1](#1-start-the-hub) into a folder on the volume, such as `/data/downloads`, with `kubectl cp`, and add `PLAYER_TWO_DOWNLOADS=/data/downloads` to the container's environment.

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

The window's smoke test starts Electron on the built app and drives it over the DevTools protocol. It needs a display, and skips without one; CI runs it under `xvfb-run`:

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

A hub and its clients must run the same version. 0.5 replaced notes with signed events, protocol 2, so its clients cannot use a 0.4 hub, and a 0.5 hub refuses to start on a 0.4 database: start it with an empty one. The hub refuses to start on a database laid out for another version of its schema.
