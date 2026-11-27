/**
 * 验证转盘落点：连转 N 次，用几何独立验算指针指向的扇区，
 * 与页面显示结果比对（不信任被测代码自己的结论）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = process.env.OUT_DIR || path.join(process.env.TEMP, 'eat-ui-shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9335;
const URL_BASE = 'http://127.0.0.1:8787/';
const N = 12;

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--proxy-server=direct://', '--proxy-bypass-list=*',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP, 'edge-spin2-' + Date.now())}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(p) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(300);
  }
  throw new Error('cdp not ready');
}

const probe = `
  (() => {
    const canvas = document.querySelector('#wheel');
    // 从 DOM 取当前启用项的顺序（与绘制顺序一致）
    const items = window.__probeItems || [];
    const res = (document.querySelector('.result__value > span') || {}).textContent || '';
    const m = /rotate\\(([-0-9.]+)deg\\)/.exec(canvas.style.transform || '');
    const rot = m ? parseFloat(m[1]) : 0;

    // 几何验算：扇区 i 在未旋转时位于 [-90 + start, -90 + start + sweep]
    // 旋转 rot 后，指针（屏幕正上方 = -90°）指向的未旋转角度为 (-90 - rot)
    const total = items.reduce((s, o) => s + Math.max(0.0001, o.weight), 0);
    let acc = 0;
    const target = ((-90 - rot) % 360 + 360) % 360;   // 归一化到 [0,360)
    let hit = null;
    for (let i = 0; i < items.length; i++) {
      const sweep = (Math.max(0.0001, items[i].weight) / total) * 360;
      const start = ((-90 + acc) % 360 + 360) % 360;
      // 判断 target 是否落在 [start, start+sweep) 模 360
      let rel = (target - start + 360) % 360;
      if (rel < sweep) { hit = items[i].text; break; }
      acc += sweep;
    }
    return JSON.stringify({ rot, res, hit });
  })()
`;

async function main() {
  const targets = await getJSON('/json/list');
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_BASE });
  await sleep(2600);

  // 把选项与权重导出到 window，供探针使用
  await send('Runtime.evaluate', {
    expression: `
      (async () => {
        const r = await fetch('/api/wheel').then(x => x.json());
        window.__probeItems = r.options.filter(o => !o.disabled).map(o => ({text:o.text, weight:o.weight}));
      })()
    `,
    awaitPromise: true,
  });

  const rows = [];
  for (let i = 0; i < N; i++) {
    await send('Runtime.evaluate', { expression: `document.querySelector('#spinBtn').click()` });
    await sleep(5300);
    const r = await send('Runtime.evaluate', { expression: probe, returnByValue: true });
    rows.push(JSON.parse(r.result.value));
  }

  const tally = {};
  let bad = 0;
  for (const [i, r] of rows.entries()) {
    const ok = r.hit === r.res;
    if (!ok) bad++;
    tally[r.res] = (tally[r.res] || 0) + 1;
    console.log(`#${String(i + 1).padStart(2)} rot=${r.rot.toFixed(1).padStart(8)} 显示="${r.res}" 几何="${r.hit}" ${ok ? 'OK' : '<<< MISMATCH'}`);
  }
  console.log('\n分布:', JSON.stringify(tally, null, 0));
  console.log(`不一致: ${bad}/${N}`);

  fs.writeFileSync(path.join(OUT, 'spin.json'), JSON.stringify(rows, null, 2));
  ws.close();
  proc.kill();
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { proc.kill(); } catch {} process.exit(1); });
