# 抖音评论采集器

在 Chrome / Edge 中采集**抖音公开评论**（含二级回复），导出 CSV / JSON。

- **不破解签名** · **不绕过登录** · **不伪造请求**  
- 复用页面自己生成的签名请求，只改分页 `cursor` / `count`  
- 数据只落在本机 `chrome.storage.local`，可导出后自行分析  
- v0.2.2：并发路数可由外部设置（`chrome.storage.local.dts_settings = {lanes: 1~8}`，默认 4）；
  DSH 插件 `dsh-douyin-comments` 在「设置 → 插件」里改的就是它
- v0.2.3：二级回复的四档限速同样可被外部覆盖（`replyLanes` 并发线程数、`replyGapMs` 同线程页间隔、
  `replyWarmupMs` 进补采前的静默、`replyThrottleMaxWaitMs` 等限流窗口的墙钟上限）；
  不写就等价于老版本（4 / 600ms / 1500ms / 10s），扩展单独使用时行为不变
- v0.2.4：**面板上多了「设置」按钮**（就在「开始采集/暂停」下面一行），点开可直接改
  目标条数 / 并发路数 / 回复并发 / 回复间隔 / 限流等待，存到 `chrome.storage.local.dts_user_settings`；
  优先级 **面板设置 > `dts_settings`（外部/插件写入）> 内置默认**；目标条数到量会自动收工
- v0.2.5：**面板设置入口改成标题栏的齿轮 ⚙**（在「—」收起按钮左边，不再占一整行），
  点开浮层里第一项就是 **`max` 目标条数**（另有 并发路数 / 回复并发 / 回复间隔 / 限流等待），
  当前生效值以「当前：并发 N 路 · 目标 M 条/不限（面板）」显示在浮层顶部
- v0.2.4 配套的插件侧（`dsh-douyin-comments` 0.5.2）**兼容 macOS**：浏览器查找覆盖
  `~/Library/Caches/ms-playwright`、`/Applications/Chromium.app`、`Google Chrome for Testing.app`、
  Homebrew / node 全局模块目录；另外品牌版 Chrome 137+ 会忽略命令行的 `--load-extension`，
  这时要么用 playwright 装的 Chromium，要么用 `DOUYIN_CHROME` 指过去（详见插件 README）
- 可选：配套 **MCP** 让 AI 代理调用采集能力（见下文）

> ⚠️ 使用本工具可能违反抖音用户协议，**账号风险自负**。请仅用于自有账号、公开数据与合规研究。

---

## 适用范围（浏览器兼容）

**本仓库以 Chromium 系浏览器为设计目标，请按此范围使用：**

| 浏览器 | 状态 | 说明 |
|---|---|---|
| **Google Chrome 111+** | ✅ 支持 | 主目标；`world: MAIN` 等需 Chrome 111+ |
| **Microsoft Edge（Chromium）** | ✅ 支持 | 与 Chrome 同一套扩展；入口为 `edge://extensions` |
| Brave / Vivaldi / Opera / Arc 等 Chromium | ⚠️ 尽力兼容 | 需开发者模式手动加载；个别策略可能禁用未打包扩展 |
| **Mozilla Firefox** | ❌ 不支持 | MV3 后台、`world: MAIN` 注入时序、权限与 API 均需移植，当前未做 |
| **Safari** | ❌ 不支持 | 需独立打包与平台工程，不在范围内 |

**其他约定：**

- **安装方式**：仅支持「开发者模式 → 加载已解压的扩展程序」（Chrome 137+ / Edge 已禁用命令行 `--load-extension`）。
- **登录态**：按浏览器隔离；Chrome 登录 ≠ Edge 登录。
- **多浏览器同时装同一扩展**：扩展 ID 可能相同，但 `chrome.storage.local` **互不相通**；AI 联调时建议只开一个装了扩展的浏览器，避免抢 Hub 命令。
- **AI / MCP**：与浏览器种类无关，前提是扩展能在该 Chromium 浏览器里加载并轮询本机 Hub。

若你只需要 Chrome/Edge 以外的浏览器支持，请先按 Chromium 路径验收，再单独立项做 Firefox/Safari 移植。

---

## 功能一览

