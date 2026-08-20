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

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- 定位 cdp-server ----
const SKILL_BIN = path.join(
  os.homedir(), '.codebuddy', 'skills', 'cdp-autorunner-skill', 'scripts', 'cdp-server'
);
const CDP_BIN = (() => {
  const name = process.platform === 'win32' ? 'cdp-server.exe' : 'cdp-server';
  const candidates = [
    path.join(__dirname, name),
    SKILL_BIN + (process.platform === 'win32' ? '.exe' : ''),
    name,
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return name;
})();

// 按命令类型给不同超时：goto-target 页面加载+标题轮询给 30s，
// waitfor-target 按传入超时+5s 余量（正常 TIMEOUT 要能返回），其余 20s。
// 任何命令超时都 kill 子进程并抛错，绝不无限阻塞（原 spawnSync 60s 死等是卡死根源）。
function cdpTimeout(args) {
  const cmd = args[0];
  if (cmd === 'goto' || cmd === 'goto-target') return 30000;
  if (cmd === 'waitfor' || cmd === 'waitfor-target') {
    const t = parseInt(args[args.length - 1], 10);
    return (isNaN(t) ? 8000 : t) + 5000;
  }
  if (cmd === 'new-tab' || cmd === 'close-tab' || cmd === 'switch-tab') return 15000;
  return 20000;
}

function cdp(...args) {
  const timeoutMs = cdpTimeout(args);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(CDP_BIN, ['browser', ...args], { windowsHide: true });
    let stdout = '', stderr = '';
    let settled = false;
    const finish = (fn, val) => { if (!settled) { settled = true; fn(val); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      if (process.platform === 'win32') {
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) {}
      }
      finish(reject, new Error(`cdp ${args[0]} 超时(${timeoutMs}ms)`));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); finish(reject, e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (ms > 5000) console.log(`[Worker ${process.env.WORKER_ID || 0}] [cdp:slow] ${args[0]} ${ms}ms`);
      if (code !== 0) finish(reject, new Error(stderr.trim() || `cdp ${args[0]} exit ${code}`));
      else finish(resolve, stdout.trim());
    });
  });
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

async function evalJS(code) {
  // 有专属 target 时：eval-target 的 code 参数支持多行 JS，直接传源码执行
  if (targetId) return cdp('eval-target', targetId, code);
  const oneLine = code
    .replace(/\/\/.*$/gm, '')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  try {
    const tmpFile = path.join(os.tmpdir(), `cdp-eval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.js`);
    fs.writeFileSync(tmpFile, code, 'utf-8');
    const r = await cdp('exec', tmpFile);
    if (r && r !== '(empty)') return r;
  } catch (_) {}
  return cdp('eval', oneLine);
}

// 超时/异常后重置 target：先关掉可能残留 attach 的旧 tab，再建新 tab。
// 防止扩展端 chrome.debugger.attach 单例被某个挂死命令占用后，后续命令全部排队卡死。
async function resetTarget() {
  if (targetId) {
    try { await cdp('close-tab', targetId); } catch (_) {}
    targetId = null;
  }
  try {
    const out = await cdp('new-tab', 'about:blank');
    const m = out.match(/NEW-TAB:\s*(\S+)/);
    if (m && m[1]) targetId = m[1];
  } catch (_) {}
}

