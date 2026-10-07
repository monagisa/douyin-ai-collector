# 跨文件协议（MVP 冻结版）

> 所有实现必须严格按本文件。改协议要先改本文件并通知所有实现者。
>
> **版本号（v0.5.15 起）**：扩展 / DSH 插件 / MCP **统一编号**，当前均为 `0.5.15`。正文里的 `v0.2.x` 是**扩展侧历史编号**：0.2.11↔发布 v0.5.9、0.2.12↔v0.5.10、0.2.13↔v0.5.11、0.2.14↔v0.5.12、0.2.15↔v0.5.13/v0.5.14。

## 0. 文件边界（禁止跨界写入）

| 归属 | 路径（相对仓库根） | 允许写什么 |
|---|---|---|
| Lead | `douyin-collector/manifest.json`、`background.js`、`PROTOCOL.md`、`README.md`、`INSTALL.md` | 只这些 |
| 实现者 A | `douyin-collector/hook.js`、`content.js` | 只这两个 |
| 实现者 B | `douyin-collector/panel.css`、`douyin-collector-test/*` | 只这些 |
| AI Hub / MCP | `douyin-mcp/*` | 只这些（独立包，不写入扩展目录） |

**实现者 B 的测试脚本绝不可写入 `douyin-collector/`**；测试 profile 仅本地使用，**禁止提交 Git**（见仓库 `.gitignore`）。旧说明中的绝对路径 `D:\dycopy\...` 仅作者本机有效，文档一律改用相对路径。

## 1. 主世界 ↔ 隔离世界 桥（`window.postMessage`）

固定 magic 字段，方向用 `dir` 区分。**两个方向都必须校验 magic**。

```js
// hook.js  →  content.js   （上行）
window.postMessage({ __dts_collector: 'DTS_COLLECTOR', dir: 'up', type: '...', payload: {...} }, '*');

// content.js → hook.js     （下行）
window.postMessage({ __dts_collector: 'DTS_COLLECTOR', dir: 'down', type: '...', payload: {...} }, '*');
```

### 上行消息类型

| type | payload | 说明 |
|---|---|---|
| `hook-ready` | `{ href }` | hook 安装完成 |
| `signed` | `{ url, keys, at }` | 截获到页面自己发出的带签名评论请求。`url` 是完整 URL 字符串，`keys` 是 query 参数名数组，`at` 是 `Date.now()` |
| `captured` | `{ items: [...], from }` | 采集到的评论对象数组。**攒批发送**，不要一条一条发 |
| `replay-result` | `{ ok, cursor, status, got, next, total, hasMore, ms, error }` | 一次重放的结果 |

### 下行消息类型

| type | payload | 说明 |
|---|---|---|
| `replay` | `{ cursor, count }` | 请求主世界用已截获的签名 URL 重发一次（只改 `cursor`/`count`） |
| `start-capture` | `{}` | 开始把页面自己发出的评论响应攒批上报 |
| `stop-capture` | `{}` | 停止上报 |

## 2. `hook.js` 必须导出的对象接口

**必须在主世界挂一个全局对象**，供 `chrome.scripting.executeScript` 的 `func` 回调调用（content.js 用它做超时兜底读结果）：

```js
window.__DTS_COLLECTOR__ = {
  getSigned()            // → { url, keys, at } | null
  getBatch()             // → 取出并清空待上报缓冲，返回数组
  replay(cursor, count)  // → Promise<{ ok, cursor, status, got, next, total, hasMore, ms, error }>
  replayReply(parentCid, cursor, count)
                         // → Promise<{ ok, parentCid, cursor, status, got, next, total, hasMore, ms, error }>
  isCapturing()          // → boolean
  getStatus()            // → content.js 镜像过来的只读状态快照（测试/排障用）。v0.1.10 起含两个诊断字段：
                         //   `liveVideoId`（现场识别一次，**不写入** videoId）与
                         //   `hint`（= signHint()，当前页面形态该给用户的指引；测试可确定性地断言文案，
                         //    不必依赖是否真的进过 waiting-sign）
                         //   v0.2.9 起镜像还含 `localStats`（`{videos,total,current}`，「本地已存」那一行的数据源）
                         //   与 `exportAll`（导出范围是否选了「全部视频」，默认 false）
}
```

### `hook.js` 的硬性约束

1. **拦截**：包装 `window.fetch` 与 `XMLHttpRequest.prototype.open/send/setRequestHeader`。
   - `fetch`：用 `res.clone().text()` 读 body，**绝不消费原响应流**。
   - XHR：在 `loadend` 里读 `responseText`，**仅当 `responseType` 是 `''` 或 `'text'`**。
   - 包装后必须保留原生行为（`toString()` 里含 `native code` 的探测不要特意去骗，但**不要改变返回值和时序**）。
2. **URL 匹配**：`/\/aweme\/v1\/web\/comment\/list/i`（主列表）。二级回复是 `/\/aweme\/v1\/web\/comment\/list\/reply/i`（**正式路径已实测**：`GET /aweme/v1/web/comment/list/reply/`，参数 `item_id`(=aweme_id) / `comment_id`(顶层 cid) / `cut_version=1` / `cursor` / `count`，响应 `comments[] + total + has_more + cursor`；注意 `/comment/reply/` 是错路径 → 404）。
   **v0.1.5 起二级回复正式采集**（§2.8 / §3.8）；命中的回复 URL 仍只做有界记录（上限 20 条，备查）。
3. **签名 URL 捕获**：任何一次命中列表接口、且 URL 里含 `a_bogus=` 的请求，把完整 URL 存进 `signed`，并发 `signed` 上行消息。**每次捕获都覆盖更新**（保持新鲜）。
4. **重放实现**（`replay`）：
   ```js
   const u = new URL(signedUrl);
   u.searchParams.set('cursor', String(cursor));
   u.searchParams.set('count',  String(count));
   const t0 = performance.now();
   const res = await fetch(u.toString(), { credentials: 'include' });
   const j = JSON.parse(await res.text());
   ```
   - **只改 `cursor` 和 `count`，其余参数一个都不动。**
   - 返回 `{ ok: j.status_code === 0, status: j.status_code, got: (j.comments||[]).length, next: j.cursor, total: j.total, hasMore: j.has_more, ms, error }`
   - 若 `fetch` 或 `JSON.parse` 抛异常，返回 `{ ok:false, error:String(e), cursor }`。
   - **不要自己 sleep**，限速由 content.js 负责。
5. **签名新鲜度**：若 `signed` 为 null，`replay` 直接返回 `{ ok:false, error:'NO_SIGNED_URL' }`。
6. **采集缓冲**：**页面自己**发出的评论响应里的 `comments` 数组，push 进 `batch`。
   - 只在 `capturing === true` 时攒。
   - 单条响应体读取上限 `MAX_BODY = 2 * 1024 * 1024`（超限则跳过该条并在 batch 里放一条 `{__oversize:true, bytes}` 标记，便于诊断）。
   - **上限保护**：batch 超过 500 条就立即发一次 `captured` 上行并清空，避免内存堆积。
7. **重放的响应不进 batch**（避免与「页面自己的采集流」重复计数）：重放结果只走 `replay-result`，由 content.js 决定是否要数据。
   - 重放的 `comments` 放在 `replay-result` 的 `items` 字段里一并返回。
   - > ⚠️ 本节与 §2.6 曾互相矛盾（§2.6 旧文写「含重放响应」），已修正为：**重放绝不进 batch**。
8. **重放必须用原生 fetch**：`hook.js` 自己包装了 `window.fetch`，重放若调用包装后的 `fetch`，会让重放响应被当成「页面自身的流量」再次 ingest，并错误刷新 `signed`。实现上要保存原生引用（如 `nativeFetch`）并 `nativeFetch.call(window, url, { credentials: 'include' })`。
9. **重放超时**：`REPLAY_TIMEOUT_MS = 15000`。上行消息一旦丢失，没有超时会让采集永久挂起；超时计入失败计数并走退避。

### 2.8 二级回复重放（`replayReply`，v0.1.5 新增）

**背景与依据**：顶层列表接口**不返回**二级回复，而服务端 `total` 把回复也算进去了
（2026-09-28 实测：差额的 76% 就是 Σ`reply_comment_total`）。实测还发现
**一个已捕获的签名，只把 `comment_id` 换掉就能拉任意线程**
（`probe-reply5.mjs`：4 条线程全部翻页拉全 221 / 61 / 52 / 43，零重试）。

**这是全文件唯一允许改 `pathname` 的地方**，改动范围严格限定为：

```js
const u = new URL(signedUrl);          // signedUrl = 页面自己发出的、带 a_bogus 的列表请求
const awemeId = u.searchParams.get('aweme_id');
u.pathname = '/aweme/v1/web/comment/list/reply/';
u.searchParams.delete('aweme_id');
u.searchParams.set('item_id', awemeId || '');
u.searchParams.set('comment_id', String(parentCid));
u.searchParams.set('cut_version', '1');
u.searchParams.set('cursor', String(cursor));
u.searchParams.set('count',  String(count));
// 其余几十个参数（含 a_bogus / msToken / verifyFp / host）原样透传
```

硬性约束：
- **签名仍然只来自页面**，不新签、不逆向、不伪造；`host` 沿用页面用过的那个。
- 除上表列出的字段外，**一个参数都不动**。
- 返回结构与 `replay` 一致，另加 `parentCid` 字段。
- 走 `down('replay-reply')` / `up('reply-result')`（协议 §1），**结果不进 batch**（同 §2.7）。
- `signed` 为 null 时返回 `{ ok:false, error:'NO_SIGNED_URL' }`。
- 暴露到主世界：`window.__DTS_COLLECTOR__.replayReply(parentCid, cursor, count)`；
  另有只读的 `getReplyUrls()` 供排障。

## 3. `content.js` 必须实现的行为

### 3.1 注入 hook
`document_start` 时：
```js
const s = document.createElement('script');
s.src = chrome.runtime.getURL('hook.js');
s.async = false;
(document.head || document.documentElement).appendChild(s);
s.onload = () => s.remove();
```

### 3.2 采集循环（核心）

状态：`phase ∈ idle | waiting-sign | collecting | replies | paused | done | error`
（`replies` = 顶层采完、正在补采二级回复，v0.1.5 新增，见 §3.8）

```
idle
 └─(点「开始采集」)─→ waiting-sign
        └─(收到 signed 上行)─→ collecting
             ├─ 每轮：replay(cursor, count) → 收 items → 去重 → 上报 background
             ├─ cursor 取响应里的 next（不是 lastCursor+count）
             ├─ 某一路「拿不满一页 且 hasMore === 0」→ 服务端列表触底：
             │      若 total>0、seen<total、本轮新增 ≥30、且轮数 <4
             │      → cursor 归零补扫（去重累加，最多 4 轮）；
             │      否则 → done，结束说明必须写明触底 offset 与
             │      「total 含二级回复/已删除评论，列表接口不再返回」
             ├─ 连续失败 >= 3 → paused（提示刷新页面，或按页面形态给出取证指引 `signHint()`）
             │      ⚠️ 但「越过列表末端」的 null 响应必须先归一成空页，不得计入失败（见下）
             └─ count 被服务端降到 5 且已采页数很少 → paused（登录态降级，提示重新登录）
```

> 触底是**服务端行为**，不是异常：实测（2026-09-28，`probe-tail.mjs`）视频
> `7667575725930679579` 的列表在 `offset=1500` 返回 `has_more=0`，此后每个
> cursor 都是空页，重试/换 `count`/换 `sort_type` 均无变化。
> **满页（`got === count`）却带 `has_more=0` 是矛盾信号，不得据此结束。**
> `total` 字段有噪声（同轮不同页会回 3170 / 50 / 12 / 0），**取历史最大值**，不可被尾页覆盖。

> **越过列表末端的响应是字面量 `null`，不是错误（v0.1.6 修正）**：实测
> （2026-09-28，`probe-replystale.mjs`）视频 `7667575725930679579` 的 `floor=1500`，
> `cursor ≤ 1500` 的 31 个请求**全部成功**，而 `cursor` 1550~7450 的 119 个请求
> **全部返回 HTTP 200 + body `null`**。`hook.js` 把它映射为
> `{ ok:false, error:'STATUS_NULL' }`，因此 `content.js` **必须**在判定失败之前把它归一成
> `{ ok:true, items:[], got:0, hasMore:0, next:null, endOfList:true }`。
> 否则每越过一次末端都会推高 `failStreak`，3 次就把「已经触底」误判成「签名失效」，
> 去要求用户手动滚动评论区 —— **这正是用户抱怨的「补采线程多时要我手动滚一下」的根源**。

**限速参数（写死在常量里，不要做成可配 UI）：**

```js
const COUNT = 50;              // 服务端单页硬上限 50（count=100/200 也只回 50）
const MIN_INTERVAL_MS = 400;   // 每轮之间最小间隔（服务端 p50=228ms，页面自身 ~444ms/页）
const JITTER_MS = 150;         // 0~150 随机抖动
const MAX_PAGES = 3000;        // 硬上限，防御死循环
const FAIL_STREAK_PAUSE = 3;   // 连续失败几次就暂停
const BACKOFF_BASE_MS = 3000;  // 失败退避基数
const BACKOFF_MAX_MS = 60000;  // 退避上限
const SIGN_STALE_MS = 8 * 60 * 1000; // 签名超过 8 分钟视为过期，暂停等新签名
const MAX_PASSES = 4;          // 触底后的最大扫描轮数（含首轮）
const RESCAN_MIN_NEW = 30;     // 本轮新增少于 30 条就不再补扫
```

