#!/usr/bin/env node
/**
 * ebay-research.js — eBay 商品调研：列表链接 → 详情 + 90天销量 → JSON / HTML 报表
 *
 * 用法:
 *   node ebay-research.js <关键词> [输出根目录] [--limit N] [--concurrency N] [--no-detail] [--no-report]
 *   node ebay-research.js --keywords "a,b,c" [输出根目录]     多关键词，结果合并成一份交付
 *   node ebay-research.js <交付目录里的JSON> [输出HTML]     用缓存重出 Excel + 报表
 *
 * 交付落在工作目录下的 <YYYY_MM_DD__关键词>/ 文件夹（关键词里的符号会洗成下划线），
 * 同一天同关键词重跑自动加 __02/__03 后缀，不覆盖上一次结果。里面三份同名文件：
 *   <关键词>.json   原始结构化缓存，重出报表用它，不必重抓
 *   <关键词>.xlsx   Excel 明细表，价格/销量数值型，供透视与二次统计
 *   <关键词>.html   可视化报表，便于预览与分发（Chart.js 走 CDN，需联网打开）
 *
 * 示例:
 *   node ebay-research.js "headlight" --limit 60 --concurrency 3
 *   node ebay-research.js "LED head/lamp 12V*24V"        → 2026_10_22__LED_head_lamp_12V_24V/
 *   node ebay-research.js "headlight" --no-report
 *   node ebay-research.js 2026_10_22__headlight/headlight.json
 *
 * 纯 Node 标准库 + cdp-server，零 npm 依赖。
 */

const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');

const { cdp, evalOnActiveTab, sleep } = require('../lib/cdp-client');
const { getFx } = require('../lib/exchange-rate');
const {
  LIST_EXTRACT_JS, DETAIL_EXTRACT_JS, PURCHASE_HISTORY_EXTRACT_JS,
  itemIdOf, emptyItem, EMPTY_SALES, calcSalesStats, sanitizeItem, stampFx,
} = require('../lib/ebay-extract');
const { renderReport } = require('../lib/ebay-report');
const { writeXlsx } = require('../lib/ebay-xlsx');

// 汇率表在 run() 里取一次：串行模式直接用；并发时随 work 消息发给 Worker
let FX = null;

// ---- 阶段一：列表页只取商品链接 ----

async function researchList(keyword) {
  const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(keyword)}&_ipg=240`;
  console.log(`[列表] 搜索: ${keyword}`);
  await cdp('goto', url);

  // 等不到结果容器就是链路/页面出问题了（daemon 半死、反爬、改版），必须报错而不是安静返回 0 条
  const ready = await cdp('waitfor', 'ul.srp-results', '10000');
  if (!ready.startsWith('FOUND')) {
    throw new Error(`列表页没有结果容器（waitfor 返回 ${JSON.stringify(ready)}）：${url}\n  依次排查：cdp-server status → 扩展是否绿灯 → 在 Chrome 里手动打开这个搜索页看是验证码还是空结果`);
  }

  // 卡片懒加载：连续两次采样数量一致才认为渲染完成
  const MAX_SAMPLES = 6;
  const SAMPLE_INTERVAL = 1500;
  let links = [];
  let prevCount = -1;

  for (let s = 0; s < MAX_SAMPLES; s++) {
    if (s > 0) await sleep(SAMPLE_INTERVAL);
    let current;
    try {
      const raw = await evalOnActiveTab(LIST_EXTRACT_JS);
      if (!raw || raw === '(empty)') continue;
      current = JSON.parse(raw);
    } catch (_) {
      continue;
    }
    const stable = current.length === prevCount;
    console.log(`[列表] 第 ${s + 1}/${MAX_SAMPLES} 次采样: ${current.length} 个链接${stable ? ' (稳定)' : ''}`);
    links = current;
    if (stable || links.length >= 240) break;
    prevCount = current.length;
  }

  console.log(`[列表] 提取到 ${links.length} 个商品链接`);
  return links;
}

// ---- 阶段二：详情页 + 90天销量（无专属 target，打当前活动标签页） ----

async function fetchDetail(url) {
  const MAX_RETRY = 3;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      await cdp('goto', url);
      // waitfor 超时输出 TIMEOUT 且 exit 0（不抛错），必须按返回值判断。
      // 等不到 buybox 说明页面异常/被反爬，按失败处理。
      const w1 = await cdp('waitfor', '.x-buybox-cta li', '10000');
      const pageOk = w1.startsWith('FOUND') || (await cdp('waitfor', 'h1', '6000')).startsWith('FOUND');
      await sleep(1500);

      if (pageOk) {
        const raw = await evalOnActiveTab(DETAIL_EXTRACT_JS);
        if (raw && raw.startsWith('{')) {
          const d = JSON.parse(raw);
          if (d.title) {
            d.url = url;
            if (itemIdOf(url)) d.item_id = itemIdOf(url);
            return sanitizeItem(d);
          }
        }
      } else {
        console.log(`[详情] 页面异常(疑似反爬)：${url}`);
      }
    } catch (e) {
      console.log(`[详情] 抓取异常(${e.message})，重试：${url}`);
    }
    if (attempt < MAX_RETRY - 1) await sleep(1500 * (attempt + 1));
  }
  return emptyItem(url);
}

async function fetchSalesHistory(itemId) {
  try {
    await cdp('goto', `https://www.ebay.com/bin/purchaseHistory?item=${itemId}`);
    await cdp('waitfor', 'table', '8000');
    await sleep(1000);
    const raw = await evalOnActiveTab(PURCHASE_HISTORY_EXTRACT_JS);
    if (!raw || raw === '(empty)') return EMPTY_SALES;
    const o = JSON.parse(raw);
    return o.has_table ? calcSalesStats(o.rows || [], FX) : EMPTY_SALES;
  } catch (e) {
    return EMPTY_SALES;
  }
}

