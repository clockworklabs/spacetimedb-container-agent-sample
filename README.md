# SpacetimeDB Container Agent Sample

A SpacetimeDB database that runs its own program in a Docker container.

- `spacetimedb/` is the module. It keeps a task queue: clients call `submit_task`, and the `task` table holds each task and its result.
- `agent/` is a Node program that SpacetimeDB runs in a container next to the database. It connects as the database itself, works through pending tasks (with an OpenAI call if you give it a key, otherwise an echo), and completes them.
- `spacetime.json` ties them together. `spacetime publish` builds and publishes the module, builds the agent's image with Docker, and attaches it to the database as its container.

Anyone can submit a task, but only the container can complete one, because the module checks that the caller is the database (`ctx.sender` equals `ctx.databaseIdentity`). Calls with the container's credential are the only ones that pass that check.

Container Hosting is a prototype, and it needs a prototype build of the `spacetime` CLI. Released versions don't have it.

## Prerequisites

- Docker, running: Docker Desktop on macOS, or Docker Engine with the buildx plugin on Linux.
- Node.js 22 or later, with npm, to build the module.
- The prototype CLI, below.

## Install the prototype CLI

Pick the archive for your machine:

| Platform | Archive |
| --- | --- |
| macOS, Apple silicon | `spacetime-aarch64-apple-darwin.tar.gz` |
| macOS, Intel | `spacetime-x86_64-apple-darwin.tar.gz` |
| Linux, x86_64 | `spacetime-x86_64-unknown-linux-gnu.tar.gz` |
| Linux, arm64 | `spacetime-aarch64-unknown-linux-gnu.tar.gz` |
| Windows, x86_64 | `spacetime-x86_64-pc-windows-msvc.zip` |

Each is at `https://spacetimedb-client-binaries.s3.amazonaws.com/tyler/container-image-in-db/<archive>`. On a Mac with Apple silicon:

```sh
mkdir -p ~/spacetime-proto/bin
curl -fsSL https://spacetimedb-client-binaries.s3.amazonaws.com/tyler/container-image-in-db/spacetime-aarch64-apple-darwin.tar.gz \
  | tar xz -C ~/spacetime-proto/bin
alias spacetime="$HOME/spacetime-proto/bin/spacetimedb-cli --root-dir $HOME/spacetime-proto/local"
spacetime server set-default local
```

The alias runs the prototype with its own root directory, `~/spacetime-proto/local`, which holds its config, your login and the local server's data, so nothing you already have from SpacetimeDB is touched. Define it in every terminal you use below, or add it to your shell profile. `server set-default local` makes the local server (`http://127.0.0.1:3000`) the default instead of Maincloud.

On Windows, extract the zip with `Expand-Archive`, and in PowerShell define the alias as a function: `function spacetime { & "$HOME\spacetime-proto\bin\spacetimedb-cli.exe" --root-dir "$HOME\spacetime-proto\local" @args }`.

## Run it locally

In one terminal, start a local server:

```sh
spacetime start
```

It runs containers with your Docker daemon, and only accepts container requests from your own machine. Its log says so: `Containers are enabled, since Docker answers, for clients on this machine`. Start Docker first; if you start it later, restart the server.

If port 3000 is taken, start the server with `spacetime start --listen-addr 0.0.0.0:3100`, and point the CLI at it with `spacetime server edit local --url http://127.0.0.1:3100 --yes`.

In another terminal, clone this repo and publish:

```sh
git clone https://github.com/clockworklabs/spacetimedb-container-agent-sample.git
cd spacetimedb-container-agent-sample
npm install --prefix spacetimedb
spacetime publish
```

The first time, the CLI asks whether to log in with spacetimedb.com. Answer no (press Enter), and the local server gives you an identity. `spacetime publish` then publishes the module, builds the agent image, and attaches it as the database's container. It ends with `Container status: running`.

## Try it

Run these in the project directory. The CLI takes the database name, `container-agent-demo`, from `spacetime.json`.

```sh
spacetime call submit_task "Write a haiku about databases"
spacetime sql "SELECT id, status, result FROM task"
spacetime sql "SELECT * FROM log"
```

Within a second or two the task is done:

```text
 id | status | result
----+--------+------------------------------------------------
 1  | "done" | (some = "echo: Write a haiku about databases")
```

The `log` table, which the agent writes to, has `agent started (echo mode, OPENAI_API_KEY not set)`, `task 1: started` and `task 1: done`.

Only the container can complete tasks. `spacetime call complete_task 1 "forged"` fails with `only the database container may call this reducer`.