每轮之间必须 `await sleep(MIN_INTERVAL_MS + Math.random() * JITTER_MS)`。

### 3.3 去重
主键 `cid`，用 `Set` 在内存里去重（background 里也会按 `cid` 再兜一次）。

### 3.4 上报 background
每轮结束（或每累计 ≥50 条）发一次：
```js
chrome.runtime.sendMessage({
  type: 'dts-comments',
  videoId, title, total, hasMore, signedUrlAt,
  comments: [ ...只保留必要字段的评论对象... ]
});
```
**落盘前裁剪**：只保留 `cid, text, create_time, digg_count, reply_comment_total, ip_label, is_hot, is_folded, level, stick_position, status, content_type, image_list, user`；`user` 只保留 `uid, nickname, sec_uid, unique_id, short_id, avatar_thumb`。**其余字段全部丢弃**（原始 `user` 有 65 个字段，不裁剪会让存储膨胀数倍）。
**v0.1.5 追加两个非接口字段**（不来自抖音，由 content.js 自己打）：二级回复的行会多出 `is_reply: true` 与 `parent_cid: <顶层 cid>`；顶层评论不带这两个字段。CSV 里对应**末尾追加**的两列 `is_reply` / `parent_cid`（前 15 列的顺序与含义保持不变，老读者按位置读前 15 列仍然正确）。

### 3.5 videoId 提取（多源，且必须与「重放实际抓的视频」一致）
不再只认 `location.pathname`。实测三种页面形态 URL 长得完全不同，必须多源：
1. `location.pathname` 的 `/\/video\/(\d{15,25})/` —— 权威
2. `location.search` 的 `modal_id` —— 推荐页点开卡片后的浮层（`/jingxuan?modal_id=<id>`）
3. 页面自己发的 `comment/list` 请求里的 `aweme_id`（hook 随 `signed` 事件上行）
4. DOM 的 `[data-aweme-id]` —— 推荐页网格（`/jingxuan`，URL 里什么都没有）

判据：URL 命中就用 URL；URL 没命中时要求「签名里的 aweme_id」与「DOM 当前卡片」**互相佐证**，
不一致就返回 null（宁可让用户重开，也不猜）。

**⚠️ v0.1.9 曾把「推荐页」和「精选页」当成同一个页面，指引是错的（用户 m06103 纠正）。
v0.1.10 实测定案：两者是两个不同的页面形态，必须分开处理（`pageKind()`）**：

**推荐页 `https://www.douyin.com/?recommend=1`（`pageKind()==='recommend'`）**：
- 它是**全屏单视频滑动流**（不是网格）：`[data-e2e="feed-item"]` / `feed-video` 一屏一条，
  右侧竖排 `video-player-digg` / **`feed-comment-icon`** / `video-player-collect` / `video-player-share`。
- **完全没有 `[data-aweme-id]`**（`probe-rec5.mjs` 实测可见 id 数 0）⇒ 推荐页识别 ID **不能**靠它。
  当前这条视频的 id 只在 slide 的 **class 名**里：
  `<div data-e2e="feed-video" class="NhEiLku8 video_7675959070997695782 sliderVid">`
  ⇒ 实现用 `awemeIdFromClass(el)`（正则 `/(?:^|\s)video_(\d{15,25})(?:\s|$)/`）抠，并沿在播 `<video>`
  往上 ≤20 跳找（`awemeIdFromPlayingVideo()`），兜底用 `nearestVisible('[data-e2e="feed-item"],[data-e2e="feed-video"]', awemeIdFromClass)`。
  该 class id 与签名里的 `aweme_id` 一致（`run-recommend-collect.mjs` R4 断言）。
- 自动化环境里 **直接 `goto ?recommend=1` 会在 2 秒~20 秒内被弹回 `/jingxuan`**（`probe-recommend2.mjs`
  20/20 被弹；抹掉自动化指纹后 `probe-rec3.mjs` 能留约 18 秒）；而**先落 `/jingxuan`、再用真实鼠标点
  导航栏「推荐」**（坐标约 (80,120)，class `kCzNsmN5`）能稳定停在 `?recommend=1`（`probe-rec4.mjs` 12 秒、
  `probe-rec5.mjs` 连续采样 60 秒一次没掉）。DOM `.click()` 不触发这个 SPA 路由，必须真实鼠标点击。
- ⇒ 推荐页滑到下一条视频时 **URL 不变**（还是 `/`）⇒ `pageKey()` 必须把 DOM 里当前视频的 id 算进去
  （返回 `'d:'+awemeIdFromDom()`），否则旧签名不会被作废，上一条的评论会被记到下一条名下。

**精选页 `/jingxuan`（`pageKind()==='grid'`）—— 这才是 v0.1.9 实测的那个页面**：
- 它是**网格页**：URL 里没有任何视频 ID（只有 DOM 的 `[data-aweme-id]`，实测 29 个），
  点开卡片才变成 `?modal_id=<id>` 浮层（此时 `liveVideoId === modal_id`，实测通过）。
- **页面在评论区真的被打开之前不会发任何评论请求**：`probe-feed-net.mjs` 监听全部
  `/aweme/v1/web/` 请求 —— 打开精选页 + 点开浮层 + 鼠标点评论图标，页面共发 **26 个 API 请求、
  评论类 0 个**。所以精选页（推荐页同理）**不可能**靠「滚动评论区」拿到签名：那里根本没有常驻评论区，
  旧文案把用户往错的方向指（这正是用户 m05852 的阻塞点）。
- 评论入口是 `[data-e2e="feed-comment-icon"]`（文本就是评论数，如 `309`）。`probe-feed-drawer.mjs`
  实测：Playwright `locator.click()` 与鼠标坐标点击**都点不动**（被遮挡/不稳定，`Timeout 8000ms exceeded`），
  而 DOM 的 `el.click()` + `el.parentElement.click()` 能打开抽屉 → 页面发出 2 条评论请求、签名到手
  且 `aweme_id === modal_id`（`7684995214813023497`），随后采集正常（`unique=639`、total 1317）。
- 评论列表的 host 是 **`www-hj.douyin.com`**（不是 `www.douyin.com`），路径仍是
  `/aweme/v1/web/comment/list/?…&aweme_id=<id>`；`hook.js` 的 pattern 与 host 无关，照常命中。
- ⇒ 实现约束（v0.1.10）：`pageKind()` 分五态 —— `'overlay'`（有 `modal_id`）/ `'recommend'`
  （`recommend=1` 或 pathname `/`）/ `'detail'`（`/video/<id>`）/ `'grid'`（`/^\/(jingxuan|recommend)/`）/ `'other'`；
  `isFeedPage()` 保留为 `recommend|grid|overlay` 的包装（旧调用点与断言不破）。等待签名的文案统一由
  `signHint()` 给：overlay/recommend → 「点一下视频右侧那个带数字的「评论」图标」；grid → 「先点开一个视频
  （点卡片开浮层），再点视频右侧那个带数字的「评论」图标」；detail/other 才说「滚动评论区一次」。
  三处等待文案（签名过期、连续失败暂停、`onStartClick`）都拼它。

**⚠️ v0.1.11 及以前「按 URL 清单分支」是错的（用户 m07300：「你设计的页面采集是写死的，还有些
比如关注，朋友，我的，在这些页面的内容是用不了的」）。v0.1.12 起改成按 DOM 判形态（`pageMode()`）**：
- `probe-pages2.mjs` 实测（`_pages2sum.txt`）：左侧导航真实 href 是 `关注 /follow`、
  `朋友 /friend`、`我的 /user/self`。关注/朋友页的 DOM 与推荐页**同构**（`[data-e2e="feed-active-video"]`
  + 可见 `feed-comment-icon`，class 里有 `video_<id>`），却因为 URL 不在旧清单里被 `pageKind()`
  判成 `'other'` ⇒ 指引错成详情页那句「滚动评论区」（那页根本没有常驻评论区）。
- 我的 `/user/self`：`[data-aweme-id]` 与 `<video>` **全是 0×0**（不可见），id 只在
  `a[href*="/video/"]` 的链接里；旧识别链没有 href 这一路 ⇒ 点「开始采集」直接 `phase='error'`
  （「未识别到视频 ID」），这正是用户踩到的。
- v0.1.12 的通用识别链（`awemeIdFromDom()`，任何页面都走同一条）：
  ① 正在播的 `<video>` 往上 ≤20 跳（`awemeIdFromPlayingVideo()`）；
  ② 可见的 `[data-e2e="feed-active-video"]`（关注/朋友/推荐这类全屏 feed 的「当前视频」）；
  ③ 视口内离中心最近的视频元素（`VIDEO_EL_SEL` = `feed-active-video` / `feed-item` / `feed-video` /
     `[data-aweme-id]` / `a[href*="/video/"]`），逐个用 `awemeIdFromEl()` 抠 id；
  ④ 全文档兜底：`[class*="video_"]` 里第一个自身 class 带 `video_<id>` 的（`awemeIdByClassToken()`）。
  其中 `awemeIdFromEl(el)` = 「自身 `data-aweme-id`」→「自身/子孙 `a[href*="/video/"]` 的 URL」→
  「自身或子孙 class 的 `video_<id>`」三路，覆盖上述所有页面。
- `pageMode()`：`detail`/`overlay` 仍看 URL（这两个 URL 形态本身无歧义），其余**一律看 DOM** ——
  有「占据 ≥50% 视口的在播视频 / 可见 `feed-active-video`」→ `'feed'`；否则有可见卡片
  （`a[href*="/video/"]` 或 `[data-aweme-id]`）→ `'grid'`；否则 `'unknown'`。
  ⚠️「≥50% 视口」这条是必须的：作品网格里卡片上的小视频也会自动播，不加这条「我的」页会被误判成 feed。
- 行为只依赖 mode：`autoOpenComments()` 只在 `feed/overlay/detail/unknown` 自动点评论入口，
  `grid` 一律 `no-target:grid` 不点（见 §4 第 14 项）；`signHint()` 按 mode 给文案
  （feed → 「一屏一条视频…点视频右侧带数字的「评论」图标」，grid → 「先点开一条作品」，
  detail/unknown → 滚动评论区）——**彻底去掉详情页文案被 feed 页误用的 bug**。
- 页面切换**但仍在等签名**时（在作品网格上点了「开始采集」、用户随后点开一条作品），800ms 轮询会
  带着新形态重跑一次 `waitForNewSignature('page-changed', '')` ⇒ 「我的页点开作品后扩展自动接手」，
  不需要用户再点一次「开始采集」。
- 判据（`run-pages-collect.mjs`，25 项）：关注/朋友页点「开始采集」后 `phase==='collecting'`、
  `liveVideoId === 页面 class 里的 id`、`autoOpen` 以 `clicked:` 开头、hint 含「一屏一条视频」且不含「滚一下」；
  我的页点「开始采集」**不得**是 `error`（应为 `waiting-sign` + `autoOpen === 'no-target:grid'`），
  再用真实鼠标点开一条作品后 `liveVideoId === modal_id` 并真的采到评论。

**空评论面板不能再空等（v0.1.12 第 4 轮加固）**：`commentAreaOpen()` 靠「`comment-list` 容器
高度 > 60」判「已经打开」，但全屏 feed 页（关注 / 朋友）重载后容器可能已经渲染出来、里面
**一条评论都没有**：此时页面不会再发 `comment/list`，签名就永远等不到。2026-09-30
`run-pages-collect.mjs` 第三轮朋友页实测：`autoOpen=already-open` + `phase` 卡在 `waiting-sign`
（B3/B5 红），而同一页第二次跑（容器没渲染出来）反而能正常采集 —— 说明这就是「空等」而不是页面限制。
因此 `autoOpenComments()` 里「已经打开就不点」**必须先数 `[data-e2e="comment-item"]`**：
条目 > 0 才算真开好（`autoOpenLast = 'already-open'`，不碰页面）；条目 = 0 就照旧点入口，
逼页面重新拉一次评论（最多 `AUTO_OPEN_MAX` 次；`already-open` 文案只在真开好时出现）。
网格页（`mode === 'grid'`）仍然一次都不点，这条判断在它之后，不受影响。

**补点不能把抽屉点关（v0.1.12 第 5 轮）**：上面那条「空面板要点」只对**本轮第一次调用**
（`autoOpenCount === 0`）成立。本轮点过一次之后面板本来就是开的（评论可能还没渲染出来），
再点一下会把抽屉**关掉** —— 2026-09-30 第四轮 A5/C10 实测 `autoOpen=clicked:… n=2 areaOpen=false`
（签名早已拿到、评论也采到了，只是断言时面板是关的）。所以判据是
`if (nItems > 0 || autoOpenCount > 0)`；补点只在「面板真没开」时才会真的再点，原意（点了没反应就补点）
保持不变。（v0.1.13 起该判据拆成两段，见下。）

**换页后残留的评论面板不能被当成「已经打开」（v0.1.13；用户 m07969）**：`commentAreaOpen()` 原来
只要 DOM 里存在 `[data-e2e="comment-item"]` 就返回 true，但 SPA 换视频后**上一个视频的评论层会留在
DOM 里**——2026-09-30 `run-switch-clear.mjs` 实测 `items=10 itemsVis=0 itemsInActive=10
lists=[0x0@0,0 hidden]`（10 条条目全是 0×0 / hidden）。于是新视频一上来就被判成「评论区已经打开」
⇒ `autoOpenLast='already-open'`、一次都不点 ⇒ 新视频永远不发 `comment/list` ⇒ 签名等不到
（用户现象：一直提示「上一个视频（A）的签名已作废」，手动点开评论区立刻就能采）。修法是三条判据一起用：
- `visibleCommentItemCount()`：只数 `visibleForClick()` 为真的 `[data-e2e="comment-item"]`；
- `commentAreaOpen()` 里 `comment-list` 容器也必须 `visibleForClick()`（隐藏容器不算「开着」）；
- `panelStateSuspect`（「这份开着的面板可能是换页前留下的」）：`onPageChanged()` 换页时置 `true`，
  `clickCommentEntry()`（本页点过入口）、`case 'signed'`（页面确实发了评论请求）时置 `false`。