// 初始化专属 target：new-tab 后立即用 eval-target 执行简单 JS 做"预热验证"，
// 确认 attach 链路真正可用。两个 worker 同时 new-tab 会撞扩展端 attach 单例，
// 导致首个 target 后续命令挂起（表现为"详情页开了但程序不动"）。
// 这里失败立即关掉重建，最多 3 次，把冲突解决在初始化阶段而非第一个商品。
async function initTarget(workerId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = await cdp('new-tab', 'about:blank');
      const m = out.match(/NEW-TAB:\s*(\S+)/);
      if (!m || !m[1]) throw new Error('new-tab 未返回 targetId');
      targetId = m[1];
      // 预热验证：执行简单 JS，确认 target 可正常 attach/操作
      const r = await cdp('eval-target', targetId, '1+1');
      if (r && r.includes('2')) {
        console.log(`[Worker ${workerId}] target 就绪: ${targetId}`);
        return true;
      }
      throw new Error(`预热验证失败: ${r}`);
    } catch (e) {
      console.log(`[Worker ${workerId}] target 初始化异常(${e.message})，第 ${attempt + 1} 次重建`);
      if (targetId) {
        try { await cdp('close-tab', targetId); } catch (_) {}
        targetId = null;
      }
      await sleep(1500 * (attempt + 1));
    }
  }
  console.log(`[Worker ${workerId}] target 初始化失败，回退共享 tab`);
  return false;
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
  var info = {
    item_id: null, title: null, sale_price: null, currency: null,
    image: null, sold: 0, compatible_vehicles: 0, specifics_item: null,
    seller_name: null, store_name: null, positive_rate: null
  };

  // ---- 新版页面 fallback：页面无 $M_96613636_C 数据时，改用 JSON-LD + DOM ----
  if (!jsonRaw) {
    var lds = document.querySelectorAll('script[type="application/ld+json"]');
    for (var li = 0; li < lds.length; li++) {
      try {
        var p = JSON.parse(lds[li].textContent);
        if (p && p['@type'] === 'Product') {
          if (p.name) info.title = p.name;
          if (p.image) {
            if (Array.isArray(p.image) && p.image.length > 0) {
              var f2 = p.image[0];
              info.image = typeof f2 === 'string' ? f2 : (f2.url || null);
            } else if (typeof p.image === 'string') info.image = p.image;
            else if (p.image.url) info.image = p.image.url;
          }
          if (p.offers) {
            if (p.offers.price != null) info.sale_price = parseFloat(p.offers.price);
            if (p.offers.priceCurrency) info.currency = p.offers.priceCurrency;
          }
          break;
        }
      } catch (e) {}
    }
    var sellerEl = document.querySelector('.x-sellercard-atf__about-seller');
    if (sellerEl) {
      var st = sellerEl.textContent.trim().replace(/\\s*\\([\\d,.]+\\)\\s*$/, '').trim();
      if (st) info.seller_name = st;
    }
    var cardEl = document.querySelector('.x-sellercard-atf');
    if (cardEl) {
      var rm2 = cardEl.textContent.match(/(\\d+(?:\\.\\d+)?)%\\s*positive/i);
      if (rm2) info.positive_rate = parseFloat(rm2[1]);
    }
    var qty2 = document.querySelectorAll('#qtyAvailability span');
    if (qty2.length > 0) {
      var sm2 = qty2[qty2.length - 1].textContent.trim().match(/([\\d,]+)\\s*sold/i);
      if (sm2) info.sold = parseInt(sm2[1].replace(/,/g, ''), 10) || 0;
    }
    return JSON.stringify(info);
  }

  var modules = {};
  try {
    var parsed = JSON.parse(jsonRaw);
    for (var j = 0; j < parsed.o.w.length; j++) {
      var mod = parsed.o.w[j];
      if (mod.length > 2 && 'model' in mod[2]) { modules = mod[2].model.modules; break; }
    }
  } catch (e) { throw new Error('解析商品脚本出错: ' + e.message); }

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
      // 1) 导航。不做反爬预判：waitfor 本身就是检测，能等到正确元素说明页面加载正常
      let t0 = Date.now();
      await goto(url);
      const gotoMs = Date.now() - t0;

      // 2) 等待 buybox。注意：waitfor 超时输出 TIMEOUT 且 exit 0（不抛错），
      //    必须按返回值判断。TIMEOUT 说明被反爬或页面异常，最多等 10s 就按失败处理
      t0 = Date.now();
      const w1 = await waitfor('.x-buybox-cta li', '10000');
      const w1ms = Date.now() - t0;
      const pageOk = w1.startsWith('FOUND') || (await waitfor('h1', '6000')).startsWith('FOUND');
      console.log(`[Worker ${process.env.WORKER_ID || 0}] goto ${gotoMs}ms / waitfor ${w1ms}ms(${w1.slice(0, 12)}) / pageOk=${pageOk}: ${url}`);
      await sleep(1500);

      if (pageOk) {
        t0 = Date.now();
        const raw = await evalJS(DETAIL_EXTRACT_JS);
        console.log(`[Worker ${process.env.WORKER_ID || 0}] eval ${Date.now() - t0}ms`);
        if (raw && raw.startsWith('{')) {
          const d = JSON.parse(raw);
          if (d.title) {
            d.url = url;
            const idMatch = url.match(/\/itm\/(\d+)/);
            if (idMatch) d.item_id = idMatch[1];
            return d;
          }
        }
      } else {
        console.log(`[Worker ${process.env.WORKER_ID || 0}] 页面异常(疑似反爬)：${url}`);
      }
      if (attempt < MAX_RETRY - 1) await sleep(1500 * (attempt + 1));
    } catch (e) {
      // 命令超时/异常：重置 target 清除扩展端残留状态，再重试
      console.log(`[Worker ${process.env.WORKER_ID || 0}] 抓取异常(${e.message})，重置标签页后重试：${url}`);
      await resetTarget();
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
    await goto(`https://www.ebay.com/bin/purchaseHistory?item=${itemId}`);
    await waitfor('table', '8000');
    await sleep(1000);
    const raw = await evalJS(PURCHASE_HISTORY_EXTRACT_JS);
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
  // 错开多 worker 的初始化时机：worker 0 立即建 tab，worker 1 延迟 800ms，
  // 避免同时 new-tab 撞扩展端 attach 单例
  if (workerId > 0) await sleep(workerId * 800);
  // 创建专属标签页并预热验证，失败则自动重建（最多 3 次）
  await initTarget(workerId);
  // 注意：若 initTarget 返回 false，targetId 为 null，
  // goto/waitfor/evalJS 会自动回退到共享 tab（非 target 版本）

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
