/**
 * 800 条数据下的虚拟滚动与搜索验证。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = 'D:\\GitHub\\eat\\.shots';
const PORT = 9336;
const URL_BASE = 'http://127.0.0.1:8787/';

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--proxy-server=direct://', '--proxy-bypass-list=*',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP, 'edge-bulk-' + Date.now())}`,
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
  const send = (m, p = {}) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id: mid, method: m, params: p }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_BASE });
  await sleep(2600);

  // 1) 首屏渲染行数（应为窗口化后的少量行）
  const domCount = async () =>
    (await send('Runtime.evaluate', {
      expression: `document.querySelectorAll('#list .row').length`,
      returnByValue: true,
    })).result.value;

  console.log('首屏 DOM 行数:', await domCount());

  // 2) 滚到底部
  await send('Runtime.evaluate', {
    expression: `(() => { const l = document.querySelector('#list'); l.scrollTop = l.scrollHeight; })()`,
  });
  await sleep(500);
  console.log('滚到底后 DOM 行数:', await domCount());
  const last = await send('Runtime.evaluate', {
    expression: `(() => {
      const rows = [...document.querySelectorAll('#list .row .row__text')];
      return rows.map(r => r.textContent).slice(-3).join(' | ');
    })()`,
    returnByValue: true,
  });
  console.log('底部可见:', last.result.value);

  // 3) 搜索
  await send('Runtime.evaluate', {
    expression: `(() => {
      const s = document.querySelector('#search');
      s.value = '菜品79';
      s.dispatchEvent(new Event('input', {bubbles:true}));
    })()`,
  });
  await sleep(400);
  const searched = await send('Runtime.evaluate', {
    expression: `(() => {
      const rows = [...document.querySelectorAll('#list .row .row__text')].map(r=>r.textContent);
      return JSON.stringify({ count: rows.length, first: rows.slice(0,6), label: document.querySelector('#countLabel').textContent });
    })()`,
    returnByValue: true,
  });
  console.log('搜索「菜品79」:', searched.result.value);

  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'bulk.png'), Buffer.from(data, 'base64'));
  console.log('saved bulk.png');

  ws.close();
  proc.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); try { proc.kill(); } catch {} process.exit(1); });