`autoOpenComments()` 的 already-open 判定因此拆成两段：`autoOpenCount > 0` ⇒ 点过就不再点（会点关）；
`nItems > 0 && !panelStateSuspect` ⇒ 面板可信且真有评论才不碰；**否则必须点一次**逼页面重发评论。
判据 `run-switch-clear.mjs`（11 项）：/follow 采 A → 暂停 → 导航 /friend（A 的评论层残留）→ 清空 →
开始采集，必须 2s 内出现 `autoOpen="clicked:…"` 且签名与落库 id 都是 B（修前 30s 干等、`already-open n=0`）。

**评论入口要选「视野中心那个」，催请求只能靠滚动（v0.1.13 修复 8）**：2026-09-30 `run-pages-collect.mjs`
实测两条现场（A 节 /follow 连点三次评论区一次没开；C 节浮层面板开着却拿不到签名），对应两个缺陷：
- **入口选择**：`firstVisibleWithin()` 原来取「第一个可见元素」，而 `visibleForClick()` 只要求与视口相交
  —— 上一屏视频的图标在顶部露 2px 也算可见，点下去就点到了**别的视频**的入口。改为 `bestVisibleEntry()`：
  按选择器优先级逐表处理，要求元素**中心**落在视口内，取离视口中心最近的那个。
- **催请求**：面板已经开着时「点过就不再点」（再点会把抽屉点关），但页面若直接用缓存渲染评论、不发新的
  `comment/list`，`waiting-sign` 就永远解除不了（hook 只认带 `a_bogus=` 的评论列表请求，见 §2.1）。
  新增 `nudgeCommentList()`：把 `[data-e2e="comment-list"]` 滚到底并派发一次 `WheelEvent`（`deltaY=1200`），
  最多 `NUDGE_MAX=3` 次，状态记 `autoOpenLast='scrolled:list'`，`waitingSignNote()` 有对应文案。
  滚动不会把抽屉点关（探针 `probe-autoopen.mjs` 实测滚动让 12 条 → 20 条，即页面真的发了新请求）。
- 诊断：`autoOpenLog`（上限 30 条）随状态镜像上行，链路上每一步（`enter:*` / `click:*` / `nudge:list` /
  `stop:*` / `retry-*`，以及 click 的 rect 与 cy）都留痕；pages E2E 的 A3/C8 会把它打出来。

**hook.js 必须最早期注入主世界（v0.1.13 修复 8b；A 节卡 waiting-sign 的真根因）**：`content.js` 在
`document_start` 用 `document.createElement('script')` 动态注入 `hook.js`，而**外部脚本是异步加载的**
—— 抖音自己的 bundle 常常先跑完并把 `window.fetch` 存成局部引用，之后所有评论请求都绕过 hook。实测
（`probe-follow-sign.mjs`，同一个 /follow 页面做 A/B）：reload 后页面发了 4 条带 `a_bogus` 的
`comment/list`（`type=fetch`、frame 就是当前页），`signedUp=0`、30s 停在 `waiting-sign`；不 reload
（纯 SPA 导航）则 `signedUp=1`、1.5s 进 `collecting`。修法：`manifest.json` 把 `hook.js` 声明成独立的
`"world":"MAIN"` + `"run_at":"document_start"` 内容脚本（`world` 需要 Chrome 111+，本扩展
`minimum_chrome_version` 已是 111），Chrome 会在页面脚本之前同步注入；`hook.js` 开头的
`__DTS_COLLECTOR_HOOKED__` 去重保护保证 `content.js` 那条动态注入兜底路径仍然安全。
判据：`probe-follow-sign.mjs` 的 reload 场景必须 `signedUp>=1` 且 5s 内 `phase=collecting`。

**跨视频污染防护（关键）**：重放用的签名 URL 里内嵌 `aweme_id`，`hook.replay()` 只改
`cursor`/`count`、不动 `aweme_id`。所以只要还在用视频 A 的签名，抓回来的就永远是 A 的评论。
因此：
- 落库标签 `videoId` 取**签名里的 aweme_id**（= 重放实际会抓的视频），保证标签与数据同源；
- 页面切换（`pageKey()` 变化）且能证明签名属于别的视频时，**作废签名**（`awemeIdFromSigned=null; signedAt=0`），
  走 `waiting-sign` 等页面为新视频发出评论请求后再继续；
- 采集途中若收到**别的视频**的签名，或 `pageViewId()` 显示已切走，立即暂停；
- 「导出」用当前 `videoId`（数据所在键），**不重新识别**。

**导出必须等下载进入终态（关键）**：`chrome.downloads.download()` 的 promise 在
**下载项被创建**时就 resolve，**不等于文件已经写盘**。因此 `background.js` 的
`download()` 必须用 `chrome.downloads.onChanged` 等到
`state==='complete' | 'interrupted'` 才回包（`in_progress` 也会被上报，**不是终态**）。
- `complete` → `{ ok:true, filename, bytes }`
- `interrupted` + `error==='USER_CANCELED'` → `{ ok:false, cancelled:true }`
- 面板在等待期间显示「正在导出…」，**不得**提前显示「已导出」。
默认 `const SAVE_AS = false`：直接落到浏览器下载目录、不弹对话框。
若改成 `true`，则每次导出弹原生「另存为」；上面「等终态」的约束在两种模式下都必须成立
（`saveAs:true` 时下载项会长时间停在 `in_progress` 等用户点确定，这正是旧代码撒谎的场景）。

### 3.6 UI 面板
- 容器 `id="dts-collector-panel"`，固定右下角，深色，`z-index: 2147483647`。
  **尺寸：只有紧凑一档，宽 236px（v0.1.15）**。v0.1.14 曾提供 `small`（236px）/`normal`（340px）
  两档 + 标题栏「大/小」按钮 + `chrome.storage.local.dts_panel_size` 持久化；用户在 m08775 明确
  「不用留大的了，已经完全能用了」⇒ v0.1.15 把 340px 那一档、`大/小` 按钮（`dts-btn-size`）、
  尺寸 class 与存储键**全部删除**：所有尺寸值（宽 236px、字号 11px、内边距/间距/按钮/进度条）
  直接写进 `panel.css` 的各条基础规则里，content.js 不再切任何尺寸 class，也不再读写
  `dts_panel_size`（老用户存过的 `'normal'` 被忽略，见判据 D17）。实现只写内联 `left/top` 做定位，
  尺寸完全归 CSS，两者解耦。
- 显示：阶段、已采条数、服务端 total、当前 cursor、进度条（`count/total`，`total` 为 0 时用不确定态）、每页耗时、错误信息。
- 按钮：`开始采集` / `暂停` / `导出 CSV` / `导出 JSON` / `本条视频` / `全部视频` / `清空` / `全部清空` / `—`（收起）。
  **v0.2.9 新增「导出范围」一行**（`.dts-row.dts-actions.dts-scope`，行首标签 `.dts-muted.dts-scope-label`
  文案 `导出范围`）：两个**互斥**小按钮
  · `本条视频`（默认选中，等于旧行为，只导当前这条视频；`data-dts-act="export-scope-video"`，
    选中带 `.dts-on`）
  · `全部视频`（把本地**所有**视频的评论合成一份导出；`data-dts-act="export-scope-all"`）
  点任一按钮走 `setExportScope(all)`：只改 `exportAll` 并刷新选中态与提示文案，**不动任何数据**；
  导出时由 `exportAs(format)` 把 `all: exportAll` 传给 `dts-export`（见 §3.10）。
  选中态互斥在 `render()` 里同步（`exportAll` 为真则 `scopeAll` 加 `.dts-on`、`scopeVideo` 去掉，反之亦然）。
  **状态镜像（v0.2.9 补充）**：`down('status', {...})` 新增 `localStats`（`{videos,total,current}`）与
  `exportAll`；`localStats` 由 `refreshLocalStats()` 读 `dts-stats` 后填充（面板构建时一次 + 每 20 秒
  一次 + 落库后 + 点「清空」后）。**v0.2.10 起** `refreshLocalStats()` 带请求序号 `localStatsSeq`，
  清空时作废在途的旧回包（见 §3.10），不再出现「清空后『本地已存』还显示旧数字」。
  **v0.2.8 起「清空」拆成两个按键**（用户 m04948 的原始诉求：「一个按键是全部清空，一个按键是清空（清空本条视频链接的评论）」）：
  · `清空`（`data-dts-act="clear-video"`，无 danger 类）= 只清**本条视频链接**的评论：删 `dts_c_<videoId>` 并从
  `dts_videos` 摘掉这一条，别的视频数据与 `dts_user_settings` 都不动。仍未识别到 videoId 时**不发清空**，
  提示「未识别到视频 ID，无法清空；请先打开具体视频页/浮层」（那条护栏只管这个按钮）。
  提示文案「已清空本视频的本地去重表与扩展存储；下次「开始采集」将从头重扫」。
  · `全部清空`（`data-dts-act="clear-all"`，`.dts-btn-danger`）= **两步确认**：第一次点只「上膛」——
  按钮文案变 `确认全部清空？` 并加 `.dts-armed`（红底强调），提示「再点一次「全部清空」确认：会清掉所有视频的评论与
  本地去重表（不可恢复），5 秒内有效」，**数据一条不动**；5 秒内第二次点才真清（删所有 `dts_c_*` 与 `dts_videos`，
  保留 `dts_user_settings`），提示「已清空全部视频的评论与本地去重表（共 N 个视频）…」；超过 5 秒文案自动复原，
  此时再点只重新上膛。**不受**未识别 videoId 的护栏限制（任意页面都能全清）。
  · **v0.2.10 起两个清空按钮都不会再假报「已清空」**：`sendClear(payload, onDone)` **等后台回包**
  （失败分三类 `SEND_FAILED:` / `CLEAR_REJECTED:` / `SEND_THREW:`，含 `EXT_CONTEXT_LOST`）；
  回包 `{ok:true}` 之后内容脚本**仍会**调 `verifyCleared(vid, all, cb)` —— **直接读回
  `chrome.storage.local` 自检**（`all=true` 查所有 `dts_c_*` 与 `dts_videos`；否则只查本条视频的桶
  与它在 `dts_videos` 里的记录），**后台回包与读回自检都过才显示「已清空」**；否则 `errText` 写明
  「清空没有生效」，并带「打开 `edge://extensions` 点『重新加载』，回到抖音页按 F5 刷新后再试」的指引。
  新增常量 `COMMENT_KEY_PREFIX = 'dts_c_'`；单视频「清空」与「全部清空」**两条路径都走自检**。
  语义不变：空 videoId 绝不兜底成全清、后台 `dts-clear` 仍要求显式 `all: true`、
  `全部清空` 仍是两步确认（`CLEAR_ALL_CONFIRM_MS = 5000`）。
  · 两个按钮都在面板最后一行 `.dts-row.dts-actions`（4 个按钮一行放不下）。`data-dts-act` 是给自动化的稳定挂点
  （`collector.mjs` 的 `clearBefore` 用 `[data-dts-act="clear-video"]` 点「清空」，老版本扩展没有挂点才退回按文案
  `/^清空$/` 找）；后台 `dts-clear` 仍然**要求 `all === true` 才全清**，空 videoId 绝不兜底成全清。
  · 真机验证（v0.2.8）：面板两按钮、单视频清空只清本条、第一次点全清只上膛不动数据、5 秒过期复原、
  第二次点真全清、`dts_user_settings` 始终保留 —— 18/18 全过。
  设置入口 **v0.2.5 起是标题栏右侧的齿轮 `⚙`**（`.dts-btn.dts-btn-gear`，排在 `—` 收起按钮**左边**，
  同一行 `.dts-tools` 内；v0.2.4 曾是第三行 `.dts-row.dts-actions` 里的「设置」文字按钮 + 摘要，
  v0.2.5 把这行去掉）。点齿轮弹出覆盖整个面板的浮层 `.dts-settings`（不改页面滚动），
  结构 = `.dts-settings-head`（`设置` + `×`）→ 一行「当前：并发 N 路 · 目标 M 条/不限（面板）」
  （`.dts-muted.dts-settings-summary`，取自 `settingsSummaryText()`）→ 5 个 `.dts-field`
  （第一项标签是 **`目标条数 max`**，对应 `maxCount`）→ 提示行 → 「保存 / 恢复默认 / 关闭」。
  浮层打开时 content.js 给容器加 `.dts-settings-open`（`panel.css` 据此把面板撑到 `min-height: 276px`，
  并让浮层子项 `flex: 0 0 auto` 不被压扁）；保存写 `dts_user_settings`（见 §3.9）；`×`、`关闭`、
  收起按钮都会先 `closeSettings()`。
