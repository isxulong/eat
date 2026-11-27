#!/usr/bin/env node
/**
 * 构建：把 styles.css 和 app.js 内联进 index.html，产出单文件站点。
 *
 * 为什么值得做：
 *   这条线路上实测是 HTTP/1.1（浏览器最多 6 并发，且每次请求都要
 *   完整往返 1–3 秒）。首屏原本要 3 个请求（html / css / js），
 *   内联后只剩 1 个 —— 省掉 2 次往返，按实测每次 800ms–2.6s 算，
 *   能省 1.6–5 秒。
 *
 *   代价：单文件不便于缓存分片。但这个站点的静态资源总量约 87KB
 *   （br 压缩后约 20KB），一次传完反而更划算。
 *
 * 用法：node build.mjs
 * 输出：dist/index.html（单文件，直接用 wrangler pages deploy dist 发布）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, 'public');
const DIST = path.join(ROOT, 'dist');

const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');

if (js.includes('</script')) {
  throw new Error('app.js 里含有 </script 字面量，内联会截断 HTML，需先转义');
}

const out = html
  .replace(
    '<link rel="stylesheet" href="./styles.css">',
    `<style>\n${css}\n</style>`
  )
  .replace(
    '<script src="./app.js" type="module"></script>',
    `<script type="module">\n${js}\n</script>`
  );

if (out === html) {
  throw new Error('内联失败：没有匹配到 styles.css / app.js 的引用，检查 index.html');
}

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, 'index.html'), out, 'utf8');

// 图标是 data: URI，不需要额外文件。确认没有遗漏的外部引用。
const external = [...out.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((m) => m[1]);
if (external.length) {
  throw new Error(`仍有外部引用未内联：${external.join(', ')}`);
}

const before = Buffer.byteLength(html) + Buffer.byteLength(css) + Buffer.byteLength(js);
const after = Buffer.byteLength(out);
console.log(`内联完成：${before} bytes → ${after} bytes（单文件）`);
console.log(`首屏请求数：3 → 1`);
console.log(`输出：${path.join(DIST, 'index.html')}`);
