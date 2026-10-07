#!/usr/bin/env node
/**
 * douyin-mcp — 方案 B 本地 Hub + MCP stdio Server
 *
 * 架构（PROTOCOL.md §7）：
 *   AI ──stdio/MCP──► 本进程 tools
 *                         │ enqueue / await result
 *                         ▼
 *                    HTTP Hub 127.0.0.1:18765
 *                         ▲ GET /pending · POST /result
 *                         │
 *              Chrome 扩展 background.js（出站轮询）
 *
 * 无 npm 依赖；Node >= 18。
 * 用法：
 *   node mcp.js                 # Hub + MCP（stdIO）
 *   node mcp.js --hub-only      # 只开 Hub，便于 curl 调试
 *   node mcp.js --port 18765
 *
 * curl 调试注意：/pending、/result、/enqueue 需要 X-DTS-Bridge 头（见下方「安全边界」），
 * /health 不需要。例：
 *   curl http://127.0.0.1:18765/api/v1/health
 *   curl -H "X-DTS-Bridge: 1" http://127.0.0.1:18765/api/v1/pending
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const VERSION = '0.3.5';
const HUB_NAME = 'douyin-collector-mcp';

const argv = process.argv.slice(2);
function argVal(name, def) {
  // 支持 --port 1234 与 --port=1234 两种形式；后一个参数是另一个 flag 时不得吞掉
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  return def;
}

const configPath = path.join(__dirname, 'config.json');
let fileCfg = {};
if (fs.existsSync(configPath)) {
  try {
    fileCfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    // 静默回退默认会让"改了端口却不生效"极难排查，必须吱声
    process.stderr.write(`[douyin-mcp] config.json 解析失败，已用默认配置: ${e.message}\n`);
  }
}

/** 数值配置校验：非法值回退默认并告警，避免 server.listen(NaN) 直接 crash */
function numCfg(val, def, name, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    process.stderr.write(`[douyin-mcp] 配置项 ${name} 值非法（${JSON.stringify(val)}），已回退默认 ${def}\n`);
    return def;
  }
  return n;
}

const CFG = {
  host: argVal('--host', fileCfg.host || '127.0.0.1'),
  port: numCfg(argVal('--port', fileCfg.port || 18765), 18765, 'port', 1, 65535),
  hubPath: fileCfg.hubPath || '/api/v1',
  commandTimeoutMs: numCfg(argVal('--timeout', fileCfg.commandTimeoutMs || 90000), 90000, 'commandTimeoutMs', 1000, 600000),
  hubOnly: argv.includes('--hub-only')
};

/**
 * 拼本进程的 HTTP 源站。
 * IPv6 字面量必须加方括号：`new URL('/x', 'http://::1:18765')` 会直接抛
 * `Invalid URL`（实测），于是一个能用于 listen('::1') 的 host 会让每个请求都 500。
 */
function originBase() {
  const h = String(CFG.host || '127.0.0.1');
  return `http://${h.includes(':') ? `[${h}]` : h}:${CFG.port}`;
}

// ---------------- Hub state ----------------

const pending = []; // [{ id, type, args, at }]
const waiters = new Map(); // id -> { resolve, reject, timer, cmd }
const MAX_PENDING = 500; // 队列上限：满了直接拒绝入队，绝不静默丢（见 enqueue）
let lastExtensionAt = 0;
let lastResultAt = 0;
let cmdSeq = 0;

function nextId() {
  cmdSeq += 1;
  return `cmd_${Date.now().toString(36)}_${cmdSeq}`;
}

function enqueue(type, args) {
  // 队列上限：扩展长期离线时无界增长是内存泄漏；满了显式报错而不是静默丢
  if (pending.length >= MAX_PENDING) {
    throw Object.assign(
      new Error(`HUB_QUEUE_FULL: 待执行命令队列已满（${MAX_PENDING}），扩展可能长期不在线`),
      { code: 'HUB_QUEUE_FULL' }
    );
  }
  const cmd = { id: nextId(), type, args: args || {}, at: Date.now() };
  pending.push(cmd);
  const p = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(cmd.id);
      // 关键：超时后必须把命令本体也从 pending 移除——否则扩展稍后轮询会取走并
      // "幽灵执行"这条调用方早已放弃的命令（clear_storage 之类的副作用操作）
      const i = pending.indexOf(cmd);
      if (i >= 0) pending.splice(i, 1);
      reject(Object.assign(new Error('HUB_TIMEOUT: 扩展未在超时内回包'), {
        code: 'HUB_TIMEOUT',
        cmd
      }));
    }, CFG.commandTimeoutMs);
    waiters.set(cmd.id, { resolve, reject, timer, cmd });
  });
  return { cmd, promise: p };
}

