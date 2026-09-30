#!/usr/bin/env node
/** Hub 命令队列冒烟测试（不依赖 Chrome） */
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 18799;
const base = `http://127.0.0.1:${PORT}/api/v1`;
// Hub 命令类接口要求该头（模拟扩展；网页发不出——预检只放行 chrome-extension://）
const BRIDGE = { 'X-DTS-Bridge': '1', 'Content-Type': 'application/json' };

function req(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (pathname === '/health' || pathname === '/pending' || pathname === '/result' || pathname === '/enqueue') {
      // health 无需头；pending/result/enqueue 需要
      if (pathname !== '/health') Object.assign(headers, BRIDGE);
      else headers['Content-Type'] = 'application/json';
    }
    if (data) headers['Content-Type'] = 'application/json';
    const r = http.request(base + pathname, {
      method,
      headers
    }, (res) => {
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

async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, 'mcp.js'), '--hub-only', '--port', String(PORT)], {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let childErr = '';
  child.stderr.on('data', (c) => { childErr += c.toString(); });

  try {
    const okUp = await waitFor(async () => {
      try { return (await req('GET', '/health')).ok === true; } catch { return false; }
    }, 5000);
    if (!okUp) throw new Error('Hub 启动失败: ' + childErr);

    const health = await req('GET', '/health');
    if (health.hub !== 'douyin-collector-mcp') throw new Error('health.hub 异常');

    // 模拟扩展轮询：取一条命令并回包
    const resultPromise = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('等结果超时')), 5000);
      // 后台：enqueue 后消费 pending
      (async () => {
        try {
          // 用进程内无法直接调用，走 HTTP enqueue + 另一协程 pending
        } catch (e) { reject(e); } finally { clearTimeout(t); }
      })();
    });

    // enqueue 会阻塞等 result —— 先起一个 pending 消费循环
    const pendingLoop = (async () => {
      for (let i = 0; i < 40; i++) {
        const p = await req('GET', '/pending');
        if (p.commands && p.commands.length) {
          const cmd = p.commands[0];
          await req('POST', '/result', {
            id: cmd.id,
            ok: true,
            type: cmd.type,
            result: { echo: cmd.type, args: cmd.args, by: 'test-hub' },
            at: Date.now()
          });
          return cmd;
        }
        await sleep(50);
      }
      throw new Error('未取到 pending 命令');
    })();

    const enq = (async () => {
      // 需要先有消费者才能立刻完成 enqueue promise；用 race 双路
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('enqueue 超时')), 8000);
        req('POST', '/enqueue', { type: 'status', args: { videoId: 'test' } })
          .then((r) => { clearTimeout(t); resolve(r); })
          .catch((e) => { clearTimeout(t); reject(e); });
      });
    })();

    const [cmd, out] = await Promise.all([pendingLoop, enq]);
    if (cmd.type !== 'status') throw new Error('pending 命令类型不对');
    if (!out.ok || !out.result || out.result.echo !== 'status') {
      throw new Error('result 回包不对: ' + JSON.stringify(out));
    }

    const health2 = await req('GET', '/health');
    if (!health2.ok) throw new Error('结果后 health 失败');

    process.stdout.write('hub-smoke: PASS\n');
    process.stdout.write(JSON.stringify({ health, enq: out, health2 }, null, 2) + '\n');
  } finally {
    child.kill();
  }
}

main().catch((e) => {
  process.stderr.write('hub-smoke: FAIL\n' + String(e && e.stack || e) + '\n');
  process.exit(1);
});
