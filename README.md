# deskmate

Deskmate passes notes between teammates and their coding agents. A note you send waits in your teammate's terminal until they approve running their agent on it, and they read the agent's answer before it comes back to you. It is meant for a handful of people who trust each other and share one small hub.

## Quick start

This walk-through sets up one hub and two people, `jacob` and `bob`, and sends one note each way.

The hub needs Docker. Each person needs `curl` and a coding-agent CLI that is installed and signed in. The default is Claude Code's `claude`; for another one, see [Configuration](#configuration).

### 1. Start the hub

One person runs the hub somewhere everyone can reach. With Docker, from a clone of this repository:

```sh
docker build -t deskmate .
docker run -d --name deskmate -p 8787:8787 -e DESKMATE_JOIN_TOKEN=JOIN_TOKEN -v deskmate-data:/data deskmate
```

Replace `JOIN_TOKEN` with a secret of at least 16 characters, for example the output of `openssl rand -hex 16`. Anyone who has it can register a name, so share it only with your teammates.

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

The installer installs [uv](https://docs.astral.sh/uv/) if it is missing, installs the `deskmate` command from `github.com/jacobragsdale/deskmate` into `~/.local/bin`, creates a signing key in `~/.config/deskmate`, and registers your name. It ends with:

```text
joined http://localhost:8787 as bob; your agent command is `claude -p`
Run 'deskmate' inside the repo you want your agent to answer from.
```

If your shell does not find `deskmate` afterwards, open a new terminal, or add `~/.local/bin` to `PATH`.

To try both people on one machine, give each their own directory by setting `DESKMATE_HOME` for the installer and for every later `deskmate` command:

```sh
curl -fsSL HUB_URL/install.sh | DESKMATE_HOME=~/deskmate-bob bash -s -- bob JOIN_TOKEN
DESKMATE_HOME=~/deskmate-bob deskmate
```

### 3. Pass a note and approve a run

Both people start `deskmate` inside the repository they want their agent to answer from:

```sh
deskmate
```

```text
deskmate · you are jacob on http://localhost:8787 · `claude -p` runs in /home/jacob/dev/uploader
  @name <text>  pass a note        r [id]  run your agent on a note (newest if no id)        q  quit
```

Jacob types a note for Bob:

```text
@bob where do we retry failed uploads?
```

Bob's terminal rings and shows the note. Nothing has run yet:

```text
┌ #1 from jacob · Mon 10:32
│ where do we retry failed uploads?
└
  r 1 = run your agent on it · @jacob <text> = answer yourself
```

Bob types `r`. His agent runs in his repository, and deskmate shows the answer and asks before sending it:

```text
running `claude -p` on the note from jacob (ctrl-c cancels) …
Retries live in `uploader/queue.py`, in `Uploader.flush`: three attempts with exponential backoff.
send this to jacob? [Y/n]
```

Bob presses Enter, and the answer appears in Jacob's terminal as a note from `bob`. If Bob answers `n`, nothing is sent.

### 4. Let your own agent ask

An agent, or a script, passes a note with `send` and reads the answer from standard output:

```sh
deskmate send bob "which tests cover the retry path?" --wait 300
```

`--wait` prints the next note that arrives from `bob`, whether or not it answers this one. Bob still has to approve the run, so if nothing arrives in time, `send` prints the `deskmate inbox --after ID` command that checks again later. Your agent only knows these commands if you tell it, for example in its instructions file.

## Commands

`deskmate` with no command watches for notes in the current directory. A typed line is one of:

| Line | Effect |
|---|---|
| `@NAME TEXT` | Passes a note to `NAME`. |
| `r` | Runs your agent on the newest note of this session. |
| `r ID` | Runs your agent on note `ID`, which can be one from an earlier session. `deskmate inbox` lists the ids. |
| `q` | Quits. Ctrl-D does the same. |

The subcommands are:

| Command | Effect |
|---|---|
| `deskmate join HUB NAME TOKEN [--agent AGENT]` | Creates a key if `~/.config/deskmate/key` does not exist, registers `NAME` with the hub at `HUB`, and writes `config.json`. Joining again with the same key is allowed; a name held by another key is refused. `--agent` defaults to `claude -p`. |
| `deskmate send TO TEXT... [--wait SECONDS]` | Passes a note to `TO`. A `TEXT` of `-` reads the note from standard input. `--wait` prints the next note from `TO` if one arrives within `SECONDS`. |
| `deskmate inbox [--after ID] [--wait SECONDS]` | Prints the newest 20 notes sent to you. With `--after`, prints the notes with a higher id, up to 100, and `--wait` holds on for a new one. |
| `deskmate who` | Lists everyone who has joined the hub. |
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
| `cursor` | The id of the last note the watcher showed, so a restart shows only notes that arrived since. |

`agent` is the command that answers notes. Deskmate appends the prompt as its last argument, runs it in the directory where you started `deskmate` with standard input closed, and sends what it prints to standard output. A run that takes longer than 900 seconds is stopped. The command is split into words the way a shell would split it, with quotes grouping words, but no shell runs it. The installer always sets `claude -p`. To use another agent, edit `agent` in `config.json` afterwards, or run `deskmate join HUB NAME TOKEN --agent "COMMAND"` again. Only `claude -p` has been tested.

## What deskmate protects, and what it does not

An agent run and its reply each need a keypress from the person whose machine it is. A note is only text until its recipient types `r`, and the agent's output stays on their screen until they confirm sending it. That second check exists because an answer can contain more of the recipient's machine than the question asked for.

Every note is signed with the sender's Ed25519 key. The hub refuses a note that its claimed sender did not sign, that is more than five minutes off the hub's clock, or that it has already delivered. The recipient's client checks the signature again, against the key it first saw for that sender, so a hub that is later compromised cannot forge a note from a teammate you already know. A note that fails this check is shown as a warning without its text and cannot be run.

The hub hands a note only to the name it is addressed to, and a request for notes must be signed with that name's key, so teammates cannot read each other's notes. Deskmate does not encrypt notes, though. Whoever operates the hub can read them, and the hub keeps every note: nothing deletes them. Transport encryption is the job of the ingress in front of the hub; over plain `http`, as in the quick start, anyone on the network path can read notes too. The join token is shared, so anyone holding it can register a new name, although not take over an existing one. There is no key rotation: a teammate who loses their key needs their row deleted from the hub's `users` table, and everyone else needs to remove that name from `known.json`.

The agent runs as you, with whatever permissions your agent CLI is configured to have. Deskmate tells it who is asking and that you will review the reply; it does not sandbox it.

## Deploy the hub on Kubernetes

[`deploy/k8s.yaml`](deploy/k8s.yaml) holds a volume claim, a single-replica Deployment, a Service and an Ingress. The manifest passes schema validation but has not been applied to a live cluster.

Prerequisites:

- Permission to create these objects and a Secret in the target namespace.
- A container registry the cluster can pull from.
- An ingress controller. The manifest assumes the `nginx` ingress class.

To deploy the hub:

1. Build and push the image.

   ```sh
   docker build -t REGISTRY/deskmate:0.1.0 .
   docker push REGISTRY/deskmate:0.1.0
   ```

2. Create the join token.

   ```sh
   kubectl create secret generic deskmate --from-literal=join-token="$(openssl rand -hex 16)"
   ```

3. In `deploy/k8s.yaml`, replace `REGISTRY/deskmate:0.1.0` with your image, and `deskmate.example.internal` and `deskmate-tls` with your host name and TLS secret.

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
