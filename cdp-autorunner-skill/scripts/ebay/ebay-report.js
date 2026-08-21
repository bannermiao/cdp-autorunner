#!/usr/bin/env node
/**
 * ebay-report.js — eBay 商品调研：可视化报表生成（独立版）
 *
 * 基于 ebay-research.js 的 generateReport 函数独立拆分而来，改动点：
 *   - 产品列表中「卖家」与「好评率」拆分为独立两列（原为同一单元格上下排列）
 *   - 好评率列支持点击排序
 *
 * 用法:
 *   node ebay-report.js <输入JSON> [输出HTML]
 *
 * 示例:
 *   node ebay-report.js data.json
 *   node ebay-report.js data.json report.html
 *
 * 依赖: 仅 Node 标准库；图表库 Chart.js 走 CDN。
 */

const fs = require('fs');

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
.rate-badge { color: #2f855a; font-weight: 600; }
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
      '<td>'+(d.positive_rate?('<span class="rate-badge">'+(d.positive_rate).toFixed(1)+'%<\/span>'):'-')+'<\/td>'+
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

const args = process.argv.slice(2);
if (!args.length || !args[0].endsWith('.json')) {
  console.error(`
  用法: node ebay-report.js <输入JSON> [输出HTML]

  示例:
    node ebay-report.js data.json
    node ebay-report.js data.json report.html
  `);
  process.exit(1);
}

generateReport(args[0], '', args[1]);
