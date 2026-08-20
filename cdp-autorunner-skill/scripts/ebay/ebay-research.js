#!/usr/bin/env node
/**
 * ebay-research.js (v3) — eBay 商品调研：列表链接 → 详情+90天销量 → JSON/报表
 *
 * 两阶段流程：
 *   1) 列表页仅提取商品链接（不提取标题/价格等，详情页会获取）
 *   2) 逐个进入详情页，从内嵌JSON脚本解析商品信息 + 访问 purchaseHistory 获取90天销售数据
 *   3) 输出 JSON 数据 + 可选可视化 HTML 报表
 *
 * 详情抓取逻辑参考 ebay-batch-detail.js
 *
 * 用法:
 *   node ebay-research.js <关键词> [输出文件] [--report] [--no-detail] [--limit N] [--concurrency N]
 *   node ebay-research.js <输入JSON> [输出HTML]           仅生成报表
 *
 * 示例:
 *   node ebay-research.js headlight --report
 *   node ebay-research.js headlight items.json
 *   node ebay-research.js headlight --limit 20 --report
 *   node ebay-research.js data.json
 *
 * 纯 Node 标准库 + cdp-server (CDP-autorunner-skill)，零 npm 依赖。
 */

const { spawn, fork } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- 定位 cdp-server ----
// 优先用同目录下的 cdp-server，其次用 skill 自带二进制，最后回退到 PATH
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

// 按命令类型给不同超时：goto 页面加载+标题轮询给 30s，
// waitfor 按传入超时+5s 余量（正常 TIMEOUT 要能返回），其余 20s。
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
      if (ms > 5000) console.log(`[cdp:slow] ${args[0]} ${ms}ms`);
      if (code !== 0) finish(reject, new Error(stderr.trim() || `cdp ${args[0]} exit ${code}`));
      else finish(resolve, stdout.trim());
    });
  });
}

