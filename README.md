# 抖音评论采集器 + MCP

仓库结构 :

```text
douyin-ai-collector/          ← 仓库根（可自行命名）
├─ README.md                  ← 本文件：总览与导航
├─ .gitignore
├─ douyin-collector/          ← Chrome MV3 扩展（主项目）
├─ dsh-douyin-comments/       ← 可选：DSH 插件（把采集做成 agent 工具 douyin_comments，自带扩展自动安装）
├─ douyin-mcp/                ← 可选：AI / MCP 控制面（控制采集）
├─ comment-viewer/            ← 可选：纯静态评论分析台（交互词云 + 评论表，点评论跳用户主页）
├─ dsh-comment-viewer/        ← 可选：DSH 客户端插件（把词云页嵌进 DSH 侧栏「评论词云」）
```

若只上传扩展，可单独使用 `douyin-collector/` 目录；AI 调用请同时带上 `douyin-mcp/`。

> **版本号（v0.5.15 起）**：扩展、DSH 插件、MCP **三件套统一编号**，当前都是 `0.5.53`。
> 最近几版：**0.5.53** 自选视频浮层去掉复选框（整行点击切换，选中只靠描边+提亮）；**0.5.52** 自选视频浮层选中态按 taste 重做（1px 琥珀描边 + 6% 淡底，去厚亮条）；**0.5.51** 词云页洞察面板「主题聚类 / 地域分布」两卡等高、主题多时卡内滚动；**0.5.50** 评论分析台 v4.0 设备兼容性适配（360~1920 无横向溢出、≤620px 评论表变卡片、触屏热区 40px、尊重减少动效）+ 视觉打磨；**0.5.49** 云图页首帧改成「正在载入词云…」占位（不再闪一下空状态的黑底三点）；**0.5.48** 云图改用专用页 `cloud.html`（不再先闪诊断页）+ 云图页加「下载 HTML」+ 侧栏复选框改内联样式（彻底防旧缓存竖排）；**0.5.47** 修复侧栏复选框文字在窄容器/旧缓存下逐字竖排（`.side-body` 防御 + `styles.css?v=` 版本号 + 静态资源 `no-store`）；**0.5.46** 词云页加「情感健康度」评分（0~100 + 四项风险指标，熵权法 + TOPSIS）+ 面板「导出词云」改为新标签页直接打开（不再下载）；**0.5.45** 词云页升级为分析台（情感 + 主题聚类 + 趋势/地域图 + 情感/主题筛选，KPI 8 格、CSV 14 列）；**0.5.44** 等签名期间持续助推（每 3 秒滚/开合评论区，最多 20 次，不再点一次就干等）；**0.5.43** 面板「导出范围」默认不再预选视频，没选时提示「未选中视频」；**0.5.42** 词云页加「导出 CSV / 导出 JSON」两个按钮（12 列 CSV + 结构化 JSON，导当前筛选结果）；**0.5.41** 关键词算法升级（视频内 IDF + 泛词剔除 + 自定义加词/屏蔽，1541 条实测 986→710）；**0.5.40** 词云关键词过滤虚词（「这种/都是/我的」不再上榜）+「过滤虚词」开关；**0.5.39** 选择浮层不再假装已选 1 条（未选中就写「还未选中视频」，按钮改「选中视频」）；**0.5.38** 词云导出打通 AI / MCP（Hub `cloud` 命令、MCP `ai_export_wordcloud`、插件 `cloud:true` → `htmlPath`）；**0.5.37** 词云页两栏等高 + 管理记录批量删除；**0.5.36** 词云骨架屏改大块；**0.5.35** 词云页「清空」持久记忆（刷新/切会话不再回来）；**0.5.34** 词云页空状态居中 + 清空后从下拉移除刚清空那条；**0.5.33** 词云页布局稳定 + 加载骨架屏（切换数据不再跳）；**0.5.32** 词云分词剥离抖音 `[表情]` 标签（`[悲伤]` 不再成为关键词）；**0.5.31** 面板视觉改版（三组分栏 / 单一琥珀色 / 白色「开始采集」/ 采集中状态点变绿 / 次要信息压成一行 / 底部版本号）；**0.5.30** 面板「导出风控日志」换成「导出词云」（一键把一个自包含词云 HTML 导出，双击即可交互，可发给别人）；**0.5.29** CSV 的 `user_unique_id`（抖音号）为空时填数字短号（不新增列）；**0.5.28** 删掉 `user_short_id`（单视频 19 列 / 多条 20 列），
保留 `user_sec_uid`（拼主页）与 `user_unique_id`；**0.5.27** CSV 第 2 行加**中文列名说明**（第 1 行英文键不变）；**0.5.26** 起不再为补标题打开页面，拿不到就显示「视频 <末 8 位>」；**0.5.23** 自选浮层选中高亮；**0.5.22** 全部清空后导出选择立刻复位；**0.5.21** 导出范围只留「导出范围 ▾」；**0.5.20** 支持自选任意几条视频导出；**0.5.19** 面板放大（宽 310px / 基础字号 14px）；**0.5.18** 二级回复预热可调（默认 10 秒，0 = 不预热）。
> 更早对照：发布 v0.5.9~v0.5.12 = 扩展 0.2.11~0.2.14，v0.5.13 / v0.5.14 = 扩展 0.2.15（MCP 依次 0.3.2~0.3.6）。

