#!/usr/bin/env node
/**
 * ebay-research.js — eBay 商品搜索提取 + 可视化报表
 *
 * 用法:
 *   node ebay-research.js <关键词> [输出文件] [--report]   搜索提取
 *   node ebay-research.js <输入JSON> [输出HTML]            生成报表
 *
 * 示例:
 *   node ebay-research.js headlight
 *   node ebay-research.js headlight --report
 *   node ebay-research.js headlight items.json
 *   node ebay-research.js data.json
 *   node ebay-research.js data.json my-report.html
 *
 * 纯 Node 标准库，零 npm 依赖。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- 定位 cdp-server ----

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

function evalJS(code) {
  if (code.length < 100 && !code.includes("'") && !code.includes('"') && !code.includes('\n')) {
    return cdp('eval', code);
  }
  const tmpFile = path.join(os.tmpdir(), `cdp-eval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.js`);
  try {
    fs.writeFileSync(tmpFile, code, 'utf-8');
    const r = cdp('exec', tmpFile);
    if (r === '(empty)' || (r && !r.startsWith('['))) {
      const oneLine = code.replace(/\n\s*/g, ' ').trim();
      return cdp('eval', oneLine);
    }
    return r;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

// ---- 搜���提取 ----

function research() {
  const args = process.argv.slice(2);
  const reportFlag = args.includes('--report');
  const positional = args.filter(a => a !== '--report');

  const keyword = positional[0];
  const outputArg = positional[1];

  if (!keyword) {
    console.error(`
  用法: node ebay-research.js <关键词> [输出文件] [--report]
          node ebay-research.js <输入JSON> [输出HTML]

  示例:
    node ebay-research.js headlight
    node ebay-research.js headlight --report
    node ebay-research.js headlight items.json
    node ebay-research.js data.json
    `);
    process.exit(1);
  }

  const now = new Date();
  const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const outputFile = outputArg
    ? outputArg.replace(/\.json$/i, `-${ts}.json`)
    : `ebay-${keyword.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '-')}-${ts}.json`;

  const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(keyword)}&_ipg=240`;

  console.log(`搜索: ${keyword}`);
  cdp('goto', url);
  cdp('waitfor', 'ul.srp-results', '10000');

  const totalRaw = evalJS(`
Array.from(document.querySelectorAll('li.s-card[data-listingid]'))
  .filter(item => !item.dataset.listingid.startsWith('2500'))
  .length
  `.trim());
  const total = parseInt(totalRaw) || 0;
  if (total === 0) { console.log('未找到商品'); process.exit(0); }
  console.log(`共 ${total} 个商品，正在分批提取...`);

  const BATCH = 30;
  const allItems = [];
  for (let start = 0; start < total; start += BATCH) {
    const raw = evalJS(`
