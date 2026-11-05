#!/usr/bin/env node
/**
 * open.mjs — 打开采集面板（一条命令，不用记端口）
 *
 * 用法:
 *   node open.mjs                探测 → 已在跑就直接打开，没跑就起一个
 *   node open.mjs --port 8801    指定端口
 *   node open.mjs --stop         停掉正在跑的面板
 *   node open.mjs --no-open      只起服务，不开浏览器
 *
 * 探测 8800–8809：命中即复用，不重复起进程。端口段避开选题板的 8790–8799。
 */

import { spawn, exec } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVE = join(HERE, 'serve.mjs');
const ROOT = process.env.DOUYIN_COLLECT_DIR || join(homedir(), '.douyin-viral-blueprint', 'collect');

const argv = process.argv.slice(2);
const noOpen = argv.includes('--no-open');
const stop = argv.includes('--stop');
const portIdx = argv.indexOf('--port');
const wantPort = portIdx >= 0 ? Number(argv[portIdx + 1]) : null;

const RANGE = wantPort ? [wantPort] : [8800, 8801, 8802, 8803, 8804, 8805, 8806, 8807, 8808, 8809];

function openBrowser(url) {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

/** 探一个端口是不是采集面板（打 /api/library，看返回结构） */
function probe(port, timeoutMs = 700) {
  return fetch(`http://127.0.0.1:${port}/api/library`, { signal: AbortSignal.timeout(timeoutMs) })
    .then(async (res) => {
      if (!res.ok) return false;
      const j = await res.json().catch(() => null);
      return !!j && Array.isArray(j.items);
    })
    .catch(() => false);
}

async function findRunning() {
  for (const port of RANGE) {
    if (await probe(port)) return port;
  }
  return null;
}

async function doStop() {
  const pidFile = join(ROOT, 'panel.pid');
  const port = await findRunning();

  if (!existsSync(pidFile)) {
    console.log(port ? `面板在 ${port} 跑着，但没有 pid 文件 —— 去那个终端按 Ctrl+C` : '没有在跑的采集面板');
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
    console.log(`采集面板已在运行：${url}`);
    if (!noOpen) openBrowser(url);
    return running;
  }

  const port = wantPort ?? 8800;
  console.log(`启动采集面板（端口 ${port}）…`);
  const child = spawn(process.execPath, [SERVE, '--port', String(port), '--no-open'], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));

  if (!noOpen) {
    for (let i = 0; i < 40; i++) {
      if (await probe(port, 300)) { openBrowser(`http://127.0.0.1:${port}`); return port; }
      await new Promise((r) => setTimeout(r, 150));
    }
    console.error('服务没起来，看上面的报错');
  }
}

main().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
