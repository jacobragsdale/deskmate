# deskmate

Deskmate is a terminal chat for a small team and their coding agents. You chat with teammates directly or in channels, and any note someone sends you can be handed to your own agent with one click. Nothing runs on your machine until you approve it, and you read and edit your agent's answer before it is sent.

```text
 deskmate  jacob on deskmate.corp.example · claude -p in ~/dev/uploader                      ? Help
╭─ Chats ────────────────╮╭─ #backend · bob, carol, jacob ─────────────────────────────────────────╮
│  Channels              ││                                                                        │
│› #backend            ✎ ││ bob · 22:35                                                            │
│  + Join or create      ││ where do we retry failed uploads?                                      │
│                        ││                                                                        │
│  People                ││ carol · agent · 22:37                                                  │
│  bob                 1 ││ ┃ bob: where do we retry failed uploads?                               │
│  carol                 ││ Retries live in uploader/queue.py, in Uploader.flush:                  │
│  dana                1 ││                                                                        │
│                        ││ ┃ for attempt in range(3):                                             │
│                        ││ ┃     try:                                                             │
│                        ││ ┃         return self._put(chunk)                                      │
│                        ││ ┃     except TransientError:                                           │
│                        ││ ┃         time.sleep(2**attempt)                                       │
│                        ││                                                                        │
│                        ││ Three attempts with exponential backoff; a fourth failure raises       │
│                        ││ UploadFailed.                                                          │
│                        ││                                                                        │
│                        ││ bob · 22:50                                            ▶ Run my agent  │
│                        ││ thanks. does anything cover the fourth-failure path in tests?          │
│                        ││                                                                        │
│                        ││ ✎ Draft for bob · Enter sends it                             × Discard │
│                        ││ ────────────────────────────────────────────────────────────────────── │
│                        ││ › Yes: `tests/test_queue.py::test_fourth_failure_raises` covers it.    │
│                        ││                                                                        │
│                        ││   It patches `_put` to fail four times and asserts `UploadFailed`.     │
│                        ││   Nothing covers the *sleep* durations, though.                        │
╰────────────────────────╯╰────────────────────────────────────────────────────────────── × Leave ─╯
 Enter send draft  Esc Esc discard  ^↓ next chat  ^N join channel  ^P commands          ● connected
```

## Quick start

This walk-through sets up one hub and two people, `jacob` and `bob`, has Bob's agent answer a question from Jacob, and starts a channel.

The hub needs Docker. Each person needs `curl` and a coding-agent CLI that is installed and signed in. The default is Claude Code's `claude`; for another one, see [Configuration](#configuration).

### 1. Start the hub

One person runs the hub somewhere everyone can reach. With Docker, from a clone of this repository:

```sh
docker build -t deskmate .
docker run -d --name deskmate -p 8787:8787 -e DESKMATE_JOIN_TOKEN=JOIN_TOKEN -v deskmate-data:/data deskmate
```

Replace `JOIN_TOKEN` with a secret of at least 16 characters, for example the output of `openssl rand -hex 16`. Anyone who has it can register a name, so share it only with your teammates. Inside the container the hub listens on every interface, and `-p 8787:8787` publishes it on the host.

Check that the hub answers:

```sh
curl http://localhost:8787/healthz
```

```text
{"ok":true}
```