- **样式全部写在 `panel.css`**（由实现者 B 提供）。content.js 里**不要写内联 style，不要注入 `<style>`**。DOM 用稳定的 class 名（`dts-btn` / `dts-btn-primary` / `dts-panel-body` / `dts-row` / `dts-bar` / `dts-bar-fill` / `dts-muted` / `dts-err`）。
- 面板必须可拖动或至少可收起，避免遮挡页面。**v0.1.8 起两者都有**：标题栏既是拖动把手
  （`pointerdown/move/up`，鼠标与触屏都可用），也是收起按钮所在行。
  位移由 content.js 写成容器上的 CSS 变量 `--dts-dx` / `--dts-dy`（`panel.css` 用
  `transform` 消费），所以**布局位置仍完全归 CSS**，content.js 不碰 `left/top`——
  与进度条写 `fill.style.width` 是同一种做法。位置存 `chrome.storage.local` 的
  `dts_panel_pos`（`{dx, dy}`），刷新页面后仍在原处；拖动时容器带 `.dts-dragging`；
  **双击标题栏复位**；拖动有边界（至少留 60px 宽 / 32px 高在视口内，防止拖出屏幕抓不回来）。
  **⚠️ 上面这段是 v0.1.8 的写法，v0.1.11 起已废弃**：位移不再走 CSS 变量，改成内联 `left/top`
  绝对坐标、存储改成 `{x,y}`（见 §4 第 14 项）；**v0.1.15 起**再给拖动加窗口级兜底
  （`pointermove/pointerup/pointercancel` 同时挂 `window`，见 §4 第 10 项）。
- 标题栏左侧有状态点 `.dts-dot`（档位 `dts-dot-idle` / `dts-dot-busy` / `dts-dot-warn` /
  `dts-dot-ok` / `dts-dot-err`，由当前阶段驱动），一眼能看出是在跑、在等签名还是已结束。

### 3.7 收消息
- `window.addEventListener('message', ...)`：只处理 `d.__dts_collector === 'DTS_COLLECTOR' && d.dir === 'up'`。
- **必须校验 `event.source === window`**，防止 iframe 伪造。

### 3.8 二级回复补采（v0.1.5 新增；**v0.2.14 起限流改「分波停顿重试」+ 总窗口 120 秒**）

顶层列表触底后**不直接结束**，而是进入第二阶段补采二级回复：

1. **记录待采线程**：`accept()` 处理顶层评论时，凡 `reply_comment_total > 0` 就把
   `cid → 期望条数` 记进 `replyTargets`。
2. **进入条件（v0.2.13 起挪到循环外的第二阶段）**：顶层 while 结束的两条路径（列表触底 / `maxCount` 到量）
   都落到循环外同一段：`if (phase === 'collecting' && replyTargets.size > replyDoneSet.size)`
   → `setPhase('replies', ...)` → `collectReplies()`。**旧版把这段写在 `laneEnd` 分支里**，
   `maxCount` 的 `break` 在它之前执行 ⇒ 设了目标条数就永远采不到回复（v0.2.13 修）。
3. **并发模型**：`REPLY_LANES = 4` 个 worker 从同一个 `todo` 队列取线程，每个线程
   自己按 `cursor` 翻到 `has_more === 0`；单页 `REPLY_COUNT = 20`，同一线程两页间隔
   `REPLY_GAP_MS = 600`。历史：v0.1.7 曾因 **4 路 × 120ms** 突发触发限流（`probe-replyburst.mjs`）
   降到 2 路；后按用户要求恢复 **4 路**，但 **间隔仍保留 600ms**，不回到 4×120ms 那档。
   若再次出现大面积空 body / `status_code=5`，应优先降 `REPLY_LANES` 或加大 `REPLY_GAP_MS`。
   **v0.2.13 起多了一道全局闸门**：每次回复请求（含 `fetchThread` 翻页、`recoverReply` 重试）前都
   `await replyGate()`，保证**跨线程**任意两次请求间隔 ≥ `RS.replyGlobalGapMs`（默认 250ms）——
   旧实现是「worker 取到线程就立刻发」，单页线程（大多数）之间**零间隔** ⇒ 实际速率 ≈ `replyLanes / RTT`
   ≈ 20 次/秒；真机同一视频两轮因此波动极大（一轮 0/46 个线程、另一轮 ~139 条二级回复）。
   撞上 `STATUS_5` / `STATUS_NULL` / `EMPTY_BODY` 时 `replyBackOff(err)` 把闸门**翻倍**
   （250 → 500 → 1000ms 封顶）并把本次的并发上限**降 1 路**（`replyLaneLimit`，下限 1，worker 自己让位）。
4. **落库**：回复与顶层评论**同一个池子**（`dts_c_<vid>`），键仍是自己的 `cid`，
   额外打两个字段：`is_reply: true`、`parent_cid: <顶层 cid>`。
5. **去重**：复用同一个 `seen` 集合 —— 回复的 cid 与顶层不重叠，天然安全。
6. **防御**：`REPLY_MAX_REQUESTS = 40000`（总量）、`REPLY_MAX_PAGES_PER_THREAD = 200`（单线程）。
7. **不要动不动就打扰用户（v0.1.6 新增约束，关键）**：回复接口会在「主扫描刚轰完列表接口」
   之后有一段拒绝期，但**签名并没有失效**。决定性对照实验 `probe-replydiag.mjs`
   （同一签名、同一时刻、真实线程 `cid=7667883981014582053`）：
   - 回复接口 → 288ms 返回**空 body**（0 字节）
   - 列表接口 `replay(0, 50)` → 713ms `status_code = 0`、`got = 50`、`has_more = 1`，**完全正常**
   ⇒ **回复接口被拒 ≠ 签名失效**。因此绝不能因为回复失败就转 `waiting-sign` 去要求用户
   滚动评论区 —— 那正是用户抱怨的场景。
   **拒绝是「时间窗」，不是永久拒绝**（v0.1.7 修正 —— 早先「服务端硬拒」的结论下早了）。
   决定性同秒对照 `probe-replywho.mjs`：让**页面自己**去点 12 个「展开N条回复」→ 12 条全部
   `http=200`、body 0 字节，UI 里也没出现回复；而**同一时刻**把页面那条 URL 原样重放 →
   `200`、9051 字节、3 条回复，成功；扩展自己的 `replayReply` 同时也成功（8 条）。
   ⇒ 抖音**连页面自己发的突发请求一起拒**，所以没有「学他」可学的东西（他并不比我们多什么）；
   而几秒后完全相同的 URL 又能通 ⇒ 窗口会自己开。
   `probe-replyfail.mjs` 之前的 30/30 全失败（age=0 新签名、`http=200 len=0`、持续 15 分钟以上）
   同样只是**打在了窗口里**，不代表接口被永久关掉。
   限流还会升级成**会话级**（`probe-replyburst.mjs`，用页面自己的 list URL 当模板）：连
   **列表接口**都回 `status_code = 5`，扩展自己的 `replay(0, 50)` 同样 `STATUS_5`。
   ⇒ 所以**降速**与**有上限等待**两件事都要做，策略是「有上限地等，等满就优雅收尾」，
   而不是无限等、更不是打扰用户。
   三种拒绝形态必须区分（`hook.js` 负责归一成稳定错误码，别把 JS 异常串当协议）：
   - **空 body** → `EMPTY_BODY`（回复接口限流时的形态；不归一的话 `JSON.parse('')`
     会抛 `SyntaxError: Unexpected end of JSON input`，文案会变、无法稳定判定）
   - **字面量 `null`** → `STATUS_NULL`（翻过列表末端的形态；这本身就是「签名被接受」的证据）
   - **`status_code = 5`** → `STATUS_5`（**会话级限流**的形态：body 只有 200 字节、
     `comments: null`；`probe-replyburst.mjs` 实测此时**连列表接口一起被限**）
   耐心策略（`recoverReply()`）：
   - 进入补采前先 `REPLY_WARMUP_MS = 1500` 停顿，让刚被列表扫描用掉的配额回血；
   - 单页失败按 `REPLY_BACKOFF_BASE_MS = 1000` 起指数退避（上限
     `REPLY_BACKOFF_MAX_MS = 3000`，即 1s → 2s → 3s → 3s…）**持续重试**（不是只重试固定次数）；
     退避压到 3s 上限是因为**单波**预算只有 12 秒（v0.2.14），拖长只会让用户干等；
   - 连续失败累计到 `REPLY_FAIL_STREAK_STOP = 3` 才做 `REPLY_COOLDOWN_MS = 1500` 冷却；
   - 冷却后用**列表接口做签名存活探测**（`sigAliveProbe()` → `requestReplay(0, 20)`，多路共用
     一次探测以免 `requestReplay` 按 cursor 去重互相踩）。**判死判据只有 `sigLooksDead()`**：
     `NO_SIGNED_URL` / `BAD_SIGNED_URL` / HTTP 401·403 / 传输层错误（fetch 失败、abort、超时）；
     **`STATUS_5`、`STATUS_NULL`、`EMPTY_BODY` 一律算「限流、签名还活着」**→ 继续退避重试，
     面板只说「服务端暂时不回数据（…），自动退避重试中，这一波最多试 12 秒（无需你操作；
     不成会停一会儿再自动来一波）」；
   - **`EMPTY_BODY` 的判据是「服务端回了 200、body 0 字节」**（`hook.js` 只在 `await res.text()`
     拿到空串时产生它，并把往返 `ms` 记在返回值里）；「本地请求没回来 / 太慢」是**另一个错误码**
     `REPLAY_TIMEOUT`。2026-10-07 真机 A/C/D 三轮的 `replyLastError` 从头到尾只有 `EMPTY_BODY`，
     一次 `REPLAY_TIMEOUT` 都没有；同一天用页面主世界手动重放改写后的回复 URL 是
     `200 / status_code:0 / 58276 字节 / 366~1666 ms`（`_rl_direct.mjs`，6 轮全绿）
     ⇒ **不是本地抢跑**，不能拿它当「扩展太快」的证据。
   - **单波预算 `REPLY_WAVE_BUDGET_MS = 12 秒`，波间停顿重试（v0.2.14）**：一波撞满预算后
     不再收尾，而是 `flushComments(0)` 先落盘 → 停 `REPLY_PARK_PLAN_MS = [15, 30, 60] 秒`
     （最后一档重复）→ 复位 `replyFailStreak` / `replyThrottleStartAt` / `replyThrottledMs` /
     `replyLastError` → 用**剩余总窗口**再算一次本波预算（下限 6 秒）→ `runRound()` 重打一波；
     `wouldWait + REPLY_WAVE_BUDGET_MS > RS.replyThrottleMaxWaitMs` 才收尾。
     依据（同一视频 `7692405235813272867`、同一份代码、250ms 闸门）：
     A 轮会话内连撞 **108 秒 / 48 次请求全被拒**，**11 秒后**新会话的 B 轮 **39/39 线程、302 条零失败**；
     C 轮把窗口放宽到 300 秒、**一口气硬撞 125 秒**仍一次没放行 ⇒ 硬撞没用，停一会儿再打才有用；
     D 轮跨 8.5 分钟 4 波全被拒，随后新会话 x1 轮 **23/23 线程全成**。
   - **整段「等服务端窗口」的总墙钟上限是 `replyThrottleMaxWaitMs`（内置
     `REPLY_THROTTLE_MAX_WAIT_MS = 120 秒`，v0.2.14 起从 10 秒改成 120 秒；面板可设 10~600 秒）**。
     累计等待记在 `replyParkedMs`（波间停顿）+ `replyThrottledMs`（波内退避），**含退避睡眠本身**；
     单波上限在**退避内层循环里也判一次**，到点立刻 `{ throttled: true }` 返回——但那是「这一波结束」，
     不是「本轮结束」；是否再打一波由上面那条循环决定。
     面板说明「服务端始终没放行回复接口（本轮共等 N 秒、分 M 波重试；x/y 个线程…）。
     再点一次『开始采集』会从断点续补采，已采到的不重复拉；面板『限流等待 s』可调
     （内置 120 秒，设 10 秒 = v0.2.13 及更早的老行为：十秒不行就收尾）」；
   - **只有「列表接口也失败」或 `NO_SIGNED_URL` 才判定签名真的没了** → 才转 `waiting-sign`。
8. **限流收尾后用户再点「开始采集」（续采，v0.2.2）**：
   - 限流收尾后 `startLoop` 会 **`setPhase('done')`**，**不是** `paused`。
   - 若 `phase==='done'` 且同一 `videoId` 且 `replyTargets.size > replyDoneSet.size`，
     `onStartClick` **必须**置 `resumeReplies = true`，`startLoop` **跳过顶层重扫**直接 `collectReplies()`。
   - **禁止**该路径 `resetProgress(false)` 把 `cursor` 归零重扫顶层（与面板「接着补」矛盾，且白轰列表接口）。
   - `phase==='paused' && cursor>0 && 同视频` 仍走「从 cursor 继续」。
9. **拿到新签名后直接回补采（v0.1.6）**：`needSignStop` 时置 `resumeReplies = true`，
   让 `startLoop()` 跳过顶层重扫、直接进 `collectReplies()`。顶层已有 `replyDoneSet`
   去重；重扫要 ~18s，而且刚轰完列表接口正是回复请求被拒的高发期。
