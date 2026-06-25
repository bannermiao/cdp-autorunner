let port;

function updateUI() {
  try {
    port = chrome.runtime.connect({ name: 'popup' });
    port.postMessage({ type: 'getState' });
    port.onMessage.addListener((res) => {
      const connected = res && res.connected;
      const dot = document.getElementById('statusDot');
      const text = document.getElementById('statusText');
      const badge = document.getElementById('statusBadge');
      if (dot) dot.className = 'dot ' + (connected ? 'on' : 'off');
      if (text) { text.textContent = connected ? '已连接' : '未连接'; text.className = 'status-text ' + (connected ? 'connected' : 'disconnected'); }
      if (badge) { badge.textContent = connected ? 'ONLINE' : 'OFFLINE'; badge.className = 'status-badge ' + (connected ? 'on' : 'off'); }
    });
  } catch (_) {}
}

document.addEventListener('DOMContentLoaded', updateUI);