| 能力 | 说明 |
|---|---|
| 多页面采集 | 视频详情页、推荐/关注/朋友流、精选网格（先点开视频）、「我的」作品页 |
| 二级回复 | 顶层采完自动补采 `reply_comment_total > 0` 的线程 |
| 本地存储 | 按 `videoId` 分池去重，关浏览器数据仍在 |
| 导出 | CSV（UTF-8 BOM）/ JSON，写入浏览器下载目录 |
| 面板 | 右下角可拖动采集面板：状态灯、进度、开始/暂停/导出/清空 |
| AI Bridge | 本地 MCP Hub，AI 可 `status` / `start_collect` / `get_comments` / `export` |

---

## 快速开始

### 1. 安装扩展

Chrome 137+ / Edge 已禁用命令行 `--load-extension`，请手动加载：

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 右上角开启 **开发者模式**
3. **加载已解压的扩展程序** → 选择本目录（含 `manifest.json` 的那一层）
4. 在浏览器中**登录抖音**
5. 打开任意视频页，例如 `https://www.douyin.com/video/<id>`

更多安装/打包/固定扩展 ID 说明见 [INSTALL.md](./INSTALL.md)。

### 2. 采集

1. 等面板状态从「等待签名」变为可开始（或按面板提示打开评论区）
2. 点 **开始采集**
3. 等待「完成」或「已暂停」
4. 点 **导出 CSV** / **导出 JSON**

### 3. 可选：让 AI 调用（MCP）

仓库内配套目录 [`../douyin-mcp`](../douyin-mcp)（若以 monorepo 上传则为同级目录；单独上传扩展时请克隆/拷贝该目录）：

```bat
cd douyin-mcp
node mcp.js
```

在 MiMo Desktop / Claude 等 MCP 客户端中注册 **stdio** server：

```json
{
  "type": "local",
  "command": ["node", "/绝对路径/douyin-mcp/mcp.js"],
  "enabled": true
}
```

Tools：`ai_status` · `ai_list_videos` · `ai_start_collect` · `ai_pause_collect` · `ai_live_status` · `ai_get_comments` · `ai_export` · `ai_clear_storage`  

详细说明见 [douyin-mcp/README.md](../douyin-mcp/README.md)。

---

## 工作原理（摘要）

抖音评论接口依赖页面生成的 `a_bogus` 签名。逆向算法不可行且版本频变。本扩展采用：

```text
① hook.js 在页面主世界截获「页面自己发出的」带签名评论请求
② 只读保存 URL 参数（不伪造、不逆向）
③ 用同一份参数重放，只改 cursor / count —— 等价于让页面多翻几页
④ 采集结果写入 chrome.storage.local，可导出 CSV/JSON
```

**语义**：不伪造身份；签名由页面生成，我们只是让页面自己多请求几页。  
**限制**：页面自身只会主动请求约 2 页 / 10 条评论，因此必须依赖上述重放才能拿到全量；登录态是硬门槛。

协议与实现约束见 [PROTOCOL.md](./PROTOCOL.md)。

---

## 支持的页面

| 页面 | 用法 |
|---|---|
| 视频详情页 `/video/<id>` | 直接打开即可；必要时滚一下评论区让页面发请求 |
| 推荐页 `/?recommend=1`、关注 `/follow`、朋友 `/friend` | 一屏一条视频；点「开始采集」后扩展会尝试自动点开右侧评论图标 |
| 精选 `/jingxuan`、「我的」作品网格 | **必须先点开一条视频**（变成浮层）再采集；网格上扩展不会替你点卡片 |
| 新页面形态 | v0.1.12 起按 **DOM** 判形态，不写死 URL 清单 |

---

## 导出格式

**CSV** 文件名：`douyin-comments-<videoId>-<时间戳>.csv`  

前 15 列自 v0.1.4 起冻结；末尾追加二级回复两列：

```text
cid, create_time, create_time_str, text, text_clean, text_len,
digg_count, reply_comment_total, ip_label, is_hot, is_folded,
level, stick_position, user_nickname, user_uid,
is_reply, parent_cid
```

- UTF-8 BOM，Excel 打开中文不乱码  
- 导出成功 = 文件**真正写盘**；中断不会谎报「已导出」  

