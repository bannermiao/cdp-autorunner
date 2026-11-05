#!/usr/bin/env node
/**
 * serve.mjs — 采集面板本地服务（静态页 + API + SSE + 媒体流）
 *
 * 用法:
 *   node serve.mjs [--port 8800] [--no-open]
 *
 * 数据目录默认 ~/.douyin-viral-blueprint/collect，可用 DOUYIN_COLLECT_DIR 覆盖。
 *
 * 路由:
 *   GET  /                      面板
 *   GET  /api/library           全部条目（含已删除标记）
 *   POST /api/item/:id/fav      { fav: bool }
 *   POST /api/item/:id/delete   { deleted: bool }（软删，文件保留）
 *   GET  /media/:id             视频流，支持 Range
 *   GET  /cover/:id             封面
 *   GET  /api/events            SSE，采集时实时推新条目
 *   POST /api/event             采集脚本推送 { type, item }
 */

import { createServer } from 'node:http';
import {
  existsSync, readFileSync, writeFileSync, renameSync, mkdirSync,
  createReadStream, statSync, rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(HERE, '..');
const WEB = join(SKILL, 'web');
const ASSETS = join(SKILL, 'assets');
const ROOT = process.env.DOUYIN_COLLECT_DIR || join(homedir(), '.douyin-viral-blueprint', 'collect');
const LIB = join(ROOT, 'library.json');
const PID = join(ROOT, 'panel.pid');

const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const PORT = portIdx >= 0 ? Number(argv[portIdx + 1]) : 8800;
const NO_OPEN = argv.includes('--no-open');

mkdirSync(ROOT, { recursive: true });

// ---- 库读写 ----

function readLib() {
  try {
    const j = JSON.parse(readFileSync(LIB, 'utf8'));
    return Array.isArray(j.items) ? j : { items: [] };
  } catch {
    return { items: [] };
  }
}

/** 写库一律 .tmp + rename：Ctrl+C 打断时不会留下半个 JSON */
function writeLib(lib) {
  const tmp = `${LIB}.tmp`;
  writeFileSync(tmp, JSON.stringify(lib, null, 2), 'utf8');
  renameSync(tmp, LIB);
}

function findItem(lib, id) {
  return lib.items.find((x) => x.id === id);
}

// ---- HTTP 工具 ----

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const STATIC = {
  '/': join(WEB, 'index.html'),
  '/index.html': join(WEB, 'index.html'),
  '/app.js': join(WEB, 'app.js'),
  '/app.css': join(WEB, 'app.css'),
  '/vue.js': join(ASSETS, 'vue.global.prod.js'),
};

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { throw new Error(`请求体不是合法 JSON：${e.message}`); }
}

/** 文件路径必须落在 ROOT 内，防止 ../ 穿越 */
function safeJoin(base, rel) {
  const p = normalize(join(base, rel));
  return p.startsWith(normalize(base)) ? p : null;
}

// ---- SSE ----

const clients = new Set();

function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(line); } catch { clients.delete(res); }
  }
}

// ---- 路由 ----

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;

  try {
    // ---- 静态 ----
    if ((req.method === 'GET' || req.method === 'HEAD') && STATIC[path]) {
      const file = STATIC[path];
      if (!existsSync(file)) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`缺少资源：${file}`);
        return;
      }
      const ext = file.slice(file.lastIndexOf('.'));
      const buf = readFileSync(file);
      // MIME 从文件路径推，不从 URL 推（/ 没有扩展名，按 URL 推会变成 octet-stream）
      res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(buf);
      return;
    }

    // ---- 库 ----
    if (path === '/api/library' && req.method === 'GET') {
      const lib = readLib();
      return json(res, 200, {
        root: ROOT,
        items: lib.items.filter((x) => !x.deleted).sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || '')),
      });
    }

    // ---- 收藏 / 删除 ----
    const act = /^\/api\/item\/(\d+)\/(fav|delete)$/.exec(path);
    if (act && req.method === 'POST') {
      const [, id, kind] = act;
      const body = await readBody(req);
      const lib = readLib();
      const it = findItem(lib, id);
      if (!it) return json(res, 404, { error: '没有这条' });
      if (kind === 'fav') it.fav = !!body.fav;
      else it.deleted = !!body.deleted;
      it.updatedAt = new Date().toISOString();
      writeLib(lib);
      broadcast({ type: 'update', item: it });
      return json(res, 200, it);
    }

    // ---- 视频流（Range）----
    if (path.startsWith('/media/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const id = path.slice('/media/'.length).replace(/[^\d]/g, '');
      const file = safeJoin(ROOT, join(id, 'video.mp4'));
      if (!file || !existsSync(file)) { res.writeHead(404); res.end('no video'); return; }

      const size = statSync(file).size;
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        const start = m && m[1] ? Number(m[1]) : 0;
        const end = m && m[2] ? Number(m[2]) : size - 1;
        if (start >= size || end >= size || start > end) {
          res.writeHead(416, { 'content-range': `bytes */${size}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          'content-type': 'video/mp4',
          'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${size}`,
          'accept-ranges': 'bytes',
          'cache-control': 'no-cache',
        });
        createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' });
      createReadStream(file).pipe(res);
      return;
    }

    // ---- 封面 ----
    if (path.startsWith('/cover/')) {
      const id = path.slice('/cover/'.length).replace(/[^\d]/g, '');
      for (const name of ['cover.jpg', 'cover.jpeg', 'cover.png']) {
        const file = safeJoin(ROOT, join(id, name));
        if (file && existsSync(file)) {
          res.writeHead(200, { 'content-type': MIME[`.${name.split('.').pop()}`], 'cache-control': 'max-age=3600' });
          res.end(readFileSync(file));
          return;
        }
      }
      res.writeHead(404); res.end('no cover');
      return;
    }

    // ---- SSE ----
    if (path === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');
      clients.add(res);

      // 连上先推一次全量快照：刷新页面或断线重连时，中间的增量才不会丢
      const snap = readLib();
      res.write(`data: ${JSON.stringify({
        type: 'snapshot',
        items: snap.items.filter((x) => !x.deleted)
          .sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || '')),
      })}\n\n`);

      const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 25_000);
      req.on('close', () => { clearInterval(beat); clients.delete(res); });
      return;
    }

    // ---- 采集脚本推送 ----
    if (path === '/api/event' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.type === 'new' && body.item) {
        const lib = readLib();
        const exist = findItem(lib, body.item.id);
        if (exist) Object.assign(exist, body.item, { updatedAt: new Date().toISOString() });
        else lib.items.push({ ...body.item, addedAt: new Date().toISOString() });
        writeLib(lib);
        broadcast({ type: 'new', item: body.item });
      } else {
        broadcast(body);
      }
      return json(res, 200, { ok: true });
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

function openBrowser(url) {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

server.listen(PORT, '127.0.0.1', () => {
  writeFileSync(PID, String(process.pid), 'utf8');
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`采集面板：${url}`);
  console.log(`数据目录：${ROOT}`);
  if (!NO_OPEN) openBrowser(url);
});

function cleanup() {
  rmSync(PID, { force: true });
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
