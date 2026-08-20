#!/usr/bin/env node
/**
 * ebay-research-worker.js — Worker 进程，负责处理一批商品 URL 的详情+销售数据抓取
 * 由 ebay-research.js 通过 child_process.fork() 启动
 * 
 * 通信协议 (IPC):
 *   收到: { urls: [...], workerId: N }
 *   发送: { type: 'progress', workerId, index, total }
 *   发送: { type: 'result', workerId, data }
 *   发送: { type: 'done', workerId, count }
 *   收到: { type: 'exit' }
 */

const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- 定位 cdp-server ----
// 从 skill scripts/ 目录加载二进制，找不到则回退到 PATH
const CDP_BIN = (() => {
  const name = process.platform === 'win32' ? 'cdp-server.exe' : 'cdp-server';
  const full = path.join(__dirname, '..', name);
  if (fs.existsSync(full)) return full;
  return name;
})();

function cdp(...args) {
  const result = spawnSync(CDP_BIN, ['browser', ...args], {
    encoding: 'utf-8', timeout: 60000, windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `exit code ${result.status}`);
  return result.stdout ? result.stdout.trim() : '';
}

// 每个 Worker 专属的 targetId（由 new-tab 创建，后续所有操作都指向它，实现真正并发）
let targetId = null;

function goto(url) {
  if (targetId) return cdp('goto-target', targetId, url);
  return cdp('goto', url);
}

function waitfor(sel, timeout) {
  if (targetId) return cdp('waitfor-target', targetId, sel, timeout);
  return cdp('waitfor', sel, timeout);
}

function evalJS(code) {
  const oneLine = code
    .replace(/\/\/.*$/gm, '')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (targetId) {
    try {
      const tmpFile = path.join(os.tmpdir(), `cdp-eval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.js`);
      fs.writeFileSync(tmpFile, code, 'utf-8');
      const r = cdp('eval-target', targetId, tmpFile);
      if (r && r !== '(empty)') return r;
    } catch (_) {}
    return cdp('eval-target', targetId, oneLine);
  }
  try {
    const tmpFile = path.join(os.tmpdir(), `cdp-eval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.js`);
    fs.writeFileSync(tmpFile, code, 'utf-8');
    const r = cdp('exec', tmpFile);
    if (r && r !== '(empty)') return r;
  } catch (_) {}
  return cdp('eval', oneLine);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function send(msg) {
  if (process.send) process.send(msg);
}

// ---- 辅助函数 ----
const parsePrice = (priceStr) => {
  let c = priceStr.replace(/[^\d,.]/g, '');
  if (c.includes(',') && c.includes('.') && c.indexOf(',') > c.indexOf('.'))
    c = c.replace(/\./g, '').replace(',', '.');
  else if (c.includes(','))
    c = c.replace(',', '.');
  c = c.replace(/[^\d.]/g, '');
  return c ? parseFloat(c) : 0;
};

const parseDate = (dateStr) => {
  try {
    const t = dateStr.trim();
    const en = t.match(/^(\d{1,2})\s+(\w{3})\s+(\d{4})\s+at\s+/);
    if (en) return new Date(`${en[2]} ${en[1]}, ${en[3]}`).toISOString().slice(0, 10);
    return null;
  } catch { return null; }
};

const calc90dStats = (rows) => {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const inRange = rows.filter(r => r.date && r.date >= cutoffStr);
  const soldTotal = inRange.reduce((s, r) => s + r.qty, 0);
  const filtered = inRange.filter(r => r.price > 0);
  if (filtered.length === 0) return { sold_90days: soldTotal, avg_price_90days: 0, min_price_90days: 0, max_price_90days: 0 };
  const prices = filtered.map(r => r.price);
  return {
    sold_90days: soldTotal,
    avg_price_90days: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length * 100) / 100,
    min_price_90days: Math.min(...prices),
    max_price_90days: Math.max(...prices),
  };
};

// ---- 详情提取 JS（与主脚本一致） ----
const DETAIL_EXTRACT_JS = `
(function(){
  var scripts = document.querySelectorAll('script');
  var jsonRaw = null;
  var pattern = /\\$M_96613636_C=\\(window\\.\\$M_96613636_C\\|\\|\\[\\]\\)\\.concat\\((.*)\\)/;
  for (var i = 0; i < scripts.length; i++) {
    var m = pattern.exec(scripts[i].textContent);
    if (m) { jsonRaw = m[1]; break; }
  }
  if (!jsonRaw) throw new Error('无法解析商品JSON信息');

  var modules = {};
  try {
    var parsed = JSON.parse(jsonRaw);
    for (var j = 0; j < parsed.o.w.length; j++) {
      var mod = parsed.o.w[j];
      if (mod.length > 2 && 'model' in mod[2]) { modules = mod[2].model.modules; break; }
    }
  } catch (e) { throw new Error('解析商品脚本出错: ' + e.message); }

  var info = {
    item_id: null, title: null, sale_price: null, currency: null,
    image: null, sold: 0, compatible_vehicles: 0, specifics_item: null,
    seller_name: null, store_name: null, positive_rate: null
  };

  if (modules.JSONLD && modules.JSONLD.product) {
    var p = modules.JSONLD.product;
    if (p.name) info.title = p.name;
    if (p.image) {
      if (Array.isArray(p.image) && p.image.length > 0) {
        var f = p.image[0];
        info.image = typeof f === 'string' ? f : (f.url || null);
      } else if (p.image.url) info.image = p.image.url;
    }
    if (p.offers) {
      if (p.offers.price) info.sale_price = p.offers.price;
      if (p.offers.priceCurrency) info.currency = p.offers.priceCurrency;
    }
  }

  var pv = modules.BUY_BOX && modules.BUY_BOX.binModel && modules.BUY_BOX.binModel.price && modules.BUY_BOX.binModel.price.value;
  if (pv) {
    if (pv.convertedFromValue != null) { info.sale_price = pv.convertedFromValue; info.currency = pv.convertedFromCurrency; }
    else if (pv.value != null) { info.sale_price = pv.value; info.currency = pv.currency; }
  }

  var qty = document.querySelectorAll('#qtyAvailability span');
  if (qty.length > 0) {
    var sm = qty[qty.length - 1].textContent.trim().match(/([\\d,]+)\\s*sold/i);
    if (sm) info.sold = parseInt(sm[1].replace(/,/g, ''), 10) || 0;
  }

  var s0 = modules.SELLER_CARD_ATF && modules.SELLER_CARD_ATF.sections && modules.SELLER_CARD_ATF.sections[0];
  if (s0) {
    if (s0.profileLogo) {
      info.seller_name = s0.profileLogo.title || null;
      info.store_name = (s0.profileLogo.action && s0.profileLogo.action.params && s0.profileLogo.action.params.store_name) || null;
    }
    if (s0.dataItems && s0.dataItems.length > 0) {
      var rm = (s0.dataItems[0].textSpans && s0.dataItems[0].textSpans[0] && s0.dataItems[0].textSpans[0].text || '').match(/([\\d.]+)%/);
      if (rm) info.positive_rate = parseFloat(rm[1]);
    }
  }

  var ct = modules.COMPATIBILITY_TABLE && modules.COMPATIBILITY_TABLE.paginatedTable;
  if (ct && ct.title && ct.title.textSpans && ct.title.textSpans.length > 0) {
    var nm = ct.title.textSpans[0].text.match(/(\\d+)/);
    if (nm) info.compatible_vehicles = parseInt(nm[1].replace(/[,.]/g, ''), 10) || 0;
  }

  var ft = modules.ABOUT_THIS_ITEM && modules.ABOUT_THIS_ITEM.sections && modules.ABOUT_THIS_ITEM.sections.features && modules.ABOUT_THIS_ITEM.sections.features.dataItems;
  if (ft) {
    var text = '';
    var keys = Object.keys(ft);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var val = ft[key];
      var v0 = val.values && val.values[0];
      if (!v0) continue;
      var t = v0._type === 'ExpandableTextualDisplayBlock'
        ? (v0.textualDisplays && v0.textualDisplays[0] && v0.textualDisplays[0].textSpans && v0.textualDisplays[0].textSpans[0] && v0.textualDisplays[0].textSpans[0].text)
        : (v0.textSpans && v0.textSpans[0] && v0.textSpans[0].text);
      if (t) text += key + ': ' + t + '\\n';
    }
    info.specifics_item = text || null;
  }

  return JSON.stringify(info);
})()
`;

const PURCHASE_HISTORY_EXTRACT_JS = `
(function(){
  var table = document.querySelector('table');
  if (!table) return JSON.stringify([]);
  var results = [];
  var rows = table.querySelectorAll('tr');
  for (var i = 0; i < rows.length; i++) {
    var tds = rows[i].querySelectorAll('td');
    if (tds.length < 4) continue;
    var qty = parseInt(tds[2].textContent.trim(), 10);
    if (!isNaN(qty) && qty > 0) {
      results.push({
        priceStr: tds[1].textContent.trim(),
        qty: qty,
        dateStr: tds[3].textContent.trim()
      });
    }
  }
  return JSON.stringify(results);
})()
`;

// ---- 抓取函数 ----
async function fetchDetail(url) {
  const MAX_RETRY = 3;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      goto(url);
      try {
        waitfor('.x-buybox-cta li', '10000');
      } catch (_) {
        waitfor('h1', '6000');
      }
      await sleep(1500);

      const bodyText = cdp('eval', "(function(){return document.body.innerText.substring(0,200);})()");
      if (/Pardon Our Interruption/i.test(bodyText)) {
        await sleep(2000 * (attempt + 1));
        continue;
      }

      const raw = evalJS(DETAIL_EXTRACT_JS);
      if (raw && raw.startsWith('{')) {
        const d = JSON.parse(raw);
        if (d.title) {
          d.url = url;
          const idMatch = url.match(/\/itm\/(\d+)/);
          if (idMatch) d.item_id = idMatch[1];
          return d;
        }
      }
      if (attempt < MAX_RETRY - 1) await sleep(1500 * (attempt + 1));
    } catch (e) {
      // retry
    }
    await sleep(1500 * (attempt + 1));
  }
  const idMatch = url.match(/\/itm\/(\d+)/);
  return {
    item_id: idMatch ? idMatch[1] : null, url, title: null, sale_price: null, currency: null,
    image: null, sold: 0, compatible_vehicles: 0, specifics_item: null,
    seller_name: null, store_name: null, positive_rate: null,
    sold_90days: 0, avg_price_90days: 0, min_price_90days: 0, max_price_90days: 0,
  };
}

