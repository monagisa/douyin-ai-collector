(function () {
  const input = document.getElementById('hubUrl');
  const btn = document.getElementById('btnProbe');
  const badge = document.getElementById('probeBadge');
  const out = document.getElementById('probeOut');

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