// 执行页面 JS。cdp exec 对多行文件不稳定，统一压成单行（去注释/换行）后用 eval，
// 但保留临时文件 exec 作为首选（部分复杂 IIFE 需文件上下文）。
async function evalJS(code) {
  const oneLine = code
    .replace(/\/\/.*$/gm, '')   // 去行内注释
    .replace(/\n/g, ' ')        // 换行转空格
    .replace(/\s+/g, ' ')
    .trim();
  try {
    const tmpFile = path.join(os.tmpdir(), `cdp-eval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.js`);
    fs.writeFileSync(tmpFile, code, 'utf-8');
    const r = await cdp('exec', tmpFile);
    if (r && r !== '(empty)') return r;
  } catch (_) {
    // exec 失败，回退到单行 eval
  }
  return cdp('eval', oneLine);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- 阶段一：列表页仅提取商品链接 ----

async function researchList(keyword) {
  const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(keyword)}&_ipg=240`;
  console.log(`[列表] 搜索: ${keyword}`);
  await cdp('goto', url);
  await cdp('waitfor', 'ul.srp-results', '10000');

  // 稳定采样：卡片是懒加载的，连续两次采样数量一致才认为渲染完成
  const EXTRACT_LIST_JS = `
JSON.stringify(
  Array.from(document.querySelectorAll('li.s-card[data-listingid]'))
    .filter(item => !item.dataset.listingid.startsWith('2500'))
    .map(item => {
      const link = (item.querySelector('a.s-card__link')?.href || '').split('?')[0];
      return link;
    })
    .filter(link => link && link.includes('/itm/'))
)
  `;

  const MAX_SAMPLES = 6;        // 最多采样 6 次（约 7.5 秒）
  const SAMPLE_INTERVAL = 1500; // 每次间隔 1.5 秒
  let links = [];
  let prevCount = -1;

  for (let s = 0; s < MAX_SAMPLES; s++) {
    if (s > 0) await sleep(SAMPLE_INTERVAL);
    const raw = await evalJS(EXTRACT_LIST_JS);
    if (!raw || raw === '(empty)') continue;
    try {
      links = JSON.parse(raw);
    } catch (_) {
      continue;
    }
    const stable = links.length === prevCount;
    console.log(`[列表] 第 ${s + 1}/${MAX_SAMPLES} 次采样: ${links.length} 个链接${stable ? ' (稳定)' : ''}`);
    if (stable) break;              // 连续两次一致 → 渲染完成
    prevCount = links.length;
    if (links.length >= 240) break; // 已达 _ipg=240 上限 → 无需再等
  }

  console.log(`[列表] 提取到 ${links.length} 个商品链接`);
  return links;
}

// ---- 阶段二：详情页提取（参考 ebay-batch-detail.js） ----

// 辅助函数
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

// 从页面内嵌 JSON 脚本提取商品详情（参考 ebay-batch-detail.js）
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

  // JSON-LD
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

  // BUY_BOX
  var pv = modules.BUY_BOX && modules.BUY_BOX.binModel && modules.BUY_BOX.binModel.price && modules.BUY_BOX.binModel.price.value;
  if (pv) {
    if (pv.convertedFromValue != null) { info.sale_price = pv.convertedFromValue; info.currency = pv.convertedFromCurrency; }
    else if (pv.value != null) { info.sale_price = pv.value; info.currency = pv.currency; }
  }

  // 已售数量
  var qty = document.querySelectorAll('#qtyAvailability span');
  if (qty.length > 0) {
    var sm = qty[qty.length - 1].textContent.trim().match(/([\\d,]+)\\s*sold/i);
    if (sm) info.sold = parseInt(sm[1].replace(/,/g, ''), 10) || 0;
  }

  // 卖家信息
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

  // 兼容车辆数
  var ct = modules.COMPATIBILITY_TABLE && modules.COMPATIBILITY_TABLE.paginatedTable;
  if (ct && ct.title && ct.title.textSpans && ct.title.textSpans.length > 0) {
    var nm = ct.title.textSpans[0].text.match(/(\\d+)/);
    if (nm) info.compatible_vehicles = parseInt(nm[1].replace(/[,.]/g, ''), 10) || 0;
  }

  // Item Specifics
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

// 从 purchaseHistory 页面提取销售记录
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

// 获取商品详情页信息
async function fetchDetail(url) {
  const MAX_RETRY = 3;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      // 1) 导航。不做反爬预判：waitfor 本身就是检测，能等到正确元素说明页面加载正常
      await cdp('goto', url);

      // 2) 等待 buybox。注意：waitfor 超时输出 TIMEOUT 且 exit 0（不抛错），
      //    必须按返回值判断。TIMEOUT 说明被反爬或页面异常，最多等 10s 就按失败处理
      const w1 = await cdp('waitfor', '.x-buybox-cta li', '10000');
      const pageOk = w1.startsWith('FOUND') || (await cdp('waitfor', 'h1', '6000')).startsWith('FOUND');
      await sleep(1500);

      if (pageOk) {
        const raw = await evalJS(DETAIL_EXTRACT_JS);
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
        console.log(`[详情] 页面异常(疑似反爬)：${url}`);
      }
      if (attempt < MAX_RETRY - 1) await sleep(1500 * (attempt + 1));
    } catch (e) {
      // 重试
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

// 获取 purchaseHistory 页面的90天销售数据
async function fetchSalesHistory(itemId) {
  try {
    await cdp('goto', `https://www.ebay.com/bin/purchaseHistory?item=${itemId}`);
    await cdp('waitfor', 'table', '8000');
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

async function enrichWithDetails(urls, limit, concurrency) {
  const capped = limit ? urls.slice(0, limit) : urls;
  const numWorkers = Math.min(concurrency || 1, capped.length);
  console.log(`[详情] 开始抓取 ${capped.length} 个商品详情 + 90天销售数据...`);
  console.log(`[并发] 使用 ${numWorkers} 个 Worker 并行处理`);

  // 单 Worker 模式：直接在主进程处理
  if (numWorkers <= 1) {
    const results = [];
    for (let i = 0; i < capped.length; i++) {
      const url = capped[i];
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
      process.stdout.write('.');
      if ((i + 1) % 5 === 0) { process.stdout.write(` ${i + 1}`); await sleep(400); }
    }
    console.log(`\n[详情] 完成 ${results.length} 个商品抓取`);
    return results;
  }

  // 多 Worker 模式：分配 URL 给各 Worker 并行处理
  const chunks = Array.from({ length: numWorkers }, () => []);
  capped.forEach((url, i) => chunks[i % numWorkers].push(url));

  const allResults = [];
  let completedWorkers = 0;
  let totalProgress = 0;

  return new Promise((resolve, reject) => {
    const workers = [];

    for (let w = 0; w < numWorkers; w++) {
      const worker = fork(path.join(__dirname, 'ebay-research-worker.js'), [], {
        env: { ...process.env, WORKER_ID: String(w) },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });

      workers.push(worker);

      // 转发 Worker 的 stdout（target 就绪、步骤耗时、cdp:slow 等关键日志）
      worker.stdout.on('data', (data) => { process.stdout.write(data); });

      // 收集 Worker 的 stderr 输出
      let stderrBuf = '';
      worker.stderr.on('data', (data) => { stderrBuf += data.toString(); });

      worker.on('message', (msg) => {
        if (msg.type === 'ready') {
          // Worker 就绪，发送任务
          worker.send({ type: 'work', urls: chunks[w], workerId: w });
        } else if (msg.type === 'progress') {
          totalProgress++;
          process.stdout.write(`\r[进度] ${totalProgress}/${capped.length} (${Math.round(totalProgress / capped.length * 100)}%)`);
        } else if (msg.type === 'result') {
          allResults.push(...msg.data);
        } else if (msg.type === 'done') {
          completedWorkers++;
          console.log(`\n[Worker ${msg.workerId}] 完成 ${msg.count} 个商品`);
          if (completedWorkers === numWorkers) {
            // 按原始 URL 顺序排序
            allResults.sort((a, b) => {
              const ia = capped.indexOf(a.url);
              const ib = capped.indexOf(b.url);
              return ia - ib;
            });
            // 通知所有 Worker 退出，回收子进程
            for (const w of workers) {
              try { w.send({ type: 'exit' }); } catch (_) {}
            }
            console.log(`[详情] 所有 Worker 完成，共 ${allResults.length} 个商品`);
            resolve(allResults);
          }
        } else if (msg.type === 'error') {
          console.error(`[Worker ${msg.workerId}] 错误: ${msg.error}`);
        }
      });

      worker.on('error', (err) => {
        console.error(`[Worker ${w}] 进程错误: ${err.message}`);
      });

      worker.on('exit', (code) => {
        if (code !== 0 && completedWorkers < numWorkers) {
          console.error(`[Worker ${w}] 异常退出 (code: ${code})`);
          if (stderrBuf) console.error(stderrBuf.trim());
        }
      });
    }
  });
}

// ---- 主流程 ----

// 解析 CLI 参数：同时支持 --limit N 与 --limit=N 两种写法
function parseCliArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--report' || a === '--no-detail') {
      opts[a.slice(2)] = true;
      continue;
    }
    const eq = a.match(/^--([^=]+)=(.*)$/);
    if (eq) {
      opts[eq[1]] = eq[2];
      continue;
    }
    if ((a === '--limit' || a === '--concurrency') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      opts[a.slice(2)] = argv[i + 1];
      i++;
      continue;
    }
    positional.push(a);
  }
  return { opts, positional };
}

