#!/usr/bin/env node
/**
 * 设置链路冒烟测试（不依赖 Chrome）：
 *   MCP stdio 客户端 → mcp.js → HTTP Hub → 假扩展（本脚本扮演，读 /pending 回 /result）
 * 验证 v0.3.0 新增的 ai_get_settings / ai_set_settings，以及 ai_start_collect 带的参数
 * 是否被正确翻译成扩展桥命令 set_settings / get_settings / start_collect{settings}。
 *
 * 跑：node test-settings.js
 */
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 18821;
const base = `http://127.0.0.1:${PORT}/api/v1`;
const BRIDGE = { 'X-DTS-Bridge': '1', 'Content-Type': 'application/json' };

function hubReq(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = Object.assign({}, BRIDGE);
    const r = http.request(base + pathname, { method, headers }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(s || '{}')); } catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function frame(obj) {
  const s = JSON.stringify(obj);
  return 'Content-Length: ' + Buffer.byteLength(s) + '\r\n\r\n' + s;
}

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail !== undefined ? ' — ' + JSON.stringify(detail) : ''));
}

async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, 'mcp.js'), '--port', String(PORT)], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let err = '';
  child.stderr.on('data', (c) => { err += c.toString(); });

  // ---- 解析 MCP stdio 回包（Content-Length 分帧）----
  const msgs = [];
  let buf = Buffer.alloc(0);
  child.stdout.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    for (;;) {
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const header = buf.slice(0, i).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { buf = buf.slice(i + 4); continue; }
      const len = Number(m[1]);
      const start = i + 4;
      if (buf.length < start + len) return;
      const body = buf.slice(start, start + len).toString('utf8');
      buf = buf.slice(start + len);
      try { msgs.push(JSON.parse(body)); } catch (e) { /* skip */ }
    }
  });

  const send = (msg) => child.stdin.write(frame(msg));
  async function waitResponse(id, ms = 5000) {
    const t0 = Date.now();
    for (;;) {
      const hit = msgs.find((m) => m.id === id);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error('等 MCP 回包超时 id=' + id);
      await sleep(30);
    }
  }
  const seen = []; // 假扩展收到的桥命令

  try {
    // ---- 假扩展：出站轮询 ----
    let stop = false;
    const extLoop = (async () => {
      while (!stop) {
        let p;
        try { p = await hubReq('GET', '/pending'); } catch (e) { await sleep(50); continue; }
        const cmds = (p && p.commands) || [];
        for (const cmd of cmds) {
          const args = cmd.args || {};
          seen.push({ type: cmd.type, args });
          let result = { ok: true, echo: cmd.type, args };
          if (cmd.type === 'get_settings') {
            result = {
              external: { lanes: 2 },
              user: null,
              effective: { lanes: 2, maxCount: 7, from: 'plugin' },
              precedence: '内置常量 < dts_settings < dts_user_settings',
              limits: { lanes: { min: 1, max: 8 } }
            };
          } else if (cmd.type === 'set_settings') {
            result = { scope: args.scope || 'external', key: 'dts_settings', settings: args.settings, note: 'ok' };
          } else if (cmd.type === 'start_collect') {
            result = { tabId: 1, status: { phase: 'collecting' }, appliedSettings: args.settings };
          }
          const body = { id: cmd.id, type: cmd.type, ok: true, result, at: Date.now() };
          if (cmd.type === 'start_collect') { body.status = { phase: 'collecting' }; body.tabId = 1; }
          await hubReq('POST', '/result', body).catch(() => {});
        }
        await sleep(40);
      }
    })();

    await sleep(500);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'settings-smoke', version: '1' } } });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const init = await waitResponse(1);
    const list = await waitResponse(2);
    check('initialize 返回 serverInfo', !!(init.result && init.result.serverInfo && init.result.serverInfo.name === 'douyin-collector-mcp'), init.result && init.result.serverInfo);
    const tools = (list.result && list.result.tools) || [];
    const names = tools.map((t) => t.name);
    check('tools/list 含 ai_get_settings', names.includes('ai_get_settings'), names.length);
    check('tools/list 含 ai_set_settings', names.includes('ai_set_settings'), names.length);
    const sc = tools.find((t) => t.name === 'ai_start_collect');
    check('ai_start_collect 接受 max/lanes/replyLanes 等参数',
      !!(sc && sc.inputSchema && sc.inputSchema.properties && sc.inputSchema.properties.max
        && sc.inputSchema.properties.lanes && sc.inputSchema.properties.replyLanes),
      sc && Object.keys((sc.inputSchema && sc.inputSchema.properties) || {}));
    const ss = tools.find((t) => t.name === 'ai_set_settings');
    check('ai_set_settings 有 scope/clear 枚举',
      !!(ss && ss.inputSchema.properties.scope && ss.inputSchema.properties.scope.enum.join(',') === 'external,panel'
        && ss.inputSchema.properties.clear && ss.inputSchema.properties.clear.enum.join(',') === 'external,user,all'),
      ss && ss.inputSchema.properties);

    // ---- 空参数守卫（不产生桥流量）----
    const before = seen.length;
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ai_set_settings', arguments: {} } });
    const guard = await waitResponse(3);
    const guardText = guard.result && guard.result.content && guard.result.content[0] && guard.result.content[0].text;
    check('ai_set_settings{} 被拒（NO_SETTINGS）', !!(guard.result && guard.result.isError && /NO_SETTINGS/.test(guardText || '')), guardText && guardText.slice(0, 80));
    await sleep(400);
    check('拒绝时没有发出桥命令', seen.length === before, seen.length - before);

    // ---- ai_set_settings {max, lanes} → 桥 set_settings ----
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ai_set_settings', arguments: { max: 5, lanes: 2 } } });
    const set1 = await waitResponse(4);
    const cmd1 = seen[seen.length - 1];
    check('ai_set_settings{max:5,lanes:2} 变成 set_settings',
      cmd1 && cmd1.type === 'set_settings' && cmd1.args.settings && cmd1.args.settings.maxCount === 5 && cmd1.args.settings.lanes === 2,
      cmd1);
    check('ai_set_settings 回包透传扩展结果', !!(set1.result && /"key"/.test(set1.result.content[0].text)), set1.result && set1.result.content[0].text.slice(0, 100));

    // ---- ai_set_settings clear ----
    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ai_set_settings', arguments: { clear: 'user' } } });
    await waitResponse(5);
    const cmd2 = seen[seen.length - 1];
    check('clear:"user" 传成 set_settings{clear:user}', cmd2 && cmd2.type === 'set_settings' && cmd2.args.clear === 'user', cmd2);

    // ---- ai_set_settings scope=panel ----
    send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ai_set_settings', arguments: { scope: 'panel', lanes: 3 } } });
    await waitResponse(6);
    const cmd3 = seen[seen.length - 1];
    check('scope:"panel" 传成 set_settings{scope:panel}', cmd3 && cmd3.type === 'set_settings' && cmd3.args.scope === 'panel' && cmd3.args.settings.lanes === 3, cmd3);

    // ---- ai_get_settings ----
    send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ai_get_settings', arguments: {} } });
    const got = await waitResponse(7);
    const cmd4 = seen[seen.length - 1];
    check('ai_get_settings → 桥 get_settings', cmd4 && cmd4.type === 'get_settings', cmd4);
    check('ai_get_settings 回包含 effective', !!(got.result && /"effective"/.test(got.result.content[0].text)), null);

    // ---- ai_start_collect 带参数 ----
    send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'ai_start_collect', arguments: { max: 7, replyLanes: 3, replyThrottleMaxWaitMs: 30000 } } });
    await waitResponse(8);
    const cmd5 = seen[seen.length - 1];
    check('ai_start_collect{max:7,replyLanes:3,…} → start_collect{settings}',
      cmd5 && cmd5.type === 'start_collect' && cmd5.args.settings
        && cmd5.args.settings.maxCount === 7 && cmd5.args.settings.replyLanes === 3 && cmd5.args.settings.replyThrottleMaxWaitMs === 30000,
      cmd5);

    // ---- 不带参数时不产生多余 settings ----
    send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'ai_start_collect', arguments: {} } });
    await waitResponse(9);
    const cmd6 = seen[seen.length - 1];
    check('ai_start_collect{} 不带 settings（沿用当前值）', cmd6 && cmd6.type === 'start_collect' && cmd6.args.settings === undefined, cmd6);

    stop = true;
    await extLoop.catch(() => {});
  } finally {
    try { child.kill(); } catch (e) {}
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n设置链路冒烟：' + (results.length - failed.length) + '/' + results.length + ' 通过');
  if (err) console.log('（mcp stderr 片段）' + err.slice(0, 300));
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error('settings-smoke: FAIL\n' + String((e && e.stack) || e));
  process.exit(1);
});