async function fetchOne(url) {
  const itemId = itemIdOf(url);
  const detail = await fetchDetail(url);
  if (itemId && detail.title) Object.assign(detail, await fetchSalesHistory(itemId));
  else Object.assign(detail, EMPTY_SALES);
  return detail;
}

// 需要收尾补抓的条目：详情没拿到标题，或成交页没读到（sold_* 全为 null）
function needsRetry(items) {
  return items.filter((i) => !i.title || i.sold_90days === null);
}

// 收尾补抓一轮：主队列跑完后，把上面这些条目再试一遍。
// 只回填拿到的值，不会用新的 null 冲掉已有的好数据；串行执行，避免刚恢复的链路又被并发打崩。
async function retryIncomplete(items) {
  const need = needsRetry(items);
  if (need.length === 0) return { tried: 0, fixed: 0 };
  console.log(`[补抓] ${need.length} 个条目未完成（详情无标题 / 成交页未读到），再试一轮`);
  let fixed = 0;
  for (const item of need) {
    const wasMissingTitle = !item.title;
    const wasMissingSales = item.sold_90days === null;
    const fresh = await fetchOne(item.url);
    for (const [k, v] of Object.entries(fresh)) {
      if (v !== null && v !== undefined) item[k] = v;
    }
    const nowOk = (!wasMissingTitle || item.title) && (!wasMissingSales || item.sold_90days !== null);
    if (nowOk && (wasMissingTitle || wasMissingSales)) fixed++;
    console.log(`[补抓] ${item.item_id}: ${nowOk ? '已补回' : '仍失败'}（标题 ${item.title ? '有' : '无'} / 成交 ${item.sold_90days === null ? '未读到' : item.sold_90days + ' 件'}）`);
  }
  return { tried: need.length, fixed };
}

// ---- 编排：单进程串行 / 多 Worker 并发 ----