function takePending() {
  const batch = pending.splice(0, pending.length);
  // 双保险：丢弃超龄命令（理论上超时回调已移除，这里兜住"时钟回拨/未来改逻辑"的情形），
  // 并让其调用方立即拿到失败，而不是干等到自己的超时点
  const now = Date.now();
  const fresh = [];
  for (const cmd of batch) {
    if (now - cmd.at > CFG.commandTimeoutMs) {
      const w = waiters.get(cmd.id);
      if (w) {
        waiters.delete(cmd.id);
        clearTimeout(w.timer);
        w.reject(Object.assign(new Error('HUB_CMD_EXPIRED: 命令已超龄，不再下发扩展'), {
          code: 'HUB_CMD_EXPIRED',
          cmd
        }));
      }
      continue;
    }
    fresh.push(cmd);
  }
  return fresh;
}

function resolveCommand(body) {
  const w = waiters.get(body.id);
  if (!w) return { ok: false, error: 'UNKNOWN_OR_EXPIRED_ID' };
  waiters.delete(body.id);
  clearTimeout(w.timer);
  lastResultAt = Date.now();
  const ok = !!body.ok;
  const result = body.result !== undefined ? body.result : (ok ? {} : undefined);
  w.resolve({
    ok,
    result,
    error: body.error || undefined,
    hint: body.hint || undefined,
    type: body.type || w.cmd.type,
    id: body.id,
    cmd: w.cmd,
    raw: body
  });
  return { ok: true, id: body.id };
}

function healthPayload() {
  return {
    ok: true,
    hub: HUB_NAME,
    version: VERSION,
    host: CFG.host,
    port: CFG.port,
    pending: pending.length,
    waiters: waiters.size,
    lastExtensionAt,
    lastResultAt,
    at: Date.now()
  };
}

// ---------------- C2 转发模式 ----------------
// Hub 端口被占用时：先 GET /health 认领。是本 Hub（hub 字段匹配）→ callExtension 切换为
// HTTP 转发（POST /enqueue 给已在跑的实例，真正"复用"）；不是本 Hub / 认领失败 →
// 扩展命令快速失败（NO_HUB），绝不让调用方干等 commandTimeoutMs。
// 注意：转发依赖对端实例的修复水平——对端版本旧于本进程时会在启动时警告
// （幽灵执行/丢帧等修复只对重启后的新进程生效）。

let hubMode = 'starting'; // 'starting' | 'own' | 'forward' | 'unavailable'
let hubReadyResolve;
const hubReady = new Promise((r) => { hubReadyResolve = r; });

function httpJson(method, urlStr, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = http.request(urlStr, { method, headers: Object.assign({}, headers) }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (e) { /* 保留原文 */ }
          resolve({ status: res.statusCode, json, text });
        });
      });
    } catch (e) {
      reject(e);
      return;
    }
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error('HTTP_CLIENT_TIMEOUT'), { code: 'HTTP_CLIENT_TIMEOUT' }));
    });
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function noHubError(detail) {
  return Object.assign(
    new Error(`NO_HUB: ${detail}（Hub 端口 ${CFG.port} 被占用且无法复用；请关掉占用进程后重启本进程）`),
    { code: 'NO_HUB' }
  );
}

async function callExtension(type, args) {
  await hubReady; // 等 Hub 模式定型（own / forward / unavailable），通常早已就绪
  if (hubMode === 'unavailable') {
    throw noHubError('端口被非本 Hub 程序占用或旧实例不可达');
  }
  if (hubMode === 'forward') {
    return forwardCommand(type, args);
  }
  const { cmd, promise } = enqueue(type, args);
  return promise;
}

/** 转发模式：把命令 POST 给已在跑的 Hub 实例（其 /enqueue 是阻塞式的，等扩展回包后才返回） */
async function forwardCommand(type, args) {
  const url = `${originBase()}${CFG.hubPath}/enqueue`;
  let r;
  try {
    // 客户端超时略宽于对端的命令超时，让对端的 HUB_TIMEOUT 有机会先回来
    r = await httpJson('POST', url, { type, args: args || {} }, { [BRIDGE_HEADER]: '1' }, CFG.commandTimeoutMs + 5000);
  } catch (e) {
    if (e && e.code === 'HTTP_CLIENT_TIMEOUT') {
      throw Object.assign(new Error('HUB_TIMEOUT: 转发至旧 Hub 后未在超时内回包'), { code: 'HUB_TIMEOUT' });
    }
    throw noHubError(`旧 Hub 连接失败（${(e && e.code) || (e && e.message) || e}），它可能刚退出`);
  }
  if (r.status === 404 || r.status === 405) {
    throw noHubError(`旧 Hub 返回 ${r.status}（缺少 /enqueue，版本过旧），请重启旧 Hub 实例`);
  }
  if (r.status === 403) {
    throw noHubError('旧 Hub 拒绝了桥接头（403），占用端口的很可能不是本 Hub');
  }
  if (r.json && typeof r.json === 'object') return r.json;
  throw noHubError(`旧 Hub 返回了非 JSON 响应（HTTP ${r.status}）`);
}