`spacetime container status` shows the container. Locally, `docker ps` lists it under a name that starts with `stdb-`, and `docker logs <name>` shows its output.

## Real LLM answers

`spacetime.json` gives `OPENAI_API_KEY` an empty value, which the agent treats as no key, so the container starts without one. A value in your shell takes precedence:

```sh
export OPENAI_API_KEY=sk-...
spacetime publish
spacetime container start
```

`spacetime publish` stores the key in the database's environment, which passes it to the container. A running container keeps the values it started with, so `spacetime container start` restarts it with the key.

Every publish stores the key from your shell, or the empty value if your shell doesn't have one. Keep it exported when you publish, or the container goes back to echo mode the next time it starts. If your shell exports `OPENAI_API_KEY` for other tools, publish with `(unset OPENAI_API_KEY; spacetime publish)` to keep it out. `OPENAI_MODEL` works the same way, and defaults to `gpt-4o-mini`.

## Change the code

- **Agent:** edit `agent/src/main.ts`, then run `spacetime publish`. The image is rebuilt and the container replaced. For example, change `echo: ` to `echo v2: `, publish, and submit another task.
- **Module:** edit `spacetimedb/src/index.ts`. If you change tables or reducers, regenerate the agent's bindings in `agent/src/module_bindings/`, then run `spacetime publish`, which also rebuilds the agent with them:

  ```sh
  spacetime generate --lang typescript --out-dir agent/src/module_bindings --module-path spacetimedb --yes
  spacetime publish
  ```

A publish with no changes leaves the container running untouched.

## How the agent connects

SpacetimeDB sets three environment variables in the container:

- `SPACETIMEDB_URI`: where to reach SpacetimeDB.
- `SPACETIMEDB_DATABASE_IDENTITY`: the database's identity.
- `SPACETIMEDB_TOKEN_FILE`: a file holding a token for the database's identity.

The token lasts 10 minutes, and SpacetimeDB rewrites the file every 5, so read the file each time you connect. The agent connects once, and exits when its connection ends. Its `on-failure` restart policy then starts it again, and it reads a fresh token.

The container also gets the database environment values listed in `container.env-keys`. The agent only works inside a container: anywhere else, it has no credential that makes it the database.

## Hosted

We can run this on a server that Clockwork Labs hosts. Use a second root directory for it, so that your hosted login doesn't replace your local one. Replace `<server>` with the address we send you:

```sh
alias spacetime-hosted="$HOME/spacetime-proto/bin/spacetimedb-cli --root-dir $HOME/spacetime-proto/hosted"
spacetime-hosted server add --url https://<server> hosted --default
spacetime-hosted login --server-issued-login hosted
spacetime-hosted login show
```

Send us the identity that the last command prints. Once we've granted it, publish from the project directory:

```sh
spacetime-hosted publish
```

Confirm that you want to publish to a non-local server. The first publish prints `This server defers environment values for new databases. Publishing without them first.`: the hosted server doesn't take them while it creates a database yet, so the CLI sets them right after. It then builds the image for the server's platform and uploads it into the database, about 100 MiB for this sample, so you don't need a registry. Then try it with `spacetime-hosted call ...` and `spacetime-hosted sql ...`, as above.

Database names are global on a server. If `container-agent-demo` is taken, pick another name in a `spacetime.local.json` file, which git ignores: `{ "database": "my-agent-demo" }`.

On the hosted server, the container can reach the Internet and SpacetimeDB, but nothing else on the server or its network.

## Clean up

In the project directory:

```sh
spacetime delete                         # also removes the container
docker image rm spacetimedb-local/container-agent-demo   # the image is named after the database
```

Stop the server with Ctrl-C. `rm -rf ~/spacetime-proto` removes the prototype and all of its data.

## Limitations

- This is a prototype CLI, built from a branch. Commands and behavior may change.
- A database has one container. Nothing can connect to it, so it can't serve requests.
- Locally, containers aren't isolated from your machine or your network, so only run code you trust. Local containers are tested on macOS with Docker Desktop and Linux with Docker Engine, not on Windows.
- On the hosted server, you can't see the container's output yet. Log to a table, as the agent does. The server is a single node without backups.
- On the hosted server, `spacetime-hosted publish --delete-data` fails with `environment control operation unavailable`, because it sends the environment values from `spacetime.json`. To start over, run `spacetime-hosted delete` and publish again.
- Uploaded images are limited to 256 MiB compressed. The database keeps them in memory for now.
- `spacetime dev` doesn't build or attach the container. Use `spacetime publish`.
- An image ID depends on Docker's image store. If your Docker and the server's use different stores (the classic store or containerd), the hosted container fails to start. Tell us if you hit this.