function research() {
  const { opts, positional } = parseCliArgs(process.argv.slice(2));
  const reportFlag = opts.report || false;
  const noDetail = opts['no-detail'] || false;
  const limit = parseInt(opts.limit || '0', 10) || 0;
  const concurrency = parseInt(opts.concurrency || '1', 10) || 1;

  const keyword = positional[0];
  const outputArg = positional[1];

  if (!keyword) {
    console.error(`
  用法: node ebay-research.js <关键词> [输出文件] [--report] [--no-detail] [--limit N] [--concurrency N]

  示例:
    node ebay-research.js headlight --report
    node ebay-research.js headlight items.json
    node ebay-research.js headlight --limit 20 --report
    node ebay-research.js headlight --limit 20 --concurrency=3 --report
    `);
    process.exit(1);
  }

  const now = new Date();
  const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const outputFile = outputArg
    ? outputArg.replace(/\.json$/i, `-${ts}.json`)
    : `ebay-${keyword.replace(/[^a-zA-Z0-9一-龥]/g, '-')}-${ts}.json`;

  (async () => {
    // 阶段一：列表页仅获取链接
    let urls = await researchList(keyword);
    if (urls.length === 0) { console.log('未提取到商品'); process.exit(0); }

    // 阶段二：详情+90天销售（可跳过）
    let items;
    if (!noDetail) {
      items = await enrichWithDetails(urls, limit, concurrency);
    } else {
      console.log('[详情] 已跳过 (--no-detail)');
      items = urls.map(u => ({ url: u, item_id: u.match(/\/itm\/(\d+)/)?.[1] || null }));
    }

    const jsonPath = path.resolve(outputFile);
    fs.writeFileSync(jsonPath, JSON.stringify(items, null, 2), 'utf-8');
    console.log(`COUNT: ${items.length}`);
    console.log(`FILE: ${jsonPath}`);

    if (reportFlag) generateReport(jsonPath, keyword);
  })();
}

