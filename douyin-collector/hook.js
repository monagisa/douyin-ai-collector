/**
 * hook.js —— 运行在页面**主世界**（MAIN world）
 *
 * 职责（按 PROTOCOL §2；§2.8 是 v0.1.5 新增的二级回复扩展）：
 *   1. 拦截页面**自己**发出的评论列表请求，把带 `a_bogus` 的完整 URL 存下来
 *      —— 签名只能来自页面，本文件不计算、不逆向、不伪造任何签名；
 *   2. 用同一份已捕获的签名 URL 重放请求，实现「不滚动页面也能翻页」：
 *        · 顶层列表（§2.4）：**只改 cursor / count**，其余参数一个不动
 *        · 二级回复（§2.8，v0.1.5 新增）：把同一份签名的 path 换成
 *          /aweme/v1/web/comment/list/reply/，并改写 item_id / comment_id /
 *          cut_version / cursor / count —— 其余参数原样透传。
 *          **签名仍然只来自页面，没有新签、没有逆向**；实测「一个签名换
 *          comment_id 即可拉任意线程」（probe-reply5.mjs：4 条线程全部翻页拉全）。
 *   3. 只观察页面自己的评论响应，按批上行给隔离世界的 content.js。
 *
 * 明确不做的事（合规红线）：
 *   - 不计算 / 不逆向 / 不伪造签名；不调用 window.byted_acrawler（它只产 X-Bogus）
 *   - 不改请求头、不改请求方法、**不换 host**（始终沿用页面自己用过的那个 host）
 *   - 顶层列表除 cursor/count 外一个 query 参数都不动；二级回复仅按 §2.8
 *     改写 path 与上述 5 个参数
 *   - 不滚动页面、不点击、不操作页面 DOM
 *   - 重放的结果**不进 batch**（PROTOCOL §2.7）：重放数据走 replay-result /
 *     reply-result，避免与「页面自己的流量」重复计数
 */
