/**
 * 本地预览服务（仅开发用，不部署）
 * 托管 public/，并模拟 /api/* 返回样例数据，用于截图核对视觉。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT || 8787);

const BULK = process.env.BULK === '1';
const SAMPLE = BULK ? Array.from({length:800},(_,i)=>'菜品'+(i+1)) : [
  '麻辣烫', '兰州拉面', '黄焖鸡米饭', '沙县小吃', '麦当劳',
  '肯德基', '吉野家', '真功夫', '猪脚饭', '螺蛳粉',
  '酸菜鱼', '火锅', '烧烤', '寿司', '披萨',
];

let options = SAMPLE.map((text, i) => ({
  id: `demo-${i}`,
  text,
  weight: 1,
  disabled: 0,
  sort: i,
}));
let revision = 1;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const json = (res, data, status = 200) => {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === '/api/wheel') {
    return json(res, { revision, title: '今天吃什么', options });
  }
  if (p === '/api/health') {
    return json(res, { ok: true, ms: 1, options: options.length, storage: 'mock', session: 'anon' });
  }
  if (p === '/api/options' && req.method === 'POST') {
    const body = await readBody(req);
    const list = body.texts || [];
    const base = options.length;
    options = options.concat(
      list.map((text, i) => ({ id: `demo-n${base + i}-${Date.now()}`, text, weight: 1, disabled: 0, sort: base + i }))
    );
    revision++;
    return json(res, { revision, added: list.length, skipped: 0 });
  }
  if (p.startsWith('/api/options/') && req.method === 'PATCH') {
    const id = p.split('/').pop();
    const body = await readBody(req);
    const o = options.find((x) => x.id === id);
    if (o) Object.assign(o, body);
    revision++;
    return json(res, { revision, ok: true });
  }
  if (p.startsWith('/api/options/') && req.method === 'DELETE') {
    const id = p.split('/').pop();
    options = options.filter((x) => x.id !== id);
    revision++;
    return json(res, { revision, ok: true });
  }
  if (p === '/api/options/batch' && req.method === 'POST') {
    const body = await readBody(req);
    for (const id of body.remove || []) options = options.filter((x) => x.id !== id);
    for (const u of body.update || []) {
      const o = options.find((x) => x.id === u.id);
      if (o) Object.assign(o, u);
    }
    revision++;
    return json(res, { revision, applied: { added: 0, updated: (body.update || []).length, removed: (body.remove || []).length } });
  }
  if (p === '/api/wheel/import' && req.method === 'POST') {
    const body = await readBody(req);
    options = (body.texts || []).map((text, i) => ({ id: `demo-i${i}-${Date.now()}`, text, weight: 1, disabled: 0, sort: i }));
    revision++;
    return json(res, { revision, imported: options.length, mode: body.mode || 'replace' });
  }
  if (p === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.token !== 'demo') return json(res, { error: 'bad_token', message: '口令不正确' }, 401);
    return json(res, { ok: true, exp: Date.now() + 7200000 });
  }

  // 静态文件
  let file = p === '/' ? '/index.html' : p;
  file = path.join(ROOT, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(file, (e, buf) => {
    if (e) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
});

server.listen(PORT, () => console.log(`preview on http://127.0.0.1:${PORT}`));