async function enrichWithDetails(urls, limit, concurrency) {
  const capped = limit > 0 ? urls.slice(0, limit) : urls;
  const numWorkers = Math.min(concurrency || 1, capped.length);
  console.log(`[详情] 开始抓取 ${capped.length} 个商品详情 + 90天销售数据`);

  if (numWorkers <= 1) {
    console.log(`[并发] 单进程串行`);
    const results = [];
    for (let i = 0; i < capped.length; i++) {
      results.push(await fetchOne(capped[i]));
      process.stdout.write('.');
      if ((i + 1) % 5 === 0) { process.stdout.write(` ${i + 1}`); await sleep(400); }
    }
    console.log(`\n[详情] 完成 ${results.length} 个商品抓取`);
    return results;
  }

  console.log(`[并发] ${numWorkers} 个 Worker，各自独立标签页`);
  const chunks = Array.from({ length: numWorkers }, () => []);
  capped.forEach((url, i) => chunks[i % numWorkers].push(url));

  return new Promise((resolve, reject) => {
    const allResults = [];
    let completedWorkers = 0;
    let totalProgress = 0;
    let settled = false;
    const workers = [];

    // 任何 Worker 意外退出都要收尾，否则主进程永远等不到 done（原来会静默挂住）
    const fail = async (msg) => {
      if (settled) return;
      settled = true;
      // 先让 Worker 自己收尾（关掉专属标签页），等不到的再 kill 兜底
      for (const wk of workers) { try { wk.send({ type: 'exit' }); } catch (_) {} }
      await sleep(4000);
      for (const wk of workers) { try { if (wk.exitCode === null) wk.kill(); } catch (_) {} }
      reject(new Error(msg));
    };

    for (let w = 0; w < numWorkers; w++) {
      const worker = fork(path.join(__dirname, 'ebay-research-worker.js'), [], {
        env: { ...process.env, WORKER_ID: String(w) },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });
      workers.push(worker);

      worker.stdout.on('data', (data) => { process.stdout.write(data); });
      let stderrBuf = '';
      worker.stderr.on('data', (data) => { stderrBuf += data.toString(); });

      worker.on('message', (msg) => {
        if (msg.type === 'ready') {
          worker.send({ type: 'work', urls: chunks[w], workerId: w, fx: FX });
        } else if (msg.type === 'progress') {
          totalProgress++;
          process.stdout.write(`\r[进度] ${totalProgress}/${capped.length} (${Math.round(totalProgress / capped.length * 100)}%)   `);
        } else if (msg.type === 'result') {
          allResults.push(...msg.data);
        } else if (msg.type === 'done') {
          completedWorkers++;
          console.log(`\n[Worker ${msg.workerId}] 完成 ${msg.count} 个商品`);
          if (completedWorkers === numWorkers && !settled) {
            settled = true;
            allResults.sort((a, b) => capped.indexOf(a.url) - capped.indexOf(b.url));
            for (const wk of workers) { try { wk.send({ type: 'exit' }); } catch (_) {} }
            console.log(`[详情] 所有 Worker 完成，共 ${allResults.length} 个商品`);
            resolve(allResults);
          }
        } else if (msg.type === 'error') {
          console.error(`[Worker ${msg.workerId}] 错误: ${msg.error}`);
        }
      });

      worker.on('error', (err) => console.error(`[Worker ${w}] 进程错误: ${err.message}`));
      worker.on('exit', (code) => {
        if (code !== 0 && !settled) {
          if (stderrBuf) console.error(stderrBuf.trim());
          fail(`Worker ${w} 异常退出 (code: ${code})`);
        }
      });
    }
  });
}

// ---- CLI ----

// 同时支持 --limit N 与 --limit=N
function parseCliArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-detail' || a === '--no-report') { opts[a.slice(2)] = true; continue; }
    const eq = a.match(/^--([^=]+)=(.*)$/);
    if (eq) { opts[eq[1]] = eq[2]; continue; }
    if ((a === '--limit' || a === '--concurrency' || a === '--keywords') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      opts[a.slice(2)] = argv[++i];
      continue;
    }
    positional.push(a);
  }
  return { opts, positional };
}

