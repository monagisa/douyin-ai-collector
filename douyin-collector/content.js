/**
 * content.js —— 隔离世界（ISOLATED world），document_start 注入
 *
 * 职责（严格按 PROTOCOL §3）：
 *   1. 把主世界的 hook.js 注入页面，并与其用 window.postMessage 双向通信；
 *   2. 驱动采集循环：反复用页面自己的签名重放评论列表，
 *      只推进 cursor，直到 has_more === 0；
 *   3. 去重 + 按协议裁剪字段 + 攒批上报 background 落盘；
 *   4. 渲染采集面板（样式全部来自 panel.css，本文件只加 class，不写内联 style）。
 *
 * 明确不做的事：不滚动页面、不操作页面 DOM（自建面板除外）、
 * 不碰签名、不改 cursor/count 以外的任何请求参数。
 * 唯一的例外是「自动打开评论区」：开始采集前如果还没拿到签名，会朝评论入口
 * 发一次合成点击（见 autoOpenComments），让页面自己发出带 a_bogus 的请求。
 */
(function () {
  'use strict';

  var MAGIC = 'DTS_COLLECTOR';

  // ================== 限速常量（数值必须与 PROTOCOL §3.2 一致） ==================
  // 2026-09-28 实测调优（探针 probe-count.mjs，依据见 README §5）：
  //   服务端单页硬上限 = 50（count=100/200 也只回 50），用它比 20 少一半页数
  //   服务端 p50 = 228ms（min 217 / max 385），故 400ms 间隔仍留有余量
  //   页面自身分页实测 ~444ms/页，400~550ms 与页面自身节奏相当甚至更慢
  const COUNT = 50;                     // 服务端上限 50；原先用 20 白跑一倍页数
  const MIN_INTERVAL_MS = 400;          // 每轮之间最小间隔
  const JITTER_MS = 150;                // 0~150 随机抖动
  const MAX_PAGES = 3000;               // 硬上限，防御死循环
  const FAIL_STREAK_PAUSE = 3;          // 连续失败几次就暂停
  const BACKOFF_BASE_MS = 3000;         // 失败退避基数
  const BACKOFF_MAX_MS = 60000;         // 退避上限
  const SIGN_STALE_MS = 8 * 60 * 1000;  // 签名超过 8 分钟视为过期，暂停等新签名

  // ================== 触底补扫（2026-09-28 实测，见 README §7） ==================
  // 视频 7667575725930679579 实测：total=3170，但列表接口在 offset 1500 处
  // has_more=0（此后每个 cursor 都是空页，重试稳定、换 count/排序也一样）——
  // 服务端就给这么多，不是循环停早了。但热榜区会重排，单轮扫完的唯一数
  // 比多轮取并集少 ~8%（README §2 的 Jaccard 实验），所以触底后值得再扫。
  const MAX_PASSES = 4;                 // 含首轮在内的最大扫描轮数（手动再点「开始采集」会重置，可继续捞）
  const RESCAN_MIN_NEW = 30;            // 本轮新增少于这个数就不再补扫

  // ================== 二级回复采集（v0.1.5，协议 §3.8） ==================
  // 顶层 list 接口不返回二级回复，而服务端 total **把回复也算进去了**
  // （2026-09-28 实测：差额的 76% 就是 Σreply_comment_total）。
  // 真实接口是 /aweme/v1/web/comment/list/reply/（早期猜 /comment/reply/ 一直 404）。
  // 实测（probe-reply3/5.mjs）：**一个已捕获签名换 comment_id 即可拉任意线程**，
  //   4 条线程全部翻页拉全：214→221、60→61、53→52、43→43，零重试。
  // 首屏 50 条顶层评论里 62% 带回复 → 线程数多、单线程页数少，所以按线程并发。
  // 剩余那 ~24% 是已删除评论，任何接口都拿不到（probe-fold.mjs 实测
  //   folded_comment_count=0，且页面上根本没有「折叠」入口）。
  const REPLY_COUNT = 20;                 // 回复单页条数（实测 20 可用；页面自己用 3）
  const REPLY_LANES = 4;                  // 并发线程数（用户要求恢复 4 路；v0.1.7 曾因突发限流降到 2，现按 4 路 + 仍保留 600ms 间隔，避免回到 4×120ms 那档）
  const REPLY_GAP_MS = 600;               // 同一线程两页之间的间隔（原 120；突发是触发限流的主因）
  const REPLY_MAX_REQUESTS = 40000;       // 回复请求总上限（防御）
  const REPLY_MAX_PAGES_PER_THREAD = 200; // 单线程页数上限（防御死循环）
  // 实测演进（probe-replyfail → probe-replydiag → probe-replywho → probe-replyburst）：
  //  1) 刚捕获的签名打回复接口：串行 10/10、4 路并发 20/20 全成功。
  //  2) 主扫描刚轰完列表接口时，紧接的回复请求会被服务端拒掉——**形态是空 body**
  //     （hook 归一成 EMPTY_BODY），而不是越界时的字面量 null（STATUS_NULL）。
  //  3) 决定性对照（probe-replydiag，同一签名同一时刻）：
  //       回复接口（真实线程 cid=7667883981014582053）→ 288ms 空 body，失败
  //       列表接口 replay(0,50)                     → 713ms status_code=0，成功
  //     ⇒ **回复接口被拒 ≠ 签名失效**。所以绝不能因为回复失败就转 waiting-sign
  //       要求用户滚动（那正是用户抱怨的场景）。
  //  4) **拒绝是时间窗，不是永久「硬拒」**（probe-replywho 同秒对照）：
  //       页面自己点 12 个「展开N条回复」→ 12 条全部 200/空 body，UI 也没出回复；
  //       但同一时刻把页面那条 URL 原样重放 → 200、9051 字节、3 条回复，成功；
  //       扩展自己的 replayReply 也成功（8 条）。
  //     ⇒ 抖音**连页面自己的突发请求一起拒**，没有「学他」可学的东西；
  //       几秒后同样的 URL 又能通 → 窗口会自己打开。
  //  5) 还会升级成**会话级**（probe-replyburst，用页面自己的 list URL 当模板）：
  //       连**列表接口**都回 status_code=5（body 200 字节、comments=null），
  //       扩展自己的 replay(0,50) 同样 STATUS_5 ⇒ 不只是回复接口被限。
  //     ⇒ 突发速率本身就是触发条件：页面点 6 个按钮的突发、扩展 4 路×120ms
  //       都算突发，越轰窗口越不容易开。
  // 策略：① 并发 REPLY_LANES=4（用户要求提速）+ REPLY_GAP_MS=600（仍保留，避免回到 4×120ms 那档）；
  //       ② **短预算**：用户明确要求「限流十秒不行就停掉」，所以整段等限流只给
  //          REPLY_THROTTLE_MAX_WAIT_MS = 10 秒（墙钟，含退避睡眠本身），
  //          配套把退避压到 1s→2s→3s（上限 3s）、streak 3、冷却 1.5s，
  //          一次补采最多花 ~10 秒在「等窗口」上，之后立刻收尾，绝不长时间卡住；
  //          想再试就再点一次「开始采集」——已采到的不重复拉，从断点续采；
  //       ③ 只有「签名真没了」（NO_SIGNED_URL / 坏签名 / 401·403 / 传输错误）才要求用户
  //          重新打开评论区；STATUS_5 / EMPTY_BODY / STATUS_NULL 一律当**限流**（签名还活着）；
  //       ④ 等满 10 秒仍无果就优雅收尾成 done，**绝不无限等待、绝不要求滚动**。
  const REPLY_WARMUP_MS = 1500;           // 进入补采前先停一下，让刚被列表扫描用掉的配额回血
  const REPLY_COOLDOWN_MS = 1500;         // 连续失败到阈值后的冷却（预算只有 10s，冷却必须短）
  const REPLY_FAIL_STREAK_STOP = 3;       // 连续失败累计到这个数，才做一次「冷却 + 探签名死活」
  const REPLY_BACKOFF_BASE_MS = 1000;     // 重试退避基数（1s 起，指数递增到上限后保持）
  const REPLY_BACKOFF_MAX_MS = 3000;      // 退避上限（3s：预算 10s 内只够试几次，不拖长）
  const REPLY_THROTTLE_MAX_WAIT_MS = 10 * 1000;       // 整段「等限流窗口」的墙钟上限（用户定的 10 秒）

  // ================== 并发重放（最快档） ==================
  // 2026-09-28 探针 probe-burst.mjs 实证（同一签名多路复用）：
  //   1 路 698ms / 2 路 561ms / 4 路 366ms / 6 路 515ms（6 路服务端开始排队，反而变慢）
  //   各 cursor 独立返回，next == cursor+count 全部成立 → 可安全并发
  //   每路平均：1 路 698ms → 4 路 92ms（7.63x）
  //   全量 206 页：串行 2.9 分钟 → 4 路 0.4 分钟
  const MAX_LANES = 4;                  // 实测甜点；6 路更慢且有风控风险
  const LANE_GAP_MS = 100;              // 多路模式轮间隔（单发形态靠 LANES=1 保底）
  const MIN_LANE_ITEMS = 30;            // 一路返回 <30 条视为触底，该轮结束后停

  // 协议未规定重放超时：没有它时一条丢失的上行消息会让采集永久挂起
  const REPLAY_TIMEOUT_MS = 15000;
  const HOOK_WAIT_MS = 3000;

  // ================== PROTOCOL §3.4 落盘字段白名单 ==================
  const COMMENT_FIELDS = [
    'cid', 'text', 'create_time', 'digg_count', 'reply_comment_total',
    'ip_label', 'is_hot', 'is_folded', 'level', 'stick_position',
    'status', 'content_type', 'image_list', 'user'
  ];
  const USER_FIELDS = ['uid', 'nickname', 'sec_uid', 'unique_id', 'short_id', 'avatar_thumb'];

  const PHASE_CN = {
    idle: '空闲',
    'waiting-sign': '等待签名',
    collecting: '采集中',
    replies: '补采回复',
    paused: '已暂停',
    done: '已完成',
    error: '错误'
  };

  // 标题栏状态点的颜色档位（panel.css 的 .dts-dot-*）
  const DOT_CLASS = {
    idle: 'dts-dot-idle',
    'waiting-sign': 'dts-dot-warn',
    collecting: 'dts-dot-busy',
    replies: 'dts-dot-busy',
    paused: 'dts-dot-idle',
    done: 'dts-dot-ok',
    error: 'dts-dot-err'
  };

  // ================== 状态 ==================
  var phase = 'idle';
  var seen = new Set();      // cid 去重（协议 §3.3，background 里还会再兜一次）
  var cursor = 0;            // 下一个请求的 cursor
  // cursor / seen / replyTargets / replyDoneSet 这套进度属于**哪个 videoId**。
  // cursor 是全局变量，但它的语义是「在某个视频的评论列表里翻到哪儿了」——
  // 换视频后若不重置，就会拿上一个视频的 offset 去翻新视频（见 onStartClick）。
  var cursorVideoId = null;
  var total = 0;             // 服务端权威总数
  var pages = 0;             // 已发起的页数
  var lastMs = 0;            // 上一页耗时
  var savedCount = 0;        // background 回报的落库条数
  var errText = '';          // 错误信息（.dts-err）
  var noteText = '';         // 提示信息（.dts-muted）
  var signedAt = 0;          // 签名捕获时间
  var signedKeys = [];       // 签名的 query 参数名（核对用）
  var failStreak = 0;        // 连续失败次数
  var running = false;       // 采集循环是否在跑
  var stopFlag = false;      // 暂停/停止请求标志
  var needSign = false;      // 因签名问题暂停，等新签名后自动继续
  var pass = 1;              // 当前是第几轮扫描（触底后补扫会 +1）
  var passNew = 0;           // 本轮新增的唯一评论数，决定还要不要补扫
  var floorCursor = null;    // 服务端首次返回 has_more=0 的 cursor（列表物理终点）
  var hookReady = false;     // 主世界 hook 是否就绪
  var pendingReplay = new Map(); // 在飞的重放请求，按 cursor 索引（并发时同时有多个）
  var pendingItems = [];     // 攒批：待上报 background 的裁剪后评论
  var videoId = extractVideoId();
  var awemeIdFromSigned = null; // 页面自己发的评论请求里带的 aweme_id（多源识别用，见 extractVideoId）

  // ---- 二级回复（协议 §3.8，v0.1.5）----
  var replyTargets = new Map();   // 顶层 cid → 服务端报的回复数（reply_comment_total）
  var replyDoneSet = new Set();   // 已拉完的顶层 cid（重扫/暂停继续时不重复拉）
  var replyPages = 0;             // 已发起的回复请求数
  var repliesCollected = 0;       // 本轮已入队的回复条数
  var pendingReplies = new Map(); // 在飞的回复请求，按 parentCid|cursor 索引
  var replyFailStreak = 0;        // 回复请求连续失败次数
  var replyFailCount = 0;         // 补采失败（没拉全）的线程数
  var replyLastError = '';        // 最近一次回复失败原因（供面板/测试诊断）
  var replyThrottledMs = 0;       // 因「回复接口拒绝」而静默等待的累计毫秒（不打扰用户的预算）
  var replyThrottleStartAt = 0;   // 本轮静默等待的起点（墙钟）；0 = 当前不在等待
  var replyStoppedByThrottle = false; // 本轮补采是因为「服务端硬拒回复接口」而提前收尾的（面板要如实说明）
  var resumeReplies = false;      // 补采因签名失效停下后，拿到新签名直接回补采（不重扫顶层）
  /** 清空/换代号：清空时 +1。旧 startLoop 的在途回包若 epoch 不一致，必须丢弃，
   *  否则清空后旧循环会把 cursor 写回高位，再点开始就“续采”，但池子已是空的。 */
  var collectEpoch = 0;
  var justCleared = false;        // 刚点过清空：下次开始采集必须整体重置、从 cursor=0

  // ================== 小工具 ==================

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /** 连续失败时的指数退避，上限 BACKOFF_MAX_MS */
  function backoffMs(streak) {
    var m = BACKOFF_BASE_MS * Math.pow(2, Math.max(0, streak - 1));
    return Math.min(m, BACKOFF_MAX_MS);
  }

  /**
   * 多源识别当前视频 ID。
   *
   * v0.1.0 只认 pathname 的 /video/<id>，导致推荐页（/jingxuan）完全无法采集 ——
   * 实测三种页面形态，URL 长得都不一样：
   *
   *   1) 详情页直开   https://www.douyin.com/video/7670855102969761051
   *        → pathname 里有
   *   2) 推荐页点开卡片 https://www.douyin.com/jingxuan?modal_id=7686909085408611630
   *        → 浮层播放，**只有 query 的 modal_id**，pathname 是 /jingxuan
   *   3) 推荐页直接刷   https://www.jingxuan.com/jingxuan
   *        → URL 里**什么都没有**，ID 只在 DOM 的 data-aweme-id 上
   *
   * 三条源分权威等级：
   *   urlId   —— URL 里的（最权威，代表「用户此刻打开的是哪个视频」）
   *   sigId   —— 页面自己发过的评论请求里带的 aweme_id（**会过期**，见下）
   *   domId   —— DOM 里正在播放/视口中心的卡片（兜底）
   *
   * ⚠️ sigId 的坑（2026-09-28 实测踩到）：它是全局缓存，用户在视频 A 开过评论区后
   * 它就一直是 A 的 ID。切到视频 B 时 urlId/domId 都拿不到 B（推荐页 URL 无 ID），
   * 若此时无条件返回 sigId 就会**返回上一个视频的 ID**，把 B 的评论写进 A 名下。
   * 所以要求「多源一致」：sigId 只在能被 urlId 或 domId 佐证时才采信。
   */
  function extractVideoId() {
    // 1) URL —— 最权威
    var urlId = null;
    var m = /\/video\/(\d{15,25})/.exec(location.pathname);
    if (m) urlId = m[1];
    if (!urlId) {
      try {
        var mid = new URLSearchParams(location.search).get('modal_id');
        if (mid && /^\d{15,25}$/.test(mid)) urlId = mid;
      } catch (e) { /* 忽略 */ }
    }

    var sigId = (awemeIdFromSigned && /^\d{15,25}$/.test(awemeIdFromSigned)) ? awemeIdFromSigned : null;
    var domId = null;
    try { domId = awemeIdFromDom(); } catch (e) { /* 忽略 */ }
    if (domId && !/^\d{15,25}$/.test(domId)) domId = null;

    // URL 有 ID 就是它，别的源再说什么都不动摇
    if (urlId) return urlId;

    // URL 没有 ID（推荐页形态）：要求 sigId 与 domId 互相佐证
    if (sigId && domId) {
      // 两个都说同一个 → 可信；说不一样 → 宁可返回 null 让用户重开，也不猜
      return (sigId === domId) ? sigId : null;
    }
    // 只有其中一个有值：DOM 是「此刻屏幕上真的在放什么」，比历史签名可靠
    if (domId) return domId;
    if (sigId) return sigId;

    return null;
  }

  /**
   * 从元素 class 名里抠出 `video_<id>`。
   *
   * 2026-09-29 实测（probe-rec5.mjs）：**真推荐页 `/?recommend=1` 上完全没有
   * `[data-aweme-id]`**（可见 id 数 0），当前这条视频的 id 只出现在
   * `<div data-e2e="feed-video" class="NhEiLku8 video_7675959070997695782 sliderVid">`
   * 这种 class 名里 ⇒ 推荐页想识别 ID 就必须靠它，否则用户看到的永远是
   * 「未识别到视频 ID」。
   */
  function awemeIdFromClass(el) {
    if (!el || !el.getAttribute) return null;
    var s = el.getAttribute('class') || '';
    if (!s && typeof el.className === 'string') s = el.className;
    var m = /(?:^|\s)video_(\d{15,25})(?:\s|$)/.exec(s);
    return m ? m[1] : null;
  }

  /**
   * 元素**自身或子孙**的 class 里有没有 `video_<id>`。
   *
   * 2026-09-29 实测（run-recommend-collect R2 读到 null，而同一时刻 DOM 里
   * `ids:["7690522922046766329"]` 明明存在）：真推荐页上外层 `[data-e2e="feed-item"]`
   * （整屏 slide）的 class 里**没有** id，id 只挂在**嵌套的** `[data-e2e="feed-video"]`
   * 上。只查自身 class 会在「正在播的 video 那一刻没抓到」时直接返回 null。
   */
  function awemeIdFromClassDeep(el) {
    var own = awemeIdFromClass(el);
    if (own) return own;
    if (!el || !el.querySelectorAll) return null;
    var kids = el.querySelectorAll('[class]');
    for (var i = 0; i < kids.length; i++) {
      var id = awemeIdFromClass(kids[i]);
      if (id) return id;
    }
    return null;
  }

  /**
   * 找到正在播放的 <video>，再往上找 id。
   * 认两种来源：祖先的 `data-aweme-id`，或祖先 class 里的 `video_<id>`
   * （推荐页没有 `<a href="/video/">` 链接，也没有 data-aweme-id，只能靠这两种）。
   */
  function awemeIdFromPlayingVideo() {
    var vids = document.querySelectorAll('video');
    for (var i = 0; i < vids.length; i++) {
      var v = vids[i];
      // 只认真正在播的（推荐页有多个 video，未播的那些定位在视口外）
      if (v.paused || !v.currentTime) continue;
      // ⚠️ 还必须**够大**（2026-09-30 run-pages-collect 实测踩到）：SPA 换页后上一页的
      // 隐藏 <video> 可能还在播（抖音把旧层留在 DOM 里），而「我的」这种作品网格里
      // 卡片上的小视频自己也会自动播 ⇒ 不加这条就会把**上一个页面**的视频 id
      // 当成当前页面在看的视频（E2E 实测在 /user/self 上读到 /follow 的 id，
      // 于是 phase 停在 waiting-sign、落库标签也是别的视频）。
      var r = v.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.height < window.innerHeight * 0.5 && r.width < window.innerWidth * 0.5) continue;
      var el = v;
      for (var hops = 0; el && hops < 20; hops++) {
        var id = el.getAttribute && el.getAttribute('data-aweme-id');
        if (id) return id;
        var cid = awemeIdFromClass(el);
        if (cid) return cid;
        el = el.parentElement;
      }
    }
    return null;
  }

  /** 在元素集合里挑「离视口中心最近且在视口内」的那个元素（pick(el) 为空就跳过） */
  function nearestVisibleEl(list, pick) {
    var cy = window.innerHeight / 2;
    var best = null, bestDist = Infinity;
    for (var i = 0; i < list.length; i++) {
      var r = list[i].getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.bottom <= 0 || r.top >= window.innerHeight) continue; // 不在视口内
      var v = pick(list[i]);
      if (v == null || v === '') continue;
      var d = Math.abs((r.top + r.height / 2) - cy);
      if (d < bestDist) { bestDist = d; best = list[i]; }
    }
    return best;
  }

  /**
   * 「这条元素代表哪条视频」（v0.1.12 通用版，不区分页面类型）。
   * 三种来源按可靠性排序：自身 `data-aweme-id` → 自身/子孙 `a[href*="/video/"]` 的 URL
   * → 自身或子孙 class 里的 `video_<id>`。
   * 2026-09-29 probe-pages2 实测为什么必须三路都要：
   *   · 我的 `/user/self`：`[data-aweme-id]` 与 video 全是 0×0，id **只在** `a[href*="/video/"]` 里；
   *   · 精选 `/jingxuan`、推荐页：外层 `[data-e2e="feed-item"]` 自身没有 id，id 在**嵌套的**
   *     `[data-e2e="feed-video"]` 上（所以要往下扫子孙 class）。
   */
  function awemeIdFromEl(el) {
    if (!el || !el.getAttribute) return null;
    var attr = el.getAttribute('data-aweme-id');
    if (attr && /^\d{15,25}$/.test(attr)) return attr;
    var href = el.getAttribute('href') || '';
    if (!href && el.querySelector) {
      var link = el.querySelector('a[href*="/video/"]');
      if (link) href = link.getAttribute('href') || '';
    }
    var m = /\/video\/(\d{15,25})/.exec(href);
    if (m) return m[1];
    return awemeIdFromClassDeep(el);
  }

  /**
   * 「可能代表一条视频」的元素——不按页面类型写死。
   * 关注 `/follow`、朋友 `/friend` 的当前视频是 `[data-e2e="feed-active-video"]`；
   * 精选/推荐是 `[data-e2e="feed-item"]`/`feed-video`；详情页浮层是 `modal-video-container`
   * 里的 video；我的 `/user/self` 只有 `a[href*="/video/"]` 卡片链接。
   */
  var VIDEO_EL_SEL = '[data-e2e="feed-active-video"], [data-e2e="feed-item"], '
    + '[data-e2e="feed-video"], [data-aweme-id], a[href*="/video/"]';

  /** 最后的兜底：全文档找「自身 class 里带 video_<id>」的**可见**元素（只看自身，避免扫子孙放大成本）。
   *  ⚠️ 必须要求可见：SPA 换页后旧层会留在 DOM 里（还带着上一页那条视频的 `video_<id>` class），
   *  不加可见性就会把上一个页面的视频 id 当成当前页面在看的视频（2026-09-30 run-pages-collect 实测）。 */
  function awemeIdByClassToken() {
    var els = document.querySelectorAll('[class*="video_"]');
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.bottom <= 0 || r.top >= window.innerHeight) continue;
      var id = awemeIdFromClass(els[i]);
      if (id) return id;
    }
    return null;
  }

  /**
   * DOM 识别（v0.1.12 去写死）：一条通用可靠性链，任何页面都走它。
   *   ① 正在播的 `<video>` 往上找（最权威：用户正看的就是它）
   *   ② 可见的 `[data-e2e="feed-active-video"]`（关注/朋友/推荐这类全屏 feed 的「当前视频」）
   *   ③ 视口内离中心最近的视频元素（`VIDEO_EL_SEL`，含卡片链接——「我的」靠这一路）
   *   ④ class 里带 `video_<id>` 的元素（兜底）
   * 旧版是「`[data-aweme-id]` → `feed-item/feed-video`」两路写死，于是在
   * 「我的」页（`[data-aweme-id]` 全 0×0 不可见、id 只在 `<a href="/video/…">` 里）
   * 直接识别失败 → 点「开始采集」就报「未识别到视频 ID」（2026-09-29 实测）。
   */
  function awemeIdFromDom() {
    var playing = awemeIdFromPlayingVideo();
    if (playing) return playing;

    // ② 可见的「当前视频」容器（同样要求可见：旧页面留下的隐藏节点会被 querySelector
    //    第一个命中，用 nearestVisibleEl 挑视口内那个）
    var active = nearestVisibleEl(document.querySelectorAll('[data-e2e="feed-active-video"]'), awemeIdFromEl);
    if (active) {
      var a = awemeIdFromEl(active);
      if (a) return a;
    }

    var el = nearestVisibleEl(document.querySelectorAll(VIDEO_EL_SEL), awemeIdFromEl);
    if (el) {
      var id = awemeIdFromEl(el);
      if (id) return id;
    }

    return awemeIdByClassToken();
  }

  /** 标题用于 CSV/JSON 元信息；只读取不修改页面 */
  function currentTitle() {
    var t = document.title || '';
    return t.replace(/\s*[-–—]\s*抖音.*$/, '').trim() || t;
  }

  /**
   * 页面切换检测：用户点了别的视频 / 关掉了浮层。
   *
   * 必须清两样东西，缺一样就漏数据到别的视频名下：
   *
   *   ① awemeIdFromSigned —— 页面发的评论请求里的 aweme_id，是全局缓存：
   *      用户在视频 A 开过评论区后它一直是 A。不清就会把「当前在看的是 A」这个
   *      错误答案喂给识别逻辑（2026-09-28 实测踩到）。
   *
   *   ② signedAt = 0 —— **更关键**。重放用的签名 URL 里内嵌着 aweme_id，
   *      hook.replay() 只改 cursor/count、不动 aweme_id，所以只要还用 A 的签名，
   *      抓回来的就一直是 A 的评论。清掉签名强制走 waiting-sign，
   *      等页面为新视频发出评论请求后再继续 —— 这样「抓到的数据」和
   *      「落库用的 videoId」必然一致。
   *
   * 只在**能证明签名属于别的视频**时才清，否则会误伤：抖音详情页/部分浮层会在
   * 导航后立刻自动发评论请求，若不分青红皂白地清，用户就得白等一次。
   */
  var lastPageKey = null;
  function pageKey() {
    var m = /\/video\/(\d{15,25})/.exec(location.pathname);
    if (m) return 'v:' + m[1];
    try {
      var mid = new URLSearchParams(location.search).get('modal_id');
      if (mid) return 'm:' + mid;
    } catch (e) { /* 忽略 */ }
    // 推荐页/精选页的 URL 里没有任何 id，但当前在视口里的那条视频 DOM 里有
    // （`[data-e2e="feed-video"]` 的 class 形如 `video_7675959070997695782`）。
    // **必须算进 pageKey**：否则用户在真推荐页滑到下一条视频时 URL 不变（还是 `/`），
    // pageKey 不变 ⇒ 上一条视频的签名不会被作废，抓回来的上一条视频评论会被记到
    // 下一条名下 —— 正是 2026-09-28 修过的跨视频污染。2026-09-29 probe-rec5 实测：
    // 推荐页 class 里的 id 能稳定区分当前这条视频。
    try {
      var domId = awemeIdFromDom();
      if (domId) return 'd:' + domId;
    } catch (e) { /* 忽略 */ }
    return 'path:' + location.pathname;
  }

  /** 「用户此刻在看哪个视频」——只看 URL 与 DOM，不看签名缓存（那正是要防的东西） */
  function pageViewId() {
    var m = /\/video\/(\d{15,25})/.exec(location.pathname);
    if (m) return m[1];
    try {
      var mid = new URLSearchParams(location.search).get('modal_id');
      if (mid && /^\d{15,25}$/.test(mid)) return mid;
    } catch (e) { /* 忽略 */ }
    try { return awemeIdFromDom(); } catch (e) { return null; }
  }

  /**
   * 推荐页（feed）判断。
   *
   * 推荐页与视频详情页的差别**不在能不能识别 ID**（两边都能，实测 /jingxuan
   * 的 liveVideoId 一直是正确的），而在**签名从哪来**：
   *   · 详情页 /video/<id>：页面一打开自己就请求评论列表 → 签名自动就有；
   *   · 推荐页 /jingxuan（含 ?modal_id= 浮层）：页面**不发**任何评论请求，
   *     直到用户点开评论区（点视频右侧那个带数字的评论图标）。
   * 2026-09-28 实测（probe-feed-net.mjs）：推荐页打开 + 点开浮层，页面一共发了
   * 26 个 /aweme/v1/web/ 请求，**评论类 0 个**；只有真把评论区点开
   * （probe-feed-drawer.mjs 用 DOM click 点开）才出现 comment/list 请求并拿到签名，
   * 随即采到 639 条。
   *
   * ⇒ 所以在推荐页等签名时，提示必须是「去点评论图标」，而不是「滚动评论区」——
   *   推荐页在点开之前**根本没有评论区可滚**。
   */
  /**
   * 页面形态（v0.1.10 拆开：之前把「推荐页」和「精选页」当成一回事，指引是错的）：
   *   'overlay'   已打开视频浮层（`?modal_id=<id>`，精选页点卡片后就是这种）
   *   'recommend' 真推荐页：`/` 或 `/?recommend=1` —— **全屏单视频**，右侧有带数字的评论图标
   *   'grid'      `/jingxuan`（精选页）或 `/recommend` —— **网格**，没有常驻评论区，必须先点卡片开浮层
   *   'detail'    `/video/<id>` —— 详情页，下方就是评论区
   *   'other'     其它
   * 2026-09-29 实测（probe-recommend*.mjs / probe-rec4/rec5.mjs）：自动化浏览器里
   * `?recommend=1` 会在几秒~十几秒后被服务端弹回 `/jingxuan`（抹掉自动化指纹后能留 ~18 秒），
   * 而**用真实鼠标点导航栏的「推荐」**能稳定停在 `?recommend=1`。
   */
  function pageKind() {
    var p = location.pathname || '/';
    var modal = null, rec = null;
    try {
      var q = new URLSearchParams(location.search);
      modal = q.get('modal_id');
      rec = q.get('recommend');
    } catch (e) { /* 忽略 */ }
    if (modal) return 'overlay';
    if (rec === '1') return 'recommend';
    if (/^\/video\//.test(p)) return 'detail';
    if (/^\/(jingxuan|recommend)/.test(p)) return 'grid';
    if (p === '/') return 'recommend';
    return 'other';
  }

  /** 是否「推荐页/精选页/浮层」这类 Feed 形态（详情页与其它页面不算） */
  function isFeedPage() {
    var k = pageKind();
    return k === 'recommend' || k === 'grid' || k === 'overlay';
  }

  /**
   * 页面「能力形态」（v0.1.12）：**按 DOM 判，不再按 URL 清单写死**。
   *   'detail'  详情页（URL 有 `/video/<id>`）—— 下方常驻评论区，等签名时可以滚
   *   'overlay' 视频浮层（URL 有 `modal_id`）—— 右侧有带数字的评论图标
   *   'feed'    全屏 feed：**关注 `/follow`、朋友 `/friend`**、推荐 `/` —— 一屏一条视频，
   *             右侧有带数字的评论图标，扩展可以自己点开
   *   'grid'    只有卡片列表：精选 `/jingxuan`、**我的 `/user/self` 的作品网格** ——
   *             没有「当前视频」，必须先点开一条
   *   'unknown' 什么都没认出来
   *
   * 为什么要有它：v0.1.11 及以前一切按 URL 清单分支，于是关注/朋友页（URL 不在清单里）
   * 被当成 'other'，提示错成详情页那句「请手动把评论列表往下滚一下」（那页根本没有常驻
   * 评论区）。2026-09-29 probe-pages2 实测：关注 `/follow`、朋友 `/friend` 的 DOM 与推荐页
   * 同构（`[data-e2e="feed-active-video"]` + `feed-comment-icon`），我的 `/user/self` 是
   * 纯网格（`[data-aweme-id]` 全 0×0，id 只在 `a[href*="/video/"]` 上）。
   * ⇒ 行为只依赖 mode：能不能自动点评论图标、该给什么指引，都由 DOM 决定。
   */
  function pageMode() {
    var k = pageKind();
    if (k === 'detail') return 'detail';
    if (k === 'overlay') return 'overlay';
    if (hasActiveVideo()) return 'feed';
    if (hasVideoCards()) return 'grid';
    return k === 'grid' ? 'grid' : 'unknown';
  }

  /**
   * 有没有「用户正在看的整屏视频」。
   * 必须要求**占据大半屏**：作品网格里卡片上的小视频也会自动播，若不加这条，
   * 「我的」页会被误判成 feed 形态，然后给一堆让人去找评论图标的错指引。
   */
  function hasActiveVideo() {
    var active = document.querySelector('[data-e2e="feed-active-video"]');
    if (active && visibleForClick(active)) {
      var ar = active.getBoundingClientRect();
      if (ar.height >= window.innerHeight * 0.5) return true;
    }
    var vids = document.querySelectorAll('video');
    for (var i = 0; i < vids.length; i++) {
      var v = vids[i];
      if (v.paused || !v.currentTime) continue;      // 只认真正在播的
      var r = v.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.height < window.innerHeight * 0.5) continue;
      return true;
    }
    return false;
  }

  /**
   * 有没有可见的视频卡片（网格判据：只要求「有卡片」，不要求知道是哪一条）。
   * 我的 `/user/self` 靠 `a[href*="/video/"]`；精选页靠 `[data-aweme-id]`。
   */
  function hasVideoCards() {
    var els = document.querySelectorAll('a[href*="/video/"], [data-aweme-id]');
    for (var i = 0; i < els.length; i++) {
      if (visibleForClick(els[i])) return true;
    }
    return false;
  }

  /**
   * 等签名时给用户的**兜底**提示：只说明扩展自己做不到、需要人来的那一步。
   * v0.1.12 起按 DOM 形态给（`pageMode()`），不再按 URL 清单分支 —— 以前关注/朋友页
   * 落到默认分支，被错发详情页那句「滚评论区」（那页根本没有常驻评论区）。
   */
  function signHint() {
    var k = pageKind();
    var mode = pageMode();
    // 真推荐页给最具体的一句（README 与 run-recommend-collect R3 都锚了这句）
    if (k === 'recommend') {
      return '若一直没动静，请点一下**视频右侧**那个带数字的「评论」图标'
        + '——这是抖音推荐页（全屏刷视频），没有评论区时点它才会打开。';
    }
    if (mode === 'feed') {
      return '若一直没动静，请点一下**视频右侧**那个带数字的「评论」图标'
        + '——这个页面是一屏一条视频（关注、朋友这类都一样），没有评论区时点它才会打开。';
    }
    if (mode === 'grid') {
      return '若一直没动静，请先点开一条作品（点一下卡片打开浮层），'
        + '再点它右侧那个带数字的「评论」图标。';
    }
    if (mode === 'overlay') {
      return '若一直没动静，请点一下视频右侧那个带数字的「评论」图标。';
    }
    // detail（/video/<id>）与认不出来的页面：详情页下方就是常驻评论区，滚它最有效
    return '若一直没动静，请手动把评论列表往下滚一下，让页面自己发出评论请求。';
  }

  // ---- 自动打开评论区（v0.1.11） ----
  // 为什么要自动打开：抖音只在评论区**真的被打开**时才发带 a_bogus 的评论请求，
  // 扩展才有签名可重放。以前这一步得用户自己点评论图标，现在扩展自己点。
  // 三条约束（用户明确要求）：
  //   ① 只在「点了开始采集、但还没有可用签名」时点；
  //   ② 空闲时绝不碰页面（不预打开、不预加载、不动别人的评论抽屉）；
  //   ③ 评论区已经打开时不再点（不做多余动作）。
  // 可行性实测（probe-autoopen.mjs，视频详情页）：
  //   · 普通 `el.click()` 就把评论列表从 0 条开到 5 条，页面自己发出真实评论请求、拿到新签名；
  //   · 完整合成指针序列更强（0→12 条、签名与请求都刷新）；
  //   · 点 `[data-e2e="comment-list"]` 滚动也能触发（12→20 条）。
  // content script 发不出 isTrusted 事件，但抖音的评论入口不校验 isTrusted，所以可行。
  var AUTO_OPEN_MAX = 3;      // 一次「开始采集」里最多自动点 3 次（首次 + 两次补点）
  var autoOpenCount = 0;      // 本轮已经点了几次
  var NUDGE_MAX = 3;          // 面板已经开着（再点会把抽屉点关）时，最多滚动催 3 次
  var nudgeCount = 0;         // 本轮已经滚动催了几次
  var autoOpenLast = '';      // 最近一次结果（写进状态，面板与测试都看它）
  // 「现在这份『开着的评论面板』可能是换页前留下的」——换页时置位，第一次点击或新签名到手后撤掉
  var panelStateSuspect = false;
  var autoOpenTimers = [];
  // 排障用（v0.1.13）：自动打开评论区这条路每一步的去向（谁在什么时候点了/为什么收手/
  // 补点定时器为什么没跑）。只留最近 30 条，随 status 镜像发给测试与面板诊断。
  var autoOpenLog = [];
  function logAutoOpen(s) {
    autoOpenLog.push(s);
    if (autoOpenLog.length > 30) autoOpenLog.shift();
  }

  /**
   * 真的渲染出来的评论条数 —— **只数看得见的**。
   * 换视频（SPA）后上一个视频的评论面板会留在 DOM 里：实测 items=10 但 itemsVis=0、
   * `comment-list` 是 0x0 hidden。只数 DOM 个数会把这种残留误当成「评论区已经打开」。
   * 2026-09-30 run-switch-clear 实测（用户 m07969 报的 bug）：换页后扩展因此一次都不点，
   * 页面不会再发 comment/list，新签名永远等不到，卡 waiting-sign 30s+。
   */
  function visibleCommentItemCount() {
    var els = document.querySelectorAll('[data-e2e="comment-item"]');
    var n = 0;
    for (var i = 0; i < els.length; i++) if (visibleForClick(els[i])) n++;
    return n;
  }

  /** 评论区是否已经打开（打开就别再点了） */
  function commentAreaOpen() {
    if (visibleCommentItemCount() > 0) return true;
    var list = document.querySelector('[data-e2e="comment-list"]');
    if (!list || !visibleForClick(list)) return false;
    var r = list.getBoundingClientRect();
    // 详情页没打开评论区时 comment-list 就已经存在，但只有 20 来像素高（实测 h=22）
    return r.height > 60 && r.width > 40;
  }

  /**
   * 「评论入口」候选，按优先级排列（v0.1.12 去页面类型化）。
   * 这几个 data-e2e 在关注/朋友/推荐/精选/详情页/浮层里都通用，不再按形态分两张表：
   *   feed-comment-icon  —— 全屏 feed（关注/朋友/推荐）右侧、精选卡片右上角那个带数字的图标
   *   comment-icon       —— 视频浮层/详情页的评论图标
   *   video-comment-more —— 详情页评论区里的「更多」入口（兜底）
   */
  var COMMENT_ENTRY_SEL = ['[data-e2e="feed-comment-icon"]',
    '[data-e2e="comment-icon"]',
    '[data-e2e="video-comment-more"]'];

  /** 「当前这条视频」的容器（把评论入口限定在它内部，避免点到背景里别的视频上） */
  var VIDEO_BOX_SEL = '[data-e2e="feed-active-video"], [data-e2e="feed-item"], '
    + '[data-e2e="feed-video"], [data-e2e="modal-video-container"]';

  function currentVideoBox() {
    var active = document.querySelector('[data-e2e="feed-active-video"]');
    if (active && visibleForClick(active)) return active;
    return nearestVisibleEl(document.querySelectorAll(VIDEO_BOX_SEL), function () { return 1; });
  }

  /**
   * 在 scope 里按候选顺序找入口：**元素中心必须落在视口内**，同选择器取离视口中心最近的那个。
   * 为什么不能取「第一个可见的」：`visibleForClick` 只要求元素与视口相交，上一屏视频的图标
   * 在顶部露 2px 也算「可见」，取到它就会去点**别的视频**的入口 —— 实测（2026-09-30
   * run-pages-collect A 节）3 次点击后评论区一次都没开（`area=0`），因为点的是邻屏残留节点。
   */
  function bestVisibleEntry(scope, sels) {
    for (var s = 0; s < sels.length; s++) {
      var els = scope.querySelectorAll(sels[s]);
      var best = null, bestD = Infinity;
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (!visibleForClick(el)) continue;
        var r = el.getBoundingClientRect();
        var cy = r.top + r.height / 2, cx = r.left + r.width / 2;
        if (cy < 0 || cy > window.innerHeight || cx < 0 || cx > window.innerWidth) continue;
        var d = Math.abs(cy - window.innerHeight / 2);
        if (d < bestD) { bestD = d; best = el; }
      }
      if (best) return { el: best, sel: sels[s] };
    }
    return null;
  }

  /** 点了之后把结果写进状态并排一次补点（两条寻找路径共用） */
  function clickCommentEntry(el, sel) {
    autoOpenCount++;
    autoOpenLast = 'clicked:' + sel;
    var crc = el.getBoundingClientRect();
    logAutoOpen('click:' + sel + ' n=' + autoOpenCount + ' rect='
      + [Math.round(crc.left), Math.round(crc.top), Math.round(crc.width), Math.round(crc.height)].join(',')
      + ' cy=' + Math.round(crc.top + crc.height / 2));
    panelStateSuspect = false;   // 已经在本页面点过入口了，之后面板状态可信
    synthClick(el);
    render();
    scheduleAutoOpenRetry();
    return true;
  }

  /** 元素真的看得见才点（页面里有大量同名的 0×0 隐藏元素，点了等于没点） */
  function visibleForClick(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return false;
    if (r.bottom <= 0 || r.top >= window.innerHeight) return false;
    if (r.right <= 0 || r.left >= window.innerWidth) return false;
    var st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  }

  /**
   * 朝元素发一次完整的合成指针序列。
   * 为什么不是只写 `el.click()`：抖音的评论入口走 React 合成事件，实测完整序列最稳；
   * 但普通 click 也有效，所以序列之后再补一发 click 兜底。
   */
  function synthClick(el) {
    var r = el.getBoundingClientRect();
    var opt = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: Math.round(r.left + r.width / 2),
      clientY: Math.round(r.top + r.height / 2),
      button: 0, buttons: 1
    };
    var ext = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, opt, ext)));
      el.dispatchEvent(new MouseEvent('mousedown', opt));
      el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, opt, ext, { buttons: 0 })));
      el.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, opt, { buttons: 0 })));
      el.dispatchEvent(new MouseEvent('click', Object.assign({}, opt, { buttons: 0 })));
      if (typeof el.click === 'function') el.click();
      return true;
    } catch (e) { return false; }
  }

  /**
   * 面板已经开着、但页面迟迟不发新的 `comment/list` 时，用**滚动**催它一次。
   * 为什么是滚动而不是再点：再点会把抽屉**点关**（第 5 轮 A5/C10 实测），而滚动不会。
   * 抖音的评论列表是虚拟列表，滚到底会拉下一页 → 页面自己发一条新的带 a_bogus 的评论请求
   * （probe-autoopen.mjs 实测：滚动 comment-list 让 12 条 → 20 条，即真的发了新请求）。
   * 2026-09-30 run-pages-collect C 节实测：`enter:retry n=2 area=1 vis=5` 时扩展直接
   * `stop:clicked-already` 收手，签名永远等不到 —— 这一步就是补它的。
   * 返回是否真的催了一次。
   */
  function nudgeCommentList() {
    if (nudgeCount >= NUDGE_MAX) return false;
    var list = document.querySelector('[data-e2e="comment-list"]');
    if (!list || !visibleForClick(list)) return false;
    nudgeCount++;
    try {
      var r = list.getBoundingClientRect();
      list.scrollTop = list.scrollHeight;
      list.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, composed: true,
        clientX: Math.round(r.left + r.width / 2),
        clientY: Math.round(r.top + r.height / 2),
        deltaY: 1200, deltaMode: 0
      }));
    } catch (e) { /* 只靠上面的 scrollTop 也能触发原生 scroll */ }
    logAutoOpen('nudge:list n=' + nudgeCount);
    render();
    scheduleAutoOpenRetry();
    return true;
  }

  /** 试着自动打开评论区；返回是否真的点了入口（只在「需要签名」的路径上调用） */
  function autoOpenComments(why) {
    logAutoOpen('enter:' + why + ' n=' + autoOpenCount + ' area=' + (commentAreaOpen() ? 1 : 0)
      + ' vis=' + visibleCommentItemCount() + ' sus=' + (panelStateSuspect ? 1 : 0));
    if (autoOpenCount >= AUTO_OPEN_MAX) { logAutoOpen('giveup:max'); return false; }
    if (commentAreaOpen()) {
      // ① 本轮已经点过一次、现在面板还看着是开的 ⇒ 绝不再点：会把抽屉**点关**。
      //    2026-09-30 run-pages-collect 第四轮 A5/C10 实测 `autoOpen=clicked:… n=2 areaOpen=false`。
      if (autoOpenCount > 0) {
        // 点过就不再点（会把抽屉点关），但**可以滚动催一下**：页面只有发出新的 comment/list
        // 才有新签名。2026-09-30 C 节实测：面板开着（vis=5）时直接收手 ⇒ 永远等不到签名。
        if (nudgeCommentList()) { autoOpenLast = 'scrolled:list'; return false; }
        autoOpenLast = 'already-open'; logAutoOpen('stop:clicked-already'); return false;
      }
      // ② 面板里确实有评论、而且这份「开着的面板」属于当前页面 ⇒ 真开好了，不碰页面。
      //    panelStateSuspect=false 才可信：换页后留在 DOM 里的旧面板也可能「看着是开的、
      //    里面还有上一个视频的评论」，信它就会一次都不点（用户 m07969 的 bug：2026-09-30
      //    run-switch-clear 实测换页后 items=10/itemsVis=0，扩展记 already-open n=0，卡 30s+）。
      var nItems = visibleCommentItemCount();
      if (nItems > 0 && !panelStateSuspect) {
        // 面板确实开好了，但我们现在之所以走到这里，就是因为**还没有签名** ⇒ 页面把评论
        // 从缓存渲染出来了、没发新的 comment/list。点不得（会点关），只能滚动催一次。
        if (nudgeCommentList()) { autoOpenLast = 'scrolled:list'; return false; }
        autoOpenLast = 'already-open'; logAutoOpen('stop:visible-items'); return false;
      }
      // ③ 空面板、或刚换过页面 ⇒ 必须点一次入口，逼页面重新发 comment/list。
      //    run-pages-collect 第三轮 B3/B5 实测：空面板时 already-open 收手 → 卡在 waiting-sign。
    }
    var mode = pageMode();
    // 作品列表（精选页网格、个人主页 `/user/self` 的作品网格）：「用户在看哪条视频」还没定，
    // 卡片上那个评论图标点下去很可能把用户**带到另一条视频**的浮层里。2026-09-29 实测
    // （run-feed-collect F2）：自动点之后扩展识别的 ID 与用户自己点开的 `?modal_id=` 对不上
    // —— 宁可一次都不点，等用户点开一条（那时 mode 变成 'overlay'，这条路就会自动点）。
    if (mode === 'grid') { autoOpenLast = 'no-target:grid'; logAutoOpen('stop:grid'); render(); return false; }
    // ① 优先在「当前这条视频的容器」内部点，避免点到背景里别的视频的图标上去
    var box = currentVideoBox();
    if (box) {
      var hit = bestVisibleEntry(box, COMMENT_ENTRY_SEL);
      if (hit) return clickCommentEntry(hit.el, hit.sel);
    }
    // ② 容器认不出来（或容器里没有）就全文档找
    var any = bestVisibleEntry(document, COMMENT_ENTRY_SEL);
    if (any) return clickCommentEntry(any.el, any.sel);
    autoOpenLast = 'no-target:' + mode;
    logAutoOpen('stop:no-target:' + mode);
    render();
    return false;
  }

  /** 点了不等于页面就发请求（抽屉有动画），1.5s 后还没拿到新鲜签名就补点一次 */
  function scheduleAutoOpenRetry() {
    if (autoOpenCount >= AUTO_OPEN_MAX) return;
    var t = setTimeout(function () {
      if (signedAt && Date.now() - signedAt <= SIGN_STALE_MS) { logAutoOpen('retry-skip:fresh-sig'); return; }   // 已有新签名，别再碰页面
      if (!needSign) { logAutoOpen('retry-skip:needSign=false phase=' + phase); return; }                       // 已经不需要签名了
      logAutoOpen('retry-fire');
      autoOpenComments('retry');
    }, 1500);
    autoOpenTimers.push(t);
  }

  /** 每次「开始采集」重新给满次数，并清掉上一轮排队的补点 */
  function resetAutoOpen() {
    autoOpenCount = 0;
    nudgeCount = 0;
    autoOpenLast = '';
    for (var i = 0; i < autoOpenTimers.length; i++) clearTimeout(autoOpenTimers[i]);
    autoOpenTimers = [];
  }

  /** 「等待签名」那一行 note：如实说清扩展做了什么、用户还剩什么事要做 */
  function waitingSignNote() {
    var base = '等待页面自己发出带 a_bogus 的评论请求……';
    if (autoOpenLast === 'already-open') return base + '评论区已经打开。' + signHint();
    // 面板开着但页面迟迟不发新请求（它可能直接用缓存渲染了评论）：扩展改成把列表滚到底去催
    if (/^scrolled:/.test(autoOpenLast)) {
      return base + '评论区已经打开，扩展已经把评论列表滚到底、试着让页面再发一次评论请求。' + signHint();
    }
    // 作品列表（精选页网格、个人主页的作品网格）是**故意**不点的：卡片上的评论图标
    // 会把用户带到另一条视频去
    if (autoOpenLast === 'no-target:grid') {
      return '还没拿到签名：这个页面是作品列表（精选页、个人主页的作品网格都是这种），'
        + '扩展没有替你点卡片（避免把你带到别的视频上去）。' + signHint();
    }
    if (/^no-target:/.test(autoOpenLast)) return '还没拿到签名：没能自动找到评论入口。' + signHint();
    if (/^clicked:/.test(autoOpenLast)) {
      return base + '扩展已替你点开评论区（没反应会再试两次，全是合成点击）。' + signHint();
    }
    return base + signHint();
  }

  /**
   * 「开始等新签名」的唯一入口（v0.1.11）。顺序很重要：
   *   ① 先置好 needSign + waiting-sign 阶段——必须**早于**合成点击，
   *      否则页面几毫秒后发回的签名会被漏掉（收到 signed 时阶段还不是 waiting-sign
   *      就不会自动接上，于是白等一轮）；
   *   ② 再自动打开评论区（合成点击，最多 AUTO_OPEN_MAX 次）；
   *   ③ 最后把「扩展到底做了什么」如实写进 note。
   * asError=true 时解释走红字那一行（沿用旧行为的场景）。
   */
  function waitForNewSignature(why, lead, asError) {
    needSign = true;
    resetAutoOpen();
    var interim = lead + '正在自动打开评论区……';
    setPhase('waiting-sign', asError ? interim : '', asError ? '' : interim);
    autoOpenComments(why);
    if (phase !== 'waiting-sign') return;   // 页面已经把签名发回来了，自动接上
    var fin = lead + waitingSignNote();
    setPhase('waiting-sign', asError ? fin : '', asError ? '' : fin);
  }

  // 最近一次「因页面切换而被作废」的签名所属视频。只用于向用户解释为什么在等待，
  // 不参与识别判断（识别判断里它必须是被清掉的那个值）。
  var lastDroppedSigId = null;

  function onPageChanged() {
    var k = pageKey();
    if (k === lastPageKey) return false;
    lastPageKey = k;
    // 换页了：DOM 里那个「开着的评论面板」可能是上一个视频留下的（SPA 不会立刻清掉，
    // 实测残留面板 0x0/hidden、但里面还有上一个视频的 comment-item）。把它标成不可信，
    // 本轮第一次要签名时即便「看着是开的」也要点一下入口。
    panelStateSuspect = true;
    var pageId = pageViewId();
    var sigId = signedVideoId();
    // 只有**能证明**签名属于别的视频时才作废。
    // 页面拿不到 ID（例如刚关掉浮层、网格还没渲染出中心卡片）时不作废：
    // 那时无法判断用户是不是还在看同一个视频，乱清只会让采集中途白停一次。
    if (sigId && pageId && sigId !== pageId) {
      lastDroppedSigId = sigId;
      awemeIdFromSigned = null;
      signedAt = 0;
    }
    return true;
  }

  /** 签名 URL 里的 aweme_id —— 重放**实际会抓**的就是这个视频，是落库标签的数据真值 */
  function signedVideoId() {
    return (awemeIdFromSigned && /^\d{15,25}$/.test(awemeIdFromSigned)) ? awemeIdFromSigned : null;
  }

  /** 上行（主世界 → 隔离世界由 hook 发；这里是隔离世界 → 主世界） */
  function down(type, payload) {
    try {
      window.postMessage({ __dts_collector: MAGIC, dir: 'down', type: type, payload: payload || {} }, '*');
    } catch (e) { /* 忽略 */ }
  }

  // ================== PROTOCOL §3.1 注入 hook ==================
  try {
    var s = document.createElement('script');
    s.src = chrome.runtime.getURL('hook.js');
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
    s.onload = function () { s.remove(); };
  } catch (e) {
    errText = '注入 hook.js 失败：' + String(e);
  }

  // ================== PROTOCOL §3.4 字段裁剪 ==================

  function pick(src, keys) {
    var out = {};
    if (!src || typeof src !== 'object') return out;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (src[k] !== undefined) out[k] = src[k];
    }
    return out;
  }

  /** 原始 user 有 65 个字段，不裁剪会让存储膨胀数倍 */
  function trimComment(c) {
    if (!c || typeof c !== 'object') return null;
    if (!c.cid) return null;
    var out = pick(c, COMMENT_FIELDS);
    out.user = pick(c.user, USER_FIELDS);
    return out;
  }

  /**
   * 去重 + 裁剪，返回本轮新增的评论（协议 §3.3 / §3.4）。
   *
   * @param items    原始评论数组
   * @param parentCid 非空表示这些是某个顶层评论的**二级回复**（协议 §3.8）：
   *                  会打上 is_reply / parent_cid 两个标记；顶层评论则顺便把
   *                  reply_comment_total>0 的记进 replyTargets，供第二阶段补采。
   */
  function accept(items, parentCid) {
    var fresh = [];
    if (!items || !items.length) return fresh;
    for (var i = 0; i < items.length; i++) {
      var raw = items[i];
      if (!raw || typeof raw !== 'object' || raw.__oversize) continue;
      var cid = raw.cid;
      if (cid === undefined || cid === null || cid === '') continue;
      var key = String(cid);
      if (seen.has(key)) continue;
      seen.add(key);
      var t = trimComment(raw);
      if (!t) continue;
      if (parentCid) {
        t.is_reply = true;
        t.parent_cid = String(parentCid);
      } else {
        var rct = Number(t.reply_comment_total);
        if (rct > 0) replyTargets.set(key, rct);   // 待补采的线程
      }
      fresh.push(t);
    }
    return fresh;
  }

  // ================== 上报 background（协议 §3.4） ==================

  /** 扩展被「重新加载 / 卸载」后，页面里旧 content script 的 chrome.runtime 会失效。
   *  典型文案：Extension context invalidated。此时**无法**再 sendMessage，只能提示刷新页面。 */
  function isExtContextInvalid(e) {
    var s = e && (e.message || String(e));
    if (!s) return false;
    return /Extension context invalidated|Extension context|Receiving end does not exist/i.test(s);
  }

  var extContextLost = false;

  function onExtContextLost(raw) {
    if (extContextLost) return;
    extContextLost = true;
    stopFlag = true;
    needSign = false;
    running = false;
    errText = '扩展上下文已失效（Extension context invalidated）。'
      + '通常是刚在 chrome://extensions 里「重新加载」了本扩展。'
      + '请 **F5 刷新本抖音页** 后再点「开始采集」。'
      + (raw ? '（' + raw + '）' : '');
    noteText = '本页旧脚本已作废；刷新后扩展会重新注入。';
    setPhase('error', errText, noteText);
  }

  async function pushComments(fresh, hasMore) {
    if (!fresh || !fresh.length) return;
    for (var i = 0; i < fresh.length; i++) pendingItems.push(fresh[i]);
    // 每累计 ≥50 条提前发一次，避免攒太大
    if (pendingItems.length >= 50) await flushComments(hasMore);
  }

  async function flushComments(hasMore) {
    if (!pendingItems.length) return;
    if (extContextLost) return;
    var comments = pendingItems;
    pendingItems = [];
    try {
      var resp = await chrome.runtime.sendMessage({
        type: 'dts-comments',
        videoId: videoId,
        title: currentTitle(),
        total: total,
        hasMore: hasMore,
        signedUrlAt: signedAt ? new Date(signedAt).toISOString() : null,
        comments: comments
      });
      if (resp && resp.ok) {
        savedCount = resp.count;
      } else if (resp && resp.error) {
        errText = '落库失败：' + resp.error;
      }
    } catch (e) {
      if (isExtContextInvalid(e)) {
        onExtContextLost(String(e && e.message || e));
        return;
      }
      errText = '上报 background 失败：' + String(e);
    }
    render();
  }

  // ================== 重放调用（协议 §1 下行 / §2.4 上行） ==================

  function requestReplay(cur, cnt) {
    var key = Number(cur);
    // 同一个 cursor 重复在飞：不该发生（循环按 cursor 推进），按失败收尾避免永久挂起
    if (pendingReplay.has(key)) {
      var dup = pendingReplay.get(key);
      clearTimeout(dup.timer);
      pendingReplay.delete(key);
      dup.resolve({ ok: false, cursor: key, error: 'REPLAY_DUPLICATE', items: [] });
    }
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        var e = pendingReplay.get(key);
        if (e && e.timer === timer) {
          pendingReplay.delete(key);
          resolve({
            ok: false, cursor: cur, status: null, got: 0, next: null,
            total: null, hasMore: null, ms: 0, items: [], error: 'REPLAY_TIMEOUT'
          });
        }
      }, REPLAY_TIMEOUT_MS);
      pendingReplay.set(key, { cursor: key, timer: timer, resolve: resolve });
      down('replay', { cursor: key, count: cnt });
    });
  }

  function onReplayResult(p) {
    // 按 cursor 精确匹配：并发多路时每个回包各归各家，不会串台
    var key = Number(p.cursor);
    var pr = pendingReplay.get(key);
    if (!pr) return;
    pendingReplay.delete(key);
    clearTimeout(pr.timer);
    pr.resolve(p);
  }

  /** 收尾：把所有在飞的请求按失败放掉（暂停/停止/切视频时用） */
  function drainReplay(error) {
    pendingReplay.forEach(function (pr) {
      clearTimeout(pr.timer);
      pr.resolve({ ok: false, cursor: pr.cursor, error: error, items: [] });
    });
    pendingReplay.clear();
    // 二级回复的在飞请求同样要放掉，否则暂停会挂住
    pendingReplies.forEach(function (pr) {
      clearTimeout(pr.timer);
      pr.resolve({ ok: false, parentCid: pr.parentCid, cursor: pr.cursor, error: error, items: [] });
    });
    pendingReplies.clear();
  }

  // ================== 二级回复重放（协议 §3.8，v0.1.5） ==================

  /** 请求主世界用同一份签名拉某个顶层评论的一页回复 */
  function requestReplyReplay(parentCid, cur, cnt) {
    var key = String(parentCid) + '|' + Number(cur);
    if (pendingReplies.has(key)) {
      var dup = pendingReplies.get(key);
      clearTimeout(dup.timer);
      pendingReplies.delete(key);
      dup.resolve({ ok: false, parentCid: parentCid, cursor: Number(cur), error: 'REPLY_DUPLICATE', items: [] });
    }
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        var e = pendingReplies.get(key);
        if (e && e.timer === timer) {
          pendingReplies.delete(key);
          resolve({
            ok: false, parentCid: parentCid, cursor: Number(cur), status: null, got: 0,
            next: null, total: null, hasMore: null, ms: 0, items: [], error: 'REPLY_TIMEOUT'
          });
        }
      }, REPLAY_TIMEOUT_MS);
      pendingReplies.set(key, { parentCid: String(parentCid), cursor: Number(cur), timer: timer, resolve: resolve });
      down('replay-reply', { parentCid: String(parentCid), cursor: Number(cur), count: cnt });
    });
  }

  function onReplyResult(p) {
    var key = String(p.parentCid) + '|' + Number(p.cursor);
    var pr = pendingReplies.get(key);
    if (!pr) return;
    pendingReplies.delete(key);
    clearTimeout(pr.timer);
    pr.resolve(p);
  }

  // 多路共用同一次签名探测（requestReplay 按 cursor 去重，并发探同一 cursor 会互相踩）
  var probeInFlight = null;

  /**
   * 签名是不是「真的没了」（协议 §3.8）。
   * 只有这几种才算：压根没签名、签名串坏了、鉴权被拒（401/403）、传输层失败。
   * **服务端限流形态（STATUS_5 / STATUS_NULL / EMPTY_BODY）一律不算死**——
   * 那恰恰是最常见的情况（probe-replyburst 实测连列表接口都会回 STATUS_5），
   * 判成死就会去要求用户滚动，正是用户最反感的行为。
   */
  function sigLooksDead(p) {
    if (!p) return true;
    var e = String(p.error || '');
    if (e === 'NO_SIGNED_URL') return true;
    if (/^BAD_SIGNED_URL/.test(e)) return true;
    if (p.status === 401 || p.status === 403) return true;
    if (/Failed to fetch|NetworkError|AbortError|timeout|Load failed/i.test(e)) return true;
    return false;
  }

  /**
   * 用「列表接口」探签名死活（协议 §3.8）。
   * 回复接口回空 body 时签名往往还活着；列表接口通不通才是判据。
   * 越过列表末端时服务端回字面量 null（STATUS_NULL）——那也是「签名被接受」，同样算活着。
   */
  function sigAliveProbe() {
    if (probeInFlight) return probeInFlight;
    probeInFlight = (async function () {
      try {
        var p = await requestReplay(0, 20);
        replyPages++;
        return !sigLooksDead(p);
      } finally {
        probeInFlight = null;
      }
    })();
    return probeInFlight;
  }

  /**
   * 回复请求被拒后的恢复（协议 §3.8）。
   * 返回 { r }（拿到成功响应）| { needSign: true }（签名真的没了）| { givingUp: true }。
   * 限流（EMPTY_BODY / STATUS_NULL / STATUS_5）**只等 10 秒**（REPLY_THROTTLE_MAX_WAIT_MS），
   * 到点就 { givingUp, throttled } 收尾 —— 绝不无限等待、绝不要求用户滚动。
   */
  async function recoverReply(parentCid, cur, firstErr) {
    var err = firstErr;
    var k = 0;   // 退避指数：跨轮累计，到 REPLY_BACKOFF_MAX_MS 后保持
    // 预算是墙钟：退避睡眠本身也算在内，否则「10 秒上限」会被重试循环放大成几十秒。
    if (!replyThrottleStartAt) replyThrottleStartAt = Date.now();
    // 本 lane 自己的起点：4 条 lane 并发时，任意一条成功都会把全局起点清零，
    // 另一条若还在冷却里、拿全局值做减法就会算出「已等待 17 亿秒」（实测踩到过）。
    var throttleStart = replyThrottleStartAt;
    // 立刻把状态告诉用户：这是「接口正在限流、我自己在短退避重试」，不需要任何操作
    setPhase('replies', '回复接口正在限流（' + err + '），自动退避重试中，最多试 '
      + Math.round(REPLY_THROTTLE_MAX_WAIT_MS / 1000) + ' 秒（无需你操作）…');

    while (!stopFlag) {
      if (replyPages >= REPLY_MAX_REQUESTS) return { givingUp: true, error: '达到请求上限' };

      // 短退避重试：一直重试到连续失败累计 REPLY_FAIL_STREAK_STOP 次
      while (replyFailStreak < REPLY_FAIL_STREAK_STOP && !stopFlag) {
        if (replyPages >= REPLY_MAX_REQUESTS) return { givingUp: true, error: '达到请求上限' };
        // 预算检查必须在内层也做：否则要等退避跑完、冷却结束才判上限，会超出 10 秒一大截
        if (Date.now() - throttleStart >= REPLY_THROTTLE_MAX_WAIT_MS) {
          return { givingUp: true, throttled: true, error: '回复接口持续拒绝超过 '
            + Math.round(REPLY_THROTTLE_MAX_WAIT_MS / 1000) + ' 秒' };
        }
        await sleep(Math.min(REPLY_BACKOFF_MAX_MS, REPLY_BACKOFF_BASE_MS * Math.pow(2, k)));
        k++;
        var r = await requestReplyReplay(parentCid, cur, REPLY_COUNT);
        replyPages++;
        if (r && r.ok) { replyThrottleStartAt = 0; replyThrottledMs = 0; return { r: r }; }
        err = (r && r.error) || err;
        if (err === 'NO_SIGNED_URL') return { needSign: true };
        replyFailStreak++;
        replyLastError = err + '（连续 ' + replyFailStreak + ' 次）';
      }
      if (stopFlag) return { givingUp: true, error: 'stopped' };

      // 连续失败到阈值：冷却，然后问列表接口「签名还在吗」
      replyFailStreak = 0;
      k = 0;
      await sleep(REPLY_COOLDOWN_MS);
      replyThrottledMs = Date.now() - throttleStart;   // 墙钟：含退避重试花掉的时间（用本 lane 的起点）

      if (!(await sigAliveProbe())) {
        replyLastError = err + '（列表接口也失败，签名确实不可用了）';
        return { needSign: true };
      }
      replyLastError = err + '（列表接口仍正常，判定为回复接口临时拒绝）';
      // 先判预算再报状态：否则刚说完「还在重试」下一行就收尾了
      if (replyThrottledMs >= REPLY_THROTTLE_MAX_WAIT_MS) {
        return { givingUp: true, throttled: true, error: '回复接口持续拒绝超过 '
          + Math.round(REPLY_THROTTLE_MAX_WAIT_MS / 1000) + ' 秒' };
      }
      setPhase('replies', '回复接口正在限流（' + err + '），已退避重试 '
        + Math.round(replyThrottledMs / 1000) + ' 秒（最多试 '
        + Math.round(REPLY_THROTTLE_MAX_WAIT_MS / 1000) + ' 秒，不成先收尾）…');
    }
    return { givingUp: true, error: 'stopped' };
  }

  /**
   * 把一个顶层评论下的回复全部翻页拉完（协议 §3.8）。
   * 返回 { got, needSign?, failed?, stop? } —— 不抛异常，交给调用方决策。
   */
  async function fetchThread(parentCid) {
    var cur = 0, guard = 0, got = 0;
    while (!stopFlag) {
      if (replyPages >= REPLY_MAX_REQUESTS) return { got: got, stop: true };
      if (guard++ >= REPLY_MAX_PAGES_PER_THREAD) break;
      var r = await requestReplyReplay(parentCid, cur, REPLY_COUNT);
      replyPages++;

      if (!r || !r.ok) {
        var err = (r && r.error) || 'unknown';
        if (err === 'NO_SIGNED_URL') return { got: got, needSign: true };
        replyFailStreak++;
        replyLastError = err + '（连续 ' + replyFailStreak + ' 次）';
        var out = await recoverReply(parentCid, cur, err);
        if (out.needSign) return { got: got, needSign: true };
        if (out.givingUp) {
          return { got: got, failed: true, throttled: !!out.throttled, error: out.error };
        }
        r = out.r;
      }

      replyFailStreak = 0;
      replyLastError = '';
      var fresh = accept(r.items || [], parentCid);
      repliesCollected += fresh.length;
      got += fresh.length;
      await pushComments(fresh, 1);
      if (!Number(r.hasMore)) break;
      var next = Number(r.next);
      if (!Number.isFinite(next) || next <= cur) break;
      cur = next;
      await sleep(REPLY_GAP_MS);
    }
    return { got: got };
  }

  /**
   * 第二阶段：补采所有带回复的顶层评论（协议 §3.8）。
   * 简单 worker 池：REPLY_LANES 个 worker 从同一个 todo 队列里取线程。
   * 尊重 stopFlag（暂停按钮）与签名失效（转为 waiting-sign 等新签名）。
   */
  async function collectReplies() {
    var todo = [];
    replyTargets.forEach(function (n, cid) {
      if (!replyDoneSet.has(cid)) todo.push(cid);
    });
    if (!todo.length) return;

    setPhase('replies', '', '顶层评论已采完，开始补采二级回复：共 ' + todo.length + ' 个线程……');
    // 主扫描刚把列表接口轰完，紧接着打回复接口会被服务端用字面量 null 拒掉一批；
    // 先停一下让配额回血，能明显削掉进入补采时的失败尖峰（实测 probe-replyfail）。
    await sleep(REPLY_WARMUP_MS);
    if (stopFlag) return;
    var needSignStop = false, hardStop = false, throttledStop = false;
    replyThrottledMs = 0;   // 每次进入补采重算「静默等待」预算
    replyThrottleStartAt = 0;
    replyStoppedByThrottle = false;

    /** 跑一轮：REPLY_LANES 个 worker 从同一队列取线程；返回本轮失败的 cid */
    async function runRound(list, label) {
      var idx = 0, failed = [];
      async function worker() {
        while (!stopFlag && !needSignStop && !hardStop && !throttledStop) {
          // 补采可能跑很久（线程多），签名过期检查必须在这里也做一遍，
          // 否则会用死签名一直失败下去
          if (!signedAt || Date.now() - signedAt > SIGN_STALE_MS) { needSignStop = true; return; }
          if (replyPages >= REPLY_MAX_REQUESTS) { hardStop = true; return; }
          var my = idx++;
          if (my >= list.length) return;
          var cid = list[my];
          if (replyDoneSet.has(cid)) continue;
          var r = await fetchThread(cid);
          if (r.needSign) { needSignStop = true; return; }
          if (r.throttled) { throttledStop = true; return; }
          if (r.stop) { hardStop = true; return; }
          if (r.failed) failed.push(cid); else replyDoneSet.add(cid);
          noteText = label + ' ' + replyDoneSet.size + '/' + replyTargets.size + ' 个线程，已得 '
            + repliesCollected + ' 条（请求 ' + replyPages + ' 次'
            + (failed.length ? '，本轮失败 ' + failed.length : '') + '）';
          render();
        }
      }
      var ws = [];
      var lanes = Math.min(REPLY_LANES, list.length);
      for (var i = 0; i < lanes; i++) ws.push(worker());
      await Promise.all(ws);
      return failed;
    }

    var failed = await runRound(todo, '补采二级回复');

    // 失败线程退避后重试一轮 —— 实测第一轮会有零星失败（超时/限流），
    // 不重试就直接丢掉会明显压低覆盖率。
    if (failed.length && !needSignStop && !throttledStop && !stopFlag) {
      noteText = '第一轮有 ' + failed.length + ' 个线程失败，退避 2.5s 后重试……';
      render();
      await sleep(2500);
      replyFailStreak = 0;
      failed = await runRound(failed, '重试失败线程');
    }

    await flushComments(0);
    replyFailCount = failed.length;
    if (throttledStop) replyStoppedByThrottle = true;

    if (needSignStop) {
      resumeReplies = true;   // 拿到新签名后直接回补采，不再重扫顶层（省时间，也少轰一次列表接口）
      // 补采途中签名失效：扩展自己点开评论区去要新签名
      waitForNewSignature('need-sign-midway',
        '签名不可用（' + (replyLastError || '列表与回复接口都失败') + '），已暂停等新签名：');
      noteText += '拿到新签名后会自动从这里继续，已采到的 ' + repliesCollected + ' 条回复不会重复拉。';
      render();
      return;
    }
    if (throttledStop) {
      noteText = '回复接口正在限流，重试 ' + Math.round(replyThrottledMs / 1000)
        + ' 秒仍未成功，本轮补采到此为止（' + replyDoneSet.size + '/' + replyTargets.size
        + ' 个线程，共 ' + repliesCollected + ' 条，请求 ' + replyPages + ' 次）。'
        + '稍后再点「开始采集」会从断点续补采二级回复（不重扫顶层，已采到的不重复拉）';
    } else {
      noteText = '二级回复补采完成：' + replyDoneSet.size + '/' + replyTargets.size
        + ' 个线程，共新增 ' + repliesCollected + ' 条（请求 ' + replyPages + ' 次'
        + (failed.length ? '，仍有 ' + failed.length + ' 个线程没拉全' : '')
        + (hardStop ? '，达到请求上限提前停止' : '') + '）';
    }
    render();
  }

  // ================== 收上行消息（协议 §3.7） ==================
  window.addEventListener('message', function (ev) {
    // 必须校验来源窗口，防止 iframe / 页面脚本伪造
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__dts_collector !== MAGIC || d.dir !== 'up') return;

    var p = d.payload || {};
    switch (d.type) {
      case 'hook-ready':
        hookReady = true;
        break;

      case 'signed':
        signedAt = p.at || Date.now();
        signedKeys = p.keys || [];
        // 多源识别第 3 路：页面自己发的评论请求里带的 aweme_id
        if (p.aweme_id) awemeIdFromSigned = String(p.aweme_id);
        lastDroppedSigId = null;   // 新签名到手，旧的「为何在等待」解释可以撤了
        panelStateSuspect = false; // 页面确实发了评论请求 → 现在这份评论面板状态可信
        // 采集途中页面又发了**别的视频**的评论请求 → 重放目标已变，必须停，
        // 否则接下来的重放会抓新视频的评论、却按旧 videoId 落库
        if (running && p.aweme_id && videoId && String(p.aweme_id) !== videoId) {
          stopFlag = true;
          setPhase('paused', '页面已切到视频 ' + p.aweme_id + '（当前采集的是 ' + videoId
            + '），已停止。请在新视频里重新点「开始采集」');
          down('stop-capture');
          break;
        }
        // 因缺签名/签名过期而等待时，新签名一到就自动继续
        if (phase === 'waiting-sign' || (needSign && !running && phase === 'paused')) {
          // 落库标签要跟着**签名**走：重放用的签名 URL 里内嵌 aweme_id，抓回来的就是它的
          // 评论。在作品网格（我的 / 精选页）上点「开始采集」时页面还没有「当前视频」，
          // 标签只能先落在随便一条卡片上；用户随后点开某条作品、签名到手时若不改标签，
          // 就会「采的是 B 的评论、记在 A 名下」（2026-09-30 run-pages-collect C8/C9 实测：
          // liveVideoId 已是浮层 modal_id，落库标签却还是网格里/上一个页面的 id）。
          if (p.aweme_id) videoId = String(p.aweme_id);
          needSign = false;
          setPhase('collecting');
          startLoop();
        } else {
          if (!running && p.aweme_id) videoId = String(p.aweme_id);
          render();
        }
        break;

      case 'captured':
        // 页面自己的评论响应（重放结果不走这里，见协议 §2.7）
        pushComments(accept(p.items || []), p.hasMore === undefined ? 1 : p.hasMore)
          .catch(function (e) { errText = String(e); render(); });
        break;

      case 'replay-result':
        onReplayResult(p);
        break;

      case 'reply-result':
        // 协议 §3.8：二级回复的重放回包
        onReplyResult(p);
        break;

      default:
        break;
    }
  });

  // ================== 采集主循环（协议 §3.2） ==================

  /**
   * 触底后的结束说明。
   *
   * 旧文案把「采到的比 total 少」一律归因为登录态受限/可刷新重试，
   * 但 2026-09-28 实测（probe-tail.mjs）：视频 7667575725930679579 的列表
   * 在 offset 1500 处真实返回 has_more=0，往后每个 cursor 都是空页，
   * 重试、换 count、换 sort_type 都一样 —— 刷新页面拿不回更多。
   * total 里还包含二级回复与已删除/被过滤的评论，它们本来就不在列表接口里。
   */
  /** 二级回复的收尾说明（协议 §3.8）；没有补采过就返回空串 */
  function replyNote() {
    if (!replyTargets.size) return '';
    var s = '；二级回复已补采 ' + repliesCollected + ' 条（' + replyDoneSet.size
      + '/' + replyTargets.size + ' 个线程，请求 ' + replyPages + ' 次）';
    // 被限流时如实说明，并给出用户唯一的动作：过一会儿再点一次（无需滚动）
    if (replyStoppedByThrottle) {
      s += '。抖音正在限流回复接口（列表接口仍正常），已重试 '
        + Math.max(1, Math.round(replyThrottledMs / 1000)) + ' 秒仍未成功，还剩 '
        + (replyTargets.size - replyDoneSet.size)
        + ' 个线程没拉到 —— 过一会儿再点「开始采集」会**从断点续补采二级回复**'
        + '（不重扫顶层、已采到的不重复拉）';
    }
    return s;
  }

  function endNote() {
    if (floorCursor === null) {
      var s0 = (total > 0 && seen.size < total)
        ? 'has_more=0 结束，已采 ' + seen.size + '/' + total + ' 条'
        : '';
      return s0 + replyNote();
    }
    var s = '服务端列表在 offset ' + floorCursor + ' 触底（has_more=0），共取回 ' + seen.size + ' 条';
    if (total > 0 && seen.size < total) {
      s += '；total=' + total + ' 含二级回复与已删除/被过滤评论，列表接口不再返回';
      if (pass > 1) s += '（已补扫 ' + pass + ' 轮）';
    } else if (total > 0) {
      s += '，已覆盖 total=' + total;
    }
    // 正常触底发生在很深的位置；头两页就没货更像是登录态/风控，那是该重登的
    if (pass === 1 && floorCursor <= COUNT * 2) {
      s += '。触底过早，疑似登录态受限：请重新登录并刷新后重试';
    }
    return s + replyNote();
  }

  /**
   * 把「采集进度」整体归零。
   *
   * ⚠️ 换视频时必须调用：`cursor` 是全局变量，但它语义上是「在**某个视频**的评论列表里
   * 翻到哪儿了」。A 视频暂停在 cursor=1500、切到 B 再继续，若沿用就会拿 offset=1500
   * 去翻 B 的列表 —— **B 的前 1500 条被静默跳过**，面板不报错、导出的 CSV 看着也正常，
   * 只能从数据缺口倒推（2026-09-30 发现）。
   *
   * 为什么不能只在 onStartClick 里重置：「暂停在 A → 切到 B → 点开始采集」这条路径会在
   * onStartClick 的 sig-dropped 分支**提前 return**（要先去等 B 的新签名），之后的
   * startLoop 是 `case 'signed'` 直接调起的，完全绕过 onStartClick ⇒ 所以 startLoop
   * 入口还要再兜一次（它是唯一消费这些状态的地方）。
   *
   * @param clearSeen true = 连去重集合与补采进度一起清（**换视频时必须**）；
   *                  false = 保留（同一视频再点一次「开始采集」= 手动补扫，既有行为）。
   */
  function resetProgress(clearSeen) {
    cursor = 0;
    pages = 0;
    failStreak = 0;
    pass = 1;
    passNew = 0;
    floorCursor = null;
    // total 也必须归零：循环里取的是**历史最大值**，不归零就会一直卡在上一个视频的
    // 大数字上，进度条失真，还会让 willRescan 反复判真、白跑几轮补扫。
    total = 0;
    if (clearSeen) {
      // seen / replyTargets / replyDoneSet 全是**上一个视频**的状态。尤其 replyTargets：
      // 留着它，补采阶段会拿 B 的签名去拉 A 的评论线程（comment_id 是 A 的、item_id 是
      // B 的），请求必然失败或返回不相干数据。background 侧按 cid 去重，重采不会产生
      // 重复行，所以清掉是安全的。
      seen.clear();
      replyTargets.clear();
      replyDoneSet.clear();
      savedCount = 0;
    }
    cursorVideoId = videoId;
    resumeReplies = false;   // 重新起一轮：走完整流程（顶层重扫 → 补采），不跳步
    replyLastError = '';
    replyThrottledMs = 0;
    replyThrottleStartAt = 0;
    replyStoppedByThrottle = false;
  }

  async function startLoop() {
    if (running) return;
    var epoch = collectEpoch;
    running = true;
    stopFlag = false;
    down('start-capture');

    try {
      if (epoch !== collectEpoch) return;

      // 入口兜底：进度不属于当前视频就整体重置。
      // 这条路径覆盖 `case 'signed'` 直接调起 startLoop 的场景（见 resetProgress 注释），
      // 那种情况下 onStartClick 已经提前 return，重置代码根本没跑到。
      if (cursorVideoId !== null && cursorVideoId !== videoId) resetProgress(true);

      // 清空后：seen/cursor 会被旧循环污染时的强制重置（协议外，修清空后“续采”bug）
      if (justCleared) {
        resetProgress(true);
        justCleared = false;
      }

      // 补采中途因签名失效停下、现在又拿到新签名了 → 直接回补采，不重扫顶层。
      // 顶层已由 replyDoneSet/replyTargets 去重，重扫既费时又白轰一次列表接口
      // （实测：重扫要 ~18s，而且刚轰完列表接口正是回复请求被拒的高发期）。
      if (resumeReplies && replyTargets.size > replyDoneSet.size) {
        resumeReplies = false;
        await collectReplies();
        if (epoch !== collectEpoch) return;
        if (!stopFlag && phase !== 'waiting-sign' && phase !== 'paused') {
          setPhase('done', '', endNote());
        }
        return;
      }

      while (!stopFlag && epoch === collectEpoch) {
        if (phase !== 'collecting') break;

        // SPA 切视频保护：切走后 cursor/videoId 全部失效。
        // 这里用 pageViewId()（只看 URL/DOM，不看签名缓存）——若用 extractVideoId()，
        // 签名缓存会把旧 ID 镜像回来，导致「明明切走了却判定没切」。
        // 注意只在「明确识别到另一个 ID」时才停 —— 推荐页/浮层关闭等场景下识别结果可能是
        // null，那是「暂时识别不到」而不是「切走了」，此时硬停会把推荐页采集直接掐死。
        var nowId = pageViewId();
        if (nowId && nowId !== videoId) {
          setPhase('paused', '页面已切换到别的视频（' + nowId + '），请重新点「开始采集」');
          break;
        }

        // 签名新鲜度检查
        if (!signedAt || Date.now() - signedAt > SIGN_STALE_MS) {
          // 采集中签名过期：扩展自己点开评论区去要新签名，不再要求用户滚动
          waitForNewSignature('stale-midway', '签名已超过 8 分钟未刷新，已暂停等待新签名：', true);
          break;
        }

        if (pages >= MAX_PAGES) {
          setPhase('done', '', '达到页数硬上限 ' + MAX_PAGES + ' 已停止（防御死循环）');
          break;
        }

        // ---- 一轮：并发 N 路（MAX_LANES），每路一个 cursor ----
        var lanes = Math.min(MAX_LANES, MAX_PAGES - pages);
        if (lanes < 1) lanes = 1;
        var cursors = [];
        var i;
        for (i = 0; i < lanes; i++) cursors.push(cursor + i * COUNT);
        var reqs = await Promise.all(cursors.map(function (cur) {
          return requestReplay(cur, COUNT);
        }));
        // 清空/换代发生在请求在途时：丢弃回包，禁止把 cursor 写回高位
        if (stopFlag || epoch !== collectEpoch) break;

        // 服务端对「越过列表末端」的 cursor 会回 HTTP 200 + 字面量 null（实测 probe-replystale：
        // 某视频 floor=1500，cursor<=1500 的 31 个请求全成功，1550~7450 的 119 个全部返回 null）。
        // 这不是失败，而是「到底了」——必须归一成空页，否则每次越过末端都推高 failStreak，
        // 3 次就把「触底」误判成「签名失效」，去要求用户手动滚评论区。
        for (i = 0; i < reqs.length; i++) {
          var z = reqs[i];
          if (z && !z.ok && z.error === 'STATUS_NULL') {
            z.ok = true; z.items = []; z.got = 0; z.hasMore = 0; z.next = null;
            z.status = 0; z.endOfList = true;
          }
        }

        // 先校验「每路都拿满一页」，再决定要不要接受这一轮
        var laneShort = false;
        var laneEnd = false;
        for (i = 0; i < reqs.length; i++) {
          var rr = reqs[i];
          if (!rr.ok) continue;
          var ni = (rr.items || []).length;
          if (ni > 0 && ni < MIN_LANE_ITEMS) laneShort = true;
          if (Number(rr.hasMore) === 0 && ni < COUNT) {
            // 只认「拿不满一页」的 has_more=0：满页却带 0 是矛盾信号，不当终点也不当触底位置。
            // 真触底那页一定拿不满 COUNT；代价只是多跑一轮（越界的路会返回空页）。
            var laneCur = (typeof rr.cursor === 'number' && isFinite(rr.cursor)) ? rr.cursor : cursors[i];
            if (floorCursor === null || laneCur < floorCursor) floorCursor = laneCur;
            laneEnd = true;
          }
        }

        var anyOk = false;
        var maxNext = cursor;
        var freshAll = [];
        for (i = 0; i < reqs.length; i++) {
          var q = reqs[i];
          pages++;
          if (q.ms > lastMs) lastMs = q.ms || 0;
          if (!q.ok) {
            failStreak++;
            setPhase('collecting', '第 ' + pages + ' 路失败：' + (q.error || ('status=' + q.status)) +
              '（连续 ' + failStreak + '/' + FAIL_STREAK_PAUSE + '）');
            if (failStreak >= FAIL_STREAK_PAUSE) {
              needSign = true;
              setPhase('paused', '连续失败 ' + failStreak + ' 次，已暂停：' + (q.error || ('status=' + q.status)) +
                ' —— 请刷新页面后重试。');
              break;
            }
            continue;
          }
          anyOk = true;
          // 服务端 total 是有噪声的：同一轮里不同页会分别回 3170 / 50 / 12（实测见
          // probe-tail.mjs），尾页甚至回 0。取历史最大值，绝不让尾页的小数字覆盖权威值。
          if (typeof q.total === 'number' && q.total > total) total = q.total;
          if (typeof q.next === 'number' && isFinite(q.next) && q.next > maxNext) maxNext = q.next;
          freshAll = freshAll.concat(accept(q.items || []));
        }

        // 失败后退出本轮：未完成的那一路下轮按同一个 cursor 重发
        if (!anyOk) {
          if (failStreak >= FAIL_STREAK_PAUSE) break;
          await sleep(backoffMs(failStreak));
          continue;
        }

        failStreak = 0;
        passNew += freshAll.length;
        // 触底 ≠ 采全：热榜区每轮会重排，从头重扫一遍还能捞到新的（去重累加）。
        // 上一轮新增还有这么多 → 值得再扫；否则停手，别白跑。
        var willRescan = laneEnd && total > 0 && seen.size < total &&
          pass < MAX_PASSES && passNew >= RESCAN_MIN_NEW;
        await pushComments(freshAll, (laneEnd && !willRescan) ? 0 : 1);
        await flushComments((laneEnd && !willRescan) ? 0 : 1);

        // 终点判据：某一路拿不满一页且 has_more=0（服务端列表物理触底）
        if (laneEnd) {
          if (willRescan) {
            pass++;
            passNew = 0;
            cursor = 0;
            noteText = '服务端列表已触底，开始第 ' + pass + ' 轮补扫（从头再扫，去重累加）……';
            render();
            await sleep(MIN_INTERVAL_MS + Math.random() * JITTER_MS);
            continue;
          }
          // 顶层列表采完 → 若还有「带回复但没拉过」的线程，进入第二阶段补采（协议 §3.8）
          if (replyTargets.size > replyDoneSet.size && !stopFlag) {
            await collectReplies();
            if (stopFlag) break;
            // collectReplies 可能因签名失效把自己置成 waiting-sign / paused ——
            // 不能再用 done 覆盖它，否则用户看到「已完成」却其实没采完（实测踩到过）
            if (phase === 'waiting-sign' || phase === 'paused') break;
          }
          setPhase('done', '', endNote());
          break;
        }

        // 触底保护：某一路返回的条数明显少于 COUNT → 服务端已到列表末尾，
        // 下轮退回单路，避免越过末尾白跑并产生空洞
        if (laneShort) {
          cursor = maxNext;
          render();
          await sleep(MIN_INTERVAL_MS + Math.random() * JITTER_MS);
          continue;
        }

        // 登录态降级：服务端把单页条数压到 5 且才采了很少页
        if (freshAll.length > 0 && freshAll.length <= 5 && pages <= 2) {
          setPhase('paused', '疑似登录态失效：服务端把单页条数降到 ' + freshAll.length +
            ' 条（正常应 ~' + COUNT + ' 条）。请重新登录并刷新页面后再试');
          break;
        }

        // cursor 必须由服务端给的 next 推进（协议 §3.2）
        if (epoch !== collectEpoch) break;
        if (maxNext <= cursor) {
          failStreak++;
          setPhase('collecting', 'cursor 未推进（maxNext=' + maxNext + '，当前=' + cursor + '），连续 ' +
            failStreak + '/' + FAIL_STREAK_PAUSE);
          if (failStreak >= FAIL_STREAK_PAUSE) {
            needSign = true;
            setPhase('paused', 'cursor 连续 ' + failStreak + ' 次未推进，已暂停。请刷新页面后重试');
            break;
          }
          await sleep(backoffMs(failStreak));
          continue;
        }
        cursor = maxNext;
        render();

        // 每轮之间限速 + 抖动（协议 §3.2）；多路模式下用更短的轮间隔
        await sleep(lanes > 1
          ? LANE_GAP_MS + Math.random() * 60
          : MIN_INTERVAL_MS + Math.random() * JITTER_MS);
      }
    } catch (e) {
      // 循环本身出意外也要把状态落到面板上，不能变成未捕获的 Promise 拒绝
      setPhase('error', '采集循环异常：' + String(e));
    } finally {
      running = false;
      if (epoch === collectEpoch) drainReplay('REPLAY_DRAINED');
      down('stop-capture');
      render();
    }
  }

  // ================== 按钮行为 ==================

  async function onStartClick() {
    if (!hookReady) {
      var ok = await waitForHook(HOOK_WAIT_MS);
      if (!ok) {
        setPhase('error', 'hook.js 未能在页面主世界注入成功（扩展可能刚被重载，请刷新页面）');
        return;
      }
    }

    // 页面换过就先清掉上一个视频的签名/aweme_id 缓存（防「回到上一个视频」）
    onPageChanged();

    var pageId = pageViewId();
    // 页面刚切过来（或真推荐页被服务端弹回后重渲染）时 DOM 里可能还没有 id：
    // 先等一等再判，否则会一上来就报「未识别到视频 ID」（2026-09-29
    // run-recommend-collect R3 实测：phase 直接变 error，而几百毫秒后 DOM 里就有 id）。
    for (var wt = 0; wt < 6 && !pageId; wt++) {
      await sleep(500);
      pageId = pageViewId();
    }
    var sigId = signedVideoId();

    // 签名与本页不一致 = 重放会去抓别的视频的评论。宁可停下等新签名，也不能
    // 把 A 的评论记到 B 名下（用户实测踩到的就是这个）。
    if (sigId && pageId && sigId !== pageId) {
      lastDroppedSigId = sigId;
      videoId = pageId;
      awemeIdFromSigned = null;
      signedAt = 0;
      // 扩展自己点开当前视频的评论区去要新签名（合成点击，最多 3 次）
      waitForNewSignature('sig-mismatch', '签名属于视频 ' + sigId + '，而当前打开的是 ' + pageId
        + '。为避免把评论记到别的视频名下，');
      return;
    }

    // 上一个视频的签名刚被 onPageChanged() 作废 → 说清原因，别让用户以为是卡住了
    if (!sigId && lastDroppedSigId && pageId && pageId !== lastDroppedSigId) {
      videoId = pageId;
      waitForNewSignature('sig-dropped', '刚切换了视频：上一个视频（' + lastDroppedSigId
        + '）的签名已作废。当前打开的是 ' + pageId + '，');
      return;
    }

    // 落库标签取「重放实际会抓的那个视频」（签名里的 aweme_id），保证标签与数据同源
    videoId = sigId || pageId;
    if (!videoId) {
      setPhase('error', '未识别到视频 ID。请先打开一条具体视频（点开一条作品，'
        + '或进视频详情页 / 全屏刷视频的页面）后，再点「开始采集」。');
      return;
    }

    errText = '';
    // 清空后：无论 phase 是 idle/paused/done，都必须整体重置从 cursor=0 重扫。
    // 否则旧循环可能已把 cursor 写回高位，storage 却是空的 → 半路续采、前段丢失。
    if (justCleared) {
      resetProgress(true);
      justCleared = false;
      noteText = '已清空，从头重新采集（cursor=0）';
    } else if (phase === 'paused' && cursor > 0 && cursorVideoId === videoId) {
      // 暂停后继续：沿用 cursor 与已去重集合，不重复上报已有评论
      noteText = '从 cursor=' + cursor + ' 继续';
    } else if (
      phase === 'done' &&
      cursorVideoId === videoId &&
      replyTargets.size > replyDoneSet.size
    ) {
      // 限流/补采收尾时 phase 是 **done**（不是 paused）。面板写的是「接着补」，
      // 若走 else 的 resetProgress(false) 会把 cursor 归零 → startLoop 从头重扫顶层
      // （seen 去重所以落库不重复，但会白轰一遍列表接口、看起来像「从头开始」）。
      // 同视频且还有未拉完的回复线程时：直接 resumeReplies，跳过顶层重扫。
      resumeReplies = true;
      noteText = '从断点继续补采二级回复（不重扫顶层，已采到的不重复拉）…';
    } else {
      // 换视频 → 整体重置（连去重集合一起清）；同一视频重来 → 保留 seen = 手动补扫
      resetProgress(cursorVideoId !== videoId);
      noteText = '';
    }

    if (!signedAt || Date.now() - signedAt > SIGN_STALE_MS) {
      // 没有可用签名：扩展自己点开评论区，让页面发出带 a_bogus 的请求
      waitForNewSignature('no-sig', '');
      return;
    }

    needSign = false;
    setPhase('collecting');
    startLoop();
  }

  function onPauseClick() {
    stopFlag = true;
    needSign = false;
    setPhase('paused', '', '已手动暂停，再点「开始采集」可从当前 cursor 继续');
    down('stop-capture');
  }

  function onClearClick() {
    // 先作废在途采集：否则旧 startLoop 回包会把 cursor 写回高位，
    // storage 已清空、再点「开始采集」就变成「从半路续采 + 前段丢失」。
    collectEpoch++;
    justCleared = true;
    stopFlag = true;
    needSign = false;
    seen.clear();
    pendingItems = [];
    cursor = 0;
    pages = 0;
    total = 0;
    savedCount = 0;
    failStreak = 0;
    pass = 1;
    passNew = 0;
    floorCursor = null;
    // 二级回复的进度也一起清掉（协议 §3.8）
    replyTargets.clear();
    replyDoneSet.clear();
    replyPages = 0;
    repliesCollected = 0;
    replyFailStreak = 0;
    replyFailCount = 0;
    replyLastError = '';
    replyThrottledMs = 0;
    replyThrottleStartAt = 0;
    replyStoppedByThrottle = false;
    resumeReplies = false;
    errText = '';
    if (extContextLost) {
      onExtContextLost('');
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: 'dts-clear', videoId: videoId || '' }, function () {
        // 忽略回包；清空是幂等的。若 context 失效，lastError 由 onExtContextLost 统一提示
        if (chrome.runtime.lastError && isExtContextInvalid(chrome.runtime.lastError.message)) {
          onExtContextLost(chrome.runtime.lastError.message);
        }
      });
    } catch (e) {
      if (isExtContextInvalid(e)) onExtContextLost(String(e && e.message || e));
    }
    setPhase('idle', '', '已清空本视频的本地去重表与扩展存储；下次「开始采集」将从头重扫');
  }

  function exportAs(format) {
    // 必须用 videoId —— 本视频采到的评论就存在这个键下（background 按 videoId 分池）。
    // 不能现场重新识别：用户滚到别的视频后再点导出，重识别会得到新 ID，
    // 于是导出一个空池，看起来像「数据丢了 / 导出的是别的视频」。
    var vid = videoId || pageViewId();
    if (!vid) {
      errText = '未识别到视频 ID，无法导出';
      render();
      return;
    }
    if (extContextLost) {
      onExtContextLost('');
      return;
    }
    // background 会等到下载真正进入终态才回包（用户可能还在「另存为」对话框里），
    // 所以先把面板切成「进行中」，否则这段等待期面板看起来像没反应。
    errText = '';
    noteText = '正在导出…（若弹出「另存为」对话框，请选择保存位置）';
    render();
    try {
      chrome.runtime.sendMessage({ type: 'dts-export', videoId: vid, format: format }, function (resp) {
        if (chrome.runtime.lastError) {
          var le = chrome.runtime.lastError.message || '';
          if (isExtContextInvalid(le)) {
            onExtContextLost(le);
            return;
          }
          noteText = '';
          errText = '导出失败：' + le;
          render();
          return;
        }
        if (resp && resp.ok) {
          errText = '';
          noteText = '已导出 ' + resp.filename + '（' + resp.bytes + ' 字节）';
        } else if (resp && resp.cancelled) {
          noteText = '';
          errText = '已取消保存，文件没有导出（评论数据仍在本地，可随时重新导出）';
        } else {
          noteText = '';
          errText = '导出失败：' + ((resp && resp.error) || '未知错误');
        }
        render();
      });
    } catch (e) {
      if (isExtContextInvalid(e)) {
        onExtContextLost(String(e && e.message || e));
        return;
      }
      noteText = '';
      errText = '导出失败：' + String(e && e.message || e);
      render();
    }
  }

  // ================== 面板（协议 §3.6） ==================
  // 只使用协议约定的 class；除进度条宽度（panel.css 通过 fill.style.width 消费）外不写任何内联 style

  var ui = null;

  function row(parent, label) {
    var r = document.createElement('div');
    r.className = 'dts-row';
    var l = document.createElement('span');
    l.className = 'dts-muted';
    l.textContent = label;
    var v = document.createElement('span');
    r.appendChild(l);
    r.appendChild(v);
    parent.appendChild(r);
    return v;
  }

  function mkBtn(text, extraClass, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'dts-btn' + (extraClass ? ' ' + extraClass : '');
    b.textContent = text;
    // 兜住同步/异步异常，避免按钮回调把错误吞进未捕获的 Promise
    b.addEventListener('click', function () {
      try {
        var r = onClick();
        if (r && typeof r.catch === 'function') {
          r.catch(function (e) { errText = '按钮操作异常：' + String(e); render(); });
        }
      } catch (e) {
        errText = '按钮操作异常：' + String(e);
        render();
      }
    });
    return b;
  }

  // ---- 面板位置（拖动 + 持久化） ----
  // 面板默认由 panel.css 钉在右下角（right/bottom）。一经用户拖动，就改成
  // **绝对坐标**：inline left/top，同时把 right/bottom 置为 auto。
  //
  // 为什么不用「右下角 + transform 位移」那一套：那样面板的位置会被布局牵着走，
  // 而且两次都会在用户眼前「瞬移」——
  //   ① right 锚定：视口宽度一变面板就横向平移。抖音开评论抽屉/浮层会锁 body 滚动，
  //      滚动条一消失 innerWidth 就变，面板自己就跳了；
  //   ② bottom 锚定：面板内容一变高，**顶边（也就是拖动把手）**就整体上跳。
  //      采集过程中提示文案一直换行数，正好命中这一条。
  // 实测（probe-drag-jump.mjs S4）：拖动中视口 1440→1280，面板 x 从 1084 跳到 924，
  // 而 --dts-dx 还是 0px —— 面板动了、位移却没记上，下一次拖动就在这错位的基础上算。
  // 换成 left/top 后：内容变高只往下长、视口变化不动它、拖动 = 直接改 left/top，
  // 位置只由坐标决定，没有再被布局牵着走的余地。
  var PANEL_POS_KEY = 'dts_panel_pos';

  function panelRect() {
    return ui && ui.root ? ui.root.getBoundingClientRect() : null;
  }

  // 至少留 60px 宽 / 32px 高在视口内，防止拖出屏幕再也抓不回来
  function clampPanel(x, y, w, h) {
    var minX = 60 - w;
    var maxX = Math.max(0, window.innerWidth - 60);
    var maxY = Math.max(0, window.innerHeight - 32);
    return { x: Math.max(minX, Math.min(maxX, x)), y: Math.max(0, Math.min(maxY, y)) };
  }

  function applyPanelAbs(x, y) {
    if (!ui || !ui.root) return;
    ui.root.style.left = Math.round(x) + 'px';
    ui.root.style.top = Math.round(y) + 'px';
    ui.root.style.right = 'auto';
    ui.root.style.bottom = 'auto';
  }

  function clearPanelAbs() {
    if (!ui || !ui.root) return;
    ui.root.style.left = '';
    ui.root.style.top = '';
    ui.root.style.right = '';
    ui.root.style.bottom = '';
  }

  function savePanelPos(x, y) {
    // 存整数：显示用的是 Math.round，存小数会让「视觉位置」和「下次读回的位置」慢慢错开
    try { chrome.storage.local.set({ dts_panel_pos: { x: Math.round(x), y: Math.round(y) } }); } catch (e) { /* 存不上也不影响使用 */ }
  }

  function clearPanelPos() {
    try { chrome.storage.local.remove(PANEL_POS_KEY); } catch (e) { /* ignore */ }
  }

  function loadPanelPos() {
    try {
      chrome.storage.local.get(PANEL_POS_KEY, function (o) {
        var p = o && o[PANEL_POS_KEY];
        var r = panelRect();
        if (!p || !r) return;
        if (typeof p.x === 'number' && typeof p.y === 'number' && isFinite(p.x) && isFinite(p.y)) {
          var c = clampPanel(p.x, p.y, r.width, r.height);
          applyPanelAbs(c.x, c.y);
          return;
        }
        // 兼容 ≤0.1.10 存的 {dx,dy}（相对右下角的位移）：换算成绝对坐标，并顺手升级存储
        if (typeof p.dx === 'number' && typeof p.dy === 'number' && isFinite(p.dx) && isFinite(p.dy)) {
          var c2 = clampPanel(r.left + p.dx, r.top + p.dy, r.width, r.height);
          applyPanelAbs(c2.x, c2.y);
          savePanelPos(c2.x, c2.y);
        }
      });
    } catch (e) { /* ignore */ }
  }

  // 视口变小（窗口缩放 / 浏览器 UI 变化）时把面板拉回可见范围，别让它留在屏幕外
  window.addEventListener('resize', function () {
    if (!ui || !ui.root || !ui.root.style.left) return;
    var r = panelRect();
    if (!r) return;
    var c = clampPanel(r.left, r.top, r.width, r.height);
    if (Math.abs(c.x - r.left) > 0.5 || Math.abs(c.y - r.top) > 0.5) {
      applyPanelAbs(c.x, c.y);
      savePanelPos(c.x, c.y);
    }
  });

  function makeDraggable(root, handle) {
    var drag = null;
    handle.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      // 标题栏上的按钮（收起）不触发拖动
      if (e.target && e.target.closest && e.target.closest('button')) return;
      var r = root.getBoundingClientRect();
      // 按下就切绝对坐标：此后位置只由 left/top 决定，内容变高、滚动条出现/消失
      // 都不会再把它挪走（拖动「瞬移」的根因就在「位置跟着布局跑」）。
      applyPanelAbs(r.left, r.top);
      drag = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        left: r.left,     // 按下瞬间的真实位置，作为这次拖动的基准
        top: r.top,
        w: r.width,
        h: r.height,
        moved: false
      };
      root.classList.add('dts-dragging');
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器忽略 */ }
      e.preventDefault();
    });

    function onMove(e) {
      if (!drag || e.pointerId !== drag.id) return;
      var c = clampPanel(drag.left + (e.clientX - drag.x), drag.top + (e.clientY - drag.y), drag.w, drag.h);
      applyPanelAbs(c.x, c.y);
      drag.moved = true;
    }
    handle.addEventListener('pointermove', onMove);

    function end(e) {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      var moved = drag.moved;
      drag = null;
      root.classList.remove('dts-dragging');
      if (moved) {
        var r = root.getBoundingClientRect();
        savePanelPos(r.left, r.top);
      }
    }
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);

    // 兜底：`setPointerCapture` 万一没生效（老浏览器、或指针事件被别的东西打断），
    // 事件就不会再被回投到把手上 —— 表现是「拖到一半停住、松手后位置也没记住」
    // （2026-09-30 探针实测到过一次：点了收起按钮把面板变小后再拖，只走了 186/220px
    // 且 dts_panel_pos 仍是 null，重跑又好了）。挂在 window 上再听一遍即可：
    // onMove 用同一个按下基准算坐标，重复触发结果一致；end 第二次进来 drag 已是 null 直接返回。
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);

    // 双击标题栏：回到 CSS 默认的右下角，并清掉记住的位置
    handle.addEventListener('dblclick', function () {
      clearPanelAbs();
      clearPanelPos();
    });
  }

  function buildPanel() {
    if (ui || document.getElementById('dts-collector-panel')) return;

    var root = document.createElement('div');
    root.id = 'dts-collector-panel';

    // 标题栏：收起时只保留这一行；同时是拖动把手（见 makeDraggable）
    var head = document.createElement('div');
    head.className = 'dts-row dts-header';
    head.setAttribute('title', '按住这里可以拖动面板；双击复位');
    var name = document.createElement('span');
    name.className = 'dts-title';
    name.textContent = '评论采集器';
    var dot = document.createElement('span');
    dot.className = 'dts-dot dts-dot-idle';
    name.insertBefore(dot, name.firstChild);
    var tools = document.createElement('div');
    tools.className = 'dts-tools';
    tools.appendChild(mkBtn('—', 'dts-btn-collapse', function () { root.classList.toggle('dts-collapsed'); }));
    head.appendChild(name);
    head.appendChild(tools);

    var body = document.createElement('div');
    body.className = 'dts-panel-body';

    var refs = {};
    refs.phase = row(body, '阶段');
    refs.count = row(body, '已采（去重）');
    refs.total = row(body, '服务端 total');
    refs.cursor = row(body, 'cursor');
    refs.ms = row(body, '每页耗时');

    var bar = document.createElement('div');
    bar.className = 'dts-bar';
    var fill = document.createElement('div');
    fill.className = 'dts-bar-fill';
    bar.appendChild(fill);
    body.appendChild(bar);
    refs.bar = bar;
    refs.fill = fill;

    var note = document.createElement('div');
    note.className = 'dts-row dts-muted';
    body.appendChild(note);
    var err = document.createElement('div');
    err.className = 'dts-row dts-err';
    body.appendChild(err);
    refs.note = note;
    refs.err = err;

    var r1 = document.createElement('div');
    r1.className = 'dts-row';
    r1.appendChild(mkBtn('开始采集', 'dts-btn-primary', onStartClick));
    r1.appendChild(mkBtn('暂停', '', onPauseClick));
    body.appendChild(r1);

    var r2 = document.createElement('div');
    r2.className = 'dts-row';
    r2.appendChild(mkBtn('导出 CSV', '', function () { exportAs('csv'); }));
    r2.appendChild(mkBtn('导出 JSON', '', function () { exportAs('json'); }));
    r2.appendChild(mkBtn('清空', '', onClearClick));
    body.appendChild(r2);

    root.appendChild(head);
    root.appendChild(body);
    (document.body || document.documentElement).appendChild(root);

    refs.root = root;
    refs.dot = dot;
    refs.head = head;
    ui = refs;
    makeDraggable(root, head);
    render();
    // 先 render 再读位置：旧版存的是相对右下角的 {dx,dy}，换算成绝对坐标需要
    // 面板已经在默认位置上有真实 rect（异步回调，不阻塞首屏）
    loadPanelPos();
  }

  function setPhase(p, err, note) {
    phase = p;
    if (err !== undefined) errText = err || '';
    if (note !== undefined) noteText = note || '';
    render();
  }

  function render() {
    if (!ui) return;
    ui.phase.textContent = PHASE_CN[phase] || phase;
    if (ui.dot) ui.dot.className = 'dts-dot ' + (DOT_CLASS[phase] || 'dts-dot-idle');
    ui.count.textContent = seen.size + ' 条' + (savedCount ? '（落库 ' + savedCount + '）' : '');
    ui.total.textContent = total ? String(total) : '未知';
    ui.cursor.textContent = String(cursor);
    ui.ms.textContent = lastMs ? lastMs + ' ms' : '—';
    ui.note.textContent = noteText || '';
    ui.err.textContent = errText || '';

    if (total > 0) {
      var pct = Math.max(0, Math.min(100, (seen.size / total) * 100));
      ui.fill.style.width = pct.toFixed(2) + '%';
      ui.bar.classList.remove('dts-bar-indeterminate');
    } else {
      // total 未知 → 不确定态，不显示虚假完成度
      ui.fill.style.width = '0%';
      ui.bar.classList.add('dts-bar-indeterminate');
    }

    // 镜像到主世界，供 __DTS_COLLECTOR__.getStatus() 读取（隔离世界的变量外部拿不到）
    down('status', {
      phase: phase, videoId: videoId, cursor: cursor, pages: pages,
      unique: seen.size, total: total, savedCount: savedCount,
      lastMs: lastMs, failStreak: failStreak, running: running,
      signedAt: signedAt,
      error: errText, note: noteText,
      pass: pass, passNew: passNew, floorCursor: floorCursor,
      // 二级回复进度（协议 §3.8）
      replyTargets: replyTargets.size, replyDone: replyDoneSet.size,
      replyPages: replyPages, repliesCollected: repliesCollected,
      replyFailed: replyFailCount, replyLastError: replyLastError,
      replyThrottledMs: replyThrottledMs,
      replyStoppedByThrottle: replyStoppedByThrottle,
      // 现场识别一遍（不写入 videoId），便于诊断「当前页面到底能不能识别到 ID」
      liveVideoId: extractVideoId(),
      // 扩展**自己**当前认的签名属于哪个视频（null = 已作废/没有）。
      // 与主世界的 getSigned() 不是一回事：那是页面最近发出过的 URL，扩展作废了它也不变
      // —— 跨视频污染要靠这个字段判（v0.1.11）。
      sigAweme: signedVideoId(),
      // 当前页面形态该给用户的指引（测试可确定性地断言，不必依赖是否真进过 waiting-sign）
      hint: signHint(),
      // 自动打开评论区最近一次的结果（'' | 'already-open' | 'clicked:<选择器>' | 'no-target:<形态>'）
      autoOpen: autoOpenLast,
      autoOpenCount: autoOpenCount,
      // 排障轨迹（最近 30 条：enter/click/stop/retry-*），只在诊断时看
      autoOpenLog: autoOpenLog.slice(-30),
      commentAreaOpen: commentAreaOpen(),
      at: Date.now()
    });
  }

  function whenBody(fn) {
    if (document.body) { fn(); return; }
    document.addEventListener('DOMContentLoaded', function () { fn(); }, { once: true });
  }

  async function waitForHook(ms) {
    var t0 = Date.now();
    while (!hookReady && Date.now() - t0 < ms) await sleep(100);
    return hookReady;
  }

  whenBody(buildPanel);

  // 页面切换轮询。抖音是 SPA，切视频/开浮层只改 URL 不刷新文档，而隔离世界
  // 拦不到主世界的 history.pushState，所以用低频轮询兜底。
  // 它的作用不是「立刻反应」，而是保证用户点「开始采集」之前，
  // lastPageKey 已经跟上当前页，且上一个视频的签名已被作废。
  lastPageKey = pageKey();
  setInterval(function () {
    if (onPageChanged()) {
      // 页面键变了不等于视频变了（例如只是关掉浮层回到网格）：
      // 只有确认「看的是另一个视频」才停，避免无谓地打断采集。
      var pv = pageViewId();
      if (running && pv && pv !== videoId) {
        stopFlag = true;
        setPhase('paused', '页面已切换到视频 ' + pv + '（当前采集的是 ' + videoId
          + '），已停止。请重新点「开始采集」');
        down('stop-capture');
        return;
      }
      // 页面变了、而扩展还在等签名（典型：在作品网格上点了「开始采集」，用户随后点开
      // 一条作品 → 页面变成浮层形态）⇒ 按**新形态**再试一次自动打开评论区。
      // 只在等签名时做，采集/空闲都不插手。
      if (needSign && phase === 'waiting-sign') {
        waitForNewSignature('page-changed', '');
      }
    }
    // 页面键没变也要照刷一次镜像：否则停在「等待签名」/空闲时，镜像会冻结在上一次
    // 页面键变化那一刻的 `liveVideoId` 上（2026-09-29 run-recommend-collect R2 实测
    // 读到 null，而同一时刻 DOM 里明明有 id）。render() 很轻：几个 textContent + 一次 postMessage。
    render();
  }, 800);

  // 供测试/排障查看当前状态（只读快照）
  window.__DTS_COLLECTOR_STATUS__ = function () {
    return {
      phase: phase,
      videoId: videoId,
      cursor: cursor,
      pages: pages,
      unique: seen.size,
      total: total,
      savedCount: savedCount,
      lastMs: lastMs,
      failStreak: failStreak,
      signedAt: signedAt,
      signedKeyCount: signedKeys.length,
      hookReady: hookReady,
      running: running,
      error: errText,
      note: noteText,
      pass: pass,
      passNew: passNew,
      floorCursor: floorCursor,
      // 当前页面形态该给用户的指引（与主世界镜像一致）
      hint: signHint(),
      // 扩展自己认的签名属于哪个视频（与主世界镜像一致）
      sigAweme: signedVideoId(),
      // 自动打开评论区最近一次的结果（与主世界镜像一致）
      autoOpen: autoOpenLast,
      autoOpenCount: autoOpenCount,
      commentAreaOpen: commentAreaOpen(),
      // 二级回复（协议 §3.8）
      replyTargets: replyTargets.size,
      replyDone: replyDoneSet.size,
      replyPages: replyPages,
      repliesCollected: repliesCollected,
      replyFailed: replyFailCount, replyLastError: replyLastError,
      replyThrottledMs: replyThrottledMs,
      replyStoppedByThrottle: replyStoppedByThrottle,
      constants: {
        COUNT: COUNT,
        MIN_INTERVAL_MS: MIN_INTERVAL_MS,
        JITTER_MS: JITTER_MS,
        MAX_PAGES: MAX_PAGES,
        FAIL_STREAK_PAUSE: FAIL_STREAK_PAUSE,
        BACKOFF_BASE_MS: BACKOFF_BASE_MS,
        BACKOFF_MAX_MS: BACKOFF_MAX_MS,
        SIGN_STALE_MS: SIGN_STALE_MS,
        MAX_PASSES: MAX_PASSES,
        RESCAN_MIN_NEW: RESCAN_MIN_NEW
      }
    };
  };

  // ================== AI Bridge（协议 §7） ==================
  // background 的 Hub poller 会转发外部 MCP 命令到这里。
  // 只处理 dts-ai-*，不干扰 dts-comments / dts-status 等既有落库消息。

  function aiStatusSnapshot() {
    return {
      phase: phase,
      videoId: videoId || null,
      liveVideoId: extractVideoId() || null,
      cursor: cursor,
      pages: pages,
      unique: seen.size,
      total: total,
      savedCount: savedCount,
      lastMs: lastMs,
      failStreak: failStreak,
      running: running,
      signedAt: signedAt,
      sigAweme: signedVideoId() || null,
      error: errText || '',
      note: noteText || '',
      hint: signHint(),
      autoOpen: autoOpenLast,
      autoOpenCount: autoOpenCount,
      commentAreaOpen: commentAreaOpen(),
      pageMode: (typeof pageMode === 'function') ? pageMode() : null,
      url: location.href,
      at: Date.now()
    };
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    var t = msg.type;

    if (t === 'dts-ai-keepalive') {
      sendResponse({ ok: true, keepalive: true, at: Date.now() });
      return false;
    }

    if (t === 'dts-ai-live-status') {
      sendResponse({ ok: true, status: aiStatusSnapshot(), url: location.href, at: Date.now() });
      return false;
    }

    if (t === 'dts-ai-start') {
      onStartClick().then(function () {
        sendResponse({ ok: true, status: aiStatusSnapshot(), at: Date.now() });
      }).catch(function (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e), status: aiStatusSnapshot() });
      });
      return true;
    }

    if (t === 'dts-ai-pause') {
      try { onPauseClick(); } catch (e) {
        sendResponse({ ok: false, error: String(e), status: aiStatusSnapshot() });
        return false;
      }
      sendResponse({ ok: true, status: aiStatusSnapshot(), at: Date.now() });
      return false;
    }

    if (t === 'dts-ai-clear-page') {
      try { onClearClick(); } catch (e) {
        sendResponse({ ok: false, error: String(e), status: aiStatusSnapshot() });
        return false;
      }
      sendResponse({ ok: true, status: aiStatusSnapshot(), at: Date.now() });
      return false;
    }

    if (t === 'dts-ai-export') {
      var vid = (msg && msg.videoId) || videoId || pageViewId();
      if (!vid) {
        sendResponse({ ok: false, error: '未识别到视频 ID，无法导出' });
        return false;
      }
      var format = msg && msg.format === 'json' ? 'json' : 'csv';
      errText = '';
      noteText = '正在导出…（AI bridge）';
      render();
      chrome.runtime.sendMessage({ type: 'dts-export', videoId: vid, format: format }, function (resp) {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message, videoId: vid });
          return;
        }
        if (resp && resp.ok) {
          sendResponse({ ok: true, videoId: vid, format: format, filename: resp.filename, bytes: resp.bytes, path: resp.path || null, downloadId: resp.downloadId || null });
        } else {
          sendResponse(Object.assign({ videoId: vid, format: format }, resp || { ok: false, error: '导出无回包' }));
        }
      });
      return true;
    }

    return false;
  });

  // 帮 MV3 Service Worker 保活：Hub 命令轮询依赖 SW 存活（协议 §7.5）
  setInterval(function () {
    try {
      chrome.runtime.sendMessage({ type: 'dts-ai-keepalive' }, function () {
        void chrome.runtime.lastError;
      });
    } catch (e) { /* 扩展重载等外部状态变化，忽略 */ }
  }, 3000);
})();