**下载发布物**（打包好的 tgz / 扩展 zip / 使用说明 / SHA256SUMS）走 **GitHub Releases**，不放在仓库里：
<https://github.com/monagisa/douyin-ai-collector/releases>（最新版直接看 [releases/latest](https://github.com/monagisa/douyin-ai-collector/releases/latest)）。
本仓库是 **public**，release 附件可直接下载；给不熟 GitHub 的人，把 zip / tgz 附件直接传文件即可。

---

## 项目是什么

**抖音评论采集器**：在浏览器里采集公开评论并导出 CSV/JSON。  
设计原则：不破解签名、不绕过登录、不伪造请求；复用页面自己生成的签名，只改分页游标。

**适用范围**：**Chrome 111+ / Edge（Chromium）**；**不支持** Firefox、Safari。详见 [douyin-collector/README.md](./douyin-collector/README.md)「适用范围」。

**douyin-mcp**：本地 MCP Hub，让 AI 代理通过 tools 调用采集能力（状态 / 开采 / 读评论 / 导出）。

**dsh-douyin-comments**：DeepSeek Harness（Cordis）工具插件，把采集做成 agent 的原生工具 `douyin_comments`。
插件**自带浏览器扩展副本**，第一次调用时自动把扩展装进它启动的浏览器；只交付本次新采的数据，
拿不到签名或没有新数据就明确失败。文档见 [dsh-douyin-comments/README.md](./dsh-douyin-comments/README.md)。

**comment-viewer**：纯静态单页「评论分析台」——载入插件/扩展导出的 JSON / CSV，生成**可交互词云**与评论表；
鼠标悬停词语会放大并弹出「说了这个词的评论」，点评论直接跳该用户的抖音主页。无后端、无依赖、数据不出本机。
文档见 [comment-viewer/README.md](./comment-viewer/README.md)。

**dsh-comment-viewer**：DSH 客户端 UI 插件——在 DSH 里加一个「评论词云」页（左侧栏「插件」组），
把上面那个分析台整页嵌进去，自动读取 `~/.dsh/douyin-collector/out` 里最新的导出，不用手动拖文件；
「管理记录」可勾选多条批量删除磁盘上的导出（越权路径会被拒绝）。
文档见 [dsh-comment-viewer/README.md](./dsh-comment-viewer/README.md)。

| 目录 | 文档 |
|---|---|
| 扩展 | [douyin-collector/README.md](./douyin-collector/README.md) |
| 安装打包 | [douyin-collector/INSTALL.md](./douyin-collector/INSTALL.md) |
| 内部协议 | [douyin-collector/PROTOCOL.md](./douyin-collector/PROTOCOL.md) |
| 采集控制 MCP | [douyin-mcp/README.md](./douyin-mcp/README.md) |
| DSH 采集插件 | [dsh-douyin-comments/README.md](./dsh-douyin-comments/README.md) |
| 评论分析网页 | [comment-viewer/README.md](./comment-viewer/README.md) |
| DSH 内嵌词云页 | [dsh-comment-viewer/README.md](./dsh-comment-viewer/README.md) |

---

## 快速体验

> 浏览器：仅 **Chrome / Edge（Chromium）**，版本建议 ≥ 111；加载解压目录，不要用命令行 `--load-extension`。

