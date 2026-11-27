/**
 * 滚动闪烁验证：
 * 模拟手指持续拖动列表（每 16ms 改一次 scrollTop），
 * 在拖动过程中采样行的 opacity / 存在性。
 * 修复前：拖动中大量行 opacity=0（动画重放）。
 * 修复后：拖动中行始终可见，且 DOM 只在跨越行高时才重建。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = process.env.OUT_DIR || path.join(process.env.TEMP, 'eat-ui-shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9340;
const URL_BASE = 'http://127.0.0.1:8787/';

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--proxy-server=direct://', '--proxy-bypass-list=*',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP, 'edge-scroll-' + Date.now())}`,
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
  // 用移动端视口，贴近用户实际场景
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: URL_BASE });
  await sleep(2600);

  // 加载 800 条，制造真实的滚动压力
  await evalJs(`
    (async () => {
      const texts = Array.from({length: 800}, (_, i) => '菜品' + (i+1));
      await fetch('/api/wheel/import', {
        method: 'POST',
        headers: {'content-type':'application/json'},
        body: JSON.stringify({ mode: 'replace', texts })
      });
      location.reload();
    })()
  `);
  await sleep(3500);

  const probe = `
    (() => {
      const rows = [...document.querySelectorAll('#list .row')];
      const invisible = rows.filter(r => parseFloat(getComputedStyle(r).opacity) < 0.9).length;
      return JSON.stringify({
        rows: rows.length,
        invisible,
        scrollTop: Math.round(document.querySelector('#list').scrollTop),
      });
    })()
  `;

  console.log('滚动前：', await evalJs(probe));

  // —— 模拟持续拖动：每 16ms 滚 12px，共 60 帧 ——
  const during = await evalJs(`
    (async () => {
      const list = document.querySelector('#list');
      const samples = [];
      let rebuilds = 0;
      let lastRows = -1;
      for (let i = 0; i < 60; i++) {
        list.scrollTop += 12;
        await new Promise(r => requestAnimationFrame(r));
        const rows = [...document.querySelectorAll('#list .row')];
        if (rows.length !== lastRows) { rebuilds++; lastRows = rows.length; }
        const invisible = rows.filter(r => parseFloat(getComputedStyle(r).opacity) < 0.9).length;
        samples.push(invisible);
        await new Promise(r => setTimeout(r, 16));
      }
      const worst = Math.max(...samples);
      const framesWithInvisible = samples.filter(n => n > 0).length;
      return JSON.stringify({ worstInvisible: worst, framesWithInvisible, totalFrames: samples.length, rebuilds });
    })()
  `);
  console.log('持续拖动 60 帧：', during);

  console.log('滚动后：', await evalJs(probe));

  // 截图确认滚动位置下的渲染
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'scroll.png'), Buffer.from(data, 'base64'));
  console.log('saved scroll.png');

  ws.close();
  proc.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); try { proc.kill(); } catch {} process.exit(1); });
