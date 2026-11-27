/**
 * 面板高度与列表可见行数验证，覆盖多种视口。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = process.env.OUT_DIR || path.join(process.env.TEMP, 'eat-ui-shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9353;
const URL_BASE = process.argv[2] || 'http://127.0.0.1:8787/';

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--proxy-server=direct://', '--proxy-bypass-list=*',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP, 'edge-h-' + Date.now())}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(p) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); if (r.ok) return await r.json(); } catch {}
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
    if (m.method === 'Page.javascriptDialogOpening') {
      send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
  };
  const send = (m, p = {}) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: mid, method: m, params: p }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');

  const probe = `
    (() => {
      const q = (s) => document.querySelector(s);
      const l = q('#list');
      const rows = document.querySelectorAll('#list .row').length;
      const cs = getComputedStyle(l);
      return JSON.stringify({
        vh: window.innerHeight,
        panelH: Math.round(q('.panel').getBoundingClientRect().height),
        listH: Math.round(l.getBoundingClientRect().height),
        visibleRows: Math.round(l.getBoundingClientRect().height / 38),
        domRows: rows,
        editing: q('.panel').dataset.edit === '1',
      });
    })()
  `;

  const sizes = [
    ['笔记本 1440x800', 1440, 800],
    ['小笔记本 1280x720', 1280, 720],
    ['桌面 1920x1080', 1920, 1080],
    ['手机 390x844', 390, 844],
  ];

  for (const [name, w, h] of sizes) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
    await send('Page.navigate', { url: URL_BASE });
    await sleep(2200);
    console.log(`\n── ${name} ──`);
    console.log('  浏览态:', await evalJs(probe));

    // 进入编辑态（录入区出现，最容易把列表挤小）
    if (w >= 600) {
      await evalJs(`document.querySelector('#editToggle').click()`);
      await sleep(400);
      await evalJs(`
        (async () => {
          const t = document.querySelector('#tokenInput');
          if (t) { t.value = 'demo1234'; document.querySelector('#loginForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true})); }
        })()
      `);
      await sleep(1400);
      console.log('  编辑态:', await evalJs(probe));

      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, `panel-${w}x${h}.png`), Buffer.from(data, 'base64'));
    }
  }

  ws.close();
  proc.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); try { proc.kill(); } catch {} process.exit(1); });
