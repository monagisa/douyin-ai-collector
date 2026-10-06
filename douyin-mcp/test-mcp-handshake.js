#!/usr/bin/env node
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const MCP = path.join(__dirname, 'mcp.js');

function frame(obj) {
  const s = JSON.stringify(obj);
  return 'Content-Length: ' + Buffer.byteLength(s) + '\r\n\r\n' + s;
}

/** 轮询等 holder 的 Hub 就绪（固定 sleep 在慢机器上会测不到真端口冲突） */
function waitHubUp(port, ms) {
  const http = require('http');
  const t0 = Date.now();
  return new Promise((resolve) => {
    const probe = () => {
      const r = http.get(`http://127.0.0.1:${port}/api/v1/health`, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      r.on('error', () => {
        if (Date.now() - t0 > ms) return resolve(false);
        setTimeout(probe, 60);
      });
    };
    probe();
  });
}

// explicit runner
function handshake(label, port, mode) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MCP, '--port', String(port)], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    let got = false;
    child.stdout.on('data', (c) => {
      out += c;
      if (!got && out.includes('douyin-collector-mcp') && out.includes('"id":1')) {
        got = true;
        setTimeout(() => {
          const hasTools = out.includes('ai_status');
          const hasSettingsTools = out.includes('ai_get_settings') && out.includes('ai_set_settings');
          const hasMaxParam = out.includes('目标条数上限');
          // 0.3.2：ai_export 必须同时暴露 videoId 与 all（全部视频导出）
          const hasExportAll = out.includes('ai_export') && out.includes('导出本地全部视频') && out.includes('"all"');
          try { child.kill(); } catch (e) {}
          resolve({ label, ok: true, hasTools, hasSettingsTools, hasMaxParam, hasExportAll, out: out.slice(0, 350), err: err.slice(0, 350) });
        }, 300);
      }
    });
    child.stderr.on('data', (c) => { err += c; });
    setTimeout(() => {
      if (mode === 'cl') {
        child.stdin.write(frame({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'mimo-sim', version: '1' }
          }
        }));
        child.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
      } else {
        child.stdin.write(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'ndjson-sim', version: '1' }
          }
        }) + '\n');
        // ndjson mode still send tools/list as ndjson
        setTimeout(() => {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        }, 50);
      }
    }, 200);
    setTimeout(() => {
      if (got) return;
      try { child.kill(); } catch (e) {}
      resolve({ label, ok: false, reason: 'timeout', out: out.slice(0, 350), err: err.slice(0, 350) });
    }, 4000);
  });
}

(async () => {
  const holder = spawn(process.execPath, [MCP, '--hub-only', '--port', '18803'], {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  const holderUp = await waitHubUp(18803, 5000);
  if (!holderUp) {
    try { holder.kill(); } catch (e) {}
    console.error('holder Hub 未就绪，CL-port-conflict 用例无意义');
    process.exit(1);
  }
  const results = [
    await handshake('CL-fresh', 18811, 'cl'),
    await handshake('NDJSON-fresh', 18812, 'ndjson'),
    await handshake('CL-port-conflict', 18803, 'cl')
  ];
  try { holder.kill(); } catch (e) {}
  console.log(JSON.stringify(results, null, 2));
  if (!results.every((r) => r.ok && r.hasTools && r.hasSettingsTools && r.hasMaxParam && r.hasExportAll)) process.exit(1);
  console.log('ALL MCP HANDSHAKE: PASS');
})();
