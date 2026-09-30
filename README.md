# 抖音评论采集器 + MCP

面向 GitHub 的推荐仓库结构（monorepo）：

```text
douyin-ai-collector/          ← 仓库根（可自行命名）
├─ README.md                  ← 本文件：总览与导航
├─ .gitignore
├─ douyin-collector/          ← Chrome MV3 扩展（主项目）
└─ douyin-mcp/                ← 可选：AI / MCP 控制面
```

若只上传扩展，可单独使用 `douyin-collector/` 目录；AI 调用请同时带上 `douyin-mcp/`。

---

## 项目是什么

**抖音评论采集器**：在浏览器里采集公开评论并导出 CSV/JSON。  
设计原则：不破解签名、不绕过登录、不伪造请求；复用页面自己生成的签名，只改分页游标。

**适用范围**：**Chrome 111+ / Edge（Chromium）**；**不支持** Firefox、Safari。详见 [douyin-collector/README.md](./douyin-collector/README.md)「适用范围」。

**douyin-mcp**：本地 MCP Hub，让 AI 代理通过 tools 调用采集能力（状态 / 开采 / 读评论 / 导出）。

| 目录 | 文档 |
|---|---|
| 扩展 | [douyin-collector/README.md](./douyin-collector/README.md) |
| 安装打包 | [douyin-collector/INSTALL.md](./douyin-collector/INSTALL.md) |
| 内部协议 | [douyin-collector/PROTOCOL.md](./douyin-collector/PROTOCOL.md) |
| MCP | [douyin-mcp/README.md](./douyin-mcp/README.md) |

---

## 快速体验

> 浏览器：仅 **Chrome / Edge（Chromium）**，版本建议 ≥ 111；加载解压目录，不要用命令行 `--load-extension`。

1. Chrome 或 Edge → `chrome://extensions` / `edge://extensions` → 开发者模式 → **加载已解压的扩展** → `douyin-collector/`
2. 在**该浏览器**登录抖音，打开视频页，点面板 **开始采集** → **导出 CSV**
3. （可选）`cd douyin-mcp && node mcp.js`，在 MCP 客户端注册 stdio server

---

## 合规提示

- 仅用于自有账号、公开数据与研究场景  
- 可能违反平台用户协议，风险自负  
- 勿提交 Cookie、profile、私钥、真实评论数据集  

详细限制与数据口径见扩展 README / INSTALL。
