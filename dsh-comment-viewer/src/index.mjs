/**
 * dsh-comment-viewer —— 把「评论分析台（交互词云 + 评论表）」嵌入 DSH Web。
 *
 * 服务端只做两件事：
 *   1. 把本包 app/ 目录（纯静态的评论分析台）挂到 /plugins/dsh-comment-viewer/app；
 *   2. 提供两个只读接口，让页面不用手选文件就能读本地导出的评论 JSON：
 *        GET  <prefix>/api/list            列出可读的 douyin-comments-*.json
 *        GET  <prefix>/api/load?path=<p>   读取其中一个（必须在允许的目录里）
 *
 * 目录来源（按顺序去重）：
 *   - 环境变量 DSH_COMMENT_VIEWER_DIRS（分号分隔，可写多个）
 *   - ~/.dsh/douyin-collector/out（采集插件/扩展的全局默认输出目录）
 *   - <当前工作目录>/douyin-comments（DSH 插件默认落盘目录）
 */
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const name = "dsh-comment-viewer";
export const inject = ["webServer"];

const PREFIX = "/plugins/dsh-comment-viewer/app";
const appDir = fileURLToPath(new URL("../app/", import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};

/** 允许被读取的目录列表（绝对路径，去重、去不存在的） */
export function viewRoots() {
  const out = [];
  const push = (dir) => {
    if (!dir) return;
    const abs = path.resolve(String(dir));
    if (!out.includes(abs) && existsSync(abs)) out.push(abs);
  };
  for (const dir of String(process.env.DSH_COMMENT_VIEWER_DIRS || "").split(";")) push(dir.trim());
  push(path.join(os.homedir(), ".dsh", "douyin-collector", "out"));
  push(path.join(process.cwd(), "douyin-comments"));
  return out;
}

/** 读取 JSON 头部的 count 字段（只读前 8KB，够用且不慢） */
function peekCount(file) {
  try {
    const head = readFileSync(file, { encoding: "utf8", flag: "r" }).slice(0, 8192);
    const m = head.match(/"count"\s*:\s*(\d+)/);
    if (m) return Number(m[1]);
    const videoId = head.match(/"videoId"\s*:\s*"(\d+)"/);
    return videoId ? 0 : 0;
  } catch {
    return 0;
  }
}

/** 列出所有可读的导出 JSON（按 mtime 倒序） */
export function listExports() {
  const files = [];
  for (const root of viewRoots()) {
    let names;
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of names) {
      if (!/^douyin-comments-.*\.json$/i.test(entry)) continue;
      const full = path.join(root, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const head = readFileSync(full, { encoding: "utf8" }).slice(0, 4096);
      const videoId = (head.match(/"videoId"\s*:\s*"(\d+)"/) || [])[1] || "";
      const title = (head.match(/"title"\s*:\s*"([^"]{0,120})"/) || [])[1] || "";
      files.push({
        name: entry,
        path: full,
        videoId,
        title,
        count: peekCount(full),
        size: st.size,
        mtime: st.mtimeMs,
      });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel = pathname.slice(PREFIX.length);
  if (rel === "" || rel === "/") rel = "/index.html";
  const file = path.resolve(appDir, "." + rel);
  if (!file.startsWith(path.resolve(appDir))) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  const body = readFileSync(file);
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

export function apply(ctx) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: "prefix",
      path: PREFIX,
      handler(req, res) {
        if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") {
          res.writeHead(405, { Allow: "GET, HEAD, POST" });
          res.end();
          return;
        }
        const url = new URL(req.url, "http://localhost");
        const pathname = url.pathname;

        if (pathname === PREFIX || pathname === `${PREFIX}/`) return serveStatic(req, res, pathname);

        if (pathname === `${PREFIX}/api/roots`) {
          sendJson(res, 200, { ok: true, roots: viewRoots() });
          return;
        }

        if (pathname === `${PREFIX}/api/list`) {
          try {
            sendJson(res, 200, { ok: true, roots: viewRoots(), files: listExports() });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String((error && error.message) || error) });
          }
          return;
        }

        if (pathname === `${PREFIX}/api/load`) {
          const target = String(url.searchParams.get("path") || "");
          const abs = path.resolve(target);
          const allowed = viewRoots().some((root) => abs === root || abs.startsWith(root + path.sep));
          if (!target || !allowed) {
            sendJson(res, 403, { ok: false, error: "路径不在允许目录内" });
            return;
          }
          if (!existsSync(abs) || !statSync(abs).isFile()) {
            sendJson(res, 404, { ok: false, error: "文件不存在" });
            return;
          }
          const body = readFileSync(abs);
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": body.length,
            "Cache-Control": "no-store",
          });
          res.end(req.method === "HEAD" ? undefined : body);
          return;
        }

        if (pathname === `${PREFIX}/api/delete`) {
          // v0.1.6：批量删除导出记录（真删磁盘文件，只允许删允许目录里的 douyin-comments-*）
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, error: "只支持 POST" });
            return;
          }
          let raw = "";
          req.on("data", (chunk) => {
            raw += chunk;
            if (raw.length > 1_000_000) req.destroy();
          });
          req.on("end", () => {
            let body = {};
            try {
              body = JSON.parse(raw || "{}");
            } catch {
              sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
              return;
            }
            const targets = Array.isArray(body.paths) ? body.paths : [];
            const roots = viewRoots();
            const deleted = [];
            const failed = [];
            for (const target of targets) {
              const abs = path.resolve(String(target || ""));
              const allowed = roots.some((root) => abs === root || abs.startsWith(root + path.sep));
              const looksLikeExport = /^douyin-comments-.*\.(json|csv)$/i.test(path.basename(abs));
              if (!allowed || !looksLikeExport) {
                failed.push({ path: String(target || ""), error: "不允许删除该路径" });
                continue;
              }
              try {
                if (!existsSync(abs) || !statSync(abs).isFile()) {
                  failed.push({ path: abs, error: "文件不存在" });
                  continue;
                }
                unlinkSync(abs);
                deleted.push(abs);
              } catch (error) {
                failed.push({ path: abs, error: String((error && error.message) || error) });
              }
            }
            sendJson(res, 200, { ok: failed.length === 0, deleted, failed });
          });
          return;
        }

        serveStatic(req, res, pathname);
      },
    }),
  );
}
