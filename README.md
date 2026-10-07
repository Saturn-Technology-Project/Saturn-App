# Saturn App

[中文](README_ZH.md)

Saturn App is an agent that runs on your own computer. It is two processes:

- **Saturn Desktop**: the Electron window. Sign in, chat, connect models and MCP servers, and read logs.
- **Saturn Runtime**: the local core. It calls models, runs the built-in skills, connects to MCP, and stores this machine's state.

Desktop talks to Runtime only through `http://127.0.0.1:4700`. Runtime does not depend on Electron and can be started on its own.

Saturn Cloud (organizations, teams, accounts, and remote policy) is a separate control plane and is not part of this project. Runtime reaches it only through `SessionService` and does not import control-plane code. Without a sign-in, Runtime still runs local agents, models, and MCP servers.

## Built-in skills

Every agent includes General Skills. The tool ids are fixed:

| Skill | What it does |
|-------|----------------|
| `chat` | Write the reply the user should see |
| `files` | List, read, write, or patch files in the workspace |
| `code` | Run a command in the workspace |
| `web` | Read a public web page. Local and private addresses are refused |
| `mcp` | Call another MCP tool already attached to this agent |
| `multi_step` | Keep a plan. Until it is finished, exactly one step is in progress |

Files and commands stay inside `workspace/` under the data directory. Patches use the `*** Begin Patch` / `*** End Patch` grammar.

## Layout

```
Saturn App/
  desktop/          Electron shell
    src/domain/         Rules and types used by the UI
    src/application/    Use cases that call Runtime
    src/infrastructure/ HTTP client
    src/presentation/   React screens
  runtime/          Local core
    src/presentation/   HTTP. Routes only forward to controllers
    src/application/    Use cases: catalog, runs, account, settings
    src/domain/         Agents, skills, and path rules
    src/infrastructure/ Models, MCP, files, and the cloud connection
```

Domain objects do not depend on Express or React. Infrastructure owns the file system, shell commands, model APIs, and the connection to Saturn Cloud.

## Requirements

- Node.js 22 or newer
- macOS or Windows. Building the macOS app has to be done on a Mac

## Develop

From `Saturn App/`, install both packages:

```bash
npm install --prefix runtime
npm install --prefix desktop
```

Open the window. If nothing is listening on port 4700, Desktop starts Runtime itself.

```bash
npm run desktop
```

Run the core on its own:

```bash
npm run dev
```

The core listens on `127.0.0.1:4700`. During development, Vite serves the UI at `http://127.0.0.1:5174`.

Local state is stored in `~/.saturn-app`. Override it with:

| Variable | Default | Purpose |
|----------|---------|---------|
| `SATURN_RUNTIME_HOST` | `127.0.0.1` | Address Runtime binds |
| `SATURN_RUNTIME_PORT` | `4700` | Runtime port |
| `SATURN_DATA_DIR` | `~/.saturn-app` | State, secrets, and the workspace |
| `SATURN_NODE` | Found on `PATH` | The `node` binary Desktop uses to start Runtime |

Model keys stay in the local Credential Broker. The API does not return the secret to the UI.

## Test

```bash
npm test
```

Tests call the Runtime HTTP API and use a temporary data directory.

## Package

These commands produce an unsigned macOS `.app` and a Windows x64 installer in `desktop/release/`.

```bash
npm run dist:mac
npm run dist:win
```

On macOS, the first launch is a right-click on the `.app` and then Open. Windows may show a SmartScreen prompt. The packaged Runtime is started from the app executable in Node mode, so a separate Node install is not required.

## Local API

Runtime accepts browser calls only from loopback origins. Common routes:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Whether the core is running |
| GET | `/session` | Current sign-in. Does not call the cloud |
| POST | `/session/login` | Sign in with an account |
| POST | `/session/refresh` | Refresh the account from the cloud. On failure, the local session stays |
| GET, POST | `/agents` | List or create agents |
| POST | `/agents/:id/runs` | Give an agent a task |
| GET | `/runs/:id` | Read that turn |
| POST | `/runs/:id/stop` | Stop that turn |

Other routes require a signed-in session. `GET /health`, `GET /session`, `POST /session/login`, and `DELETE /session` do not.

## License

[MIT](LICENSE). Copyright (c) 2026 Prism Capital LLC.