1. Chrome 或 Edge → `chrome://extensions` / `edge://extensions` → 开发者模式 → **加载已解压的扩展** → `douyin-collector/`
2. 在**该浏览器**登录抖音，打开视频页，点面板 **开始采集** → **导出 CSV**
3. （可选）打开 comment-viewer/index.html，把导出的 JSON/CSV 拖进去 → 看词云、点词看评论、点评论跳主页
4. （可选）`cd douyin-mcp && node mcp.js`，在 MCP 客户端注册 stdio server
5. （可选，DSH）`dsh plugin --profile web add file:./dsh-douyin-comments`，直接对 agent 说
   「采集这个视频的评论 <链接>」——扩展由插件自己装，不用手动加载目录；目标条数 `max`（默认 80000，
   **采到这么多只停止顶层扫描，二级回复仍会补完**——0.5.11 + 扩展 0.2.13 起真正如此）、
   顶层列表路数 `lanes`（0.5.13 + 扩展 0.2.15 起生效：默认 **3 路错峰 200ms**，1 = 单路；发现两路同页会自动降回 1 路）、
   超时、等扫码秒数、是否先清空、二级回复限速（`replyLanes` / `replyGlobalGapMs` / `replyGapMs` / `replyThrottleSec`）与**二级回复预热**（`replyWarmupSec`，0.5.18 起默认 **10 秒**、以前写死 30 秒，0 = 不预热）都可以改，三个入口：
   **扩展面板标题栏右上角的设置齿轮 `⚙`**（0.2.5 起，优先级最高，用不用 DSH 都能改）→
   DSH「设置 → 插件 → dsh-douyin-comments」的设置表（0.5.0 起，改完立即生效，不用重启）→
   AI 经 MCP（`douyin-mcp` 0.5.31）的 `ai_get_settings` / `ai_set_settings`，`ai_start_collect`
   可带 `max` / `lanes` / `replyLanes` / `replyGlobalGapMs` / `replyGapMs` / `replyWarmupMs` / `replyThrottleMaxWaitMs`
   （优先级：面板齿轮 > AI 下发 > 内置默认）。0.5.12 + 扩展 0.2.14 起，回复接口被服务端暂时拒绝时
   **不再「十秒不行就收尾」**：单波最多撞 12 秒，波间停 15/30/60 秒自动再来一波，总窗口默认 120 秒
   （`replyThrottleSec` / `replyThrottleMaxWaitMs` 可调，设 10 秒 = 老行为）；`replyGlobalGapMs = 0`
   明确等于「用内置 250ms」。0.5.14 起**每次调用都写一份运行日志**（`~/.dsh/douyin-collector/logs/`，
   返回值 `logPath`，末尾一行是「收工原因」），**失败或没采完时另存失败现场**（`~/.dsh/douyin-collector/failures/`，
   含截图 / 页面 HTML / 状态 JSON / 日志副本，返回值 `snapshotDir`；正常采完不留，日志留 50 份、现场留 20 份）。
   装完**不用重启**：桌面端这类宿主默认开着 HMR（只监听 profile 配置，`@deepseek-ai/dsh-hmr` 的 `root: []`），
   新装插件会即时重新组合并挂载；只有**覆盖安装同一个包换版本**时才需要重启 DSH 才会加载新代码。
   要把这套发给别人：下载 [v0.5.31 的单文件包](https://github.com/monagisa/douyin-ai-collector/releases/download/v0.5.31/dsh-douyin-comments-v0.5.31.zip)

   （解压后是 `dsh-douyin-comments-0.5.31.tgz` 插件包 + `douyin-collector-extension-v0.5.31.zip`
    单独扩展 + `使用说明.md` + `SHA256SUMS.txt`）。
   对方**不用 DSH、只要 MCP**：下载
   [v0.5.31 里的 MCP 单文件包](https://github.com/monagisa/douyin-ai-collector/releases/download/v0.5.31/douyin-collector-mcp-v0.5.31.zip)
   （解压后是 `douyin-collector/` 扩展源码（0.5.31）+ `douyin-mcp/` 本地 MCP server（0.5.31）+
    `使用说明.md`）。同页附件里还有 `SHA256SUMS.txt` 可校验，单独的中文说明是附件 `USAGE-zh-CN.md`。
   （**v0.5.15 起三件套同号**；v0.5.14 及更早是扩展 `0.2.x` / 插件 `0.5.x` / MCP `0.3.x` 各自编号。）

---

## 合规提示

- 仅用于自有账号、公开数据与研究场景  
- 可能违反平台用户协议，风险自负  
- 勿提交 Cookie、profile、私钥、真实评论数据集  

详细限制与数据口径见扩展 README / INSTALL。