(function () {
  'use strict';

  // 重复注入保护（content.js 每次 document_start 都会注入一次）
  if (window.__DTS_COLLECTOR_HOOKED__) return;
  window.__DTS_COLLECTOR_HOOKED__ = true;

  var MAGIC = 'DTS_COLLECTOR';

  /** 主列表接口：只有它才触发签名捕获与重放（协议 §2.2） */
  var URL_PATTERN = /\/aweme\/v1\/web\/comment\/list/i;
  /**
   * 二级回复接口（协议 §2.8，v0.1.5 正式接入）。
   * 实测正确路径是 /aweme/v1/web/comment/list/reply/ —— 注意中间那个 list/，
   * 早期以为是 /aweme/v1/web/comment/reply/，那个路径返 404（见 README §7）。
   */
  var URL_REPLY = /\/aweme\/v1\/web\/comment\/list\/reply/i;
  /** 重放二级回复时替换成的 pathname */
  var REPLY_PATH = '/aweme/v1/web/comment/list/reply/';

  /** 单条响应体读取上限（协议 §2.6），超过就不解析，只放一条诊断标记 */
  var MAX_BODY = 2 * 1024 * 1024;
  /** 攒批上限（协议 §2.6），超过就立刻发一次 captured，避免内存堆积 */
  var MAX_BATCH = 500;

  // ---------- 状态 ----------
  var signed = null;      // { url, keys, at }：最近一次页面自己发出的带签名请求
  var capturing = false;  // 是否正在攒批上报
  var batch = [];         // 待上报的评论对象（原样，裁剪由 content.js 负责）
  var replyUrls = [];     // 二级回复 URL 的最近记录（备查，上限 20 条）

  // 原生 fetch 的引用：重放走它，避免被自己的包装再次拦截（协议 §2.7）
  var nativeFetch = window.fetch;

  // ---------- 小工具 ----------

  function up(type, payload) {
    try {
      window.postMessage({ __dts_collector: MAGIC, dir: 'up', type: type, payload: payload || {} }, '*');
    } catch (e) { /* postMessage 失败不影响页面 */ }
  }

  function absUrl(u) {
    try { return new URL(String(u), location.href).href; } catch (e) { return String(u); }
  }

  /** 取 query 参数名列表（协议 §1 的 signed.keys，便于外部核对 41 个参数是否原样） */
  function keysOf(url) {
    var out = [];
    try {
      new URL(url).searchParams.forEach(function (_v, k) { out.push(k); });
    } catch (e) { /* 忽略 */ }
    return out;
  }

  /**
   * 捕获签名 URL：命中列表接口 **且** URL 里含 a_bogus= 时覆盖更新。
   * 每次命中都刷新，保证重放用的签名尽量新鲜（协议 §2.3）。
   */
  function noteSigned(url) {
    if (!url || url.indexOf('a_bogus=') < 0) return;
    if (!URL_PATTERN.test(url)) return;
    signed = { url: url, keys: keysOf(url), at: Date.now() };
    // 顺手把 aweme_id 摘出来上行：推荐页 URL 里没有视频 ID，这是内容脚本识别
    // 「当前在看哪个视频」的可靠来源之一（见 content.js extractVideoId）。
    var awemeId = null;
    try { awemeId = new URL(url).searchParams.get('aweme_id'); } catch (e) { /* 忽略 */ }
    up('signed', { url: signed.url, keys: signed.keys, at: signed.at, aweme_id: awemeId });
  }

  /** 二级回复 URL 只做有界记录，不采集 */
  function noteReply(url) {
    if (!url) return;
    replyUrls.push({ url: url, at: Date.now() });
    if (replyUrls.length > 20) replyUrls.shift();
  }

  // ---------- 采集缓冲（协议 §2.6） ----------

  /** 攒批的最长停留时间：不满 MAX_BATCH 也要按时发出去，否则一次采集里页面自己的
   *  那几页评论永远停在主世界里（以前只有「超过 500 条」才发，content.js 又从不调 getBatch）。 */
  var FLUSH_DELAY_MS = 300;
  var flushTimer = 0;

  function flushNow(from) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = 0; }
    if (!batch.length) return;
    var items = batch;
    batch = [];
    up('captured', { items: items, from: from || 'page' });
  }

  function flushIfFull(from) {
    if (batch.length > MAX_BATCH) { flushNow(from); return; }
    if (batch.length && !flushTimer) {
      flushTimer = setTimeout(function () { flushTimer = 0; flushNow(from); }, FLUSH_DELAY_MS);
    }
  }

  /** 解析一条列表响应，把 comments 攒进 batch；只在 capturing 时攒 */
  function ingest(text, from) {
    if (!capturing) return;
    if (typeof text !== 'string' || !text) return;

    // 超大响应不解析，只留诊断标记，避免一次性吃掉大量内存
    if (text.length > MAX_BODY) {
      batch.push({ __oversize: true, bytes: text.length });
      flushIfFull(from);
      return;
    }

    var j;
    try { j = JSON.parse(text); } catch (e) { return; }
    if (!j || !Array.isArray(j.comments) || j.comments.length === 0) return;
    for (var i = 0; i < j.comments.length; i++) batch.push(j.comments[i]);
    flushIfFull(from);
  }

  /** 取出并清空待上报缓冲（协议 §2 的 getBatch） */
  function getBatch() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = 0; }
    var items = batch;
    batch = [];
    return items;
  }

  // ---------- 重放（协议 §2.4） ----------

  /**
   * 用已捕获的签名 URL 重发一次请求。
   * 只有 cursor / count 两个参数被改写，其余 39 个 query 参数原样透传。
   * 刻意不 sleep —— 限速由 content.js 负责。
   */
  async function replay(cursor, count) {
    var base = {
      cursor: cursor, status: null, got: 0, next: null,
      total: null, hasMore: null, ms: 0, items: [], error: null
    };

    if (!signed || !signed.url) {
      base.error = 'NO_SIGNED_URL';
      return base;
    }

    var u;
    try {
      u = new URL(signed.url);
    } catch (e) {
      base.error = 'BAD_SIGNED_URL: ' + String(e);
      return base;
    }

    // ↓↓↓ 全文件仅有的两处 query 改动（协议 §2.4）↓↓↓
    u.searchParams.set('cursor', String(cursor));
    u.searchParams.set('count', String(count));
    // ↑↑↑ 其余参数一律不碰 ↑↑↑

    var t0 = (window.performance || Date).now();
    try {
      var res = await nativeFetch.call(window, u.toString(), { credentials: 'include' });
      var text = await res.text();
      // 空 body 是服务端的一种拒绝形态：实测回复接口在被限流时回 0 字节，
      // JSON.parse('') 会抛 SyntaxError: Unexpected end of JSON input，
      // 把 JS 异常串当协议很脆（文案会变、无法稳定判定）。归一成稳定错误码。
      // 注意与「越过列表末端」区分：那个回的是字面量 null（→ STATUS_NULL）。
      if (!text) {
        base.ms = Math.round(((window.performance || Date).now()) - t0);
        base.ok = false;
        base.error = 'EMPTY_BODY';
        return base;
      }
      var j = JSON.parse(text);
      var items = (j && Array.isArray(j.comments)) ? j.comments : [];
      base.ms = Math.round(((window.performance || Date).now()) - t0);
      base.status = j ? j.status_code : null;
      base.got = items.length;
      base.next = j ? j.cursor : null;
      base.total = j ? j.total : null;
      base.hasMore = j ? j.has_more : null;
      base.items = items;
      base.ok = !!(j && j.status_code === 0);
      if (!base.ok) base.error = 'STATUS_' + (j ? j.status_code : 'NULL');
      return base;
    } catch (e) {
      base.ms = Math.round(((window.performance || Date).now()) - t0);
      base.ok = false;
      base.error = String(e);
      return base;
    }
  }

  // ---------- 二级回复重放（协议 §2.8，v0.1.5 新增） ----------

  /**
   * 用**同一份**已捕获的签名 URL，拉某个顶层评论下的二级回复。
   *
   * 与 replay() 的区别（这是全文件唯一一处会改 path 的地方，协议 §2.8 有明确描述）：
   *   - pathname → /aweme/v1/web/comment/list/reply/
   *   - 删掉 aweme_id，改设 item_id / comment_id / cut_version=1
   *   - cursor / count 照常改写
   *   - 其余几十个参数（含 a_bogus / msToken / verifyFp …）**原样透传**
   *
   * 签名依旧完全来自页面自己发出的那次请求，本文件不产生任何签名。
   * 实测依据：probe-reply3.mjs（从真实请求里抓到该接口）、
   *           probe-reply5.mjs（4 条线程全部翻页拉全，Σ上报 370 vs Σ实拉 377）。
   */
  async function replayReply(parentCid, cursor, count) {
    var base = {
      parentCid: String(parentCid), cursor: cursor, status: null, got: 0, next: null,
      total: null, hasMore: null, ms: 0, items: [], error: null
    };

    if (!signed || !signed.url) {
      base.error = 'NO_SIGNED_URL';
      return base;
    }

    var u;
    try {
      u = new URL(signed.url);
    } catch (e) {
      base.error = 'BAD_SIGNED_URL: ' + String(e);
      return base;
    }

    // ↓↓↓ 仅 §2.8 允许的改动 ↓↓↓
    var awemeId = u.searchParams.get('aweme_id');
    u.pathname = REPLY_PATH;
    u.searchParams.delete('aweme_id');
    u.searchParams.set('item_id', awemeId || '');
    u.searchParams.set('comment_id', String(parentCid));
    u.searchParams.set('cut_version', '1');
    u.searchParams.set('cursor', String(cursor));
    u.searchParams.set('count', String(count));
    // ↑↑↑ 其余参数一律不碰 ↑↑↑

    var t0 = (window.performance || Date).now();
    try {
      var res = await nativeFetch.call(window, u.toString(), { credentials: 'include' });
      var text = await res.text();
      // 空 body 是服务端的一种拒绝形态：实测回复接口在被限流时回 0 字节，
      // JSON.parse('') 会抛 SyntaxError: Unexpected end of JSON input，
      // 把 JS 异常串当协议很脆（文案会变、无法稳定判定）。归一成稳定错误码。
      // 注意与「越过列表末端」区分：那个回的是字面量 null（→ STATUS_NULL）。
      if (!text) {
        base.ms = Math.round(((window.performance || Date).now()) - t0);
        base.ok = false;
        base.error = 'EMPTY_BODY';
        return base;
      }
      var j = JSON.parse(text);
      var items = (j && Array.isArray(j.comments)) ? j.comments : [];
      base.ms = Math.round(((window.performance || Date).now()) - t0);
      base.status = j ? j.status_code : null;
      base.got = items.length;
      base.next = j ? j.cursor : null;
      base.total = j ? j.total : null;
      base.hasMore = j ? j.has_more : null;
      base.items = items;
      base.ok = !!(j && j.status_code === 0);
      if (!base.ok) base.error = 'STATUS_' + (j ? j.status_code : 'NULL');
      return base;
    } catch (e) {
      base.ms = Math.round(((window.performance || Date).now()) - t0);
      base.ok = false;
      base.error = String(e);
      return base;
    }
  }

  // ---------- fetch 拦截（协议 §2.1） ----------
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      var url = absUrl(typeof input === 'string' ? input : (input && input.url) || '');
      // ⚠️ 顺序很重要：URL_PATTERN(/comment/list/i) 也会匹配到
      // /comment/list/reply/。必须先判回复，否则页面一展开回复线程，
      // signed 就会被覆盖成一条「comment_id 固定」的回复 URL ——
      // 之后主列表重放会去抓那条线程的回复，数据全错。
      var isReply = URL_REPLY.test(url);
      var hit = !isReply && URL_PATTERN.test(url);

      // 先记签名再放行：签名新鲜度以「页面发起请求的时刻」为准
      if (hit) noteSigned(url);
      else if (isReply) noteReply(url);

      var p = nativeFetch.apply(this, arguments);
      if (!hit) return p;

      // 克隆一份读 body —— 绝不消费页面自己的响应流，返回的原响应对象不变
      return p.then(function (res) {
        try {
          res.clone().text().then(
            function (txt) { ingest(txt, 'fetch'); },
            function () { /* 读 body 失败不影响页面 */ }
          );
        } catch (e) { /* clone 不支持时静默跳过 */ }
        return res;
      });
    };
  }

  // ---------- XHR 拦截（协议 §2.1） ----------
  var XO = XMLHttpRequest.prototype.open;
  var XS = XMLHttpRequest.prototype.send;
  var XH = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      var a = absUrl(url);
      // 同样先判回复（URL_PATTERN 会误匹配 /comment/list/reply/）
      var isReply = URL_REPLY.test(a);
      this.__dts = { url: a, hit: !isReply && URL_PATTERN.test(a) };
      if (this.__dts.hit) noteSigned(a);
      else if (isReply) noteReply(a);
    } catch (e) { /* 忽略 */ }
    return XO.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      var meta = this.__dts;
      if (meta && meta.hit) {
        var self = this;
        // 只在 loadend 里读 responseText，此时页面自己已经消费完响应
        self.addEventListener('loadend', function () {
          try {
            var rt = self.responseType;
            // 仅当 responseType 是 '' 或 'text' 时才安全可读（协议 §2.1）
            if (rt !== '' && rt !== 'text') return;
            var txt = self.responseText;
            if (typeof txt === 'string' && txt) ingest(txt, 'xhr');
          } catch (e) { /* 读失败不影响页面 */ }
        });
      }
    } catch (e) { /* 忽略 */ }
    return XS.apply(this, arguments);
  };

  // setRequestHeader 只做透明包装：本扩展从不修改请求头，包装目的仅是保证
  // 原型方法存在且行为完全不变（协议 §2.1 要求覆盖该方法）。
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    return XH.apply(this, arguments);
  };

  // ---------- 重放触发（隔离世界 → 主世界） ----------
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    // 两个方向都必须校验 magic 与方向（协议 §1）
    if (!d || d.__dts_collector !== MAGIC || d.dir !== 'down') return;

    var p = d.payload || {};
    switch (d.type) {
      case 'start-capture':
        capturing = true;
        break;
      case 'stop-capture':
        capturing = false;
        flushNow('page');   // 停止前攒下的那点别丢在主世界里
        break;
      case 'status':
        // 隔离世界 → 主世界镜像，供 getStatus() 读取（测试/调试用）
        lastStatus = p;
        break;
      case 'replay':
        // 串行重放由 content.js 保证；这里只负责执行并回一条 replay-result
        replay(Number(p.cursor) || 0, Number(p.count) || 0).then(
          function (r) { up('replay-result', r); },
          function (e) {
            up('replay-result', {
              ok: false, cursor: Number(p.cursor) || 0, status: null, got: 0,
              next: null, total: null, hasMore: null, ms: 0, items: [],
              error: 'REPLAY_THROW: ' + String(e)
            });
          }
        );
        break;
      case 'replay-reply':
        // 协议 §2.8：用同一份签名拉某个顶层评论的二级回复
        replayReply(p.parentCid, Number(p.cursor) || 0, Number(p.count) || 0).then(
          function (r) { up('reply-result', r); },
          function (e) {
            up('reply-result', {
              ok: false, parentCid: String(p.parentCid || ''), cursor: Number(p.cursor) || 0,
              status: null, got: 0, next: null, total: null, hasMore: null, ms: 0, items: [],
              error: 'REPLAY_REPLY_THROW: ' + String(e)
            });
          }
        );
        break;
      default:
        break;
    }
  });

  // ---------- 主世界全局接口（协议 §2，供 executeScript 兜底调用） ----------
  // 隔离世界的可见变量拿不到（content script 在 isolated world），
  // 所以由 content.js 通过 'status' 消息把采集进度镜像到这里，供调试/测试读取。
  var lastStatus = null;

  window.__DTS_COLLECTOR__ = {
    /** 返回当前签名 URL（副本），没有则 null */
    getSigned: function () {
      return signed ? { url: signed.url, keys: signed.keys.slice(), at: signed.at } : null;
    },
    /** 取出并清空缓存 */
    getBatch: getBatch,
    /** 用已捕获签名重放一页 */
    replay: replay,
    /** 用已捕获签名拉某个顶层评论的二级回复（协议 §2.8） */
    replayReply: replayReply,
    /** 最近记录到的二级回复 URL（备查，上限 20 条） */
    getReplyUrls: function () { return replyUrls.slice(); },
    /** 当前是否在攒批 */
    isCapturing: function () { return capturing; },
    /** 采集进度快照（由隔离世界镜像过来），没有则 null */
    getStatus: function () { return lastStatus; }
  };

  // 通知隔离世界：钩子已就绪
  up('hook-ready', { href: location.href });
})();