/** EADDRINUSE 时认领已在跑的 Hub：验明正身 + 版本比对，然后切转发模式 */
async function claimExistingHub() {
  const url = `${originBase()}${CFG.hubPath}/health`;
  let health = null;
  try {
    const r = await httpJson('GET', url, undefined, {}, 3000);
    if (r.status === 200 && r.json) health = r.json;
  } catch (e) { /* 认领失败按不可用处理 */ }
  if (!health || health.hub !== HUB_NAME) {
    hubMode = 'unavailable';
    process.stderr.write(
      `[douyin-mcp] Hub 端口 ${CFG.port} 被占用，且占用方不是本 Hub（${HUB_NAME}）。\n`
      + `[douyin-mcp] 扩展命令将快速失败（NO_HUB）；请确认占用进程后重启。\n`
    );
    return;
  }
  hubMode = 'forward';
  const verCmp = compareVersions(health.version, VERSION);
  process.stderr.write(
    `[douyin-mcp] Hub 端口 ${CFG.port} 由已在跑的实例提供（version=${health.version || 'unknown'}），本进程切换为转发模式。\n`
  );
  if (verCmp < 0) {
    process.stderr.write(
      `[douyin-mcp] 警告：旧 Hub 版本 ${health.version} 低于本进程 ${VERSION}，`
      + `幽灵执行/丢帧等修复在旧进程上不生效，建议尽快重启旧 Hub。\n`
    );
  }
}

function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  }
  return 0;
}

// ---------------- HTTP Hub ----------------

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------- 安全边界 ----------------
//
// 为什么需要下面两道门：Hub 绑 127.0.0.1 只挡住了**外网**，挡不住**用户浏览器里的
// 网页** —— 网页 JS 可以直连 localhost。而 CORS 里 `Access-Control-Allow-Origin: *`
// 与「反射请求的 Origin」对网页是**等价**的：两种情况浏览器都允许网页读响应。
// 于是任意页面都能读走采集数据（get_comments，含昵称/uid/正文）、清空存储
// （clear_storage）、甚至抢先轮询 /pending 把本该发给扩展的 AI 命令**抢走**。
//
// 两道门各堵一半，合起来对「网页」这一类攻击者是完全封闭的：
//   ① CORS 只放行 chrome-extension:// —— 堵住「读响应」；
//   ② 命令类请求必须带 X-DTS-Bridge 头 —— 堵住「盲发」（改状态但读不到响应那种）。
//      网页发不出这个头：自定义头**必然**触发 CORS 预检，而预检过不了 ①；
//      改用 text/plain 这类不触发预检的「简单请求」，又**没有能力**带自定义头。
//
// 这不是鉴权、不需要用户配置任何东西：头的**值不重要**（下面只判存在），
// 它只是一个「预检门槛」。扩展侧零配置，即插即用不变。
//
// 边界（说清楚防不住什么）：本机已有恶意进程或用户装了恶意扩展时防不住——前者能读
// config.json、甚至先占住 18765 端口冒充 Hub，后者有 host 权限可绕过 CORS 直接发头。
// 那属于「本机已失陷」，不在本设计的防御范围内。
const BRIDGE_HEADER = 'x-dts-bridge';

