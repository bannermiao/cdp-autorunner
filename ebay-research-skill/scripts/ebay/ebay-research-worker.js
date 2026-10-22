#!/usr/bin/env node
/**
 * ebay-research-worker.js — 单个并发单元的抓取进程，由 ebay-research.js 通过 fork() 拉起
 *
 * IPC 协议:
 *   发出: { type:'ready' } | { type:'progress', workerId, index, total }
 *         { type:'result', workerId, data } | { type:'done', workerId, count }
 *         { type:'error', workerId, error }
 *   收到: { type:'work', urls, workerId } | { type:'exit' }
 *
 * 每个 Worker 独占一个标签页(targetId)，全程用 *-target 命令操作它，互不干扰。
 */

const { cdp, evalOnActiveTab, evalOnTarget, sleep } = require('../lib/cdp-client');
const {
  DETAIL_EXTRACT_JS, PURCHASE_HISTORY_EXTRACT_JS,
  itemIdOf, emptyItem, EMPTY_SALES, calcSalesStats, sanitizeItem,
} = require('../lib/ebay-extract');

// 汇率表由主进程随 work 消息发来（主进程只取一次，Worker 不重复请求 API）
let FX = null;

const WORKER_ID = process.env.WORKER_ID || '0';
const log = (...a) => console.log(`[Worker ${WORKER_ID}]`, ...a);

// 专属 target；为 null 时回退到共享活动标签页
let targetId = null;

const goto = (url) => targetId ? cdp('goto-target', targetId, url) : cdp('goto', url);
const waitfor = (sel, timeout) => targetId ? cdp('waitfor-target', targetId, sel, timeout) : cdp('waitfor', sel, timeout);
const evalJS = (code) => targetId ? evalOnTarget(targetId, code) : evalOnActiveTab(code);

const send = (msg) => { if (process.send) process.send(msg); };

// 新建标签页并拿回 targetId
async function createTarget() {
  const out = await cdp('new-tab', 'about:blank');
  const m = out.match(/NEW-TAB:\s*(\S+)/);
  if (!m || !m[1]) throw new Error('new-tab 未返回 targetId');
  targetId = m[1];
}

async function destroyTarget() {
  if (!targetId) return;
  const dead = targetId;
  targetId = null;
  try { await cdp('close-tab', dead); } catch (_) {}
}

// 预热验证：new-tab 成功后立刻 eval-target 跑一句 1+1，确认 attach 链路真能用。
// 多个 Worker 同时 new-tab 会撞扩展端的 debugger attach 单例，首个 target 的后续命令会挂起
// （表现为"详情页开了但程序不动"）。这里失败就关掉重建，把冲突解决在初始化阶段。
async function initTarget() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await createTarget();
      const r = await cdp('eval-target', targetId, '1+1');
      if (r && r.includes('2')) { log(`target 就绪: ${targetId}`); return true; }
      throw new Error(`预热验证失败: ${r}`);
    } catch (e) {
      log(`target 初始化异常(${e.message})，第 ${attempt + 1} 次重建`);
      await destroyTarget();
      await sleep(1500 * (attempt + 1));
    }
  }
  log('target 初始化失败，回退共享 tab');
  return false;
}

// 超时/异常后重置 target：清掉扩展端可能残留的 attach，避免后续命令全部排队卡死
async function resetTarget() {
  await destroyTarget();
  try { await initTarget(); } catch (_) {}
}

async function fetchDetail(url) {
  const MAX_RETRY = 3;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      const t0 = Date.now();
      await goto(url);
      const gotoMs = Date.now() - t0;

      const t1 = Date.now();
      const w1 = await waitfor('.x-buybox-cta li', '10000');
      const pageOk = w1.startsWith('FOUND') || (await waitfor('h1', '6000')).startsWith('FOUND');
      log(`goto ${gotoMs}ms / waitfor ${Date.now() - t1}ms(${w1.slice(0, 12)}) / pageOk=${pageOk}: ${url}`);
      await sleep(1500);

      if (pageOk) {
        const raw = await evalJS(DETAIL_EXTRACT_JS);
        if (raw && raw.startsWith('{')) {
          const d = JSON.parse(raw);
          if (d.title) {
            d.url = url;
            if (itemIdOf(url)) d.item_id = itemIdOf(url);
            return sanitizeItem(d);
          }
        }
      } else {
        log(`页面异常(疑似反爬)：${url}`);
      }
    } catch (e) {
      log(`抓取异常(${e.message})，重置标签页后重试：${url}`);
      await resetTarget();
    }
    if (attempt < MAX_RETRY - 1) await sleep(1500 * (attempt + 1));
  }
  return emptyItem(url);
}

async function fetchSalesHistory(itemId) {
  try {
    await goto(`https://www.ebay.com/bin/purchaseHistory?item=${itemId}`);
    await waitfor('table', '8000');
    await sleep(1000);
    const raw = await evalJS(PURCHASE_HISTORY_EXTRACT_JS);
    if (!raw || raw === '(empty)') return EMPTY_SALES;
    const o = JSON.parse(raw);
    return o.has_table ? calcSalesStats(o.rows || [], FX) : EMPTY_SALES;
  } catch (e) {
    return EMPTY_SALES;
  }
}

async function processUrls(urls, workerId) {
  // 错开初始化时机：worker 0 立即建 tab，worker N 延迟 N*800ms，避开 attach 单例竞争
  if (workerId > 0) await sleep(workerId * 800);
  await initTarget();

  const results = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const itemId = itemIdOf(url);
    const detail = await fetchDetail(url);
    Object.assign(detail, (itemId && detail.title) ? await fetchSalesHistory(itemId) : EMPTY_SALES);
    results.push(detail);
    send({ type: 'progress', workerId, index: i + 1, total: urls.length });
  }

  send({ type: 'result', workerId, data: results });
  send({ type: 'done', workerId, count: results.length });
}

process.on('message', async (msg) => {
  if (msg.type === 'work') {
    FX = msg.fx || null;
    try {
      await processUrls(msg.urls, msg.workerId);
    } catch (e) {
      send({ type: 'error', workerId: msg.workerId, error: e.message });
      send({ type: 'done', workerId: msg.workerId, count: 0 });
    }
  } else if (msg.type === 'exit') {
    await destroyTarget();   // 收尾时关掉自己的标签页，不残留
    process.exit(0);
  }
});

send({ type: 'ready', workerId: WORKER_ID });