10. **可恢复**：`replyDoneSet` 记录已拉完的线程，暂停后再点「开始采集」不会重复拉。
11. **收尾（整轮必须以 done 结束）**：`endNote()` 追加「二级回复已补采 N 条…」；
    限流时 `replyNote()` 说明「…本轮共等 N 秒、分 M 波重试…过一会儿再点『开始采集』会从断点续补采
    二级回复（不重扫顶层）」，并写清服务端回的是「HTTP 200 + 0 字节 body」（不是本地请求没回来）。
    补采返回后 `startLoop()` **照常 `setPhase('done')`**，**绝不能永远卡在 `replies`**。
    **实现要点（v0.2.14）**：`collectReplies()` 正常收尾（非 `needSignStop`）时**必须把阶段交回**
    ——裸赋值 `phase = 'collecting';`（不能走 `setPhase`：会把刚写好的 `noteText` 覆盖掉、也会清掉 `errText`），
    否则第二阶段收尾的 `phase === 'collecting'` 门槛不成立、整轮永远不置 `done`
    （真机 y1 轮实测：补采完成后 `phase` 停在 `replies` / 随后被签名抖动拽成 `waiting-sign`，
    DSH 采集器一直等到「无进展 900 秒」或 120 秒空窗才收工，整轮白拖 8.5 分钟；修完 z1 轮 25 秒结束）。
    另：`runRound()` 的 worker 里**任一回复线程成功就清 `errText`**（`if (errText) errText = '';`）——
    这一波先撞了几次 `EMPTY_BODY`、后面又成功时，面板那行红字不清会一直挂着，用户会以为「一直在限流」。
12. **诊断**：`replyLastError` / `replyThrottledMs` / `replyParkedMs` / `replyWaves` 镜像进
    `__DTS_COLLECTOR_STATUS__`；生效的波策略另见 `dts_settings_effective.replyWaveBudgetMs` /
    `replyParkPlanMs`。

**为什么值得做**：实测差额的 76% 就是这些回复；剩下 ~24% 是已删除评论
（`folded_comment_count = 0`，接口层没有「折叠评论」这回事），任何接口都拿不到。

### 3.9 运行时设置（`dts_settings` v0.2.2；v0.2.3 扩充二级回复档位；v0.2.4 加入面板设置 `dts_user_settings`；v0.2.5 入口改齿轮 `⚙`；v0.2.12~v0.2.14 顶层固定单路；**v0.2.15 起顶层改回错峰多路，`lanes` 重新生效**）

外部（DSH 插件 `dsh-douyin-comments`、脚本、DevTools）可以在 `chrome.storage.local` 里写：

| 键 | 内容 |
|---|---|
| `dts_settings` | 外部写入的运行时设置；`startLoop()` **每轮开头**读一次 |
| `dts_user_settings` | v0.2.4：**面板设置**（v0.2.5 起入口是标题栏齿轮 `⚙`）写入的用户设置；优先级高于 `dts_settings`（`chrome.storage.local.remove('dts_user_settings')` 即恢复插件/内置值） |
| `dts_settings_effective` | 本轮**实际**用的值 + 时间戳（`{lanes, lanesWanted, lanesNote, maxCount, replyLanes, replyGlobalGapMs, replyGapMs, replyThrottleMaxWaitMs, replyWaveBudgetMs, replyParkPlanMs, from: 'panel'\|'plugin', at}`），回写给调用方核对。**v0.2.15 起**：`lanes` 是**本轮实际在用的路数**（正常 = 设置值，检测到「两路返回同一页」会就地改成 `1`）、`lanesWanted` 是设置/请求的原始值、`lanesNote` 平时是空串、被降路时写明原因（形如「第 N 页前后发现两路返回了同一页（服务端合并并发请求），已自动降回单路…」，排查的人一眼能看出这一轮是不是被降过路）。**v0.2.13 起**：`maxCount` 是真正下发的目标条数，DSH 插件据此判断「扩展是否自己管住了 max」（读不到就退回插件侧点暂停的兜底逻辑）。**v0.2.14 起**：`replyWaveBudgetMs`（单波预算，12 秒）与 `replyParkPlanMs`（波间停顿计划 `15/30/60`）也回写，排查「到底打了几波、每波多久」时一眼可见 |

**取值优先级（v0.2.4 起）**：面板 `dts_user_settings` > 外部 `dts_settings` > 内置常量。逐字段判断，
面板里没填的字段继续用外部值 / 内置值（`loadRuntimeSettings()` 里对每个 key 先看面板那份、再看插件那份）。
`startLoop()` 只在**每轮开头**读一次，所以改完是「下一轮生效」（面板保存时会提示这一点）。

`dts_settings` 的字段（都可选；缺失/非法一律回退内置常量，也就是老行为）：

| 字段 | 含义 | 内置默认 | 允许范围 |
|---|---|---|---|
| `maxCount` | v0.2.4：**一级评论**去重后达到多少条就**停止顶层扫描**（`0` = 不限）；已采到的线程二级回复仍补完（v0.2.13 起；v0.2.4~v0.2.12 实际会连回复一起丢，见下） | `0` | `0..MAX_COUNT_HARD_MAX (= 1000000)` |
| `lanes` | 顶层列表的路数（v0.2.2；**v0.2.15 起重新生效**）：一轮同时（错峰 200ms）推进几路分页请求，`1` = 老的单路串行。同一瞬间发多路会被服务端并成同一页（静默少采），所以扩展发现两路同页会自动降回 1 并写进 `lanesNote` | `MAX_LANES = 3` | `1..LANES_HARD_MAX (= 8)` |
| `replyLanes` | 二级回复的并发线程数（v0.2.3）；**v0.2.13 起撞限流会自动降 1 路**（下限 1） | `REPLY_LANES = 4` | `1..8` |
| `replyGapMs` | 同一回复线程两页之间的间隔（v0.2.3） | `REPLY_GAP_MS = 600` | `0..60000` |
| `replyGlobalGapMs` | v0.2.13：**跨线程**的全局最小间隔（真正只有这一个 `await replyGate()` 闸门，取到线程就发的老行为没了） | `REPLY_GLOBAL_GAP_MS = 250` | `0..2000`（**`0` = 用内置 250ms**，v0.2.14 起真的如此——v0.2.13 及更早把 `0` 当成「关掉闸门」，与 DSH 设置页/MCP/本文档的说法相反，AI 一条 `ai_set_settings{replyGlobalGapMs:0}` 就能静默关掉限速；撞限流时闸门自动翻倍，上限 `REPLY_GLOBAL_GAP_MAX_MS = 1000`） |
| `replyWarmupMs` | 进入补采前的静默时间（v0.2.3） | `REPLY_WARMUP_MS = 1500` | `0..600000` |
| `replyThrottleMaxWaitMs` | **总**窗口上限：整轮「等服务端放行回复接口」的墙钟上限（v0.2.3；**v0.2.14 起从「一波判决」变成「总窗口」**，波内退避 + 波间停顿都算在里面） | `REPLY_THROTTLE_MAX_WAIT_MS = 120 * 1000`（v0.2.14 起；v0.2.3~v0.2.13 是 `10 * 1000`） | `10000..600000`（下限仍是 10 秒：设 10 = 老行为「十秒不行就收尾」） |

面板设置（v0.2.4 文字按钮 → v0.2.5 标题栏齿轮 `⚙`）暴露的是其中 5 项（`maxCount`（标签 `目标条数 max`） /
`lanes` / `replyLanes` / `replyGapMs` / `replyThrottleSec`＝秒，存盘时换算成 `replyThrottleMaxWaitMs`），
存进 `dts_user_settings`；`replyGlobalGapMs` 与 `replyWarmupMs` **不在面板里**（面板尽量少占高度），
要改走 DSH 插件设置表 / MCP / 直接写 `dts_settings`。其中 `lanes` 自 **v0.2.15 起重新生效**（标签「顶层并发路数」，
摘要里写成「顶层 3 路错峰（200ms）」；`1` = 单路）：面板保存时若 `RS.lanes > 1` 就按设置值用错峰多路。
`replyThrottleSec` 自 **v0.2.14 起语义是「本轮总共最多等多久」**（不是「一波最多等多久」）：
单波撞满 `REPLY_WAVE_BUDGET_MS = 12 秒` 后会按 `REPLY_PARK_PLAN_MS` 停 15/30/60 秒再来一波，
直到总窗口用完；面板 title 写明「内置 120 秒；设 10 = 老行为」。面板保存时重建 `RS`，
**必须把不在面板里的 `replyGlobalGapMs` 原样带过去**（否则面板一存就把全局限速丢了）。

- 读取点：`startLoop()` 进入时 `RS = await loadRuntimeSettings()`（内部 `chrome.storage.local.get([USER_SETTINGS_KEY, RUNTIME_SETTINGS_KEY])`，逐字段按上面的优先级合并），
  之后本轮所有限速点都读 `RS.*`。同一轮内不再重读；下一轮（含暂停后续采）会再读一次 ⇒ 改完**下一轮生效**，不用刷新页面。
- `maxCount` 到量**只停顶层扫描、不吞二级回复**（v0.2.13 起；`seen` 混一二级，所以计数改用 `topSeenCount`）：
  顶层循环里判 `if (RS.maxCount > 0 && topSeenCount >= RS.maxCount) { topCapReached = true; …; break; }`，
  只跳出**顶层** while；跳出后由循环外的第二阶段补采二级回复
  （`if (phase === 'collecting' && replyTargets.size > replyDoneSet.size) await collectReplies();`），
  最后才 `setPhase('done', …)`。语义与 DSH 插件的 `max` 一致。
  **v0.2.4~v0.2.12 的实现是错的**：那个 `break` 写在 `collectReplies()` 调用点之前，直接退出了整个循环 ⇒
  设了目标条数的用户**一条二级回复都采不到**（真机：`max=100` 交付 896 条、二级 0 条、面板「已手动暂停」）。
- 合法性：按上表范围钳位（取整）；字段缺失 / 非数字 / `<= 0` 一律回退内置默认。
  `replyThrottleMaxWaitMs` 的下限**刻意写死成字面量 10000（10 秒）**，而内置默认已改成 120 秒：
  放宽可以，**不允许调得比原来更早放弃**（「限流十秒不行就停」是 v0.1.8 的策略；v0.2.14 的真机证据
  表明那个策略会漏采，但用户若明确想要老行为，面板「限流等待 s」设 10 即回到它）。
  另外 `replyGlobalGapMs` 的 `0` **不再**解析成「关闸门」，而是「用内置 250ms」。
- **v0.2.15 起顶层列表改回「错峰多路」（`lanes: 1` = 老单路）**：一轮里按 `laneBudget` 组出
  `cursors = [cursor, cursor + COUNT, cursor + 2*COUNT, …]`，**逐路发出、路与路之间
  `await sleep(LANE_STAGGER_MS + Math.round(Math.random()*60))`**（`LANE_STAGGER_MS = 200`），
  再 `Promise.all` 收拢；`cursor` 取各路返回的 `next` 最大值推进。
  **关键是「错峰」而不是「并发」**：2026-10-07 真机复现（临时探针 `_lanes_probe.mjs`）——同一签名下
  **同时**发 4 个 cursor（0/50/100/150）：Σ返回 200 条、**按 cid 去重后只有 56 条**，
  `c50/c100/c150` 三页逐条完全相同、而 `next` 字段还是对的（50/100/150/200）⇒ **静默少给**；
  改成**错峰 200ms** 就恢复正常（唯一 200/200），错峰 500ms 也一样（唯一 200/200）。
  扫完整个列表（21 页、Σ返回 1021 条）：**单路（含 400ms 礼貌间隔）15.79s / 唯一 907** vs
  **错峰 4 路 7.72s / 唯一 912** ⇒ 2.04× 提速、数据一样多（多 5 条是那半小时里新评论在变）。
  内置默认 `MAX_LANES = 3`（错峰 3 路）。
- **降路兜底（v0.2.15）**：同一轮里若两路返回**逐条相同**的页（`mergedLanes`），当轮就把 `laneBudget`
  降回 1，并把原因写进 `dts_settings_effective.lanesNote`（面板同步提示）——宁可慢，也不再静默少采。
  另外多路时「某路越界返回空页」**不算触底**（`anyLaneHasMore` 修正 `laneEnd`）；`laneShort`
  （某路明显不满一页）也把 `laneBudget` 降回 1，靠近列表末端时自然收回单路。
- 单路礼貌间隔：`MIN_INTERVAL_MS` 400ms → **150ms**（v0.2.15）。实测中位往返 344ms，那 400ms 有一半
  是纯等；21 页的单路从 ~15.8s 降到 ~10s。
- 默认行为（扩展单独使用时也一样）：`MAX_LANES = 3`（错峰 200ms）、`REPLY_LANES = 4` /
  `REPLY_GAP_MS = 600` / `REPLY_THROTTLE_MAX_WAIT_MS = 120s`（v0.2.14 起；v0.2.3~v0.2.13 是 10s）。
- 历史：**v0.2.12~v0.2.14 顶层固定单路**（`var lanes = 1; var cursors = [cursor];`）——2026-10-06 只测了
  「同时发」这一种形态（4 路 5 轮只有 **492 条**且 **0 个失败请求**；单路串行 18 步 **714~744 条**；
  每路错峰 200ms 才恢复正常），于是把触发条件过度概括成「并发一定少采」。v0.2.15 的探针把它缩到
  「同一签名 + ~200ms 窗口内同时发」。
- 单一事实来源仍是 `content.js`；`LANES_HARD_MAX = 8` 只用于 `clampSettings()` 钳位（兼容老调用方），
  `RS` 只是兜底。
- 服务端列表本身也有上限：`cursor=850` 时只回 8 条且 `has_more=0`，`cursor≥900` 回字面量 `null`
  （上述视频列表接口最多约 **850 条**，服务端 `total=1709` 里的差额是二级回复 + 已删除/被过滤评论）。
- 实战提示（2026-10-05 macOS 报告的成因之一）：刚轰完列表接口时回复接口容易被整段拒
  （见本节前面的实测），这时把 `replyThrottleMaxWaitMs` 放宽到 60~300 秒比反复重跑更省事；
  仍然被拒就降 `replyLanes` 到 1~2、加大 `replyGapMs`。

