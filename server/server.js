#!/usr/bin/env node
/**
 * mcp-apidesk（接口工作台）— agent 版 API 联调与回归 MCP server（stdio，零依赖）
 *
 * 协议：MCP over stdio（换行分隔的 JSON-RPC 2.0）
 * 状态：APIDESK_HOME 或 <cwd>/.apidesk/ 下的纯 JSON 文件
 *
 * 工具（4 个，action 风格）：
 *   env       { action: list | use, name? }
 *   secret    { action: set | list, key?, value? }
 *   request   { action: send | save, ... }
 *   collection{ action: show | run }
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

const SERVER_NAME = 'mcp-apidesk';
const SERVER_VERSION = '0.3.0';
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 32 * 1024;

// ---------- 状态目录 ----------
const STATE_DIR = process.env.APIDESK_HOME
  ? path.resolve(process.env.APIDESK_HOME)
  : path.join(process.cwd(), '.apidesk');

const P = {
  active: path.join(STATE_DIR, 'active.json'),
  envDir: path.join(STATE_DIR, 'env'),
  secretsDir: path.join(STATE_DIR, 'secrets'),
  runtime: path.join(STATE_DIR, 'secrets', 'runtime.json'), // 会话捕获的变量（可能含 token，放密钥区）
  collection: path.join(STATE_DIR, 'collection.json'),
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 原子写：先写 .tmp 再 rename，避免并发会话互相截断 */
function writeJSONAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function activeEnvName() {
  const a = readJSON(P.active, null);
  return a && a.env ? String(a.env) : null;
}

function loadEnv(name) {
  const file = path.join(P.envDir, `${name}.json`);
  const e = readJSON(file, null);
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  return { host: String(e.host || ''), vars: e.vars && typeof e.vars === 'object' && !Array.isArray(e.vars) ? e.vars : {} };
}

