#!/usr/bin/env node
/**
 * taobao-cart.js — 淘宝购物车商品提取工具
 *
 * 用法:
 *   node taobao-cart.js                   列出购物车商品
 *   node taobao-cart.js <输出JSON>         保存为 JSON 文件
 *
 * 示例:
 *   node taobao-cart.js
 *   node taobao-cart.js cart-items.json
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

// ---- 购物车提取函数 ----

/**
 * 提取淘宝购物车所有商品
 * @returns {Array<{shop:string, title:string, price:string, qty:string}>}
 */
function getCartItems() {
  // 导航到购物车
  cdp('goto', 'https://cart.taobao.com/cart.htm');
  cdp('wait', '3000');

  // 执行 JS 提取数据，用稳定 class 前缀
  var code = [
    '(function(){',
    'var shops=document.querySelectorAll("[class*=\\"trade-cart-shop-container\\"]");',
    'var r=[];',
    'Array.from(shops).forEach(function(shop){',
    'var nameEl=shop.querySelector("[class*=\\"cartShopName\\"]");',
    'var shopName=nameEl?nameEl.textContent.trim():"";',
    'var items=shop.querySelectorAll("[class*=\\"trade-cart-item-info\\"]");',
    'Array.from(items).forEach(function(item){',
    'var titleEl=item.querySelector("[class*=\\"cartDetail\\"]");',
    'var title=titleEl?titleEl.textContent.trim().substring(0,120):"";',
    // 取第一个 trade-price-integer 为实际价格
    'var priceEls=item.querySelectorAll(".trade-price-integer");',
    'var price="";',
    'if(priceEls.length>0)price="\\u00a5"+priceEls[0].textContent.trim();',
    // 数量
    'var qtyEl=item.querySelector("[class*=\\"quantityNumWrapper\\"]");',
    'var qty=qtyEl?qtyEl.textContent.trim():"1";',
    // SKU 规格
    'var skuEls=item.querySelectorAll("[class*=\\"cartSku\\"],[class*=\\"sku\\"]");',
    'var sku="";',
    'for(var i=0;i<skuEls.length;i++){var s=skuEls[i].textContent.trim();if(s&&s!="重新选择规格"&&s!="款式缺货"){sku=s;break;}}',
    'r.push({shop:shopName,title:title,price:price,qty:qty,sku:sku});',
    '});',
    '});',
    'return JSON.stringify({total:r.length,items:r});',
    '})()'
  ].join('');

  var raw = cdp('eval', code);
  try {
    var parsed = JSON.parse(raw);
    return parsed.items || [];
  } catch (_) {
    return [];
  }
}

// ---- 结果显示 ----

function printItems(items) {
  if (items.length === 0) {
    console.log('购物车为空或获取失败');
    return;
  }

  console.log('共 ' + items.length + ' 件商品\n');

  var currentShop = '';
  items.forEach(function(item, i) {
    if (item.shop !== currentShop) {
      currentShop = item.shop;
      console.log('--- ' + currentShop + ' ---');
    }
    var skuInfo = item.sku ? ' (' + item.sku + ')' : '';
    console.log('  [' + (i + 1) + '] ' + item.title + skuInfo);
    console.log('      ' + item.price + ' x' + item.qty);
  });

  // 总计
  var total = 0;
  items.forEach(function(item) {
    var num = parseFloat(item.price.replace(/[^0-9.]/g, ''));
    if (!isNaN(num)) total += num * parseInt(item.qty || '1');
  });
  console.log('\n合计: ¥' + total.toFixed(2));
}

// ---- 主入口 ----

function main() {
  var args = process.argv.slice(2);
  var outFile = args[0] || null;

  console.log('读取淘宝购物车...');
  console.log('');

  try {
    var items = getCartItems();
    printItems(items);

    if (outFile) {
      fs.writeFileSync(outFile, JSON.stringify(items, null, 2), 'utf-8');
      console.log('\n已写入: ' + outFile);
    }
  } catch (err) {
    console.error('获取失败:', err.message);
    process.exit(1);
  }
}

main();