### 3.10 跨视频可见性与导出范围（v0.2.9 新增：`dts-stats` / `dts-export` 的 `all` 分支；v0.2.10 起 `dts-stats` 带请求序号 `localStatsSeq`；v0.2.11 起 Hub `export` 与面板导出共用 `exportComments`，也支持 `all`）

**背景**：用户报「上一条视频采集完成，我又去下一条，点击开始采集，结果上一条采集完的数据没了」。
**数据并没有丢** —— 评论一直按视频分桶存在 `chrome.storage.local` 的 `dts_c_<videoId>`
（一个视频一个桶），除了 `dts-clear`（面板那两个清空按钮）**没有任何删除路径**；
只是旧面板的计数（`savedCount` / `seen`）与导出都只认「当前这条视频」，滑到下一条后归零，
看起来像被清了。本节只加「可见性」与「导出范围」，**不改任何落库/导出数据路径**。

**`dts-stats`**（content.js → background，查本机存储规模）：

| 字段 | 含义 |
|---|---|
| `count` | 当前（或请求里指定）视频的条数（原有） |
| `totalAll` | **v0.2.9**：跨视频总条数，用 `dts_videos` 里维护的 `count` 元数据累加（**不遍历每个评论桶**） |
| `videoCount` | **v0.2.9**：本地有几个视频（`dts_videos` 的键数） |
| `videos` | `dts_videos` 元数据（原有） |

- 请求 `{ type:'dts-stats', videoId? }` → 回包 `{ ok:true, count, totalAll, videoCount, videos }`。
- content.js 侧：`refreshLocalStats()` 把回包写进 `localStats = {videos, total, current}`；
  面板构建时读一次，之后每 20 秒刷新（`localStatsTimer`；`document.hidden` 或扩展上下文中断时跳过），
  落库后与点「清空」后**立刻**再刷新一次。
  **v0.2.10 起带请求序号**：`refreshLocalStats()` 进入时 `var seq = ++localStatsSeq;`，回包时
  `if (seq !== localStatsSeq) return;`；点「清空 / 全部清空」时 `localStatsSeq++`，把在途的旧
  `dts-stats` 回包**作废**。修的就是「清空已经生效，但清空**之前**发出的旧回包晚到、又把
  『本地已存』写成旧数字（如 `2 个视频 / 7 条`），最长要等 20 秒周期刷新才纠正」。
  面板据此显示「本地已存」`N 个视频 / M 条（本条 X 条）`，
  「已采（去重）」在本轮尚未落库但 `localStats.current > 0` 时补显 `（本地已有 N 条）`，
  点「开始采集」时另写一行
  `本机已存：N 个视频 / M 条（含其它视频）；本条视频本地已有 X 条`。

**`dts-export`**（content.js → background 导出）：

- 单视频（默认，旧行为）：`{ type:'dts-export', videoId, format }`，与 v0.2.8 及以前完全一致。
- **v0.2.9 新增「全部视频」**：`{ type:'dts-export', videoId, format, all: true }`
  （`content.js` 的 `exportAs(format)` 传 `all: exportAll`，由面板「导出范围」那两个按钮决定）：

| | `all` 不传 / false（本条视频） | `all: true`（全部视频） |
|---|---|---|
| CSV 列 | 17 列（`cid … is_reply,parent_cid`） | **18 列：末尾追加 `video_id`**；**前 17 列的列序与含义完全不变**，老读者按位置读前 17 列仍然正确 |
| JSON | `{exportedAt, videoId, title, count, topLevelCount, replyCount, comments[]}` | 顶层多 `scope: "all"` 与 `videos: [{ videoId, title, count }]`；每条评论也带 `videoId` |
| 文件名 | `douyin-comments-<videoId>-<时间戳>.csv\|json` | `douyin-comments-all-<时间戳>.csv\|json` |

- background 实现要点：`toCsv(comments, { withVideoId: wantAll })` 只在 `withVideoId` 为真时把
  `video_id` 推进列头、并给每行追加一列；不带该选项时列数、列序完全不变。
- 导出是**只读**操作：不删、不改任何存储键（面板「清空」按钮才走 `dts-clear`，见 §3.6）。
- **v0.2.11 起导出只有一份实现**：面板「导出 CSV/JSON」（`dts-export`）与 Hub(AI/MCP) 的 `export`
  命令**共用** `background.js` 的 `async function exportComments(opts)`（`case 'export':` 与面板按钮
  路径都走它），行为完全一致；Hub `export` 也支持 `all:true`（不传 `videoId` 时把本地所有视频合成
  一份，每条评论标 `videoId`）。Hub 回包约定：**成功主体放 `result`**——`{ok:true, result:{scope, videoId, videoCount, count, topLevelCount, replyCount, format, filename, bytes, downloadId, path}}`；**失败保持顶层** `{ok:false, error, hint}`。失败口径统一：
  既没 `videoId` 又没 `all:true` → `MISSING_VIDEO_ID`（hint 提示可传 `all:true`）；本地确实没有
  评论数据 → `EMPTY_POOL`（全量时 hint 提示先采集或用 `list_videos` / `get_comments` 确认）。
  **不再下载一个只有表头的空 CSV**（以前「导出成功」会掩盖「本来就是空的」）。
- 面板导出失败时的提示会带上后台给的 `hint`：文案形如 `导出失败：<error>（<hint>）`。

## 4. 测试要求（实现者 B）

用本机 node 全局安装的 `playwright-core` +
本机 Playwright 的 chromium 可执行文件（路径因机器而异，`npx playwright install chromium` 后自查），
`chromium.launchPersistentContext(PROFILE, { headless:false, args:['--disable-extensions-except=<EXT>','--load-extension=<EXT>'] })`。

**登录态**：用 `（本机探针 profile，不入库）.profile` 的**副本**（先 `Copy-Item -Recurse` 到 `douyin-collector-test\.profile`），因为原目录可能被占用。**绝不可关掉所有标签页**（Chromium 会整个退出）；测试结束不要 `browser.close()`，让调用方用 `job_kill` 结束。

**必须验证的 8 项**（每项都要在报告里给出证据）：
1. service worker 起来了，扩展 ID 稳定
2. `window.__DTS_COLLECTOR__` 存在，且 `getSigned` 在页面发过评论请求后非 null
3. `window.fetch` / `XMLHttpRequest.prototype.open` 确实被包装（且页面自身功能未坏：评论区仍能正常加载）
4. `replay(20, 20)` 返回 `ok:true`、`got>0`
5. 完整采集：跑到 `hasMore===0` 或脚本给定的页数上限，报告实际页数/唯一条数/耗时
6. 去重有效：唯一数 ≤ 返回总条数，且无重复 cid
7. 面板存在、进度条随采集更新、按钮可点
8. 存储里 `dts_videos[videoId].count` 与实际一致；导出 CSV 能被产生。
   **导出要验三条**（只验「`downloads.download` 被调用」不够，旧代码会在文件没写盘时就报成功）：
   - 正常完成：文件真的落盘（默认下载目录，文件名 `douyin-comments-<videoId>-<时间戳>.csv`），
     `chrome.downloads.search` 里 `state==='complete'`、`exists===true`、`filename` 非空，面板说「已导出」
   - 不弹对话框（`SAVE_AS=false` 时）：下载项不会长时间停在 `in_progress` 等用户
   - 被中断（在 SW 里挂 `chrome.downloads.onCreated` 立刻 `cancel`）：面板**不得**说「已导出」，且磁盘上无文件
   参考实现：`douyin-collector-test/run-export-ui.mjs`（15 项）、`run-export-auto.mjs`、
   `run-export-cancel.mjs`（`SAVE_AS=true` 时的对话框场景）、`probe-saveas.mjs`（暴露旧缺陷）
9. **二级回复（v0.1.5 新增，协议 §2.8 / §3.8）**：
   - 采集过程中**观察到 `phase === 'replies'`**，最终落到 `done`（不是 error/paused）；
     **服务端限流回复接口时也必须落到 `done`**（v0.1.8：**只等 10 秒**就优雅降级，
     判据 `replyStoppedByThrottle === true`、`replyThrottledMs <= 10 秒多一点`，
     面板须出现「限流回复接口」，且整轮用时 ≤ 5 分钟 —— 实测旧版会永远卡在 replies：
     901 秒、面板谎报 running；v0.1.6/v0.1.7 分别要等 8 分钟）
   - 落库里同时有顶层评论与回复；**每条回复都有 `parent_cid`**，且该 `parent_cid`
     必须能在顶层评论里找到（**不允许孤儿回复**）
   - 覆盖率：`实际回复数 / Σ(顶层评论的 reply_comment_total)` 应达到 ~90% 以上
     （降级时改判：必须留下 `replyLastError` 失败原因，且顶层评论完好）
     （拉不回来的那部分是已删除回复）
   - 导出 CSV 是 **17 列**，`is_reply=1` 的行数 = 落库回复数；顶层行 `is_reply=0` 且 `parent_cid` 为空
   - ⚠️ 解析 CSV 时**必须做引号感知**：评论文本里可能含换行，按 `\n` 直接切行会把 1 行拆成多行
     （实测踩到：2377「行」里有 177 行是同一条评论的换行）
   参考实现：`douyin-collector-test/run-replies.mjs`（22 项，含降级判据 R9b/R9c/R9d/R9e）、
   `run-replies-throttled.mjs`（12 项：用 `page.route` 把回复接口伪造成 `200 + 空 body`，
   **不靠服务端赏脸**地验证「十秒预算 → 收尾成 done」；实测 37s 结束、`replyThrottledMs=10352`、
   `replyStoppedByThrottle=true`、回复请求只有 14 次、顶层 1329 条完好）
10. **面板（v0.1.8；v0.1.11 起改为绝对坐标）**：必须能拖动（`makeDraggable(root, head)` +
    `pointerdown/move/up/cancel`，**v0.1.11 起位移写成内联 `left/top` 绝对坐标**，
    CSS 变量 `--dts-dx/--dts-dy` 那套已废弃）、位置以 `{x,y}` 持久化到 `chrome.storage.local.dts_panel_pos`、
    **双击标题栏复位**、从按钮上按下**不触发拖动**、`.dts-dot` 状态灯随 `phase` 变色（`DOT_CLASS`）、
    收起按钮仍然可用。**v0.1.15 起拖动还要有「窗口级兜底」**：`pointermove/pointerup/pointercancel`
    除了挂在把手上，也要挂在 `window` 上（`function onMove(e)` 共用），这样 `setPointerCapture`
    没生效时拖动也不会「拖到一半停住、松手后位置没记住」（判据：check-zip 的「content: 拖动有窗口兜底」）。
    **测试依赖的类名一个都不能改**（`dts-panel-body`/`dts-row`/`dts-muted`/`dts-err`/
    `dts-bar`/`dts-bar-fill`/`dts-btn`/`dts-btn-primary`/`dts-collapsed`，进度条仍由 `style.width` 驱动）。
    **面板尺寸（v0.1.15）**：只有紧凑一档 —— 宽 236px、字号 11px，写死在 `panel.css` 基础规则里；
    不得再出现「大/小」按钮（`dts-btn-size`）、尺寸 class 或 `dts_panel_size` 存储键，
    老用户存过的 `'normal'` 必须被忽略（D17 会把 `dts_panel_size='normal'` 塞回存储再刷新，
    面板必须仍是 236px）。
    参考实现：`douyin-collector-test/probe-panel-drag.mjs`（17 项：拖动位移、变量、落盘、刷新保持、
    双击复位、按钮不触发拖动、收起仍可用、固定紧凑档、无大小按钮/存储键、旧「大」档失效）
11. **精选页能采（v0.1.9，协议 §3.5；该页是 `/jingxuan` 网格，不是真推荐页）**：
    在 `https://www.douyin.com/jingxuan`（网格页）上必须走通「点卡片开浮层 → 点评论图标开评论区 → 采集」，判据：
    - 未打开评论区时点「开始采集」→ `phase === 'waiting-sign'`，且面板文案**按页面形态**给出
      「这是抖音精选页（网格）：请先点开一个视频…点视频右侧那个带数字的「评论」图标」，
      **不得**再出现「滚动评论区一次」（该页没有常驻评论区）；
    - 点开卡片后 URL 变 `?modal_id=<id>` 且 `liveVideoId === modal_id`；此时文案改成「请点一下视频右侧…」；
    - 打开评论区后页面自己发出评论请求 → 扩展截获签名，且 `下载/落库的 videoId === 签名里的 aweme_id`
      （**不得**记到别的视频名下）；
    - 采到评论（`unique > 0`）、`phase` 进入 `collecting/replies/done`、能正常暂停。
    参考实现：`douyin-collector-test/run-feed-collect.mjs`（17 项，跑真实抖音）；
    机制探针 `probe-feed-net.mjs`（不打开评论区页面就 0 个评论请求）、`probe-feed-drawer.mjs`
    （DOM 点开评论图标 → 签名到手、`unique=639`）、`probe-feed-modal.mjs`（浮层 ID 识别一致）。