function stamp() {
  const n = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${n.getFullYear()}_${p(n.getMonth() + 1)}_${p(n.getDate())}`;
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// 关键词进目录名。规则：文字与数字（含中文）保留，其余任意字符（空格、标点、斜杠、emoji、控制字符）
// 连同连续串一律压成一个下划线；只有夹在两个文字/数字之间的连字符保留（12V-24V）。
// 首尾分隔符丢弃，长度截到 60，Windows 保留设备名加前缀。
function sanitizeKeyword(kw) {
  const isWord = (ch) => !!ch && /[\p{L}\p{N}]/u.test(ch);
  let out = '';
  let pendingSep = false;
  const src = String(kw || '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (isWord(ch)) {
      if (pendingSep && out) out += '_';
      out += ch;
      pendingSep = false;
      continue;
    }
    if (ch === '-' && out && isWord(out[out.length - 1]) && isWord(src[i + 1])) {
      if (pendingSep) { out += '_'; pendingSep = false; }
      out += '-';
      continue;
    }
    pendingSep = true;
  }
  let s = out.slice(0, 60).replace(/[_.-]+$/, '');
  if (!s) s = 'keyword';
  if (WIN_RESERVED.test(s)) s = `_${s}`;
  return s;
}

// 交付目录：<输出根目录>/YYYY_MM_DD__<关键词>/，三份产物同名不同后缀
function makeDeliveryDir(rootDir, keyword) {
  const base = `${stamp()}__${sanitizeKeyword(keyword)}`;
  let dir = path.join(rootDir, base);
  let seq = 2;
  // 同一天同关键词重跑不覆盖上一次结果
  while (fs.existsSync(dir)) {
    dir = path.join(rootDir, `${base}__${String(seq).padStart(2, '0')}`);
    seq++;
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const USAGE = `
  用法: node ebay-research.js <关键词> [输出根目录] [--limit N] [--concurrency N] [--no-detail] [--no-report]
        node ebay-research.js --keywords "a,b,c" [输出根目录] ...   多关键词，结果合并成一份交付
        node ebay-research.js <交付目录里的JSON> [输出HTML]   用缓存重出 Excel + 报表

  交付落在 <输出根目录或cwd>/YYYY_MM_DD__关键词/ 里，三份同名文件：.json / .xlsx / .html
  同一天同关键词重跑自动加 __02、__03，不覆盖上一次结果
  多关键词按 item_id 去重，每条记录带 keyword(首个命中) 与 keywords(全部命中)

  提醒: 7/30/90 天销量与成交均价依赖 eBay 登录态；未登录时价格/标题/卖家照常抓到，销量会整列空白

  示例:
    node ebay-research.js headlight --limit 60 --concurrency 3
    node ebay-research.js "LED head/lamp 12V*24V"
    node ebay-research.js --keywords "9438904619,9438904919,A9438904619,A9438904919" --limit 30 --concurrency 3
    node ebay-research.js headlight D:/research
    node ebay-research.js 2026_10_22__headlight/headlight.json
`;

// 基准名 = <交付目录>/<关键词>，三份产物同名不同后缀
async function emitDeliverables({ jsonPath, base, title, items, opts, htmlPath }) {
  // 先出 HTML：Excel 开着会锁住 xlsx，别让报表跟着一起失败
  if (!opts['no-report']) {
    const r = renderReport(jsonPath, title, htmlPath || `${base}.html`);
    console.log(`HTML: ${path.resolve(r.outputFile)} (${r.bytes} bytes)`);
  }
  const xlsx = await writeXlsx(items, `${base}.xlsx`);
  console.log(`XLSX: ${path.resolve(xlsx.outputFile)} (${xlsx.rows} 行)`);
}

// 多关键词命中合并：按 item_id 去重，并记下每个商品被哪些关键词命中
function mergeKeywordLists(perKeyword) {
  const entries = new Map();
  for (const { kw, urls } of perKeyword) {
    for (const url of urls) {
      const id = itemIdOf(url) || url;
      const e = entries.get(id) || { url, keyword: kw, keywords: [] };
      if (!e.keywords.includes(kw)) e.keywords.push(kw);
      entries.set(id, e);
    }
  }
  return [...entries.values()];
}

// 多关键词时目录/文件名用「首个关键词+Nkw」，避免拼一长串
const kwLabel = (list) => (list.length > 1 ? `${list[0]}+${list.length - 1}kw` : list[0]);

async function run() {
  const { opts, positional } = parseCliArgs(process.argv.slice(2));
  const limit = parseInt(opts.limit || '0', 10) || 0;
  const concurrency = Math.max(1, parseInt(opts.concurrency || '1', 10) || 1);

  const kwList = String(opts.keywords || '').split(/[,，;；\n]+/).map((s) => s.trim()).filter(Boolean);
  if (!kwList.length && positional[0]) kwList.push(positional[0]);
  if (!kwList.length) { console.error(USAGE); process.exit(1); }
  const first = kwList[0];
  // 传了 --keywords 时，位置参数就当作输出根目录用
  const rootArg = opts.keywords ? positional[0] : positional[1];

  // 已有 JSON 缓存 → 重出 Excel + 报表，不重新抓取
  if (fs.existsSync(first) && /\.json$/i.test(first)) {
    const items = JSON.parse(fs.readFileSync(first, 'utf8'));
    console.log(`COUNT: ${items.length}`);
    console.log(`JSON: ${path.resolve(first)}`);
    await emitDeliverables({
      jsonPath: path.resolve(first),
      base: first.replace(/\.json$/i, ''),
      title: '',
      items,
      opts,
      htmlPath: positional[1] && /\.html?$/i.test(positional[1]) ? positional[1] : null,
    });
    return;
  }

  const label = kwLabel(kwList);
  const stem = sanitizeKeyword(label);
  const dir = makeDeliveryDir(rootArg ? path.resolve(rootArg) : process.cwd(), label);
  console.log(`[交付] 目录: ${dir}`);
  console.log('[提醒] 销量数据依赖 eBay 登录态：未登录时价格/标题/卖家照常抓到，但 7/30/90 天销量与成交均价会整列空白。要完整数据请先在 Chrome 里登录 www.ebay.com（不强制，可先跑一轮看看）。');

  FX = await getFx();
  console.log(FX
    ? `[汇率] 价格统计统一成 USD（api.exchangerate.fun ${FX.date}，${FX.source}）`
    : '[汇率] 没取到汇率：价格按页面原币种统计（price_basis=SOURCE），sale_price_usd 与 fx_date 留空');

  const perKeyword = [];
  for (let i = 0; i < kwList.length; i++) {
    if (kwList.length > 1) console.log(`[关键词 ${i + 1}/${kwList.length}] ${kwList[i]}`);
    perKeyword.push({ kw: kwList[i], urls: await researchList(kwList[i]) });
  }
  const merged = mergeKeywordLists(perKeyword);
  if (merged.length === 0) {
    console.log(`各关键词命中数: ${perKeyword.map((x) => `${x.kw}=${x.urls.length}`).join(' , ')}`);
    console.log('结果页都正常渲染但没抓到商品卡片——大概率是这些词在 eBay 上确实无结果，不是链路问题');
    process.exit(0);
  }
  if (kwList.length > 1) {
    const raw = perKeyword.reduce((s, x) => s + x.urls.length, 0);
    console.log(`[合并] ${kwList.length} 个关键词共 ${raw} 条链接，按 item_id 去重后 ${merged.length} 个商品`);
  }

  let items;
  if (opts['no-detail']) {
    console.log('[详情] 已跳过 (--no-detail)');
    items = merged.map((e) => ({ url: e.url, item_id: itemIdOf(e.url) || null, keyword: e.keyword, keywords: e.keywords.join(',') }));
  } else {
    const fetched = await enrichWithDetails(merged.map((e) => e.url), limit, concurrency);
    const byUrl = new Map(merged.map((e) => [e.url, e]));
    items = fetched.map((d) => {
      const e = byUrl.get(d.url);
      return Object.assign(d, e ? { keyword: e.keyword, keywords: e.keywords.join(',') } : { keyword: null, keywords: null });
    });
    const re = await retryIncomplete(items);
    if (re.tried) console.log(`[补抓] 尝试 ${re.tried} 个，补回 ${re.fixed} 个`);
  }

  // 轮级 USD 口径盖到每条记录（成交页抓不到的行也会被 EMPTY_SALES 清空，所以放最后统一盖）
  items.forEach((i) => stampFx(i, FX));

  const jsonPath = path.join(dir, `${stem}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(items, null, 2), 'utf-8');
  console.log(`COUNT: ${items.length}`);
  console.log(`JSON: ${jsonPath}`);

  await emitDeliverables({ jsonPath, base: path.join(dir, stem), title: kwList.join(', '), items, opts });
}

if (require.main === module) {
  run().catch((err) => {
    console.error(`\n调研失败: ${err.message}`);
    if (/EBUSY|EPERM|EACCES/.test(`${err.code || ''} ${err.message || ''}`)) {
      console.error('产物文件被占用：把正在打开的 xlsx / html 关掉再重跑。已抓到的数据在同目录的 .json 里，不会丢，可直接用它重出报表。');
    } else {
      console.error('排查顺序：1) cdp-server status  2) 扩展是否已连接(绿灯)  3) 见 SKILL.md「错误处理」');
    }
    process.exit(1);
  });
}

module.exports = { sanitizeKeyword, makeDeliveryDir, mergeKeywordLists, kwLabel, parseCliArgs, needsRetry };
