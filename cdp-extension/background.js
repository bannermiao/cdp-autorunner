// CDP Bridge Extension — 自动连接 ws://127.0.0.1:18765

const WS_URL = 'ws://127.0.0.1:18765';
const PROBE_MS = 5000;
const KEEPALIVE_MIN = 0.4;

let ws = null;
let attachedTab = null;
let sharedTab = null;

function isConnected() { return ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING); }
function isScriptable(t) { return t && /^https?:/.test(t.url); }

function waitTabLoad(id) {
  return new Promise(r => {
    chrome.tabs.onUpdated.addListener(function l(t, i) { if (t === id && i.status === 'complete') { chrome.tabs.onUpdated.removeListener(l); r(); } });
  });
}

// chrome.debugger 同一时刻只能 attach 一个 tab。并发命令切换 tab 时，
// detach 旧 tab 和 attach 新 tab 之间隔了 await，多个请求同时进来会互相踩踏
// （attachedTab 赋值互相覆盖，后续 sendCommand 挂在未 attach 的 tab 上导致命令永不返回）。
// 用 promise 链把所有 detach/attach 串行化，彻底消除这个竞态。
let attachChain = Promise.resolve();
function withAttachLock(fn) {
  const p = attachChain.then(fn, fn);
  attachChain = p.catch(() => {});
  return p;
}

async function ensureAttached(tabId) {
  return withAttachLock(async () => {
    if (attachedTab === tabId) return;
    if (attachedTab !== null) {
      try { await chrome.debugger.detach({ tabId: attachedTab }); } catch (_) {}
      attachedTab = null;
    }
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTab = tabId;
  });
}

function detachDebugger() {
  if (attachedTab !== null) { chrome.debugger.detach({ tabId: attachedTab }, () => {}); attachedTab = null; }
  if (sharedTab !== null) { chrome.tabs.remove(sharedTab, () => {}); sharedTab = null; }
}

async function ensureTab(url) {
  if (sharedTab) {
    try {
      await chrome.tabs.get(sharedTab);
      if (url) {
        await ensureAttached(sharedTab);
        await chrome.debugger.sendCommand({ tabId: sharedTab }, 'Page.navigate', { url });
        await waitTabLoad(sharedTab);
      }
      return sharedTab;
    } catch (_) { sharedTab = null; }
  }
  const tab = await chrome.tabs.create({ url: url || 'about:blank', active: false });
  sharedTab = tab.id;
  await waitTabLoad(sharedTab);
  return sharedTab;
}

async function cdpCmd(method, params, tabId, url) {
  if (!tabId) tabId = await ensureTab(url);
  if (!tabId) return { ok: false, error: 'no tabId' };
  try {
    await ensureAttached(tabId);
    return { ok: true, data: await chrome.debugger.sendCommand({ tabId }, method, params || {}) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleExec(code, tabId, url) {
  const newTabs = [];
  const onCreated = (tab) => { newTabs.push(tab); };
  chrome.tabs.onCreated.addListener(onCreated);
  const expression = '(function(){ return ' + code + ' })()';
  const r = await cdpCmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, tabId, url);
  chrome.tabs.onCreated.removeListener(onCreated);
  if (!r.ok) return r;
  if (r.data.exceptionDetails) return { ok: false, error: r.data.exceptionDetails.exception?.description || 'Runtime.evaluate error' };
  const result = { ok: true, data: r.data.result.value };
  if (newTabs.length > 0) {
    await new Promise(r => setTimeout(r, 500));
    result.newTabs = await Promise.all(newTabs.map(t =>
      chrome.tabs.get(t.id).then(tab => ({ id: tab.id, url: tab.url, title: tab.title })).catch(() => null)
    ).filter(Boolean));
  }
  return result;
}

function handleTabs() {
  return chrome.tabs.query({}).then(tabs => ({ ok: true, data: tabs.filter(t => /^https?:/.test(t.url)).map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId })) }))
    .catch(e => ({ ok: false, error: e.message }));
}

// attach 前清理可能的残留 attach。
// 命令超时被 kill 的是 cdp-server 子进程，扩展端进程不受影响：
// 若超时恰发生在 attach 与 detach 之间，该 target 的 attach 会残留，
// 下次 attach 同一 target 会报 "Another debugger is already attached"。
async function attachTarget(targetId) {
  try {
    await chrome.debugger.attach({ targetId }, '1.3');
  } catch (e) {
    if (/already attached/i.test(e.message)) {
      try { await chrome.debugger.detach({ targetId }); } catch (_) {}
      await chrome.debugger.attach({ targetId }, '1.3');
    } else {
      throw e;
    }
  }
}

