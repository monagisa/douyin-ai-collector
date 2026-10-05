// 把开发目录里的扩展同步进插件自带的 extension/（发布前跑一次）
//
//   node sync-extension.mjs [源目录]
//
// 默认源目录：DOUYIN_EXT_DIR → D:\dycopy\douyin-collector
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const src = process.argv[2] || process.env.DOUYIN_EXT_DIR || 'D:\\dycopy\\douyin-collector';
const dst = path.join(here, 'extension');

const KEEP = ['manifest.json', 'hook.js', 'content.js', 'background.js', 'panel.css', 'app.js', 'index.html', 'style.css'];

if (!fs.existsSync(path.join(src, 'manifest.json'))) {
  console.error('❌ 源目录里没有 manifest.json：' + src);
  process.exit(1);
}
fs.mkdirSync(dst, { recursive: true });
const copied = [];
for (const f of fs.readdirSync(src)) {
  if (!fs.statSync(path.join(src, f)).isFile()) continue;
  if (!/\.(json|js|css|html)$/i.test(f)) continue;
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
  copied.push(f);
}
// manifest.json 带 UTF-8 BOM（Chrome 不在意），但 JSON.parse 会炸 —— 统一去掉再解析
const readJsonTolerant = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const man = readJsonTolerant(path.join(dst, 'manifest.json'));
const missing = KEEP.filter((f) => fs.existsSync(path.join(src, f)) && !copied.includes(f));
console.log(`✅ 已同步 ${copied.length} 个文件：${src} → ${dst}`);
console.log(`   扩展 v${man.version}（${man.name}）；必带文件：${KEEP.join(', ')}`);
if (missing.length) console.log('   未同步：' + missing.join(', '));