// ---- 生成报表 ----

function generateReport(inputFile, keyword, outputFile) {
  if (!fs.existsSync(inputFile)) {
    console.error('错误: 文件不存在 - ' + inputFile);
    process.exit(1);
  }
  if (outputFile === undefined && keyword && (keyword.endsWith('.html') || keyword.endsWith('.htm'))) {
    outputFile = keyword;
    keyword = '';
  }
  outputFile = outputFile || inputFile.replace(/\.json$/i, '-report.html');
  const title = keyword ? `eBay 商品【${keyword}】深度调研报告` : 'eBay 商品深度调研报告';

  const rawJson = JSON.stringify(JSON.parse(fs.readFileSync(inputFile, 'utf8')));

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"><\/script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f2f5; color: #333; }
.header { background: linear-gradient(135deg, #1a1a2e, #16213e); color: #fff; padding: 30px 0; text-align: center; }
.header h1 { font-size: 26px; margin-bottom: 6px; }
.header p { color: #a0aec0; font-size: 14px; }
.container { max-width: 1500px; margin: 0 auto; padding: 20px; }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
.stat-card { background: #fff; border-radius: 12px; padding: 20px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.stat-card .num { font-size: 26px; font-weight: 700; color: #1a1a2e; }
.stat-card .label { font-size: 13px; color: #718096; margin-top: 4px; }
.charts-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
@media (max-width: 900px) { .charts-row { grid-template-columns: 1fr; } }
.chart-box { background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.chart-box h3 { font-size: 15px; color: #4a5568; margin-bottom: 12px; }
.chart-box canvas { max-height: 340px; }
.toolbar { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }
.toolbar input, .toolbar select { padding: 8px 14px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 14px; background: #fff; }
.toolbar input { flex: 1; min-width: 200px; }
.toolbar select { cursor: pointer; }
.toolbar .info { margin-left: auto; font-size: 13px; color: #718096; }
.table-wrap { background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
thead { background: #f7fafc; }
th { padding: 12px 14px; text-align: left; font-weight: 600; color: #4a5568; cursor: pointer; user-select: none; white-space: nowrap; }
th:hover { color: #1a1a2e; }
th .arrow { margin-left: 4px; font-size: 11px; }
td { padding: 10px 14px; border-top: 1px solid #edf2f7; white-space: nowrap; }
tr:hover { background: #f7fafc; }
.price { font-weight: 600; color: #2d3748; }
.shop-badge { display: inline-block; background: #ebf4ff; color: #2b6cb0; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
.seller-badge { display: inline-block; background: #e6fffa; color: #285e61; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
.title-col { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.title-col a { color: #2b6cb0; text-decoration: none; }
.title-col a:hover { text-decoration: underline; }
.img-thumb { width: 50px; height: 50px; object-fit: contain; border-radius: 6px; background: #f7fafc; }
.pagination { display: flex; justify-content: center; align-items: center; gap: 8px; padding: 16px; }
.pagination button { padding: 6px 14px; border: 1px solid #e2e8f0; border-radius: 6px; background: #fff; cursor: pointer; font-size: 13px; }
.pagination button:hover { background: #f7fafc; }
.pagination button:disabled { opacity: .4; cursor: default; }
.pagination .page-info { font-size: 13px; color: #718096; }
<\/style>
<\/head>
<body>
<div class="header">
  <h1>${title}</h1>
  <p>共 <span id="headerCount">-</span> 件商品 · 数据采集于 eBay 实时页面</p>
<\/div>
<div class="container">
  <div class="stats-grid" id="statsGrid"><\/div>
  <div class="charts-row">
    <div class="chart-box"><h3>📊 价格分布<\/h3><canvas id="priceChart"><\/canvas><\/div>
    <div class="chart-box"><h3>🏪 热门店铺 Top 15<\/h3><canvas id="shopChart"><\/canvas><\/div>
  <\/div>
  <div class="charts-row">
    <div class="chart-box"><h3>📈 90天销量 Top 20<\/h3><canvas id="soldChart"><\/canvas><\/div>
    <div class="chart-box"><h3>💰 90天均价分布<\/h3><canvas id="avgPriceChart"><\/canvas><\/div>
  <\/div>
  <div class="toolbar">
    <input type="text" id="searchInput" placeholder="搜索标题、卖家、店铺..." oninput="renderTable()">
    <select id="soldFilter" onchange="renderTable()">
      <option value="">全部</option>
      <option value="has">有90天销量</option>
      <option value="none">无90天销量</option>
    <\/select>
    <span class="info" id="tableInfo"><\/span>
  <\/div>
  <div class="table-wrap">
    <table id="dataTable">
      <thead>
        <tr>
          <th>图片</th>
          <th onclick="sortBy('title')">标题 <span class="arrow">▾<\/span><\/th>
          <th onclick="sortBy('sale_price')">价格 <span class="arrow">▾<\/span><\/th>
          <th onclick="sortBy('seller_name')">卖家 <span class="arrow">▾<\/span><\/th>
          <th onclick="sortBy('positive_rate')">好评率 <span class="arrow">▾<\/span><\/th>
          <th onclick="sortBy('sold_90days')">90天销量 <span class="arrow">▾<\/span><\/th>
          <th onclick="sortBy('avg_price_90days')">90天均价 <span class="arrow">▾<\/span><\/th>
          <th onclick="sortBy('sold')">总销量 <span class="arrow">▾<\/span><\/th>
          <th>链接</th>
        <\/tr>
      <\/thead>
      <tbody id="tableBody"><\/tbody>
    <\/table>
    <div class="pagination" id="pagination"><\/div>
  <\/div>
<\/div>
<script>
var RAW_DATA = ${rawJson};
var data = [], filtered = [], page = 1, pageSize = 25;
var sortField = 'sold_90days', sortDir = 'desc';

(function init() {
  data = RAW_DATA.map(function(d){
    d.sale_price = parseFloat(d.sale_price) || 0;
    d.sold = parseInt(d.sold) || 0;
    d.compatible_vehicles = parseInt(d.compatible_vehicles) || 0;
    d.positive_rate = parseFloat(d.positive_rate) || 0;
    d.sold_90days = parseInt(d.sold_90days) || 0;
    d.avg_price_90days = parseFloat(d.avg_price_90days) || 0;
    d.min_price_90days = parseFloat(d.min_price_90days) || 0;
    d.max_price_90days = parseFloat(d.max_price_90days) || 0;
    return d;
  });
  document.getElementById('headerCount').textContent = data.length;
  renderStats(); renderCharts(); renderTable();
})();
function getFiltered() {
  var q = document.getElementById('searchInput').value.toLowerCase();
  var sf = document.getElementById('soldFilter').value;
  var arr = data.filter(function(d){
    if (q && (d.title||'').toLowerCase().indexOf(q)===-1 && (d.seller_name||'').toLowerCase().indexOf(q)===-1 && (d.store_name||'').toLowerCase().indexOf(q)===-1) return false;
    if (sf === 'has' && d.sold_90days<=0) return false;
    if (sf === 'none' && d.sold_90days>0) return false;
    return true;
  });
  arr.sort(function(a,b){
    var va=a[sortField], vb=b[sortField];
    if (typeof va==='string'){ va=va.toLowerCase(); vb=(vb+'').toLowerCase(); }
    return sortDir==='asc' ? (va>vb?1:-1) : (va<vb?1:-1);
  });
  return arr;
}
function renderTable(){ filtered=getFiltered(); page=1; applyPage(); }
function applyPage(){
  var start=(page-1)*pageSize, end=start+pageSize, pages=Math.ceil(filtered.length/pageSize);
  var slice=filtered.slice(start,end);
  var tb=document.getElementById('tableBody');
  var h='';
  for (var i=0;i<slice.length;i++){
    var d=slice[i];
    var t=(d.title||'').substring(0,80);
    h+='<tr>'+
      '<td><img class="img-thumb" src="'+(d.image||'')+'" alt="" loading="lazy" onerror="this.style.display=\\'none\\'"><\/td>'+
      '<td class="title-col"><a href="'+(d.url||d.link||'')+'" target="_blank">'+t+'<\/a><\/td>'+
      '<td class="price">'+(d.currency||'$')+(d.sale_price?d.sale_price.toFixed(2):'?')+'<\/td>'+
      '<td><span class="seller-badge">'+(d.seller_name||'-')+'<\/span><\/td>'+
      '<td>'+(d.positive_rate?d.positive_rate.toFixed(1)+'%':'-')+'<\/td>'+
      '<td>'+(d.sold_90days?d.sold_90days.toLocaleString()+' 件':'-')+'<\/td>'+
      '<td>'+(d.avg_price_90days?'$'+d.avg_price_90days.toFixed(2):'-')+'<\/td>'+
      '<td>'+(d.sold?d.sold.toLocaleString():'-')+'<\/td>'+
      '<td><a href="'+(d.url||d.link||'')+'" target="_blank" style="font-size:12px;color:#2b6cb0;">🔗<\/a><\/td>'+
      '<\/tr>';
  }
  tb.innerHTML=h;
  document.getElementById('tableInfo').textContent=filtered.length+' / '+data.length;
  var pg=document.getElementById('pagination');
  pg.innerHTML='<button onclick="goPage(1)"'+(page<=1?' disabled':'')+'>首页<\/button>'+
    '<button onclick="goPage('+(page-1)+')"'+(page<=1?' disabled':'')+'>‹<\/button>'+
    '<span class="page-info">'+page+'/'+pages+'</span>'+
    '<button onclick="goPage('+(page+1)+')"'+(page>=pages?' disabled':'')+'>›<\/button>'+
    '<button onclick="goPage('+pages+')"'+(page>=pages?' disabled':'')+'>末页<\/button>';
}
function goPage(p){ page=p; applyPage(); }
function sortBy(f){ if(sortField===f) sortDir=sortDir==='asc'?'desc':'asc'; else {sortField=f; sortDir='asc';} renderTable(); }
function renderStats(){
  var prices=data.filter(function(d){return d.sale_price>0;}).map(function(d){return d.sale_price;});
  var min=Math.min.apply(null,prices), max=Math.max.apply(null,prices);
  var avg=prices.reduce(function(a,b){return a+b;},0)/prices.length;
  var totalSold90=data.reduce(function(a,d){return a+d.sold_90days;},0);
  var withSold90=data.filter(function(d){return d.sold_90days>0;}).length;
  document.getElementById('statsGrid').innerHTML=
    '<div class="stat-card"><div class="num">'+data.length+'<\/div><div class="label">商品总数<\/div><\/div>'+
    '<div class="stat-card"><div class="num">$'+(isFinite(min)?min.toFixed(0):'-')+'<\/div><div class="label">最低价<\/div><\/div>'+
    '<div class="stat-card"><div class="num">$'+(isFinite(max)?max.toFixed(0):'-')+'<\/div><div class="label">最高价<\/div><\/div>'+
    '<div class="stat-card"><div class="num">$'+(isFinite(avg)?avg.toFixed(0):'-')+'<\/div><div class="label">平均价<\/div><\/div>'+
    '<div class="stat-card"><div class="num">'+totalSold90.toLocaleString()+'<\/div><div class="label">90天总销量<\/div><\/div>'+
    '<div class="stat-card"><div class="num">'+withSold90+'<\/div><div class="label">含90天销量<\/div><\/div>';
}
function renderCharts(){
  var prices=data.filter(function(d){return d.sale_price>0;}).map(function(d){return d.sale_price;});
  var bins=[0,50,100,150,200,250,300,350,400,450,500,600,700,1000];
  var labels=['$0-50','$50-100','$100-150','$150-200','$200-250','$250-300','$300-350','$350-400','$400-450','$450-500','$500-600','$600-700','$700+'];
  var counts=new Array(labels.length).fill(0);
  prices.forEach(function(p){ for(var i=0;i<bins.length-1;i++){ if(p>=bins[i]&&p<bins[i+1]){counts[i]++;return;} } counts[labels.length-1]++; });
  new Chart(document.getElementById('priceChart'),{type:'bar',data:{labels:labels,datasets:[{label:'商品数',data:counts,backgroundColor:'#4f8cf7',borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}}}});
  // 卖家统计（基于seller_name）
  var sellerCnt={}; data.forEach(function(d){ if(d.seller_name) sellerCnt[d.seller_name]=(sellerCnt[d.seller_name]||0)+1; });
  var topSellers=Object.entries(sellerCnt).sort(function(a,b){return b[1]-a[1];}).slice(0,15);
  new Chart(document.getElementById('shopChart'),{type:'bar',data:{labels:topSellers.map(function(s){return s[0];}),datasets:[{label:'商品数',data:topSellers.map(function(s){return s[1];}),backgroundColor:'#48bb78',borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{display:false}}}});
  // 90天销量 Top 20
  var sorted=[...data].filter(function(d){return d.sold_90days>0;}).sort(function(a,b){return b.sold_90days-a.sold_90days;});
  var top20=sorted.slice(0,20).reverse();
  var sLabels=top20.map(function(d){return (d.title||'').substring(0,30)+(d.sold_90days?(' ('+d.sold_90days+')'):'');});
  new Chart(document.getElementById('soldChart'),{type:'bar',data:{labels:sLabels,datasets:[{label:'90天销量(件)',data:top20.map(function(d){return d.sold_90days;}),backgroundColor:'#f6ad55',borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{display:false}}}});
  // 90天均价分布
  var avgPrices=data.filter(function(d){return d.avg_price_90days>0;}).map(function(d){return d.avg_price_90days;});
  var avgBins=[0,20,40,60,80,100,150,200,300,500];
  var avgLabels=['$0-20','$20-40','$40-60','$60-80','$80-100','$100-150','$150-200','$200-300','$300+'];
  var avgCounts=new Array(avgLabels.length).fill(0);
  avgPrices.forEach(function(p){ for(var i=0;i<avgBins.length-1;i++){ if(p>=avgBins[i]&&p<avgBins[i+1]){avgCounts[i]++;return;} } avgCounts[avgLabels.length-1]++; });
  new Chart(document.getElementById('avgPriceChart'),{type:'doughnut',data:{labels:avgLabels,datasets:[{data:avgCounts,backgroundColor:['#4f8cf7','#48bb78','#f6ad55','#fc8181','#9f7aea','#38b2ac','#ed64a6','#ecc94b','#667eea']}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom'}}}});
}
<\/script>
<\/body>
<\/html>`;

  fs.writeFileSync(outputFile, html, 'utf8');
  console.log('报表已生成: ' + outputFile + ' (' + fs.statSync(outputFile).size + ' bytes)');
}

// ---- 入口 ----

const firstArg = process.argv[2];
if (!firstArg) {
  console.error(`
  用法: node ebay-research.js <关键词> [输出文件] [--report] [--no-detail] [--limit N] [--concurrency N]
          node ebay-research.js <输入JSON> [输出HTML]

  示例:
    node ebay-research.js headlight --report
    node ebay-research.js headlight items.json
    node ebay-research.js headlight --limit 20 --concurrency=3 --report
    node ebay-research.js data.json
  `);
  process.exit(1);
}

if (fs.existsSync(firstArg) && firstArg.endsWith('.json')) {
  // 已有 JSON 文件 → 仅生成报表
  generateReport(firstArg, process.argv[3]);
} else {
  // 关键词 → 列表 + 详情两阶段调研
  research();
}