async function fetchSalesHistory(itemId) {
  try {
    goto(`https://www.ebay.com/bin/purchaseHistory?item=${itemId}`);
    waitfor('table', '8000');
    await sleep(1000);
    const raw = evalJS(PURCHASE_HISTORY_EXTRACT_JS);
    if (!raw || raw === '(empty)') return { sold_90days: 0, avg_price_90days: 0, min_price_90days: 0, max_price_90days: 0 };
    const rows = JSON.parse(raw);
    if (rows.length === 0) return { sold_90days: 0, avg_price_90days: 0, min_price_90days: 0, max_price_90days: 0 };
    const parsed = rows.map(r => ({ price: parsePrice(r.priceStr), qty: r.qty, date: parseDate(r.dateStr) }))
      .filter(r => r.date !== null);
    return calc90dStats(parsed);
  } catch (e) {
    return { sold_90days: 0, avg_price_90days: 0, min_price_90days: 0, max_price_90days: 0 };
  }
}

// ---- 主逻辑 ----
async function processUrls(urls, workerId) {
  // 每个 Worker 创建自己的专属标签页，保存 targetId 供后续所有操作复用（真正并发）
  try {
    const out = cdp('new-tab', 'about:blank');
    const m = out.match(/NEW-TAB:\s*(\S+)/);
    if (m && m[1]) targetId = m[1];
  } catch (_) {
    // 忽略新标签页失败，回退到共享 tab
  }

  const results = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const itemId = url.match(/\/itm\/(\d+)/)?.[1] || '';

    const detail = await fetchDetail(url);

    if (itemId && detail.title) {
      const sales = await fetchSalesHistory(itemId);
      Object.assign(detail, sales);
    } else {
      detail.sold_90days = 0;
      detail.avg_price_90days = 0;
      detail.min_price_90days = 0;
      detail.max_price_90days = 0;
    }

    results.push(detail);
    send({ type: 'progress', workerId, index: i + 1, total: urls.length });
  }

  send({ type: 'result', workerId, data: results });
  send({ type: 'done', workerId, count: results.length });
}

// ---- 入口 ----
process.on('message', async (msg) => {
  if (msg.type === 'work') {
    try {
      await processUrls(msg.urls, msg.workerId);
    } catch (e) {
      send({ type: 'error', workerId: msg.workerId, error: e.message });
    }
  } else if (msg.type === 'exit') {
    process.exit(0);
  }
});

// 通知主进程 Worker 已就绪
send({ type: 'ready', workerId: process.env.WORKER_ID || 0 });
