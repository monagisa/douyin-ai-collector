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
  // v0.2.15：单路每轮之间的最小间隔 400 → 150。真机实测（2026-10-07，视频 7692405235813272867）
  // 列表往返中位 344ms，400ms 的间隔里有一半是纯等；21 页从 15.8s 降到 ~10s。
  const MIN_INTERVAL_MS = 150;          // 单路模式每轮之间最小间隔
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
  //          重新打开评论区；STATUS_5 / EMPTY_BODY / STATUS_NULL 一律当**服务端没放行**（签名还活着）；
  //       ④ 等满预算仍无果就收尾成 done，**绝不无限等待、绝不要求滚动**。
  // 2026-10-07 v0.2.14：预算从「10 秒一次性判决」改成「分波停顿重试、总窗口封顶」。
  //   实测（同一视频 7692405235813272867，探针 _rl_probe/_rl_direct）：
  //     · A 轮：会话内连续重试 108 秒，48 次回复请求全部 HTTP 200 + 0 字节 body；
  //     · 11 秒后新开会话的 B 轮：39/39 线程、302 条回复，一次没失败；
  //     · C 轮（把预算放宽到 300 秒，连撞 125 秒 / 200+ 次请求）：服务端一次都没放行；
  //     · D 轮：跨 8.5 分钟 4 波全被拒；随后新会话的 x1 轮又 23/23 全成。
  //   ⇒ 空 body 是服务端真没给数据（不是本地抢跑：hook 里只有 res.text() 拿到空串才是
  //     EMPTY_BODY，超时是另一个错误码 REPLAY_TIMEOUT，从未出现过）；但「10 秒」是假的终局：
  //     窗口常在十几秒后自己打开。所以改成：单波最多 REPLY_WAVE_BUDGET_MS，
  //     波与波之间停 REPLY_PARK_PLAN_MS，总等待封顶 RS.replyThrottleMaxWaitMs（内置 120 秒）。
  //     老行为（十秒不行就停）仍可复原：面板「限流等待 s」设 10 即可。
  const REPLY_WARMUP_MS = 1500;           // 进入补采前先停一下，让刚被列表扫描用掉的配额回血
  const REPLY_COOLDOWN_MS = 1500;         // 连续失败到阈值后的冷却
  const REPLY_FAIL_STREAK_STOP = 3;       // 连续失败累计到这个数，才做一次「冷却 + 探签名死活」
  const REPLY_BACKOFF_BASE_MS = 1000;     // 重试退避基数（1s 起，指数递增到上限后保持）
  const REPLY_BACKOFF_MAX_MS = 3000;      // 退避上限（3s）
  const REPLY_THROTTLE_MAX_WAIT_MS = 120 * 1000;      // 「等窗口」的**总**墙钟上限（含波间停顿；面板可改，10s~10min）
  const REPLY_WAVE_BUDGET_MS = 12 * 1000;             // 单波连续重试的上限（撞得再久也不连撞 200 次）
  const REPLY_PARK_PLAN_MS = [15000, 30000, 60000];   // 波间停顿计划（最后一档重复用）
  // ================== 回复请求全局限速（v0.2.13） ==================
  // 2026-10-07 定因（用户报「时不时触发回复限流，并发调低了也没用」）：
  // 4 条 lane 各自「取到线程就发」，唯一间隔只有同线程翻页的 REPLY_GAP_MS，
  // 而绝大多数线程只有一页 ⇒ 单线程等于**零间隔**，速率 ≈ replyLanes / RTT
  // ≈ 20 次/秒（实测 4 路 × ~200ms）。同一视频两轮差距极大（一轮 0/46 线程被拒、
  // 另一轮拿到 ~139 条）正是突发速率的典型特征，不是「设置没生效」。
  // 策略：① 跨 lane 的**全局间隔**（默认 250ms ≈ ≤4 次/秒，落在用户给的 4~6 次/秒档）；
  //       ② 撞限流（列表接口正常、回复被拒）时**自动降 1 路**并把全局间隔翻倍（上限 1000ms）——
  //          越撞越慢，自然退到服务端能过的档位，而不是一路硬撞到预算耗尽。
  const REPLY_GLOBAL_GAP_MS = 250;        // 所有回复请求（跨线程）的最小间隔；0/未设 = 用这个内置值
  const REPLY_GLOBAL_GAP_MAX_MS = 1000;   // 自适应上限（每撞一次限流翻倍，封顶在这里）

  // ================== 并发重放（最快档） ==================
  // 2026-09-28 探针 probe-burst.mjs 实证（同一签名多路复用）：
  //   1 路 698ms / 2 路 561ms / 4 路 366ms / 6 路 515ms（6 路服务端开始排队，反而变慢）
  //   各 cursor 独立返回，next == cursor+count 全部成立 → 可安全并发
  //   每路平均：1 路 698ms → 4 路 92ms（7.63x）
  //   全量 206 页：串行 2.9 分钟 → 4 路 0.4 分钟
  // ⚠️ 顶层列表的路数规则（v0.2.12 固定单路 → v0.2.15 恢复「错峰多路」）：
  //   0.2.11 及以前：同**一瞬间**并发发多个 cursor → 服务端把同签名的并发请求合并成同一页，
  //     4 路并发反而少采 ~30%（2026-10-06 实测；2026-10-07 在 __DTS_COLLECTOR__.replay()
  //     上用 4 个 cursor 同时发复现：Σ返回 200 条、**去重后只有 56 条**，c50/c100/c150 三页
  //     逐条完全相同，而 next 字段还是对的 ⇒ 静默少给，只能靠 cid 去重才看得出）。
  //   0.2.12：矫枉过正固定单路 —— 拿得全但慢。
  //   0.2.15：**错峰多路**。同一批请求每路错开 LANE_STAGGER_MS=200ms 就不再被合并
  //     （同一次实测：错峰 200ms → 200 条全唯一；错峰 500ms 同样正常），
  //     扫完整个列表 21 页：单路含间隔 15.79s → 错峰 4 路 7.72s（2.04×），唯一 cid 907 vs 912（一样多）。
  //   兜底：若某一轮里两路返回的 cid 完全一样（服务端又开始合并），当轮就把路数降回 1 并在面板说明，
  //     宁可慢也不再静默少采。
  const MAX_LANES = 3;                  // 内置默认顶层路数（v0.2.15 起真正生效；1 = 老单路）
  // DSH 插件（dsh-douyin-comments）可以在自己的「设置 → 插件」里调并发路数：它把
  // { lanes } 写进 chrome.storage.local.dts_settings，扩展每次开始采集时读一次。
  // LANES_HARD_MAX 是兜底硬上限（6 路起服务端开始排队，再多只是白挨风控）。
  const LANES_HARD_MAX = 8;
  const LANE_STAGGER_MS = 200;          // 同一批请求里每路之间的错峰（少了会被服务端并成一页）
  const RUNTIME_SETTINGS_KEY = 'dts_settings';
  // 面板自己的「设置」按钮写这里（用户当场点的偏好，v0.2.4 新增）。
  // 两个键同时存在时**以面板为准**：插件写的 dts_settings 只是「面板里没设过」时的默认值，
  // 这样用户在面板上改了并发/目标条数，下一次开始采集立刻按新值跑，不用去 DSH 里改。
  // 面板点「恢复默认」会整条删掉本键，回到 DSH 设置 / 内置常量。
  const USER_SETTINGS_KEY = 'dts_user_settings';
  const MAX_COUNT_HARD_MAX = 1000000;   // 面板「目标条数」硬上限（0 = 不限）
  const LANE_GAP_MS = 100;              // 多路模式轮间隔（单发形态靠 LANES=1 保底）
  const MIN_LANE_ITEMS = 30;            // 一路返回 <30 条视为触底，该轮结束后停

  // 本次「开始采集」实际使用的设置：默认就是上面那几个内置常量（扩展单独用时行为不变），
  // DSH 插件可以在设置里把二级回复的档位调宽（写进 dts_settings，见 loadRuntimeSettings）。
  var RS = {
    lanes: MAX_LANES,
    maxCount: 0,                        // 0 = 不限；面板「目标条数」到量即自动收工
    replyLanes: REPLY_LANES,
    replyGapMs: REPLY_GAP_MS,
    replyWarmupMs: REPLY_WARMUP_MS,
    replyThrottleMaxWaitMs: REPLY_THROTTLE_MAX_WAIT_MS,
    replyGlobalGapMs: REPLY_GLOBAL_GAP_MS,   // v0.2.13：回复请求跨线程的全局限速（0/未设 = 用内置 250ms）
  };
  // 最近一次读设置时，面板（dts_user_settings）里是否有用户改动 —— 只用于面板上显示来源
  var hasUserSettings = false;

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
  // v0.2.13：`seen` 是一二级**同池**去重（accept 把回复 cid 也加进去），所以「目标条数 max」
  // 不能再拿 seen.size 当一级计数 —— 单独记一个一级去重数（协议 §3.9 的 topSeen 字段）。
  var topSeenCount = 0;      // 一级评论去重条数
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
  // ---- v0.2.13：回复请求的全局限速 + 撞限流自动降速（跨 lane 共享）----
  var replyGateAt = 0;            // 下一个回复请求最早可发的时刻（墙钟毫秒）
  var replyGateMs = REPLY_GLOBAL_GAP_MS;        // 当前生效的全局间隔（撞限流翻倍，封顶 REPLY_GLOBAL_GAP_MAX_MS）
  var replyLaneLimit = 0;         // 撞限流后「自动降 1 路」的实时并发上限；0 = 用设置里的 replyLanes
  var repliesCollected = 0;       // 本轮已入队的回复条数
  var pendingReplies = new Map(); // 在飞的回复请求，按 parentCid|cursor 索引
  var replyFailStreak = 0;        // 回复请求连续失败次数
  var replyFailCount = 0;         // 补采失败（没拉全）的线程数
  var replyLastError = '';        // 最近一次回复失败原因（供面板/测试诊断）
  var replyThrottledMs = 0;       // 因「服务端不放行回复接口」而在**单波内**等待的毫秒（不打扰用户的预算）
  var replyThrottleStartAt = 0;   // 本轮静默等待的起点（墙钟）；0 = 当前不在等待
  var replyParkedMs = 0;          // v0.2.14：波间停顿累计毫秒（与 replyThrottledMs 相加 = 本轮总等待）
  var replyWaves = 0;             // v0.2.14：本轮已经打过的波数（1 = 只跑了第一波）
  var replyWaveBudgetMs = REPLY_WAVE_BUDGET_MS;  // v0.2.14：当前这一波的连续重试上限
  var replyStoppedByThrottle = false; // 本轮补采是因为「服务端不放行回复接口」而提前收尾的（面板要如实说明）
  var resumeReplies = false;      // 补采因签名失效停下后，拿到新签名直接回补采（不重扫顶层）
  /** 清空/换代号：清空时 +1。旧 startLoop 的在途回包若 epoch 不一致，必须丢弃，
   *  否则清空后旧循环会把 cursor 写回高位，再点开始就“续采”，但池子已是空的。 */
  var collectEpoch = 0;
  var justCleared = false;        // 刚点过清空：下次开始采集必须整体重置、从 cursor=0
  /** 「全部清空」的二次确认窗口（毫秒）：第一次点击只上膛，窗口内再点一次才真的清。
   *  全清不可恢复（所有视频的评论 + 去重表），必须防误触。 */
  var CLEAR_ALL_CONFIRM_MS = 5000;
  var clearAllArmedAt = 0;        // 0 = 未上膛；否则 = 首次点击的时间戳
  /** v0.2.9：本地已存的规模（跨视频）。换视频后面板原来会从 0 开始显示，
   *  用户会以为「上一条采集完的数据没了」——其实评论按 videoId 分桶存着。
   *  这里缓存一次统计（dts-stats），在面板上如实显示「N 个视频 / M 条（本条 X 条）」。 */
  var localStats = { videos: 0, total: 0, current: 0 };
  var localStatsTimer = 0;        // 「本地已存」的周期刷新（20s）
  /** v0.2.10：统计请求的序号。清空（或任何新的统计请求）会让旧回包作废——
   *  否则「清空前发出的 dts-stats」晚到，会把已经归零的「本地已存」又写回旧数字，
   *  看起来就像「全部清空没有用，本地已存还是在」。 */
  var localStatsSeq = 0;
  /** 评论桶的 key 前缀（与 background.js 的 PREFIX_COMMENTS 一致）：清空后读回存储自检用 */
  var COMMENT_KEY_PREFIX = 'dts_c_';
  /** 导出范围：false = 只导本条视频（默认，和旧版一致）；true = 把所有视频合成一份导出 */
  var exportAll = false;

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
        topSeenCount++;   // v0.2.13：一级去重计数（maxCount / 面板「目标条数」用它，不再用混池的 seen.size）
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

  // 扩展后台（background.js）可达性自测。null = 还没测过。
  // 实测坑（v0.2.7 批次 1 真机）：扩展文件刚变过、清过脚本缓存的那一轮，Chrome 偶尔让页面里
  // 的 content script 拿到一个已作废的扩展上下文 —— 面板注入正常、页面照常采集，但每次
  // chrome.runtime.sendMessage 都回 lastError「Receiving end does not exist」：
  // 清空无效、评论一条不落库，采集器最后只能报「交付 0 条」。
  // 这里主动 ping 一次后台并镜像给采集器（采集器据此自愈：刷新页面重新注入脚本）。
  var bgOk = null;
  var bgErr = '';
  var bgCheckedAt = 0;

  function probeBackground() {
    return new Promise(function (resolve) {
      var done = function (ok, err) {
        bgOk = ok; bgErr = err || ''; bgCheckedAt = Date.now();
        render();
        resolve(ok);
      };
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        done(false, 'chrome.runtime 不可用'); return;
      }
      try {
        chrome.runtime.sendMessage({ type: 'dts-ping' }, function (resp) {
          var le = chrome.runtime.lastError;
          if (le && le.message) {
            // 「Receiving end does not exist」= 本页脚本的扩展上下文已作废（后台收不到消息）
            if (isExtContextInvalid(le.message)) onExtContextLost(le.message);
            done(false, String(le.message)); return;
          }
          if (!resp || resp.ok !== true) {
            done(false, '后台回了异常响应：' + String(JSON.stringify(resp || null)).slice(0, 120)); return;
          }
          done(true, '');
        });
      } catch (e) {
        var m = String(e && e.message || e);
        if (isExtContextInvalid(m)) onExtContextLost(m);
        done(false, m);
      }
    });
  }

  function onExtContextLost(raw) {
    if (extContextLost) return;
    extContextLost = true;
    stopFlag = true;
    needSign = false;
    running = false;
    // 两种死法要分开说：「Receiving end does not exist」= 后台收不到消息（多半是本页脚本的
    // 扩展上下文刚作废），把它说成「上下文失效、去 chrome://extensions 重新加载」会让用户白折腾。
    var dead = /Receiving end does not exist/i.test(raw || '');
    errText = dead
      ? '扩展后台没有响应（Receiving end does not exist）：本页脚本的扩展上下文已作废。'
        + '请 **F5 刷新本抖音页** 后再点「开始采集」；刷新后仍这样，就关掉这个浏览器窗口重跑一次采集。'
        + (raw ? '（' + raw + '）' : '')
      : '扩展上下文已失效（Extension context invalidated）。'
        + '通常是刚在 chrome://extensions 里「重新加载」了本扩展。'
        + '请 **F5 刷新本抖音页** 后再点「开始采集」。'
        + (raw ? '（' + raw + '）' : '');
    noteText = dead ? '扩展后台不可达：本页采到的评论不会落库。' : '本页旧脚本已作废；刷新后扩展会重新注入。';
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
        // 落库后顺带刷新「本地已存」总量（本条视频的条数也在涨）
        refreshLocalStats();
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
   * 「服务端不回数据」（EMPTY_BODY / STATUS_NULL / STATUS_5）**只在单波预算内**等
   * （replyWaveBudgetMs：内置 12 秒，由 collectReplies 按剩余总窗口算出），
   * 到点就 { givingUp, throttled } 交给 collectReplies —— 由它决定「停一会儿再打下一波」
   * 还是收尾（v0.2.14：不再一波判终局）。绝不无限等待、绝不要求用户滚动。
   */
  async function recoverReply(parentCid, cur, firstErr) {
    var err = firstErr;
    var k = 0;   // 退避指数：跨轮累计，到 REPLY_BACKOFF_MAX_MS 后保持
    var waveBudget = replyWaveBudgetMs > 0 ? replyWaveBudgetMs : RS.replyThrottleMaxWaitMs;
    // 预算是墙钟：退避睡眠本身也算在内，否则「12 秒上限」会被重试循环放大成几十秒。
    if (!replyThrottleStartAt) replyThrottleStartAt = Date.now();
    // 本 lane 自己的起点：4 条 lane 并发时，任意一条成功都会把全局起点清零，
    // 另一条若还在冷却里、拿全局值做减法就会算出「已等待 17 亿秒」（实测踩到过）。
    var throttleStart = replyThrottleStartAt;
    // 立刻把状态告诉用户：这是「服务端不回数据、我自己在短退避重试」，不需要任何操作
    setPhase('replies', '服务端暂时不回数据（' + err + '），自动退避重试中，这一波最多试 '
      + Math.round(waveBudget / 1000) + ' 秒（无需你操作；不成会停一会儿再自动来一波）…');

    while (!stopFlag) {
      if (replyPages >= REPLY_MAX_REQUESTS) return { givingUp: true, error: '达到请求上限' };

      // 短退避重试：一直重试到连续失败累计 REPLY_FAIL_STREAK_STOP 次
      while (replyFailStreak < REPLY_FAIL_STREAK_STOP && !stopFlag) {
        if (replyPages >= REPLY_MAX_REQUESTS) return { givingUp: true, error: '达到请求上限' };
        // 预算检查必须在内层也做：否则要等退避跑完、冷却结束才判上限，会超出预算一大截
        if (Date.now() - throttleStart >= waveBudget) {
          return { givingUp: true, throttled: true, error: '服务端持续不回数据超过 '
            + Math.round(waveBudget / 1000) + ' 秒' };
        }
        await sleep(Math.min(REPLY_BACKOFF_MAX_MS, REPLY_BACKOFF_BASE_MS * Math.pow(2, k)));
        k++;
        await replyGate();   // v0.2.13：重试也要过全局闸门，否则「退避重试」本身又变成突发
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
      replyLastError = err + '（列表接口仍正常，判定为服务端暂时不放行回复接口）';
      // v0.2.13：确认只是「回复被拒」（签名还活着）→ 自动降速，别继续用同一个速率硬撞
      replyBackOff(err);
      // 先判预算再报状态：否则刚说完「还在重试」下一行就收尾了
      if (replyThrottledMs >= waveBudget) {
        return { givingUp: true, throttled: true, error: '服务端持续不回数据超过 '
          + Math.round(waveBudget / 1000) + ' 秒' };
      }
      setPhase('replies', '服务端暂时不回数据（' + err + '），已退避重试 '
        + Math.round(replyThrottledMs / 1000) + ' 秒（这一波最多 '
        + Math.round(waveBudget / 1000) + ' 秒，之后会停一会儿再来一波）…');
    }
    return { givingUp: true, error: 'stopped' };
  }

  /**
   * v0.2.13：回复请求的**全局闸门**（跨 lane 共享）。
   * 保证所有 lane 合起来的回复请求速率 ≤ 1/replyGateMs；单页线程也因此不再零间隔。
   * JS 是单线程：成功分支里「读时刻 → 写下一个放行时刻」之间没有 await，
   * 所以不会出现两条 lane 同时通过闸门的情况。
   */
  async function replyGate() {
    if (!(replyGateMs > 0)) return;
    for (;;) {
      var now = Date.now();
      var wait = replyGateAt - now;
      if (wait <= 0) { replyGateAt = now + replyGateMs; return; }
      await sleep(wait);
    }
  }

  /**
   * v0.2.13：判定为「回复接口被限流（列表接口仍正常）」时自动降速：
   * 全局间隔翻倍（封顶 REPLY_GLOBAL_GAP_MAX_MS）+ 并发降 1 路（下限 1）。
   * 只在 recoverReply 里「列表探活成功」之后调用 —— 签名真没了走 needSign，不该降速。
   */
  function replyBackOff(reason) {
    var before = replyGateMs;
    replyGateMs = Math.min(REPLY_GLOBAL_GAP_MAX_MS, Math.max(REPLY_GLOBAL_GAP_MS, replyGateMs * 2));
    var lanes = replyLaneLimit > 0 ? replyLaneLimit : RS.replyLanes;
    if (lanes > 1) replyLaneLimit = lanes - 1;
    noteText = '服务端暂时不放行回复接口（' + (reason || '') + '）：已自动降速 —— 全局间隔 ' + before + '→'
      + replyGateMs + 'ms，并发 ' + (replyLaneLimit || RS.replyLanes) + ' 路……';
    render();
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
      await replyGate();   // v0.2.13：跨线程全局限速（单页线程以前等于零间隔，是撞限流的主因）
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
      await sleep(RS.replyGapMs);
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
    await sleep(RS.replyWarmupMs);
    if (stopFlag) return;
    var needSignStop = false, hardStop = false, throttledStop = false;
    replyThrottledMs = 0;   // 每次进入补采重算「等窗口」预算
    replyThrottleStartAt = 0;
    replyParkedMs = 0;      // v0.2.14：波间停顿累计
    replyWaves = 1;         // v0.2.14：马上要打第一波
    replyWaveBudgetMs = Math.min(REPLY_WAVE_BUDGET_MS, RS.replyThrottleMaxWaitMs);
    replyStoppedByThrottle = false;
    // v0.2.13：每次进入补采都把限速/降速状态复位（上一轮的降速不继承到这一轮）
    replyGateMs = RS.replyGlobalGapMs;
    replyGateAt = 0;
    replyLaneLimit = 0;

    /** 跑一轮：REPLY_LANES 个 worker 从同一队列取线程；返回本轮失败的 cid */
    async function runRound(list, label) {
      var idx = 0, failed = [];
      async function worker(myLane) {
        while (!stopFlag && !needSignStop && !hardStop && !throttledStop) {
          // v0.2.13：撞限流后 replyLaneLimit 会降到 1..n-1，多出来的 worker 主动退出
          if (myLane >= (replyLaneLimit > 0 ? replyLaneLimit : RS.replyLanes)) return;
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
          if (r.failed) failed.push(cid); else {
            replyDoneSet.add(cid);
            // v0.2.14：这一波里先撞了几次「服务端暂时不回数据」、后面又成功时，
            // 面板那行红字（errText）不清掉会一直挂着，看起来像「一直在限流」——
            // 有任意一个线程成功就说明窗口已经开了，立刻清掉。
            if (errText) errText = '';
          }
          noteText = label + ' ' + replyDoneSet.size + '/' + replyTargets.size + ' 个线程，已得 '
            + repliesCollected + ' 条（请求 ' + replyPages + ' 次'
            + (failed.length ? '，本轮失败 ' + failed.length : '') + '）';
          render();
        }
      }
      var ws = [];
      var laneBudget = replyLaneLimit > 0 ? replyLaneLimit : RS.replyLanes;
      var lanes = Math.min(laneBudget, list.length);
      for (var i = 0; i < lanes; i++) ws.push(worker(i));
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

    // v0.2.14：服务端不放行时**不再一波判终局** —— 停一会儿、再来一波。
    // 依据见文件顶部 REPLY_THROTTLE_MAX_WAIT_MS 的实测注释：窗口常在十几秒后自己打开，
    // 而「一口气连撞」并不会让它开得更快（C 轮连撞 125 秒 / 200+ 次请求，一次没放行）。
    // 单波上限 replyWaveBudgetMs，波间停 REPLY_PARK_PLAN_MS，总等待封顶 RS.replyThrottleMaxWaitMs。
    while (throttledStop && failed.length && !needSignStop && !stopFlag) {
      var parkMs = REPLY_PARK_PLAN_MS[Math.min(replyWaves - 1, REPLY_PARK_PLAN_MS.length - 1)];
      var wouldWait = replyParkedMs + parkMs;
      // 留一波的余量：总窗口不够再打一波就收尾，别停完了发现没时间试
      if (wouldWait + REPLY_WAVE_BUDGET_MS > RS.replyThrottleMaxWaitMs) break;
      replyWaves++;
      await flushComments(0);   // 先落盘：用户这时关页面/切视频也不会丢已拿到的
      noteText = '服务端还没放行回复接口（本轮已等 '
        + Math.round((replyParkedMs + replyThrottledMs) / 1000) + ' 秒，还剩 '
        + (replyDoneSet.size < replyTargets.size ? (replyTargets.size - replyDoneSet.size) : failed.length)
        + ' 个线程）：' + Math.round(parkMs / 1000) + ' 秒后自动再试一波，不用你操作……';
      render();
      await sleep(parkMs);
      if (stopFlag) break;
      replyParkedMs = wouldWait;
      throttledStop = false;
      replyFailStreak = 0;
      replyThrottleStartAt = 0;
      replyThrottledMs = 0;
      replyLastError = '';
      replyWaveBudgetMs = Math.min(REPLY_WAVE_BUDGET_MS,
        Math.max(6000, RS.replyThrottleMaxWaitMs - replyParkedMs));
      setPhase('replies', '', noteText);
      failed = await runRound(failed, '停顿 ' + Math.round(parkMs / 1000) + 's 后重试');
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
      noteText = '服务端始终没放行回复接口（本轮共等 '
        + Math.round((replyParkedMs + replyThrottledMs) / 1000) + ' 秒、分 ' + replyWaves
        + ' 波重试；' + replyDoneSet.size + '/' + replyTargets.size
        + ' 个线程、共 ' + repliesCollected + ' 条已采到，请求 ' + replyPages + ' 次）。'
        + '再点一次「开始采集」会从断点续补采（不重扫顶层、已采到的不重复拉）；'
        + '想让它等更久/更短，面板「限流等待 s」可调（内置 120 秒，设 10 秒 = 老行为）';
    } else {
      noteText = '二级回复补采完成：' + replyDoneSet.size + '/' + replyTargets.size
        + ' 个线程，共新增 ' + repliesCollected + ' 条（请求 ' + replyPages + ' 次'
        + (failed.length ? '，仍有 ' + failed.length + ' 个线程没拉全' : '')
        + (hardStop ? '，达到请求上限提前停止' : '') + '）';
    }
    // v0.2.14：补采阶段到此结束，把「阶段」交回调用方 —— 它负责置 done，并补上
    // 「到量停顶层」的前缀（第二阶段收尾的 phase === 'collecting' 门槛，见本文件下方）。
    // 旧版这里留在 'replies'，那个门槛因此永远不成立 ⇒ 面板一直停在「补采二级回复」，
    // DSH 采集器更要等到「无进展 900 秒」才收工；真机 y1 轮就是补采完成后被签名抖动
    // 拽进 waiting-sign、再空等 120 秒才结束（ok=true，但 phase 不是 done）。
    // 裸赋值不走 setPhase：既不改刚写好的 noteText，也不清掉可能刚清空过的 errText。
    phase = 'collecting';
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
    // 服务端不放行时如实说明（含总等待与波数），并给出用户唯一的动作：过一会儿再点一次（无需滚动）
    if (replyStoppedByThrottle) {
      s += '。服务端始终没放行回复接口（列表接口正常：它回的是 HTTP 200 + 0 字节 body，'
        + '不是本地请求没回来），本轮共等 '
        + Math.max(1, Math.round((replyParkedMs + replyThrottledMs) / 1000)) + ' 秒、分 '
        + replyWaves + ' 波重试，还剩 '
        + (replyTargets.size - replyDoneSet.size)
        + ' 个线程没拉到 —— 再点「开始采集」会**从断点续补采二级回复**'
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
      topSeenCount = 0;   // v0.2.13：一级计数与 seen 同生同灭
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

  /**
   * 读运行时设置。两个来源：
   *   ① chrome.storage.local.dts_settings   —— DSH 插件每次调用下发（协议 §3.9）
   *   ② chrome.storage.local.dts_user_settings —— 面板「设置」按钮里用户当场写的（v0.2.4）
   * 优先级：内置常量 < ① < ②。面板是用户当场点的意图，插件下发只是默认值。
   * 两个键都没有 → 全用内置常量，扩展单独使用时行为与以前完全一致。
   * 可调项：lanes（顶层并发路数）、maxCount（目标条数，0=不限）、replyLanes（回复并发）、
   *        replyGapMs（回复同线程间隔）、replyWarmupMs（进补采前静默）、
   *        replyThrottleMaxWaitMs（整段等限流窗口的墙钟上限）。
   * @returns {Promise<object>} 本次开始采集要用的设置（已按硬上限钳过）
   */
  function loadRuntimeSettings() {
    return new Promise(function (resolve) {
      var out = {
        lanes: MAX_LANES,
        maxCount: 0,
        replyLanes: REPLY_LANES,
        replyGapMs: REPLY_GAP_MS,
        replyWarmupMs: REPLY_WARMUP_MS,
        replyThrottleMaxWaitMs: REPLY_THROTTLE_MAX_WAIT_MS,
        replyGlobalGapMs: REPLY_GLOBAL_GAP_MS,   // v0.2.13：回复请求跨线程全局限速（0/未设 = 用这个内置 250ms）
      };
      var clamp = function (v, lo, hi, dflt) {
        var n = Number(v);
        if (!isFinite(n)) return dflt;
        return Math.max(lo, Math.min(Math.round(n), hi));
      };
      try {
        chrome.storage.local.get([USER_SETTINGS_KEY, RUNTIME_SETTINGS_KEY], function (o) {
          var s = (o && o[RUNTIME_SETTINGS_KEY]) || null;    // ① 插件本次下发
          var u = (o && o[USER_SETTINGS_KEY]) || null;       // ② 面板里用户设的（优先）
          hasUserSettings = !!(u && typeof u === 'object');
          // 逐项取：面板设过就用面板的，否则用插件的，都没有就内置默认
          var pick = function (key, lo, hi, dflt) {
            if (u && u[key] !== undefined && u[key] !== null) return clamp(u[key], lo, hi, dflt);
            if (s && s[key] !== undefined && s[key] !== null) return clamp(s[key], lo, hi, dflt);
            return dflt;
          };
          out.lanes = pick('lanes', 1, LANES_HARD_MAX, MAX_LANES);   // 顶层列表路数（v0.2.15 起真正生效，默认 3）
          out.maxCount = pick('maxCount', 0, MAX_COUNT_HARD_MAX, 0);
          out.replyLanes = pick('replyLanes', 1, LANES_HARD_MAX, REPLY_LANES);
          out.replyGapMs = pick('replyGapMs', 0, 60000, REPLY_GAP_MS);
          out.replyWarmupMs = pick('replyWarmupMs', 0, 600000, REPLY_WARMUP_MS);
          // 等窗口的**总**预算：上限 10 分钟；下限 10 秒（=老行为「十秒不行就停」），内置 120 秒
          out.replyThrottleMaxWaitMs = pick('replyThrottleMaxWaitMs', 10000, 600000, REPLY_THROTTLE_MAX_WAIT_MS);
          // v0.2.13：回复请求全局限速。0 或缺省 = 用内置 250ms —— 与 DSH 设置页/MCP/文档的
          // 「0 = 用扩展内置 250ms」保持一致（v0.2.13 曾把 0 当「关闸门」，与文档矛盾：AI 一条
          // ai_set_settings{replyGlobalGapMs:0} 就能静默关掉限速）
          var gap = pick('replyGlobalGapMs', 0, 2000, 0);
          out.replyGlobalGapMs = gap > 0 ? gap : REPLY_GLOBAL_GAP_MS;
          resolve(out);
        });
      } catch (e) {
        resolve(out);
      }
    });
  }

  /** 面板「设置」里读取用户自己存的那份（原样，不钳位不合并）——用于回显输入框 */
  function loadUserSettings(cb) {
    try {
      chrome.storage.local.get(USER_SETTINGS_KEY, function (o) {
        cb((o && o[USER_SETTINGS_KEY]) || null);
      });
    } catch (e) {
      cb(null);
    }
  }

  async function startLoop() {
    if (running) return;
    var epoch = collectEpoch;
    running = true;
    stopFlag = false;
    // 设置每次「开始采集」都重读一次：DSH 插件改完立即生效，不用重开浏览器。
    RS = await loadRuntimeSettings();
    var lanesWanted = RS.lanes;
    // 顶层列表路数（v0.2.15：错峰多路，见常量区那段实测说明）。把「实际用了几路」落进 storage，
    // 供 DSH 插件/排查时核对（读不回来也不影响采集）。若主循环发现两路被服务端并成了同一页，
    // 会就地改写 effSettings.lanes / lanesNote 再回写 —— 排查的人一眼能看出「这一轮被降成单路了」。
    var effSettings = {
      lanes: lanesWanted,
      lanesWanted: lanesWanted,
      lanesNote: '',
      maxCount: RS.maxCount,
      replyLanes: RS.replyLanes,
      replyGlobalGapMs: RS.replyGlobalGapMs,
      replyGapMs: RS.replyGapMs,
      replyThrottleMaxWaitMs: RS.replyThrottleMaxWaitMs,
      replyWaveBudgetMs: REPLY_WAVE_BUDGET_MS,      // v0.2.14：单波连续重试上限
      replyParkPlanMs: REPLY_PARK_PLAN_MS.join('/'), // v0.2.14：波间停顿计划
      from: hasUserSettings ? 'panel' : 'plugin',
      at: Date.now(),
    };
    var writeEffective = function () {
      try { chrome.storage.local.set({ dts_settings_effective: effSettings }); } catch (e) { /* 忽略 */ }
    };
    writeEffective();
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

      // v0.2.13：maxCount 到量只停**顶层扫描**，二级回复仍要补完（循环外的补采段负责）
      var topCapReached = false;
      // v0.2.15：顶层列表实际用的路数。正常情况下就是 RS.lanes；一旦发现某一轮里两路返回了
      // 完全相同的页（服务端又开始合并并发请求），当轮就降回 1 并写进 dts_settings_effective。
      var laneBudget = Math.max(1, Math.min(LANES_HARD_MAX, Math.round(RS.lanes || MAX_LANES)));
      var lanes = laneBudget;
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

        // ---- 一轮：顶层列表**错峰多路**推进（每路都用服务端给的 next） ----
        //
        // 0.2.11 及以前是「同时发 N 路」：cursor, cursor+COUNT, cursor+2*COUNT … 一起发出去。
        // 2026-10-06 真机实测（_scan_probe2.mjs / _scan_probe3.mjs，视频 7692405235813272867，
        // 登录态正常，服务端列表在 offset 850 触底、total=1704）：
        //   · 单路串行 18 步 → 714 条唯一一级评论（多轮累加 744）；
        //   · 4 路并发 5 轮 → 只有 492 条，且**一个失败请求都没有**；
        //   · 并发那一轮里 c50/c100/c150 三个请求拿到的是**同一页**（两两重合 50/50，
        //     而且这一页不在任何串行页里）→ 服务端把**同一瞬间**的同签名请求合并了；
        //   · 同样 4 路、每路之间错峰 200ms → 恢复正常（4 页 = 200 条唯一）。
        // 0.2.12 因此固定单路（拿得全但慢）。2026-10-07 用 __DTS_COLLECTOR__.replay() 复现 + 量化：
        //   · 同时发 4 个 cursor：Σ返回 200 条、**去重后只有 56 条**，c50/c100/c150 逐条相同，
        //     而 next 字段还是对的（50/100/150/200）⇒ 静默少给，只有按 cid 去重才看得出；
        //   · 错峰 200ms：唯一 200/200；错峰 500ms：唯一 200/200；
        //   · 扫完整个列表（21 页 / Σ返回 1021 条）：单路含 400ms 间隔 15.79s → 错峰 4 路 7.72s，
        //     唯一 cid 907 vs 912（一样多）。
        // 所以 v0.2.15 起改成**错峰多路**：每路错开 LANE_STAGGER_MS，并且在下面校验里检测
        // 「两路返回同一页」→ 当轮降回单路（宁可慢，也不再静默少采）。
        var lanes = laneBudget;
        var i;
        var cursors = [];
        for (i = 0; i < lanes; i++) cursors.push(cursor + i * COUNT);
        var reqs = [];
        for (i = 0; i < lanes; i++) {
          if (i > 0) await sleep(LANE_STAGGER_MS + Math.round(Math.random() * 60));
          if (stopFlag || epoch !== collectEpoch) break;
          reqs.push(requestReplay(cursors[i], COUNT));   // 不 await：让它先飞，形成错峰在途
        }
        reqs = await Promise.all(reqs);
        if (stopFlag || epoch !== collectEpoch) break;
        // 清空/换代发生在请求在途时：丢弃回包，禁止把 cursor 写回高位
        if (!reqs.length) continue;

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

        // v0.2.15 兜底：同一轮里两路返回**逐条相同**的页 ⇒ 服务端又把并发的同签名请求并成一个响应了。
        // 当轮就降回单路，并如实写进 dts_settings_effective —— 宁可慢，也不再静默少采（这是少采的唯一可见信号）。
        if (reqs.length > 1) {
          var mergedLanes = false;
          var ai; var bi; var m;
          for (i = 0; i < reqs.length && !mergedLanes; i++) {
            for (var k = i + 1; k < reqs.length; k++) {
              ai = reqs[i].items || []; bi = reqs[k].items || [];
              if (ai.length > 0 && ai.length === bi.length) {
                var sameIds = true;
                for (m = 0; m < ai.length; m++) {
                  if (String(ai[m].cid) !== String(bi[m].cid)) { sameIds = false; break; }
                }
                if (sameIds) { mergedLanes = true; break; }
              }
            }
          }
          if (mergedLanes) {
            laneBudget = 1;
            lanes = 1;
            effSettings.lanes = 1;
            effSettings.lanesNote = '第 ' + pages + ' 页前后发现两路返回了同一页（服务端合并并发请求），已自动降回单路；'
              + '其余设置不变。想彻底关掉多路就把「并发路数」设成 1。';
            effSettings.at = Date.now();
            writeEffective();
            noteText = '检测到服务端把并发请求合并成同一页，已自动降回单路继续采（慢一点，但不会少采）……';
            render();
          }
        }

        // 先校验「每路都拿满一页」，再决定要不要接受这一轮
        var laneShort = false;
        var laneEnd = false;
        var anyLaneHasMore = false;
        for (i = 0; i < reqs.length; i++) {
          var rr = reqs[i];
          if (!rr.ok) continue;
          var ni = (rr.items || []).length;
          if (ni > 0 && ni < MIN_LANE_ITEMS) laneShort = true;
          if (ni > 0 && Number(rr.hasMore) !== 0) anyLaneHasMore = true;
          if (Number(rr.hasMore) === 0 && ni < COUNT) {
            // 只认「拿不满一页」的 has_more=0：满页却带 0 是矛盾信号，不当终点也不当触底位置。
            // 真触底那页一定拿不满 COUNT；代价只是多跑一轮（越界的路会返回空页）。
            var laneCur = (typeof rr.cursor === 'number' && isFinite(rr.cursor)) ? rr.cursor : cursors[i];
            if (floorCursor === null || laneCur < floorCursor) floorCursor = laneCur;
            laneEnd = true;
          }
        }
        // v0.2.15：多路时「有一路越界返回空页」不代表触底 —— 同一轮里还有路带回满页且 has_more=1，
        // 那是本路 cursor 暂时跑到列表末端之外（列表还没扫完），必须继续。只有所有路都没有 has_more 才算到底。
        if (laneEnd && anyLaneHasMore) laneEnd = false;

        var anyOk = false;
        var maxNext = cursor;
        var freshAll = [];
        for (i = 0; i < reqs.length; i++) {
          var q = reqs[i];
          pages++;
          if (q.ms) lastMs = q.ms;   // 面板标签是"上一页耗时"：显示最近值，不是历史最大值
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

        // 面板「设置 → 目标条数」到了就**停止顶层扫描**（0 = 不限）。
        // 0.2.13 修正：这里只跳出顶层 while，二级回复由循环外的补采段继续补完 ——
        //   旧版在这一行直接 setPhase('done') + break，于是「设了目标条数」
        //   就变成「二级回复一条都不要」，而注释恰恰写着「仍要补完再停」（Mac 报告里那个坑）。
        // 计数用 topSeenCount（**一级**去重条数），不再用一二级混池的 seen.size。
        if (RS.maxCount > 0 && topSeenCount >= RS.maxCount) {
          topCapReached = true;
          noteText = '一级评论已到目标 ' + RS.maxCount + ' 条（去重后 ' + topSeenCount +
            ' 条），停止顶层扫描，继续补采二级回复……';
          setPhase('collecting');
          render();
          break;
        }

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
          // 顶层列表采完 → 第二阶段（补采二级回复）统一交给循环外的补采段处理（v0.2.13 抽出，
          // 这样「maxCount 到量」和「列表触底」两条路径共用同一段逻辑，不会再有一条漏掉回复）
          break;
        }

        // 触底保护：某一路返回的条数明显少于 COUNT → 服务端已到列表末尾，
        // 下轮退回单路，避免越过末尾白跑并产生空洞（v0.2.15：这一轮起 laneBudget 就固定为 1）
        if (laneShort) {
          laneBudget = 1;
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

      // ---- 第二阶段：补采二级回复（协议 §3.8）----
      // v0.2.13：顶层扫描结束的两条路径（列表触底 / maxCount 到量）都落到这里，
      // 「设了目标条数」因此不会再丢掉二级回复。只在仍是 collecting 时收尾：
      // 不覆盖 collectReplies 自己置的 waiting-sign / paused（实测踩到过「显示已完成却没采完」）。
      if (!stopFlag && epoch === collectEpoch && phase === 'collecting' &&
          replyTargets.size > replyDoneSet.size) {
        await collectReplies();
      }
      if (!stopFlag && epoch === collectEpoch && phase === 'collecting') {
        // endNote() 里已经带「二级回复已补采 N 条（x/y 个线程，请求 n 次）」，
        // 这里只补「到量停止顶层扫描」的前缀，别再叠一份回复摘要（真机验收时叠出过「；；」）。
        var doneNote = endNote();
        if (topCapReached) {
          doneNote = '一级评论已到目标 ' + RS.maxCount + ' 条（去重后 ' + topSeenCount
            + ' 条），已停止顶层扫描；' + doneNote + '。再点「开始采集」会从断点继续';
        } else if (replyTargets.size > 0) {
          doneNote += '。';
        }
        setPhase('done', '', doneNote);
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
    // v0.2.9：点「开始采集」时立刻刷新「本地已存」，让用户看到上一个视频的数据还在
    // （savedCount/seen 会按当前视频重置，面板的「已采」归零容易被误解成数据丢了）
    refreshLocalStats(videoId);
    noteText = localStatsNote();
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

  /**
   * 把「本页采集状态」整体归零（不动扩展存储里的数据）。两个清空按钮共用。
   * 必须同时作废在途采集：否则旧 startLoop 回包会把 cursor 写回高位，
   * storage 已清空、再点「开始采集」就变成「从半路续采 + 前段丢失」。
   */
  function resetLocalState() {
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
  }

  /**
   * 发清空消息：给 videoId = 只清那条视频的评论；all:true = 全清所有视频。
   * v0.2.10：不再「发出去就当成功」——必须等后台回包（后台可能没起来/上下文已失效），
   * 回包后把结果交给 onDone(err)：err 为空 = 后台确认删了；否则带上失败原因。
   * 调用方随后还要读一遍存储自检（verifyCleared），三者都过才敢说「已清空」。
   */
  function sendClear(payload, onDone) {
    var done = (typeof onDone === 'function') ? onDone : function () {};
    if (extContextLost) { onExtContextLost(''); done('EXT_CONTEXT_LOST'); return; }
    try {
      chrome.runtime.sendMessage(Object.assign({ type: 'dts-clear' }, payload), function (resp) {
        var le = chrome.runtime.lastError && chrome.runtime.lastError.message;
        if (le) {
          if (isExtContextInvalid(le)) onExtContextLost(le);
          done('SEND_FAILED: ' + le);
          return;
        }
        if (!resp || !resp.ok) { done('CLEAR_REJECTED: ' + ((resp && resp.error) || 'unknown')); return; }
        done('');
      });
    } catch (e) {
      if (isExtContextInvalid(e)) onExtContextLost(String((e && e.message) || e));
      done('SEND_THREW: ' + String((e && e.message) || e));
    }
  }

  /**
   * 读回 chrome.storage.local 自检清空到底有没有生效（v0.2.10）。
   * 内容脚本能直接读存储，所以「后台没响应」这种情况再也不能被谎报成「已清空」。
   * all=true 查所有 dts_c_* 与 dts_videos；否则只查本条视频的桶与它在 dts_videos 里的记录。
   * cb(gone, detail)：gone=false 时 detail 是还残留的键（给用户看的证据）。
   */
  function verifyCleared(vid, all, cb) {
    try {
      chrome.storage.local.get(null, function (o) {
        if (chrome.runtime.lastError) { cb(false, 'READ_FAILED: ' + chrome.runtime.lastError.message); return; }
        var obj = o || {};
        var left = [];
        var keys = Object.keys(obj);
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          if (k === 'dts_videos') { if (all) left.push('dts_videos'); continue; }
          if (k.indexOf(COMMENT_KEY_PREFIX) !== 0) continue;
          if (all || k === COMMENT_KEY_PREFIX + vid) left.push(k);
        }
        if (!all && vid && obj.dts_videos && obj.dts_videos[vid]) left.push('dts_videos[' + vid + ']');
        cb(left.length === 0, left.join('、'));
      });
    } catch (e) {
      cb(false, 'READ_THREW: ' + String((e && e.message) || e));
    }
  }

  /** 清空失败时统一的提示文案：说清「没清掉」+ 怎么办（别让用户以为清过了） */
  function clearFailedText(which, err, detail) {
    var why = err || (detail ? ('本地还剩 ' + detail) : '未知原因');
    return '「' + which + '」没有生效（' + why + '）。这通常是扩展后台没响应或扩展刚被重新加载过：'
      + '请打开 edge://extensions 点一下「重新加载」，回到抖音页按 F5 刷新后再试';
  }

  /** 「清空」：只清**本条视频链接**的评论（其它视频的数据与面板设置都保留）。 */
  function onClearClick() {
    // 护栏：未识别到视频 ID 时绝不能发清空——background 侧空 videoId 不再兜底成全清，
    // 这里直接拦下并如实提示（以前会发空串清掉所有视频的存储，面板却谎称"已清空本视频"）
    if (!videoId) {
      setPhase('idle', '', '未识别到视频 ID，无法清空；请先打开具体视频页/浮层');
      return;
    }
    resetLocalState();
    if (extContextLost) {
      onExtContextLost('');
      return;
    }
    sendClear({ videoId: videoId }, function (err) {
      if (extContextLost) return;
      // 上下文已失效时绝不能宣称「已清空」：采集器看到这句话会以为清空成功，
      // 而扩展存储其实一条没动（实测踩过一次：面板说已清空，桶里还是 1403 条）。
      // v0.2.10 起再加一道：后台回包之后读回存储自检，真清掉了才改口。
      verifyCleared(videoId, false, function (gone, detail) {
        if (!gone) {
          // 注意：必须用 setPhase 的 err 参数落文案——写成 errText=… 再 setPhase('idle','','') 会把
          // errText 又清成空串（踩过：面板既不报「已清空」也不报「没有生效」，用户看不到任何反馈）
          setPhase('error', clearFailedText('清空', err, detail), '本条视频的本地数据还在，别当成清过了');
          return;
        }
        setPhase('idle', '', '已清空本视频的本地去重表与扩展存储；下次「开始采集」将从头重扫');
        // 清完立刻刷新「本地已存」总量（本条视频那部分已经归零）
        localStatsSeq++;
        refreshLocalStats(videoId);
      });
    });
  }

  /**
   * 「全部清空」：清掉**所有**视频的评论与本地去重表（不可恢复，且不受「未识别到视频 ID」限制）。
   * 两步确认：第一次点击只上膛（按钮变「确认全部清空？」），5 秒内再点一次才真的清。
   */
  function onClearAllClick() {
    var now = Date.now();
    if (!clearAllArmedAt || now - clearAllArmedAt > CLEAR_ALL_CONFIRM_MS) {
      clearAllArmedAt = now;
      noteText = '再点一次「全部清空」确认：会清掉所有视频的评论与本地去重表（不可恢复），'
        + Math.round(CLEAR_ALL_CONFIRM_MS / 1000) + ' 秒内有效';
      errText = '';
      render();
      // 窗口过期后把按钮文案复原（面板不是一直重绘，得自己收尾）
      setTimeout(function () {
        if (clearAllArmedAt && Date.now() - clearAllArmedAt >= CLEAR_ALL_CONFIRM_MS) {
          clearAllArmedAt = 0;
          render();
        }
      }, CLEAR_ALL_CONFIRM_MS + 60);
      return;
    }
    clearAllArmedAt = 0;
    resetLocalState();
    if (extContextLost) {
      onExtContextLost('');
      return;
    }
    var finish = function (n) {
      // v0.2.10：等后台回包 + 读回存储自检，两者都过才敢说「已清空」并归零「本地已存」。
      // 以前是「发出去就改口」，后台没响应时面板显示已清空、20 秒后周期刷新又把旧数字写回来，
      // 用户看到的就是「全部清空没有用，本地已存还是在」。
      sendClear({ all: true }, function (err) {
        if (extContextLost) return;
        verifyCleared(videoId, true, function (gone, detail) {
          if (!gone) {
            // 同上：文案必须走 setPhase 的 err 参数，否则会被自己清掉
            setPhase('error', clearFailedText('全部清空', err, detail), '所有视频的本地数据都还在，别当成清过了');
            return;
          }
          setPhase('idle', '', '已清空全部视频的评论与本地去重表'
            + (n > 0 ? '（共 ' + n + ' 个视频）' : '') + '；下次「开始采集」将从头重扫');
          // 全清之后「本地已存」必须立刻显示为 0；序号 +1 作废清空前发出的旧统计回包
          localStats = { videos: 0, total: 0, current: 0 };
          localStatsSeq++;
          refreshLocalStats(videoId);
        });
      });
    };
    // 先数一下有几个视频再清（清完就只剩 0 了，提示里想写清楚到底清了什么）
    try {
      chrome.storage.local.get('dts_videos', function (o) {
        var n = 0;
        try { n = (o && o.dts_videos) ? Object.keys(o.dts_videos).length : 0; } catch (e) { n = 0; }
        finish(n);
      });
    } catch (e) {
      finish(0);
    }
  }

  /** 「本地已存」一句话摘要（面板 note 与提示都用它，口径一致） */
  function localStatsNote() {
    return '本机已存：'
      + (localStats.total ? (localStats.videos + ' 个视频 / ' + localStats.total + ' 条') : '暂无')
      + '（含其它视频）；本条视频本地已有 ' + localStats.current + ' 条';
  }

  /** 读一次本地已存规模（跨视频统计）。失败/上下文失效就静默（面板还有 bgOk/bgErr 那条链路）。 */
  function refreshLocalStats(id) {
    if (extContextLost) return;
    var vid = (id === undefined) ? (videoId || pageViewId() || '') : id;
    var seq = ++localStatsSeq;
    try {
      chrome.runtime.sendMessage({ type: 'dts-stats', videoId: vid }, function (resp) {
        // 清空（或任何更新的请求）之后，旧回包必须丢弃，否则会把归零的数字又写回去
        if (seq !== localStatsSeq) return;
        if (chrome.runtime.lastError) {
          var le = chrome.runtime.lastError.message || '';
          if (isExtContextInvalid(le)) onExtContextLost(le);
          return;
        }
        if (!resp || !resp.ok) return;
        localStats = {
          videos: Number(resp.videoCount) || 0,
          total: Number(resp.totalAll) || 0,
          current: Number(resp.count) || 0
        };
        // 只在「note 还停在本地已存这句」时改写它，别覆盖采集流程刚写下的提示
        if (typeof noteText === 'string' && noteText.indexOf('本机已存') === 0) {
          noteText = localStatsNote();
        }
        render();
      });
    } catch (e) {
      if (isExtContextInvalid(e)) onExtContextLost(String((e && e.message) || e));
    }
  }

  /** 面板「导出范围」的两个小按钮：本条视频（默认，兼容旧行为）/ 全部视频 */
  function setExportScope(all) {
    exportAll = !!all;
    noteText = exportAll
      ? '导出范围：全部视频（所有视频的评论合成一份；CSV 末尾多一列 video_id）'
      : '导出范围：本条视频（只导当前这条视频链接的评论）';
    render();
  }

  function exportAs(format) {
    // 必须用 videoId —— 本视频采到的评论就存在这个键下（background 按 videoId 分池）。
    // 不能现场重新识别：用户滚到别的视频后再点导出，重识别会得到新 ID，
    // 于是导出一个空池，看起来像「数据丢了 / 导出的是别的视频」。
    var vid = videoId || pageViewId();
    if (!vid && !exportAll) {
      errText = '未识别到视频 ID，无法导出本条视频；可把导出范围切到「全部视频」导出本地已存的评论';
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
    noteText = exportAll
      ? '正在导出全部视频…（所有视频的评论合成一份；若弹出「另存为」对话框，请选择保存位置）'
      : '正在导出本条视频…（若弹出「另存为」对话框，请选择保存位置）';
    render();
    try {
      chrome.runtime.sendMessage({ type: 'dts-export', videoId: vid, format: format, all: exportAll }, function (resp) {
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
          errText = '导出失败：' + ((resp && resp.error) || '未知错误')
            + (resp && resp.hint ? '（' + resp.hint + '）' : '');
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

  function mkBtn(text, extraClass, onClick, act) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'dts-btn' + (extraClass ? ' ' + extraClass : '');
    b.textContent = text;
    // 给自动化（采集器的 clearBefore、回归脚本）一个稳定挂点：
    // 按文案匹配在「清空」旁边多了「全部清空」之后会变得含糊（两个都含「清空」）。
    if (act) b.setAttribute('data-dts-act', act);
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

  // ---- 面板「设置」浮层（v0.2.4） ----
  // 为什么做在扩展面板里、而不是只放在 DSH 的「设置 → 插件」：用户反馈「按钮在哪」——
  // 独立装的扩展（不经过 DSH）根本没有 DSH 设置页可用，设置必须跟着面板走。
  // 存的 dts_user_settings 优先级高于 DSH 插件下发的 dts_settings（见 loadRuntimeSettings）。
  var SETTING_FIELDS = [
    { key: 'maxCount', label: '目标条数 max', min: 0, max: MAX_COUNT_HARD_MAX, step: 50, title: '采到这么多条一级评论就自动收工（等同 DSH 插件的 max）；0 = 不限（二级回复会补完再停）' },
    // v0.2.15 起顶层列表**错峰多路**真正生效（默认 3 路、每路 200ms 错峰）。
    // 2026-10-07 实测：同一瞬间发多路会被服务端并成同一页（4 路 Σ200 条只去重出 56 条），
    // 错峰 200ms 就正常；扫完 21 页单路 15.8s vs 错峰 4 路 7.7s，唯一 cid 一样多。
    { key: 'lanes', label: '顶层并发路数', min: 1, max: LANES_HARD_MAX, step: 1, title: '顶层列表同时推进几路：1 = 老老实实单路；内置默认 3，每路错峰 200ms 出发。一旦发现两路拿到同一页（服务端合并并发请求）会自动降回单路并在面板说明。' },
    { key: 'replyLanes', label: '回复并发', min: 1, max: LANES_HARD_MAX, step: 1, title: '二级回复同时拉几条线程：1~8，内置默认 4' },
    { key: 'replyGapMs', label: '回复间隔 ms', min: 0, max: 60000, step: 100, title: '同一线程两次回复请求之间的间隔，内置默认 600ms' },
    { key: 'replyThrottleSec', label: '限流等待 s', min: 10, max: 600, step: 10, title: '服务端暂时不回数据时，本轮**总共**最多等这么久（分波重试：单波 12 秒，波间停 15/30/60 秒）。内置 120 秒；设 10 = 老行为「十秒不行就收尾」' },
  ];

  function clampInt(v, lo, hi, dflt) {
    var n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.max(lo, Math.min(Math.round(n), hi));
  }

  /** 存储对象 → 输入框值（缺项用当前生效值兜底，replyThrottleMaxWaitMs 换成秒显示） */
  function settingsToInputs(st) {
    var pick = function (k, dflt) {
      return (st && st[k] !== undefined && st[k] !== null) ? Number(st[k]) : dflt;
    };
    return {
      maxCount: pick('maxCount', RS.maxCount),
      lanes: pick('lanes', RS.lanes),
      replyLanes: pick('replyLanes', RS.replyLanes),
      replyGapMs: pick('replyGapMs', RS.replyGapMs),
      replyThrottleSec: Math.round(pick('replyThrottleMaxWaitMs', RS.replyThrottleMaxWaitMs) / 1000),
    };
  }

  /** 输入框值 → 存储对象（逐项钳位；本键一旦存在就是「整套面板偏好」，逐项都写） */
  function inputsToSettings(v) {
    return {
      maxCount: clampInt(v.maxCount, 0, MAX_COUNT_HARD_MAX, 0),
      lanes: clampInt(v.lanes, 1, LANES_HARD_MAX, MAX_LANES),
      replyLanes: clampInt(v.replyLanes, 1, LANES_HARD_MAX, REPLY_LANES),
      replyGapMs: clampInt(v.replyGapMs, 0, 60000, REPLY_GAP_MS),
      replyThrottleMaxWaitMs: clampInt(v.replyThrottleSec, 10, 600, Math.round(REPLY_THROTTLE_MAX_WAIT_MS / 1000)) * 1000,
    };
  }

  function settingsSummaryText() {
    // v0.2.15：顶层默认错峰多路（内置 3 路 / 每路错峰 200ms）。摘要里如实写**设置值**；
    // 某一轮若因「两路同页」被自动降成单路，`dts_settings_effective.lanesNote` 会另附说明。
    return '顶层 ' + (RS.lanes > 1 ? RS.lanes + ' 路错峰（' + LANE_STAGGER_MS + 'ms）' : '单路') +
      ' · 目标 ' + (RS.maxCount > 0 ? RS.maxCount + ' 条' : '不限') +
      (hasUserSettings ? '（面板）' : '');
  }

  function fillSettingsInputs(st) {
    if (!ui || !ui.inputs) return;
    var vals = settingsToInputs(st);
    SETTING_FIELDS.forEach(function (f) {
      var el = ui.inputs[f.key];
      if (el) el.value = String(vals[f.key]);
    });
  }

  function openSettings() {
    if (!ui || !ui.settings) return;
    if (ui.root) {
      ui.root.classList.remove('dts-collapsed');      // 收起态点齿轮：先展开，否则浮层压着一条标题栏
      ui.root.classList.add('dts-settings-open');     // 让面板撑高到够放 5 行设置（panel.css §9）
    }
    loadUserSettings(function (st) { fillSettingsInputs(st); });
    ui.settings.classList.remove('dts-hidden');
  }

  function closeSettings() {
    if (ui && ui.settings) ui.settings.classList.add('dts-hidden');
    if (ui && ui.root) ui.root.classList.remove('dts-settings-open');
  }

  function readSettingsInputs() {
    var v = {};
    SETTING_FIELDS.forEach(function (f) {
      var el = ui.inputs[f.key];
      v[f.key] = el ? el.value : undefined;
    });
    return v;
  }

  function saveSettings() {
    var st = inputsToSettings(readSettingsInputs());
    try {
      chrome.storage.local.set({ dts_user_settings: st }, function () {
        hasUserSettings = true;
        // 立刻反映到面板摘要与当前生效值：不用等下一次开始采集
        RS = {
          lanes: st.lanes,
          maxCount: st.maxCount,
          replyLanes: st.replyLanes,
          replyGapMs: st.replyGapMs,
          replyWarmupMs: RS.replyWarmupMs,
          replyThrottleMaxWaitMs: st.replyThrottleMaxWaitMs,
          replyGlobalGapMs: RS.replyGlobalGapMs,   // 面板不管这项，别在保存时丢掉
        };
        noteText = '设置已保存：并发 ' + st.lanes + ' 路 · 目标 ' +
          (st.maxCount > 0 ? st.maxCount + ' 条' : '不限') + ' · 回复并发 ' + st.replyLanes +
          ' · 限流等待 ' + (st.replyThrottleMaxWaitMs / 1000) + 's（下次开始采集生效）';
        closeSettings();
        render();
      });
    } catch (e) {
      errText = '设置保存失败：' + String(e);
      render();
    }
  }

  function resetSettings() {
    try {
      chrome.storage.local.remove(USER_SETTINGS_KEY, function () {
        hasUserSettings = false;
        noteText = '已恢复默认（删掉面板偏好，回到 DSH 插件设置 / 内置常量）';
        fillSettingsInputs(null);
        render();
      });
    } catch (e) {
      errText = '恢复默认失败：' + String(e);
      render();
    }
  }

  function buildSettingsBox(root) {
    var box = document.createElement('div');
    box.className = 'dts-settings dts-hidden';

    var head = document.createElement('div');
    head.className = 'dts-row dts-settings-head';
    var t = document.createElement('span');
    t.textContent = '设置';
    var tools = document.createElement('div');
    tools.className = 'dts-tools';
    tools.appendChild(mkBtn('×', 'dts-btn-collapse', function () { closeSettings(); }));
    head.appendChild(t);
    head.appendChild(tools);
    box.appendChild(head);

    // 当前生效值（原来挂在第三行按钮旁边，v0.2.5 起移进浮层，面板更干净）
    var cur = document.createElement('div');
    cur.className = 'dts-row dts-muted dts-settings-summary';
    cur.setAttribute('title', '当前生效值：面板设置 > DSH 插件下发 > 内置常量');
    box.appendChild(cur);

    var inputs = {};
    SETTING_FIELDS.forEach(function (f) {
      var r = document.createElement('div');
      r.className = 'dts-row dts-field';
      r.setAttribute('title', f.title || '');
      var l = document.createElement('span');
      l.className = 'dts-field-label';
      l.textContent = f.label;
      var inp = document.createElement('input');
      inp.type = 'number';
      inp.className = 'dts-input';
      inp.min = String(f.min);
      inp.max = String(f.max);
      inp.step = String(f.step);
      r.appendChild(l);
      r.appendChild(inp);
      box.appendChild(r);
      inputs[f.key] = inp;
    });

    var hint = document.createElement('div');
    hint.className = 'dts-row dts-muted dts-settings-hint';
    hint.textContent = '保存后立即生效（下一次「开始采集」用新值）。面板里设过的项优先于 DSH 插件设置；点「恢复默认」交回插件/内置值。';
    box.appendChild(hint);

    var btns = document.createElement('div');
    btns.className = 'dts-row dts-actions';
    btns.appendChild(mkBtn('保存', 'dts-btn-primary', function () { saveSettings(); }));
    btns.appendChild(mkBtn('恢复默认', '', function () { resetSettings(); }));
    btns.appendChild(mkBtn('关闭', '', function () { closeSettings(); }));
    box.appendChild(btns);

    root.appendChild(box);
    return { box: box, inputs: inputs, cur: cur };
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
    // 齿轮（v0.2.5）：跟「—」同一行、在它左边，比原来第三行的「设置」文字按钮省地方
    var gear = mkBtn('⚙', 'dts-btn-gear', function () { openSettings(); });
    gear.setAttribute('title', '设置：目标条数 max / 并发路数 / 回复档位（面板 > 插件 > 内置）');
    gear.setAttribute('aria-label', '设置');
    tools.appendChild(gear);
    tools.appendChild(mkBtn('—', 'dts-btn-collapse', function () {
      closeSettings();
      root.classList.toggle('dts-collapsed');
    }));
    head.appendChild(name);
    head.appendChild(tools);

    var body = document.createElement('div');
    body.className = 'dts-panel-body';

    var refs = {};
    refs.phase = row(body, '阶段');
    refs.count = row(body, '已采（去重）');
    // v0.2.9：换视频后这一行仍然显示「本地已存 N 个视频 / M 条（本条 X 条）」，
    // 让用户一眼看到旧视频的评论还在本地（面板计数是按当前视频重置的，别误解成数据丢了）
    refs.local = row(body, '本地已存');
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
    body.appendChild(r2);

    // v0.2.9：导出范围。「本条视频」= 旧行为（当前视频那个桶）；「全部视频」= 把所有视频的评论合成一份。
    // 用户报过「滑到下一条视频点开始采集，上一条的数据没了」——分开视频存的数据仍在，
    // 只是导出/计数都只认当前视频，所以必须给一个显式的「全部视频」出口。
    var rScope = document.createElement('div');
    rScope.className = 'dts-row dts-actions dts-scope';
    var scopeLabel = document.createElement('span');
    scopeLabel.className = 'dts-muted dts-scope-label';
    scopeLabel.textContent = '导出范围';
    rScope.appendChild(scopeLabel);
    var btnScopeVideo = mkBtn('本条视频', 'dts-btn-scope dts-on', function () { setExportScope(false); }, 'export-scope-video');
    btnScopeVideo.title = '只导出当前这条视频链接的评论（旧行为）';
    rScope.appendChild(btnScopeVideo);
    var btnScopeAll = mkBtn('全部视频', 'dts-btn-scope', function () { setExportScope(true); }, 'export-scope-all');
    btnScopeAll.title = '导出本地已存的**所有**视频的评论（合成一份；CSV 末尾多一列 video_id）';
    rScope.appendChild(btnScopeAll);
    body.appendChild(rScope);

    // 清空拆成两个按钮：范围完全不同，不能共用一个入口
    //   「清空」    —— 只清本条视频链接的评论（其它视频、面板设置都保留）
    //   「全部清空」—— 清掉所有视频的评论与本地去重表（不可恢复，两步确认）
    var r3 = document.createElement('div');
    r3.className = 'dts-row dts-actions';
    var clearBtn = mkBtn('清空', '', onClearClick, 'clear-video');
    clearBtn.title = '只清空本条视频链接的评论与本地去重记录（其它视频的数据保留）';
    r3.appendChild(clearBtn);
    var clearAllBtn = mkBtn('全部清空', 'dts-btn-danger', onClearAllClick, 'clear-all');
    clearAllBtn.title = '清空所有视频的评论与本地去重表，不可恢复；需连点两次确认';
    r3.appendChild(clearAllBtn);
    body.appendChild(r3);

    // 设置入口在标题栏的齿轮里（buildPanel 顶部），这里不再占一行
    root.appendChild(head);
    root.appendChild(body);
    // 设置浮层：面板内的模态层（absolute 覆盖整个面板），默认隐藏
    var sbox = buildSettingsBox(root);
    (document.body || document.documentElement).appendChild(root);

    refs.root = root;
    refs.dot = dot;
    refs.head = head;
    refs.summary = sbox.cur;
    refs.settings = sbox.box;
    refs.clearAll = clearAllBtn;   // render() 里同步「全部清空」的上膛文案/配色
    refs.scopeVideo = btnScopeVideo;
    refs.scopeAll = btnScopeAll;
    refs.inputs = sbox.inputs;
    ui = refs;
    makeDraggable(root, head);
    render();
    // 先 render 再读位置：旧版存的是相对右下角的 {dx,dy}，换算成绝对坐标需要
    // 面板已经在默认位置上有真实 rect（异步回调，不阻塞首屏）
    loadPanelPos();
    // 回显一次面板设置（决定摘要里显不显示「（面板）」）
    loadUserSettings(function (st) { hasUserSettings = !!st; fillSettingsInputs(st); render(); });
    // 本地已存规模：立刻读一次，之后每 20 秒刷新（别的标签页/AI 桥在采时也能看到总量变化）
    refreshLocalStats();
    if (!localStatsTimer) {
      localStatsTimer = setInterval(function () {
        if (!ui || document.hidden || extContextLost) return;
        refreshLocalStats();
      }, 20000);
    }
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
    ui.count.textContent = seen.size + ' 条' + (savedCount ? '（落库 ' + savedCount + '）' : (localStats.current ? '（本地已有 ' + localStats.current + ' 条）' : ''));
    if (ui.local) {
      // 跨视频口径：本条视频的历史数据也在这行里点出来，避免「换视频 = 数据没了」的误解
      ui.local.textContent = localStats.videos
        ? (localStats.videos + ' 个视频 / ' + localStats.total + ' 条' + (localStats.current ? '（本条 ' + localStats.current + ' 条）' : ''))
        : '暂无';
    }
    ui.total.textContent = total ? String(total) : '未知';
    ui.cursor.textContent = String(cursor);
    ui.ms.textContent = lastMs ? lastMs + ' ms' : '—';
    ui.note.textContent = noteText || '';
    ui.err.textContent = errText || '';
    if (ui.summary) ui.summary.textContent = '当前：' + settingsSummaryText();

    // 「全部清空」上膛态：按钮文案/配色跟着走（否则用户不知道第一次点击已经生效）
    if (ui.clearAll) {
      var armed = !!clearAllArmedAt && (Date.now() - clearAllArmedAt) <= CLEAR_ALL_CONFIRM_MS;
      var want = armed ? '确认全部清空？' : '全部清空';
      if (ui.clearAll.textContent !== want) ui.clearAll.textContent = want;
      if (armed) ui.clearAll.classList.add('dts-armed');
      else ui.clearAll.classList.remove('dts-armed');
    }

    if (total > 0) {
      var pct = Math.max(0, Math.min(100, (seen.size / total) * 100));
      ui.fill.style.width = pct.toFixed(2) + '%';
      ui.bar.classList.remove('dts-bar-indeterminate');
    } else {
      // total 未知 → 不确定态，不显示虚假完成度
      ui.fill.style.width = '0%';
      ui.bar.classList.add('dts-bar-indeterminate');
    }

    // 导出范围按钮的选中态（两个按钮互斥）
    if (ui.scopeVideo && ui.scopeAll) {
      if (exportAll) { ui.scopeAll.classList.add('dts-on'); ui.scopeVideo.classList.remove('dts-on'); }
      else { ui.scopeVideo.classList.add('dts-on'); ui.scopeAll.classList.remove('dts-on'); }
    }

    // 镜像到主世界，供 __DTS_COLLECTOR__.getStatus() 读取（隔离世界的变量外部拿不到）
    down('status', {
      phase: phase, videoId: videoId, cursor: cursor, pages: pages,
      unique: seen.size, total: total, savedCount: savedCount,
      // v0.2.13：**一级评论**去重条数（seen 混了一二级）——maxCount 与采集器的 max 都用它
      topSeen: topSeenCount,
      localStats: localStats, exportAll: exportAll,
      lastMs: lastMs, failStreak: failStreak, running: running,
      signedAt: signedAt,
      error: errText, note: noteText,
      // 扩展后台可达性（采集器据此自愈：不可达时刷新页面重新注入脚本）
      bgOk: bgOk, bgErr: bgErr, bgCheckedAt: bgCheckedAt,
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

  // 扩展后台可达性：面板一出现就自测一次（采集器读它决定要不要刷新页面自愈），
  // 之后每 30 秒复测（页面被放到后台很久、MV3 回收 SW 后需要知道后台还在不在）。
  whenBody(function () { setTimeout(function () { probeBackground(); }, 200); });
  setInterval(function () { if (!extContextLost) probeBackground(); }, 30000);

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
      topSeen: topSeenCount,   // v0.2.13：一级去重条数（unique 含二级回复）
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
      bgOk: bgOk, bgErr: bgErr, bgCheckedAt: bgCheckedAt,
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
      topSeen: topSeenCount,   // v0.2.13：一级去重条数（采集器的 max 用它判定，别用混池的 unique）
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
      // all:true = 导出本地所有视频（与面板「导出范围 → 全部视频」同一条链路）
      var wantAll = !!(msg && msg.all === true);
      var vid = (msg && msg.videoId) || videoId || pageViewId();
      if (!vid && !wantAll) {
        sendResponse({ ok: false, error: '未识别到视频 ID，无法导出本条视频；可传 all:true 导出本地已存的全部视频' });
        return false;
      }
      var format = msg && msg.format === 'json' ? 'json' : 'csv';
      errText = '';
      noteText = wantAll ? '正在导出全部视频…（AI bridge）' : '正在导出本条视频…（AI bridge）';
      render();
      chrome.runtime.sendMessage({ type: 'dts-export', videoId: vid, format: format, all: wantAll }, function (resp) {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message, videoId: vid });
          return;
        }
        if (resp && resp.ok) {
          sendResponse({
            ok: true, videoId: wantAll ? null : vid, scope: wantAll ? 'all' : 'video',
            format: format, filename: resp.filename, bytes: resp.bytes, path: resp.path || null,
            downloadId: resp.downloadId || null, count: resp.count, videoCount: resp.videoCount,
          });
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
