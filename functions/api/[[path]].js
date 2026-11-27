/**
 * Cloudflare Pages Function — 转盘选项 API
 * 路由：/api/*（functions/api/[[path]].js 捕获全部子路径）
 *
 * 存储：D1（通过 REST 调用，避免依赖 wrangler 打包 D1 绑定；
 *      若环境里存在 env.DB 绑定则优先使用，直连更快）
 *
 * 鉴权：写接口需要 Bearer token；token 由 ADMIN_TOKEN 校验后换取
 *      短期 session cookie（2h），前端不保存口令本身。
 */

const WHEEL_ID = 'default';
const SESSION_TTL = 2 * 60 * 60 * 1000; // 2h
const MAX_TEXT_LEN = 200;
const MAX_BATCH = 2000;
const MAX_PAYLOAD = 256 * 1024;

/* ---------------- 工具 ---------------- */

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...extra,
    },
  });

const err = (code, message, status = 400, extra = {}) =>
  json({ error: code, message, ...extra }, status);

const now = () => Date.now();

function uuid() {
  return crypto.randomUUID();
}

/** 定长比较，避免时序侧信道 */
function safeEqual(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** 规范化文本：去首尾空白、压缩内部空白、截断 */
function normText(t) {
  return String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LEN);
}

/* ---------------- D1 访问层 ---------------- */

const CF_API = 'https://api.cloudflare.com/client/v4';

function d1Conf(env) {
  const token = env.CLOUDFLARE_API_TOKEN;
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const db = env.CLOUDFLARE_D1_ID;
  if (!token || !account || !db) return null;
  return { token, account, db };
}

/** 统一执行：支持 D1 绑定（env.DB）或 REST 回退 */
async function d1Query(env, sql, params = []) {
  if (env.DB && typeof env.DB.prepare === 'function') {
    const stmt = env.DB.prepare(sql);
    const bound = params.length ? stmt.bind(...params) : stmt;
    const res = await bound.all();
    return res.results ?? [];
  }

  const conf = d1Conf(env);
  if (!conf) throw new Error('d1_not_configured');

  const res = await fetch(
    `${CF_API}/accounts/${conf.account}/d1/database/${conf.db}/query`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${conf.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    }
  );
  const body = await res.json();
  if (!body.success) {
    const msg = body.errors?.map((e) => e.message).join('; ') || 'd1_error';
    throw new Error(msg);
  }
  return body.result?.[0]?.results ?? [];
}

/** 批量（事务）执行 */
async function d1Batch(env, statements) {
  if (!statements.length) return;
  if (env.DB && typeof env.DB.batch === 'function') {
    await env.DB.batch(
      statements.map((s) => {
        const st = env.DB.prepare(s.sql);
        return s.params?.length ? st.bind(...s.params) : st;
      })
    );
    return;
  }
  for (const s of statements) await d1Query(env, s.sql, s.params ?? []);
}

/* ---------------- 会话 ---------------- */

function b64url(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
}

/* --- 口令存储 ---
 * 口令存在 D1 的 meta 表里，不在环境变量里。
 * 这样网页内就能改，不需要去控制台改 Secret 再重新部署。
 * meta 表为空时回退到 env.ADMIN_TOKEN（首次部署的引导值）。
 */

const PASS_KEY = 'admin_pass_hash';
const PASS_SALT = 'admin_pass_salt';

