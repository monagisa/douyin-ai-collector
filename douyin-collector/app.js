(function () {
  const input = document.getElementById('hubUrl');
  const btn = document.getElementById('btnProbe');
  const badge = document.getElementById('probeBadge');
  const out = document.getElementById('probeOut');
  // 云图页里没有这些元素：直接跳过诊断页逻辑
  if (!input || !btn || !badge || !out) return;

  function setBadge(text, cls) {
    badge.textContent = text;
    badge.className = 'badge' + (cls ? ' ' + cls : '');
  }

  async function probe() {
    const url = (input.value || '').trim();
    if (!url) {
      setBadge('请填 URL', 'bad');
      out.textContent = 'Hub URL 不能为空。';
      return;
    }
    setBadge('探测中…', '');
    out.textContent = 'GET ' + url + '\n…';
    try {
      const res = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
      const text = await res.text();
      const acao = res.headers.get('access-control-allow-origin');
      const lines = [
        'HTTP ' + res.status,
        'access-control-allow-origin: ' + (acao || '(无)'),
        '',
        text
      ];
      out.textContent = lines.join('\n');
      if (res.ok) {
        setBadge('Hub 可达', 'ok');
      } else {
        setBadge('HTTP ' + res.status, 'bad');
      }
    } catch (e) {
      setBadge('失败', 'bad');
      out.textContent =
        'fetch 失败：' + (e && e.message ? e.message : String(e)) +
        '\n\n可能原因：\n1) douyin-mcp 未启动\n2) 端口不是 18765\n3) 本机防火墙拦截\n' +
        '\n请先运行：node <douyin-mcp 目录>/mcp.js';
    }
  }

  btn.addEventListener('click', probe);
  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') probe();
  });
})();

