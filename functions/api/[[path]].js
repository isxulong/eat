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

async function makeSession(env) {
  const exp = now() + SESSION_TTL;
  const secret = env.ADMIN_TOKEN;
  if (!secret) return null;
  const sig = await hmac(secret, `exp:${exp}`);
  return `${exp}.${b64url(sig)}`;
}

async function validSession(env, token) {
  if (!token || !env.ADMIN_TOKEN) return false;
  const [expStr, sig] = String(token).split('.');
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < now()) return false;
  const expect = b64url(await hmac(env.ADMIN_TOKEN, `exp:${exp}`));
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

/** 写权限判定：Bearer ADMIN_TOKEN 或有效 session cookie */
async function canWrite(req, env) {
  const auth = req.headers.get('authorization') || '';
  if (auth.startsWith('Bearer ')) {
    if (safeEqual(auth.slice(7).trim(), env.ADMIN_TOKEN)) return true;
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

async function bumpRevision(env) {
  await d1Query(
    env,
    'UPDATE wheels SET revision = revision + 1, updated_at = ? WHERE id = ?',
    [now(), WHEEL_ID]
  );
  const rows = await d1Query(env, 'SELECT revision FROM wheels WHERE id = ?', [
    WHEEL_ID,
  ]);
  return rows[0]?.revision ?? 0;
}

function publicOption(r) {
  return {
    id: r.id,
    text: r.text,
    weight: r.weight,
    disabled: r.disabled ? 1 : 0,
    sort: r.sort,
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
      const options = await getOptions(env);
      return json(
        {
          revision: wheel.revision,
          title: wheel.title,
          options: options.map(publicOption),
        },
        200,
        { 'cache-control': 'public, max-age=10, stale-while-revalidate=60' }
      );
    }

    /* ---- GET /api/health ---- */
    if (path === '/api/health' && method === 'GET') {
      const started = now();
      const rows = await d1Query(env, 'SELECT COUNT(*) AS n FROM options', []);
      return json({
        ok: true,
        ms: now() - started,
        options: rows[0]?.n ?? 0,
        storage: env.DB ? 'binding' : d1Conf(env) ? 'rest' : 'none',
        session: (await validSession(env, readCookie(request, 'wheel_session')))
          ? 'authed'
          : 'anon',
      });
    }

    /* ---- POST /api/login ---- */
    if (path === '/api/login' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (!env.ADMIN_TOKEN) return err('not_configured', '未设置 ADMIN_TOKEN', 500);
      if (!safeEqual(body.token, env.ADMIN_TOKEN)) {
        return err('bad_token', '口令不正确', 401);
      }
      const session = await makeSession(env);
      return json({ ok: true, exp: Number(session.split('.')[0]) }, 200, {
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
        const options = await getOptions(env);
        return err('revision_conflict', '数据已被其他人修改', 409, {
          revision: wheel.revision,
          options: options.map(publicOption),
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
      const revision = await bumpRevision(env);
      return json({ revision, added, skipped: list.length - added.length });
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
      const revision = await bumpRevision(env);
      return json({ revision, ok: true });
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
      const revision = await bumpRevision(env);
      return json({ revision, ok: true });
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
        const options = await getOptions(env);
        return err('revision_conflict', '数据已被其他人修改', 409, {
          revision: wheel.revision,
          options: options.map(publicOption),
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
      const revision = await bumpRevision(env);
      return json({ revision, applied: { added, updated, removed } });
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
        const options = await getOptions(env);
        return err('revision_conflict', '数据已被其他人修改', 409, {
          revision: wheel.revision,
          options: options.map(publicOption),
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
      const revision = await bumpRevision(env);
      return json({ revision, imported: sortCursor - base, mode });
    }

    return err('not_found', `没有这个接口：${method} ${path}`, 404);
  } catch (e) {
    const msg = e?.message || 'unknown';
    const status = msg === 'd1_not_configured' ? 500 : 500;
    return err('server_error', msg, status);
  }
}