function applyCors(res, req, openToAll) {
  const origin = (req && req.headers && req.headers.origin) || '';
  if (openToAll) {
    // 只读、无用户数据、无副作用的接口（/health、首页）放开，供诊断页 index.html 探测
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (/^chrome-extension:\/\//.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  // 不匹配时**刻意不设** ACAO：浏览器会拦住网页读取响应（门 ①）
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-DTS-Bridge');
  res.setHeader('Access-Control-Expose-Headers', 'Access-Control-Allow-Origin');
  res.setHeader('Access-Control-Max-Age', '600');
}

/** 门 ②：命令类接口必须带 X-DTS-Bridge 头。只判存在，不校验值（它不是密码）。 */
function bridgeAuthorized(req) {
  const v = req && req.headers && req.headers[BRIDGE_HEADER];
  return typeof v === 'string' && v.length > 0;
}

function forbidden() {
  return {
    ok: false,
    error: 'FORBIDDEN',
    hint: '该接口只接受扩展的出站轮询，请求需带 X-DTS-Bridge 头。'
      + '命令行调试请加：curl -H "X-DTS-Bridge: 1" ...'
  };
}

/**
 * 门 ③：Host 头白名单 —— 防 DNS Rebinding。
 * 恶意域名先解析到攻击者 IP、页面加载后再改解析到 127.0.0.1 时，浏览器视为同源，
 * 门 ①（CORS）与门 ②（自定义头）会同时失效。但 rebinding 请求的 Host 头是那个
 * 恶意域名，不是 127.0.0.1/localhost —— 在入口校验 Host 即可把这类请求整体 403。
 */
function hostAllowed(req) {
  const h = ((req && req.headers && req.headers.host) || '').trim().toLowerCase();
  if (!h) return false;
  const allowed = new Set([
    `127.0.0.1:${CFG.port}`,
    `localhost:${CFG.port}`,
    `[::1]:${CFG.port}`,
    `${String(CFG.host).toLowerCase()}:${CFG.port}`
  ]);
  return allowed.has(h);
}

function sendJson(res, code, obj, req, openToAll) {
  const s = JSON.stringify(obj);
  applyCors(res, req, openToAll);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(s)
  });
  res.end(s);
}

function createHubServer() {
  const server = http.createServer(async (req, res) => {
    try {
      // 门 ③：DNS Rebinding 防护（见 hostAllowed 注释），最先执行
      if (!hostAllowed(req)) {
        return sendJson(res, 403, {
          ok: false,
          error: 'BAD_HOST',
          hint: 'Host 头必须是 127.0.0.1/localhost，本服务不接受域名访问（防 DNS Rebinding）。'
        }, req);
      }
      const url = new URL(req.url, originBase());
      const p = url.pathname;

      if (req.method === 'OPTIONS') {
        // 预检只对扩展放行 —— 网页的预检拿不到 ACAO，正式请求根本不会发出（门 ①）
        applyCors(res, req, false);
        res.writeHead(204);
        res.end();
        return;
      }

      // /health 只读、无用户数据、无副作用 → 放开给诊断页与 curl
      if (req.method === 'GET' && (p === '/health' || p === CFG.hubPath + '/health')) {
        return sendJson(res, 200, healthPayload(), req, true);
      }

      if (req.method === 'GET' && (p === '/pending' || p === CFG.hubPath + '/pending')) {
        // 门 ②：[...] 网页若抢先轮询 /pending，会把本该发给扩展的 AI 命令**抢走**
        if (!bridgeAuthorized(req)) return sendJson(res, 403, forbidden(), req);
        lastExtensionAt = Date.now();
        const commands = takePending();
        return sendJson(res, 200, { ok: true, commands, at: Date.now() }, req);
      }

      if (req.method === 'POST' && (p === '/result' || p === CFG.hubPath + '/result')) {
        // 门 ②：否则网页可以伪造扩展的回包
        if (!bridgeAuthorized(req)) return sendJson(res, 403, forbidden(), req);
        const raw = await readBody(req, 8 * 1024 * 1024);
        let body;
        try { body = JSON.parse(raw); } catch (e) {
          return sendJson(res, 400, { ok: false, error: 'BAD_JSON' }, req);
        }
        if (!body || !body.id) {
          return sendJson(res, 400, { ok: false, error: 'MISSING_ID' }, req);
        }
        lastExtensionAt = Date.now();
        return sendJson(res, 200, resolveCommand(body), req);
      }

      // 可选：本地管理接口（仅 127.0.0.1 绑定时可用；命令行调试需带 X-DTS-Bridge 头）
      if (req.method === 'POST' && (p === '/enqueue' || p === CFG.hubPath + '/enqueue')) {
        // 门 ②：这是**执行任意扩展命令并同步返回结果**的接口，是外泄链的核心一环
        if (!bridgeAuthorized(req)) return sendJson(res, 403, forbidden(), req);
        const raw = await readBody(req, 1024 * 1024);
        let body;
        try { body = JSON.parse(raw); } catch (e) {
          return sendJson(res, 400, { ok: false, error: 'BAD_JSON' }, req);
        }
        if (!body || !body.type) {
          return sendJson(res, 400, { ok: false, error: 'MISSING_TYPE' }, req);
        }
        try {
          const out = await callExtension(body.type, body.args || {});
          return sendJson(res, 200, out, req);
        } catch (e) {
          return sendJson(res, 200, {
            ok: false,
            error: String((e && e.message) || e),
            code: e && e.code
          }, req);
        }
      }

      if (p === '/' || p === '/index.html') {
        return sendJson(res, 200, Object.assign(healthPayload(), {
          endpoints: ['/health', '/pending', '/result', '/enqueue'],
          note: '扩展出站轮询本 Hub；MCP 客户端请用 stdIO 运行本进程。'
            + ' /pending、/result、/enqueue 需要 X-DTS-Bridge 头（只有扩展发得出）。'
        }), req, true);
      }

      return sendJson(res, 404, { ok: false, error: 'NOT_FOUND' }, req, false);
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }, req);
    }
  });

  return server;
}

