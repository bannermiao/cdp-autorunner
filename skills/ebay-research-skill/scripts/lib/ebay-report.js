'use strict';
/**
 * ebay-report.js — 自包含 HTML 报表生成（Chart.js 走 CDN，数据内联）
 *
 * 内联数据一律把 < 转成 \\u003c，行渲染一律过 esc()，
 * 否则商品标题里的 </script> 会截断脚本、把站点内容当代码执行。
 */

const fs = require('fs');

const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderReport(inputFile, keyword, outputFile) {
  if (!fs.existsSync(inputFile)) throw new Error('文件不存在 - ' + inputFile);
  if (outputFile === undefined && keyword && /\.(html?)$/i.test(keyword)) {
    outputFile = keyword;
    keyword = '';
  }
  outputFile = outputFile || inputFile.replace(/\.json$/i, '.html');
  const title = escapeHtml(keyword ? `eBay 商品【${keyword}】深度调研报告` : 'eBay 商品深度调研报告');

  const rawJson = JSON.stringify(JSON.parse(fs.readFileSync(inputFile, 'utf8'))).replace(/</g, '\\u003c');

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
.stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px; }
@media (max-width: 900px) { .stats-grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 520px) { .stats-grid { grid-template-columns: 1fr; } }
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
th { padding: 12px 14px; text-align: center; font-weight: 600; color: #4a5568; cursor: pointer; user-select: none; white-space: nowrap; }
th:hover { color: #1a1a2e; }
th .arrow { margin-left: 4px; font-size: 11px; }
td { padding: 10px 14px; border-top: 1px solid #edf2f7; white-space: nowrap; text-align: center; }
tr:hover { background: #f7fafc; }
.price { font-weight: 600; color: #2d3748; }
.seller-badge { display: inline-block; background: #e6fffa; color: #285e61; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
.title-col { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
th.num, td.num { font-variant-numeric: tabular-nums; }
th.num, td.num { font-variant-numeric: tabular-nums; }
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
  <h1>${title}<\/h1>
  <p>共 <span id="headerCount">-<\/span> 件商品 · 数据采集于 eBay 实时页面 · <span id="basisNote">计价基准读取中…<\/span><\/p>
<\/div>
<div class="container">
  <div class="stats-grid" id="statsGrid"><\/div>
  <div class="charts-row">
    <div class="chart-box"><h3>价格分布<\/h3><canvas id="priceChart"><\/canvas><\/div>
    <div class="chart-box"><h3>热门卖家 Top 15<\/h3><canvas id="shopChart"><\/canvas><\/div>
  <\/div>
  <div class="charts-row">
    <div class="chart-box"><h3>30天销量 Top 20<\/h3><canvas id="soldChart"><\/canvas><\/div>
    <div class="chart-box"><h3>30天均价分布<\/h3><canvas id="avgPriceChart"><\/canvas><\/div>
  <\/div>
  <div class="toolbar">
    <input type="text" id="searchInput" placeholder="搜索标题、卖家、店铺..." oninput="renderTable()">
    <select id="soldFilter" onchange="renderTable()">
      <option value="">全部<\/option>
      <option value="has">有90天销量<\/option>
      <option value="none">无90天销量<\/option>
    <\/select>
    <span class="info" id="tableInfo"><\/span>
  <\/div>
  <div class="table-wrap">
    <table id="dataTable">
      <thead>
        <tr>
          <th>图片<\/th>
          <th onclick="sortBy('title')">标题 <span class="arrow">▾<\/span><\/th>
          <th class="num" onclick="sortBy('sale_price')">价格 <span class="arrow">▾<\/span><\/th>
          <th class="num" onclick="sortBy('sale_price_usd')">折USD <span class="arrow">▾<\/span><\/th>
          <th onclick="sortBy('seller_name')">卖家 <span class="arrow">▾<\/span><\/th>
          <th class="num" onclick="sortBy('positive_rate')">好评率 <span class="arrow">▾<\/span><\/th>
          <th class="num" onclick="sortBy('sold_7days')">7天销量 <span class="arrow">▾<\/span><\/th>
          <th class="num" onclick="sortBy('sold_30days')">30天销量 <span class="arrow">▾<\/span><\/th>
          <th class="num" onclick="sortBy('sold_90days')">90天销量 <span class="arrow">▾<\/span><\/th>
          <th class="num" onclick="sortBy('avg_price_30days')">30天均价 <span class="arrow">▾<\/span><\/th>
          <th class="num" onclick="sortBy('min_price_30days')">30天最低 <span class="arrow">▾<\/span><\/th>
          <th class="num" onclick="sortBy('max_price_30days')">30天最高 <span class="arrow">▾<\/span><\/th>
          <th class="num" onclick="sortBy('sold')">总销量 <span class="arrow">▾<\/span><\/th>
          <th>链接<\/th>
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
var sortField = 'sold_30days', sortDir = 'desc';
var BASIS = 'USD';   // 金额口径：取到汇率=USD，没取到=页面原币种
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function money(v){ if(!v) return '-'; return (BASIS==='USD'?'$ ':'')+Number(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function px(d){ return BASIS==='USD' ? (d.sale_price_usd||0) : (d.sale_price||0); }
// 价格拆两列：源币种原价 + 折算 USD（没取到汇率时折USD列留空，不假装是美元）
function srcPrice(d){ return d.sale_price ? esc((d.currency||'') + ' ' + d.sale_price.toFixed(2)) : '-'; }
function usdPrice(d){ return d.sale_price_usd ? esc('$' + d.sale_price_usd.toFixed(2)) : '-'; }

(function init() {
  BASIS = RAW_DATA.some(function(d){ return d.price_basis === 'SOURCE'; }) ? 'SOURCE' : 'USD';
  data = RAW_DATA.map(function(d){
    d.sale_price = parseFloat(d.sale_price) || 0;
    d.sale_price_usd = parseFloat(d.sale_price_usd) || 0;
    d.sold = parseInt(d.sold) || 0;
    d.compatible_vehicles = parseInt(d.compatible_vehicles) || 0;
    d.positive_rate = parseFloat(d.positive_rate) || 0;
    d.sold_7days = parseInt(d.sold_7days) || 0;
    d.sold_30days = parseInt(d.sold_30days) || 0;
    d.sold_90days = parseInt(d.sold_90days) || 0;
    d.avg_price_90days = parseFloat(d.avg_price_90days) || 0;
    d.min_price_90days = parseFloat(d.min_price_90days) || 0;
    d.max_price_90days = parseFloat(d.max_price_90days) || 0;
    d.avg_price_30days = parseFloat(d.avg_price_30days) || 0;
    d.min_price_30days = parseFloat(d.min_price_30days) || 0;
    d.max_price_30days = parseFloat(d.max_price_30days) || 0;
    d.gmv_90days = parseFloat(d.gmv_90days) || 0;
    d.special_qty_90days = parseInt(d.special_qty_90days) || 0;
    return d;
  });
  document.getElementById('headerCount').textContent = data.length;
  // 命中关键词只留在 JSON/Excel 里，报表不展示
  var fxDate = RAW_DATA.map(function(d){ return d.fx_date; }).filter(Boolean)[0];
  document.getElementById('basisNote').textContent = BASIS === 'USD'
    ? ('金额已统一换算为 USD' + (fxDate ? '（汇率日期 ' + fxDate + '）' : ''))
    : '未取到汇率，金额按页面原币种统计';
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
  var start=(page-1)*pageSize, end=start+pageSize, pages=Math.ceil(filtered.length/pageSize)||1;
  var slice=filtered.slice(start,end);
  var h='';
  for (var i=0;i<slice.length;i++){
    var d=slice[i];
    var link=esc(d.url||d.link||'');
    var t=esc((d.title||'').substring(0,80));
    h+='<tr>'+
      '<td><img class="img-thumb" src="'+esc(d.image)+'" alt="" loading="lazy" onerror="this.style.display=\\'none\\'"><\/td>'+
      '<td class="title-col"><a href="'+link+'" target="_blank" rel="noopener noreferrer">'+(t||'(未取到标题)')+'<\/a><\/td>'+
      '<td class="price num">'+srcPrice(d)+'<\/td>'+
      '<td class="price num">'+usdPrice(d)+'<\/td>'+
      '<td><span class="seller-badge">'+esc(d.seller_name||'-')+'<\/span><\/td>'+
      '<td class="num">'+(d.positive_rate?d.positive_rate.toFixed(1)+'%':'-')+'<\/td>'+
      '<td class="num">'+(d.sold_7days?d.sold_7days.toLocaleString():'-')+'<\/td>'+
      '<td class="num">'+(d.sold_30days?d.sold_30days.toLocaleString():'-')+'<\/td>'+
      '<td class="num">'+(d.sold_90days?d.sold_90days.toLocaleString():'-')+'<\/td>'+
      '<td class="num">'+money(d.avg_price_30days)+'<\/td>'+
      '<td class="num">'+money(d.min_price_30days)+'<\/td>'+
      '<td class="num">'+money(d.max_price_30days)+'<\/td>'+
      '<td class="num">'+(d.sold?d.sold.toLocaleString():'-')+'<\/td>'+
      '<td><a href="'+link+'" target="_blank" rel="noopener noreferrer" style="font-size:12px;color:#2b6cb0;">链接<\/a><\/td>'+
      '<\/tr>';
  }
  document.getElementById('tableBody').innerHTML=h||'<tr><td colspan="14">无数据<\/td><\/tr>';
  document.getElementById('tableInfo').textContent=filtered.length+' / '+data.length;
  document.getElementById('pagination').innerHTML='<button onclick="goPage(1)"'+(page<=1?' disabled':'')+'>首页<\/button>'+
    '<button onclick="goPage('+(page-1)+')"'+(page<=1?' disabled':'')+'>‹<\/button>'+
    '<span class="page-info">'+page+'/'+pages+'</span>'+
    '<button onclick="goPage('+(page+1)+')"'+(page>=pages?' disabled':'')+'>›<\/button>'+
    '<button onclick="goPage('+pages+')"'+(page>=pages?' disabled':'')+'>末页<\/button>';
}
function goPage(p){ page=p; applyPage(); }
function sortBy(f){ if(sortField===f) sortDir=sortDir==='asc'?'desc':'asc'; else {sortField=f; sortDir='asc';} renderTable(); }
function renderStats(){
  var prices=data.map(px).filter(function(v){return v>0;});
  var min=Math.min.apply(null,prices), max=Math.max.apply(null,prices);
  var avg=prices.length?prices.reduce(function(a,b){return a+b;},0)/prices.length:NaN;
  var totalSold7=data.reduce(function(a,d){return a+d.sold_7days;},0);
  var totalSold30=data.reduce(function(a,d){return a+d.sold_30days;},0);
  var totalSold90=data.reduce(function(a,d){return a+d.sold_90days;},0);
  var totalSoldAll=data.reduce(function(a,d){return a+d.sold;},0);
  var cur=BASIS==='USD'?'$':(data.map(function(d){return d.sales_currency||d.currency;}).filter(Boolean)[0]||'');
  document.getElementById('statsGrid').innerHTML=
    '<div class="stat-card"><div class="num">'+data.length+'<\/div><div class="label">商品总数<\/div><\/div>'+
    '<div class="stat-card"><div class="num">'+cur+(isFinite(min)?min.toFixed(0):'-')+'<\/div><div class="label">最低价<\/div><\/div>'+
    '<div class="stat-card"><div class="num">'+cur+(isFinite(max)?max.toFixed(0):'-')+'<\/div><div class="label">最高价<\/div><\/div>'+
    '<div class="stat-card"><div class="num">'+cur+(isFinite(avg)?avg.toFixed(0):'-')+'<\/div><div class="label">平均价<\/div><\/div>'+
    '<div class="stat-card"><div class="num">'+totalSold7.toLocaleString()+'<\/div><div class="label">近7天销量<\/div><\/div>'+
    '<div class="stat-card"><div class="num">'+totalSold30.toLocaleString()+'<\/div><div class="label">近30天销量<\/div><\/div>'+
    '<div class="stat-card"><div class="num">'+totalSold90.toLocaleString()+'<\/div><div class="label">近90天销量<\/div><\/div>'+
    '<div class="stat-card"><div class="num">'+totalSoldAll.toLocaleString()+'<\/div><div class="label">总销量<\/div><\/div>';
}
function renderCharts(){
  var prices=data.map(px).filter(function(v){return v>0;});
  var bins=[0,50,100,150,200,250,300,350,400,450,500,600,700,1000];
  var labels=['$0-50','$50-100','$100-150','$150-200','$200-250','$250-300','$300-350','$350-400','$400-450','$450-500','$500-600','$600-700','$700+'];
  var counts=new Array(labels.length).fill(0);
  prices.forEach(function(p){ for(var i=0;i<bins.length-1;i++){ if(p>=bins[i]&&p<bins[i+1]){counts[i]++;return;} } counts[labels.length-1]++; });
  new Chart(document.getElementById('priceChart'),{type:'bar',data:{labels:labels,datasets:[{label:'商品数',data:counts,backgroundColor:'#4f8cf7',borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}}}});
  var sellerCnt={}; data.forEach(function(d){ if(d.seller_name) sellerCnt[d.seller_name]=(sellerCnt[d.seller_name]||0)+1; });
  var topSellers=Object.entries(sellerCnt).sort(function(a,b){return b[1]-a[1];}).slice(0,15);
  new Chart(document.getElementById('shopChart'),{type:'bar',data:{labels:topSellers.map(function(s){return s[0];}),datasets:[{label:'商品数',data:topSellers.map(function(s){return s[1];}),backgroundColor:'#48bb78',borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{display:false}}}});
  var sorted=data.filter(function(d){return d.sold_30days>0;}).sort(function(a,b){return b.sold_30days-a.sold_30days;});
  var top20=sorted.slice(0,20).reverse();
  var sLabels=top20.map(function(d){return (d.title||'').substring(0,30)+' ('+d.sold_30days+')';});
  new Chart(document.getElementById('soldChart'),{type:'bar',data:{labels:sLabels,datasets:[{label:'30天销量(件)',data:top20.map(function(d){return d.sold_30days;}),backgroundColor:'#f6ad55',borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{display:false}}}});
  var avgPrices=data.filter(function(d){return d.avg_price_30days>0;}).map(function(d){return d.avg_price_30days;});
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
  return { outputFile, bytes: fs.statSync(outputFile).size };
}

module.exports = { renderReport };
