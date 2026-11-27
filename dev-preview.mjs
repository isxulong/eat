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
  tags: [],
}));
let tags = [
  { id: 'tag-hot', name: '辣的', color: '#b4401f', sort: 0 },
  { id: 'tag-noodle', name: '面食', color: '#3d6a86', sort: 1 },
  { id: 'tag-fast', name: '快餐', color: '#4a5f2a', sort: 2 },
];
// 给前几条打上标签，便于看筛选效果
options[0].tags = ['tag-hot'];
options[1].tags = ['tag-noodle'];
options[2].tags = ['tag-fast'];
options[3].tags = ['tag-fast'];
options[4].tags = ['tag-fast'];
options[9].tags = ['tag-noodle', 'tag-hot'];

let revision = 1;
let mockPass = 'demo1234';   // 至少 6 位，否则无法被改回（与 /api/password 的校验保持一致）
let bootstrap = true;

/** 所有写接口都返回完整快照，与真实后端保持一致 */
const snapshot = (extra = {}) => ({ revision, title: '今天吃什么', options, tags, ...extra });

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
    res.setHeader('cache-control', 'no-store');
    return json(res, snapshot());
  }
  if (p === '/api/health') {
    return json(res, { ok: true, ms: 1, options: options.length, storage: 'mock', session: 'anon', bootstrapPass: bootstrap });
  }
  if (p === '/api/tags' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 20);
    if (!name) return json(res, { error: 'empty', message: '标签名不能为空' }, 400);
    if (tags.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      return json(res, { error: 'duplicate', message: '这个标签已经有了' }, 409);
    }
    const id = `tag-${Date.now()}`;
    tags = tags.concat({ id, name, color: body.color || '', sort: tags.length });
    revision++;
    return json(res, snapshot({ created: id }));
  }
  if (p.startsWith('/api/tags/') && req.method === 'PATCH') {
    const id = p.split('/').pop();
    const body = await readBody(req);
    const t = tags.find((x) => x.id === id);
    if (!t) return json(res, { error: 'not_found', message: '没有这个分类' }, 404);
    if (body.name != null) {
      const name = String(body.name).trim().slice(0, 20);
      if (!name) return json(res, { error: 'empty', message: '分类名不能为空' }, 400);
      if (tags.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) {
        return json(res, { error: 'duplicate', message: '这个标签已经有了' }, 409);
      }
      t.name = name;
    }
    if (body.color != null) t.color = String(body.color).slice(0, 20);
    revision++;
    return json(res, snapshot());
  }
  if (p.startsWith('/api/tags/') && req.method === 'DELETE') {
    const id = p.split('/').pop();
    tags = tags.filter((t) => t.id !== id);
    for (const o of options) o.tags = (o.tags || []).filter((t) => t !== id);
    revision++;
    return json(res, snapshot());
  }
  if (p === '/api/option-tags' && req.method === 'POST') {
    const body = await readBody(req);
    const ids = body.optionIds || [];
    const tids = body.tagIds || [];
    const mode = body.mode === 'remove' ? 'remove' : 'add';
    for (const o of options) {
      if (!ids.includes(o.id)) continue;
      const set = new Set(o.tags || []);
      for (const t of tids) mode === 'remove' ? set.delete(t) : set.add(t);
      o.tags = [...set];
    }
    revision++;
    return json(res, snapshot());
  }
  if (p === '/api/options' && req.method === 'POST') {
    const body = await readBody(req);
    const list = body.texts || [];
    const base = options.length;
    options = options.concat(
      list.map((text, i) => ({ id: `demo-n${base + i}-${Date.now()}`, text, weight: 1, disabled: 0, sort: base + i }))
    );
    revision++;
    return json(res, snapshot({ added: list.length, skipped: 0 }));
  }
  if (p.startsWith('/api/options/') && req.method === 'PATCH') {
    const id = p.split('/').pop();
    const body = await readBody(req);
    const o = options.find((x) => x.id === id);
    if (o) Object.assign(o, body);
    revision++;
    return json(res, snapshot({ ok: true }));
  }
  if (p.startsWith('/api/options/') && req.method === 'DELETE') {
    const id = p.split('/').pop();
    options = options.filter((x) => x.id !== id);
    revision++;
    return json(res, snapshot({ ok: true }));
  }
  if (p === '/api/options/batch' && req.method === 'POST') {
    const body = await readBody(req);
    for (const id of body.remove || []) options = options.filter((x) => x.id !== id);
    for (const u of body.update || []) {
      const o = options.find((x) => x.id === u.id);
      if (o) Object.assign(o, u);
    }
    revision++;
    return json(res, snapshot({ applied: { added: 0, updated: (body.update || []).length, removed: (body.remove || []).length } }));
  }
  if (p === '/api/wheel/import' && req.method === 'POST') {
    const body = await readBody(req);
    options = (body.texts || []).map((text, i) => ({ id: `demo-i${i}-${Date.now()}`, text, weight: 1, disabled: 0, sort: i }));
    revision++;
    return json(res, snapshot({ imported: options.length, mode: body.mode || 'replace' }));
  }
  if (p === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.token !== mockPass) return json(res, { error: 'bad_token', message: '口令不正确' }, 401);
    return json(res, { ok: true, exp: Date.now() + 7200000, bootstrap });
  }
  if (p === '/api/password' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.next && body.next.length >= 6) {
      if (bootstrap || body.current === mockPass) {
        mockPass = body.next;
        bootstrap = false;
        return json(res, { ok: true, updatedAt: Date.now() });
      }
      return json(res, { error: 'bad_current', message: '当前口令不正确' }, 401);
    }
    return json(res, { error: 'weak', message: '新口令至少 6 位' }, 400);
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