// 在指定 targetId 上执行 JS（attach → evaluate → detach），支持并发
async function execOnTarget(targetId, code) {
  const expression = '(function(){ return ' + code + ' })()';
  try {
    await attachTarget(targetId);
    const r = await chrome.debugger.sendCommand({ targetId }, 'Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true
    });
    await chrome.debugger.detach({ targetId });
    if (r.exceptionDetails) return { ok: false, error: r.exceptionDetails.exception?.description || 'Runtime.evaluate error' };
    return { ok: true, data: r.result.value };
  } catch (e) { return { ok: false, error: e.message }; }
}

// 在指定 targetId 上执行 CDP 命令（attach → 命令 → detach），支持并发
async function cdpOnTarget(targetId, method, params) {
  try {
    await attachTarget(targetId);
    const r = await chrome.debugger.sendCommand({ targetId }, method, params || {});
    await chrome.debugger.detach({ targetId });
    return { ok: true, data: r };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function handleBatch(batch, tabId) {
  // 并行执行所有命令（每个命令可指定独立 targetId，互不干扰）
  const results = await Promise.all(batch.commands.map(async (cmd) => {
    const tid = cmd.targetId || cmd.tabId || tabId;
    if (cmd.cmd === 'cdp') {
      const params = JSON.parse(JSON.stringify(cmd.params || {}).replace(/"\$(\d+)\.([^"]+)"/g, (_, i, path) => {
        let v = results[+i]; for (const k of path.split('.')) v = v?.[k]; return JSON.stringify(v);
      }));
      if (tid && typeof tid === 'string' && tid.startsWith('target')) return cdpOnTarget(tid, cmd.method, params);
      return cdpCmd(cmd.method, params, tid);
    } else if (cmd.cmd === 'exec') {
      if (tid && typeof tid === 'string' && tid.startsWith('target')) return execOnTarget(tid, cmd.code || cmd.js);
      return handleExec(cmd.code || cmd.js, tid);
    } else {
      return { ok: false, error: 'unknown cmd: ' + cmd.cmd };
    }
  }));
  return { ok: true, results };
}

async function handleMessage(data) {
  const c = data.code;
  if (c && typeof c === 'object') {
    if (c.cmd === 'exec') {
      if (c.targetId) return execOnTarget(c.targetId, c.code || c.js);
      return handleExec(c.code || c.js, c.tabId, c.url);
    }
    if (c.cmd === 'cdp') {
      if (c.targetId) return cdpOnTarget(c.targetId, c.method, c.params);
      return cdpCmd(c.method, c.params, c.tabId, c.url);
    }
    if (c.cmd === 'tabs') return handleTabs();
    if (c.cmd === 'batch') return handleBatch(c, c.tabId);
    if (c.cmd === 'ext') return handleExt(c);
    if (c.method) return cdpCmd(c.method, c.params, c.tabId);
    return { ok: false, error: 'unknown cmd: ' + c.cmd };
  }
  if (typeof c === 'string') return handleExec(c, data.tabId);
  return { ok: false, error: 'invalid format' };
}

// ---- 扩展上下文命令（可调用 chrome.debugger / chrome.tabs 等扩展 API）----

