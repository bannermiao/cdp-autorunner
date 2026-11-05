'use strict';
/**
 * cdp-client.js — cdp-server CLI 调用层（主脚本与 Worker 共用）
 *
 * 约定：二进制放在 <skill>/scripts/cdp-server(.exe)，即本目录的上一级。
 * 找不到时回退到 PATH 上的 cdp-server。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN_NAME = process.platform === 'win32' ? 'cdp-server.exe' : 'cdp-server';

function resolveCdpBin() {
  const local = path.join(__dirname, '..', BIN_NAME);
  if (fs.existsSync(local)) return local;
  return BIN_NAME;
}

const CDP_BIN = resolveCdpBin();

// 包装器超时。注意这里有两层：cdp-server CLI 自己也带一层（见 references/cdp-cli.md 的超时表），
// 包装器必须不短于 CLI，否则一个 CLI 还在等的命令会被我们提前 kill 掉、误报成超时。
// waitfor 取「传入超时 + 5s」，因为正常 TIMEOUT 也要能原样返回而不被判成失败。
function cdpTimeout(args) {
  const cmd = args[0];
  if (cmd === 'waitfor' || cmd === 'waitfor-target') {
    const t = parseInt(args[args.length - 1], 10);
    return (isNaN(t) ? 8000 : t) + 5000;
  }
  if (cmd === 'new-tab' || cmd === 'close-tab' || cmd === 'switch-tab') return 20000;   // CLI 侧 15s
  if (cmd === 'scroll' || cmd === 'hover') return 10000;                                 // CLI 侧 5s
  if (['click', 'fill', 'select', 'text', 'html', 'attr', 'count', 'css', 'screenshot', 'reload'].includes(cmd)) return 15000;  // CLI 侧 10s
  return 35000;   // eval · exec · goto · goto-target · eval-target · wait-response（CLI 侧 30s）
}

function cdp(...args) {
  const timeoutMs = cdpTimeout(args);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(CDP_BIN, ['browser', ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
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
    child.on('error', e => { clearTimeout(timer); finish(reject, e); });
    child.on('close', code => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (ms > 5000) console.log(`[cdp:slow] ${args[0]} ${ms}ms`);
      if (code !== 0) finish(reject, new Error(stderr.trim() || `cdp ${args[0]} exit ${code}`));
      else finish(resolve, stdout.trim());
    });
  });
}

// 只压掉「整行注释」和换行。不能按 // 全局删注释：那会把字符串里的 https:// 一起砍掉。
function flatten(code) {
  return code
    .split(/\r?\n/)
    .filter(line => !/^\s*\/\//.test(line))
    .join(' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// 无专属 target 时使用：exec 临时文件优先（保留原始多行代码），失败回退单行 eval。
async function evalOnActiveTab(code) {
  const tmpFile = path.join(os.tmpdir(), `cdp-eval-${process.pid}-${Date.now()}.js`);
  try {
    fs.writeFileSync(tmpFile, code, 'utf-8');
    const r = await cdp('exec', tmpFile);
    if (r && r !== '(empty)') return r;
  } catch (_) {
    // 落到 eval 回退
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
  return cdp('eval', flatten(code));
}

// 有专属 target 时 eval-target 支持多行代码，直接传源码。
function evalOnTarget(targetId, code) {
  return cdp('eval-target', targetId, code);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { CDP_BIN, cdp, cdpTimeout, evalOnActiveTab, evalOnTarget, flatten, sleep };
