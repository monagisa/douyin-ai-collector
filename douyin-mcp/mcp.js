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
const crypto = require('crypto');

const VERSION = '0.2.0';
const HUB_NAME = 'douyin-collector-mcp';

const argv = process.argv.slice(2);
function argVal(name, def) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  return def;
}

const configPath = path.join(__dirname, 'config.json');
let fileCfg = {};
if (fs.existsSync(configPath)) {
  try { fileCfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) { /* keep defaults */ }
}

const CFG = {
  host: argVal('--host', fileCfg.host || '127.0.0.1'),
  port: Number(argVal('--port', fileCfg.port || 18765)),
  hubPath: fileCfg.hubPath || '/api/v1',
  commandTimeoutMs: Number(argVal('--timeout', fileCfg.commandTimeoutMs || 90000)),
  hubOnly: argv.includes('--hub-only')
};

// ---------------- Hub state ----------------

const pending = []; // [{ id, type, args, at }]
const waiters = new Map(); // id -> { resolve, reject, timer, cmd }
let lastExtensionAt = 0;
let lastResultAt = 0;
let cmdSeq = 0;

function nextId() {
  cmdSeq += 1;
  return `cmd_${Date.now().toString(36)}_${cmdSeq}`;
}

function enqueue(type, args) {
  const cmd = { id: nextId(), type, args: args || {}, at: Date.now() };
  pending.push(cmd);
  const p = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(cmd.id);
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
  return batch;
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

async function callExtension(type, args) {
  const { cmd, promise } = enqueue(type, args);
  return promise;
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
      const url = new URL(req.url, `http://${CFG.host}:${CFG.port}`);
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

const TOOLS = [
  {
    name: 'ai_status',
    description: '查看抖音评论采集器扩展状态：存储摘要、最近页面采集快照、当前打开的抖音页、Hub 连接情况。',
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
    description: '在当前已打开的抖音页面上开始采集评论（等价面板「开始采集」）。前提：Chrome 已登录抖音、扩展已加载、已打开具体视频页/浮层。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
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
    description: '把某个 videoId 的评论导出为 CSV 或 JSON，写入浏览器下载目录，并返回文件名/路径/字节数。',
    inputSchema: {
      type: 'object',
      properties: {
        videoId: { type: 'string', description: '必填' },
        format: { type: 'string', enum: ['csv', 'json'], description: '默认 csv' }
      },
      required: ['videoId'],
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
      case 'ai_start_collect':
        return toolResult(JSON.stringify(await callExtension('start_collect', a), null, 2));
      case 'ai_pause_collect':
        return toolResult(JSON.stringify(await callExtension('pause_collect', a), null, 2));
      case 'ai_live_status':
        return toolResult(JSON.stringify(await callExtension('live_status', a), null, 2));
      case 'ai_get_comments':
        if (!a.videoId) return toolResult(JSON.stringify({ ok: false, error: 'videoId 必填' }), true);
        return toolResult(JSON.stringify(await callExtension('get_comments', a), null, 2));
      case 'ai_export':
        if (!a.videoId) return toolResult(JSON.stringify({ ok: false, error: 'videoId 必填' }), true);
        return toolResult(JSON.stringify(await callExtension('export', a), null, 2));
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
        }
      }

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
// 若端口被占，只警告并继续（复用已在跑的 Hub），绝不能 exit，
// 否则 MiMo 侧 initialize 会 30s 超时。

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
      process.stderr.write(
        `[douyin-mcp] Hub 端口 ${CFG.port} 已被占用 —— 不退出，继续用 MCP；请确认占用方是本 Hub。\n`
        + `[douyin-mcp] 若占用的是旧实例，请先关掉终端里正在跑的 node mcp.js。\n`
      );
      return;
    }
    process.stderr.write('[douyin-mcp] hub error: ' + String((e && e.message) || e) + '\n');
  });
  server.listen(CFG.port, CFG.host, () => {
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