async function handleExt(c) {
  const action = c.action;

  // 获取所有 debugger targets（含 OOPIF）
  if (action === 'getTargets') {
    try { return { ok: true, data: await chrome.debugger.getTargets() }; }
    catch (e) { return { ok: false, error: e.message }; }
  }

  // 新建标签页并返回 targetId。用 chrome.tabs.create + getTargets 匹配，
  // 完全不碰 sharedTab/attachedTab 共享单例，支持多客户端并发 new-tab。
  if (action === 'newTab') {
    try {
      const url = c.url || 'about:blank';
      const tab = await chrome.tabs.create({ url, active: false });
      // 等待加载完成，带 3s 兜底（监听器可能错过 already-complete 的 tab）
      await Promise.race([waitTabLoad(tab.id), new Promise(r => setTimeout(r, 3000))]);
      // 轮询等 target 出现在 getTargets 里（tab 刚创建时可能尚未注册）
      let tid = null;
      for (let i = 0; i < 10 && !tid; i++) {
        const targets = await chrome.debugger.getTargets();
        const t = targets.find(x => x.type === 'page' && x.tabId === tab.id);
        if (t) tid = t.id; else await new Promise(r => setTimeout(r, 100));
      }
      return { ok: true, data: { tabId: tab.id, targetId: tid } };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // 按 targetId 或 tabId 精确关闭标签页（不再删"当前活动 tab"，避免并发下关错）
  if (action === 'closeTab') {
    try {
      let tabId = c.tabId;
      if (tabId == null && c.targetId) {
        const targets = await chrome.debugger.getTargets();
        const t = targets.find(x => x.id === c.targetId);
        if (t) tabId = t.tabId;
      }
      if (tabId != null) await chrome.tabs.remove(tabId);
      return { ok: true, data: 'closed' };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // 在指定 targetId 上执行 JS（attach → evaluate → detach）
  if (action === 'evalOnTarget') {
    const targetId = c.targetId;
    const expression = c.expression;
    try {
      await attachTarget(targetId);
      const r = await chrome.debugger.sendCommand({ targetId }, 'Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true
      });
      await chrome.debugger.detach({ targetId });
      if (r.exceptionDetails) return { ok: false, error: r.exceptionDetails.exception?.description || 'evaluate error' };
      return { ok: true, data: r.result.value };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // 在指定 targetId 上执行 CDP 命令
  if (action === 'cdpOnTarget') {
    const targetId = c.targetId;
    const method = c.method;
    const params = c.params || {};
    try {
      await attachTarget(targetId);
      const r = await chrome.debugger.sendCommand({ targetId }, method, params);
      await chrome.debugger.detach({ targetId });
      return { ok: true, data: r };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  return { ok: false, error: 'unknown ext action: ' + action };
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
}

function probeAndConnect() {
  if (isConnected()) return;
  fetch('http://127.0.0.1:18765', { method: 'HEAD', signal: AbortSignal.timeout(2000) })
    .then(() => {
      try { ws = new WebSocket(WS_URL); } catch (e) { ws = null; chrome.alarms.create('cdp-probe', { delayInMinutes: PROBE_MS / 60000 }); return; }
      ws.onopen = async () => {
        updateBadge();
        chrome.alarms.create('cdp-keepalive', { delayInMinutes: KEEPALIVE_MIN });
        const tabs = await chrome.tabs.query({});
        wsSend(JSON.stringify({ type: 'ext_ready', tabs: tabs.filter(isScriptable).map(t => ({ id: t.id, url: t.url, title: t.title })) }));
      };
      ws.onmessage = async (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d.type === 'ping') { wsSend(JSON.stringify({ type: 'pong' })); return; }
          if (d.id !== undefined && d.code !== undefined) {
            const r = await handleMessage(d);
            wsSend(JSON.stringify({ type: r.ok ? 'result' : 'error', id: d.id, result: r, error: r.error }));
          }
        } catch (_) {}
      };
      ws.onclose = () => { updateBadge(); ws = null; detachDebugger(); chrome.alarms.create('cdp-probe', { delayInMinutes: PROBE_MS / 60000 }); };
    })
    .catch(() => chrome.alarms.create('cdp-probe', { delayInMinutes: PROBE_MS / 60000 }));
}

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'cdp-keepalive' && isConnected()) {
    wsSend(JSON.stringify({ type: 'ping' }));
    chrome.alarms.create('cdp-keepalive', { delayInMinutes: KEEPALIVE_MIN });
  }
  if (a.name === 'cdp-probe' && (!isConnected())) probeAndConnect();
});

function updateBadge() {
  const on = isConnected();
  // 同步更新，立即生效，确保图标与状态一致
  chrome.action.setBadgeText({ text: on ? 'ON' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: on ? '#45e94d' : '#ff2e2e' });
}

async function sendTabsUpdate() {
  if (!isConnected()) return;
  const tabs = (await chrome.tabs.query({})).filter(t => isScriptable(t.url));
  wsSend(JSON.stringify({ type: 'tabs_update', tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title })) }));
}
chrome.tabs.onUpdated.addListener((_, changeInfo) => { if (changeInfo.status === 'complete') sendTabsUpdate(); });
chrome.tabs.onRemoved.addListener(() => sendTabsUpdate());
chrome.tabs.onCreated.addListener(() => sendTabsUpdate());

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup') {
    port.onMessage.addListener((msg) => {
      if (msg.type === 'getState') {
        port.postMessage({ connected: isConnected() });
      }
    });
  }
});

updateBadge();
probeAndConnect();
chrome.runtime.onStartup.addListener(probeAndConnect);
chrome.runtime.onInstalled.addListener(probeAndConnect);
