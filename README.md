# mcp-apidesk（接口工作台）

**给编码 Agent 用的本地 HTTP 联调与回归 MCP 服务器。** Agent 写完或改完接口代码，当场发真实请求验证；调通的请求存入集合，一条命令按序重放、链式注入 token、断言并输出回归报告。环境、密钥、集合都是本地纯 JSON 文件，跨会话持续累积。

标准 MCP stdio 传输，零 npm 依赖，Node 18+ 单文件实现。任何 MCP 客户端可直接拉起：TRAE / Claude Code / Cursor / VS Code / Cline 等。

## 它解决什么问题

Agent 写 HTTP 代码很强，验证却很弱：现场手拼 curl 受引号转义、代理、平台差异影响，结果不可靠；让人自己开 Postman，验证环节又回到人手上。更糟的是 token 全程暴露在对话上下文里，调通的东西也随会话一起消失。

mcp-apidesk 给 agent 补上这一环：

- **环境配置** — dev / staging / prod 各一份 host + 变量，请求只写路径，不写死 URL
- **本地密钥库** — 密钥发送时注入，响应、报错、请求回显中一律不出现明文
- **请求集合** — 调通的请求固化成纯 JSON，可直接提交 git，团队共享回归用例
- **链式捕获** — `capture` 从响应取字段（如登录 token）存为变量，后续请求以 `{{token}}` 引用
- **一键回归** — `collection run` 按序重放全部请求，捕获值自动沿链传递，断言失败报告期望值与实际值

## 工具

| 工具 | action | 用途 |
|------|--------|------|
| `ping` | — | 健康检查：状态目录、Node 版本、激活环境 |
| `env` | `list` / `use` | 列出 / 切换环境 |
| `secret` | `set` / `list` | 存密钥；`list` 只显示键名，不显示值 |
| `request` | `send` / `save` | 发送请求（完整 URL 或相对路径、`{{var}}` 插值、断言、捕获）；把调通的请求存入集合 |
| `collection` | `show` / `run` | 查看集合；按序重放全部请求并输出报告 |

响应结构化返回（status / headers / body / 耗时），超过 32 KB 截断，GBK 编码自动转码。工具报错与返回文案当前为中文。

## 为 Agent 而生的设计

这一节是它与人用 GUI 工具（Postman 等）的根本差异，每一条都围绕 LLM 调用的可靠性：

- **报错即修复菜单**。变量未定义的报错列出当前环境的全部变量和下一步该调的工具；超时报错带上 `timeout_ms` 参数指引。Agent 读到报错即可自愈，无需人介入。
- **工具描述即说明书**。每个工具的 description 写明何时用、返回什么——没读过本文档的 agent 也能正确构造参数。
- **结构化返回省 token**。响应是 JSON 而非原始文本流，解析快、重试少。
- **密钥永不进上下文**。请求回显保持 `{{secret.token}}` 模板形态，值只在发送瞬间解析——密钥连错误信息都进不去。
- **状态跨会话**。今天调通的 20 个接口，下周一句「跑一遍回归」全部复验。Agent 会话是一次性的，文件资产不是。

## 状态目录

全部是纯 JSON 文件（默认 `<项目>/.apidesk/`，可用 `APIDESK_HOME` 覆盖）：

```
.apidesk/
  active.json      # 当前激活环境
  env/             # 环境配置：{ "host": "...", "vars": { ... } }
  secrets/         # 各环境密钥（首次写入时自动生成 .gitignore 排除）
  collection.json  # 请求集合——设计为可提交，团队的回归用例就是一个文件
  runtime.json     # 捕获的变量，跨 run 持久
```

## 安装

### npm / npx（推荐）

已发布到 npm（[npmjs.com/package/mcp-apidesk](https://www.npmjs.com/package/mcp-apidesk)）。任意 MCP 客户端（TRAE / Claude Code / Cursor / VS Code / Cline）配置：

```json
{
  "mcpServers": {
    "apidesk": {
      "command": "npx",
      "args": ["-y", "mcp-apidesk"]
    }
  }
}
```

不设 `APIDESK_HOME` 时默认取 `<工作目录>/.apidesk`——编辑器类客户端在项目根启动 MCP，通常正是想要的效果。需要固定状态目录时加 `"env": { "APIDESK_HOME": "/absolute/path/to/.apidesk" }`。

TRAE 用户：也可将上段放入项目根 `.trae/mcp.json`（项目级 MCP，需在设置中开启）。

### 本地克隆

单文件零依赖，直接指向源码同样可行：

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

### Smithery

Server 页：[smithery.ai/servers/@891752529/mcp-apidesk](https://smithery.ai/servers/@891752529/mcp-apidesk)。注意：本 server 的正确形态是**本地 stdio 运行**——状态在你机器上、目标接口通常是你自己的 dev/staging，远程托管实例两头都够不着。页面用于展示与分发 `.mcpb`，实际使用请用上面的本地配置。

## 使用

两句话，其余由 agent 完成。

联调并固化：

> 联调一下 user controller 的 login 接口，dev 环境，通过后存入集合

Agent 读路由代码 → 切到 dev 环境 → 发请求 → 看结构化响应修问题 → 通过后带断言和 token 捕获存入集合。

回归：

> 跑一遍接口回归

`collection run` 按序重放全部请求，捕获的 token 沿链注入（登录 → token → 带鉴权的业务调用），断言失败报告期望值与实际值，agent 据此定位代码中出错的 handler。

## 设计边界

刻意不做的，以及它们的归属：

- **断言 DSL** — 只支持状态码与 JSON 顶层字段，更深的判断是 agent 的职责
- **请求前置/后置脚本** — agent 本身就是脚本引擎
- **Mock / 抓包 / 代理** — 另一类工具的问题
- **接口文档生成** — agent 写 markdown 是强项

## 安全

- 密钥存于本地 `secrets/`，发送瞬间注入；响应、报错、请求回显中不出现明文
- 请求从运行 agent 的机器直达目标主机，不经过任何第三方，无遥测

## 开发

```
node test-suite.js
```

一条命令：内置靶机（登录 / token 鉴权 / 慢接口 / GBK / 大响应 / echo）+ 25 场景端到端（含链式回归全流程、密钥脱敏、坏文件容错）。零依赖，Node 18+。

## License

MIT

--- 

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
