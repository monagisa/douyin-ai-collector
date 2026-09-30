#!/usr/bin/env node
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const MCP = path.join(__dirname, 'mcp.js');

function frame(obj) {
  const s = JSON.stringify(obj);
  return 'Content-Length: ' + Buffer.byteLength(s) + '\r\n\r\n' + s;
}

function run(label, port, mode, extraArgs) {
  return new Promise((resolve) => {
    const args = [MCP, '--port', String(port)].concat(extraArgs || []);
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (e) {}
      resolve(payload);
    };
    const timer = setTimeout(() => {
      const ok = out.includes('douyin-collector-mcp') && out.includes('"id":1');
      finish({
        label,
        ok,
        reason: ok ? 'got-response' : 'timeout-no-response',
        out: out.slice(0, 600),
        err: err.slice(0, 600)
      });
    }, 2500);
    child.stdout.on('data', (c) => {
      out += c;
      if (out.includes('"id":1') && out.includes('douyin-collector-mcp')) {
        // 给 tools/list 一点时间
        setTimeout(() => {
          const hasTools = out.includes('ai_status');
          finish({
            label,
            ok: true,
            hasTools,
            out: out.slice(0, 400),
            err: err.slice(0, 400)
          });
        }, 400);
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
      }
    }, 200);
    clearTimeout(timer); // reset after start? keep simple: use 2500 from start
  });
}

// simpler explicit runner
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
          try { child.kill(); } catch (e) {}
          resolve({ label, ok: true, hasTools, out: out.slice(0, 350), err: err.slice(0, 350) });
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
  await new Promise((r) => setTimeout(r, 400));
  const results = [
    await handshake('CL-fresh', 18811, 'cl'),
    await handshake('NDJSON-fresh', 18812, 'ndjson'),
    await handshake('CL-port-conflict', 18803, 'cl')
  ];
  try { holder.kill(); } catch (e) {}
  console.log(JSON.stringify(results, null, 2));
  if (!results.every((r) => r.ok)) process.exit(1);
  console.log('ALL MCP HANDSHAKE: PASS');
})();
