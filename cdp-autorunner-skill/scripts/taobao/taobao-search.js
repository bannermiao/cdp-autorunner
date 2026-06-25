#!/usr/bin/env node
/**
 * taobao-search.js — 淘宝商品搜索提取工具
 *
 * 用法:
 *   node taobao-search.js <关键词>             搜索并打印结果
 *   node taobao-search.js <关键词> <输出JSON>  搜索并将结果写入 JSON 文件
 *
 * 示例:
 *   node taobao-search.js "512G M2 NVMe 固态"
 *   node taobao-search.js "DDR5 内存 16G" results.json
 *
 * 注意: 需要已在 Chrome 中登录 taobao.com。
 *       纯 Node 标准库，零 npm 依赖。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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

// ---- 搜索提取函数 ----

/**
 * 在淘宝搜索商品并提取结果
 * @param {string} keyword - 搜索关键词
 * @returns {Array<{title:string, price:string, sales:string, shop:string, note:string}>}
 */
function searchTaobao(keyword) {
  var url = 'https://s.taobao.com/search?q=' + encodeURIComponent(keyword);
  cdp('goto', url);
  cdp('wait', '4000');

  // 提取商品列表 + 容量判断
  var code = [
    '(function(){',
    'var cards=document.querySelectorAll("[class*=\\"doubleCardWrapperAdapt\\"]");',
    'var items=[];',
    'Array.from(cards).slice(0,20).forEach(function(w){',
    'var txt=w.textContent.trim();',
    // 标题
    'var tEl=w.querySelector("[class*=\\"title\\"],[class*=\\"Title\\"]");',
    'var title=tEl?tEl.textContent.trim():"";',
    'if(!title){var end=txt.search(/\\u00a5\\d/);title=end>0?txt.substring(0,end).trim():txt.substring(0,50);}',
    // 价格：取 ¥ 后 2-4 位数字
    'var pM=txt.match(/\\u00a5(\\d{2,4})(?=\\+|\\u4f18\\u60e0|$)/);',
    'var price=pM?pM[1]:"";',
    // 销量
    'var sM=txt.match(/(\\d{1,5})\\+?\\u4eba\\u4ed8\\u6b3e/);',
    'var sales=sM?sM[1]:"0";',
    // 店铺
    'var sEl=w.querySelector("[class*=\\"shop\\"],[class*=\\"Shop\\"]");',
    'var shop=sEl?sEl.textContent.trim():"";',
    // 容量判断：检测标题/文本中的容量关键词
    'var has256=/256/.test(txt);',
    'var has512=/512/.test(txt);',
    'var has1T=/1T|1TB|1000|1024/.test(txt);',
    'var note="";',
    'if(has256&&has512){note="\\u8d77\\u4ef7\\uff08\\u53ef\\u80fd\\u662f256G\\u4ef7\\uff09";}',
    'else if(has256&&!has512){note="\\u53ef\\u80fd\\u662f256G\\u4ef7";}',
    'if(price&&title){items.push({title:title.replace(/\\s+/g," ").substring(0,50),price:price,sales:sales,shop:shop,note:note});}',
    '});',
    // 去重
    'var seen={},unique=[];',
    'items.forEach(function(it){var k=it.title.substring(0,15);if(!seen[k]){seen[k]=true;unique.push(it);}});',
    'return JSON.stringify(unique.slice(0,12));',
    '})()'
  ].join('');

  var raw = cdp('eval', code);
  try { return JSON.parse(raw); } catch (_) { return []; }
}

// ---- 结果显示 ----

function printResults(items) {
  if (items.length === 0) {
    console.log('未找到结果');
    return;
  }
  console.log('共 ' + items.length + ' 件商品\n');
  console.log('注: 淘宝搜索页默认展示最低SKU价格（起价）。');
  console.log('    若商品有多个容量规格，标注"起价"的价格可能不是目标容量实价。\n');
  items.forEach(function(item, i) {
    var idx = (i + 1).toString().padStart(2, ' ');
    var shopInfo = item.shop ? ' [' + item.shop + ']' : '';
    var noteInfo = item.note ? ' ⚠' + item.note : '';
    console.log('  ' + idx + '. ¥' + item.price + '  ' + item.title + noteInfo + shopInfo);
    console.log('     销量: ' + item.sales + '+');
  });
  console.log('\n💡 提示: 标注"起价"的条目，实际 512G 价格会更高。');
  console.log('   可点进商品详情页查看完整 SKU 价格表。');
}

// ---- 主入口 ----

function main() {
  var args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('用法: node taobao-search.js <关键词> [输出JSON]');
    process.exit(1);
  }

  var keyword = args[0];
  var outFile = args[1] || null;

  console.log('搜索: ' + keyword);
  console.log('');

  try {
    var items = searchTaobao(keyword);
    printResults(items);

    if (outFile) {
      fs.writeFileSync(outFile, JSON.stringify(items, null, 2), 'utf-8');
      console.log('\n已写入: ' + outFile);
    }
  } catch (err) {
    console.error('搜索失败:', err.message);
    process.exit(1);
  }
}

main();
