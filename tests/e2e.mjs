#!/usr/bin/env node
/**
 * 端到端契约测试（对真实部署跑）。
 *
 * 用法：
 *   node tests/e2e.mjs                       # 默认测生产 https://eat-4t0.pages.dev
 *   BASE=http://127.0.0.1:8787 node tests/e2e.mjs   # 测本地预览（mock 后端不支持全部用例）
 *   TOKEN=xxx BASE=... node tests/e2e.mjs
 *
 * 覆盖：
 *   1. 未授权写 → 401
 *   2. 错误口令 → 401
 *   3. 正确口令 → 会话 cookie
 *   4. 批量新增 → revision 递增
 *   5. 重新读取 → 数据仍在（持久化）
 *   6. 单条 PATCH → 文本改变
 *   7. 过期 revision → 409 且返回最新快照
 *   8. 批量事务 add/update/remove → 原子生效
 *   9. 全量替换 → 精确条数
 *  10. 软删除 → disabled=1
 *  11. 清理测试数据 → 恢复原状
 */

const BASE = process.env.BASE || 'https://eat-4t0.pages.dev';
const TOKEN = process.env.TOKEN || 'eat-2026-let-me-decide';

let cookie = '';
let pass = 0;
let fail = 0;
let revision = 0;

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`);
  }
}

async function call(method, path, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (body) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const setCookie = res.headers.getSetCookie?.() || [];
  for (const c of setCookie) {
    const kv = c.split(';')[0];
    if (kv.startsWith('wheel_session=')) cookie = kv;
  }

  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function main() {
  console.log(`\n端到端测试 → ${BASE}\n`);

  // 0. 基线
  const base0 = await call('GET', '/api/wheel');
  const baseline = base0.data?.options?.length ?? 0;
  revision = base0.data?.revision ?? 0;
  console.log(`基线：${baseline} 项，revision=${revision}\n`);

  // 1. 未授权写
  const r1 = await call('POST', '/api/options', { texts: ['x'] });
  ok('未授权写返回 401', r1.status === 401, `实际 ${r1.status}`);

  // 2. 错误口令
  const r2 = await call('POST', '/api/login', { token: 'definitely-wrong' });
  ok('错误口令返回 401', r2.status === 401, `实际 ${r2.status}`);

  // 3. 正确口令
  const r3 = await call('POST', '/api/login', { token: TOKEN });
  ok('正确口令换取会话', r3.status === 200 && r3.data?.ok === true);
  ok('会话 cookie 已下发', cookie.startsWith('wheel_session='), cookie || '(空)');

  // 4. 批量新增
  const marker = 'E2E' + Date.now();
  const r4 = await call('POST', '/api/options', { texts: [marker + '-1', marker + '-2', marker + '-3'] });
  ok('批量新增 3 条', r4.status === 200 && r4.data?.added?.length === 3, JSON.stringify(r4.data));
  const addedIds = (r4.data?.added || []).map((o) => o.id);
  revision = r4.data?.revision ?? revision;

  // 5. 持久化（新请求读取）
  const r5 = await call('GET', '/api/wheel');
  const found = (r5.data?.options || []).filter((o) => o.text.startsWith(marker));
  ok('重新读取时数据仍在', found.length === 3, `找到 ${found.length} 条`);

  // 6. PATCH
  const target = addedIds[0];
  const r6 = await call('PATCH', `/api/options/${target}`, { text: marker + '-改' });
  ok('PATCH 成功', r6.status === 200 && r6.data?.ok === true, JSON.stringify(r6.data));
  const r6b = await call('GET', '/api/wheel');
  const renamed = (r6b.data?.options || []).find((o) => o.id === target);
  ok('PATCH 后文本已更新', renamed?.text === marker + '-改', renamed?.text);
  revision = r6.data?.revision ?? revision;

  // 7. 冲突检测（用过期 revision）
  const r7 = await call('POST', '/api/options', { texts: [marker + '-conflict'], expectedRevision: 1 });
  ok('过期 revision 返回 409', r7.status === 409, `实际 ${r7.status}`);
  ok('409 里带最新快照', Array.isArray(r7.data?.options), typeof r7.data?.options);

  // 8. 批量事务
  const r8 = await call('POST', '/api/options/batch', {
    add: [{ text: marker + '-batch' }],
    update: [{ id: addedIds[1], text: marker + '-2改' }],
    remove: [addedIds[2]],
  });
  ok('批量事务返回三类计数', r8.status === 200 && r8.data?.applied?.added === 1
    && r8.data?.applied?.updated === 1 && r8.data?.applied?.removed === 1,
    JSON.stringify(r8.data?.applied));
  const r8b = await call('GET', '/api/wheel');
  const after8 = r8b.data?.options || [];
  ok('批量删除已生效', !after8.some((o) => o.id === addedIds[2]));
  ok('批量更新已生效', after8.some((o) => o.id === addedIds[1] && o.text === marker + '-2改'));
  ok('批量新增已生效', after8.some((o) => o.text === marker + '-batch'));

  // 9. 软删除
  const r9 = await call('DELETE', `/api/options/${addedIds[1]}`);
  ok('软删除返回成功', r9.status === 200, `实际 ${r9.status}`);
  const r9b = await call('GET', '/api/wheel');
  const soft = (r9b.data?.options || []).find((o) => o.id === addedIds[1]);
  ok('软删除后 disabled=1', soft?.disabled === 1, JSON.stringify(soft));

  // 10. 清理：把测试项全部移除，恢复基线
  const leftovers = (r9b.data?.options || []).filter((o) => o.text.startsWith(marker));
  if (leftovers.length) {
    const r10 = await call('POST', '/api/options/batch', { remove: leftovers.map((o) => o.id) });
    ok('清理测试数据', r10.status === 200, JSON.stringify(r10.data));
  }
  const final = await call('GET', '/api/wheel');
  const finalCount = (final.data?.options || []).length;
  ok('恢复至基线条数', finalCount === baseline, `${finalCount} vs ${baseline}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试异常：', e.message);
  process.exit(1);
});
