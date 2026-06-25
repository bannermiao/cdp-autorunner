#!/usr/bin/env node
/**
 * deepseek-balance.js — DeepSeek 账户余额查询工具
 *
 * 用法:
 *   node deepseek-balance.js                  查询并打印余额
 *   node deepseek-balance.js <输出JSON>        查询并将结果写入 JSON 文件
 *
 * 示例:
 *   node deepseek-balance.js
 *   node deepseek-balance.js balance.json
 *
 * 注意: 需要已在 Chrome 中登录 platform.deepseek.com。
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

function cdpJSON(...args) {
  const raw = cdp(...args);
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// ---- 余额查询函数 ----

/**
 * 查询 DeepSeek 账户余额和当月消费
 * @returns {{ balance: string, consumption: string }}
 *   balance:     账户余额（如 "¥19.60"）
 *   consumption: 当月消费（如 "¥125.92"）
 */
function queryBalance() {
  // 导航到用量页面
  cdp('goto', 'https://platform.deepseek.com/usage');

  // 等待页面渲染（SPA 可能需要短暂等待）
  cdp('wait', '2000');

  // 提取余额卡片数据
  var code = [
    '(function(){',
    'var cards=document.querySelectorAll(".a0cde8c1");',
    'var r={};',
    'if(cards[0]){var m=cards[0].textContent.match(/\\u00a5([\\d,.]+)/);r.balance=m?"\\u00a5"+m[1]:cards[0].textContent.trim();}',
    'if(cards[1]){var m=cards[1].textContent.match(/\\u00a5([\\d,.]+)/);r.consumption=m?"\\u00a5"+m[1]:cards[1].textContent.trim();}',
    'return JSON.stringify(r);',
    '})()'
  ].join('');

  var raw = cdp('eval', code);

  try {
    return JSON.parse(raw);
  } catch (_) {
    // 回退：直接取文本
    var cards = cdpJSON('css', '.a0cde8c1');
    if (cards && cards.length >= 2) {
      return {
        balance: cards[0],
        consumption: cards[1]
      };
    }
    return { balance: '未获取到', consumption: '未获取到' };
  }
}

// ---- 结果显示 ----

function printResult(data) {
  console.log('DeepSeek 账户余额');
  console.log('');
  console.log('  充值余额:  ' + (data.balance || '未知'));
  console.log('  当月消费:  ' + (data.consumption || '未知'));
}

// ---- 主入口 ----

function main() {
  const args = process.argv.slice(2);
  const outFile = args[0] || null;

  console.log('查询 DeepSeek 账户余额...');
  console.log('');

  try {
    const data = queryBalance();
    printResult(data);

    if (outFile) {
      fs.writeFileSync(outFile, JSON.stringify(data, null, 2), 'utf-8');
      console.log('\n已写入: ' + outFile);
    }
  } catch (err) {
    console.error('查询失败:', err.message);
    process.exit(1);
  }
}

main();