/* === BEGIN CLOUD VIEWER (v0.5.46) === */
(function () {
  var q = new URLSearchParams(location.search || '');
  if (q.get('cloudview') !== '1') return;
  var CSS = "/* 评论分析台 · 样式\n   v2 视觉：单一强调色只落在数据上；中性纯净深色底；1px 线分隔；无渐变、无玻璃、无发光。\n   参考 tasteskill（app-screens）：KPI 一大格用线切分、数字右对齐等宽、面板无阴影、标题 20px。 */\n\n:root {\n  --bg: #0b0b0c;\n  --surface: #131315;\n  --surface-2: #1a1a1d;\n  --line: #27272b;\n  --line-strong: #3a3a40;\n  --ink: #f4f4f5;\n  --text: #d3d3d6;\n  --muted: #a3a3a8;\n  --meta: #8e8e94;\n  --accent: #e0a94a;\n  --accent-ink: #1a1206;\n  --accent-dim: #2a2213;\n  --pos: #6cc59a;\n  --neg: #e08a84;\n  --r: 8px;\n  --r-ctl: 6px;\n  --shadow-float: 0 18px 44px rgba(0, 0, 0, .55);\n  --font: \"Segoe UI\", Inter, \"Microsoft YaHei UI\", \"Microsoft YaHei\", \"PingFang SC\", system-ui, -apple-system, sans-serif;\n  --mono: \"Cascadia Mono\", Consolas, ui-monospace, SFMono-Regular, Menlo, monospace;\n}\n\n* { box-sizing: border-box; }\nhtml, body { margin: 0; padding: 0; }\nbody {\n  background: var(--bg);\n  color: var(--text);\n  font: 14px/1.5 var(--font);\n  font-variant-numeric: tabular-nums;\n  min-height: 100vh;\n  padding-bottom: 32px;\n  -webkit-font-smoothing: antialiased;\n}\n\n/* ---------- 控件 ---------- */\n.btn {\n  appearance: none;\n  border: 1px solid var(--line-strong);\n  background: transparent;\n  color: var(--text);\n  padding: 7px 13px;\n  border-radius: var(--r-ctl);\n  font: 500 13px/1.25 var(--font);\n  cursor: pointer;\n  white-space: nowrap;\n  transition: border-color .15s, background .15s, color .15s;\n}\n.btn:hover { border-color: #55555c; color: var(--ink); background: #17171a; }\n.btn:active { transform: translateY(1px); }\n.btn:disabled { opacity: .4; cursor: not-allowed; }\n.btn:focus-visible, .select:focus-visible, .input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }\n/* 主操作：反白，不用强调色 */\n.btn.primary { background: var(--ink); border-color: var(--ink); color: #111113; font-weight: 600; }\n.btn.primary:hover { background: #fff; border-color: #fff; color: #000; }\n.btn.ghost { border-color: transparent; color: var(--muted); }\n.btn.ghost:hover { color: var(--ink); background: var(--surface-2); border-color: transparent; }\n.btn.small { padding: 5px 10px; font-size: 13px; }\n\n.select, .input {\n  appearance: none;\n  background: var(--surface-2);\n  color: var(--text);\n  border: 1px solid var(--line);\n  border-radius: var(--r-ctl);\n  padding: 6px 10px;\n  font: 13px/1.3 var(--font);\n  min-width: 130px;\n}\n.select { background-image: linear-gradient(45deg, transparent 50%, var(--meta) 50%), linear-gradient(135deg, var(--meta) 50%, transparent 50%); background-position: calc(100% - 15px) 52%, calc(100% - 10px) 52%; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; padding-right: 28px; }\n.select.small { min-width: 66px; padding: 4px 24px 4px 8px; font-size: 13px; }\n.input { min-width: 280px; }\n.input::placeholder { color: #7c7c82; }\n.select:hover, .input:hover { border-color: var(--line-strong); }\n\n.muted { color: var(--muted); }\n.small { font-size: 13px; }\n.meta { color: var(--meta); font-size: 13px; }\ncode { font-family: var(--mono); background: var(--surface-2); border: 1px solid var(--line); padding: 1px 5px; border-radius: 4px; font-size: 13px; color: var(--text); }\n.hidden { display: none !important; }\n.inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }\n\n/* ---------- 外壳 ---------- */\n.topbar {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 16px;\n  padding: 22px 28px 14px;\n  flex-wrap: wrap;\n}\n.brand { display: flex; align-items: center; gap: 11px; min-width: 0; }\n.brand .mark {\n  width: 30px; height: 30px; flex: 0 0 30px;\n  color: var(--accent);\n}\n.brand .shell-id { display: flex; flex-direction: column; gap: 2px; min-width: 0; }\n.brand h1 { font-size: 20px; line-height: 1.25; margin: 0; font-weight: 600; letter-spacing: -.01em; color: var(--ink); }\n.brand .scope { margin: 0; font-size: 13px; color: var(--meta); }\n.actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }\n\n/* ---------- KPI：一格，用线切分 ---------- */\n.kpis {\n  display: grid;\n  grid-auto-flow: column;\n  grid-auto-columns: 1fr;\n  margin: 0 28px 16px;\n  background: var(--surface);\n  border: 1px solid var(--line);\n  border-radius: var(--r);\n  overflow: hidden;\n}\n.kpis:empty { display: none; }\n.kpi { padding: 13px 18px 14px; min-width: 0; }\n.kpi + .kpi { box-shadow: inset 1px 0 0 var(--line); }\n.kpi .k { font-size: 13px; color: var(--meta); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.kpi .v { margin-top: 4px; font-size: 24px; line-height: 1.15; font-weight: 500; color: var(--ink); letter-spacing: -.01em; }\n.kpi .v small { font-size: 13px; font-weight: 400; color: var(--meta); margin-left: 5px; letter-spacing: 0; }\n@media (max-width: 860px) {\n  .kpis { grid-auto-flow: row; grid-template-columns: repeat(3, 1fr); }\n  .kpi + .kpi { box-shadow: inset 1px 0 0 var(--line); }\n}\n\n/* ---------- 主网格 ---------- */\n.grid {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) 322px;\n  gap: 14px;\n  padding: 0 28px 14px;\n  align-items: stretch;\n}\n@media (max-width: 1080px) {\n  .grid { grid-template-columns: minmax(0, 1fr); }\n  .side { position: static; }\n}\n\n.panel {\n  background: var(--surface);\n  border: 1px solid var(--line);\n  border-radius: var(--r);\n  min-width: 0;\n}\n.panel-head {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 12px;\n  padding: 12px 16px;\n  border-bottom: 1px solid var(--line);\n  flex-wrap: wrap;\n}\n.panel-head .panel-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }\n.panel-head h2 { font-size: 16px; font-weight: 600; margin: 0; color: var(--ink); letter-spacing: -.005em; }\n.panel-head .panel-sub { font-size: 13px; color: var(--meta); }\n.panel-head.sub { border-bottom: 0; padding: 12px 16px 2px; }\n.panel-head.sub h2 { font-size: 13px; font-weight: 600; color: var(--muted); }\n\n/* ---------- 词云 ---------- */\n.cloud-panel { display: flex; flex-direction: column; position: relative; height: 100%; }\n.cloud {\n  position: relative;\n  flex: 1 1 auto;\n  min-height: clamp(340px, 48vh, 500px);\n  margin: 0;\n  overflow: hidden;\n  background: var(--bg);\n  contain: layout paint;\n}\n.cloud-empty, .empty {\n  position: absolute; inset: 0;\n  pointer-events: none;\n  display: flex; flex-direction: column; align-items: center; justify-content: center;\n  gap: 6px; text-align: center; padding: 28px; color: var(--muted);\n}\n.empty .empty-mark { color: var(--line-strong); margin-bottom: 6px; }\n.empty strong { color: var(--text); font-weight: 600; font-size: 16px; }\n.empty p { margin: 0; font-size: 13px; color: var(--meta); line-height: 1.6; }\n.empty .btn { pointer-events: auto; margin-top: 12px; }\n.cloud-foot {\n  display: flex; align-items: center; justify-content: space-between; gap: 12px;\n  padding: 9px 16px; border-top: 1px solid var(--line);\n  font-size: 12px; color: var(--meta); flex-wrap: wrap;\n}\n.cloud-foot .swatch { display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: var(--accent); vertical-align: 0; margin-right: 5px; }\n.cloud-foot .swatch.grey { background: #b9b9be; }\n.cloud-foot .swatch.mono { background: #8e8e94; }\n\n.cw {\n  position: absolute;\n  left: 0; top: 0;\n  white-space: nowrap;\n  cursor: pointer;\n  user-select: none;\n  line-height: 1;\n  transform-origin: center center;\n  transition: transform .14s ease-out, color .14s, opacity .14s;\n  will-change: transform;\n}\n.cw:hover, .cw.hot { transform: scale(1.22); z-index: 30; color: var(--ink) !important; }\n.cw.dim { opacity: .22; }\n\n/* ---------- 侧栏 ---------- */\n.side { position: sticky; top: 12px; display: flex; flex-direction: column; align-self: stretch; max-height: calc(100vh - 24px); overflow-y: auto; overscroll-behavior: contain; }\n.word-list { list-style: none; margin: 0; padding: 6px 8px; flex: 0 0 auto; height: 322px; max-height: 322px; overflow: auto; }\n.word-list li {\n  display: grid;\n  grid-template-columns: 22px minmax(0, 1fr) auto;\n  align-items: center;\n  gap: 10px;\n  padding: 6px 8px;\n  border-radius: var(--r-ctl);\n  cursor: pointer;\n  font-size: 13px;\n  color: var(--text);\n}\n.word-list li:hover { background: var(--surface-2); color: var(--ink); }\n.word-list li .rank { color: var(--meta); font-size: 11px; text-align: right; }\n.word-list li .w { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.word-list li .n { color: var(--meta); font-size: 13px; text-align: right; }\n.word-list li .mark { width: 3px; height: 14px; border-radius: 1px; background: var(--accent); }\n.side-body { padding: 8px 16px 16px; display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--line); }\n/* v0.5.47：侧栏防御 —— 即使外层样式被旧缓存/窄容器影响，子项也整行铺开，复选框文字不逐字折行（曾出现「只看有主页的用户」竖排） */\n.side-body { flex-wrap: nowrap; align-items: stretch; }\n.side-body > * { flex: 0 0 auto; width: 100%; min-width: 0; }\n.check { white-space: nowrap; }\n.check input { flex: 0 0 auto; }\n.field { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--meta); }\n.field .select { width: 100%; }\n.check { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text); cursor: pointer; }\n.check input { accent-color: var(--ink); width: 14px; height: 14px; }\n\n/* ---------- 表格 ---------- */\n.table-panel { margin: 0 28px; }\n.table-wrap { position: relative; overflow: auto; height: 620px; min-height: 420px; max-height: 620px; }\ntable { width: 100%; border-collapse: collapse; table-layout: fixed; }\nthead th {\n  position: sticky; top: 0; z-index: 2;\n  background: var(--surface);\n  text-align: left;\n  font-size: 12px;\n  font-weight: 500;\n  color: var(--meta);\n  padding: 10px 14px;\n  border-bottom: 1px solid var(--line);\n}\ntbody td {\n  padding: 11px 14px;\n  border-bottom: 1px solid #1e1e21;\n  vertical-align: top;\n  font-size: 13px;\n  color: var(--text);\n}\ntbody tr:last-child td { border-bottom: 0; }\ntbody tr:hover { background: #17171a; }\n.col-text { width: auto; }\n.col-user { width: 176px; }\n.col-num { width: 76px; text-align: right; }\n.col-ip { width: 84px; }\n.col-time { width: 132px; white-space: nowrap; }\ntd.muted { white-space: nowrap; }\n.col-level { width: 68px; }\ntd.num { text-align: right; color: var(--ink); }\ntd .txt { white-space: pre-wrap; word-break: break-word; color: var(--ink); }\ntd .txt .hl { background: #4a3a17; color: #f0cd8f; border-radius: 2px; padding: 0 2px; }\n.video-link { color: var(--meta); text-decoration: none; }\n.video-link:hover { color: var(--text); text-decoration: underline; }\n.badges { display: inline-flex; gap: 5px; margin-left: 6px; vertical-align: 1px; }\n.badge {\n  font-size: 11px;\n  line-height: 1.5;\n  border-radius: 4px;\n  padding: 0 5px;\n  border: 1px solid var(--line);\n  color: var(--meta);\n  white-space: nowrap;\n}\n.badge.hot { color: #f0cd8f; border-color: #4a3a17; background: var(--accent-dim); }\n.badge.reply { color: #c8c8cd; border-color: #333338; background: #1c1c20; }\n.badge.fold { color: var(--meta); }\n.user-cell { display: flex; align-items: center; gap: 9px; min-width: 0; }\n.avatar {\n  width: 26px; height: 26px; border-radius: 50%;\n  flex: 0 0 26px;\n  display: flex; align-items: center; justify-content: center;\n  font-size: 11px; font-weight: 600;\n  background: #232327;\n  color: #c9c9ce;\n}\n.user-meta { min-width: 0; }\n.user-name {\n  display: block;\n  color: var(--text);\n  text-decoration: none;\n  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;\n  max-width: 132px;\n}\na.user-name:hover { color: var(--ink); text-decoration: underline; }\n.user-name.nolink { color: var(--meta); cursor: default; }\n.user-sub { font-family: var(--mono); font-size: 12px; color: var(--meta); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 132px; }\n.empty.small { position: static; padding: 28px; }\n\n.pager { display: flex; align-items: center; justify-content: center; gap: 4px; padding: 12px; flex-wrap: wrap; }\n.pager button {\n  min-width: 30px;\n  padding: 4px 8px;\n  border-radius: var(--r-ctl);\n  border: 1px solid transparent;\n  background: transparent;\n  color: var(--muted);\n  font: 500 12px/1.4 var(--font);\n  cursor: pointer;\n}\n.pager button:hover { color: var(--ink); background: var(--surface-2); }\n.pager button.on { background: var(--ink); border-color: var(--ink); color: #111113; font-weight: 600; }\n.pager button:disabled { opacity: .32; cursor: not-allowed; }\n.pager .info { color: var(--meta); font-size: 13px; margin: 0 8px; }\n\n.foot {\n  display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;\n  padding: 16px 30px 0; color: var(--meta); font-size: 12px;\n}\n\n/* ---------- 悬浮框（浮层才给阴影） ---------- */\n.tooltip {\n  position: fixed;\n  z-index: 100;\n  max-width: 380px;\n  background: var(--surface-2);\n  border: 1px solid var(--line-strong);\n  border-radius: var(--r);\n  box-shadow: var(--shadow-float);\n  padding: 12px 14px;\n  pointer-events: auto;\n}\n.tooltip .tt-word { font-size: 15px; font-weight: 600; color: var(--ink); }\n.tooltip .tt-meta { color: var(--meta); font-size: 13px; margin: 3px 0 9px; }\n.tt-comments { display: flex; flex-direction: column; gap: 0; }\n.tt-item {\n  display: block; text-decoration: none; color: inherit;\n  padding: 8px 0;\n  border-top: 1px solid var(--line);\n}\n.tt-item:first-child { border-top: 0; }\n.tt-item:hover { background: #1f1f23; }\n.tt-item .tt-txt { font-size: 13px; color: var(--text); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }\n.tt-item .tt-user { font-size: 13px; color: var(--meta); margin-top: 3px; }\n.tt-item .tt-user .go { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }\n.tt-more { margin-top: 8px; padding-top: 9px; border-top: 1px solid var(--line); font-size: 13px; color: var(--text); cursor: pointer; user-select: none; }\n.tt-more:hover { color: var(--ink); text-decoration: underline; }\n\n/* ---------- 抽屉 ---------- */\n.drawer {\n  position: fixed;\n  right: 0; top: 0; bottom: 0;\n  width: min(560px, 94vw);\n  z-index: 90;\n  background: var(--surface);\n  border-left: 1px solid var(--line-strong);\n  box-shadow: -18px 0 44px rgba(0, 0, 0, .45);\n  display: flex;\n  flex-direction: column;\n  animation: slideIn .16s ease-out;\n}\n@keyframes slideIn { from { transform: translateX(18px); opacity: .7; } to { transform: none; opacity: 1; } }\n.drawer-head {\n  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;\n  padding: 16px 18px 13px; border-bottom: 1px solid var(--line);\n}\n.drawer-head h3 { margin: 0 0 3px; font-size: 16px; font-weight: 600; color: var(--ink); }\n.drawer-head p { margin: 0; }\n.drawer-body { flex: 1 1 auto; overflow: auto; padding: 4px 14px 8px; }\n.dc { padding: 12px 4px; border-bottom: 1px solid var(--line); }\n.dc:last-child { border-bottom: 0; }\n.dc-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 7px; }\n.dc-user { display: flex; align-items: center; gap: 9px; min-width: 0; }\n.dc-text { white-space: pre-wrap; word-break: break-word; font-size: 13px; color: var(--ink); }\n.dc-meta { display: flex; gap: 12px; flex-wrap: wrap; color: var(--meta); font-size: 13px; margin-top: 8px; }\n.dc-meta .spacer { flex: 1 1 auto; }\n.dc-go {\n  color: var(--text); font-size: 12px; text-decoration: none; white-space: nowrap;\n  border: 1px solid var(--line-strong); padding: 3px 9px; border-radius: var(--r-ctl);\n}\n.dc-go:hover { color: var(--ink); border-color: #55555c; background: var(--surface-2); }\n.dc-go.off { color: var(--meta); border-color: var(--line); cursor: default; }\n.drawer-foot {\n  display: flex; justify-content: space-between; gap: 10px;\n  padding: 12px 18px; border-top: 1px solid var(--line);\n}\n.drawer-foot .btn { flex: 1 1 auto; }\n\n/* ---------- toast ---------- */\n.toast {\n  position: fixed;\n  left: 50%; bottom: 28px;\n  transform: translateX(-50%);\n  background: var(--surface-2);\n  border: 1px solid var(--line-strong);\n  color: var(--text);\n  padding: 9px 16px;\n  border-radius: var(--r);\n  font-size: 13px;\n  z-index: 150;\n  box-shadow: var(--shadow-float);\n  max-width: min(720px, 92vw);\n}\n\n/* ---------- 加载骨架屏（请求/解析时占位，避免白屏与跳动） ---------- */\nbody.is-loading #cloud .cw,\nbody.is-loading #cloudEmpty,\nbody.is-loading #tbody,\nbody.is-loading #tableEmpty,\nbody.is-loading #wordList li:not(.sk-li) { visibility: hidden; }\nbody.is-loading .kpi .v { color: transparent; position: relative; }\nbody.is-loading .kpi .v::after {\n  content: '';\n  position: absolute;\n  left: 0;\n  top: 50%;\n  transform: translateY(-50%);\n  width: 66px;\n  height: 22px;\n  border-radius: 4px;\n  background: #2e2e34;\n  animation: skPulse 1.15s ease-in-out infinite;\n}\n.sk-cloud {\n  position: absolute;\n  inset: 14px;\n  display: none;\n}\n.sk-cloud i {\n  position: absolute;\n  display: block;\n  border-radius: 12px;\n  background: #26262c;\n  animation: skBlockPulse 1.5s ease-in-out infinite;\n}\n.sk-table {\n  position: absolute;\n  inset: 0;\n  padding: 16px 18px;\n  display: none;\n  flex-direction: column;\n  gap: 15px;\n  background: var(--surface);\n}\n.sk-row { display: flex; gap: 16px; align-items: center; }\n.sk-row i {\n  height: 12px;\n  border-radius: 3px;\n  background: #2e2e34;\n  animation: skPulse 1.15s ease-in-out infinite;\n}\n@keyframes skBlockPulse { 0%, 100% { opacity: 0.35 } 50% { opacity: 0.75 } }\n@keyframes skPulse { 0%, 100% { opacity: 0.5 } 50% { opacity: 1 } }\nbody.is-loading .sk-cloud { display: block; }\nbody.is-loading .sk-table { display: flex; }\n#wordList li.sk-li { opacity: 1; display: block; padding: 4px 0; }\nbody.is-loading .kpi .v * { color: transparent; }\n#wordList li.sk-li i {\n  display: block;\n  height: 12px;\n  border-radius: 3px;\n  background: #2e2e34;\n  animation: skPulse 1.15s ease-in-out infinite;\n}\n.sk-cloud[hidden],\n.sk-table[hidden] { display: none !important; }\n\n/* ---------- 空状态：布局保持不变，只把内容变淡（避免切换数据时整页重排） ---------- */\nbody.is-empty .cloud-panel { min-height: 460px; }\nbody.is-empty .side .word-list,\nbody.is-empty .side .filters,\nbody.is-empty .table-wrap tbody { opacity: 0.55; }\n\n/* 滚动条 */\n::-webkit-scrollbar { width: 10px; height: 10px; }\n::-webkit-scrollbar-thumb { background: #2c2c31; border-radius: 8px; border: 2px solid var(--surface); }\n::-webkit-scrollbar-thumb:hover { background: #3a3a40; }\n::-webkit-scrollbar-track { background: transparent; }\n\n/* v0.5.41：自定义加词 / 屏蔽词 */\n.kw-tune {\n  margin-top: 10px;\n  padding-top: 10px;\n  border-top: 1px solid var(--line);\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n}\n.kw-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--meta); }\n.kw-row > span { flex: 0 0 34px; }\n.kw-input {\n  flex: 1 1 auto;\n  min-width: 0;\n  background: var(--surface-2);\n  border: 1px solid var(--line);\n  color: var(--text);\n  border-radius: 6px;\n  padding: 5px 8px;\n  font-size: 13px;\n  font-family: inherit;\n}\n.kw-input::placeholder { color: var(--meta); opacity: 0.7; }\n.kw-input:focus { outline: none; border-color: var(--line-strong); }\n\n\n/* ===================== v2.8：洞察面板（情感 / 趋势 / 地域 / 主题） ===================== */\n.insights { padding-bottom: 4px; }\n.insight-grid {\n  display: grid;\n  grid-template-columns: repeat(2, minmax(0, 1fr));\n  gap: 1px;\n  background: var(--line);\n  border-top: 1px solid var(--line);\n}\n.insight-card { background: var(--surface); padding: 12px 18px 14px; min-width: 0; }\n.insight-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 8px; }\n.insight-head h3 { margin: 0; font-size: 13px; font-weight: 600; color: var(--text); letter-spacing: .02em; }\n.insight-body { min-height: 96px; }\n.insights.is-empty .insight-body { color: var(--meta); }\n.sent-bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--surface-2); }\n.sent-seg { display: block; height: 100%; }\n.sent-seg.pos { background: var(--pos); }\n.sent-seg.neu { background: var(--line-strong); }\n.sent-seg.neg { background: var(--neg); }\n.sent-list { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 9px; font-size: 13px; color: var(--muted); }\n.sent-list .sw-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; vertical-align: 1px; }\n.sw-dot.pos { background: var(--pos); }\n.sw-dot.neu { background: var(--line-strong); }\n.sw-dot.neg { background: var(--neg); }\n.mini-list { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 8px; }\n.mini-h { font-size: 12px; color: var(--meta); margin-bottom: 4px; }\n.mini-row { display: flex; width: 100%; gap: 10px; padding: 4px 0; background: none; border: 0; text-align: left; color: var(--text); font-size: 13px; cursor: pointer; }\n.mini-row:hover .mini-txt { color: var(--ink); }\n.mini-txt { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.mini-num { flex: 0 0 auto; color: var(--meta); font-variant-numeric: tabular-nums; }\n.trend { width: 100%; height: 92px; display: block; }\n.trend .area { fill: rgba(224, 169, 74, .10); }\n.trend .line { fill: none; stroke: var(--accent); stroke-width: 1.6; }\n.trend .negline { fill: none; stroke: var(--neg); stroke-width: 1.2; stroke-dasharray: 3 3; opacity: .85; }\n.trend .dot { fill: var(--accent); }\n.legend { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--meta); margin-top: 6px; }\n.legend i { display: inline-block; width: 14px; height: 2px; margin-right: 6px; vertical-align: 3px; }\n.legend .sw-line { background: var(--accent); }\n.legend .sw-neg { background: var(--neg); }\n.axis { display: flex; justify-content: space-between; font-size: 11px; color: var(--meta); margin-top: 2px; font-variant-numeric: tabular-nums; }\n.region-row { display: flex; align-items: center; gap: 10px; padding: 3px 0; font-size: 13px; }\n.region-name { flex: 0 0 62px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.region-bar { flex: 1 1 auto; height: 6px; background: var(--surface-2); border-radius: 3px; overflow: hidden; }\n.region-bar i { display: block; height: 100%; background: var(--line-strong); }\n.region-num { flex: 0 0 auto; width: 52px; text-align: right; color: var(--meta); font-variant-numeric: tabular-nums; }\n.topic-item { padding: 7px 0; border-top: 1px solid var(--line); }\n.topic-item:first-child { border-top: 0; padding-top: 0; }\n.topic-main { display: flex; width: 100%; gap: 10px; align-items: baseline; background: none; border: 0; padding: 0; cursor: pointer; text-align: left; }\n.topic-label { flex: 1 1 auto; font-size: 13px; color: var(--ink); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.topic-main:hover .topic-label { color: var(--accent); }\n.topic-count { flex: 0 0 auto; font-size: 12px; color: var(--meta); font-variant-numeric: tabular-nums; }\n.topic-terms { display: flex; flex-wrap: wrap; gap: 5px; margin: 5px 0 4px; }\n.chip { border: 1px solid var(--line-strong); background: var(--surface-2); color: var(--muted); font-size: 12px; padding: 1px 7px; border-radius: 10px; cursor: pointer; }\n.chip:hover { color: var(--ink); border-color: var(--accent); }\n.topic-rep { font-size: 12px; color: var(--meta); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.6; }\n.sbadge { display: inline-block; padding: 0 6px; border-radius: 9px; font-size: 12px; line-height: 18px; }\n.sbadge.pos { color: var(--pos); background: rgba(108, 197, 154, .12); }\n.sbadge.neu { color: var(--meta); background: rgba(142, 142, 148, .12); }\n.sbadge.neg { color: var(--neg); background: rgba(224, 138, 132, .14); }\n.col-sent { width: 76px; }\n@media (max-width: 900px) {\n  .insight-grid { grid-template-columns: 1fr; }\n}\n\n/* v3.1：情感健康度卡（跨两列） */\n.insight-card.health { grid-column: 1 / -1; }\n.health-top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }\n.health-score b { font-size: 30px; line-height: 1; font-variant-numeric: tabular-nums; }\n.health-score small { color: var(--meta); margin-left: 2px; }\n.health-grade { padding: 2px 10px; border-radius: 999px; font-size: 12px; border: 1px solid var(--line-strong); }\n.health-grade.h-good { color: #6cc59a; border-color: rgba(108, 197, 154, .45); }\n.health-grade.h-ok { color: #a8d08d; border-color: rgba(168, 208, 141, .45); }\n.health-grade.h-mid { color: #e0a94a; border-color: rgba(224, 169, 74, .45); }\n.health-grade.h-warn { color: #e0a94a; border-color: rgba(224, 169, 74, .6); }\n.health-grade.h-bad { color: #e08a84; border-color: rgba(224, 138, 132, .5); }\n.health-bar { position: relative; flex: 1 1 240px; height: 8px; border-radius: 4px; background: var(--surface-2); overflow: hidden; }\n.health-bar i { display: block; height: 100%; border-radius: 4px; }\n.health-bar i.h-good { background: #6cc59a; }\n.health-bar i.h-ok { background: #a8d08d; }\n.health-bar i.h-mid, .health-bar i.h-warn { background: #e0a94a; }\n.health-bar i.h-bad { background: #e08a84; }\n.health-bar .mk { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--bg); opacity: .8; }\n.health-metrics { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }\n.health-metrics th, .health-metrics td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--line); color: var(--muted); }\n.health-metrics th { color: var(--meta); font-weight: 500; }\n.health-metrics td.num { text-align: right; font-variant-numeric: tabular-nums; color: var(--text); }\n.health-metrics tbody tr:last-child td { border-bottom: 0; }\n\n/* ==========================================================================\n   v4.0 设备兼容性适配 + 视觉打磨\n   - 间距/字号用 clamp，360~1920px 不出现横向溢出\n   - KPI 用 1px gap 画线：换行时分割线不错位\n   - ≤620px 评论表变卡片列表（td 的 data-label 由 app.js 注入）\n   - 触屏：关掉 hover 放大、控件热区 ≥40px；尊重 prefers-reduced-motion\n   ========================================================================== */\n:root {\n  --pad-x: clamp(16px, 3vw, 28px);\n  --gap-y: clamp(10px, 1.4vw, 16px);\n  --r-panel: 10px;\n}\nhtml { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }\nbody {\n  overflow-x: hidden;\n  padding-left: env(safe-area-inset-left);\n  padding-right: env(safe-area-inset-right);\n  padding-bottom: calc(28px + env(safe-area-inset-bottom));\n}\nbutton, .btn, .select, .input, .check, .kw-input { touch-action: manipulation; }\ncode { overflow-wrap: anywhere; }\n.empty p { overflow-wrap: anywhere; }\n\n/* 外壳：统一水平节奏 */\n.topbar { padding: clamp(14px, 2.6vw, 22px) var(--pad-x) clamp(10px, 1.6vw, 14px); }\n.brand h1 { font-size: clamp(18px, 1.6vw, 20px); }\n.kpis {\n  margin: 0 var(--pad-x) var(--gap-y);\n  display: grid;\n  grid-auto-flow: column;\n  grid-auto-columns: minmax(0, 1fr);\n  gap: 1px;\n  background: var(--line);\n  border: 1px solid var(--line);\n  border-radius: var(--r-panel);\n  overflow: hidden;\n}\n.kpi {\n  background: var(--surface);\n  box-shadow: none !important;\n  padding: clamp(10px, 1.2vw, 14px) clamp(12px, 1.4vw, 18px);\n}\n.kpi .v { font-size: clamp(20px, 1.9vw, 26px); }\n.grid { padding: 0 var(--pad-x) var(--gap-y); gap: var(--gap-y); }\n.panel { border-radius: var(--r-panel); }\n.panel-head { padding: 12px clamp(12px, 1.4vw, 18px); }\n.table-panel { margin: 0 var(--pad-x); }\n.table-wrap { height: auto; max-height: 620px; min-height: 240px; }\nbody.is-empty .table-wrap { min-height: 140px; max-height: none; }\n.foot { padding: clamp(12px, 1.6vw, 18px) var(--pad-x) 0; }\n\n/* 平板：KPI 换 4 列 */\n@media (max-width: 900px) {\n  .kpis { grid-auto-flow: row; grid-template-columns: repeat(4, minmax(0, 1fr)); }\n}\n/* 平板竖屏 / 大手机：单列主区、侧栏不粘顶 */\n@media (max-width: 1080px) {\n  .side { position: static; max-height: none; overflow: visible; }\n  .word-list { height: auto; max-height: min(46vh, 380px); }\n  .cloud { min-height: clamp(240px, 40vh, 420px); }\n}\n/* 手机：顶栏竖排、KPI 2 列、洞察单列 */\n@media (max-width: 700px) {\n  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }\n  .topbar { flex-direction: column; align-items: stretch; gap: 12px; }\n  .actions { justify-content: flex-start; }\n  .actions .btn { flex: 1 1 auto; }\n  .brand .mark { width: 26px; height: 26px; flex-basis: 26px; }\n  .insight-grid { grid-template-columns: 1fr; }\n  .insight-card { padding: 12px 14px; }\n  .cloud-foot { font-size: 12px; gap: 6px 12px; }\n  .cloud-foot span:last-child { display: none; }\n  .pager { gap: 2px; padding: 10px 6px; }\n  .pager button { min-width: 28px; padding: 6px 7px; }\n  .pager .info { flex: 0 0 100%; text-align: center; margin: 4px 0 0; }\n}\n/* 窄手机：评论表变卡片列表 */\n@media (max-width: 620px) {\n  .table-wrap { max-height: none; overflow: visible; }\n  #table, #table tbody, #table tbody tr { display: block; }\n  #table thead { display: none; }\n  #table tbody tr { padding: 12px 14px; border-bottom: 1px solid var(--line); }\n  #table tbody tr:last-child { border-bottom: 0; }\n  #table tbody td { display: flex; align-items: flex-start; gap: 10px; padding: 3px 0; border: 0; font-size: 13px; }\n  #table tbody td::before { content: attr(data-label); flex: 0 0 52px; color: var(--meta); font-size: 12px; line-height: 1.6; }\n  #table tbody td.cell-text { display: block; padding: 0 0 6px; }\n  #table tbody td.cell-text::before { content: none; }\n  #table tbody td .txt { font-size: 14px; }\n  #table tbody td .user-name, #table tbody td .user-sub { max-width: 100%; }\n  #table tbody td.num { text-align: left; }\n  #table tbody td:empty { display: none; }\n  .table-panel .panel-head .inline { width: 100%; }\n  .table-panel .panel-head .input { min-width: 0; flex: 1 1 100%; }\n  .table-panel .panel-head .select, .table-panel .panel-head .btn { flex: 1 1 auto; }\n}\n/* 触屏：点击热区 + 关掉 hover 放大 */\n@media (hover: none), (pointer: coarse) {\n  .cw:hover { transform: none; }\n  .cw.hot { transform: scale(1.05); }\n  .btn, .select, .input { min-height: 40px; }\n  .check { min-height: 40px; }\n  .word-list li { padding: 10px 8px; }\n  .tt-item { padding: 10px 0; }\n}\n/* 大屏：侧栏略宽、词云更高 */\n@media (min-width: 1600px) {\n  .grid { grid-template-columns: minmax(0, 1fr) 360px; }\n  .cloud { min-height: clamp(420px, 46vh, 560px); }\n}\n/* 减少动效 */\n@media (prefers-reduced-motion: reduce) {\n  *, *::before, *::after {\n    animation-duration: .001s !important;\n    animation-iteration-count: 1 !important;\n    transition-duration: .001s !important;\n    scroll-behavior: auto !important;\n  }\n}\n\n/* v4.0 细节：窄屏评论表用两列网格 —— 文字/用户整行，元信息两列并排，单条不再过高 */\n@media (max-width: 620px) {\n  #table tbody tr {\n    display: grid;\n    grid-template-columns: repeat(2, minmax(0, 1fr));\n    gap: 2px 10px;\n    padding: 12px 12px 10px;\n  }\n  #table tbody td.cell-text { grid-column: 1 / -1; padding-bottom: 4px; }\n  #table tbody td[data-label=\"用户\"] { grid-column: 1 / -1; padding-bottom: 2px; }\n  #table tbody td { padding: 2px 0; }\n  #table tbody td::before { flex: 0 0 44px; }\n}\n\n/* v0.5.51：洞察卡片等高——卡片内竖向弹性，主题列表与左侧「地域分布」同高、超出在卡片内滚动 */\n.insight-card { display: flex; flex-direction: column; }\n.insight-card .insight-body { flex: 1 1 auto; min-width: 0; }\n.insight-card.topic-card .insight-body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-right: 4px; }\n.insight-card.topic-card .insight-body::-webkit-scrollbar { width: 8px; }\n.insight-card.topic-card .insight-body::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 4px; }\n@media (max-width: 700px) {\n  .insight-card.topic-card .insight-body { max-height: none !important; overflow-y: visible; }\n}\n";
  var MARKUP = "\n<header class=\"topbar\">\n  <div class=\"brand\">\n    <svg class=\"mark\" viewBox=\"0 0 32 32\" fill=\"none\" aria-hidden=\"true\">\n      <path d=\"M5 8.5A3.5 3.5 0 0 1 8.5 5h15A3.5 3.5 0 0 1 27 8.5v10a3.5 3.5 0 0 1-3.5 3.5H14l-6.2 4.6A1 1 0 0 1 6.2 25.8V22H8.5A3.5 3.5 0 0 1 5 18.5v-10Z\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linejoin=\"round\"/>\n      <circle cx=\"11\" cy=\"13.5\" r=\"1.4\" fill=\"currentColor\"/>\n      <circle cx=\"16\" cy=\"13.5\" r=\"1.4\" fill=\"currentColor\"/>\n      <circle cx=\"21\" cy=\"13.5\" r=\"1.4\" fill=\"currentColor\"/>\n    </svg>\n    <div class=\"shell-id\">\n      <h1>评论分析台</h1>\n      <p class=\"scope\" id=\"sourceInfo\">未载入数据</p>\n    </div>\n  </div>\n  <div class=\"actions\">\n    <button id=\"btnOpenFiles\" class=\"btn primary\" type=\"button\">打开导出文件…</button>\n    <button id=\"btnOpenDir\" class=\"btn\" type=\"button\">打开导出目录…</button>\n    <button id=\"btnClear\" class=\"btn ghost\" type=\"button\" disabled>清空</button>\n  </div>\n  <input type=\"file\" id=\"fileInput\" accept=\".json,.csv,application/json,text/csv\" multiple hidden>\n  <input type=\"file\" id=\"dirInput\" webkitdirectory directory multiple hidden>\n</header>\n\n<section id=\"kpis\" class=\"kpis\" aria-label=\"总览\"></section>\n\n<main class=\"grid\">\n  <section class=\"panel cloud-panel\">\n    <div class=\"panel-head\">\n      <div class=\"panel-title\">\n        <h2>词云</h2>\n        <span id=\"cloudSub\" class=\"panel-sub\"></span>\n      </div>\n      <div class=\"inline\">\n        <label class=\"meta\" for=\"cloudSize\">词数</label>\n        <select id=\"cloudSize\" class=\"select small\">\n          <option value=\"80\">80</option>\n          <option value=\"120\" selected>120</option>\n          <option value=\"160\">160</option>\n          <option value=\"220\">220</option>\n        </select>\n        <button id=\"btnRelayout\" class=\"btn small ghost\" type=\"button\">重新排布</button>\n      </div>\n    </div>\n    <div id=\"cloud\" class=\"cloud\" aria-label=\"评论关键词词云\"></div>\n    <div id=\"skCloud\" class=\"sk-cloud\" aria-hidden=\"true\" hidden></div>\n    <div id=\"cloudEmpty\" class=\"empty\">\n      <svg class=\"empty-mark\" width=\"34\" height=\"34\" viewBox=\"0 0 32 32\" fill=\"none\" aria-hidden=\"true\">\n        <path d=\"M5 8.5A3.5 3.5 0 0 1 8.5 5h15A3.5 3.5 0 0 1 27 8.5v10a3.5 3.5 0 0 1-3.5 3.5H14l-6.2 4.6A1 1 0 0 1 6.2 25.8V22H8.5A3.5 3.5 0 0 1 5 18.5v-10Z\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linejoin=\"round\"/>\n      </svg>\n      <strong>还没有数据</strong>\n      <p>载入插件或扩展导出的 <code>douyin-comments-*.json</code> / <code>.csv</code>，<br>也可以直接选整个导出目录，一次载入多条视频。</p>\n      <p class=\"meta\">数据只在本机浏览器里处理，不上传任何服务器。</p>\n      <button id=\"btnOpenFiles2\" class=\"btn primary\" type=\"button\">打开导出文件…</button>\n    </div>\n    <div class=\"cloud-foot\">\n      <span><span class=\"swatch\"></span>高频词 <span class=\"swatch grey\" style=\"margin-left:12px\"></span>一般 <span class=\"swatch mono\" style=\"margin-left:12px\"></span>低频 · 字号 = 出现次数</span>\n      <span>悬停看样例评论 · 点词看全部</span>\n    </div>\n  </section>\n\n  <aside class=\"panel side\">\n    <div class=\"panel-head\">\n      <div class=\"panel-title\">\n        <h2>关键词</h2>\n        <span id=\"wordInfo\" class=\"panel-sub\"></span>\n      </div>\n    </div>\n    <ol id=\"wordList\" class=\"word-list\"></ol>\n    <div class=\"panel-head sub\">\n      <h2>筛选</h2>\n    </div>\n    <!-- v0.5.50：侧栏内联样式，避免旧缓存 CSS 把复选框挤成竖排 -->\n    <div class=\"side-body\" style=\"display:flex;flex-direction:column;align-items:stretch;gap:10px;width:100%;min-width:0;\">\n      <label class=\"field\">\n        <span>视频</span>\n        <select id=\"videoFilter\" class=\"select\"></select>\n      </label>\n      <label class=\"field\">\n        <span>情感</span>\n        <select id=\"sentFilter\" class=\"select\">\n          <option value=\"\">全部情感</option>\n          <option value=\"pos\">只看正向</option>\n          <option value=\"neu\">只看中性</option>\n          <option value=\"neg\">只看负向</option>\n        </select>\n      </label>\n      <label class=\"field\">\n        <span>主题</span>\n        <select id=\"topicFilter\" class=\"select\" disabled><option value=\"\">全部主题</option></select>\n      </label>\n      <button id=\"btnOpenVideo\" class=\"btn small\" type=\"button\" disabled title=\"在新标签页打开当前选中视频的抖音页面\">打开原视频 ↗</button>\n      <label class=\"check\" style=\"display:flex;flex-direction:row;align-items:center;gap:8px;width:100%;min-width:0;white-space:nowrap;margin:0;box-sizing:border-box;\"><input type=\"checkbox\" id=\"onlyHasProfile\" style=\"flex:0 0 auto;margin:0;\"> 只看有主页的用户</label>\n      <label class=\"check\" style=\"display:flex;flex-direction:row;align-items:center;gap:8px;width:100%;min-width:0;white-space:nowrap;margin:0;box-sizing:border-box;\"><input type=\"checkbox\" id=\"onlyTopLevel\" style=\"flex:0 0 auto;margin:0;\"> 只看一级评论</label>\n      <label class=\"check\" style=\"display:flex;flex-direction:row;align-items:center;gap:8px;width:100%;min-width:0;white-space:nowrap;margin:0;box-sizing:border-box;\"><input type=\"checkbox\" id=\"onlyNonEmpty\" style=\"flex:0 0 auto;margin:0;\"> 只看有文字的评论</label>\n            <label class=\"check\" style=\"display:flex;flex-direction:row;align-items:center;gap:8px;width:100%;min-width:0;white-space:nowrap;margin:0;box-sizing:border-box;\" title=\"过滤「这种 / 都是 / 我的」这类没有信息量的词\"><input type=\"checkbox\" id=\"onlyContent\" style=\"flex:0 0 auto;margin:0;\" checked> 过滤虚词</label>\n      <div class=\"kw-tune\" title=\"加词：保证长词不被切碎（如「露营装备」）；屏蔽词：从词云里剔除\">\n        <label class=\"kw-row\"><span>加词</span><input id=\"kwKeep\" class=\"kw-input\" type=\"text\" placeholder=\"逗号分隔，如：露营装备\" autocomplete=\"off\" spellcheck=\"false\"></label>\n        <label class=\"kw-row\"><span>屏蔽</span><input id=\"kwBlock\" class=\"kw-input\" type=\"text\" placeholder=\"如：真的,感觉\" autocomplete=\"off\" spellcheck=\"false\"></label>\n      </div>\n    </div>\n  </aside>\n</main>\n\n<section class=\"panel insights\" id=\"insights\" aria-label=\"洞察\">\n  <div class=\"panel-head\">\n    <div class=\"panel-title\">\n      <h2>洞察</h2>\n      <span id=\"insightSub\" class=\"panel-sub\"></span>\n    </div>\n  </div>\n  <div class=\"insight-grid\" id=\"insightGrid\"></div>\n</section>\n\n<section class=\"panel table-panel\">\n  <div class=\"panel-head\">\n    <div class=\"panel-title\">\n      <h2>评论表</h2>\n      <span id=\"tableCount\" class=\"panel-sub\"></span>\n    </div>\n    <div class=\"inline\">\n      <input id=\"search\" class=\"input\" type=\"search\" placeholder=\"搜索评论内容 / 昵称 / 抖音号…\" autocomplete=\"off\">\n      <select id=\"sortBy\" class=\"select\">\n        <option value=\"digg\">按点赞降序</option>\n        <option value=\"time\">按时间降序</option>\n        <option value=\"len\">按字数降序</option>\n        <option value=\"replies\">按回复数降序</option>\n      </select>\n      <button id=\"btnExport\" class=\"btn small\" type=\"button\" disabled>导出 CSV</button>\n          <button id=\"btnExportJson\" class=\"btn small\" type=\"button\" disabled>导出 JSON</button>\n    </div>\n  </div>\n  <div class=\"table-wrap\">\n    <table id=\"table\">\n      <thead>\n        <tr>\n          <th class=\"col-text\">评论内容</th>\n          <th class=\"col-user\">用户</th>\n          <th class=\"col-num\">点赞</th>\n          <th class=\"col-num\">回复</th>\n          <th class=\"col-ip\">属地</th>\n          <th class=\"col-time\">时间</th>\n          <th class=\"col-level\">层级</th>\n          <th class=\"col-sent\">情感</th>\n        </tr>\n      </thead>\n      <tbody id=\"tbody\"></tbody>\n    </table>\n    <div id=\"tableEmpty\" class=\"empty small\">没有符合条件的评论</div>\n    <div id=\"skTable\" class=\"sk-table\" aria-hidden=\"true\" hidden></div>\n  </div>\n  <nav id=\"pager\" class=\"pager\"></nav>\n</section>\n\n<footer class=\"foot\">\n  <span>本地静态页面 · 数据不上传</span>\n  <span>点昵称跳抖音主页（需导出数据带 sec_uid）</span>\n  <span id=\"uiVer\">v0.5.53</span>\n</footer>\n\n<div id=\"tooltip\" class=\"tooltip hidden\" role=\"tooltip\"></div>\n\n<aside id=\"drawer\" class=\"drawer hidden\" aria-label=\"关键词评论列表\">\n  <div class=\"drawer-head\">\n    <div>\n      <h3 id=\"drawerTitle\">关键词</h3>\n      <p id=\"drawerSub\" class=\"meta\"></p>\n    </div>\n    <button id=\"btnCloseDrawer\" class=\"btn ghost small\" type=\"button\">关闭</button>\n  </div>\n  <div id=\"drawerBody\" class=\"drawer-body\"></div>\n  <div class=\"drawer-foot\">\n    <button id=\"btnDrawerMore\" class=\"btn small\" type=\"button\">加载更多</button>\n    <button id=\"btnDrawerFilter\" class=\"btn small\" type=\"button\">在评论表里筛选这个词</button>\n  </div>\n</aside>\n\n<div id=\"toast\" class=\"toast hidden\"></div>\n\n<script src=\"app.js?v=0.5.53\"></script>\n";
  var BODY_CLASS = "is-empty";
  // 词云页的整段前端逻辑（与独立版 / DSH 内嵌页 / 导出快照同一份）
  window.__cvViewerMain = function () {
/* 评论分析台 · 词云 + 评论表（纯前端，无依赖）
 * 数据来源：抖音评论采集插件/扩展导出的 JSON / CSV（可整目录批量载入）
 * 隐私：全部在本机浏览器内处理，不发任何网络请求
 */
(function () {
  'use strict';

  /* ===================== 工具 ===================== */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const PROFILE_BASE = 'https://www.douyin.com/user/';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const fmtNum = (n) => {
    n = Number(n) || 0;
    if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + ' 亿';
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + ' 万';
    return String(n);
  };

  const pad2 = (n) => (n < 10 ? '0' + n : String(n));
  const fmtTime = (ts) => {
    if (!ts) return '';
    const d = new Date(Number(ts) * (String(ts).length > 10 ? 1 : 1000));
    if (isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  const fmtTimeShort = (ts) => {
    const s = fmtTime(ts);
    return s ? s.slice(5) : '';
  };

  const profileOf = (user) => {
    const sec = user && user.secUid ? String(user.secUid).trim() : '';
    return sec ? PROFILE_BASE + encodeURIComponent(sec) : '';
  };

  const videoUrl = (videoId) => {
    const id = String(videoId || '').trim();
    if (!id) return '';
    const v = state.videos.get(id);
    if (v && v.url) return v.url;
    return 'https://www.douyin.com/video/' + encodeURIComponent(id);
  };

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(self, args), ms);
    };
  }

  const initials = (name) => {
    const s = String(name || '').trim();
    if (!s) return '?';
    return s.slice(0, 1).toUpperCase();
  };

  // 每个用户一个稳定的淡色头像底（按昵称/ID 散列取色），只用淡色、不参与数据配色
  const avatarHue = (user) => {
    const key = String((user && (user.secUid || user.uid || user.nickname)) || '');
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
    return h;
  };
  const avatarStyle = (user) => {
    const h = avatarHue(user);
    return `background:hsl(${h} 16% 18%);color:hsl(${h} 30% 78%)`;
  };

  /* ===================== 状态 ===================== */
  const state = {
    comments: [],              // 全部评论（已归一化、已去重）
    videos: new Map(),         // videoId -> { id, title, url, collectedAt }
    sources: [],               // 已载入文件名
    filters: { videoId: '', search: '', onlyHasProfile: false, onlyTopLevel: false, onlyNonEmpty: false, onlyContent: true, sentiment: '', topic: '' },
    topics: [],                // v3.0：主题聚类结果（TF-IDF + k-means）
    topicBusy: false,
    kwKeep: [],               // v0.5.41：自定义加词（长词优先，避免被切碎）
    kwBlock: [],              // v0.5.41：自定义屏蔽词
    sort: 'digg',
    page: 1,
    pageSize: 50,
    words: [],
    wordMap: new Map(),        // word -> { word, count, cids:Set }
    lastWord: '',
    cloudReady: false,
    hoverWord: '',
  };

  /* v0.5.41：自定义加词 / 屏蔽词存在 localStorage（只在本机，不上传） */
  try {
    state.kwKeep = JSON.parse(localStorage.getItem('cw.kw.keep') || '[]') || [];
    state.kwBlock = JSON.parse(localStorage.getItem('cw.kw.block') || '[]') || [];
  } catch (e) { state.kwKeep = []; state.kwBlock = []; }

  /* ===================== CSV 解析 ===================== */
  function parseCsv(text) {
    text = String(text || '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field); field = '';
      } else if (ch === '\r') {
        if (text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else if (ch === '\n') {
        row.push(field); field = '';
        rows.push(row); row = [];
      } else field += ch;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    // 去掉首格为 # 的中文说明行 / 空行
    return rows.filter((r) => {
      if (!r.length) return false;
      const first = String(r[0] == null ? '' : r[0]).trim();
      if (first.startsWith('#')) return false;
      if (r.every((c) => String(c == null ? '' : c).trim() === '')) return false;
      return true;
    });
  }

  function num(v) { const n = Number(String(v == null ? '' : v).trim()); return isFinite(n) ? n : 0; }

  /* ===================== 归一化 ===================== */
  function normalizeUser(u) {
    u = u || {};
    return {
      nickname: String(u.nickname || '').trim() || '匿名用户',
      uid: u.uid ? String(u.uid) : '',
      secUid: u.sec_uid ? String(u.sec_uid) : (u.secUid ? String(u.secUid) : ''),
      uniqueId: u.unique_id ? String(u.unique_id) : (u.uniqueId ? String(u.uniqueId) : ''),
      shortId: u.short_id ? String(u.short_id) : (u.shortId ? String(u.shortId) : ''),
    };
  }

  // v2.4：导出数据本来就带清洗后的文本（`text_clean`，去表情/@/#，扩展的 cleanText() 生成）。
  // 分词优先用它；老数据/快照没有该字段时，再在 tokensOf() 里剥 [表情] 兜底。
  function cleanForTokens(raw, text) {
    const cleaned = String(raw.text_clean != null ? raw.text_clean : (raw.textClean != null ? raw.textClean : '')).trim();
    if (cleaned) return cleaned;
    return String(text || '');
  }

  function normalizeComment(raw, meta) {
    raw = raw || {};
    const text = String(raw.text != null ? raw.text : (raw.text_clean || raw.content || '')).trim();
    const cid = String(raw.cid || raw.comment_id || '');
    const user = normalizeUser(raw.user || {
      nickname: raw.user_nickname, uid: raw.user_uid, sec_uid: raw.user_sec_uid,
      unique_id: raw.user_unique_id, short_id: raw.user_short_id,
    });
    const videoId = String(raw.videoId || raw.video_id || meta.videoId || '');
    return {
      cid,
      videoId,
      videoTitle: meta.title || '',
      text,
      textClean: cleanForTokens(raw, text),
      digg: num(raw.digg_count != null ? raw.digg_count : raw.digg),
      replies: num(raw.reply_comment_total != null ? raw.reply_comment_total : raw.replies),
      ip: String(raw.ip_label || ''),
      createTime: num(raw.create_time),
      createTimeStr: String(raw.create_time_str || fmtTime(raw.create_time) || ''),
      isReply: raw.is_reply === true || String(raw.is_reply) === '1' || String(raw.is_reply).toLowerCase() === 'true' || num(raw.level) > 1,
      level: num(raw.level) || 1,
      isHot: raw.is_hot === true || String(raw.is_hot) === '1',
      isFolded: raw.is_folded === true || String(raw.is_folded) === '1',
      user,
    };
  }

  /* ===================== 载入数据 ===================== */
  function addComments(list) {
    let added = 0;
    const seen = new Set(state.comments.map((c) => c.videoId + '|' + c.cid));
    for (const c of list) {
      if (!c.text && !c.user.nickname) continue;
      const key = c.videoId + '|' + c.cid;
      if (c.cid && seen.has(key)) continue;
      seen.add(key);
      state.comments.push(c);
      added++;
    }
    return added;
  }

  function ingestJson(text, fileName) {
    let obj;
    try { obj = JSON.parse(String(text).replace(/^\uFEFF/, '')); }
    catch (e) { toast('JSON 解析失败：' + fileName); return -1; }
    let arr = null, meta = { videoId: '', title: '' };
    if (Array.isArray(obj)) arr = obj;
    else if (obj && Array.isArray(obj.comments)) {
      arr = obj.comments;
      meta.videoId = String(obj.videoId || obj.video_id || '');
      meta.title = String(obj.title || '');
    } else if (obj && obj.data && Array.isArray(obj.data.comments)) {
      arr = obj.data.comments;
    }
    if (!arr) { toast('这个 JSON 里没有 comments 数组：' + fileName); return -1; }
    if (meta.videoId) {
      state.videos.set(meta.videoId, {
        id: meta.videoId, title: meta.title || '视频 ' + meta.videoId.slice(-8),
        url: obj.url || ('https://www.douyin.com/video/' + meta.videoId),
        collectedAt: obj.collectedAt || '',
      });
    }
    const list = arr.map((c) => normalizeComment(c, meta));
    return addComments(list);
  }

  function ingestCsv(text, fileName) {
    const rows = parseCsv(text);
    if (!rows.length) { toast('CSV 是空的：' + fileName); return -1; }
    const header = rows[0].map((h) => String(h || '').trim());
    const idx = {};
    header.forEach((h, i) => { idx[h] = i; });
    if (idx.cid == null && idx.text == null) { toast('这不是评论导出 CSV：' + fileName); return -1; }
    const hasVideoCol = idx.video_id != null;
    let curMeta = { videoId: '', title: '' };
    if (!hasVideoCol) {
      // 单视频 CSV：从文件名里取 videoId
      const m = String(fileName || '').match(/(\d{15,25})/);
      if (m) {
        curMeta.videoId = m[1];
        if (!state.videos.has(m[1])) {
          state.videos.set(m[1], { id: m[1], title: '视频 ' + m[1].slice(-8), url: 'https://www.douyin.com/video/' + m[1], collectedAt: '' });
        }
      }
    }
    const get = (r, key) => (idx[key] != null ? r[idx[key]] : '');
    const list = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const vid = hasVideoCol ? String(get(r, 'video_id') || '').trim() : curMeta.videoId;
      if (hasVideoCol && vid && !state.videos.has(vid)) {
        state.videos.set(vid, { id: vid, title: '视频 ' + vid.slice(-8), url: 'https://www.douyin.com/video/' + vid, collectedAt: '' });
      }
      const meta = { videoId: vid, title: (state.videos.get(vid) || {}).title || '' };
      list.push(normalizeComment({
        cid: get(r, 'cid'),
        text: get(r, 'text') || get(r, 'text_clean'),
        text_clean: get(r, 'text_clean'),
        digg_count: get(r, 'digg_count'),
        reply_comment_total: get(r, 'reply_comment_total'),
        ip_label: get(r, 'ip_label'),
        create_time: get(r, 'create_time'),
        create_time_str: get(r, 'create_time_str'),
        is_reply: get(r, 'is_reply'),
        level: get(r, 'level'),
        is_hot: get(r, 'is_hot'),
        is_folded: get(r, 'is_folded'),
        user_nickname: get(r, 'user_nickname'),
        user_uid: get(r, 'user_uid'),
        user_sec_uid: get(r, 'user_sec_uid'),
        user_unique_id: get(r, 'user_unique_id'),
        user_short_id: get(r, 'user_short_id'),
      }, meta));
    }
    return addComments(list);
  }

  async function loadFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => /\.(json|csv)$/i.test(f.name));
    if (!files.length) { toast('没有找到 .json / .csv 文件'); return; }
    setLoading(true);
    let total = 0;
    const names = [];
    for (const f of files) {
      try {
        const text = await f.text();
        const n = /\.json$/i.test(f.name) ? ingestJson(text, f.name) : ingestCsv(text, f.name);
        if (n >= 0) {
          total += n;
          names.push(f.name);
        }
      } catch (e) {
        console.warn('读取失败', f.name, e);
      }
    }
    state.sources = state.sources.concat(names);
    updateScope();
    updateEmptyState();
    $('#btnClear').disabled = state.comments.length === 0;
    if (total > 0) toast(`载入 ${total} 条评论（${names.length} 个文件）`);
    else toast('没有新增评论（可能是重复文件）');
    setLoading(false);
    refreshAll();
  }

  /* ===================== 过滤 ===================== */
  function filtered() {
    const f = state.filters;
    const q = f.search.trim().toLowerCase();
    return state.comments.filter((c) => {
      if (f.videoId && c.videoId !== f.videoId) return false;
      if (f.onlyHasProfile && !profileOf(c.user)) return false;
      if (f.onlyTopLevel && c.isReply) return false;
      if (f.onlyNonEmpty && !c.text) return false;
      // v3.0：情感 / 主题筛选（主题由 baseFiltered 的聚类结果给出，避免自我循环）
      if (f.sentiment && ((c.sentiment && c.sentiment.label) || 'neu') !== f.sentiment) return false;
      if (f.topic !== '' && f.topic != null && String(c.topic == null ? -1 : c.topic) !== String(f.topic)) return false;
      if (q) {
        const hay = (c.text + ' ' + c.user.nickname + ' ' + c.user.uniqueId + ' ' + c.ip).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  // v3.0：不含情感/主题的“基础筛选”，主题聚类与洞察面板都基于它，避免筛选后主题编号漂移
  function baseFiltered() {
    const savedS = state.filters.sentiment, savedT = state.filters.topic;
    state.filters.sentiment = ''; state.filters.topic = '';
    const out = filtered();
    state.filters.sentiment = savedS; state.filters.topic = savedT;
    return out;
  }

  /* ===================== 分词 ===================== */
  const STOPWORDS = new Set((
    '的 了 是 在 我 你 他 她 它 们 这 那 有 和 就 都 也 又 还 要 会 能 可以 不是 没有 一个 这个 那个 ' +
    '什么 怎么 为什么 因为 所以 但是 然后 而且 如果 就是 这样 那样 这么 那么 自己 我们 你们 他们 ' +
    '她们 它们 人家 别人 大家 真的 真是 确实 其实 应该 可能 觉得 感觉 知道 看到 看过 听到 时候 ' +
    '现在 之前 以后 一样 一直 已经 还是 只是 不过 有点 一点 一些 这些 那些 多少 几个 一次 一下 ' +
    '评论 回复 视频 抖音 作者 楼主 主播 up 啊 吧 呢 吗 呀 哦 嗯 哈 啦 嘛 哇 呵 嘿 诶 哎 唉 么 ' +
    '哇塞 哈哈哈 哈哈哈哈 呵呵 嘿嘿 666 233 999 111 1111 2333 555 干嘛 咋 咱 俺 啥 嘞 咯 嗷 呜 喵 ' +
  '必须 直接 肯定 一定 主要 以及 中的 的话 之类 等等 以为 希望 想要 需要 为了 要是 还有 才有 都要 没了 不对 一句 一段 一眼 看完 出来 上去 下去 起来 下来 过去 回去 以前 之后 刚才 马上 立刻 终于 甚至 反而 竟然 居然 果然 依然 仍然 偶尔 总是 经常 有时 从来 一向 还要 会不会 能不能 是不是 有没有 怎么办 怎么样 什么时候 干什么 什么样 什么的 或者 来说 来讲 似的 一般 差不多 一会 一下 一起 这种 那种 哪种 各种 这种 都是 才是 也是 还是 只是 就是 而是 于是 但是 可是 因此 所以 如果 虽然 不管 无论 即使 尽管 只要 只有 除了 关于 对于 由于 按照 根据 通过 经过 沿着 随着 直到 等到'
  ).split(/\s+/).filter(Boolean));

  /* v0.5.41：按社区做法（jieba 系 + 中文停用词四表的口径）补齐常见泛词，
   * 让「真的 / 感觉 / 很多 / 这种 / 都是」这类词在词云里自然消失。 */
  for (const w of (
    '真的 感觉 觉得 知道 认为 以为 希望 想要 需要 应该 必须 一定 肯定 估计 可能 或许 大概 差不多 几乎 简直 实在 确实 其实 本来 原来 果然 竟然 居然 反而 甚至 尤其 特别 非常 十分 相当 比较 稍微 略微 更加 越来越 太多 好多 很多 不少 有些 挺多 一堆 一大 全都 全部 整个 所有 每个 任何 某些 其他 其它 剩下 别的 另外 此外 而且 并且 或者 还不如 不如 要不 不然 否则 因此 所以 于是 然后 接着 随后 最后 首先 其次 总之 反正 究竟 到底 毕竟 何况 况且 再说 至于 关于 对于 根据 按照 依照 通过 经过 凭借 由于 因为 为了 除了 除非 即使 即便 哪怕 无论 不管 不论 只要 虽然 尽管 但是 可是 不过 然而 只是 就算 如果 要是 假如 万一 一旦 直到 等到 每当 之前 之后 以前 以后 现在 目前 当时 那时 这时 此时 同时 立刻 马上 立即 刚刚 刚才 已经 曾经 从来 一向 一直 始终 总是 经常 常常 时常 有时 偶尔 很少 从不 再次 重新 继续 仍然 依然 依旧 仍旧 还要 还没 还没有 不用 不要 不能 不会 不敢 不想 不需要 说不定 不一定 不可能 不错 不好 好看 不起 老是 不知道 不打 还好 好听 好玩 可爱 漂亮 厉害 牛逼 牛批 牛皮 离谱 逆天 绝了 完了 笑死 笑了 感动 无语 服了 麻了 破防 上头 东西 事情 时候 时间 地方 方式 方法 方面 问题 情况 样子 意思 内容 部分 结果 原因 感觉 心里 希望 想法 办法 事情 过程 水平 大家 大家伙 各位 咱们 我们 你们 他们 她们 它们 自己 别人 人家 有人 没人 谁都 什么 啥 咋 咋样 怎么办 怎么样 什么样 为什么 为啥 什么时候 哪里 哪儿 这里 那里 这边 那边 这样 那样 这么 那么 这种 那种 哪种 这些 那些 哪些 这个 那个 哪个 一次 一下 一会 一起 一直 一边 一样 一般 一致 一切 一共 一点 一半 一天 一年 一句 一段 一条 一遍 一层 一群 一批 一部分 一方面 双方 彼此 互相 相互 各种 各自 每次 每天 每年 某个 某些 是不是 有没有 要不要 会不会 能不能 对不对 好不好 行不行 可不可以 有没有人 我说 你说 他说 她说 我说真的 我觉 你们觉得 我觉得 说实话 说真的 说白了 换句话说 也就是 也就是说 也就是说 另一方面 与此同时 除此之外 不仅如此 由此可见 总的来说 简单说 总之 唉 哎 哎呀 哎哟 天哪 天啊 我的天 妈呀 卧槽 我靠 哈哈哈 哈哈 呵呵 嘿嘿 嘻嘻 么么 哇哦 嗯嗯 对对 好好 是是 行行 可以可以 谢谢 感谢 多谢 辛苦 支持 关注 收藏 转发 分享 弹幕 直播 主播 作者 楼主 老铁 兄弟 姐姐 哥哥 妹妹 弟弟 朋友 视频 评论 回复 点赞 投币 三连 关注了 已关注 取关 前排 沙发 板凳 路过 打卡 签到 首次 第一次 上次 下次 这次 那次 刚才 刚刚 突然 忽然 立刻 最终 终于 好像 似乎 显然 明显 确实 的确 真的 真是 简直 完全 全部 整体 总体'
  ).split(/\s+/)) if (w) STOPWORDS.add(w);

  /* v0.5.40：只看虚词字符组成的词直接丢掉（都是 / 这种 / 我的 / 出来 / 中的…）。
   * 依据是「实词至少有一个非虚词字符」，这样不用维护几千条停用词也能过滤掉大部分口头词。 */
  const FUNCTION_CHARS = new Set(('的是我你他她它们这那个也就都还又和与在有不会能可要什么怎样些点时候一二三不没很太更最对错上下中内外到说看想做去来出进过回从被把给跟于为以因此所以就而且并且但是然后如果虽然不过只是当然因为所以着了吧呢吗啊呀哦嗯啦嘛哇种才里完句直真错对同再又').split(''));
  function isFunctionOnly(t) {
    for (const ch of t) if (!FUNCTION_CHARS.has(ch)) return false;
    return true;
  }

  let segmenter = null;
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) segmenter = new Intl.Segmenter('zh-Hans', { granularity: 'word' });
  } catch (e) { segmenter = null; }

  function tokensOf(text) {
    const out = [];
    // v2.3：抖音表情是 [憨笑] [流泪] 这种方括号标签文本，直接分词会把标签名当成词（点进去只有一条「[悲伤]」）。
    // 分词前先把方括号标签剥掉，纯表情评论因此不贡献任何关键词。
    const s = String(text || '').replace(/\[[^\[\]]{1,12}\]/g, ' ');
    if (!s.trim()) return out;
    if (segmenter) {
      for (const seg of segmenter.segment(s)) {
        if (!seg.isWordLike) continue;
        out.push(seg.segment);
      }
    } else {
      // 兜底：中文取 2-gram，英文/数字按词
      const parts = s.match(/[A-Za-z][A-Za-z0-9'+.-]*|\d+(?:\.\d+)?|[\u4e00-\u9fff]+/g) || [];
      for (const p of parts) {
        if (/^[\u4e00-\u9fff]+$/.test(p)) {
          if (p.length === 1) out.push(p);
          else for (let i = 0; i + 2 <= p.length; i++) out.push(p.slice(i, i + 2));
        } else out.push(p);
      }
    }
    // v0.5.41：自定义加词——Intl.Segmenter 没有词典，会把「酒池肉林」切成「酒池 / 肉林」，
    // 用户把整词加进来后，只要原文里出现就按整词计一次（每条评论内仍去重）。
    if (state.kwKeep && state.kwKeep.length) {
      const low = s.toLowerCase();
      for (const kw of state.kwKeep) if (kw && low.indexOf(kw) >= 0) out.push(kw);
    }
    return out;
  }

  function cleanToken(w, strict) {
    let t = String(w || '').trim();
    if (!t) return '';
    t = t.replace(/[\s\u3000]+/g, '');
    if (!t) return '';
    if (/^[\d.,%+\-/:]+$/.test(t)) return '';
    if (/^[A-Za-z]+$/.test(t)) t = t.toLowerCase();
    if (t.length < 2) return '';
    if (strict !== false) {
      if (STOPWORDS.has(t.toLowerCase())) return '';
      if (isFunctionOnly(t)) return '';      // v0.5.40：这种 / 都是 / 我的 …
    }
    if (/^(.)\1{2,}$/.test(t)) return '';       // 啊啊啊
    return t;
  }

  function parseWordList(v) {
    const out = [];
    for (const raw of String(v || '').split(/[,，、;；\s]+/)) {
      const t = raw.trim().toLowerCase();
      if (t.length >= 2 && out.indexOf(t) === -1) out.push(t);
    }
    return out.slice(0, 200);
  }

  function applyWordLists() {
    const keepEl = $('#kwKeep'), blockEl = $('#kwBlock');
    state.kwKeep = parseWordList(keepEl ? keepEl.value : '');
    state.kwBlock = parseWordList(blockEl ? blockEl.value : '');
    try {
      localStorage.setItem('cw.kw.keep', JSON.stringify(state.kwKeep));
      localStorage.setItem('cw.kw.block', JSON.stringify(state.kwBlock));
    } catch (e) {}
    refreshAll();
  }

  function buildWords(comments) {
    const map = new Map();
    const blockSet = new Set(state.kwBlock || []);
    const keepSet = new Set(state.kwKeep || []);
    let docN = 0;
    for (const c of comments) if (c.text) docN++;
    for (const c of comments) {
      if (!c.text) continue;
      const seen = new Set();
      for (const raw of tokensOf(c.textClean || c.text)) {
        const isKeep = keepSet.has(String(raw || '').toLowerCase());
        const w = isKeep ? String(raw).toLowerCase() : cleanToken(raw, state.filters.onlyContent !== false);
        if (!w || seen.has(w) || blockSet.has(w)) continue;
        seen.add(w);
        let rec = map.get(w);
        if (!rec) { rec = { word: w, count: 0, weight: 0, ratio: 0, generic: false, cids: new Set(), users: new Set() }; map.set(w, rec); }
        rec.count++;
        if (c.cid) rec.cids.add(c.cid);
        rec.users.add(c.user.secUid || c.user.uid || c.user.nickname);
      }
    }
    // v0.5.41：轻量 IDF（对标 jieba.analyse 的 TF-IDF 思路，但只用本视频语料，不用外部语料）：
    //   weight = df * log(1 + N / df)，N = 有文字的评论数
    // 同时把「这条视频里到处都在说」的泛词（df/N > 40% 且样本 ≥ 30 条）直接剔除。
    const out = [];
    for (const rec of map.values()) {
      rec.ratio = docN ? rec.count / docN : 0;
      rec.weight = rec.count * Math.log(1 + (docN || 1) / Math.max(1, rec.count));
      rec.generic = docN >= 30 && rec.ratio > 0.4;
      if (!rec.generic) out.push(rec);
    }
    return out.sort((a, b) => b.weight - a.weight || b.count - a.count || a.word.localeCompare(b.word));
  }

  /* ===================== 情感分析（v3.0） =====================
   * 纯本地词典法：正向/负向词表（分级权重）+ 程度副词提升 + 否定词翻转 + 抖音表情标签。
   * 不联网、不调模型，结果可解释；输出挂在评论上：c.sentiment = { score, label, hits }。
   */
  const SENT_POS_STRONG = new Set(('太棒 牛逼 绝了 神作 惊艳 完美 精彩 厉害 高能 真香 给力 宝藏 神器 顶 爱了 圈粉 封神 天花板 牛逼克拉斯 大佬 佩服 五体投地 神评 笑死'.split(/\s+/)));
  const SENT_POS = new Set(('好 赞 棒 强 牛 喜欢 爱 支持 感谢 感动 治愈 暖心 温柔 靠谱 良心 专业 优秀 燃 爽 香 甜 不错 挺好 蛮好 中肯 客观 理性 真实 实在 清楚 明白 简洁 干净 顺畅 稳定 实用 有用 值得 推荐 安利 好用 期待 开心 快乐 高兴 兴奋 满意 舒服 舒适 好看 好听 好玩 可爱 漂亮 帅 美 有趣 搞笑 好笑 感人 贴心 用心 细致 耐心 认真 高手 内行 尊敬 涨知识 学到 受教 好评 有质感 有诚意 有干货 硬核'.split(/\s+/)));
  const SENT_NEG_STRONG = new Set(('垃圾 恶心 恶心人 烂 骗子 欺骗 智障 弱智 傻逼 恶臭 反感 讨厌 恨 愤怒 崩溃 心碎 失望 无语 离谱 逆天 破防 麻了 服了 难受 痛苦 吐了 呕吐 鄙视 白眼 嘲讽 喷 骂 举报 差评 水军 掉粉 取关 别买 不值 退钱 翻车 侮辱 冒犯 恶俗 低俗 割韭菜 智商税 阴阳怪气 洗白 洗地 拉胯 恰饭 硬广'.split(/\s+/)));
  const SENT_NEG = new Set(('不行 不好 难看 难听 难受 麻烦 复杂 混乱 卡 卡顿 慢 贵 亏 可惜 遗憾 一般 普通 平庸 老套 套路 水 敷衍 凑数 多余 尬 冷场 叹气 皱眉 害怕 恐怖 吓人 阴影 不适 争议 质疑 反驳 抬杠 双标 强行 尴尬 无聊 拖沓 生气 发怒 差 弱 划水 广告 坑 糊弄 玄学 劝退'.split(/\s+/)));
  const SENT_NEGATORS = new Set(('不 没 无 未 别 莫 非 勿 没有 不是 不算 不会 不能 不要 不用 不必 不够 不太 不怎么 没那么'.split(/\s+/)));
  const SENT_DEGREE = new Set(('太 很 非常 特别 超 巨 极 真 更 最 十分 相当 格外 尤其 愈发 更加 简直 实在 真是 巨他妈'.split(/\s+/)));
  const EMOJI_POS = new Set(('憨笑 微笑 大笑 笑哭 呲牙 偷笑 得意 调皮 酷 比心 鼓掌 加油 玫瑰 爱心 飞吻 抱拳 胜利 强 点赞 撒花 庆祝 耶 亲亲 害羞 愉快 色 吃瓜 调皮'.split(/\s+/)));
  const EMOJI_NEG = new Set(('流泪 大哭 崩溃 发怒 生气 鄙视 白眼 呕吐 敲打 菜刀 心碎 失望 无语 裂开 叹气 皱眉 骷髅 害怕 惊恐 再见 弱 尬 汗 擦汗 抠鼻 黑线 委屈 可怜 抓狂 咒骂 闭嘴 哼 怒 困'.split(/\s+/)));

  const EMOJI_TAG_RE = /\[[^\[\]]{1,12}\]/g;

  function sentimentOf(text) {
    const raw = String(text || '');
    let score = 0;
    let emoHits = 0;
    const tags = raw.match(EMOJI_TAG_RE) || [];
    for (const t of tags) {
      const name = t.slice(1, -1);
      if (EMOJI_POS.has(name)) { score += 1.2; emoHits++; }
      else if (EMOJI_NEG.has(name)) { score -= 1.2; emoHits++; }
    }
    const s = raw.replace(EMOJI_TAG_RE, ' ').replace(/@[^\s@]+|#[^\s#]+/g, ' ');
    if (!s.trim()) {
      const norm0 = Math.tanh(score / 2);
      return { score: Math.round(norm0 * 100) / 100, label: norm0 > 0.15 ? 'pos' : (norm0 < -0.15 ? 'neg' : 'neu'), hits: emoHits };
    }
    const toks = [];
    if (segmenter) for (const seg of segmenter.segment(s)) if (seg.isWordLike) toks.push(seg.segment);
    else for (const p of s.match(/[A-Za-z][A-Za-z0-9']*|[\u4e00-\u9fff]{1,4}/g) || []) toks.push(p);
    let hits = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      let base = 0;
      if (SENT_POS_STRONG.has(t)) base = 2;
      else if (SENT_POS.has(t)) base = 1;
      else if (SENT_NEG_STRONG.has(t)) base = -2;
      else if (SENT_NEG.has(t)) base = -1;
      if (!base) continue;
      let mult = 1;
      for (let j = Math.max(0, i - 2); j < i; j++) {
        if (SENT_DEGREE.has(toks[j])) mult *= 1.5;
        if (SENT_NEGATORS.has(toks[j])) mult *= -0.8;
      }
      score += base * mult;
      hits++;
    }
    const norm = Math.tanh(score / 2);
    return {
      score: Math.round(norm * 100) / 100,
      label: norm > 0.15 ? 'pos' : (norm < -0.15 ? 'neg' : 'neu'),
      hits: hits + emoHits,
    };
  }

  function annotateSentiment(list) {
    for (const c of list) if (!c.sentiment) c.sentiment = sentimentOf(c.text);
  }

  const SENT_LABEL = { pos: '正向', neu: '中性', neg: '负向' };

  function sentimentStats(list) {
    const s = { pos: 0, neu: 0, neg: 0 };
    for (const c of list) {
      const l = (c.sentiment && c.sentiment.label) || 'neu';
      s[l] = (s[l] || 0) + 1;
    }
    return s;
  }

  /* ===================== 主题聚类（v3.0） =====================
   * TF-IDF + 轻量 k-means（确定性种子：等距取 k 篇当初始中心），纯前端、无依赖。
   * 输出 state.topics = [{ id, label, terms, count, reps:[comment] }]，评论上挂 c.topic。
   */
  function buildTopics(list) {
    const docs = [];
    for (const c of list) {
      if (!c.text) continue;
      const seen = new Set();
      const toks = [];
      for (const raw of tokensOf(c.textClean || c.text)) {
        const w = cleanToken(raw, true);
        if (!w || seen.has(w)) continue;
        seen.add(w);
        toks.push(w);
      }
      if (toks.length >= 2) docs.push({ c, toks });
    }
    const n = docs.length;
    for (const c of list) delete c.topic;
    if (n < 12) { state.topics = []; return; }
    const df = new Map();
    for (const d of docs) for (const w of d.toks) df.set(w, (df.get(w) || 0) + 1);
    const minDf = Math.max(2, Math.round(n * 0.012));
    const vocab = Array.from(df.entries())
      .filter(([, v]) => v >= minDf)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 900)
      .map(([w]) => w);
    if (vocab.length < 8) { state.topics = []; return; }
    const idx = new Map(vocab.map((w, i) => [w, i]));
    const idf = vocab.map((w) => Math.log(1 + n / df.get(w)));
    const vecs = docs.map((d) => {
      const tf = new Map();
      for (const w of d.toks) { const i = idx.get(w); if (i != null) tf.set(i, (tf.get(i) || 0) + 1); }
      const v = new Map();
      let sum = 0;
      for (const [i, f] of tf) { const val = (1 + Math.log(f)) * idf[i]; v.set(i, val); sum += val * val; }
      const norm = Math.sqrt(sum) || 1;
      for (const [i, val] of v) v.set(i, val / norm);
      return v;
    });
    const k = Math.max(3, Math.min(8, Math.round(Math.sqrt(n) / 2)));
    const cos = (a, b) => {
      let s = 0;
      const small = a.size <= b.size ? a : b;
      const big = a.size <= b.size ? b : a;
      for (const [i, v] of small) { const w = big.get(i); if (w) s += v * w; }
      return s;
    };
    const cent = [];
    for (let i = 0; i < k; i++) cent.push(new Map(vecs[Math.min(n - 1, Math.floor((i + 0.5) * n / k))]));
    const assign = new Array(n).fill(-1);
    for (let it = 0; it < 14; it++) {
      let moved = 0;
      for (let d = 0; d < n; d++) {
        let best = 0, bestS = -2;
        for (let c = 0; c < k; c++) { const s = cos(vecs[d], cent[c]); if (s > bestS) { bestS = s; best = c; } }
        if (assign[d] !== best) { assign[d] = best; moved++; }
      }
      const next = Array.from({ length: k }, () => new Map());
      for (let d = 0; d < n; d++) {
        const m = next[assign[d]];
        for (const [i, v] of vecs[d]) m.set(i, (m.get(i) || 0) + v);
      }
      for (let c = 0; c < k; c++) {
        const m = next[c];
        let sum = 0;
        for (const v of m.values()) sum += v * v;
        const norm = Math.sqrt(sum) || 1;
        for (const [i, v] of m) m.set(i, v / norm);
        cent[c] = m;
      }
      if (!moved && it > 2) break;
    }
    const raw = [];
    for (let c = 0; c < k; c++) {
      const members = [];
      const termW = new Map();
      for (let d = 0; d < n; d++) {
        if (assign[d] !== c) continue;
        members.push(d);
        for (const [i, v] of vecs[d]) termW.set(i, (termW.get(i) || 0) + v);
      }
      if (members.length < 2) { raw.push(null); continue; }
      const terms = Array.from(termW.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([i]) => vocab[i]);
      const reps = members
        .map((d) => ({ d, s: cos(vecs[d], cent[c]) * (1 + Math.log1p(Math.max(0, docs[d].c.digg))) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 3)
        .map((x) => docs[x.d].c);
      raw.push({ label: terms.slice(0, 2).join(' · ') || ('主题 ' + (c + 1)), terms, count: members.length, reps, members });
    }
    state.topics = raw.filter(Boolean).map((t, i) => ({ id: i, label: t.label, terms: t.terms, count: t.count, reps: t.reps }));
    const keep = new Set(raw.map((t, i) => (t ? i : -1)).filter((i) => i >= 0));
    const remap = new Map();
    let j = 0;
    for (let i = 0; i < raw.length; i++) if (raw[i]) remap.set(i, j++);
    for (let d = 0; d < n; d++) {
      const c0 = assign[d];
      if (!keep.has(c0)) continue;
      docs[d].c.topic = remap.get(c0);
    }
  }

  /* ===================== 洞察面板（v3.0） ===================== */
  function dashboardCard(title, sub, bodyHtml, extraClass) {
    return `<div class="insight-card${extraClass ? ' ' + extraClass : ''}">
      <div class="insight-head"><h3>${esc(title)}</h3><span class="meta">${esc(sub || '')}</span></div>
      <div class="insight-body">${bodyHtml}</div>
    </div>`;
  }

  function svgTrend(list) {
    const byDay = new Map();
    let minT = Infinity, maxT = -Infinity;
    for (const c of list) {
      const s = String(c.createTimeStr || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) continue;
      const neg = c.sentiment && c.sentiment.label === 'neg' ? 1 : 0;
      const rec = byDay.get(s) || { n: 0, neg: 0 };
      rec.n++; rec.neg += neg;
      byDay.set(s, rec);
      const t = Date.parse(s + 'T00:00:00');
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
    }
    const days = Array.from(byDay.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (days.length < 2) {
      return `<p class="meta">${days.length ? '只有一天的数据（' + days[0][0] + '），看不出趋势' : '没有可用的时间字段'}</p>`;
    }
    const shown = days.slice(-30);
    const maxN = Math.max.apply(null, shown.map(([, v]) => v.n)) || 1;
    const W = 300, H = 92, pad = 4;
    const x = (i) => pad + (i * (W - pad * 2)) / Math.max(1, shown.length - 1);
    const y = (n) => H - pad - (n / maxN) * (H - pad * 2);
    const pts = shown.map(([, v], i) => [x(i), y(v.n)]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const area = line + ` L${x(shown.length - 1).toFixed(1)} ${H - pad} L${pad} ${H - pad} Z`;
    const negPts = shown.map(([, v], i) => [x(i), H - pad - (v.neg / Math.max(1, v.n)) * (H - pad * 2)]);
    const negLine = negPts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const peak = shown.reduce((a, b) => (b[1].n > a[1].n ? b : a));
    return `<svg class="trend" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="评论量趋势">
      <path class="area" d="${area}"></path>
      <path class="line" d="${line}"></path>
      <path class="negline" d="${negLine}"></path>
      ${pts.map((p, i) => (i === 0 || i === pts.length - 1 || shown[i] === peak ? `<circle class="dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="1.8"></circle>` : '')).join('')}
    </svg>
    <div class="legend"><span><i class="sw-line"></i>每天评论数</span><span><i class="sw-neg"></i>负评占比</span><span class="meta">峰值 ${valEsc(peak[0].slice(5))} · ${peak[1].n} 条</span></div>
    <div class="axis"><span>${esc(shown[0][0].slice(5))}</span><span>${esc(shown[shown.length - 1][0].slice(5))}</span></div>`;
  }

  function valEsc(v) { return String(v == null ? '' : v).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }

  /* ===================== 情感健康度（v3.1：熵权法 + TOPSIS，按天分桶） ===================== */
  const HEALTH_GRADES = [
    { min: 80, label: '很好', cls: 'h-good' },
    { min: 65, label: '较好', cls: 'h-ok' },
    { min: 50, label: '一般', cls: 'h-mid' },
    { min: 35, label: '偏弱', cls: 'h-warn' },
    { min: 0, label: '较差', cls: 'h-bad' },
  ];
  const HEALTH_IND = [
    { key: 'negRatio', label: '负面占比', cap: 0.35 },
    { key: 'negDigg', label: '负评点赞占比', cap: 0.35 },
    { key: 'burst', label: '评论热度', cap: 1 },
    { key: 'topNeg', label: '高赞负评率', cap: 0.5 },
  ];

  function healthMedian(nums) {
    if (!nums.length) return 0;
    const a = nums.slice().sort((x, y) => x - y);
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  // 按天分桶：每天是一个“方案”，4 个指标都是「越大越差」的风险向
  function healthBuckets(list) {
    const diggAll = list.map((c) => Number(c.digg) || 0);
    const diggMedian = healthMedian(diggAll);
    const map = new Map();
    for (const c of list) {
      const day = String(c.createTimeStr || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      let b = map.get(day);
      if (!b) { b = { day, n: 0, neg: 0, digg: 0, negDigg: 0, topN: 0, topNeg: 0 }; map.set(day, b); }
      const dg = Number(c.digg) || 0;
      const neg = c.sentiment && c.sentiment.label === 'neg' ? 1 : 0;
      b.n++; b.digg += dg; b.neg += neg;
      if (neg) b.negDigg += dg;
      if (dg >= diggMedian && dg > 0) { b.topN++; b.topNeg += neg; }
    }
    return Array.from(map.values()).sort((a, b) => (a.day < b.day ? -1 : 1));
  }

  // 熵权法：m 个方案 × k 个指标；方案少于 2 个或区分度全为 0 时退化成等权
  function entropyWeights(matrix) {
    const m = matrix.length, k = matrix[0].length;
    const w = new Array(k).fill(1 / k);
    if (m < 2) return w;
    const sums = [];
    for (let j = 0; j < k; j++) { let s = 0; for (let i = 0; i < m; i++) s += matrix[i][j]; sums.push(s); }
    const div = 1 / Math.log(m);
    const ds = [];
    for (let j = 0; j < k; j++) {
      if (sums[j] <= 0) { ds.push(0); continue; }
      let e = 0;
      for (let i = 0; i < m; i++) {
        const p = matrix[i][j] / sums[j];
        if (p > 0) e -= p * Math.log(p);
      }
      ds.push(Math.max(0, 1 - e * div));
    }
    const sumD = ds.reduce((s, v) => s + v, 0);
    if (sumD <= 0) return w;
    for (let j = 0; j < k; j++) w[j] = ds[j] / sumD;
    return w;
  }

  // TOPSIS：指标全为「越大越差」，返回每个方案的风险贴近度 0~1（1 = 最差）
  function topsisRisk(matrix, w) {
    const m = matrix.length, k = matrix[0].length;
    if (m < 2) return matrix.map((row) => row.reduce((s, v, j) => s + v * w[j], 0));
    const norm = [];
    for (let j = 0; j < k; j++) {
      let sq = 0;
      for (let i = 0; i < m; i++) sq += matrix[i][j] * matrix[i][j];
      norm.push(Math.sqrt(sq) || 1);
    }
    const v = matrix.map((row) => row.map((x, j) => (x / norm[j]) * w[j]));
    const best = [], worst = [];
    for (let j = 0; j < k; j++) {
      let hi = -Infinity, lo = Infinity;
      for (let i = 0; i < m; i++) { if (v[i][j] > hi) hi = v[i][j]; if (v[i][j] < lo) lo = v[i][j]; }
      best.push(hi); worst.push(lo);
    }
    return v.map((row) => {
      let db = 0, dw = 0;
      for (let j = 0; j < k; j++) { db += Math.pow(row[j] - best[j], 2); dw += Math.pow(row[j] - worst[j], 2); }
      db = Math.sqrt(db); dw = Math.sqrt(dw);
      return db + dw === 0 ? 0.5 : dw / (db + dw);
    });
  }

  function healthOf(list) {
    const buckets = healthBuckets(list);
    if (!buckets.length) return null;
    const maxN = Math.max.apply(null, buckets.map((b) => b.n)) || 1;
    const matrix = buckets.map((b) => [
      Math.min(1, b.neg / Math.max(1, b.n) / HEALTH_IND[0].cap),
      Math.min(1, b.negDigg / Math.max(1, b.digg) / HEALTH_IND[1].cap),
      Math.min(1, b.n / maxN / HEALTH_IND[2].cap),
      Math.min(1, b.topNeg / Math.max(1, b.topN) / HEALTH_IND[3].cap),
    ]);
    const w = entropyWeights(matrix);
    const risks = topsisRisk(matrix, w);
    const totalN = buckets.reduce((s, b) => s + b.n, 0) || 1;
    const risk = buckets.reduce((s, b, i) => s + risks[i] * (b.n / totalN), 0);
    const score = Math.max(0, Math.min(100, Math.round((1 - risk) * 100)));
    const grade = HEALTH_GRADES.find((g) => score >= g.min) || HEALTH_GRADES[HEALTH_GRADES.length - 1];
    const metrics = HEALTH_IND.map((ind, j) => {
      const mean = buckets.reduce((s, b, i) => s + matrix[i][j] * (b.n / totalN), 0);
      return { key: ind.key, label: ind.label, risk: mean, weight: w[j], contrib: w[j] * mean };
    });
    return { score, risk, grade, metrics, days: buckets.length };
  }

  function renderHealth(list) {
    const h = healthOf(list);
    if (!h) return '';
    const riskPct = (x) => Math.round(x * 100);
    const rows = h.metrics
      .slice()
      .sort((a, b) => b.contrib - a.contrib)
      .map((m) => '<tr><td>' + esc(m.label) + '</td><td class="num">' + riskPct(m.risk) + '%</td><td class="num">' + Math.round(m.weight * 100) + '%</td><td class="num">' + riskPct(m.contrib) + '%</td></tr>')
      .join('');
    const marks = [20, 40, 60, 80].map((x) => '<span class="mk" style="left:' + x + '%"></span>').join('');
    return '<div class="insight-card health">'
      + '<div class="insight-head"><h3>情感健康度</h3><span class="meta">熵权法 + TOPSIS · 按天分桶（' + fmtNum(h.days) + ' 天）</span></div>'
      + '<div class="insight-body">'
      + '<div class="health-top">'
      + '<div class="health-score"><b>' + h.score + '</b><small>/100</small></div>'
      + '<span class="health-grade ' + h.grade.cls + '">' + esc(h.grade.label) + '</span>'
      + '<div class="health-bar"><i class="' + h.grade.cls + '" style="width:' + h.score + '%"></i>' + marks + '</div>'
      + '<span class="meta">风险 ' + riskPct(h.risk) + '%</span>'
      + '</div>'
      + '<table class="health-metrics"><thead><tr><th>指标（越大越差）</th><th>风险</th><th>权重</th><th>贡献</th></tr></thead><tbody>' + rows + '</tbody></table>'
      + '<p class="meta">分数 = 100 − Σ(按天风险 × 当天评论占比)；权重由熵权法从数据里算，区分度越高的指标权重越大。</p>'
      + '</div></div>';
  }

  function renderInsights(list) {
    const box = $('#insightGrid') || $('#insights');
    if (!box) return;
    const total = list.length;
    const st = sentimentStats(list);
    const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
    const seg = (cls, n) => (total && n ? `<i class="sent-seg ${cls}" style="width:${(n / total) * 100}%"></i>` : '');
    const negTop = list
      .filter((c) => c.sentiment && c.sentiment.label === 'neg')
      .sort((a, b) => b.digg - a.digg)
      .slice(0, 3);
    const sentHtml = total
      ? `<div class="sent-bar">${seg('pos', st.pos)}${seg('neu', st.neu)}${seg('neg', st.neg)}</div>
         <div class="sent-list">
           <span><i class="sw-dot pos"></i>正向 ${fmtNum(st.pos)} · ${pct(st.pos)}%</span>
           <span><i class="sw-dot neu"></i>中性 ${fmtNum(st.neu)} · ${pct(st.neu)}%</span>
           <span><i class="sw-dot neg"></i>负向 ${fmtNum(st.neg)} · ${pct(st.neg)}%</span>
         </div>
         ${negTop.length ? `<div class="mini-list"><div class="mini-h">负评 Top${negTop.length}（按点赞）</div>${negTop.map((c) => `<button class="mini-row" type="button" data-neg-cid="${esc(c.cid)}"><span class="mini-txt">${esc((c.text || '').slice(0, 46) || '（无文字）')}</span><span class="mini-num">${fmtNum(c.digg)}</span></button>`).join('')}</div>` : '<p class="meta">没有识别到负向评论</p>'}`
      : '<p class="meta">暂无数据</p>';

    const regions = new Map();
    for (const c of list) if (c.ip) regions.set(c.ip, (regions.get(c.ip) || 0) + 1);
    const regTop = Array.from(regions.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const regMax = regTop.length ? regTop[0][1] : 1;
    const regHtml = regTop.length
      ? regTop.map(([k, v]) => `<div class="region-row"><span class="region-name">${esc(k)}</span><span class="region-bar"><i style="width:${(v / regMax) * 100}%"></i></span><span class="region-num">${fmtNum(v)}</span></div>`).join('')
      : '<p class="meta">导出数据里没有属地字段</p>';

    const topics = (state.topics || []).slice().sort((a, b) => b.count - a.count).slice(0, 6);
    const topicHtml = topics.length
      ? topics.map((t) => `<div class="topic-item">
          <button class="topic-main" type="button" data-topic="${t.id}" title="只看这个主题">
            <span class="topic-label">${esc(t.label)}</span>
            <span class="topic-count">${fmtNum(t.count)} 条</span>
          </button>
          <div class="topic-terms">${t.terms.slice(0, 3).map((w) => `<button class="chip" type="button" data-topic-word="${esc(w)}">${esc(w)}</button>`).join('')}</div>
          <div class="topic-reps">${t.reps.slice(0, 2).map((c) => `<div class="topic-rep">${esc((c.text || '').slice(0, 52) || '（无文字）')}</div>`).join('')}</div>
        </div>`).join('')
      : '<p class="meta">评论太少（< 12 条带文字）或没有明显主题</p>';

    box.innerHTML = renderHealth(list) + dashboardCard('情感分布', `${fmtNum(total)} 条评论`, sentHtml)
      + dashboardCard('评论趋势', '按天 · 最近 30 天', svgTrend(list))
      + dashboardCard('地域分布', 'Top 8 省份/地区', regHtml)
      + dashboardCard('主题聚类', `${topics.length} 个主题 · TF-IDF + k-means`, topicHtml, 'topic-card');

    const sub = $('#insightSub');
    if (sub) sub.textContent = total ? `负评率 ${pct(st.neg)}% · ${topics.length} 个主题` : '';
    box.classList.toggle('is-empty', total === 0);
    syncInsightHeights();
  }

  // v0.5.51：主题卡与左侧「地域分布」等高——量左侧自然高度，把主题列表限到同高并在内部滚动。
  // 之前主题多（6 个簇 × 标签/词/代表评论）会把整行撑高，视觉上和左边不齐。
  function syncInsightHeights() {
    const apply = () => {
    const box = $('#insightGrid') || $('#insights');
    if (!box) return;
    const topic = box.querySelector('.insight-card.topic-card');
    if (!topic) return;
    const cards = Array.from(box.querySelectorAll('.insight-card'));
    const left = cards[cards.indexOf(topic) - 1] || null;
    const body = topic.querySelector('.insight-body');
    if (!body) return;
    body.style.maxHeight = '';
    body.style.overflowY = '';
    if (!left) return;
    const leftBody = left.querySelector('.insight-body');
    const leftHead = left.querySelector('.insight-head');
    const topicHead = topic.querySelector('.insight-head');
    if (!leftBody || !leftHead || !topicHead) return;
    const cs = getComputedStyle(left);
    const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    // 关键：左侧 body 是 flex:1，会被整行拉伸；量自然高度前先取消 stretch，否则会「越量越高」
    const prevFlex = leftBody.style.flex;
    leftBody.style.flex = '0 0 auto';
    const naturalLeftBody = leftBody.offsetHeight;
    leftBody.style.flex = prevFlex;
    const naturalLeft = leftHead.offsetHeight + naturalLeftBody + padV;
    const csT = getComputedStyle(topic);
    const padT = parseFloat(csT.paddingTop) + parseFloat(csT.paddingBottom);
    const max = Math.max(120, Math.round(naturalLeft - topicHead.offsetHeight - padT));
    body.style.maxHeight = max + 'px';
    body.style.overflowY = 'auto';
    };
    apply();
    // v0.5.51b：字体/布局晚到会让首帧量到的字高偏小，补两帧 + 字体就绪后再复算（幂等）
    requestAnimationFrame(() => requestAnimationFrame(apply));
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(apply).catch(() => {});
  }

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(syncInsightHeights, 150);
  });

  function renderTopicFilter() {
    const sel = $('#topicFilter');
    if (!sel) return;
    const cur = state.filters.topic;
    const opts = ['<option value="">全部主题</option>'];
    for (const t of (state.topics || [])) {
      opts.push(`<option value="${t.id}">${esc(t.label)}（${fmtNum(t.count)} 条）</option>`);
    }
    sel.innerHTML = opts.join('');
    sel.value = cur === '' ? '' : String(cur);
    sel.disabled = !(state.topics || []).length;
  }

  /* ===================== KPI ===================== */
  function renderKpis(list) {
    const users = new Set();
    let digg = 0, hot = 0, topLevel = 0;
    for (const c of list) {
      users.add(c.user.secUid || c.user.uid || c.user.nickname);
      digg += c.digg;
      if (c.digg >= 100) hot++;
      if (!c.isReply) topLevel++;
    }
    const avg = list.length ? (digg / list.length) : 0;
    const pct = (n) => (list.length ? Math.round(n / list.length * 100) : 0) + '%';
    const st = sentimentStats(list);
    const cells = [
      { k: '评论数', v: fmtNum(list.length), s: '条' },
      { k: '参与用户', v: fmtNum(users.size), s: '人' },
      { k: '关键词', v: fmtNum(state.words.length), s: '个' },
      { k: '平均点赞', v: fmtNum(Math.round(avg * 10) / 10), s: '' },
      { k: '正向评论', v: pct(st.pos), s: fmtNum(st.pos) + ' 条' },
      { k: '负向评论', v: pct(st.neg), s: fmtNum(st.neg) + ' 条' },
      { k: '主题', v: fmtNum((state.topics || []).length), s: '个' },
      { k: '一级评论', v: pct(topLevel), s: fmtNum(topLevel) + ' 条' },
    ];
    $('#kpis').innerHTML = cells.map((c) => `
      <div class="kpi">
        <div class="k">${esc(c.k)}</div>
        <div class="v">${esc(c.v)}<small>${esc(c.s || '')}</small></div>
      </div>`).join('');
  }

  function updateScope() {
    const el = $('#sourceInfo');
    if (!state.comments.length) { el.textContent = '未载入数据'; return; }
    const parts = [
      `${state.videos.size} 个视频`,
      `${fmtNum(state.comments.length)} 条评论`,
      `${state.sources.length} 个文件`,
    ];
    el.textContent = parts.join(' · ') + (state.videos.size === 1 ? ' · 单条视频' : '');
  }

  // v2.9：加载骨架屏（读文件 / 解析 JSON 时先占位，避免白屏和跳动）
  let skeletonBuilt = false;
  let wordListStash = null;
  function buildSkeletons() {
    if (skeletonBuilt) return;
    skeletonBuilt = true;
    // v2.6：词云骨架改成几块「大块」铺在面板里（以前 18 条细碎小条看着乱）
    const cloud = $('#skCloud');
    if (cloud) {
      const blocks = [{"l":6,"t":10,"w":11,"h":11},{"l":8,"t":26,"w":26,"h":30},{"l":37,"t":17,"w":30,"h":41},{"l":70,"t":23,"w":22,"h":27},{"l":16,"t":62,"w":18,"h":17},{"l":39,"t":66,"w":23,"h":15},{"l":66,"t":58,"w":25,"h":13},{"l":82,"t":74,"w":12,"h":14}];
      cloud.innerHTML = blocks
        .map((b, i) => `<i style="left:${b.l}%;top:${b.t}%;width:${b.w}%;height:${b.h}%;animation-delay:${(i * 0.08).toFixed(2)}s"></i>`)
        .join('');
    }
    const tb = $('#skTable');
    if (tb) {
      tb.innerHTML = Array.from({ length: 8 }, () =>
        '<div class="sk-row"><i style="width:44%"></i><i style="width:12%"></i><i style="width:6%"></i><i style="width:6%"></i><i style="width:8%"></i></div>'
      ).join('');
    }
  }
  function setLoading(on) {
    if (on) buildSkeletons();
    document.body.classList.toggle('is-loading', !!on);
    const c = $('#skCloud');
    if (c) c.hidden = !on;
    const t = $('#skTable');
    if (t) t.hidden = !on;
    const k = $('#kpis');
    if (k) k.setAttribute('aria-busy', on ? 'true' : 'false');
    const wl = $('#wordList');
    if (wl) {
      if (on) {
        wordListStash = wl.innerHTML;
        wl.innerHTML = '';
        [72, 54, 64, 46, 58, 40, 50, 36].forEach((w) => {
          const li = document.createElement('li');
          li.className = 'sk-li';
          li.innerHTML = '<i style="width:' + w + '%"></i>';
          wl.appendChild(li);
        });
        wl.scrollTop = 0;
      } else {
        wl.querySelectorAll('.sk-li').forEach((li) => li.remove());
        if (wordListStash != null) {
          wl.innerHTML = wordListStash;
          wordListStash = null;
        }
      }
    }
  }

  function updateEmptyState() {
    const empty = state.comments.length === 0;
    document.body.classList.toggle('is-empty', empty);
    const el = $('#cloudEmpty');
    if (el) el.classList.toggle('hidden', !empty);
  }

  /* ===================== 视频下拉 ===================== */
  function renderVideoFilter() {
    const sel = $('#videoFilter');
    const cur = state.filters.videoId;
    const counts = new Map();
    for (const c of state.comments) counts.set(c.videoId, (counts.get(c.videoId) || 0) + 1);
    const opts = ['<option value="">全部视频（' + state.comments.length + ' 条评论）</option>'];
    const list = Array.from(state.videos.values()).sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0));
    for (const v of list) {
      const n = counts.get(v.id) || 0;
      if (!n) continue;
      const label = (v.title || ('视频 ' + String(v.id).slice(-8))) + `（${n} 条）`;
      opts.push(`<option value="${esc(v.id)}">${esc(label)}</option>`);
    }
    sel.innerHTML = opts.join('');
    sel.value = cur;
    // 「打开原视频 ↗」：选中某条视频时可用；只载入了一条视频时默认可用
    const btn = $('#btnOpenVideo');
    const onlyId = state.videos.size === 1 ? Array.from(state.videos.keys())[0] : '';
    const target = cur || onlyId;
    const meta = target ? (state.videos.get(target) || {}) : null;
    btn.disabled = !target;
    btn.dataset.videoId = target || '';
    btn.title = target
      ? '在新标签页打开抖音视频页：' + ((meta && meta.title) || target)
      : '先在左侧选一条视频（或只载入一条视频）';
  }

  /* ===================== 词云布局 ===================== */
  // 词云只用一支色阶：前 6 个高频词用强调色（数据色），其余两级中性灰。
  function wordTier(rank) {
    if (rank < 6) return { color: '#e0a94a', weight: 600 };
    if (rank < 26) return { color: '#c2c2c7', weight: 500 };
    return { color: '#8e8e94', weight: 400 };
  }

  function measureWord(word, fontSize, cloud) {
    const span = document.createElement('span');
    span.className = 'cw';
    span.textContent = word;
    span.style.position = 'absolute';
    span.style.visibility = 'hidden';
    span.style.whiteSpace = 'nowrap';
    span.style.fontSize = fontSize + 'px';
    span.style.fontWeight = '600';
    span.style.letterSpacing = '0.5px';    cloud.appendChild(span);
    const w = span.offsetWidth, h = span.offsetHeight;
    cloud.removeChild(span);
    return { w: Math.max(w, 8), h: Math.max(h, 8) };
  }

  function layoutCloud(words, cloud) {
    const W = cloud.clientWidth, H = cloud.clientHeight;
    if (!W || !H || !words.length) return [];
    cloud.innerHTML = '';
    const placed = [];
    const pad = 6;
    const maxWords = words.length;
    // v0.5.41：字号按 IDF 权重（而不是纯词频），泛词自动变小
    const minCount = words[maxWords - 1] ? words[maxWords - 1].weight : 1;
    const maxCount = words[0] ? words[0].weight : 1;
    const maxFont = Math.max(24, Math.min(60, Math.round(Math.min(W, H) / 7.5)));
    const minFont = 13;

    const sizeOf = (c) => {
      const t = maxCount === minCount ? 1 : (Math.sqrt(c) - Math.sqrt(minCount)) / (Math.sqrt(maxCount) - Math.sqrt(minCount));
      return Math.round(minFont + (maxFont - minFont) * Math.max(0, Math.min(1, t)));
    };

    const cx = W / 2, cy = H / 2;
    // 把阿基米德螺旋归一化到椭圆里，避免只用水平方向铺、留下上下一大片空白
    const rx = Math.max(40, cx - pad), ry = Math.max(40, cy - pad);

    for (let i = 0; i < maxWords; i++) {
      const rec = words[i];
      const fs = sizeOf(rec.weight);
      const m = measureWord(rec.word, fs, cloud);
      if (m.w > W - pad * 2) continue;
      let angle = (i % 2 === 0 ? 1 : -1) * 0.35;
      let okRect = null;
      for (let step = 0; step < 2600; step++) {
        const sr = 0.055 * Math.pow(Math.max(angle, 0.001), 0.85);
        const x = cx + Math.cos(angle) * sr * rx - m.w / 2;
        const y = cy + Math.sin(angle) * sr * ry - m.h / 2;
        const rect = { x, y, w: m.w, h: m.h };
        if (x >= pad && y >= pad && x + m.w <= W - pad && y + m.h <= H - pad) {
          let hit = false;
          for (const p of placed) {
            if (rect.x < p.x + p.w + 3 && rect.x + rect.w + 3 > p.x &&
                rect.y < p.y + p.h + 2 && rect.y + rect.h + 2 > p.y) { hit = true; break; }
          }
          if (!hit) { okRect = rect; break; }
        }
        angle += 0.38;
      }
      if (!okRect) continue;
      const span = document.createElement('span');
      span.className = 'cw';
      span.textContent = rec.word;
      span.dataset.word = rec.word;
      span.style.left = Math.round(okRect.x) + 'px';
      span.style.top = Math.round(okRect.y) + 'px';
      span.style.fontSize = fs + 'px';
      const tier = wordTier(placed.length);
      span.style.color = tier.color;
      span.style.fontWeight = String(tier.weight);
      cloud.appendChild(span);
      placed.push(okRect);
    }
    return placed;
  }

  /* ===================== 词云交互 ===================== */
  let hideTipTimer = null;

  function wordSamples(rec, n) {
    const out = [];
    for (const c of state.comments) {
      if (!c.text) continue;
      if (rec.cids.has(c.cid) || (c.cid === '' && tokensOf(c.textClean || c.text).map(cleanToken).indexOf(rec.word) >= 0)) {
        out.push(c);
        if (out.length >= n) break;
      }
    }
    return out;
  }

  function showTooltip(span, rec) {
    // v2.1：先清掉「上一个词 mouseout 排下的隐藏定时器」，否则快速从一个词扫到另一个词时，
    // 新弹框会在 180ms 后被旧定时器关掉——表现为「有时候悬停不弹框」。
    clearTimeout(hideTipTimer);
    hideTipTimer = null;
    const tip = $('#tooltip');
    const samples = wordSamples(rec, 2);
    const userCount = rec.users ? rec.users.size : 0;
    const items = samples.map((c) => {
      const href = profileOf(c.user);
      const tag = href ? 'a' : 'div';
      const attrs = href ? ` href="${esc(href)}" target="_blank" rel="noopener noreferrer"` : '';
      const go = href ? ' · <span class="go">点这里打开 TA 的主页 ↗</span>' : ' · <span class="go">（该用户无主页信息）</span>';
      return `<${tag} class="tt-item"${attrs}>
        <div class="tt-txt">${esc(c.text || '（无文字）')}</div>
        <div class="tt-user">${esc(c.user.nickname)}${go}</div>
      </${tag}>`;
    }).join('');
    tip.innerHTML = `
      <div class="tt-word">${esc(rec.word)}</div>
      <div class="tt-meta">出现 ${rec.count} 条评论 · ${userCount} 位用户说了这个词</div>
      <div class="tt-comments">${items || '<div class="muted small">没有可展示的样例评论</div>'}</div>
      <div class="tt-more" data-act="open-drawer">查看全部 ${rec.count} 条 →</div>`;
    tip.classList.remove('hidden');
    positionTooltip(span);
    tip.onmouseenter = () => clearTimeout(hideTipTimer);
    tip.onmouseleave = () => hideTooltip();
    const more = tip.querySelector('[data-act="open-drawer"]');
    if (more) more.addEventListener('click', (e) => { e.stopPropagation(); openDrawer(rec.word); });
  }

  function positionTooltip(span) {
    const tip = $('#tooltip');
    const r = span.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const gap = 12;
    // 悬浮框本身可点（样例评论 → 主页），所以要尽量别盖住词：鼠标进不到词上就会出现
    // 「悬停 A 却显示 B 的框」。做法：在词云面板内试上/下/左/右四个位置，取压住词面积最小的。
    const cloudRect = $('#cloud').getBoundingClientRect();
    const wordRects = $$('.cw', $('#cloud')).map((el) => el.getBoundingClientRect());
    const overlapArea = (x, y) => {
      let sum = 0;
      for (const w of wordRects) {
        const ox = Math.min(x + tw, w.right + 4) - Math.max(x, w.left - 4);
        const oy = Math.min(y + th, w.bottom + 4) - Math.max(y, w.top - 4);
        if (ox > 0 && oy > 0) sum += ox * oy;
      }
      return sum;
    };
    const inside = (x, y) => x >= cloudRect.left + 4 && y >= cloudRect.top + 4 &&
      x + tw <= cloudRect.right - 4 && y + th <= cloudRect.bottom - 4;
    const clampTo = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
    const loX = cloudRect.left + 6, hiX = cloudRect.right - tw - 6;
    const loY = cloudRect.top + 6, hiY = cloudRect.bottom - th - 6;
    const cands = [
      { x: r.left + r.width / 2 - tw / 2, y: r.top - th - gap },        // 上
      { x: r.left + r.width / 2 - tw / 2, y: r.bottom + gap },          // 下
      { x: r.right + gap + 2, y: r.top + r.height / 2 - th / 2 },       // 右
      { x: r.left - tw - gap - 2, y: r.top + r.height / 2 - th / 2 },   // 左
    ].map((c) => ({
      x: clampTo(Math.round(c.x), loX, Math.max(loX, hiX)),
      y: clampTo(Math.round(c.y), loY, Math.max(loY, hiY)),
    }));
    let best = null, bestScore = Infinity;
    for (const c of cands) {
      // 越界（词云面板放不下）优先扣分；再按压住词的总面积排序
      const score = overlapArea(c.x, c.y) + (inside(c.x, c.y) ? 0 : 1e9);
      if (score < bestScore) { bestScore = score; best = c; }
    }
    if (!best) return;
    tip.style.left = best.x + 'px';
    tip.style.top = best.y + 'px';
  }

  function hideTooltip() {
    clearTimeout(hideTipTimer);
    hideTipTimer = setTimeout(() => { $('#tooltip').classList.add('hidden'); }, 180);
  }

  function bindCloudHover() {
    const cloud = $('#cloud');

    function activate(span) {
      const rec = state.wordMap.get(span.dataset.word);
      if (!rec) return;
      if (state.hoverWord !== rec.word) {
        state.hoverWord = rec.word;
        $$('.cw', cloud).forEach((el) => {
          if (el === span) { el.classList.add('hot'); el.classList.remove('dim'); }
          else { el.classList.add('dim'); el.classList.remove('hot'); }
        });
      }
      showTooltip(span, rec);
    }

    cloud.addEventListener('mouseover', (e) => {
      const span = e.target.closest('.cw');
      if (!span) return;
      activate(span);
    });
    // 兜底：tooltip 是浮在词云上的可点面板，会挡住它下面的词，光靠 mouseover 就会出现
    // 「悬停 A 却显示 B 的框 / 悬停了不弹」。这里在 document 上按鼠标坐标做几何命中，
    // 即使指针落在 tooltip 上，只要下面有词就切到那个词。
    function clearHighlight() {
      $$('.cw', cloud).forEach((el) => { el.classList.remove('hot'); el.classList.remove('dim'); });
      state.hoverWord = '';
    }
    let moveRaf = 0;
    let lastPt = null;
    document.addEventListener('mousemove', (e) => {
      lastPt = { x: e.clientX, y: e.clientY };
      // 指针在抽屉里（抽屉会盖住词云右半边）时不要再去命中它背后的词，
      // 否则翻抽屉时词云会莫名其妙地高亮。
      const inDrawer = e.target && e.target.closest ? !!e.target.closest('#drawer') : false;
      if (inDrawer) {
        if (state.hoverWord) clearHighlight();
        return;
      }
      if (moveRaf) return;
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        if (!lastPt) return;
        const p = lastPt;
        const spans = $$('.cw', cloud);
        let hit = null;
        for (const el of spans) {
          const r = el.getBoundingClientRect();
          if (p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) { hit = el; break; }
        }
        // 指针不在任何词上（空处 / 悬浮框上）就必须把高亮清掉。
        // 否则从悬浮框里移出来时，那个词没有 mouseout 事件，会一直亮着、别的词一直变淡，
        // 看起来就是「没悬浮在词上却高亮了」。
        if (!hit) {
          if (state.hoverWord) clearHighlight();
          return;
        }
        const tip = $('#tooltip');
        if (state.hoverWord === hit.dataset.word && !tip.classList.contains('hidden')) return;
        activate(hit);
      });
    });
    document.addEventListener('mouseleave', () => {
      clearHighlight();
      hideTooltip();
    });
    cloud.addEventListener('mouseout', (e) => {
      const span = e.target.closest('.cw');
      if (!span) return;
      const to = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('.cw') : null;
      if (to === span) return;
      span.classList.remove('hot');
      if (!to) {
        $$('.cw', cloud).forEach((el) => el.classList.remove('dim'));
        state.hoverWord = '';
      }
      hideTooltip();
    });
    cloud.addEventListener('click', (e) => {
      const span = e.target.closest('.cw');
      if (!span) return;
      openDrawer(span.dataset.word);
    });
  }

  /* ===================== 侧栏关键词 ===================== */
  function renderWordList() {
    const list = $('#wordList');
    const top = state.words.slice(0, 30);
    const max = top.length ? top[0].count : 1;
    $('#wordInfo').textContent = state.words.length ? `${state.words.length} 个词 · 点击看评论` : '';
    if (!top.length) {
      list.innerHTML = '<li class="muted small" style="display:block;cursor:default">暂无关键词</li>';
      return;
    }
    list.innerHTML = top.map((w, i) => `
      <li data-word="${esc(w.word)}">
        <span class="rank">${i + 1}</span>
        <span class="w" title="${esc(w.word)}">${esc(w.word)}</span>
        <span class="n">${w.count}</span>
      </li>`).join('');
  }

  /* ===================== 抽屉 ===================== */
  const drawer = { word: '', list: [], shown: 0, pageStep: 20 };

  function commentsWithWord(word) {
    const out = [];
    const rec = state.wordMap.get(word);
    for (const c of filtered()) {
      if (!c.text) continue;
      const has = rec && c.cid ? rec.cids.has(c.cid) : tokensOf(c.textClean || c.text).map(cleanToken).indexOf(word) >= 0;
      if (has) out.push(c);
    }
    out.sort((a, b) => b.digg - a.digg);
    return out;
  }

  function openDrawer(word) {
    const list = commentsWithWord(word);
    drawer.word = word;
    drawer.list = list;
    drawer.shown = 0;
    $('#drawerTitle').textContent = '「' + word + '」';
    $('#drawerSub').textContent = `${list.length} 条评论包含这个词（按点赞降序）`;
    $('#drawerBody').innerHTML = '';
    $('#drawer').classList.remove('hidden');
    $('#tooltip').classList.add('hidden');
    renderDrawerMore();
  }

  function renderDrawerMore() {
    const body = $('#drawerBody');
    const next = drawer.list.slice(drawer.shown, drawer.shown + drawer.pageStep);
    if (!drawer.shown && !drawer.list.length) {
      body.innerHTML = '<div class="empty small">没有找到包含这个词的评论</div>';
    }
    const frag = document.createElement('div');
    frag.innerHTML = next.map((c) => {
      const href = profileOf(c.user);
      const go = href
        ? `<a class="dc-go" href="${esc(href)}" target="_blank" rel="noopener noreferrer">打开主页 ↗</a>`
        : '<span class="dc-go off" title="导出数据里没有 sec_uid">无主页信息</span>';
      const badges = [
        c.isHot ? '<span class="badge hot">热评</span>' : '',
        c.isReply ? '<span class="badge reply">回复</span>' : '',
        c.isFolded ? '<span class="badge fold">折叠</span>' : '',
      ].join('');
      return `<div class="dc">
        <div class="dc-head">
          <div class="dc-user">
            <span class="avatar" style="${esc(avatarStyle(c.user))}">${esc(initials(c.user.nickname))}</span>
            <div class="user-meta">
              <span class="user-name">${esc(c.user.nickname)}</span>
              <span class="user-sub">${esc(c.user.uniqueId || (c.user.shortId ? 'ID ' + c.user.shortId : 'ID ' + String(c.user.uid || '').slice(-8)))}</span>
            </div>
          </div>
          ${go}
        </div>
        <div class="dc-text">${esc(c.text || '（无文字）')}</div>
        <div class="dc-meta">
          <span>赞 ${fmtNum(c.digg)}</span>
          <span>回复 ${fmtNum(c.replies)}</span>
          ${c.ip ? `<span>属地 ${esc(c.ip)}</span>` : ''}
          <span>${esc(c.createTimeStr || fmtTimeShort(c.createTime))}</span>
          <span class="spacer"></span>
          ${badges}
        </div>
      </div>`;
    }).join('');
    while (frag.firstChild) body.appendChild(frag.firstChild);
    drawer.shown += next.length;
    const more = $('#btnDrawerMore');
    more.disabled = drawer.shown >= drawer.list.length;
    more.textContent = drawer.shown >= drawer.list.length
      ? `已全部显示（${drawer.list.length} 条）`
      : `加载更多（还有 ${drawer.list.length - drawer.shown} 条）`;
  }

  function closeDrawer() { $('#drawer').classList.add('hidden'); }

  /* ===================== 表格 ===================== */
  function sortList(list) {
    const arr = list.slice();
    const by = state.sort;
    if (by === 'digg') arr.sort((a, b) => b.digg - a.digg || b.createTime - a.createTime);
    else if (by === 'time') arr.sort((a, b) => b.createTime - a.createTime || b.digg - a.digg);
    else if (by === 'len') arr.sort((a, b) => b.text.length - a.text.length || b.digg - a.digg);
    else if (by === 'replies') arr.sort((a, b) => b.replies - a.replies || b.digg - a.digg);
    return arr;
  }

  function highlight(text, q) {
    if (!q) return esc(text);
    const lower = text.toLowerCase();
    let idx = lower.indexOf(q);
    if (idx === -1) return esc(text);
    let out = '', i = 0;
    while (idx !== -1) {
      out += esc(text.slice(i, idx)) + '<span class="hl">' + esc(text.slice(idx, idx + q.length)) + '</span>';
      i = idx + q.length;
      idx = lower.indexOf(q, i);
    }
    out += esc(text.slice(i));
    return out;
  }

  function sentBadge(c) {
    const l = (c.sentiment && c.sentiment.label) || 'neu';
    return '<span class="sbadge ' + l + '" title="词典打分 ' + ((c.sentiment && c.sentiment.score) || 0) + '">' + SENT_LABEL[l] + '</span>';
  }

  function renderTable() {
    const list = sortList(filtered());
    const total = list.length;
    const pages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page > pages) state.page = pages;
    const start = (state.page - 1) * state.pageSize;
    const rows = list.slice(start, start + state.pageSize);
    const q = state.filters.search.trim().toLowerCase();
    const tbody = $('#tbody');
    tbody.innerHTML = rows.map((c) => {
      const href = profileOf(c.user);
      const nameHtml = highlight(c.user.nickname, q);
      const userCell = `<div class="user-cell">
        <span class="avatar" style="${esc(avatarStyle(c.user))}">${esc(initials(c.user.nickname))}</span>
        <div class="user-meta">
          ${href ? `<a class="user-name" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="打开抖音主页">${nameHtml}</a>`
                 : `<span class="user-name nolink" title="导出数据里没有 sec_uid，无法拼主页">${nameHtml}</span>`}
          <span class="user-sub">${esc(c.user.uniqueId || (c.user.shortId ? 'ID ' + c.user.shortId : ''))}</span>
        </div>
      </div>`;
      const badges = `<span class="badges">
        ${c.isHot ? '<span class="badge hot">热</span>' : ''}
        ${c.isReply ? '<span class="badge reply">回复</span>' : ''}
        ${c.isFolded ? '<span class="badge fold">折叠</span>' : ''}
      </span>`;
      return `<tr>
        <td class="cell-text"><div class="txt">${highlight(c.text || '（无文字）', q)}${badges}</div>
          ${c.videoTitle && !state.filters.videoId ? `<div class="muted small" style="margin-top:4px"><a class="video-link" href="${esc(videoUrl(c.videoId))}" target="_blank" rel="noopener noreferrer" title="在原视频页打开这条视频">${esc(c.videoTitle)} ↗</a></div>` : ''}
        </td>
        <td data-label="用户">${userCell}</td>
        <td class="num" data-label="点赞">${fmtNum(c.digg)}</td>
        <td class="num" data-label="回复">${fmtNum(c.replies)}</td>
        <td class="muted" data-label="属地">${esc(c.ip || '-')}</td>
        <td class="muted small" data-label="时间">${esc(c.createTimeStr ? c.createTimeStr.slice(0, 16) : fmtTime(c.createTime))}</td>
        <td class="muted small" data-label="层级">${c.isReply ? '二级' : '一级'}</td>
        <td class="cell-sent" data-label="情感">${sentBadge(c)}</td>
      </tr>`;
    }).join('');
    $('#tableEmpty').classList.toggle('hidden', rows.length > 0);
    $('#tableCount').textContent = `（${total} 条${state.filters.search ? '，含搜索「' + state.filters.search + '」' : ''}）`;
    $('#btnExport').disabled = total === 0;
    if ($('#btnExportJson')) $('#btnExportJson').disabled = total === 0;
    renderPager(pages, total);
  }

  function renderPager(pages, total) {
    const pager = $('#pager');
    const cur = state.page;
    const btns = [];
    btns.push(`<button type="button" data-page="1" ${cur === 1 ? 'disabled' : ''}>« 首页</button>`);
    btns.push(`<button type="button" data-page="${cur - 1}" ${cur === 1 ? 'disabled' : ''}>‹ 上一页</button>`);
    const from = Math.max(1, cur - 3), to = Math.min(pages, from + 6);
    for (let p = from; p <= to; p++) {
      btns.push(`<button type="button" data-page="${p}" class="${p === cur ? 'on' : ''}">${p}</button>`);
    }
    btns.push(`<button type="button" data-page="${cur + 1}" ${cur === pages ? 'disabled' : ''}>下一页 ›</button>`);
    btns.push(`<button type="button" data-page="${pages}" ${cur === pages ? 'disabled' : ''}>末页 »</button>`);
    pager.innerHTML = btns.join('') + `<span class="info">第 ${cur} / ${pages} 页 · 共 ${total} 条</span>`;
  }

  /* ===================== 导出 ===================== */
  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  const EXPORT_COLS = [
    ['cid', '评论ID'], ['video_id', '视频ID'], ['video_title', '视频标题'], ['text', '评论内容'],
    ['user_nickname', '用户昵称'], ['user_unique_id', '抖音号'], ['user_sec_uid', 'sec_uid(主页链接用)'],
    ['digg_count', '点赞数'], ['reply_comment_total', '回复数'], ['ip_label', '属地'],
    ['create_time_str', '发布时间'], ['level', '层级(1一级/2二级)'],
    ['sentiment', '情感(正向/中性/负向)'], ['topic', '主题'],
  ];

  function topicLabelOf(c) {
    const t = state.topics && state.topics[c.topic];
    return t ? t.label : '';
  }

  function exportRows() {
    const list = sortList(filtered());
    if (!list.length) { toast('没有可导出的评论'); return null; }
    return list;
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  function stamp() { return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'); }

  // 导出 CSV：第 1 行英文键（给程序读），第 2 行中文说明（给 Excel 里的人看，首格带 # 标记）
  function exportFilteredCsv() {
    const list = exportRows();
    if (!list) return;
    const rows = [EXPORT_COLS.map((c) => c[0]).join(',')];
    rows.push(EXPORT_COLS.map((c, i) => (i === 0 ? '# ' : '') + c[1]).join(','));
    for (const c of list) {
      rows.push([
        csvCell(c.cid), csvCell(c.videoId), csvCell(c.videoTitle), csvCell(c.text),
        csvCell(c.user.nickname), csvCell(c.user.uniqueId), csvCell(c.user.secUid),
        csvCell(c.digg), csvCell(c.replies), csvCell(c.ip), csvCell(c.createTimeStr || fmtTime(c.createTime)),
        csvCell(c.isReply ? 2 : 1),
        csvCell(SENT_LABEL[(c.sentiment && c.sentiment.label) || 'neu']),
        csvCell(topicLabelOf(c)),
      ].join(','));
    }
    download(new Blob(['\uFEFF' + rows.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }), 'comments-view-' + stamp() + '.csv');
    toast(`已导出 ${list.length} 条评论（CSV）`);
  }

  // 导出 JSON：meta + comments（与采集插件导出的 JSON 结构接近，方便再喂给别的工具）
  function exportFilteredJson() {
    const list = exportRows();
    if (!list) return;
    const vids = Array.from(new Set(list.map((c) => String(c.videoId))));
    const payload = {
      exportedAt: new Date().toISOString(),
      count: list.length,
      filters: {
        videoId: state.filters.videoId || '',
        search: state.filters.search || '',
        onlyHasProfile: !!state.filters.onlyHasProfile,
        onlyTopLevel: !!state.filters.onlyTopLevel,
        onlyNonEmpty: !!state.filters.onlyNonEmpty,
        sortBy: state.filters.sortBy || 'digg',
      },
      videos: vids.map((id) => ({ videoId: id, title: (state.videos.get(id) || {}).title || '' })),
      comments: list.map((c) => ({
        cid: c.cid, videoId: c.videoId, videoTitle: c.videoTitle,
        text: c.text, textClean: c.textClean, createTime: c.createTime, createTimeStr: c.createTimeStr,
        diggCount: c.digg, replyCommentTotal: c.replies, ipLabel: c.ip,
        level: c.isReply ? 2 : 1, isReply: !!c.isReply, isHot: !!c.isHot, isFolded: !!c.isFolded,
        sentiment: (c.sentiment && c.sentiment.label) || 'neu',
        sentimentScore: (c.sentiment && c.sentiment.score) || 0,
        topic: topicLabelOf(c),
        user: { nickname: c.user.nickname, uid: c.user.uid, secUid: c.user.secUid, uniqueId: c.user.uniqueId, shortId: c.user.shortId },
      })),
    };
    download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }), 'comments-view-' + stamp() + '.json');
    toast(`已导出 ${list.length} 条评论（JSON）`);
  }

  /* ===================== 刷新 ===================== */
  function recomputeWords(list) {
    state.words = buildWords(list);
    state.wordMap = new Map(state.words.map((w) => [w.word, w]));
  }

  let layoutSeq = 0;
  function renderCloud() {
    const cloud = $('#cloud');
    if (!state.comments.length) { cloud.innerHTML = ''; return; }
    const size = Number($('#cloudSize').value) || 120;
    const words = state.words.slice(0, size).filter((w) => w.count >= 2 || state.words.length < 40);
    const use = words.length ? words : state.words.slice(0, size);
    const seq = ++layoutSeq;
    // 等一帧，保证 cloud 已按最新尺寸布局
    requestAnimationFrame(() => {
      if (seq !== layoutSeq) return;
      layoutCloud(use, cloud);
      state.cloudReady = true;
    });
  }

  function refreshAll() {
    // v3.0：先给全部评论打情感分（筛选按它走），再在“基础筛选”集合上做主题聚类，
    // 最后按当前筛选渲染表格 / KPI / 洞察。
    annotateSentiment(state.comments);
    const base = baseFiltered();
    buildTopics(base);
    const list = filtered();
    recomputeWords(list);
    renderKpis(list);
    renderInsights(list);
    renderTopicFilter();
    renderVideoFilter();
    renderWordList();
    renderCloud();
    $('#cloudSub').textContent = state.words.length
      ? `${state.words.length} 个词 · ${fmtNum(list.length)} 条评论`
      : '';
    state.page = 1;
    renderTable();
  }

  /* ===================== 事件绑定 ===================== */
  function bindEvents() {
    $('#btnOpenFiles').addEventListener('click', () => $('#fileInput').click());
    const btnOpenFiles2 = $('#btnOpenFiles2');
    if (btnOpenFiles2) btnOpenFiles2.addEventListener('click', () => $('#fileInput').click());
    $('#btnOpenDir').addEventListener('click', () => $('#dirInput').click());
    $('#fileInput').addEventListener('change', (e) => { loadFiles(e.target.files); e.target.value = ''; });
    $('#dirInput').addEventListener('change', (e) => { loadFiles(e.target.files); e.target.value = ''; });

    $('#btnClear').addEventListener('click', () => {
      state.comments = [];
      state.videos = new Map();
      state.sources = [];
      state.words = [];
      state.wordMap = new Map();
      state.page = 1;
      state.filters.videoId = '';
      state.filters.search = '';
      $('#search').value = '';
      updateEmptyState();
      updateScope();
      refreshAll();
      $('#btnClear').disabled = true;
      $('#cloudEmpty').classList.remove('hidden');
      $('#tableEmpty').classList.remove('hidden');
      $('#videoFilter').innerHTML = '';
      $('#btnOpenVideo').disabled = true;
      $('#btnOpenVideo').dataset.videoId = '';
      closeDrawer();
      toast('已清空');
    });

    $('#cloudSize').addEventListener('change', () => { renderCloud(); });
    $('#btnRelayout').addEventListener('click', () => { renderCloud(); toast('已重新排布'); });

    // 「打开原视频 ↗」：新标签页打开当前选中视频的抖音页面
    $('#btnOpenVideo').addEventListener('click', () => {
      const btn = $('#btnOpenVideo');
      const id = btn.dataset.videoId || state.filters.videoId;
      const url = videoUrl(id);
      if (!url) { toast('先选择一条视频'); return; }
      window.open(url, '_blank', 'noopener');
    });

    $('#wordList').addEventListener('click', (e) => {
      const li = e.target.closest('li[data-word]');
      if (!li) return;
      openDrawer(li.dataset.word);
    });

    $('#videoFilter').addEventListener('change', (e) => {
      state.filters.videoId = e.target.value;
      state.filters.topic = '';
      refreshAll();
    });
    const sentSel = $('#sentFilter');
    if (sentSel) sentSel.addEventListener('change', (e) => { state.filters.sentiment = e.target.value; refreshAll(); });
    const topicSel = $('#topicFilter');
    if (topicSel) topicSel.addEventListener('change', (e) => { state.filters.topic = e.target.value; state.page = 1; refreshAll(); });
    const insights = $('#insights');
    if (insights) {
      insights.addEventListener('click', (e) => {
        const t = e.target.closest('[data-topic]');
        if (t) { state.filters.topic = t.dataset.topic; state.page = 1; refreshAll(); return; }
        const w = e.target.closest('[data-topic-word]');
        if (w) { $('#search').value = w.dataset.topicWord; state.filters.search = w.dataset.topicWord; state.page = 1; renderTable(); document.querySelector('.table-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
        const n = e.target.closest('[data-neg-cid]');
        if (n) {
          const c = state.comments.find((x) => x.cid === n.dataset.negCid);
          if (c) toast((SENT_LABEL[(c.sentiment && c.sentiment.label) || 'neu']) + '：' + (c.text || '（无文字）').slice(0, 80));
        }
      });
    }
    ['onlyHasProfile', 'onlyTopLevel', 'onlyNonEmpty', 'onlyContent'].forEach((id) => {
      $('#' + id).addEventListener('change', (e) => {
        state.filters[id] = e.target.checked;
        refreshAll();
      });
    });

    // v0.5.41：自定义加词 / 屏蔽词（逗号或空格分隔，改完 400ms 自动生效并记忆）
    const kwKeepEl = $('#kwKeep'), kwBlockEl = $('#kwBlock');
    if (kwKeepEl) kwKeepEl.value = (state.kwKeep || []).join(',');
    if (kwBlockEl) kwBlockEl.value = (state.kwBlock || []).join(',');
    const onKwTune = debounce(applyWordLists, 400);
    if (kwKeepEl) kwKeepEl.addEventListener('input', onKwTune);
    if (kwBlockEl) kwBlockEl.addEventListener('input', onKwTune);

    const onSearch = debounce(() => {
      state.filters.search = $('#search').value;
      state.page = 1;
      renderTable();
    }, 200);
    $('#search').addEventListener('input', onSearch);

    $('#sortBy').addEventListener('change', (e) => {
      state.sort = e.target.value;
      state.page = 1;
      renderTable();
    });

    $('#pager').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-page]');
      if (!btn) return;
      state.page = Number(btn.dataset.page) || 1;
      renderTable();
      document.querySelector('.table-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    $('#btnExport').addEventListener('click', exportFilteredCsv);
    $('#btnExportJson').addEventListener('click', exportFilteredJson);

    $('#btnCloseDrawer').addEventListener('click', closeDrawer);
    $('#btnDrawerMore').addEventListener('click', renderDrawerMore);
    $('#btnDrawerFilter').addEventListener('click', () => {
      const w = drawer.word;
      if (!w) return;
      $('#search').value = w;
      state.filters.search = w;
      state.page = 1;
      closeDrawer();
      renderTable();
      document.querySelector('.table-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      toast('已在评论表里筛选「' + w + '」');
    });

    window.addEventListener('resize', debounce(() => {
      if (!state.comments.length) return;
      renderCloud();
    }, 260));

    // 拖拽文件到页面
    document.addEventListener('dragover', (e) => { e.preventDefault(); });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeDrawer();
        $('#tooltip').classList.add('hidden');
      }
    });

    bindCloudHover();
  }

  /* ===================== 启动 ===================== */
  // 单文件快照（插件「导出词云」生成的自包含 HTML）会在加载本脚本前塞入
  //   window.__CW_BOOT__ = { title, exportedAt, docs: [<导出 JSON 对象>, …] }
  // 这里把它当成本地文件一样读进来，用户双击 HTML 就能看词云，不用再选文件。
  function bootFromSnapshot() {
    const boot = window.__CW_BOOT__;
    if (!boot || !Array.isArray(boot.docs) || !boot.docs.length) return false;
    let total = 0;
    boot.docs.forEach((doc, i) => {
      try {
        const name = (doc && doc.__name) || `快照-${i + 1}.json`;
        const n = ingestJson(JSON.stringify(doc), name);
        if (n > 0) { total += n; state.sources.push(name); }
      } catch (e) { console.warn('快照读取失败', e); }
    });
    if (!total) return false;
    if (boot.title) document.title = boot.title;
    updateScope();
    updateEmptyState();
    $('#btnClear').disabled = false;
    refreshAll();
    toast(`词云快照：${total} 条评论${boot.exportedAt ? '（导出于 ' + String(boot.exportedAt).slice(0, 16).replace('T', ' ') + '）' : ''}`);
    return true;
  }

  function init() {
    bindEvents();
    renderWordList();
    updateEmptyState();
    updateScope();
    // 快照优先：自带数据时不再走 ?data= 自动载入
    if (bootFromSnapshot()) return console.log('%c评论分析台（快照模式）已就绪', 'color:#e0a94a;font-weight:600');

    // 若页面地址带 ?data=<url 或 相对路径>，尝试自动载入（便于本地服务直接打开）
    try {
      const params = new URLSearchParams(location.search);
      const auto = params.get('data');
      if (auto) {
        fetch(auto, { cache: 'no-store' }).then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        }).then((text) => {
          const n = /\.csv($|\?)/i.test(auto) ? ingestCsv(text, auto.split('/').pop()) : ingestJson(text, auto.split('/').pop());
          if (n > 0) {
            state.sources.push(auto);
            updateScope();
            updateEmptyState();
            $('#btnClear').disabled = false;
            refreshAll();
            toast(`自动载入 ${n} 条评论`);
          }
        }).catch((err) => {
          console.warn('自动载入失败', err);
          toast('自动载入失败：' + err.message + '（可手动选文件）');
        });
      }
    } catch (e) { /* ignore */ }
    console.log('%c评论分析台已就绪', 'color:#e0a94a;font-weight:600', '· 选择导出的 JSON/CSV 即可');
  }

  // 便于自动化测试 / 二次开发
  window.CommentViewer = {
    cleanToken,
    applyWordLists,
    setWordLists: (keep, block) => {
      state.kwKeep = parseWordList(keep);
      state.kwBlock = parseWordList(block);
      const k = $('#kwKeep'), b = $('#kwBlock');
      if (k) k.value = state.kwKeep.join(',');
      if (b) b.value = state.kwBlock.join(',');
      refreshAll();
    },
    state,
    loadFiles,
    ingestJson,
    ingestCsv,
    filtered,
    buildWords,
    tokensOf,
    profileOf,
    videoUrl,
    openDrawer,
    closeDrawer,
    renderTable,
    refreshAll,
    EXPORT_COLS,
    exportRows,
    topicLabelOf,
    sentimentOf,
    annotateSentiment,
    sentimentStats,
    buildTopics,
    renderInsights,
    syncInsightHeights,
    baseFiltered,
    SENT_LABEL,
    exportFilteredCsv,
    exportFilteredJson,
    healthOf, renderHealth,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

  };
  chrome.storage.local.get('dts_cloud_view', function (o) {
    var boot = (o || {}).dts_cloud_view;
    // v0.5.49：cloud.html 的首帧占位要先撤掉（占位给 body 设了 flex 居中，会挤压词云容器导致算不出词）
    var bootCss = document.getElementById('bootCss');
    if (bootCss && bootCss.parentNode) bootCss.parentNode.removeChild(bootCss);
    if (document.body) document.body.removeAttribute('style');
    if (!boot || !boot.docs || !boot.docs.length) {
      document.body.innerHTML = '<p style="padding:24px;color:#a3a3a8;font:14px/1.7 system-ui,-apple-system,Segoe UI,sans-serif">没有可显示的词云数据：回到抖音页面，在面板里点「导出词云」重新打开。</p>';
      return;
    }
    var st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    document.body.className = BODY_CLASS;
    document.body.innerHTML = MARKUP;
    document.title = boot.title || '词云 · 评论分析台';
    window.__CW_BOOT__ = boot;
    window.__cvViewerMain();
    // v0.5.48：云图页加「下载 HTML」（扩展页里可以用 blob 下载，MV3 SW 里不行）
    (function () {
      var actions = document.querySelector('.actions');
      if (!actions) return;
      var saveBtn = document.createElement('button');
      saveBtn.id = 'cvSaveHtml';
      saveBtn.className = 'btn small';
      saveBtn.type = 'button';
      saveBtn.textContent = '下载 HTML';
      saveBtn.title = '把这页保存成单文件 HTML（也可以直接 Ctrl+S）';
      actions.insertBefore(saveBtn, actions.firstChild);
      saveBtn.addEventListener('click', function () {
        saveBtn.disabled = true;
        chrome.runtime.sendMessage({ type: 'dts-cloud-save' }, function (r) {
          saveBtn.disabled = false;
          if (r && r.ok) { saveBtn.textContent = '已保存'; return; }
          saveBtn.textContent = '下载 HTML';
          alert('保存失败：' + ((r && (r.error || r.hint)) || '未知错误'));
        });
      });
    })();
  });
})();
/* === END CLOUD VIEWER (v0.5.46) === */
