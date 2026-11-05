#!/usr/bin/env node
/**
 * manage.mjs — 选题库可视化管理面板（本地服务）
 *
 * 用法:
 *   node manage.mjs [--port 8790] [--no-open]
 *
 * 起一个只监听 127.0.0.1 的小服务，浏览器打开即可改 / 删 / 新增 / 导出。
 * 数据仍是本地文件：~/.douyin-viral-blueprint/topics.json（与 CLI 共用）。
 *
 * 依赖两个静态资源（首次已随包提供，改了样式要重新构建）：
 *   assets/vue.global.prod.js   Vue 3 运行时（含模板编译器）
 *   assets/manage.css           Tailwind + Flowbite 构建产物
 *
 * 重新构建 CSS:
 *   npm i -D tailwindcss@3 flowbite@2
 *   npx tailwindcss -c web/tailwind.config.js -i web/input.css -o assets/manage.css --minify
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(HERE, '..');
const WEB = join(SKILL_ROOT, 'web');
const ASSETS = join(SKILL_ROOT, 'assets');

const SHARED_DIR = join(homedir(), '.douyin-viral-blueprint');
const TOPICS = join(SHARED_DIR, 'topics.json');
const PID_FILE = join(SHARED_DIR, 'panel.pid');
const ACCOUNT = join(SHARED_DIR, 'account.json');

const 定位 = ['泛选题', '人设选题', '转化选题'];
const 路径 = ['晒过程', '聊观点', '讲故事', '教知识'];
const 元素 = ['成本', '人群', '猎奇', '对比', '最差', '头牌', '怀旧', '荷尔蒙'];

const len = (s) => [...String(s ?? '')].length;

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} 不是合法 JSON：${e.message}`);
  }
}

function writeAtomic(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) writeFileSync(`${file}.bak`, readFileSync(file));
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

const readLib = () => {
  const j = readJson(TOPICS, { 版本: 1, 选题: [] });
  return { 版本: 1, 选题: Array.isArray(j.选题) ? j.选题 : [] };
};
const readAccount = () => readJson(ACCOUNT, { 版本: 1, 赛道: '', 目标人群: '', 变现途径: [], '专长/职业': [], 补充: '' });

/** 单条校验：不阻断保存（允许存半成品），只回警告 */
function lint(t) {
  const w = [];
  const 主题 = String(t.主题 ?? '').trim();
  const 看点 = String(t.看点 ?? '').trim();
  if (len(主题) < 6 || len(主题) > 30) w.push(`主题 ${len(主题)} 字，规范是 6–30 字`);
  if (len(看点) < 10 || len(看点) > 90) w.push(`看点 ${len(看点)} 字，规范是 10–90 字`);
  if (!定位.includes(t.内容定位)) w.push('内容定位不合法');
  if (!路径.includes(t.创作路径)) w.push('创作路径不合法');
  const els = Array.isArray(t.爆款元素) ? t.爆款元素 : [];
  if (els.length < 1 || els.length > 2) w.push('爆款元素需 1–2 个');
  const 结构 = Array.isArray(t.结构) ? t.结构 : [];
  if (结构.length < 3 || 结构.length > 5) w.push('结构需 3–5 段');
  结构.forEach((s, i) => {
    if (len(s?.段名) < 2 || len(s?.段名) > 8) w.push(`第 ${i + 1} 段段名需 2–8 字`);
    if (len(s?.要点) < 4 || len(s?.要点) > 120) w.push(`第 ${i + 1} 段要点需 4–120 字`);
  });
  return w;
}