**JSON** 含 `videoId` / `count` / `topLevelCount` / `replyCount` / `comments[]` 等字段。

---

## 目录结构

```text
douyin-collector/          ← 本扩展（发布主体）
├─ manifest.json           MV3 清单
├─ background.js           存储 / 导出 / 清空 / AI Bridge 轮询
├─ hook.js                 主世界：截获签名、重放
├─ content.js              隔离世界：采集循环、面板、上报
├─ panel.css               面板样式
├─ PROTOCOL.md             跨文件协议（实现约束）
├─ INSTALL.md              安装 · 打包 · 排错
└─ README.md               本文件

douyin-mcp/                ← 可选配套（建议同仓库上传）
├─ mcp.js                  本地 Hub + MCP stdio（无 npm 依赖）
├─ test-hub.js             Hub 冒烟
├─ test-mcp-handshake.js   MCP 握手冒烟
├─ config.example.json
├─ douyin-mcp.cmd          Windows 启动包装
└─ README.md

douyin-collector-test/     ← 本地测试脚本（默认不进发行包）
└─ *.mjs                   E2E / 探针脚本（需本机 Playwright + 登录 profile）
```

**权限**（最小集）：`storage` · `unlimitedStorage` · `downloads` · `scripting`  
**Host**：`*://*.douyin.com/*` · `*://*.iesdouyin.com/*` · `http://127.0.0.1/*` · `http://localhost/*`（AI Hub）  

> 排错：用本目录 `index.html`（Hub 探测）在浏览器打开。扩展侧不再使用 `chrome.alarms`。
数据流：

```text
hook.js (MAIN)  ──postMessage──►  content.js (ISOLATED)  ──runtime──►  background.js
     签名截获 / replay                 限速采集 / 面板 UI              落库 / 导出 / AI
```

---

## 设计边界（合规）

1. 不逆向 / 不伪造 `a_bogus`  
2. 重放只改 `cursor` / `count`，不改 host、方法、其它参数  
3. 不绕过登录，不使用账号池  
4. 单浏览器顺序请求，速率不高于页面自身  
5. 只采评论正文与公开计数，不采手机号/私信等  
6. 登录态降级即暂停，不尝试抗风控  

---

## 已知限制

- **需要登录**：未登录通常只能拿到约 2 页 / 10 条  
- **签名约 8 分钟过期**：过期后暂停，刷新页面重来  
- **服务端 `total` ≠ 实收数**：`total` 常含二级回复与已删除/过滤但仍计数的评论；列表接口 `has_more=0` 为物理终点  
- **热榜区有重复**：cursor 靠前区段会重排，去重后唯一数会低于累计返回数  
- **风控真实存在**：服务端可能在 cookie 未过期时作废会话；请自行评估使用风险  

更完整的实测与口径说明见 [INSTALL.md](./INSTALL.md) 与 [PROTOCOL.md](./PROTOCOL.md)。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 面板不出现 | 确认在抖音页、扩展已加载；`chrome://extensions` 看是否有错误 |
| `Extension context invalidated` | 刚在扩展页点过「重新加载」→ **F5 刷新抖音页**再采集（旧 content script 已作废） |
| 一直「等待签名」 | 刷新页面；feed 页等扩展自动点开评论；网格页先点开一条视频 |
| 条数远小于页面上的「X.X万」 | 正常：服务端 total 口径与列表可翻页集合不同 |
| 导出无反应 | 查看 `chrome://downloads` 与扩展 Service Worker 控制台 |
| 换机器/换路径后数据消失 | 扩展 ID 随路径变化；旧数据在旧 ID 的 storage 里（见 INSTALL） |

---

## 相关文档

- [INSTALL.md](./INSTALL.md) — 安装、打包、固定扩展 ID、排错  
- [PROTOCOL.md](./PROTOCOL.md) — 内部协议与 AI Bridge（v0.2.0 §7）  
- [../douyin-mcp/README.md](../douyin-mcp/README.md) — MCP / AI 调用  

---

## License

个人自用 / 学习研究向工具。上传 GitHub 前请自行确认合规义务，并勿提交：
- 登录 Cookie / 浏览器 profile  
- 真实评论数据集  
- 私钥（`.pem`）与本机绝对路径敏感配置  
