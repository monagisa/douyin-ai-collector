# 抖音评论采集器 + MCP

面向 GitHub 的推荐仓库结构（monorepo）：

```text
douyin-ai-collector/          ← 仓库根（可自行命名）
├─ README.md                  ← 本文件：总览与导航
├─ .gitignore
├─ douyin-collector/          ← Chrome MV3 扩展（主项目）
├─ dsh-douyin-comments/       ← 可选：DSH 插件（把采集做成 agent 工具 douyin_comments，自带扩展自动安装）
├─ douyin-mcp/                ← 可选：AI / MCP 控制面（控制采集）
└─ release/                    ← 打包好的发布物（含给别人用的 tgz / 扩展 zip / 使用说明）
```

若只上传扩展，可单独使用 `douyin-collector/` 目录；AI 调用请同时带上 `douyin-mcp/`。

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
4. （可选，DSH）`dsh plugin --profile web add file:./dsh-douyin-comments` 后重启 dsh，直接对 agent 说
   「采集这个视频的评论 <链接>」——扩展由插件自己装，不用手动加载目录；目标条数 `max`（默认 80000）、
   并发路数 `lanes`（默认 4）、超时、等扫码秒数、是否先清空、二级回复限速可在 DSH
   「设置 → 插件 → dsh-douyin-comments」里改（0.5.0 起，改完立即生效，不用重启）；
   **扩展面板标题栏右上角的设置齿轮 `⚙`**（0.2.5 起，在收起「—」左边；0.2.4 是面板第三行的「设置」文字按钮）
   优先级更高，用不用 DSH 都能改，可调项含 `max`（目标条数）/并发路数/回复并发/回复间隔/限流等待。
   要把这套发给别人：用 [release/dsh-douyin-comments-v0.5.3.zip](./release/dsh-douyin-comments-v0.5.3.zip)
   （单文件，解压后是 `dsh-douyin-comments-0.5.3.tgz` 插件包 + `douyin-collector-extension-v0.2.5.zip`
   单独扩展 + `使用说明.md` + `SHA256SUMS.txt`）。

---

## 合规提示

- 仅用于自有账号、公开数据与研究场景  
- 可能违反平台用户协议，风险自负  
- 勿提交 Cookie、profile、私钥、真实评论数据集  

详细限制与数据口径见扩展 README / INSTALL。
