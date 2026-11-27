/**
 * 用 CDP 驱动 Edge headless，截图编辑态与移动端。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = 'D:\\GitHub\\eat\\.shots';
const PORT = 9333;
const URL_BASE = 'http://127.0.0.1:8787/';

fs.mkdirSync(OUT, { recursive: true });

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--proxy-server=direct://', '--proxy-bypass-list=*',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP, 'edge-cdp-' + Date.now())}`,
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
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');

  async function shot(name, w, h, dsf = 1, prep) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: dsf, mobile: w < 600,
    });
    await send('Page.navigate', { url: URL_BASE });
    await sleep(2200);
    if (prep) await prep();
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log('saved', file, fs.statSync(file).size, 'bytes');
  }

  // 1. 编辑态：点「编辑」→ 输口令 → 解锁
  const enterEdit = `
    (async () => {
      document.querySelector('#editToggle').click();
      await new Promise(r => setTimeout(r, 400));
      const dlg = document.querySelector('#loginDlg');
      const inp = document.querySelector('#tokenInput');
      inp.value = 'demo';
      document.querySelector('#loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
      await new Promise(r => setTimeout(r, 900));
      const ta = document.querySelector('#pasteArea');
      ta.value = '麻辣烫\\n兰州拉面\\n黄焖鸡米饭\\n沙县小吃\\n麦当劳\\n肯德基\\n吉野家\\n真功夫';
      ta.dispatchEvent(new Event('input', {bubbles:true}));
      await new Promise(r => setTimeout(r, 300));
    })()
  `;

  await shot('desktop.png', 1440, 980, 1);
  await shot('edit.png', 1440, 980, 1, async () => {
    await send('Runtime.evaluate', { expression: enterEdit, awaitPromise: true });
    await sleep(400);
  });
  await shot('mobile.png', 390, 844, 2);

  ws.close();
  proc.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  try { proc.kill(); } catch {}
  process.exit(1);
});