JSON.stringify(
  Array.from(document.querySelectorAll('li.s-card[data-listingid]'))
    .filter(item => !item.dataset.listingid.startsWith('2500'))
    .slice(${start}, ${start + BATCH})
    .map(item => {
      const rp = (item.querySelector('.s-card__price')?.textContent?.trim() || '');
      const ps = rp.replace(/[^0-9.,]/g, '').replace(/,/g, '');
      const cv = ((m => { if (!m) return ''; const cm = {'$':'USD','€':'EUR','£':'GBP','¥':'JPY'}; return cm[m[0]]||''; })(rp.match(/[$€£¥]/)));
      return {
        title: (item.querySelector('.s-card__title')?.textContent?.trim() || ''),
        price: rp,
        price_value: parseFloat(ps) || 0,
        currency: cv,
        link: (item.querySelector('a.s-card__link')?.href || '').split('?')[0],
        image: item.querySelector('img.s-card__image')?.src || '',
        shop: (item.querySelector('.s-card__attribute-row:first-child span:first-child')?.textContent?.trim() || '')
      };
    })
    .filter(i => i.title && i.price)
)
    `);
    if (raw && raw !== '(empty)') {
      try { const batch = JSON.parse(raw); allItems.push(...batch); } catch (_) {}
    }
    process.stdout.write('.');
  }
  console.log('');

  if (allItems.length === 0) { console.log('未提取到有效商品数据'); process.exit(0); }

  const jsonPath = path.resolve(outputFile);
  fs.writeFileSync(jsonPath, JSON.stringify(allItems, null, 2), 'utf-8');
  console.log(`COUNT: ${allItems.length}`);
  console.log(`FILE: ${jsonPath}`);

  if (reportFlag) {
    generateReport(jsonPath, keyword);
  }
}

// ---- 生成报表 ----

function generateReport(inputFile, keyword, outputFile) {
  if (!fs.existsSync(inputFile)) {
    console.error('错误: 文件不存在 - ' + inputFile);
    process.exit(1);
  }

  // research() 传参为 (file, keyword, outputFile)
  // CLI 直接调用传参为 (file, outputFile)
  if (outputFile === undefined && keyword && (keyword.endsWith('.html') || keyword.endsWith('.htm'))) {
    outputFile = keyword;
    keyword = '';
  }
  outputFile = outputFile || inputFile.replace(/\.json$/i, '-report.html');
  const title = keyword ? `eBay 商品【${keyword}】数据报告` : 'eBay 商品数据报告';

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
.header h1 { font-size: 28px; margin-bottom: 6px; }
.header p { color: #a0aec0; font-size: 14px; }
.container { max-width: 1400px; margin: 0 auto; padding: 20px; }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
.stat-card { background: #fff; border-radius: 12px; padding: 20px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.stat-card .num { font-size: 28px; font-weight: 700; color: #1a1a2e; }
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
.table-wrap { background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
thead { background: #f7fafc; }
th { padding: 12px 14px; text-align: left; font-weight: 600; color: #4a5568; cursor: pointer; user-select: none; white-space: nowrap; }
th:hover { color: #1a1a2e; }
th .arrow { margin-left: 4px; font-size: 11px; }
td { padding: 10px 14px; border-top: 1px solid #edf2f7; }
tr:hover { background: #f7fafc; }
.price { font-weight: 600; color: #2d3748; }
.shop-badge { display: inline-block; background: #ebf4ff; color: #2b6cb0; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
.title-col { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
  <p>共 <span id="headerCount">-</span> 件商品</p>
<\/div>
<div class="container">
  <div class="stats-grid" id="statsGrid"><\/div>
  <div class="charts-row">
    <div class="chart-box"><h3>\u{1F4CA} 价格分布<\/h3><canvas id="priceChart"><\/canvas><\/div>
    <div class="chart-box"><h3>\u{1F3EA} 热门店铺 Top 15<\/h3><canvas id="shopChart"><\/canvas><\/div>
  <\/div>
  <div class="charts-row">
    <div class="chart-box"><h3>\u{1F4B2} 套餐数量分布<\/h3><canvas id="qtyChart"><\/canvas><\/div>
    <div class="chart-box"><h3>\u{1F4C8} 价格 Top 20<\/h3><canvas id="topPriceChart"><\/canvas><\/div>
  <\/div>
  <div class="toolbar">
    <input type="text" id="searchInput" placeholder="搜索商品标题、店铺..." oninput="renderTable()">
    <select id="qtyFilter" onchange="renderTable()">
      <option value="">全部数量</option>
      <option value="1">单条</option>
      <option value="2">2条装</option>
      <option value="4">4条装</option>
    <\/select>
    <span class="info" id="tableInfo"><\/span>
  <\/div>
  <div class="table-wrap">
    <table id="dataTable">
      <thead>
        <tr>
          <th>图片</th>
          <th onclick="sortBy('title')">标题 <span class="arrow">\u25BE<\/span><\/th>
          <th onclick="sortBy('price_value')">价格 <span class="arrow">\u25BE<\/span><\/th>
          <th onclick="sortBy('shop')">店铺 <span class="arrow">\u25BE<\/span><\/th>
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
var sortField = 'price_value', sortDir = 'asc';

(function init() {
  data = RAW_DATA.map(function(d) {
    var qty = 1;
    var m = d.title.match(/^(Set of )?\\s*(\\d+)\\s+(New\\s+)?/);
    if (m) qty = parseInt(m[2]);
    else if (/^2\\s+Tires/i.test(d.title)) qty = 2;
    else if (/^4\\s+Tires/i.test(d.title) || /^4 New/i.test(d.title)) qty = 4;
    d.qty = qty; return d;
  });
  document.getElementById('headerCount').textContent = data.length;
  renderStats(); renderCharts(); renderTable();
})();
function getFiltered() {
  var q = document.getElementById('searchInput').value.toLowerCase();
  var qf = document.getElementById('qtyFilter').value;
  var arr = data.filter(function(d) {
    if (q && d.title.toLowerCase().indexOf(q) === -1 && d.shop.toLowerCase().indexOf(q) === -1) return false;
    if (qf && d.qty !== parseInt(qf)) return false;
    return true;
  });
  arr.sort(function(a, b) {
    var va = a[sortField], vb = b[sortField];
    if (typeof va === 'string') { va = va.toLowerCase(); vb = (vb+'').toLowerCase(); }
    return sortDir === 'asc' ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
  });
  return arr;
}
function renderTable() { filtered = getFiltered(); page = 1; applyPage(); }
function applyPage() {
  var start = (page-1)*pageSize, end = start+pageSize, pages = Math.ceil(filtered.length/pageSize);
  var slice = filtered.slice(start, end);
  var tb = document.getElementById('tableBody');
  var h = '';
  for (var i = 0; i < slice.length; i++) {
    var d = slice[i];
    var t = d.title.replace(/\\(Fits:.*?\\)/g,'').trim();
    h += '<tr>' +
      '<td><img class="img-thumb" src="' + d.image + '" alt="" loading="lazy" onerror="this.style.display=\\'none\\'"><\/td>' +
      '<td class="title-col"><a href="' + d.link + '" target="_blank">' + t + '<\/a><\/td>' +
      '<td class="price">' + d.price + '<\/td>' +
      '<td><span class="shop-badge">' + d.shop + '<\/span><\/td>' +
      '<td><a href="' + d.link + '" target="_blank" style="font-size:12px;color:#2b6cb0;">\u{1F517}<\/a><\/td>' +
      '<\/tr>';
  }
  tb.innerHTML = h;
  document.getElementById('tableInfo').textContent = filtered.length + ' / ' + data.length;
  var pg = document.getElementById('pagination');
  pg.innerHTML = '<button onclick="goPage(1)"' + (page<=1?' disabled':'') + '>首页<\/button>' +
    '<button onclick="goPage(' + (page-1) + ')"' + (page<=1?' disabled':'') + '>\u2039<\/button>' +
    '<span class="page-info">' + page + '/' + pages + '<\/span>' +
    '<button onclick="goPage(' + (page+1) + ')"' + (page>=pages?' disabled':'') + '>\u203A<\/button>' +
    '<button onclick="goPage(' + pages + ')"' + (page>=pages?' disabled':'') + '>末页<\/button>';
}
function goPage(p) { page = p; applyPage(); }
function sortBy(f) { if (sortField === f) sortDir = sortDir === 'asc' ? 'desc' : 'asc'; else { sortField = f; sortDir = 'asc'; } renderTable(); }
function renderStats() {
  var prices = data.filter(function(d){return d.price_value;}).map(function(d){return d.price_value;});
  var min = Math.min.apply(null, prices), max = Math.max.apply(null, prices);
  var avg = prices.reduce(function(a,b){return a+b;},0)/prices.length;
  var shops = {}; data.forEach(function(d){shops[d.shop]=1;});
  document.getElementById('statsGrid').innerHTML =
    '<div class="stat-card"><div class="num">' + data.length + '<\/div><div class="label">商品总数<\/div><\/div>' +
    '<div class="stat-card"><div class="num">$' + min.toFixed(0) + '<\/div><div class="label">最低价<\/div><\/div>' +
    '<div class="stat-card"><div class="num">$' + max.toFixed(0) + '<\/div><div class="label">最高价<\/div><\/div>' +
    '<div class="stat-card"><div class="num">$' + avg.toFixed(0) + '<\/div><div class="label">平均价<\/div><\/div>' +
    '<div class="stat-card"><div class="num">' + Object.keys(shops).length + '<\/div><div class="label">店铺数<\/div><\/div>' +
    '<div class="stat-card"><div class="num">' + prices.length + '<\/div><div class="label">含价格商品<\/div><\/div>';
}
function renderCharts() {
  var prices = data.filter(function(d){return d.price_value>0;}).map(function(d){return d.price_value;});
  var bins = [0,50,100,150,200,250,300,350,400,450,500,600,700,1000];
  var labels = ['$0-50','$50-100','$100-150','$150-200','$200-250','$250-300','$300-350','$350-400','$400-450','$450-500','$500-600','$600-700','$700+'];
  var counts = new Array(labels.length).fill(0);
  prices.forEach(function(p) {
    for (var i=0;i<bins.length-1;i++) { if (p>=bins[i] && p<bins[i+1]) { counts[i]++; return; } }
    counts[labels.length-1]++;
  });
  new Chart(document.getElementById('priceChart'), { type:'bar', data:{ labels:labels, datasets:[{ label:'商品数', data:counts, backgroundColor:'#4f8cf7', borderRadius:4 }] }, options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{display:false} } } });
  var shopCnt = {};
  data.forEach(function(d) { shopCnt[d.shop] = (shopCnt[d.shop]||0)+1; });
  var topShops = Object.entries(shopCnt).sort(function(a,b){return b[1]-a[1];}).slice(0,15);
  new Chart(document.getElementById('shopChart'), { type:'bar', data:{ labels:topShops.map(function(s){return s[0];}), datasets:[{ label:'商品数', data:topShops.map(function(s){return s[1];}), backgroundColor:'#48bb78', borderRadius:4 }] }, options:{ responsive:true, maintainAspectRatio:false, indexAxis:'y', plugins:{ legend:{display:false} } } });
  var qtyBuckets = { '单条':0, '2条装':0, '4条装':0, '其他':0 };
  data.forEach(function(d) { if (d.qty===1) qtyBuckets['单条']++; else if (d.qty===2) qtyBuckets['2条装']++; else if (d.qty===4) qtyBuckets['4条装']++; else qtyBuckets['其他']++; });
  new Chart(document.getElementById('qtyChart'), { type:'doughnut', data:{ labels:Object.keys(qtyBuckets), datasets:[{ data:Object.values(qtyBuckets), backgroundColor:['#4f8cf7','#48bb78','#f6ad55','#fc8181'] }] }, options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ position:'bottom'} } } });
  var sorted = [...data].filter(function(d){return d.price_value;}).sort(function(a,b){return b.price_value-a.price_value;});
  var top20 = sorted.slice(0,20).reverse();
  var tLabels = top20.map(function(d){ return d.title.replace(/\\(Fits:.*?\\)/g,'').trim().substring(0,30)+'...'; });
  new Chart(document.getElementById('topPriceChart'), { type:'bar', data:{ labels:tLabels, datasets:[{ label:'价格 ($)', data:top20.map(function(d){return d.price_value;}), backgroundColor:'#f6ad55', borderRadius:4 }] }, options:{ responsive:true, maintainAspectRatio:false, indexAxis:'y', plugins:{ legend:{display:false} } } });
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
  用法: node ebay-research.js <关键词> [输出文件] [--report]
          node ebay-research.js <输入JSON> [输出HTML]

  示例:
    node ebay-research.js headlight
    node ebay-research.js headlight --report
    node ebay-research.js headlight items.json
    node ebay-research.js data.json
  `);
  process.exit(1);
}

if (fs.existsSync(firstArg) && firstArg.endsWith('.json')) {
  // 已有 JSON 文件 → 生成报表
  generateReport(firstArg, process.argv[3]);
} else {
  // 关键词 → 搜索提取
  research();
}