12. **真推荐页能采（v0.1.10 新增；这是用户 m05852/m06103 的原始诉求）**：
    `https://www.douyin.com/?recommend=1` 是**全屏单视频滑动流**，与精选页（`/jingxuan` 网格）**不是同一个页面**，
    且**完全没有 `[data-aweme-id]`** —— 当前视频 id 只在 slide 的 class 名里（`video_<id>`）。判据：
    - 进入方式必须能复现：先落 `/jingxuan`，**真实鼠标点导航栏「推荐」**（DOM `.click()` 不触发 SPA 路由，
      直接 `goto ?recommend=1` 会在几秒~二十秒内被弹回 `/jingxuan`）；
    - **ID 识别**：`liveVideoId === 当前在视口里的 slide class 里的 video_<id>`（推荐页上唯一可用的 ID 来源）；
    - **签名反证**：点开该 slide 的 `[data-e2e="feed-comment-icon"]` 后拿到的签名里
      `aweme_id === 那个 class id`（证明 class id 就是真 aweme id，不是别的命名空间）；
    - **落库**：`videoId === 那个 class id`、`unique > 0`、`videoId === sigAweme`（不得记到别的视频名下）；
    - **滑到下一条不污染**：切换 slide 后 `pageKey()` 必须变化（`'d:'+awemeIdFromDom()`），
      签名要么被作废（`hasSig === false`）要么等于**当前**视频，**绝不能**停留在这条的上一条上；
    - 未打开评论区时点「开始采集」→ 扩展**先置 `waiting-sign`、再自己合成点击评论图标**（v0.1.11），
      面板出现「这是抖音推荐页（全屏刷视频）…」；若合成点击立刻拿到签名，`phase` 直接进 `collecting`
      也算通过（文案用 `status.hint` 断言，不要死等 `waiting-sign`）；
    - **采集中换视频不许混用**：只要 `phase === 'collecting'`，落库标签 `videoId` 就必须恒等于
      `liveVideoId`（扩展自己按 :1621 停掉也算通过）——这是 m03457 那条跨视频污染的反向验证；
    - **「暂停」必须真的停**：点面板「暂停」后 `phase ∈ {paused, done}` 且已采数不再增长
      （不能只等 2.5 秒就断言：点按时循环可能正在 await，旧版实测会读到 `collecting`）。
    参考实现：`douyin-collector-test/run-recommend-collect.mjs`（19 项，跑真实抖音；R3a/R3b 是 v0.1.11 的
    「空闲一次都不碰页面」与「一开采集就自己点开评论区」）；
    机制探针 `probe-recommend.mjs`/`probe-recommend2.mjs`（直接 goto 必被弹回 `/jingxuan`）、
    `probe-rec3.mjs`（抹掉自动化指纹能多留约 18 秒）、`probe-rec4.mjs`（真实鼠标点导航能稳定进）、
    `probe-rec5.mjs`（60 秒采样：无 `data-aweme-id`、id 在 class 里、e2e 清单）。
14. **面板定位与自动打开评论区（v0.1.11 新增；用户 m06554 的原始诉求）**：
    - **拖动不许「瞬移」**：面板位置一经拖动就从 CSS 的 `right/bottom` 切换成**内联 `left/top` 绝对坐标**
      （`right/bottom` 置 `auto`），此后位置只由坐标决定。判据：
      ① 拖过后改视口宽度（1440→1280）面板 x 不动（v0.1.10 会跳 −160px，探针 `probe-drag-jump.mjs` S4 实测）；
      ② 拖过后面板内容变高 200px，**顶边（拖动把手）**不动（旧版 bottom 锚定会让顶边上跳）；
      ③ 位置以 `{x,y}` 存 `chrome.storage.local.dts_panel_pos`，刷新后保持；
      ④ 双击标题栏清内联定位 + 清存储、面板回右下角；
      ⑤ ≤0.1.10 存的 `{dx,dy}` 会被换算成绝对 `{x,y}` 并升级存储（不丢用户已拖的位置）；
      ⑥ 从标题栏的按钮上按下不触发拖动；⑦ 视口变小时重新夹取，至少留 60px 宽 / 32px 高可见。
      参考实现：`probe-panel-drag.mjs`（14 项，含 D12/D13 两条根因回归、D14 升级兼容）。
    - **需要签名时扩展自己打开评论区，空闲时一次都不许碰页面**：`waitForNewSignature()` 是**唯一入口**，
      顺序必须是「先 `needSign = true` + `setPhase('waiting-sign')`，**再**合成点击」——反过来会漏掉页面
      几毫秒后发回的签名。合成点击＝`pointerdown/mousedown/pointerup/mouseup/click` + 末尾补 `el.click()`
      （`probe-autoopen.mjs` 实测 `el.click()` 就能开评论区并让页面自己发出评论请求）；最多点 3 次
      （`AUTO_OPEN_MAX`），已打开（`commentAreaOpen()`）就不点，1.5 秒没签名再补一次；
      **网格页（精选页 `/jingxuan`）故意一次都不点**：那时「用户在看哪个视频」还没定，卡片上那个
      评论图标点下去会把用户带到**另一条视频**的浮层里（2026-09-29 `run-feed-collect.mjs` F2 实测
      自动点之后扩展识别的 ID 与用户自己点开的 `?modal_id=` 对不上）⇒ `autoOpen = 'no-target:grid'`，
      交给用户先点开卡片（形态变成 `overlay` 之后才走自动点）。
      状态镜像暴露 `autoOpen` / `autoOpenCount` / `commentAreaOpen` 供确定性断言，另外暴露
      `sigAweme` = **扩展自己认的**签名所属视频（`null` = 已作废）——它和主世界 `getSigned()`
      （页面最近发出过的签名 URL，扩展作废了自己的缓存后它**也不会变**）不是一回事，
      跨视频污染的判据必须用前者。
      判据：空闲时 `autoOpen === ''` 且 `autoOpenCount === 0`（**没点开始就绝不碰页面**）；
      点「开始采集」后（非网格页）`autoOpen` 形如 `clicked:<选择器>` 且 `commentAreaOpen === true`；
      网格页上 `autoOpen === 'no-target:grid'` 且阶段仍是 `waiting-sign`；切到下一条视频后
      `sigAweme` 要么为空、要么等于当前视频。
      参考实现：`run-recommend-collect.mjs` R3a/R3b（19 项）、`run-feed-collect.mjs` F2/F2b/F3。
    - **推荐页 ID 解析加固（v0.1.11，2026-09-29 `run-recommend-collect.mjs` R2/R3 实测红之后补）**：
      真推荐页 `/?recommend=1` 既没有 `data-aweme-id`、URL 里也没有 id，识别只能靠 class 里的
      `video_<id>`；而外层 `[data-e2e="feed-item"]`（整屏 slide）**自身 class 里没有 id**，
      id 挂在**嵌套的** `[data-e2e="feed-video"]` 上 ⇒ 识别时既看元素自身、也**深扫子孙** class
      （`awemeIdFromClassDeep()`，与测试 `idOf()` 同口径）。另外 `onStartClick()` 在
      `pageViewId()` 还为空时**先等最多 3 秒**（6×500ms）再报「未识别到视频 ID」，避免页面刚切过来
      或被服务端弹回重渲染的一瞬间直接把 phase 打成 `error`。状态镜像也不再只在页面键变化时刷新：
      页面键不变也每 800ms `render()` 一次，否则停在「等待签名」/空闲时 `liveVideoId` 会冻结在
      上一次页面键变化那一刻的值（R2 读到 `null`、而同一时刻 DOM 里明明有 id，就是这么来的）。
      判据：真推荐页上 `liveVideoId === 当前 slide class 里的 video_<id>`（R2）；点「开始采集」后
      phase 不得是 `error`（R3）。
    - **不再出现「零滚动」字样**：面板标题、`manifest.json` 的 `name`、README 标题、导出 JSON 的 `note`
      都不带「零滚动」；`check-zip.mjs` J 段断言 `content.js` 与 `manifest` 里都没有这四个字。
15. **页面形态不再按 URL 写死；关注/朋友/我的都能用（v0.1.12 新增；用户 m07300 的原始诉求）**：
    - **规则**：`pageKind()`（URL 五态）只保留给「URL 本身无歧义」的两种形态用（`detail` = `/video/<id>`、
      `overlay` = 有 `modal_id`）；其余一律由 `pageMode()` **看 DOM** 判：有占据 ≥50% 视口的在播视频或
      可见 `[data-e2e="feed-active-video"]` → `'feed'`；否则有可见作品卡片（`a[href*="/video/"]`
      或 `[data-aweme-id]`）→ `'grid'`；否则 `'unknown'`。**行为只依赖 mode，不依赖 URL 清单**
      （抖音以后新加的页面无需改代码）。
      ⚠️「≥50% 视口」这条是必须的：作品网格里卡片上的小视频也会自动播，去掉它「我的」页会被误判成 feed。
    - **ID 识别链必须通用**（`awemeIdFromDom()`，任何页面同一条）：① 正在播的 `<video>` 往上 ≤20 跳
      → ② 视口内可见的 `[data-e2e="feed-active-video"]` → ③ 视口内离中心最近的视频元素
      （`VIDEO_EL_SEL` = `feed-active-video` / `feed-item` / `feed-video` / `[data-aweme-id]` /
      `a[href*="/video/"]`）→ ④ 全文档 `[class*="video_"]` 自身 class 兜底（`awemeIdByClassToken()`）。
      抠 id 的 `awemeIdFromEl(el)` 三路 = 自身 `data-aweme-id` → 自身/子孙 `a[href*="/video/"]` 的 URL
      → 自身或子孙 class 的 `video_<id>`。**必须包含 href 这一路**：我的 `/user/self` 里
      `[data-aweme-id]` 与 `<video>` 全是 0×0，id 只在 `a[href*="/video/"]` 里（v0.1.11 缺这一路
      ⇒ 点「开始采集」直接 `phase='error'`）。
    - **旧页面残留 DOM 必须挡住**（2026-09-30 `run-pages-collect.mjs` 第一次跑实测踩到）：SPA 换页后
      抖音把上一页的层留在 DOM 里（隐藏的 `<video>` 可能还在播、还带着上一页的 `video_<id>` class），
      于是「我的」页上识别到的是**上一个页面的视频**（E2E 实测在 `/user/self` 上读到 `/follow` 的 id，
      `phase` 停在 `waiting-sign`）。⇒ 三处都要可见性/尺寸门槛：① `awemeIdFromPlayingVideo()` 只认
      「至少一个方向 ≥50% 视口」的在播视频；② `[data-e2e="feed-active-video"]` 用
      `nearestVisibleEl()` 挑视口内那个（`querySelector` 会第一个命中隐藏的旧节点）；
      ③ `awemeIdByClassToken()` 只认视口内可见元素的 class。
    - **落库标签必须跟随签名**：在作品网格上点「开始采集」时页面还没有「当前视频」，标签只能先落在
      某条卡片上；用户随后点开一条作品、签名到手时若不改标签，就会出现「采的是 B 的评论、记在 A 名下」。
      ⇒ `case 'signed'` 里非采集态一律 `videoId = String(p.aweme_id)`（签名 URL 内嵌 `aweme_id`，
      重放抓的就是它）。E2E 实测：修复前 `liveVideoId` 已是浮层 `modal_id`、落库标签还是网格里那条。
    - **指引按 mode 给**（`signHint()`）：feed → 「一屏一条视频…点视频右侧带数字的「评论」图标」；
      grid → 「先点开一条作品…」；overlay → 点右侧评论图标；`recommend` 仍给原推荐页文案（最先判）；
      detail/unknown → 旧的「滚动评论区」那句。**详情页文案不许再出现在 feed 页上**（v0.1.11 的 bug）。
    - **网格页一律不替用户点卡片**（沿用第 14 项）：`autoOpen = 'no-target:grid'`；但在网格页点了
      「开始采集」后用户点开一条作品时，800ms 轮询会带新形态重跑
      `waitForNewSignature('page-changed', '')` ⇒ **自动接手，不用再点一次「开始采集」**。
    - **判据**（参考实现 `run-pages-collect.mjs`，25 项；每个小节都 `page.reload()` 重载页面，
      否则上一节的运行态会带进来）：① **关注 `/follow`**：空闲 `autoOpen === ''` 且可见评论图标 0；
      点「开始采集」→ `phase === 'collecting'`、`liveVideoId === 页面 class 里的 video_<id>`、
      `autoOpen` 形如 `clicked:…` 且 `commentAreaOpen === true`、hint 含「一屏一条视频」且**不含**
      「滚一下」、`unique > 0`、暂停生效；② **朋友 `/friend`**：同上；
      ③ **我的 `/user/self`**：点「开始采集」**不得**是 `error`（须 `waiting-sign` +
      `autoOpen === 'no-target:grid'` + hint 含「先点开一条作品」）；随后真实鼠标点开一条作品 →
      URL 出现 `modal_id=`、`phase === 'collecting'`、`liveVideoId === modal_id`、评论区自动打开、`unique > 0`。