function listEnvNames() {
  try {
    return fs.readdirSync(P.envDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

function loadSecrets(name) {
  const file = path.join(P.secretsDir, `${name}.json`);
  const s = readJSON(file, {});
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

/** 会话运行时变量（capture 产物），持久化以防进程被重启 */
function loadRuntimeVars() {
  const r = readJSON(P.runtime, {});
  return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
}
function saveRuntimeVars(vars) {
  writeJSONAtomic(P.runtime, vars);
}

/** 集合加载：手改坏文件（数组/字符串/缺 requests）一律重置为空集合，写入时不丢数据 */
function loadCollection() {
  const col = readJSON(P.collection, null);
  if (col && typeof col === 'object' && !Array.isArray(col) && Array.isArray(col.requests)) return col;
  return { requests: [] };
}

/** 首次使用密钥时自动写 .gitignore，防止密钥进 git */
function ensureSecretGitignore() {
  const gi = path.join(STATE_DIR, '.gitignore');
  let content = '';
  try { content = fs.readFileSync(gi, 'utf8'); } catch {}
  if (!content.includes('secrets/')) {
    ensureDir(STATE_DIR);
    fs.appendFileSync(gi, '# apidesk 密钥目录，勿提交\nsecrets/\n', 'utf8');
  }
}

// ---------- 插值 ----------

/** 深遍历对象/数组里的字符串，替换 {{var}} / {{secret.key}} */
function interpolate(value, ctx) {
  if (typeof value === 'string') return interpString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => interpolate(v, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, ctx);
    return out;
  }
  return value;
}

function interpString(s, ctx) {
  return s.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, rawKey) => {
    const key = rawKey.trim();
    if (key.startsWith('secret.')) {
      const sk = key.slice('secret.'.length).trim();
      if (!(sk in ctx.secrets)) {
        throw new Error(
          `密钥 {{secret.${sk}}} 未定义（当前环境 ${ctx.envName}）。` +
            `已有密钥：[${Object.keys(ctx.secrets).join(', ') || '无'}]。` +
            `可先调 secret 工具 {action:"set", key:"${sk}", value:"..."} 存入。`
        );
      }
      return ctx.secrets[sk];
    }
    if (!(key in ctx.vars)) {
      throw new Error(
        `变量 {{${key}}} 未定义（当前环境 ${ctx.envName}）。` +
        `可用变量：[${Object.keys(ctx.vars).join(', ') || '无'}]。` +
        `可通过以下方式补充：编辑 .apidesk/env/${ctx.envName}.json 的 vars；` +
        `或在前置请求中用 capture 捕获；密钥用 secret 工具（引用写法 {{secret.xxx}}）。`
      );
    }
    return String(ctx.vars[key]);
  });
}

/** 按点路径取值：a.b.c */
function getPath(obj, dotPath) {
  let cur = obj;
  for (const seg of dotPath.split('.')) {
    if (cur == null || typeof cur !== 'object' || !(seg in cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

// ---------- HTTP 发送核心（send 与 collection.run 共用） ----------

async function sendCore(reqDef, ctx) {
  const method = String(reqDef.method || 'GET').toUpperCase();
  const rawPath = String(reqDef.path || '');
  if (!rawPath) throw new Error('缺少 path。传完整 URL（http://...）可直接发送，无需环境。');

  const isFullUrl = /^https?:\/\//i.test(rawPath);
  const relPath = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
  // 模板形态 URL：用于报错与回显，{{}} 占位保持原样（密钥不泄露）
  const templateUrl = isFullUrl ? rawPath : (ctx && ctx.host ? ctx.host : '') + relPath;
  let url;
  if (isFullUrl) {
    // 先插值再构造 URL：路径/内联 query 里的 {{var}} 才能生效（构造后再插值会被百分号编码挡住）
    url = new URL(interpolate(rawPath, ctx));
  } else {
    if (!ctx || !ctx.host) {
      throw new Error(
        `path "${rawPath}" 不是完整 URL，需要环境提供 host，但当前没有激活环境。` +
        `两种解决方式：1) path 直接传完整 URL；` +
        `2) 先写环境文件 .apidesk/env/<名称>.json（内容如 {"host":"http://localhost:3000","vars":{}}），` +
        `再调 env 工具 {action:"use", name:"<名称>"}。`
      );
    }
    url = new URL(ctx.host.replace(/\/+$/, '') + interpolate(relPath, ctx));
  }

  // query：对象先插值再并入 URL（避免 URLSearchParams 的百分号编码破坏模板）
  const rawQuery = reqDef.query;
  if (rawQuery && typeof rawQuery === 'object' && !Array.isArray(rawQuery)) {
    const q = interpolate(rawQuery, ctx);
    for (const [k, v] of Object.entries(q)) {
      url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
  }

  const rawHeaders = reqDef.headers && typeof reqDef.headers === 'object' ? reqDef.headers : {};
  const rawBody = reqDef.body;

  let bodyPayload;
  const autoHeaders = {};
  if (rawBody !== undefined && rawBody !== null) {
    if (typeof rawBody === 'string') {
      bodyPayload = rawBody;
    } else {
      bodyPayload = JSON.stringify(rawBody);
      if (!Object.keys(rawHeaders).some((h) => h.toLowerCase() === 'content-type')) {
        autoHeaders['Content-Type'] = 'application/json';
      }
    }
  }
  // 插值（path/query 已在构造 URL 前完成；回显用原模板，密钥不外泄）
  const headers = interpolate({ ...autoHeaders, ...rawHeaders }, ctx);
  const finalUrl = url.toString();
  if (bodyPayload !== undefined) bodyPayload = interpolate(bodyPayload, ctx);

  const requestedTimeout = Number(reqDef.timeout_ms);
  const timeoutMs = requestedTimeout > 0 ? requestedTimeout : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let res;
  try {
    res = await fetch(finalUrl, { method, headers, body: bodyPayload, signal: controller.signal });
  } catch (e) {
    const reason = e.name === 'AbortError'
      ? `请求超时（${timeoutMs}ms）。可调大参数 timeout_ms，或确认目标服务是否存活。`
      : `网络错误：${e.message}。请确认 URL 可达、服务已启动、端口正确。目标：${templateUrl}`;
    throw new Error(reason);
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - started;

  // 读响应体 + 字符集（GBK 等老接口兼容）
  const buf = await res.arrayBuffer();
  const totalBytes = buf.byteLength;
  const contentType = res.headers.get('content-type') || '';
  const charsetMatch = /charset=([\w-]+)/i.exec(contentType);
  const charset = charsetMatch ? charsetMatch[1].toLowerCase() : 'utf-8';
  let decoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  const truncated = totalBytes > MAX_BODY_BYTES;
  const slice = truncated ? buf.slice(0, MAX_BODY_BYTES) : buf;
  let bodyText = decoder.decode(slice);
  if (truncated) bodyText += `\n[已截断：响应体 ${totalBytes} 字节，仅保留前 ${MAX_BODY_BYTES} 字节]`;

  // JSON 解析（宽松：按内容尝试）
  let bodyJson = undefined;
  const ct = contentType.toLowerCase();
  if (ct.includes('json')) {
    try { bodyJson = JSON.parse(bodyText); } catch { /* 保持文本 */ }
  } else if (totalBytes <= MAX_BODY_BYTES) {
    const t = bodyText.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try { bodyJson = JSON.parse(t); } catch { /* 保持文本 */ }
    }
  }

  const respHeaders = {};
  res.headers.forEach((v, k) => { respHeaders[k] = v; });

  return {
    latency_ms: latencyMs,
    status: res.status,
    headers: respHeaders,
    body_text: bodyJson === undefined ? bodyText : undefined,
    body_json: bodyJson,
    body_bytes: totalBytes,
    truncated,
    content_type: contentType || null,
    // 回显请求（模板形态：密钥保持 {{secret.x}} 占位，不泄露）
    echo_request: {
      method,
      url: templateUrl,
      headers: { ...rawHeaders },
      has_body: bodyPayload !== undefined,
    },
  };
}

// ---------- 断言（status + json 点路径匹配） ----------

function runAssert(assert, resp) {
  const failures = [];
  if (!assert || typeof assert !== 'object') return failures;

  if (assert.status !== undefined && Number(assert.status) !== resp.status) {
    failures.push(`断言失败 status：期望 ${assert.status}，实际 ${resp.status}`);
  }

  if (assert.json && typeof assert.json === 'object') {
    if (resp.body_json === undefined) {
      failures.push(
        `断言失败 json：响应体不是 JSON（content-type: ${resp.content_type || '未知'}），无法做 json 断言。` +
        `请改用 status 断言，或先确认接口返回格式。`
      );
    } else {
      for (const [dotPath, expected] of Object.entries(assert.json)) {
        const actual = getPath(resp.body_json, dotPath);
        const actualOk = actual === expected || JSON.stringify(actual) === JSON.stringify(expected);
        if (!actualOk) {
          const topLevel = resp.body_json && typeof resp.body_json === 'object'
            ? `[${Object.keys(resp.body_json).join(', ')}]`
            : '无';
          failures.push(
            `断言失败 json.${dotPath}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}。` +
            `响应顶层字段：${topLevel}（可据此修正断言路径或检查上游改动）`
          );
        }
      }
    }
  }
  return failures;
}

// ---------- capture：把响应字段存为运行时变量 ----------

function runCapture(capture, resp, ctx) {
  if (!capture || typeof capture !== 'object') return;
  if (resp.body_json === undefined) {
    throw new Error(
      `capture 失败：响应体不是 JSON（content-type: ${resp.content_type || '未知'}），无法提取字段。`
    );
  }
  for (const [dotPath, varName] of Object.entries(capture)) {
    const val = getPath(resp.body_json, dotPath);
    if (val === undefined) {
      const topLevel = resp.body_json && typeof resp.body_json === 'object'
        ? `[${Object.keys(resp.body_json).join(', ')}]`
        : '无';
      throw new Error(
        `capture 失败：路径 "${dotPath}" 在响应中不存在。响应顶层字段：${topLevel}。` +
        `可能是上游改了响应结构——请据此更新 capture 路径。`
      );
    }
    // 同时写入快照 vars（本进程立即可用）与 runtimeVars（持久化，跨进程可用）
    ctx.vars[varName] = val;
    ctx.runtimeVars[varName] = val;
  }
  saveRuntimeVars(ctx.runtimeVars);
}

// ---------- 组装上下文 ----------

function buildCtx() {
  const envName = activeEnvName();
  const env = envName ? loadEnv(envName) : null;
  const secrets = envName ? loadSecrets(envName) : {};
  const runtimeVars = loadRuntimeVars();
  return {
    envName: envName || '(无)',
    host: env ? env.host : '',
    secrets,
    vars: { ...(env ? env.vars : {}), ...runtimeVars },
    runtimeVars,
  };
}

// ---------- 工具注册表 ----------

const tools = {};
function register(name, description, inputSchema, handler) {
  tools[name] = { description, inputSchema, handler };
}

// ===== ping =====
register(
  'ping',
  '健康检查：返回工作目录、Node 版本、状态目录 .apidesk 的位置与激活环境。链路验证首选。',
  { type: 'object', properties: {}, required: [] },
  async () => ({
    ok: true,
    server: `${SERVER_NAME}@${SERVER_VERSION}`,
    node: process.version,
    cwd: process.cwd(),
    state_dir: STATE_DIR,
    active_env: activeEnvName() || '(无)',
  })
);

// ===== env =====
register(
  'env',
  '管理接口调试环境（多环境切换）。action=list 列出全部环境；action=use 切换激活环境。' +
  '新建/修改环境 = 直接编辑文件 .apidesk/env/<名称>.json，内容形如 {"host":"http://localhost:3000","vars":{"username":"u"}}。',
  {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'use'], description: 'list=列出环境；use=切换激活环境' },
      name: { type: 'string', description: '目标环境名（use 时必填）' },
    },
    required: ['action'],
  },
  async (args) => {
    if (args.action === 'list') {
      const names = listEnvNames();
      const active = activeEnvName();
      const list = names.map((n) => {
        const e = loadEnv(n);
        return { name: n, host: e ? e.host : '(文件格式有误)', active: n === active, vars: e ? Object.keys(e.vars) : [] };
      });
      return {
        envs: list,
        active: active || '(无)',
        hint: list.length ? '用 {action:"use", name:"..."} 切换；编辑 env/<名称>.json 修改 host/vars' : '尚无环境：请创建 .apidesk/env/<名称>.json',
      };
    }
    if (args.action === 'use') {
      const name = String(args.name || '').trim();
      if (!name) throw new Error('use 需要 name 参数。先用 {action:"list"} 查看已有环境。');
      const env = loadEnv(name);
      if (!env) {
        const existing = listEnvNames();
        throw new Error(
          `环境 "${name}" 不存在（.apidesk/env/${name}.json 未找到）。已有环境：[${existing.join(', ') || '无'}]。` +
          `创建方式：写文件 .apidesk/env/${name}.json，内容 {"host":"http://...","vars":{}}。`
        );
      }
      writeJSONAtomic(P.active, { env: name });
      return { ok: true, active_env: name, host: env.host, vars: Object.keys(env.vars) };
    }
    throw new Error(`未知 action "${args.action}"，可用：list / use`);
  }
);

// ===== secret =====
register(
  'secret',
  '按环境托管密钥（token 等）：值存本地 .apidesk/secrets/<环境>.json（已自动 gitignore），发送时用 {{secret.键名}} 引用，值永不回显到对话。' +
  'action=set 存入（对当前激活环境）；action=list 列出键名（不显示值）。',
  {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['set', 'list'], description: 'set=存入；list=列出键名' },
      key: { type: 'string', description: '键名（set 必填）' },
      value: { type: 'string', description: '值（set 必填）' },
    },
    required: ['action'],
  },
  async (args) => {
    const envName = activeEnvName();
    if (!envName) {
      throw new Error(
        '当前没有激活环境，密钥按环境隔离存储，需要先激活环境。' +
        '流程：创建 .apidesk/env/<名称>.json → 调 env {action:"use", name:"<名称>"} → 再 set。'
      );
    }
    if (args.action === 'set') {
      const key = String(args.key || '').trim();
      if (!key || args.value === undefined) throw new Error('set 需要 key 和 value 参数。');
      ensureSecretGitignore();
      const secrets = loadSecrets(envName);
      secrets[key] = String(args.value);
      writeJSONAtomic(path.join(P.secretsDir, `${envName}.json`), secrets);
      return { ok: true, env: envName, saved_keys: Object.keys(secrets), note: `引用方式：{{secret.${key}}}` };
    }
    if (args.action === 'list') {
      const secrets = loadSecrets(envName);
      return { env: envName, keys: Object.keys(secrets), note: '值不显示；删除/改值可直接编辑 .apidesk/secrets/' + envName + '.json' };
    }
    throw new Error(`未知 action "${args.action}"，可用：set / list`);
  }
);

// ===== request =====
register(
  'request',
  '发送或保存 HTTP 请求。action=send 立即发送（path 传完整 URL 可免环境直发；相对路径则拼当前环境 host）；' +
  'action=save 把请求存入集合（按 name 去重更新），供 collection 一键回归。' +
  '字符串中的 {{变量}} 取自环境 vars，{{secret.键}} 取自托管密钥；断言 assert 支持 {status, json}；' +
  'capture 把响应字段提取为变量（如 {"data.token":"token"}），供后续请求引用。',
  {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['send', 'save'], description: 'send=立即发送；save=存入集合' },
      name: { type: 'string', description: '请求名（save 必填；send 可选）' },
      method: { type: 'string', description: 'HTTP 方法，默认 GET' },
      path: { type: 'string', description: '完整 URL 或相对路径（相对路径需激活环境）' },
      headers: { type: 'object', description: '请求头对象' },
      query: { type: 'object', description: '查询参数对象' },
      body: { description: '请求体：对象=JSON，字符串=原样发送' },
      timeout_ms: { type: 'number', description: '超时毫秒数，默认 10000' },
      assert: { type: 'object', description: '断言 {status:200, json:{"code":0, "data.uid":7}}，json 键为点路径' },
      capture: { type: 'object', description: '捕获 {"data.token":"token"}：把响应字段存为变量' },
    },
    required: ['action', 'path'],
  },
  async (args) => {
    if (args.action === 'save') {
      const name = String(args.name || '').trim();
      if (!name) throw new Error('save 需要 name 参数（集合中按 name 去重更新）。');
      const entry = {
        name,
        method: args.method || 'GET',
        path: args.path,
        ...(args.headers ? { headers: args.headers } : {}),
        ...(args.query ? { query: args.query } : {}),
        ...(args.body !== undefined ? { body: args.body } : {}),
        ...(args.timeout_ms ? { timeout_ms: args.timeout_ms } : {}),
        ...(args.assert ? { assert: args.assert } : {}),
        ...(args.capture ? { capture: args.capture } : {}),
      };
      const col = loadCollection();
      const idx = col.requests.findIndex((r) => r && r.name === name);
      if (idx >= 0) col.requests[idx] = entry;
      else col.requests.push(entry);
      writeJSONAtomic(P.collection, col);
      return {
        ok: true,
        saved: name,
        replaced: idx >= 0,
        collection_size: col.requests.length,
        hint: '调 collection {action:"run"} 可全量回归；增删改也可直接编辑 .apidesk/collection.json',
      };
    }

    if (args.action === 'send') {
      const ctx = buildCtx();
      const resp = await sendCore(args, ctx);
      const failures = runAssert(args.assert, resp);
      if (args.capture) runCapture(args.capture, resp, ctx);
      return {
        ok: failures.length === 0,
        request: resp.echo_request,
        response: {
          status: resp.status,
          headers: resp.headers,
          body: resp.body_json !== undefined ? resp.body_json : resp.body_text,
          body_bytes: resp.body_bytes,
          truncated: resp.truncated,
          latency_ms: resp.latency_ms,
        },
        assert_result: failures.length ? { passed: false, failures } : { passed: true },
        ...(args.capture ? { captured: Object.fromEntries(Object.entries(args.capture).map(([p, n]) => [n, '<已捕获>'])) } : {}),
      };
    }

    throw new Error(`未知 action "${args.action}"，可用：send / save`);
  }
);

