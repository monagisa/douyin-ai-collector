# 抖音评论采集器 + MCP

仓库结构 :

```text
douyin-ai-collector/          ← 仓库根（可自行命名）
├─ README.md                  ← 本文件：总览与导航
├─ .gitignore
├─ douyin-collector/          ← Chrome MV3 扩展（主项目）
├─ dsh-douyin-comments/       ← 可选：DSH 插件（把采集做成 agent 工具 douyin_comments，自带扩展自动安装）
└─ douyin-mcp/                ← 可选：AI / MCP 控制面（控制采集）
```

若只上传扩展，可单独使用 `douyin-collector/` 目录；AI 调用请同时带上 `douyin-mcp/`。

**下载发布物**（打包好的 tgz / 扩展 zip / 使用说明 / SHA256SUMS）走 **GitHub Releases**，不放在仓库里：
<https://github.com/monagisa/douyin-ai-collector/releases>（最新版直接看 [releases/latest](https://github.com/monagisa/douyin-ai-collector/releases/latest)）。
本仓库是 **private**，这些链接要用有权限的 GitHub 账号打开；要发给没有权限的人，请下载附件后直接传文件。

---

## 项目是什么

**抖音评论采集器**：在浏览器里采集公开评论并导出 CSV/JSON。  
设计原则：不破解签名、不绕过登录、不伪造请求；复用页面自己生成的签名，只改分页游标。

**适用范围**：**Chrome 111+ / Edge（Chromium）**；**不支持** Firefox、Safari。详见 [douyin-collector/README.md](./douyin-collector/README.md)「适用范围」。

**douyin-mcp**：本地 MCP Hub，让 AI 代理通过 tools 调用采集能力（状态 / 开采 / 读评论 / 导出）。

**dsh-douyin-comments**：DeepSeek Harness（Cordis）工具插件，把采集做成 agent 的原生工具 `douyin_comments`。
插件**自带浏览器扩展副本**，第一次调用时自动把扩展装进它启动的浏览器；只交付本次新采的数据，
拿不到签名或没有新数据就明确失败。文档见 [dsh-douyin-comments/README.md](./dsh-douyin-comments/README.md)。

| 目录 | 文档 |
|---|---|
| 扩展 | [douyin-collector/README.md](./douyin-collector/README.md) |
| 安装打包 | [douyin-collector/INSTALL.md](./douyin-collector/INSTALL.md) |
| 内部协议 | [douyin-collector/PROTOCOL.md](./douyin-collector/PROTOCOL.md) |
| 采集控制 MCP | [douyin-mcp/README.md](./douyin-mcp/README.md) |
| DSH 采集插件 | [dsh-douyin-comments/README.md](./dsh-douyin-comments/README.md) |

---

## 快速体验

> 浏览器：仅 **Chrome / Edge（Chromium）**，版本建议 ≥ 111；加载解压目录，不要用命令行 `--load-extension`。

1. Chrome 或 Edge → `chrome://extensions` / `edge://extensions` → 开发者模式 → **加载已解压的扩展** → `douyin-collector/`
2. 在**该浏览器**登录抖音，打开视频页，点面板 **开始采集** → **导出 CSV**
3. （可选）`cd douyin-mcp && node mcp.js`，在 MCP 客户端注册 stdio server
4. （可选，DSH）`dsh plugin --profile web add file:./dsh-douyin-comments`，直接对 agent 说
   「采集这个视频的评论 <链接>」——扩展由插件自己装，不用手动加载目录；目标条数 `max`（默认 80000）、
   并发路数 `lanes`（默认 4，**自扩展 0.2.12 起已停用**：顶层列表固定单路，仅保留兼容）、超时、等扫码秒数、是否先清空、二级回复限速都可以改，三个入口：
   **扩展面板标题栏右上角的设置齿轮 `⚙`**（0.2.5 起，优先级最高，用不用 DSH 都能改）→
   DSH「设置 → 插件 → dsh-douyin-comments」的设置表（0.5.0 起，改完立即生效，不用重启）→
   AI 经 MCP（`douyin-mcp` 0.3.3）的 `ai_get_settings` / `ai_set_settings`，`ai_start_collect`
   可带 `max` / `lanes` / `replyLanes` / `replyGapMs` / `replyWarmupMs` / `replyThrottleMaxWaitMs`
   （优先级：面板齿轮 > AI 下发 > 内置默认）。
   装完**不用重启**：桌面端这类宿主默认开着 HMR（只监听 profile 配置，`@deepseek-ai/dsh-hmr` 的 `root: []`），
   新装插件会即时重新组合并挂载；只有**覆盖安装同一个包换版本**时才需要重启 DSH 才会加载新代码。
   要把这套发给别人：下载 [v0.5.10 的单文件包](https://github.com/monagisa/douyin-ai-collector/releases/download/v0.5.10/dsh-douyin-comments-v0.5.10.zip)
   （解压后是 `dsh-douyin-comments-0.5.10.tgz` 插件包 + `douyin-collector-extension-v0.2.12.zip`
    单独扩展 + `使用说明.md` + `SHA256SUMS.txt`）。
   对方**不用 DSH、只要 MCP**：下载
   [v0.5.10 里的 MCP 单文件包](https://github.com/monagisa/douyin-ai-collector/releases/download/v0.5.10/douyin-collector-mcp-v0.3.3.zip)
   （解压后是 `douyin-collector/` 扩展源码（v0.2.12）+ `douyin-mcp/` 本地 MCP server（v0.3.3）+
    `使用说明.md`）。同页附件里还有 `SHA256SUMS.txt` 可校验，单独的中文说明是附件 `USAGE-zh-CN.md`。

---

## 合规提示

- 仅用于自有账号、公开数据与研究场景  
- 可能违反平台用户协议，风险自负  
- 勿提交 Cookie、profile、私钥、真实评论数据集  

详细限制与数据口径见扩展 README / INSTALL。