// ---------------- MCP tools ----------------

// 与扩展 content.js 的硬上限一致（扩展侧还会再钳一次，这里只是给 AI 写清范围）。
// `max` 是给 AI 用的别名 → 扩展里的字段名是 `maxCount`（面板齿轮里显示为「目标条数 max」）。
const SETTINGS_PROPS = {
  max: { type: 'number', description: '目标条数上限（一级评论），0=不限；等价面板齿轮里的「目标条数 max」。扩展 0.2.13 起真正生效：到量只停顶层扫描、二级回复仍补完，实际条数通常多于它' },
  maxCount: { type: 'number', description: '同 max（扩展里的原始字段名），两者都传时以 max 为准' },
  lanes: { type: 'number', description: '【已停用】顶层扫描并发路数。扩展 0.2.12 起顶层列表固定单路：实测同一签名下同时发多个分页请求会被服务端合并成同一页，4 路并发反而少采约 30%。此键保留兼容（仍可下发、仍会落进 dts_settings_effective），但不影响采集' },
  replyLanes: { type: 'number', description: '二级回复并发路数 1~8（默认 4）。扩展 0.2.13 起回复请求有**全局节流**（replyGlobalGapMs，默认 250ms ≈ ≤4 次/秒，**与路数无关**）'
    + '并在撞限流时自动降 1 路，所以这里主要决定「同时几条线程在飞」；0.2.14 起被拒也不再「十秒判终局」（见 replyThrottleMaxWaitMs），'
    + '但早期实测「4 路各自零间隔发 ≈16~20 次/秒」会撞成片拒绝（EMPTY_BODY，惩罚态可持续数分钟），建议 1~2' },
  replyGapMs: { type: 'number', description: '回复同线程翻页间隔 ms 0~60000（默认 600）。只在同一条评论有多页回复时生效；'
    + '跨线程的限速用 replyGlobalGapMs（0.2.13 起默认 250ms）' },
  replyGlobalGapMs: { type: 'number', description: '回复请求**跨线程**的全局最小间隔 ms 0~2000（0 = 用扩展内置的 250ms ≈ ≤4 次/秒）。'
    + '扩展 0.2.13 起所有回复请求都过这个闸门（旧版单页线程等于零间隔），撞限流还会自动翻倍到上限 1000ms' },
  replyWarmupMs: { type: 'number', description: '进补采前的静默 ms 0~600000（默认 1500）' },
  replyThrottleMaxWaitMs: { type: 'number', description: '回复请求被拒时「等窗口」的**总**墙钟预算 ms 10000~600000（扩展 0.2.14 起内置 120000）。'
    + '扩展 0.2.14 不再一波判终局：单波最多撞 12 秒，波间停 15/30/60 秒再打一波，总等待封顶在这个预算上；'
    + '设 10000 = 旧行为（十秒不行就收尾，再点一次「开始采集」断点续补采）' }
};

const SETTINGS_KEYS = ['maxCount', 'lanes', 'replyLanes', 'replyGlobalGapMs', 'replyGapMs', 'replyWarmupMs', 'replyThrottleMaxWaitMs'];

/** 把工具参数里的设置项拣出来（max 归一成 maxCount），返回 { maxCount?, lanes?, … } */
function pickSettings(a) {
  const args = a || {};
  const out = {};
  if (args.max !== undefined && args.max !== null) out.maxCount = args.max;
  else if (args.maxCount !== undefined && args.maxCount !== null) out.maxCount = args.maxCount;
  for (const k of SETTINGS_KEYS) {
    if (k === 'maxCount') continue;
    if (args[k] !== undefined && args[k] !== null) out[k] = args[k];
  }
  return out;
}

