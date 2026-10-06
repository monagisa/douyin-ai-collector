// 把开发目录里的扩展同步进插件自带的 extension/（发布前跑一次）
//
//   node sync-extension.mjs [源目录]
//
// 默认源目录：DOUYIN_EXT_DIR → 仓库平级的 ../douyin-collector（不写死盘符）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const src = process.argv[2] || process.env.DOUYIN_EXT_DIR || path.resolve(here, '..', 'douyin-collector');
const dst = path.join(here, 'extension');

// 只同步白名单：源目录里混入的 probe/备份脚本不能被一起装进浏览器
const KEEP = ['manifest.json', 'hook.js', 'content.js', 'background.js', 'panel.css', 'app.js', 'index.html', 'style.css'];

if (!fs.existsSync(path.join(src, 'manifest.json'))) {
  console.error('❌ 源目录里没有 manifest.json：' + src);
  process.exit(1);
}
fs.mkdirSync(dst, { recursive: true });
const copied = [];
for (const f of KEEP) {
  const s = path.join(src, f);
  if (!fs.existsSync(s) || !fs.statSync(s).isFile()) continue;
  fs.copyFileSync(s, path.join(dst, f));
  copied.push(f);
}
// manifest.json 带 UTF-8 BOM（Chrome 不在意），但 JSON.parse 会炸 —— 统一去掉再解析
const readJsonTolerant = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
// 反向清理：dst 是构建产物目录，白名单之外的文件（旧版本遗留）必须删掉，
// 否则它们会跟着插件一起被装进浏览器，而两处副本一致性校验永远看不见它们。
const pruned = fs.readdirSync(dst).filter((f) => !KEEP.includes(f) && fs.statSync(path.join(dst, f)).isFile());
for (const f of pruned) fs.rmSync(path.join(dst, f), { force: true });
const man = readJsonTolerant(path.join(dst, 'manifest.json'));
const missing = KEEP.filter((f) => fs.existsSync(path.join(src, f)) && !copied.includes(f));
console.log(`✅ 已同步 ${copied.length} 个文件：${src} → ${dst}`);
if (pruned.length) console.log(`   已清掉白名单外的旧文件 ${pruned.length} 个：${pruned.join(', ')}`);
console.log(`   扩展 v${man.version}（${man.name}）；必带文件：${KEEP.join(', ')}`);
if (missing.length) console.log('   未同步：' + missing.join(', '));