/** PBKDF2-SHA256，迭代 10 万次。Workers 支持 crypto.subtle。 */
async function hashPassword(pass, saltHex) {
  const enc = new TextEncoder();
  const salt = hexToBytes(saltHex);
  const key = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function randomHex(nBytes) {
  const buf = new Uint8Array(nBytes);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

/** 读取当前生效的口令记录；没有则返回 null */
async function getPassRecord(env) {
  const rows = await d1Query(
    env,
    "SELECT k, v FROM meta WHERE k IN (?, ?)",
    [PASS_KEY, PASS_SALT]
  );
  const map = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  if (!map[PASS_KEY] || !map[PASS_SALT]) return null;
  return { hash: map[PASS_KEY], salt: map[PASS_SALT] };
}

/** 校验口令：优先 D1 里的，没有就用 env.ADMIN_TOKEN 引导 */
async function checkPass(env, input) {
  if (typeof input !== 'string' || !input) return false;
  const rec = await getPassRecord(env);
  if (rec) {
    const h = await hashPassword(input, rec.salt);
    return safeEqual(h, rec.hash);
  }
  // 引导期：环境变量
  return Boolean(env.ADMIN_TOKEN) && safeEqual(input, env.ADMIN_TOKEN);
}

/** 是否仍在使用环境变量的引导口令（提示用户改掉） */
async function isBootstrapPass(env) {
  const rec = await getPassRecord(env);
  return !rec && Boolean(env.ADMIN_TOKEN);
}

async function setPass(env, newPass) {
  const salt = randomHex(16);
  const hash = await hashPassword(newPass, salt);
  const ts = now();
  await d1Batch(env, [
    { sql: 'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', params: [PASS_SALT, salt] },
    { sql: 'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', params: [PASS_KEY, hash] },
    { sql: 'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', params: ['admin_pass_updated_at', String(ts)] },
  ]);
  return ts;
}

/** 会话签名密钥：有 D1 记录就用 salt 派生，否则用环境变量 */
async function sessionSecret(env) {
  const rec = await getPassRecord(env);
  return rec ? 'v2:' + rec.salt : 'v1:' + (env.ADMIN_TOKEN || '');
}

async function makeSession(env) {
  const exp = now() + SESSION_TTL;
  const secret = await sessionSecret(env);
  if (!secret || secret === 'v1:') return null;
  const sig = await hmac(secret, `exp:${exp}`);
  return `${exp}.${b64url(sig)}`;
}

async function validSession(env, token) {
  if (!token) return false;
  const [expStr, sig] = String(token).split('.');
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < now()) return false;
  const secret = await sessionSecret(env);
  if (!secret || secret === 'v1:') return false;
  const expect = b64url(await hmac(secret, `exp:${exp}`));
  return safeEqual(sig, expect);
}

function readCookie(req, name) {
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

/** 写权限判定：Bearer 口令 或 有效 session cookie */
async function canWrite(req, env) {
  const auth = req.headers.get('authorization') || '';
  if (auth.startsWith('Bearer ')) {
    if (await checkPass(env, auth.slice(7).trim())) return true;
  }
  return validSession(env, readCookie(req, 'wheel_session'));
}

/* ---------------- 数据读写 ---------------- */

async function getWheel(env) {
  const rows = await d1Query(
    env,
    'SELECT id, title, revision, updated_at FROM wheels WHERE id = ?',
    [WHEEL_ID]
  );
  let wheel = rows[0];
  if (!wheel) {
    const ts = now();
    await d1Query(
      env,
      'INSERT INTO wheels (id, title, revision, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(id) DO NOTHING',
      [WHEEL_ID, '今天吃什么', ts]
    );
    wheel = { id: WHEEL_ID, title: '今天吃什么', revision: 1, updated_at: ts };
  }
  return wheel;
}

async function getOptions(env) {
  return d1Query(
    env,
    `SELECT id, text, weight, disabled, sort FROM options
      WHERE wheel_id = ? ORDER BY sort ASC, created_at ASC`,
    [WHEEL_ID]
  );
}

/* ---- 标签 ---- */

async function getTags(env) {
  return d1Query(
    env,
    'SELECT id, name, color, sort FROM tags WHERE wheel_id = ? ORDER BY sort ASC, created_at ASC',
    [WHEEL_ID]
  );
}

/** option_id -> [tag_id]，一次查询取完，避免 N+1 */
async function getOptionTags(env) {
  const rows = await d1Query(
    env,
    `SELECT ot.option_id, ot.tag_id
       FROM option_tags ot
       JOIN options o ON o.id = ot.option_id
      WHERE o.wheel_id = ?`,
    [WHEEL_ID]
  );
  const map = {};
  for (const r of rows) (map[r.option_id] ||= []).push(r.tag_id);
  return map;
}

/**
 * 写操作收尾：在同一次往返里把 revision +1 并返回完整快照。
 *
 * 关键设计：写接口直接回吐新快照，前端拿到就不必再发一次 GET。
 * 原来「PATCH → 再 GET」是两次往返，每次 1–2.5s，用户感觉「很慢」，
 * 而且那第二次 GET 还有可能命中浏览器缓存拿到旧数据（表现为「不自动刷新」）。
 */
async function commitAndSnapshot(env) {
  const ts = now();
  // 一条语句同时完成递增与取值，省掉一次 SELECT 往返
  const rows = await d1Query(
    env,
    'UPDATE wheels SET revision = revision + 1, updated_at = ? WHERE id = ? RETURNING revision, title',
    [ts, WHEEL_ID]
  );
  const wheel = rows[0] || { revision: 0, title: '今天吃什么' };
  const [options, tags, links] = await Promise.all([
    getOptions(env),
    getTags(env),
    getOptionTags(env),
  ]);
  return {
    revision: wheel.revision,
    title: wheel.title,
    options: options.map((o) => publicOption(o, links[o.id])),
    tags: tags.map(publicTag),
    updatedAt: ts,
  };
}

function publicTag(r) {
  return { id: r.id, name: r.name, color: r.color || '', sort: r.sort };
}

function publicOption(r, tagIds) {
  return {
    id: r.id,
    text: r.text,
    weight: r.weight,
    disabled: r.disabled ? 1 : 0,
    sort: r.sort,
    tags: tagIds || [],
  };
}

/* ---------------- 路由处理 ---------------- */

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+/g, '/');
  const method = request.method.toUpperCase();

  try {
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': url.origin,
          'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
          'access-control-allow-headers': 'content-type,authorization',
          'access-control-allow-credentials': 'true',
        },
      });
    }

    /* ---- GET /api/wheel ---- */
    if (path === '/api/wheel' && method === 'GET') {
      const wheel = await getWheel(env);
      const [options, tags, links] = await Promise.all([
        getOptions(env),
        getTags(env),
        getOptionTags(env),
      ]);
      // 不再让浏览器缓存：写入后必须立刻能读到自己的改动。
      // 原来 max-age=10 会让「改完刷新」在 10 秒内看到旧数据。
      return json(
        {
          revision: wheel.revision,
          title: wheel.title,
          options: options.map((o) => publicOption(o, links[o.id])),
          tags: tags.map(publicTag),
          updatedAt: wheel.updated_at,
        },
        200,
        { 'cache-control': 'no-store' }
      );
    }

    /* ---- GET /api/health ---- */
    if (path === '/api/health' && method === 'GET') {
      const started = now();
      const rows = await d1Query(env, 'SELECT COUNT(*) AS n FROM options', []);
      const authed = await validSession(env, readCookie(request, 'wheel_session'));
      return json({
        ok: true,
        ms: now() - started,
        options: rows[0]?.n ?? 0,
        storage: env.DB ? 'binding' : d1Conf(env) ? 'rest' : 'none',
        session: authed ? 'authed' : 'anon',
        // 仍在用环境变量口令时前端要提示用户改掉
        bootstrapPass: await isBootstrapPass(env),
      });
    }

    /* ---- POST /api/login ---- */
    if (path === '/api/login' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (!(await checkPass(env, String(body.token ?? '')))) {
        return err('bad_token', '口令不正确', 401);
      }
      const session = await makeSession(env);
      return json(
        { ok: true, exp: Number(session.split('.')[0]), bootstrap: await isBootstrapPass(env) },
        200,
        {
          'set-cookie': `wheel_session=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${
            url.protocol === 'https:' ? '; Secure' : ''
          }`,
        }
      );
    }

    /* ---- POST /api/password （改口令，不需重新部署） ---- */
    if (path === '/api/password' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const next = String(body.next ?? '');
      if (next.length < 6) return err('weak', '新口令至少 6 位');
      if (next.length > 128) return err('too_long', '新口令太长');

      // 已经设置过口令时，必须提供当前口令。
      // 引导期（口令还在环境变量里）允许用环境变量口令直接设置首条：
      // 只要 current 能通过校验，或用 Bearer 带了有效口令，就算授权。
      const hasOwn = Boolean(await getPassRecord(env));
      if (hasOwn) {
        if (!(await checkPass(env, String(body.current ?? '')))) {
          return err('bad_current', '当前口令不正确', 401);
        }
      } else {
        const provided = String(body.current ?? '').trim();
        const byCurrent = provided && (await checkPass(env, provided));
        if (!byCurrent && !(await canWrite(request, env))) {
          return err('bad_current', '当前口令不正确', 401);
        }
      }

      const ts = await setPass(env, next);
      // 改完立即下发新会话，旧会话因为签名密钥变了自动失效
      const session = await makeSession(env);
      return json({ ok: true, updatedAt: ts }, 200, {
        'set-cookie': `wheel_session=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${
          url.protocol === 'https:' ? '; Secure' : ''
        }`,
      });
    }

    /* ---- POST /api/logout ---- */
    if (path === '/api/logout' && method === 'POST') {
      return json({ ok: true }, 200, {
        'set-cookie': 'wheel_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      });
    }

    /* ---- 写操作鉴权闸门 ---- */
    const isWrite =
      method === 'POST' || method === 'PATCH' || method === 'DELETE' || method === 'PUT';
    if (path.startsWith('/api/') && isWrite) {
      if (!(await canWrite(request, env))) {
        return err('unauthorized', '需要编辑口令', 401);
      }
      const len = Number(request.headers.get('content-length') || 0);
      if (len > MAX_PAYLOAD) return err('payload_too_large', '内容超过 256KB', 413);
    }

    /* ---- GET /api/export ---- */
    if (path === '/api/export' && method === 'GET') {
      const wheel = await getWheel(env);
      const options = await getOptions(env);
      const fmt = url.searchParams.get('format') || 'json';
      if (fmt === 'txt') {
        const text = options
          .filter((o) => !o.disabled)
          .map((o) => o.text)
          .join('\n');
        return new Response(text, {
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'content-disposition': 'attachment; filename="options.txt"',
          },
        });
      }
      return json({ revision: wheel.revision, title: wheel.title, options });
    }

    /* ---- 标签管理 ---- */

    if (path === '/api/tags' && method === 'GET') {
      const tags = await getTags(env);
      return json({ tags: tags.map(publicTag) });
    }

    if (path === '/api/tags' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const name = normText(body.name).slice(0, 20);
      if (!name) return err('empty', '标签名不能为空');

      const existing = await getTags(env);
      if (existing.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
        return err('duplicate', '这个标签已经有了', 409);
      }
      const id = body.id || uuid();
      const ts = now();
      await d1Query(
        env,
        'INSERT INTO tags (id, wheel_id, name, color, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, WHEEL_ID, name, String(body.color || '').slice(0, 20), existing.length, ts]
      );
      const snap = await commitAndSnapshot(env);
      return json({ ...snap, created: id });
    }

    const tagMatch = path.match(/^\/api\/tags\/([\w-]+)$/);
    if (tagMatch && method === 'PATCH') {
      const id = tagMatch[1];
      const body = await request.json().catch(() => ({}));
      const sets = [];
      const params = [];
      if (body.name != null) {
        const name = normText(body.name).slice(0, 20);
        if (!name) return err('empty', '标签名不能为空');
        sets.push('name = ?');
        params.push(name);
      }
      if (body.color != null) {
        sets.push('color = ?');
        params.push(String(body.color).slice(0, 20));
      }
      if (!sets.length) return err('no_change', '没有要修改的字段');
      params.push(id, WHEEL_ID);
      await d1Query(env, `UPDATE tags SET ${sets.join(', ')} WHERE id = ? AND wheel_id = ?`, params);
      const snap = await commitAndSnapshot(env);
      return json(snap);
    }

    if (tagMatch && method === 'DELETE') {
      const id = tagMatch[1];
      // 删标签同时断开关联，避免留下孤儿行
      await d1Batch(env, [
        { sql: 'DELETE FROM option_tags WHERE tag_id = ?', params: [id] },
        { sql: 'DELETE FROM tags WHERE id = ? AND wheel_id = ?', params: [id, WHEEL_ID] },
      ]);
      const snap = await commitAndSnapshot(env);
      return json(snap);
    }

    /* ---- 给选项设置标签 ---- */
    if (path === '/api/option-tags' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const ids = Array.isArray(body.optionIds) ? body.optionIds : [];
      const tagIds = Array.isArray(body.tagIds) ? body.tagIds : [];
      const mode = body.mode === 'remove' ? 'remove' : 'add';
      if (!ids.length) return err('empty', '没有指定选项');

      const stmts = [];
      for (const oid of ids) {
        if (mode === 'remove') {
          for (const tid of tagIds) {
            stmts.push({
              sql: 'DELETE FROM option_tags WHERE option_id = ? AND tag_id = ?',
              params: [oid, tid],
            });
          }
        } else {
          for (const tid of tagIds) {
            stmts.push({
              sql: 'INSERT INTO option_tags (option_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
              params: [oid, tid],
            });
          }
        }
      }
      if (!stmts.length) return err('no_change', '没有要执行的操作');
      await d1Batch(env, stmts);
      const snap = await commitAndSnapshot(env);
      return json(snap);
    }

    /* ---- POST /api/options  （批量新增） ---- */
    if (path === '/api/options' && method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body) return err('bad_json', '请求体不是合法 JSON');

      const list = Array.isArray(body.texts)
        ? body.texts
        : body.text
        ? [body.text]
        : [];
      if (!list.length) return err('empty', '没有可添加的内容');
      if (list.length > MAX_BATCH) return err('too_many', `一次最多 ${MAX_BATCH} 条`);

      const wheel = await getWheel(env);
      if (
        body.expectedRevision != null &&
        Number(body.expectedRevision) !== wheel.revision
      ) {
        const [options, links] = await Promise.all([getOptions(env), getOptionTags(env)]);
        return err('revision_conflict', '数据已被其他人修改', 409, {
          revision: wheel.revision,
          options: options.map((o) => publicOption(o, links[o.id])),
        });
      }

      const existing = new Set(
        (await getOptions(env)).map((o) => o.text.toLowerCase())
      );
      const base = await d1Query(
        env,
        'SELECT COALESCE(MAX(sort), -1) AS m FROM options WHERE wheel_id = ?',
        [WHEEL_ID]
      );
      let sortCursor = (base[0]?.m ?? -1) + 1;
      const ts = now();
      const stmts = [];
      const added = [];

      for (const raw of list) {
        const text = normText(raw);
        if (!text) continue;
        if (body.dedupe !== false && existing.has(text.toLowerCase())) continue;
        existing.add(text.toLowerCase());
        const id = uuid();
        stmts.push({
          sql: `INSERT INTO options (id, wheel_id, text, weight, disabled, sort, created_at, updated_at)
                VALUES (?, ?, ?, 1, 0, ?, ?, ?)`,
          params: [id, WHEEL_ID, text, sortCursor++, ts, ts],
        });
        added.push({ id, text, weight: 1, disabled: 0, sort: sortCursor - 1 });
      }

      if (!stmts.length) {
        return json({ revision: wheel.revision, added: [], skipped: list.length });
      }
      await d1Batch(env, stmts);
      const snap = await commitAndSnapshot(env);
      return json({ ...snap, added, skipped: list.length - added.length });
    }

    /* ---- PATCH /api/options/:id ---- */
    const patchMatch = path.match(/^\/api\/options\/([\w-]+)$/);
    if (patchMatch && method === 'PATCH') {
      const id = patchMatch[1];
      const body = await request.json().catch(() => ({}));
      const sets = [];
      const params = [];
      if (body.text != null) {
        const t = normText(body.text);
        if (!t) return err('empty_text', '内容不能为空');
        sets.push('text = ?');
        params.push(t);
      }
      if (body.weight != null) {
        const w = Number(body.weight);
        if (!Number.isFinite(w) || w < 0) return err('bad_weight', '权重不合法');
        sets.push('weight = ?');
        params.push(w);
      }
      if (body.disabled != null) {
        sets.push('disabled = ?');
        params.push(body.disabled ? 1 : 0);
      }
      if (body.sort != null) {
        sets.push('sort = ?');
        params.push(Number(body.sort) || 0);
      }
      if (!sets.length) return err('no_change', '没有要修改的字段');

      sets.push('updated_at = ?');
      params.push(now(), id, WHEEL_ID);
      await d1Query(
        env,
        `UPDATE options SET ${sets.join(', ')} WHERE id = ? AND wheel_id = ?`,
        params
      );
      const snap = await commitAndSnapshot(env);
      return json({ ...snap, ok: true });
    }

    /* ---- DELETE /api/options/:id ---- */
    if (patchMatch && method === 'DELETE') {
      const id = patchMatch[1];
      const hard = url.searchParams.get('hard') === '1';
      if (hard) {
        await d1Query(env, 'DELETE FROM options WHERE id = ? AND wheel_id = ?', [
          id,
          WHEEL_ID,
        ]);
      } else {
        await d1Query(
          env,
          'UPDATE options SET disabled = 1, updated_at = ? WHERE id = ? AND wheel_id = ?',
          [now(), id, WHEEL_ID]
        );
      }
      const snap = await commitAndSnapshot(env);
      return json({ ...snap, ok: true });
    }

    /* ---- POST /api/options/batch （后台集中批量） ---- */
    if (path === '/api/options/batch' && method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body) return err('bad_json', '请求体不是合法 JSON');

      const wheel = await getWheel(env);
      if (
        body.expectedRevision != null &&
        Number(body.expectedRevision) !== wheel.revision
      ) {
        const [options, links] = await Promise.all([getOptions(env), getOptionTags(env)]);
        return err('revision_conflict', '数据已被其他人修改', 409, {
          revision: wheel.revision,
          options: options.map((o) => publicOption(o, links[o.id])),
        });
      }

      const stmts = [];
      const ts = now();
      let added = 0,
        updated = 0,
        removed = 0;

      for (const item of body.add || []) {
        const text = normText(item.text);
        if (!text) continue;
        stmts.push({
          sql: `INSERT INTO options (id, wheel_id, text, weight, disabled, sort, created_at, updated_at)
                VALUES (?, ?, ?, ?, 0, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET text = excluded.text, weight = excluded.weight, updated_at = excluded.updated_at`,
          params: [
            item.id || uuid(),
            WHEEL_ID,
            text,
            Number(item.weight) || 1,
            Number(item.sort) || 0,
            ts,
            ts,
          ],
        });
        added++;
      }

      for (const item of body.update || []) {
        if (!item.id) continue;
        const sets = [];
        const params = [];
        if (item.text != null) {
          const t = normText(item.text);
          if (!t) continue;
          sets.push('text = ?');
          params.push(t);
        }
        if (item.weight != null) {
          sets.push('weight = ?');
          params.push(Number(item.weight) || 0);
        }
        if (item.disabled != null) {
          sets.push('disabled = ?');
          params.push(item.disabled ? 1 : 0);
        }
        if (item.sort != null) {
          sets.push('sort = ?');
          params.push(Number(item.sort) || 0);
        }
        if (!sets.length) continue;
        sets.push('updated_at = ?');
        params.push(ts, item.id, WHEEL_ID);
        stmts.push({
          sql: `UPDATE options SET ${sets.join(', ')} WHERE id = ? AND wheel_id = ?`,
          params,
        });
        updated++;
      }

      for (const id of body.remove || []) {
        if (!id) continue;
        stmts.push({
          sql: 'DELETE FROM options WHERE id = ? AND wheel_id = ?',
          params: [id, WHEEL_ID],
        });
        removed++;
      }

      if (!stmts.length) return err('no_change', '批次里没有可执行的操作');
      await d1Batch(env, stmts);
      const snap = await commitAndSnapshot(env);
      return json({ ...snap, applied: { added, updated, removed } });
    }

    /* ---- POST /api/wheel/import （全量替换 / 追加） ---- */
    if (path === '/api/wheel/import' && method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body) return err('bad_json', '请求体不是合法 JSON');

      const mode = body.mode === 'append' ? 'append' : 'replace';
      const list = Array.isArray(body.texts) ? body.texts : [];
      if (!list.length) return err('empty', '没有可导入的内容');
      if (list.length > MAX_BATCH) return err('too_many', `一次最多 ${MAX_BATCH} 条`);

      const wheel = await getWheel(env);
      if (
        body.expectedRevision != null &&
        Number(body.expectedRevision) !== wheel.revision
      ) {
        const [options, links] = await Promise.all([getOptions(env), getOptionTags(env)]);
        return err('revision_conflict', '数据已被其他人修改', 409, {
          revision: wheel.revision,
          options: options.map((o) => publicOption(o, links[o.id])),
        });
      }

      const ts = now();
      const stmts = [];
      if (mode === 'replace') {
        stmts.push({
          sql: 'DELETE FROM options WHERE wheel_id = ?',
          params: [WHEEL_ID],
        });
      }
      const base = mode === 'replace'
        ? 0
        : ((
            await d1Query(
              env,
              'SELECT COALESCE(MAX(sort), -1) AS m FROM options WHERE wheel_id = ?',
              [WHEEL_ID]
            )
          )[0]?.m ?? -1) + 1;

      let sortCursor = base;
      const seen = new Set();
      for (const raw of list) {
        const text = normText(raw);
        if (!text) continue;
        if (seen.has(text.toLowerCase())) continue;
        seen.add(text.toLowerCase());
        stmts.push({
          sql: `INSERT INTO options (id, wheel_id, text, weight, disabled, sort, created_at, updated_at)
                VALUES (?, ?, ?, 1, 0, ?, ?, ?)`,
          params: [uuid(), WHEEL_ID, text, sortCursor++, ts, ts],
        });
      }
      if (body.title) {
        stmts.push({
          sql: 'UPDATE wheels SET title = ? WHERE id = ?',
          params: [String(body.title).slice(0, 100), WHEEL_ID],
        });
      }
      if (!stmts.length) return err('empty', '没有可导入的内容');

      await d1Batch(env, stmts);
      const snap = await commitAndSnapshot(env);
      return json({ ...snap, imported: sortCursor - base, mode });
    }

    return err('not_found', `没有这个接口：${method} ${path}`, 404);
  } catch (e) {
    const msg = e?.message || 'unknown';
    const status = msg === 'd1_not_configured' ? 500 : 500;
    return err('server_error', msg, status);
  }
}