/** 把前端传来的对象收敛成合法结构，多余字段丢掉 */
function normalize(input, prev = {}) {
  const now = new Date().toISOString();
  return {
    id: prev.id ?? input.id ?? randomUUID(),
    主题: String(input.主题 ?? prev.主题 ?? '').trim(),
    看点: String(input.看点 ?? prev.看点 ?? '').trim(),
    内容定位: 定位.includes(input.内容定位) ? input.内容定位 : (prev.内容定位 ?? '泛选题'),
    创作路径: 路径.includes(input.创作路径) ? input.创作路径 : (prev.创作路径 ?? '聊观点'),
    爆款元素: (Array.isArray(input.爆款元素) ? input.爆款元素 : prev.爆款元素 ?? []).filter((e) => 元素.includes(e)).slice(0, 2),
    结构: (Array.isArray(input.结构) ? input.结构 : prev.结构 ?? []).slice(0, 5).map((s) => ({
      段名: String(s?.段名 ?? '').trim(),
      要点: String(s?.要点 ?? '').trim(),
    })),
    收藏: typeof input.收藏 === 'boolean' ? input.收藏 : (prev.收藏 ?? false),
    标签: (Array.isArray(input.标签) ? input.标签 : prev.标签 ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 8),
    备注: String(input.备注 ?? prev.备注 ?? '').trim(),
    来源: input.来源 && typeof input.来源 === 'object' ? input.来源 : (prev.来源 ?? {}),
    生成于: prev.生成于 ?? now,
    更新于: now,
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const STATIC = {
  '/': join(WEB, 'index.html'),
  '/index.html': join(WEB, 'index.html'),
  '/app.js': join(WEB, 'app.js'),
  '/manage.css': join(ASSETS, 'manage.css'),
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
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`请求体不是合法 JSON：${e.message}`);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;

  try {
    // ---- 静态 ----
    if ((req.method === 'GET' || req.method === 'HEAD') && STATIC[path]) {
      const file = STATIC[path];
      if (!existsSync(file)) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`缺少资源：${file}\n\n首次运行请构建：\nnpx tailwindcss -c web/tailwind.config.js -i web/input.css -o assets/manage.css --minify`);
        return;
      }
      const ext = file.slice(file.lastIndexOf('.'));
      const buf = readFileSync(file);
      res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(buf);
      return;
    }

    // ---- 选题 ----
    if (path === '/api/topics' && req.method === 'GET') {
      return json(res, 200, readLib());
    }

    if (path === '/api/topics' && req.method === 'POST') {
      const body = await readBody(req);
      const t = normalize(body);
      const warnings = lint(t);
      const lib = readLib();
      lib.选题.push(t);
      writeAtomic(TOPICS, lib);
      return json(res, 200, { ...t, warnings });
    }

    if (path === '/api/topics/batch-delete' && req.method === 'POST') {
      const body = await readBody(req);
      const ids = new Set(Array.isArray(body.ids) ? body.ids : []);
      if (!ids.size) return json(res, 400, { error: '没给 ids' });
      const lib = readLib();
      const before = lib.选题.length;
      lib.选题 = lib.选题.filter((t) => !ids.has(t.id));
      writeAtomic(TOPICS, lib);
      return json(res, 200, { ok: true, removed: before - lib.选题.length, left: lib.选题.length });
    }

    const m = path.match(/^\/api\/topics\/([\w-]+)$/);
    if (m && req.method === 'PATCH') {
      const id = m[1];
      const lib = readLib();
      const i = lib.选题.findIndex((x) => x.id === id);
      if (i < 0) return json(res, 404, { error: '找不到这条选题' });
      const body = await readBody(req);
      const next = normalize(body, lib.选题[i]);
      const warnings = lint(next);
      lib.选题[i] = next;
      writeAtomic(TOPICS, lib);
      return json(res, 200, { ...next, warnings });
    }

    if (m && req.method === 'DELETE') {
      const id = m[1];
      const lib = readLib();
      const i = lib.选题.findIndex((x) => x.id === id);
      if (i < 0) return json(res, 404, { error: '找不到这条选题' });
      lib.选题.splice(i, 1);
      writeAtomic(TOPICS, lib);
      return json(res, 200, { ok: true });
    }

    // ---- 账号档案 ----
    if (path === '/api/account' && req.method === 'GET') {
      return json(res, 200, readAccount());
    }

    if (path === '/api/account' && req.method === 'POST') {
      const body = await readBody(req);
      const prev = readAccount();
      const list = (v) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean).slice(0, 5) : []);
      const next = {
        版本: 1,
        赛道: String(body.赛道 ?? prev.赛道 ?? '').trim(),
        目标人群: String(body.目标人群 ?? prev.目标人群 ?? '').trim(),
        变现途径: list(body.变现途径 ?? prev.变现途径),
        '专长/职业': list(body['专长/职业'] ?? prev['专长/职业']),
        补充: String(body.补充 ?? prev.补充 ?? '').trim().slice(0, 200),
        // 手改过的档案不再标为推断
        推断字段: [],
        推断依据: {},
        更新于: new Date().toISOString(),
      };
      if (!next.赛道 || !next.目标人群) return json(res, 400, { error: '赛道与目标人群必填' });
      writeAtomic(ACCOUNT, next);
      return json(res, 200, next);
    }

    json(res, 404, { error: `没有这个接口：${req.method} ${path}` });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

// ---- 启动 ----

const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const port = portIdx >= 0 ? Number(argv[portIdx + 1]) : 8790;
const noOpen = argv.includes('--no-open');

for (const f of [join(ASSETS, 'vue.global.prod.js'), join(ASSETS, 'manage.css')]) {
  if (!existsSync(f)) {
    console.error(`缺少资源：${f}`);
    console.error('首次运行请构建：');
    console.error('  npm i -D tailwindcss@3 flowbite@2');
    console.error('  npx tailwindcss -c web/tailwind.config.js -i web/input.css -o assets/manage.css --minify');
    console.error('（vue.global.prod.js 从 CDN 下载后放到 assets/）');
    process.exit(1);
  }
}

server.listen(port, '127.0.0.1', () => {
  try {
    mkdirSync(SHARED_DIR, { recursive: true });
    writeFileSync(PID_FILE, String(process.pid), 'utf8');
  } catch (_) { /* pid 文件写不了不影响使用 */ }
  const url = `http://127.0.0.1:${port}`;
  const lib = readLib();
  const 收藏数 = lib.选题.filter((t) => t.收藏).length;
  console.log(`选题库面板：${url}`);
  console.log(`数据：${TOPICS}（共 ${lib.选题.length} 条，收藏 ${收藏数} 条）`);
  console.log('按 Ctrl+C 停止');
  if (!noOpen) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 被占用，换一个：node manage.mjs --port ${port + 1}`);
    process.exit(1);
  }
  console.error(e.message);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n已停止');
    try { rmSync(PID_FILE, { force: true }); } catch (_) { /* ignore */ }
    server.close(() => process.exit(0));
  });
}
