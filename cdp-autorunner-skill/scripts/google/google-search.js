#!/usr/bin/env node
/**
 * google-search.js — Google 搜索提取工具
 *
 * 用法:
 *   node google-search.js <关键词>             搜索并打印结果
 *   node google-search.js <关键词> <输出JSON>  搜索并将结果写入 JSON 文件
 *
 * 示例:
 *   node google-search.js "什么是CDP"
 *   node google-search.js "headlight" results.json
 *
 * 纯 Node 标准库，零 npm 依赖。
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

function cdpJSON(...args) {
  const raw = cdp(...args);
  try { return JSON.parse(raw); } catch (_) { return []; }
}

// ---- 核心搜索函数 ----

/**
 * 搜索 Google 并提取结果标题
 * @param {string} keyword - 搜索关键词
 * @returns {Array<{title:string}>} 结果列表
 */
function googleSearch(keyword) {
  // 打开 Google
  cdp('goto', 'https://www.google.com');

  // 输入关键词
  cdp('fill', 'textarea[name="q"]', keyword);

  // 提交搜索（form.submit 比 key Enter 更可靠）
  cdp('wait', '500');
  cdp('eval', 'document.querySelector(\'textarea\').closest(\'form\').submit()');

  // 轮询 URL 直到跳转到搜索结果页
  for (let i = 0; i < 20; i++) {
    const url = cdp('eval', 'location.href');
    if (url.includes('/search')) break;
    cdp('wait', '500');
  }

  // 等待渲染
  cdp('wait', '1500');

  // 提取结果标题
  const titles = cdpJSON('css', 'h3');
  return titles.slice(0, 10).map(t => ({ title: t }));
}

// ---- 结果显示 ----

function printResults(items) {
  if (items.length === 0) {
    console.log('未找到结果');
    return;
  }
  items.forEach((item, i) => {
    console.log(`  [${i + 1}] ${item.title}`);
  });
}

// ---- 主入口 ----

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('用法: node google-search.js <关键词> [输出JSON]');
    process.exit(1);
  }

  const keyword = args[0];
  const outFile = args[1] || null;

  console.log(`搜索: ${keyword}`);
  console.log('');

  try {
    const results = googleSearch(keyword);
    printResults(results);

    if (outFile) {
      fs.writeFileSync(outFile, JSON.stringify(results, null, 2), 'utf-8');
      console.log(`\n已写入: ${outFile}`);
    }
  } catch (err) {
    console.error('搜索失败:', err.message);
    process.exit(1);
  }
}

main();
