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

async function ensureAttached(tabId) {
  if (attachedTab === tabId) return;
  if (attachedTab !== null) {
    try { await chrome.debugger.detach({ tabId: attachedTab }); } catch (_) {}
    attachedTab = null;
  }
  await chrome.debugger.attach({ tabId }, '1.3');
  attachedTab = tabId;
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

async function handleBatch(batch, tabId) {
  const results = [];
  for (const cmd of batch.commands) {
    const tid = cmd.tabId || tabId;
    let res;
    if (cmd.cmd === 'cdp') {
      const params = JSON.parse(JSON.stringify(cmd.params || {}).replace(/"\$(\d+)\.([^"]+)"/g, (_, i, path) => {
        let v = results[+i]; for (const k of path.split('.')) v = v?.[k]; return JSON.stringify(v);
      }));
      res = await cdpCmd(cmd.method, params, tid);
    } else if (cmd.cmd === 'exec') {
      res = await handleExec(cmd.code || cmd.js, tid);
    } else {
      res = { ok: false, error: 'unknown cmd: ' + cmd.cmd };
    }
    results.push(res);
  }
  return { ok: true, results };
}

async function handleMessage(data) {
  const c = data.code;
  if (c && typeof c === 'object') {
    if (c.cmd === 'exec') return handleExec(c.code || c.js, c.tabId, c.url);
    if (c.cmd === 'cdp') return cdpCmd(c.method, c.params, c.tabId, c.url);
    if (c.cmd === 'tabs') return handleTabs();
    if (c.cmd === 'batch') return handleBatch(c, c.tabId);
    if (c.method) return cdpCmd(c.method, c.params, c.tabId);
    return { ok: false, error: 'unknown cmd: ' + c.cmd };
  }
  if (typeof c === 'string') return handleExec(c, data.tabId);
  return { ok: false, error: 'invalid format' };
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