// ===== collection =====
register(
  'collection',
  '管理请求集合（.apidesk/collection.json，可直接编辑增删改）。action=show 查看集合；' +
  'action=run 按顺序全量回归：逐条发送（前一条 capture 的变量自动注入后一条），返回汇总报告。',
  {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['show', 'run'], description: 'show=查看；run=全量回归' },
    },
    required: ['action'],
  },
  async (args) => {
    const requests = loadCollection().requests;

    if (args.action === 'show') {
      return {
        size: requests.length,
        requests: requests.map((r, i) => ({
          index: i,
          name: r && r.name,
          method: r && r.method,
          path: r && r.path,
          has_assert: !!(r && r.assert),
          has_capture: !!(r && r.capture),
        })),
        hint: '增删改：直接编辑 .apidesk/collection.json；执行：{action:"run"}',
      };
    }

    if (args.action === 'run') {
      if (!requests.length) {
        return { ok: true, total: 0, passed: 0, failed: 0, invalid: 0, note: '集合为空。先用 request {action:"save"} 存入调通的请求。' };
      }
      const ctx = buildCtx();
      const results = [];
      let passed = 0, failed = 0, invalid = 0;

      for (let i = 0; i < requests.length; i++) {
        const r = requests[i];
        // 容错：坏条目跳过并标注，不让一条坏数据炸掉整个回归
        if (!r || typeof r !== 'object' || !r.path || !r.method) {
          invalid++;
          results.push({ index: i, name: r && r.name, result: 'INVALID', note: '缺少 method/path，已跳过（请修复 .apidesk/collection.json 中该条目）' });
          continue;
        }
        try {
          const resp = await sendCore(r, ctx);
          const failures = runAssert(r.assert, resp);
          if (r.capture) runCapture(r.capture, resp, ctx);
          if (failures.length) {
            failed++;
            results.push({ index: i, name: r.name, result: 'FAIL', status: resp.status, latency_ms: resp.latency_ms, failures });
          } else {
            passed++;
            results.push({ index: i, name: r.name, result: 'PASS', status: resp.status, latency_ms: resp.latency_ms });
          }
        } catch (e) {
          failed++;
          results.push({ index: i, name: r.name, result: 'FAIL', error: e.message });
        }
      }

      const lines = results.map((r) =>
        r.result === 'PASS'
          ? `  PASS [${r.name}] ${r.status} (${r.latency_ms}ms)`
          : r.result === 'INVALID'
            ? `  INVALID [${r.name || '未命名'}] ${r.note}`
            : `  FAIL [${r.name}] ${r.failures ? r.failures.join('；') : r.error}`
      );
      return {
        ok: failed === 0 && invalid === 0,
        total: requests.length,
        passed,
        failed,
        invalid,
        env: ctx.envName,
        report: [`回归报告（环境 ${ctx.envName}）：${passed} 通过 / ${failed} 失败 / ${invalid} 无效`, ...lines].join('\n'),
      };
    }

    throw new Error(`未知 action "${args.action}"，可用：show / run`);
  }
);