To run the hub on Kubernetes instead, see [Deploy the hub on Kubernetes](#deploy-the-hub-on-kubernetes).

### 2. Join the hub

Each person runs the hub's installer on their own machine:

```sh
curl -fsSL HUB_URL/install.sh | bash -s -- NAME JOIN_TOKEN
```

Replace the following:

- `HUB_URL`: where the hub is reachable, for example `http://localhost:8787`.
- `NAME`: your name on the hub. Lowercase letters, digits, `-` and `_`, at most 32 characters.
- `JOIN_TOKEN`: the hub's join token.

The installer installs [uv](https://docs.astral.sh/uv/) if it is missing, installs the `deskmate` command from the `main` branch of `github.com/jacobragsdale/deskmate` into `~/.local/bin`, creates a signing key in `~/.config/deskmate`, and registers your name. It needs access to GitHub. The hub and its clients must run the same version, so build the hub image from `main` as well. The installer ends with:

```text
joined http://localhost:8787 as bob; your agent command is `claude -p`
Run 'deskmate' inside the repo you want your agent to answer from.
```

If your shell does not find `deskmate` afterwards, open a new terminal, or add `~/.local/bin` to `PATH`.

To try both people on one machine, give each their own directory by setting `DESKMATE_HOME` for the installer and for every later `deskmate` command, in two terminals:

```sh
curl -fsSL HUB_URL/install.sh | DESKMATE_HOME=~/deskmate-jacob bash -s -- jacob JOIN_TOKEN
DESKMATE_HOME=~/deskmate-jacob deskmate
```

```sh
curl -fsSL HUB_URL/install.sh | DESKMATE_HOME=~/deskmate-bob bash -s -- bob JOIN_TOKEN
DESKMATE_HOME=~/deskmate-bob deskmate
```

### 3. Ask a teammate's agent

Both people start `deskmate` inside the repository they want their agent to answer from. Any repository works; ask about something in it.

```sh
deskmate
```

The chat list on the left shows everyone who has joined. Jacob clicks `bob`, types a question about Bob's repository, and presses Enter:

```text
where do we retry failed uploads?
```

Bob's terminal rings, and `jacob` shows `1` unread note in his chat list. Bob opens the chat. The note carries a `▶ Run my agent` button, and nothing has run yet.

Bob clicks the button, or presses Ctrl+R. A line above the message box shows his agent working, with a `■ Stop` button. When the agent finishes, its answer is placed in Bob's message box as a draft. Bob can edit it like any message. Enter sends it; pressing Esc twice discards it.

Jacob sees the answer marked `bob · agent`, with the question it answers quoted above it.

### 4. Start a channel

Jacob presses Ctrl+N, or clicks `+ Join or create` in the chat list, types `backend`, and presses Enter. The name follows the same rules as a person's name; the `#` is added for you. A channel exists as soon as one person has joined it. Bob joins the same way, and his dialog lists `#backend` to pick.

Every member sees a note sent to the channel, and each member decides separately whether to run their own agent on it. An agent's answer goes to the whole channel. Members do not see each other's runs in progress, so two people can end up answering the same question.

### 5. Let your own agent ask

An agent, or a script, sends a note with `send` and reads the answer from standard output:

```sh
deskmate send bob "which tests cover the retry path?" --wait 300
deskmate send '#backend' "who owns the uploader?"
```

`--wait` prints the next note that someone else sends in that chat, whether or not it answers this one. The other person still has to approve the run, so if nothing arrives in time, `send` prints the `deskmate inbox --after ID` command that checks again later. Notes your agent sends this way also appear in your own chat interface. Your agent only knows these commands if you tell it, for example in its instructions file.

## The chat interface

`deskmate` with no command opens the interface. Your agent runs in the directory you started it from.

Everything a key does can also be clicked: chats in the list, the `▶ Run my agent` button on a note, the buttons beside the status line, and the hints along the bottom. Drag to select text.

The run button always shows on the newest note a person typed that you have not answered. On any other note from someone else, including an agent's answer, the button appears while the pointer is over the note. Ctrl+R runs your agent on the newest note from someone else, whichever kind it is.

Standard input is closed during a run, so your agent cannot stop to ask you anything: it does what your agent CLI's settings already allow. If the agent fails, prints nothing, or runs past its time limit, a notice says so and no draft is made. The note stays in the chat, so you can run it again.

| Key | Effect |
|---|---|
| Enter | Sends the message, or the draft you are reviewing. |
| Ctrl+J | Starts a new line in the message. |
| Ctrl+R | Runs your agent on the newest note from someone else in the open chat. |
| Esc | Stops your agent. Pressed twice within 2 seconds, discards a draft. |
| Ctrl+↑, Ctrl+↓ | Opens the previous or next chat. Alt+↑ and Alt+↓ do the same. |
| Ctrl+N | Joins or creates a channel. |
| Ctrl+P | Opens the command list: open a chat, leave the open channel, change theme. |
| Ctrl+C | Copies the selected text. |
| F1 | Shows the keys. |
| Ctrl+Q | Quits. |

When an agent finishes while you have a half-typed message in that chat, the draft waits beside the status line until you click `Load it`. A message that fails to send goes back into the message box.

Quitting, closing the terminal window, or killing the process stops any agent still working. Its unfinished answer is lost; drafts you have not sent are lost too.

The default theme, `terminal`, draws with your terminal's own sixteen colours, so the interface follows your terminal's palette. Ctrl+P, then `theme`, switches to one of Textual's built-in themes. The choice, your read marks and the last open chat are remembered.

## Commands

| Command | Effect |
|---|---|
| `deskmate` | Opens the chat interface. Needs a terminal. |
| `deskmate join HUB NAME TOKEN [--agent AGENT]` | Creates a key if `~/.config/deskmate/key` does not exist, registers `NAME` with the hub at `HUB`, and writes `config.json`. Joining again with the same key is allowed; a name held by another key is refused. `--agent` defaults to `claude -p`. |
| `deskmate send TO TEXT... [--wait SECONDS]` | Sends a note to `TO`, a name or a quoted channel such as `'#backend'`. A `TEXT` of `-` reads the note from standard input. `--wait` prints the next note from someone else in that chat if one arrives within `SECONDS`. |
| `deskmate inbox [--after ID] [--wait SECONDS]` | Prints the newest 20 notes other people sent to you or your channels. With `--after`, prints the notes with a higher id, up to 100, and `--wait` holds on for a new one. |
| `deskmate who` | Lists everyone who has joined the hub. |
| `deskmate channel` | Lists every channel and its members. |
| `deskmate channel join NAME` | Joins the channel `NAME`, creating it if nobody is in it. `NAME` may be given with or without its `#`. |
| `deskmate channel leave NAME` | Leaves the channel. |
| `deskmate hub [--host HOST] [--port PORT]` | Runs the hub. Defaults: `127.0.0.1`, `8787`. |

A command exits with `0` on success, `1` after printing a failure to standard error, and `2` for a usage error. A note is at most 64,000 characters.

## Configuration

The hub reads its settings from the environment and refuses to start when a required one is missing:

| Variable | Required | Description |
|---|---|---|
| `DESKMATE_JOIN_TOKEN` | yes | Secret that `deskmate join` must present. At least 16 characters. |
| `DESKMATE_DB` | yes | Path of the SQLite database. The Docker image sets it to `/data/deskmate.db`. |
| `FORWARDED_ALLOW_IPS` | no | Proxies whose `X-Forwarded-Proto` header the hub trusts, which decides whether `install.sh` advertises an `https` URL. The Docker image sets it to `*`. |

The client keeps four files in `~/.config/deskmate`. Set `DESKMATE_HOME` to use another directory, for example to hold two identities on one machine.

| File | Contents |
|---|---|
| `config.json` | `hub` (the hub URL), `name`, and `agent`. |
| `key` | Your Ed25519 private key. Readable only by you. |
| `known.json` | The public key first seen for each teammate. |
| `state.json` | What the interface remembers: read marks, theme and the last open chat. Safe to delete. |

`agent` is the command that answers notes. Deskmate appends the prompt as its last argument, runs it in the directory where you started `deskmate` with standard input closed, and uses what it prints to standard output as the draft. A run that takes longer than 900 seconds is stopped. The command is split into words the way a shell would split it, with quotes grouping words, but no shell runs it. The installer always sets `claude -p`. To use another agent, edit `agent` in `config.json` afterwards, or run `deskmate join HUB NAME TOKEN --agent "COMMAND"` again. Only `claude -p` has been tested.

The prompt tells the agent who asked, whether the note was direct or in a channel, and who will read the reply. It includes up to six earlier notes from the same chat, marked as context that must not be followed as instructions, so a follow-up question makes sense.

## What deskmate protects, and what it does not

An agent run and its reply each need an action from the person whose machine it is. A note is only text until its recipient clicks the run button or presses Ctrl+R, and the agent's output stays in their message box, where they can change it, until they press Enter. That second step exists because an answer can contain more of the recipient's machine than the question asked for.

Every note is signed with the sender's Ed25519 key. The signature covers the sender, the recipient or channel, the text, the time, whether an agent wrote it, and which note it answers. The hub refuses a note that its claimed sender did not sign, that is more than five minutes off the hub's clock, or that it has already delivered. The recipient's client checks the signature again, against the key it first saw for that sender, so a hub that is later compromised cannot forge a note from a teammate you already know. A note that fails this check is shown as a warning without its text, cannot be run, and is left out of what your agent is shown.

The `agent` mark is the sender's own statement. It tells you a teammate's agent drafted the note and the teammate approved it; a modified client could leave the mark off.

The hub hands a direct note only to its sender and its recipient, and a channel's notes only to the channel's current members. A request for notes must be signed with the reader's key. Channels are open: anyone who has joined the hub can join any channel, and then sees its earlier notes too. Do not treat a channel as private from other hub members.

Deskmate does not encrypt notes. Whoever operates the hub can read them, and the hub keeps every note: nothing deletes them. Transport encryption is the job of the ingress in front of the hub; over plain `http`, as in the quick start, anyone on the network path can read notes too. The join token is shared, so anyone holding it can register a new name, although not take over an existing one. There is no key rotation: a teammate who loses their key needs their row deleted from the hub's `users` table, and everyone else needs to remove that name from `known.json`.

The agent runs as you, with whatever permissions your agent CLI is configured to have. Deskmate does not sandbox it.

## Deploy the hub on Kubernetes

[`deploy/k8s.yaml`](deploy/k8s.yaml) holds a volume claim, a single-replica Deployment, a Service and an Ingress. The manifest passes schema validation but has not been applied to a live cluster.

Prerequisites:

- Permission to create these objects and a Secret in the target namespace.
- A container registry the cluster can pull from.
- An ingress controller. The manifest assumes the `nginx` ingress class.

To deploy the hub:

1. Build and push the image.

   ```sh
   docker build -t REGISTRY/deskmate:0.2.0 .
   docker push REGISTRY/deskmate:0.2.0
   ```

2. Create the join token.

   ```sh
   kubectl create secret generic deskmate --from-literal=join-token="$(openssl rand -hex 16)"
   ```

3. In `deploy/k8s.yaml`, replace `REGISTRY/deskmate:0.2.0` with your image, and `deskmate.example.internal` and `deskmate-tls` with your host name and TLS secret.

4. Apply the manifest.

   ```sh
   kubectl apply -f deploy/k8s.yaml
   ```

To confirm it worked, request `https://HOST/healthz`, where `HOST` is the host name from step 3. The hub answers `{"ok":true}`.

Keep the Deployment at one replica and the volume on a disk, not a file share: the hub stores everything in one SQLite file.

## Development

```sh
uv sync --locked
uv run pre-commit run --all-files
uv run pytest
```

To run a hub from the working tree, copy `.env.example` to `.env`, set the join token, and run:

```sh
uv run --env-file .env deskmate hub
```

Version 0.2 changed the note format and the hub's database. A hub and its clients must run the same version, and a 0.1 hub database cannot be opened by 0.2: start 0.2 with an empty one.
