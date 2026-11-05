#!/usr/bin/env node
/**
 * open.mjs — 启动选题库（一条命令，不用记端口）
 *
 * 用法:
 *   node open.mjs                 探测 → 已有服务则直接打开，没有就起一个
 *   node open.mjs --port 8791     指定端口
 *   node open.mjs --stop          停掉正在跑的面板
 *   node open.mjs --no-open       只起服务，不开浏览器
 *
 * 探测范围 8790–8799：命中即复用，避免重复起一堆进程。
 * 起服务时前台运行（Ctrl+C 结束），日志直接打在这个终端。
 */

import { spawn, exec } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANAGE = join(HERE, 'manage.mjs');

const argv = process.argv.slice(2);
const noOpen = argv.includes('--no-open');
const stop = argv.includes('--stop');
const portIdx = argv.indexOf('--port');
const wantPort = portIdx >= 0 ? Number(argv[portIdx + 1]) : null;

const RANGE = wantPort ? [wantPort] : [8790, 8791, 8792, 8793, 8794, 8795, 8796, 8797, 8798, 8799];

function openBrowser(url) {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

/** 探一个端口是不是我们的面板（打 /api/topics，看返回结构） */
function probe(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const req = fetch(`http://127.0.0.1:${port}/api/topics`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    req
      .then(async (res) => {
        if (!res.ok) return resolve(false);
        const j = await res.json().catch(() => null);
        resolve(!!j && Array.isArray(j.选题));
      })
      .catch(() => resolve(false));
  });
}

async function findRunning() {
  for (const port of RANGE) {
    if (await probe(port)) return port;
  }
  return null;
}

/** --stop：按 pid 文件结束在跑的面板 */
async function doStop() {
  const pidFile = join(homedir(), '.douyin-viral-blueprint', 'panel.pid');
  const port = await findRunning();

  if (!existsSync(pidFile)) {
    console.log(port ? `面板在 ${port} 跑着，但没有 pid 文件（可能是旧版本起的）—— 去那个终端按 Ctrl+C` : '没有在跑的选题库面板');
    return;
  }

  const pid = Number(String(readFileSync(pidFile, 'utf8')).trim());
  if (!Number.isFinite(pid) || pid <= 0) {
    rmSync(pidFile, { force: true });
    console.log('pid 文件内容无效，已清理');
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
    console.log(`已停止面板（PID ${pid}${port ? `，端口 ${port}` : ''}）`);
  } catch (e) {
    console.log(`进程 ${pid} 已经不在了（${e.code ?? e.message}）`);
  }
  rmSync(pidFile, { force: true });
}

async function main() {
  if (stop) return doStop();

  const running = await findRunning();
  if (running) {
    const url = `http://127.0.0.1:${running}`;
    console.log(`选题库已在运行：${url}`);
    if (!noOpen) openBrowser(url);
    return;
  }

  // 没在跑 → 起一个，前台运行
  const port = wantPort ?? 8790;
  console.log(`启动选题库面板（端口 ${port}）…`);
  const child = spawn(process.execPath, [MANAGE, '--port', String(port), '--no-open'], {
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));

  if (!noOpen) {
    // 等端口起来再开浏览器
    for (let i = 0; i < 40; i++) {
      if (await probe(port, 300)) {
        openBrowser(`http://127.0.0.1:${port}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    console.error('服务没起来，看上面的报错');
  }
}

main().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
