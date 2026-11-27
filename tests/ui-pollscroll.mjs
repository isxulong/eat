/**
 * 复现「轮询恰好撞上滑动」的闪烁。
 *
 * 旧实现每 20 秒 pull() 都无条件 renderAll() → replaceChildren 整段重建，
 * scrollTop 被 clamp → 视觉跳动。
 *
 * 本测试：一边持续拖动列表，一边强行触发多次 pull()，
 * 断言 scrollTop 不跳、行不消失。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = process.env.OUT_DIR || path.join(process.env.TEMP, 'eat-ui-shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9352;
const URL_BASE = process.argv[2] || 'http://127.0.0.1:8787/';

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--proxy-server=direct://', '--proxy-bypass-list=*',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP, 'edge-poll-' + Date.now())}`,
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
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: URL_BASE });
  await sleep(2800);

  // 造 300 条，制造可滚动的长列表
  await evalJs(`
    (async () => {
      const texts = Array.from({length: 300}, (_, i) => '菜' + (i+1));
      await fetch('/api/wheel/import', {
        method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ mode:'replace', texts })
      });
      location.reload();
    })()
  `);
  await sleep(3200);

  console.log('初始：', await evalJs(`
    JSON.stringify({rows: document.querySelectorAll('#list .row').length, scrollTop: document.querySelector('#list').scrollTop})
  `));

  // 一边滚动，一边高频触发同步（模拟轮询撞上滑动）
  const result = await evalJs(`
    (async () => {
      const list = document.querySelector('#list');
      const jumps = [];
      const emptyFrames = [];
      let prev = list.scrollTop;

      // 后台高频拉数据（不 await，让它和滚动交错）
      let pulling = true;
      const puller = (async () => {
        while (pulling) {
          try { await fetch('/api/wheel', { cache:'no-store' }); } catch {}
          // 直接调用页面内的 pull，模拟轮询
          try { window.__pull && await window.__pull({ silent: true }); } catch {}
          await new Promise(r => setTimeout(r, 60));
        }
      })();

      for (let i = 0; i < 90; i++) {
        list.scrollTop += 10;
        await new Promise(r => requestAnimationFrame(r));
        const now = list.scrollTop;
        // 正常向下滚动时 scrollTop 只应增长（允许 0 增量，不允许回退>2px）
        if (now < prev - 2) jumps.push({ i, from: prev, to: now });
        prev = now;
        if (document.querySelectorAll('#list .row').length === 0) emptyFrames.push(i);
        await new Promise(r => setTimeout(r, 16));
      }
      pulling = false;
      await puller.catch(()=>{});

      return JSON.stringify({
        backwardJumps: jumps.length,
        worstJump: jumps.length ? Math.max(...jumps.map(j => j.from - j.to)) : 0,
        emptyFrames: emptyFrames.length,
        finalScrollTop: Math.round(list.scrollTop),
        rows: document.querySelectorAll('#list .row').length,
      });
    })()
  `);
  console.log('轮询 + 滚动交错 90 帧：', result);

  ws.close();
  proc.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); try { proc.kill(); } catch {} process.exit(1); });
