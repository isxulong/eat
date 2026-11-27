/**
 * 改口令对话框的「当前口令」显示条件。
 *
 * 这是一个被线上反馈抓到的反转 bug：
 *   bootstrapPass=true（还在用初始口令）→ 后端不要求 current → 不该显示输入框
 *   bootstrapPass=false（已设过自定义）→ 后端强制校验 current → 必须显示
 * 前端曾经写成 hidden = !bootstrap，恰好相反，
 * 导致改过口令后输入框消失、提交空串、永远提示「当前口令不正确」。
 *
 * 本测试对真实部署跑，直接读 DOM 判断显示状态。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = process.env.OUT_DIR || path.join(process.env.TEMP, 'eat-ui-shots');
const PORT = 9362;
const URL_BASE = process.env.BASE || 'http://127.0.0.1:8787/';
const TOKEN = process.env.TOKEN || 'demo1234';

fs.mkdirSync(OUT, { recursive: true });

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--proxy-server=direct://', '--proxy-bypass-list=*',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP, 'edge-pass-' + Date.now())}`,
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

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' | ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_BASE });

  // 生产链路可能 4–12 秒才加载完，必须等到状态确定再操作
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const s = await evalJs(`document.querySelector('#syncState')?.dataset.state`);
    if (s === 'ok' || s === 'local') { ready = true; break; }
  }
  check('页面加载完成', ready);

  const health = await evalJs(`fetch('/api/health',{cache:'no-store'}).then(r=>r.json())`);
  console.log(`\n服务端状态：bootstrapPass=${health.bootstrapPass}\n`);

  // 登录
  await evalJs(`document.querySelector('#editToggle').click()`);
  await sleep(800);

  // 等登录框真正出现再填（生产链路慢，不能固定等）
  for (let i = 0; i < 20; i++) {
    const open = await evalJs(`document.querySelector('#loginDlg')?.open === true`);
    if (open) break;
    await sleep(500);
  }

  await evalJs(`
    (async () => {
      document.querySelector('#tokenInput').value = ${JSON.stringify(TOKEN)};
      document.querySelector('#loginForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
    })()
  `);

  // 等编辑态真正生效（composer 出现），而不是固定 sleep
  let editing = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    editing = await evalJs(`!document.querySelector('#composer').hidden`);
    if (editing) break;
    const err = await evalJs(`document.querySelector('#loginErr')?.hidden === false ? document.querySelector('#loginErr').textContent : ''`);
    if (err) { console.log('  登录报错：', err); break; }
  }
  check('已进入编辑态', editing);

  // 打开口令对话框（它内部要 await health，必须等打开完成）
  await evalJs(`document.querySelector('#passBtn').click()`);
  let dlgOpen = false;
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    dlgOpen = await evalJs(`document.querySelector('#passDlg')?.open === true`);
    if (dlgOpen) break;
  }

  const state = await evalJs(`
    JSON.stringify({
      dlgOpen: document.querySelector('#passDlg').open,
      currentHidden: document.querySelector('#currentField').hidden,
    })
  `);
  const st = JSON.parse(state);
  console.log('  对话框：', state);

  check('口令对话框已打开', st.dlgOpen);
  check(
    `「当前口令」显示状态与 bootstrapPass 一致（bootstrap=${health.bootstrapPass}）`,
    st.currentHidden === health.bootstrapPass,
    `expected currentHidden=${health.bootstrapPass}, got ${st.currentHidden}`
  );

  // 真正改一次口令，验证端到端可用
  const newPass = 'pw' + Date.now().toString().slice(-8);
  const submitResult = await evalJs(`
    (async () => {
      const cur = ${JSON.stringify(TOKEN)};
      document.querySelector('#passNext').value = ${JSON.stringify(newPass)};
      document.querySelector('#passRepeat').value = ${JSON.stringify(newPass)};
      if (!document.querySelector('#currentField').hidden) {
        document.querySelector('#passCurrent').value = cur;
      }
      document.querySelector('#passForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
      await new Promise(r => setTimeout(r, 2500));
      return JSON.stringify({
        dlgOpen: document.querySelector('#passDlg').open,
        err: document.querySelector('#passErr').hidden ? '' : document.querySelector('#passErr').textContent,
      });
    })()
  `);
  const sr = JSON.parse(submitResult);
  console.log('  提交结果：', submitResult);
  check('改口令成功（无报错、对话框已关闭）', sr.dlgOpen === false && !sr.err, sr.err);

  // 用新口令能登录，旧口令不能
  const canLoginNew = await evalJs(`
    fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:${JSON.stringify(newPass)}})})
      .then(r=>r.status)
  `);
  check('新口令可登录', canLoginNew === 200, `status=${canLoginNew}`);

  const oldStatus = await evalJs(`
    fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:${JSON.stringify(TOKEN)}})})
      .then(r=>r.status)
  `);
  check('旧口令已失效', oldStatus === 401, `status=${oldStatus}`);

  // 再打开一次对话框：此时已不是 bootstrap，必须显示「当前口令」
  const again = await evalJs(`
    (async () => {
      document.querySelector('#passBtn').click();
      await new Promise(r => setTimeout(r, 1200));
      return JSON.stringify({ currentHidden: document.querySelector('#currentField').hidden });
    })()
  `);
  const ag = JSON.parse(again);
  check('改成自定义口令后「当前口令」重新出现', ag.currentHidden === false, again);

  // 还原：用新口令把口令改回去，避免污染环境
  await evalJs(`
    (async () => {
      // 上一步已经打开了对话框，等它完成异步探测后再填值
      for (let i = 0; i < 40; i++) {
        if (document.querySelector('#passDlg').open) break;
        await new Promise(r => setTimeout(r, 100));
      }
      await new Promise(r => setTimeout(r, 500));
      document.querySelector('#passCurrent').value = ${JSON.stringify(newPass)};
      document.querySelector('#passNext').value = ${JSON.stringify(TOKEN)};
      document.querySelector('#passRepeat').value = ${JSON.stringify(TOKEN)};
      document.querySelector('#passForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
      await new Promise(r => setTimeout(r, 2500));
    })()
  `);
  const restored = await evalJs(`
    fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:${JSON.stringify(TOKEN)}})})
      .then(r=>r.status)
  `);
  check('口令已还原', restored === 200, `status=${restored}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  ws.close();
  proc.kill();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { proc.kill(); } catch {} process.exit(1); });