16. **换视频/清空后必须自己重新打开评论区（v0.1.13 新增；用户 m07969 的原始诉求）**：
    - **现象**：在 A 视频采着 → 暂停 → 跳到 B → 点「清空」→ 再点「开始采集」，扩展一直提示
      「上一个视频（A）的签名已作废」，`phase` 卡在 `waiting-sign`，`autoOpen === 'already-open'`、
      `autoOpenCount === 0`（**一次都没点**）；用户手动打开 B 的评论区后立刻就能采。
    - **根因**（2026-09-30 `run-switch-clear.mjs` 实测）：SPA 换页后 A 的评论层留在 DOM 里
      （`items=10 itemsVis=0 itemsInActive=10 lists=[0x0@0,0 hidden]`），而旧的 `commentAreaOpen()`
      只按 DOM 存在性数 `comment-item` ⇒ 把残留面板当成「已经打开」⇒ 不点入口 ⇒ B 永远不发
      `comment/list` ⇒ 签名等不到。
    - **规则**（§3.5「换页后残留的评论面板…」三条判据）：只数可见条目 `visibleCommentItemCount()`、
      容器也要 `visibleForClick()`、换页置 `panelStateSuspect = true`（点过入口 / 收到新签名时置回
      `false`）；`autoOpenComments()` 里 `autoOpenCount > 0` ⇒ 点过就不再点，`nItems > 0 &&
      !panelStateSuspect` ⇒ 才判「已开」，**否则本轮必须点一次**。
    - **判据**（`run-switch-clear.mjs`，11 项）：`/follow` 采 A（拿到 A 签名且 `unique > 0`）→ 暂停 →
      导航 `/friend` → 清空（`phase === 'idle'`）→ 开始采集 ⇒ **2s 内** `autoOpen` 出现 `clicked:`，
      且 `sig` / `liveVideoId` / `videoId` 都等于 B 的 id 且 ≠ A（修前同一流程 30s 干等）。
    - 注：扩展的 `liveVideoId` 镜像在换页后会**滞后**（实测 `/friend` 导航后 25s 内仍报 A，因为旧层
      还在 DOM）。**不得**把「点开始采集前 live id 已变」当前置条件，换页证据用 URL + 采集到的 id。

---

## 7. AI Bridge（v0.2.0；协议冻结补充）

> 目标：让 MCP / 任意本地 agent 调用本扩展，而**不必**会 Playwright、不必点面板。
> 采集核心、签名语义、限速与落库契约（§1–§6）**一字不改**；本节只加「外部控制面」。

### 7.1 架构（扩展不能 listen，所以是反向轮询）

MV3 Service Worker **不能** `listen` TCP。因此：

```text
MCP Client (AI)
    ↓ tools/call
douyin-mcp Hub  127.0.0.1:18765
    ↑ GET /pending  /  POST /result
    │
background.js（poll，约 800ms + chrome.alarms 兜底）
    ├─ 存储类命令：直接读写 chrome.storage / 复用 dts-export·dts-clear
    └─ 页面类命令：chrome.tabs.sendMessage → content.js
                      ↓
                 content.js（dts-ai-* 监听器）
                      ↓
                 onStartClick / onPauseClick / 状态快照
```

安全边界（Hub ↔ 扩展，v0.2.x）：
- MV3 SW **不能 listen**，扩展**出站**轮询 `http://127.0.0.1:<port>/api/v1`。
- Hub 默认端口 **18765**，只绑 `127.0.0.1`。
- **CORS**：`/health` 对任意 Origin 开放；`/pending` `/result` `/enqueue` 仅对 `Origin: chrome-extension://*` 回 `Access-Control-Allow-Origin`。
- **桥头**：命令类接口必须带 `X-DTS-Bridge`（值任意，只判存在）。自定义头必然触发 CORS 预检，网页预检拿不到 ACAO ⇒ 发不出该头；扩展侧随 `background.js` 固定发送，零配置。
- 扩展 manifest `host_permissions` 含 `http://127.0.0.1/*`、`http://localhost/*`（双保险）。
- **禁止**再引入 `chrome.alarms`（曾导致 SW `onAlarm` TypeError / 注册失败）；轮询用 `setInterval` + content keepalive。
- **导出 CSV**：`csvCell` 对首字符为 `= + - @` 的单元格前置 `'`，防公式注入（评论文本完全由他人控制）。

### 7.2 存储键（扩展侧）

```js
chrome.storage.local.dts_ai_bridge = {
  host: '127.0.0.1',
  port: 18765,
  enabled: true,
  intervalMs: 800
}
```

改端口必须 **Hub 与扩展两侧一致**（改 Hub 配置 + `chrome.storage.local.dts_ai_bridge.port`）。

### 7.3 Hub HTTP API（Hub 对扩展）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/v1/health` | — | `{ ok, hub, version, pending, lastExtensionAt, lastResultAt }` |
| GET | `/api/v1/pending` | — | `{ ok, commands: [{ id, type, args, at }] }`（出队） |
| POST | `/api/v1/result` | `{ id, ok, result?, error?, at }` | `{ ok: true }` |

Hub 对 **MCP 客户端** 的内部接口（同进程 in-memory / 可选 localhost 管理口）只保证：
- `enqueue(type, args) → id`
- `awaitResult(id, timeoutMs)`

### 7.4 命令类型（Hub → 扩展 → 结果回 Hub）

| type | 执行者 | 语义 |
|---|---|---|
| `status` | background | storage 摘要 + 最近一次页面 live 快照 + Hub 连接信息 + `settings`（见 §7.9） |
| `live_status` | content.js | 当前抖音页采集器只读快照（`__DTS_COLLECTOR_STATUS__`） |
| `start_collect` | content.js | 等价面板「开始采集」（`onStartClick`）；可带 `args.settings` 先写 `dts_settings` 再启动，回包含 `appliedSettings` / `settingsNote` |
| `get_settings` | background | 只读设置快照 `{ external, user, effective, precedence, limits }`（见 §7.9） |
| `set_settings` | background | `{ settings, scope? }` 写设置：`scope="external"`（默认）→ `dts_settings`，`scope="panel"` → `dts_user_settings`；或 `{ clear: "external"\|"user"\|"all" }` 删键回默认；空设置 → `{ ok:false, error:"NO_SETTINGS", hint }` |
| `pause_collect` | content.js | 等价面板「暂停」 |
| `clear_page` | content.js | 等价面板「清空」（页面内存 + `dts-clear`）。**v0.2.8 起面板有两个清空按钮，它对应的是「清空」（只清本条视频）**，不是「全部清空」。**v0.2.10 起**桥回包 `{ok:true}` 之后内容脚本仍会读回 `chrome.storage.local` 自检（`verifyCleared`），**只有真清掉才显示「已清空」**；失败时回「清空没有生效」并带「`edge://extensions` 重新加载 + F5 刷新」指引（详见 §3.6） |
| `list_videos` | background | `dts_videos` 列表 |
| `get_comments` | background | 按 videoId 读评论；支持 `mode=summary\|page` |
| `export` | background / content | 复用 `dts-export`，返回 `filename/bytes/path`；v0.2.9 起可带 `all:true` 走「全部视频」（CSV 末尾多 `video_id` 列，见 §3.10）。**v0.2.11 起与面板「导出 CSV/JSON」共用 `exportComments()`**：`all:true` 时不传 `videoId` 也能导出；**成功回包主体放 `result`**（`scope / videoCount / count / topLevelCount / replyCount / format / filename / bytes / downloadId / path`），**失败保持顶层** `{ok:false, error, hint}`，口径统一 `MISSING_VIDEO_ID`（既没 videoId 又没 all，hint 提示可传 `all:true`）/ `EMPTY_POOL`（本地无数据），**不再下载只有表头的空 CSV**（详见 §3.10） |
| `clear_storage` | background | 复用 `dts-clear`：带 `videoId` = 只清那条视频（等价面板「清空」）；不带给 `all:true` = 清全部（等价面板「全部清空」，面板那层多一个连点两次的 UI 护栏，桥调用不需要） |

页面类命令失败时必须回 **可操作 hint**（例如：没有抖音 tab、扩展未就绪请刷新页面、网格页请先点开视频）。

### 7.5 content.js 新增监听（实现者 A 必须实现）

在隔离世界注册 `chrome.runtime.onMessage`，**只处理**下列 type，不得吞掉既有 `dts-*` 落库消息：

| type | 行为 | 回包 |
|---|---|---|
| `dts-ai-live-status` | 返回 `__DTS_COLLECTOR_STATUS__()` | `{ ok, status, url, at }` |
| `dts-ai-start` | `await onStartClick()` | `{ ok, status, at }` / `{ ok:false, error }` |
| `dts-ai-pause` | `onPauseClick()` | `{ ok, status }` |
| `dts-ai-clear-page` | `onClearClick()`（**v0.2.10 起**内部走 `sendClear()` 等后台回包，再调 `verifyCleared()` 读回 `chrome.storage.local` 自检；**两边都过才显示「已清空」**，否则回 `ok:false` 并带「清空没有生效 / 去 `edge://extensions` 重新加载 + F5」提示，不再假报成功） | `{ ok, status }` |
| `dts-ai-export` | 等价 `exportAs(format)`，videoId 可用参数覆盖 | 与 `dts-export` 回包一致 |
| `dts-ai-export`（`all: true`，v0.2.9 起） | 导出本地**所有**视频的评论，合成一份（与面板「导出范围 → 全部视频」走同一条 `dts-export` 链路）；此时不需要 videoId，`format` 仍可 `csv`/`json` | 成功回包多 `scope:"all"`、`videoId:null`、`count`、`videoCount`（不带 `all` 时仍是 `scope:"video"` + 具体 videoId）。CSV 末尾追加 `video_id` 列、文件名 `douyin-comments-all-<时间戳>.csv`；JSON 多 `videos` 摘要数组。无 videoId 且没传 `all` 时报 `未识别到视频 ID，无法导出本条视频；可传 all:true 导出本地已存的全部视频` |

另：每约 3s 发 `dts-ai-keepalive`（空消息）帮 MV3 SW 保活；background 必须忽略并回 `{ ok:true, keepalive:true }`。

### 7.6 MCP tools（`douyin-mcp`）

| tool | 参数 | 结果要点 |
|---|---|---|
| `ai_status` | `videoId?` | 扩展/页面/存储总览 + 当前采集设置快照 |
| `ai_list_videos` | — | 已采视频元数据 |
| `ai_start_collect` | 见下「设置参数」全部可选 | 触发当前页采集；带设置时先写 `dts_settings` 再启动 |
| `ai_pause_collect` | — | 暂停 |
| `ai_get_settings` | — | 读设置快照（external / user / effective / precedence / limits） |
| `ai_set_settings` | `scope?=external\|panel`、`clear?=external\|user\|all`，以及「设置参数」 | 写设置或清设置；两样都空 → `NO_SETTINGS`（不会发桥命令） |
| `ai_get_comments` | `videoId`, `mode=summary\|page`, `limit?`, `offset?`, `fields?` | 默认摘要，避免刷爆上下文 |
| `ai_export` | `videoId?`, `all?`, `format=csv\|json` | 文件名/路径；`all:true`（需扩展 ≥ 0.2.11）不传 `videoId` 也能导出本地全部视频合成一份（CSV 末列 `video_id`、回包带 `videoCount`）；两者都不传时 MCP 自己就拒（`videoId 必填`，不发桥命令），旧扩展回 `MISSING_VIDEO_ID` 时补一句「扩展可能太旧（< 0.2.11）」。回包已把 Hub 的 `result` **拍平**（`scope / videoCount / count / topLevelCount / replyCount / format / filename / bytes / path`） |
| `ai_clear_storage` | `videoId?` | 清空（可选） |

**设置参数**（`ai_start_collect` / `ai_set_settings` 通用）: `max`（AI 别名，等价面板齿轮的「目标条数 max」）、`maxCount`、`lanes`、`replyLanes`、`replyGapMs`、`replyWarmupMs`、`replyThrottleMaxWaitMs`。`max` 与 `maxCount` 同时给时以 `max` 为准。其中 `lanes` 是**顶层列表路数**：**v0.2.15 起重新生效**（默认 3 路错峰 200ms，`1` = 老单路；v0.2.12~v0.2.14 期间被固定为单路），实际用的值在 `dts_settings_effective.lanes` 里回显，被自动降路时原因写在 `lanesNote`。

### 7.9 设置（AI 可调）与优先级

三层优先级（`content.js` 每次「开始采集」时重读）:
**内置常量 < `dts_settings`（external，AI 经桥下发） < `dts_user_settings`（panel，面板齿轮里保存的值）**。

- `get_settings` / `ai_get_settings` 返回 `{ external, user, effective, precedence, limits }`；`effective` = 上次采集实际生效的 `dts_settings_effective`（含 `from: 'panel'|'plugin'`）。
- `set_settings` / `ai_set_settings` 只写一层；写值都过 `clampSettings()` 钳位（`lanes 1..8`（v0.2.15 起生效）、`maxCount 0..1000000`、`replyLanes 1..8`、`replyGapMs 0..60000`、`replyWarmupMs 0..600000`、`replyThrottleMaxWaitMs 10000..600000`），未知键与非法值在回包 `unknown` 里列出。
- 想「一键恢复默认」用 `clear: 'all'`（同时删两层的键）；面板里按「恢复默认」只删 `dts_user_settings`。


### 7.7 硬约束

1. **不改采集语义**：AI 不得绕过限速、不得伪造签名、不得注入额外网络请求（Hub↔扩展仅本机控制面）。
2. **落库标签规则不变**（§3.5）：AI `start_collect` 后数据仍按签名 `aweme_id` 分池。
3. **导出成功判据不变**（§3.4 / README）：必须等下载终态，不得谎报「已导出」。
4. **Hub 默认端口 18765**，绑定 `127.0.0.1`；不得监听 `0.0.0.0`。
5. **别人能用的前提**仍写在 README：装扩展 + 登录抖音 + 打开视频页 + 本地跑 Hub/MCP。

### 7.8 验收（最小）

- Hub 未启动时：扩展 poll 静默失败，**不影响**面板采集。
- Hub 启动后：`ai_status` 有 `hub.ok=true`；无抖音 tab 时 `ai_start_collect` 返回明确 hint。
- 有抖音 tab 且扩展就绪：`ai_start_collect` 后 `live_status.phase ∈ {waiting-sign, collecting, ...}`，与面板一致。
- `ai_export` 后磁盘存在对应文件，且 `result.ok===true`（对齐既有导出契约）。