// ---------- JSON-RPC / MCP 协议层 ----------

function writeMsg(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function sendResult(id, result) {
  writeMsg({ jsonrpc: '2.0', id, result });
}
function sendError(id, code, message) {
  writeMsg({ jsonrpc: '2.0', id, error: { code, message } });
}

/** 工具调用的统一出口：文本包成 MCP result；isError=true 表示业务报错（非协议错误） */
function sendToolResult(id, text, isError = false) {
  sendResult(id, { isError, content: [{ type: 'text', text }] });
}

async function handleToolsCall(id, params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  const tool = tools[name];
  if (!tool) {
    sendToolResult(id, `未知工具 "${name}"。可用工具：${Object.keys(tools).join(', ')}`, true);
    return;
  }
  try {
    const result = await tool.handler(args);
    sendToolResult(id, JSON.stringify(result, null, 2));
  } catch (err) {
    sendToolResult(id, `[${name}] ${err.message}`, true);
  }
}

async function dispatch(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification 不回包
  switch (method) {
    case 'initialize':
      // 版本协商：固定返回本 server 实现的协议版本（MCP 规范：客户端据此按子集工作）
      sendResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      break;
    case 'ping':
      sendResult(id, {});
      break;
    case 'tools/list':
      sendResult(id, {
        tools: Object.entries(tools).map(([name, t]) => ({
          name, description: t.description, inputSchema: t.inputSchema,
        })),
      });
      break;
    case 'tools/call':
      await handleToolsCall(id, params);
      break;
    default:
      sendError(id, -32601, `method not found: ${method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).replace(/\r$/, '');
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error(`无法解析的消息（已忽略）：${line.slice(0, 200)}`);
      continue;
    }
    dispatch(msg).catch((e) => console.error(`dispatch 异常：${e.message}`));
  }
});
process.stdin.on('end', () => process.exit(0));
