# API Desk (mcp-apidesk)

HTTP debugging and regression workbench for coding agents. A local MCP server (stdio, zero dependencies, Node 18+) that lets an agent send real HTTP requests while you code, capture response values into variables, keep passing requests as a collection, and replay the whole collection as a regression suite on demand.

## The problem it solves

Agents write HTTP code well but verify it poorly. Asked to test an endpoint, an agent either shells out to curl — where quoting rules, proxies, and platform quirks make results unreliable — or tells you to open Postman yourself. Either way, tokens end up in the conversation transcript and nothing survives the session.

API Desk gives the agent what raw shell access cannot:

- **Environment profiles** — `dev` / `staging` / `prod` hosts with per-environment variables; requests use paths, not hard-coded URLs.
- **A local secret vault** — secrets are injected into requests at send time and never echoed back in responses, errors, or request previews.
- **A persistent request collection** — a request that took twenty iterations to get right is saved once and replayed forever.
- **Chained capture** — `capture` pulls a field out of a response (a login token, for instance) into a variable that later requests interpolate.
- **One-command regression** — `collection run` replays every saved request in order, threads captures forward, checks assertions, and reports failures with expected vs. actual.

## Tools

| Tool | Actions | Purpose |
|------|---------|---------|
| `ping` | — | Health check: state directory, Node version, active environment. |
| `env` | `list`, `use` | List or switch environment profiles. |
| `secret` | `set`, `list` | Store secrets per environment. `list` shows key names only. |
| `request` | `send`, `save` | Send a request (full URL or environment-relative path, `{{var}}` interpolation, optional assertions and capture). Save a proven request into the collection. |
| `collection` | `show`, `run` | Show the collection, or replay every request in order and report pass/fail with details. |

Responses come back structured (`status`, `headers`, `body`, elapsed time) and are truncated above 32 KB. GBK-encoded bodies are transcoded. Error messages are menus, not dead ends: an undefined-variable error lists the variables that exist and the call that would define them.

Tool responses and error messages are currently in Chinese.

## State

Everything is plain JSON under one directory (`.apidesk/` by default, override with `APIDESK_HOME`):

```
.apidesk/
  active.json      # active environment name
  env/             # one profile per file: { "host": "...", "vars": { ... } }
  secrets/         # per-environment secrets
  collection.json  # saved requests — safe to commit and share
  runtime.json     # captured variables, persisted between runs
```

A `.gitignore` covering `secrets/` is created inside the state directory on first write. `collection.json` is designed for git: a team's regression suite is just a committed file.

## Install

### Smithery

Server page: [smithery.ai/servers/@891752529/mcp-apidesk](https://smithery.ai/servers/@891752529/mcp-apidesk). Install from the page, or download the `.mcpb` bundle there for MCPB-aware clients.

Note: prefer the local stdio install below. This server keeps state on your machine and typically targets your own dev/staging hosts, so a remotely hosted connection cannot reach either.

### Claude Desktop / any MCPB-aware client

Open the downloaded `mcp-apidesk.mcpb` with the client, or drag it onto the Extensions pane in Claude Desktop.

### Any MCP client

The server is a single file with no dependencies:

```json
{
  "mcpServers": {
    "apidesk": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-apidesk/server.js"],
      "env": { "APIDESK_HOME": "/absolute/path/to/project/.apidesk" }
    }
  }
}
```

Drop `APIDESK_HOME` to use `<working directory>/.apidesk`, which is usually what you want in editors (Cursor, VS Code, TRAE) that start MCP servers in the project root.

## Usage

Both flows below are one sentence from you; the agent does the rest.

Debug and bank a request:

> 联调一下 user controller 的 login 接口，dev 环境，通过后存进集合

The agent reads the route handler, switches to the `dev` environment, sends the request, inspects the structured response, fixes whatever is wrong, then saves the proven request — with an assertion and a `capture` for the session token.

Regress:

> 跑一遍接口回归

`collection run` replays every saved request in order, threads captured tokens through the chain (login → token → authenticated calls), and reports pass/fail with expected vs. actual on failures. The agent then reads the failing handler in the codebase — the part it is good at.

## Design boundaries

Deliberately not built, and where the work belongs instead:

- **Assertion DSL** — status code and top-level JSON fields only. Deeper inspection is the agent's judgment.
- **Request scripting** (pre/post scripts) — the agent is the script.
- **Mock servers, traffic capture, proxying** — different tools.
- **API documentation generation** — agents write markdown natively.

## Security notes

- Secret values live in `secrets/` and are injected at send time. They do not appear in tool responses, error messages, or the request preview — templates are echoed, never resolved values.
- Requests go directly from the machine running the agent to the target host. Nothing is proxied or reported anywhere.

## Development

```
node test-suite.js
```

Boots a local target server (login, token-protected route, slow endpoint, GBK endpoint, oversized response) and runs 25 scenarios end to end over stdio, including the full capture-chain regression. No dependencies; Node 18+.

## License

MIT