const TOOLS = [
  {
    name: 'ai_status',
    description: '查看抖音评论采集器扩展状态：存储摘要、最近页面采集快照、当前打开的抖音页、Hub 连接情况、当前采集设置（dts_settings / 面板 dts_user_settings / 上次生效值）。',
    inputSchema: {
      type: 'object',
      properties: {
        videoId: { type: 'string', description: '可选；指定视频 ID 时只统计该池条数' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'ai_list_videos',
    description: '列出扩展 chrome.storage 里已采集过的视频（videoId、标题、条数、phase 等元数据）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'ai_start_collect',
    description: '在当前已打开的抖音页面上开始采集评论（等价面板「开始采集」）。前提：Chrome 已登录抖音、扩展已加载、已打开具体视频页/浮层。'
      + '可选参数会把采集设置写进 dts_settings（等价 DSH 插件下发/面板齿轮），本次采集立即生效；'
      + '面板齿轮里用户设过的同名项优先级更高。不传参数则沿用当前设置。',
    inputSchema: {
      type: 'object',
      properties: Object.assign({}, SETTINGS_PROPS),
      additionalProperties: false
    }
  },
  {
    name: 'ai_pause_collect',
    description: '暂停当前页面的采集（等价面板「暂停」）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'ai_live_status',
    description: '读取当前抖音页采集器的只读状态快照（phase、videoId、unique、hint 等）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'ai_get_comments',
    description: '按 videoId 读取已采集评论。默认 mode=summary（统计+样例，适合分析）；mode=page 返回分页明细。',
    inputSchema: {
      type: 'object',
      properties: {
        videoId: { type: 'string', description: '必填，抖音 aweme/video id' },
        mode: { type: 'string', enum: ['summary', 'page'], description: '默认 summary' },
        limit: { type: 'number', description: 'page 模式返回条数，默认 50，上限 2000' },
        offset: { type: 'number', description: 'page 模式偏移，默认 0' },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: '可选，裁剪字段；默认含 text/digg_count/is_reply/user 等'
        }
      },
      required: ['videoId'],
      additionalProperties: false
    }
  },
  {
    name: 'ai_export',
    description: '把已采集的评论导出为 CSV 或 JSON，写入浏览器下载目录，并返回文件名/路径/字节数。'
      + '默认导某一个 videoId（scope=video）；传 all:true 时把本地所有视频合成一份（scope=all，CSV 末尾多一列 video_id，'
      + '回包带 videoCount），此时 videoId 可以不传。本地没有数据时返回 EMPTY_POOL（不会生成只有表头的空文件）。'
      + '全部视频导出需要扩展 >= 0.2.11。',
    inputSchema: {
      type: 'object',
      properties: {
        videoId: { type: 'string', description: '要导出的视频 ID；all:true 时可不传（传了则把它也并进这份合集）' },
        all: { type: 'boolean', description: 'true = 导出本地全部视频并合成一份（CSV 末尾追加 video_id 列）；默认 false' },
        format: { type: 'string', enum: ['csv', 'json'], description: '默认 csv' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'ai_get_settings',
    description: '读取采集设置：AI 下发的 dts_settings、面板齿轮里用户设的 dts_user_settings、'
      + '以及上一次「开始采集」真正生效的 dts_settings_effective（含来源 from=panel|plugin），外加各项硬上限。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'ai_set_settings',
    description: '写入采集设置（改完在下一次「开始采集」生效，内容脚本每次开始都重读）。'
      + 'scope=external（默认）写 dts_settings，等价 DSH 插件下发；scope=panel 写 dts_user_settings，等价面板齿轮，优先级最高。'
      + 'clear="external"|"user"|"all" 可删掉对应设置恢复内置/插件值。部分字段可以不传（与已有值合并）。',
    inputSchema: {
      type: 'object',
      properties: Object.assign({
        scope: { type: 'string', enum: ['external', 'panel'], description: '默认 external（AI 下发层）；panel = 等价面板齿轮（优先级更高）' },
        clear: { type: 'string', enum: ['external', 'user', 'all'], description: '删掉对应设置恢复默认：external=dts_settings，user=面板的 dts_user_settings，all=都删' }
      }, SETTINGS_PROPS),
      additionalProperties: false
    }
  },
  {
    name: 'ai_clear_storage',
    description: '清空扩展本地评论存储。videoId 指定时只清该视频；不传则清空全部（危险操作）。',
    inputSchema: {
      type: 'object',
      properties: {
        videoId: { type: 'string', description: '可选；不传清空全部' }
      },
      additionalProperties: false
    }
  }
];

function toolResult(content, isError) {
  return {
    content: [{ type: 'text', text: content }],
    isError: !!isError
  };
}

async function callTool(name, args) {
  const a = args || {};
  try {
    switch (name) {
      case 'ai_status':
        return toolResult(JSON.stringify(await callExtension('status', a), null, 2));
      case 'ai_list_videos':
        return toolResult(JSON.stringify(await callExtension('list_videos', a), null, 2));
      case 'ai_start_collect': {
        const s = pickSettings(a);
        const payload = Object.keys(s).length ? { settings: s } : {};
        return toolResult(JSON.stringify(await callExtension('start_collect', payload), null, 2));
      }
      case 'ai_pause_collect':
        return toolResult(JSON.stringify(await callExtension('pause_collect', a), null, 2));
      case 'ai_live_status':
        return toolResult(JSON.stringify(await callExtension('live_status', a), null, 2));
      case 'ai_get_comments':
        if (!a.videoId) return toolResult(JSON.stringify({ ok: false, error: 'videoId 必填' }), true);
        return toolResult(JSON.stringify(await callExtension('get_comments', a), null, 2));
      case 'ai_export': {
        if (!a.videoId && a.all !== true) {
          return toolResult(JSON.stringify({
            ok: false,
            error: 'videoId 必填',
            hint: '导出一条视频请传 videoId；要导出本地全部视频请传 all:true'
          }), true);
        }
        const r = await callExtension('export', a);
        // 旧扩展（< 0.2.11）的 Hub export 不认 all，会回 MISSING_VIDEO_ID —— 别让用户以为是自己的参数问题
        if (r && r.ok === false && r.error === 'MISSING_VIDEO_ID' && a.all === true) {
          r.hint = '扩展可能太旧（< 0.2.11）：「全部视频导出」是 0.2.11 起才有的，请更新扩展后重试。';
        }
        // 成功时按 Hub 约定主体在 result 里（scope/videoCount/count/filename/bytes/path），拍平给模型
        return toolResult(JSON.stringify(r && r.result ? r.result : r, null, 2));
      }
      case 'ai_get_settings':
        return toolResult(JSON.stringify(await callExtension('get_settings', {}), null, 2));
      case 'ai_set_settings': {
        if (a.clear) {
          return toolResult(JSON.stringify(await callExtension('set_settings', { clear: a.clear }), null, 2));
        }
        const s = pickSettings(a);
        if (!Object.keys(s).length) {
          return toolResult(JSON.stringify({
            ok: false,
            error: 'NO_SETTINGS',
            hint: '至少传一个设置项（max/lanes/replyLanes/replyGlobalGapMs/replyGapMs/replyWarmupMs/replyThrottleMaxWaitMs），或 clear="external"|"user"|"all"。'
          }), true);
        }
        const payload = { settings: s };
        if (a.scope) payload.scope = a.scope;
        return toolResult(JSON.stringify(await callExtension('set_settings', payload), null, 2));
      }
      case 'ai_clear_storage':
        return toolResult(JSON.stringify(await callExtension('clear_storage', a), null, 2));
      default:
        return toolResult(JSON.stringify({ ok: false, error: 'UNKNOWN_TOOL:' + name }), true);
    }
  } catch (e) {
    return toolResult(JSON.stringify({
      ok: false,
      error: String((e && e.message) || e),
      code: e && e.code,
      hint: '若 code=HUB_TIMEOUT：请确认 Chrome 扩展已加载、后台正在轮询本 Hub（默认 127.0.0.1:18765），且浏览器未睡眠。'
    }), true);
  }
}

// ---------------- MCP stdio (Content-Length + NDJSON) ----------------

/** 默认按官方 MCP SDK：Content-Length 分帧。
 *  若客户端用 NDJSON 发来，我们按同样风格回，避免 initialize 超时。 */
let mcpOutMode = 'content-length'; // content-length | ndjson

function writeMcpMessage(msg) {
  const s = JSON.stringify(msg);
  if (mcpOutMode === 'ndjson') {
    process.stdout.write(s + '\n');
    return;
  }
  const buf = Buffer.from(s, 'utf8');
  process.stdout.write(`Content-Length: ${buf.length}\r\n\r\n`);
  process.stdout.write(buf);
}

function createMcpSession() {
  let buffer = Buffer.alloc(0);

  function handleMessage(msg, source) {
    if (!msg || typeof msg !== 'object') return;
    if (source === 'ndjson') mcpOutMode = 'ndjson';
    const { id, method, params } = msg;

    // JSON-RPC notification（没有 id）：按协议执行但**绝不回包**。
    // 以前只有 tools/call 判了 id，ping/hub/health/initialize 在无 id 时照样 writeMcpMessage，
    // 序列化时 id:undefined 被丢掉 → 客户端收到一个没有 id 的「响应」，严格实现会判协议错。
    if (id === undefined) {
      if (method === 'tools/call') {
        callTool(params && params.name, (params && params.arguments) || {}).catch(() => {});
      }
      return;
    }

    if (method === 'initialize') {
      writeMcpMessage({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: HUB_NAME, version: VERSION }
        }
      });
      process.stderr.write(`[douyin-mcp] initialize ok id=${id} out=${mcpOutMode}\n`);
      return;
    }

    if (method === 'notifications/initialized' || method === 'initialized') {
      return;
    }

    if (method === 'tools/list') {
      writeMcpMessage({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }

    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      // JSON-RPC notification（无 id）：按规定执行但不回包
      if (id === undefined) {
        callTool(name, args).catch(() => {});
        return;
      }
      callTool(name, args).then((r) => {
        writeMcpMessage({ jsonrpc: '2.0', id, result: r });
      }).catch((e) => {
        writeMcpMessage({
          jsonrpc: '2.0',
          id,
          result: toolResult(JSON.stringify({ ok: false, error: String(e) }), true)
        });
      });
      return;
    }

    if (method === 'ping') {
      writeMcpMessage({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (method === 'hub/health') {
      writeMcpMessage({ jsonrpc: '2.0', id, result: healthPayload() });
      return;
    }

    if (id !== undefined) {
      writeMcpMessage({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      });
    }
  }

  function onStdinData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      // Content-Length（\r\n\r\n 或 \n\n）
      let headerEnd = buffer.indexOf('\r\n\r\n');
      let sepLen = 4;
      if (headerEnd < 0) {
        headerEnd = buffer.indexOf('\n\n');
        sepLen = 2;
      }
      if (headerEnd >= 0) {
        const header = buffer.slice(0, headerEnd).toString('utf8');
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        if (m) {
          const len = Number(m[1]);
          const start = headerEnd + sepLen;
          if (buffer.length >= start + len) {
            const body = buffer.slice(start, start + len).toString('utf8');
            buffer = buffer.slice(start + len);
            try { handleMessage(JSON.parse(body), 'content-length'); } catch (e) { /* skip */ }
            continue;
          }
          // body 未到齐（chunk 边界落在 body 中间）：必须等更多数据。
          // 绝不能落进下面的 NDJSON 分支——它会把 "Content-Length: N" 头行当垃圾吞掉，
          // 之后所有帧永久错位且无任何报错。
          break;
        }
      }

      // 头块本身被切开：缓冲里已经有一行 `Content-Length: N`，但空行还没到。
      // 必须继续等 —— 否则下面的 NDJSON 分支会把这一行头当「一行 JSON」吃掉，
      // 滞留的 body 会在下一条帧到达时被 slice() 静默丢弃（丢帧，无任何报错）。
      const firstNl = buffer.indexOf(0x0a);
      if (firstNl >= 0 && /^content-length:\s*\d+/i.test(buffer.slice(0, firstNl).toString('utf8'))) break;

      // NDJSON fallback
      const nl = buffer.indexOf(0x0a);
      if (nl >= 0) {
        const line = buffer.slice(0, nl).toString('utf8').trim();
        buffer = buffer.slice(nl + 1);
        if (line && !/^content-length:/i.test(line) && !/^\r?$/.test(line)) {
          try { handleMessage(JSON.parse(line), 'ndjson'); } catch (e) { /* skip */ }
          continue;
        }
        continue;
      }
      break;
    }
  }

  process.stdin.on('data', onStdinData);
  process.stdin.on('end', () => {
    process.exit(0);
  });
  process.stdin.on('error', () => {});
  process.stdout.on('error', () => {});
}

// ---------------- entry ----------------
// 顺序很重要：必须先挂 MCP stdio，再尝试听 Hub。
// 若端口被占，不退出（否则 MiMo 侧 initialize 会 30s 超时），而是认领旧实例：
// 是本 Hub → 转发模式复用它；不是 → 扩展命令快速失败（NO_HUB）。

function startMcpOrDie() {
  if (!CFG.hubOnly) {
    createMcpSession();
    process.stderr.write(
      `[douyin-mcp] MCP stdio ready (Content-Length + NDJSON fallback)\n`
      + `[douyin-mcp] hub=${CFG.host}:${CFG.port}${CFG.hubPath}\n`
    );
  } else {
    process.stderr.write('[douyin-mcp] --hub-only: MCP stdio not started\n');
  }
}

function tryStartHub() {
  const server = createHubServer();
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      // 不退出（否则 MiMo 侧 initialize 会 30s 超时），但也不能让命令烂在
      // 本进程内存队列里——认领旧实例并切转发模式，认领不了就快速失败
      claimExistingHub().finally(() => hubReadyResolve());
      return;
    }
    process.stderr.write('[douyin-mcp] hub error: ' + String((e && e.message) || e) + '\n');
    hubMode = 'unavailable';
    hubReadyResolve();
  });
  server.listen(CFG.port, CFG.host, () => {
    hubMode = 'own';
    hubReadyResolve();
    process.stderr.write(
      `[douyin-mcp] Hub listening on http://${CFG.host}:${CFG.port}${CFG.hubPath}\n`
    );
  });
  return server;
}

function main() {
  // 1) 先让 MCP 对 MiMo 可用
  startMcpOrDie();
  // 2) 再尝试挂 Hub（失败也不影响 initialize）
  tryStartHub();
}

main();
