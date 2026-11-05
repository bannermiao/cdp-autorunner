#!/usr/bin/env node
/**
 * config.mjs — 统一配置 + key 的写入与自检
 *
 * 用法:
 *   node config.mjs                          查看生效配置（key 打码）与来源
 *   node config.mjs --set-key sk-xxx         写入用户目录配置文件
 *   node config.mjs --set baseUrl=https://... 改任意字段（见下方 FIELDS）
 *   node config.mjs --test                   实测三路接口：embedding / chat / ASR
 *   node config.mjs --clear                  删除用户目录配置文件
 *
 * 配置来源（优先级高 → 低）:
 *   1. 环境变量 DR_*
 *   2. <当前工作目录>/dr.config.json      —— 临时覆盖，随项目走
 *   3. ~/.douyin-viral-blueprint/config.json  —— 默认写入位置，更新 skill 不会丢
 *   4. <skill>/config.json                —— 打包自带默认值用
 *   5. 内置默认值
 *
 * key 写在用户目录而不是 skill 目录：skillhub 更新会整目录覆盖，key 会一起没。
 *
 * 默认对接**硅基流动**（api.siliconflow.cn），ASR / embedding / 标注三个模型都在那里：
 *   FunAudioLLM/SenseVoiceSmall · BAAI/bge-m3 · Qwen/Qwen3-8B
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USER_CFG = join(homedir(), '.douyin-viral-blueprint', 'config.json');
const CWD_CFG = join(process.cwd(), 'dr.config.json');
const SKILL_CFG = join(SKILL_ROOT, 'config.json');

/** 字段定义：env 名、默认值、类型、说明 */
const FIELDS = {
  baseUrl: { env: 'DR_BASE_URL', def: 'https://api.siliconflow.cn/v1', desc: '硅基流动 API 地址' },
  apiKey: { env: 'DR_API_KEY', def: '', desc: 'API key' },
  asrModel: { env: 'DR_ASR_MODEL', def: 'FunAudioLLM/SenseVoiceSmall', desc: 'ASR 模型' },
  language: { env: 'DR_LANGUAGE', def: 'zh', desc: 'ASR 语言' },
  embedModel: { env: 'DR_EMBED_MODEL', def: 'BAAI/bge-m3', desc: 'embedding 模型' },
  labelModel: { env: 'DR_LABEL_MODEL', def: 'Qwen/Qwen3-8B', desc: '评论标注模型' },
  concurrency: { env: 'DR_CONCURRENCY', def: 4, num: true, desc: '并发数' },
  timeoutMs: { env: 'DR_TIMEOUT', def: 120_000, num: true, desc: '单请求超时 ms' },
  retries: { env: 'DR_RETRIES', def: 3, num: true, desc: '重试次数' },
  speechMinChars: { env: 'DR_SPEECH_MIN_CHARS', def: 20, num: true, desc: '有效口播字数下限' },
  speechMinRate: { env: 'DR_SPEECH_MIN_RATE', def: 60, num: true, desc: '有效口播语速下限（字/分）' },
};

function readJson(file) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  } catch (e) {
    console.error(`配置读取失败，已忽略：${file}（${e.message}）`);
    return null;
  }
}

/** 按优先级合并，并记录每个字段的来源 */
export function loadConfig() {
  const layers = [
    { tag: SKILL_CFG, data: readJson(SKILL_CFG) },
    { tag: USER_CFG, data: readJson(USER_CFG) },
    { tag: CWD_CFG, data: readJson(CWD_CFG) },
  ].filter((l) => l.data && typeof l.data === 'object');

  const cfg = {};
  const src = {};

  for (const [key, meta] of Object.entries(FIELDS)) {
    const envVal = process.env[meta.env];
    if (envVal !== undefined && envVal !== '') {
      cfg[key] = meta.num ? Number(envVal) : envVal;
      src[key] = `env ${meta.env}`;
      continue;
    }
    let hit = false;
    // 后读的层优先级更高：从后往前找
    for (let i = layers.length - 1; i >= 0; i--) {
      const v = layers[i].data[key];
      if (v !== undefined && v !== null && v !== '') {
        cfg[key] = meta.num ? Number(v) : v;
        src[key] = layers[i].tag === CWD_CFG ? 'cwd/dr.config.json'
          : layers[i].tag === USER_CFG ? '~/.douyin-viral-blueprint/config.json'
          : 'skill/config.json';
        hit = true;
        break;
      }
    }
    if (!hit) {
      cfg[key] = meta.def;
      src[key] = 'default';
    }
  }

  Object.defineProperty(cfg, '_src', { value: src, enumerable: false });
  return cfg;
}

export function maskKey(k) {
  if (!k) return '(未配置)';
  if (k.length <= 12) return k.slice(0, 2) + '***';
  return `${k.slice(0, 5)}…${k.slice(-4)}（${k.length} 位）`;
}

export function describeConfig(cfg) {
  const lines = [];
  lines.push('生效配置：');
  for (const [key, meta] of Object.entries(FIELDS)) {
    const v = key === 'apiKey' ? maskKey(cfg[key]) : cfg[key];
    lines.push(`  ${key.padEnd(15)} ${String(v).padEnd(34)} ${meta.desc}  ← ${cfg._src[key]}`);
  }
  const files = [
    ['用户目录', USER_CFG],
    ['当前目录', CWD_CFG],
    ['skill', SKILL_CFG],
  ];
  lines.push('');
  lines.push('配置文件：');
  for (const [name, f] of files) lines.push(`  ${existsSync(f) ? '✓' : '·'} ${name}  ${f}`);
  return lines.join('\n');
}

function writeUserConfig(patch) {
  const cur = readJson(USER_CFG) || {};
  const next = { ...cur, ...patch };
  mkdirSync(dirname(USER_CFG), { recursive: true });
  writeFileSync(USER_CFG, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return USER_CFG;
}

/** 1 秒静音 WAV：只用来验证 ASR 通道能通，不产生真实转写 */
function silentWav(seconds = 1) {
  const sr = 16_000;
  const bytes = sr * 2 * seconds;
  const b = Buffer.alloc(44 + bytes);
  b.write('RIFF', 0); b.writeUInt32LE(36 + bytes, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(bytes, 40);
  return b;
}

const HINTS = {
  30001: '账户余额不足 —— 去网关后台充值',
  30003: '模型已下线 —— 换个模型名',
  401: 'key 无效或拼错',
  403: 'key 无该模型权限',
  404: 'baseUrl 路径不对（应形如 https://xxx/v1）',
};

async function hit(name, fn, tries = 2) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const detail = await fn();
      console.log(`  ✓ ${name.padEnd(11)} ${detail}`);
      return true;
    } catch (e) {
      last = e;
      // 首次 TLS/DNS 握手偶发失败（实测过），重试一次再判定
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 800));
    }
  }
  console.log(`  ✗ ${name.padEnd(11)} ${last?.message ?? '未知错误'}`);
  return false;
}

/** 轻量探活：只打一次 embedding，确认 key 真能用。8 秒超时，失败重试一次。 */
async function probe(cfg, timeoutMs = 8_000) {
  let last = null;
  for (let i = 0; i < 2; i++) {
    const started = Date.now();
    try {
      const res = await fetch(`${cfg.baseUrl}/embeddings`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.embedModel, input: ['ping'] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        let code = null;
        try { code = JSON.parse(text).code; } catch (_) { /* 非 JSON 错误体 */ }
        const e = new Error(HINTS[code] || HINTS[res.status] || text.slice(0, 100));
        e.status = res.status;
        e.code = code;
        throw e;
      }
      const j = JSON.parse(text);
      return { dim: j.data?.[0]?.embedding?.length ?? 0, ms: Date.now() - started };
    } catch (e) {
      last = e;
      // 首次 TLS/DNS 握手偶发失败，重试一次再判定
      if (i === 0) await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw last;
}

async function test(cfg) {
  if (!cfg.apiKey) {
    console.error('没有 key，先跑：node config.mjs --set-key sk-xxx');
    process.exit(1);
  }
  console.log(`测 ${cfg.baseUrl}（key ${maskKey(cfg.apiKey)}）\n`);

  const post = async (path, body, extra = {}) => {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json', ...extra },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let code = null;
      try { code = JSON.parse(text).code; } catch (_) { /* 非 JSON 错误体 */ }
      const hint = HINTS[code] || HINTS[res.status] || '';
      throw new Error(`HTTP ${res.status}${code ? ` code ${code}` : ''}${hint ? ` —— ${hint}` : ''}：${text.slice(0, 120)}`);
    }
    return text;
  };

  const okEmbed = await hit(`embedding`, async () => {
    const t = await post('/embeddings', { model: cfg.embedModel, input: ['连通性测试'] });
    const j = JSON.parse(t);
    return `${cfg.embedModel}  →  ${j.data?.[0]?.embedding?.length ?? '?'} 维`;
  });

  const okChat = await hit(`chat`, async () => {
    const t = await post('/chat/completions', {
      model: cfg.labelModel,
      messages: [{ role: 'user', content: '回一个字：好' }],
      max_tokens: 8,
      temperature: 0,
    });
    const j = JSON.parse(t);
    return `${cfg.labelModel}  →  ${JSON.stringify(j.choices?.[0]?.message?.content ?? '').slice(0, 20)}`;
  });

  const okAsr = await hit(`asr`, async () => {
    const fd = new FormData();
    fd.append('file', new Blob([silentWav(1)], { type: 'audio/wav' }), 'probe.wav');
    fd.append('model', cfg.asrModel);
    if (cfg.language) fd.append('language', cfg.language);
    fd.append('response_format', 'json');
    const res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      body: fd,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let code = null;
      try { code = JSON.parse(text).code; } catch (_) { /* ignore */ }
      throw new Error(`HTTP ${res.status}${code ? ` code ${code}` : ''}${HINTS[code] ? ` —— ${HINTS[code]}` : ''}：${text.slice(0, 120)}`);
    }
    return `${cfg.asrModel}  →  1s 静音可上传（返回 ${text.slice(0, 40).replace(/\s+/g, ' ')}）`;
  });

  console.log('');
  if (okEmbed && okChat && okAsr) {
    console.log('三路全通，可以跑完整链路。');
  } else {
    console.log('未全通：缺的环节会自动降级（无 ASR → 缺口播；无 embedding/chat → 评论走字数口径）。');
    process.exit(2);
  }
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--set-key')) {
    const v = argv[argv.indexOf('--set-key') + 1];
    if (!v || v.startsWith('--')) {
      console.error('用法: node config.mjs --set-key sk-xxx');
      process.exit(1);
    }
    console.log(`已写入 ${writeUserConfig({ apiKey: v.trim() })}\n`);
    console.log(describeConfig(loadConfig()));
    return;
  }

  if (argv.includes('--set')) {
    const pair = argv[argv.indexOf('--set') + 1] || '';
    const eq = pair.indexOf('=');
    if (eq < 0) {
      console.error(`用法: node config.mjs --set <字段>=<值>\n字段: ${Object.keys(FIELDS).join(' / ')}`);
      process.exit(1);
    }
    const key = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (!(key in FIELDS)) {
      console.error(`未知字段：${key}\n可用: ${Object.keys(FIELDS).join(' / ')}`);
      process.exit(1);
    }
    console.log(`已写入 ${writeUserConfig({ [key]: FIELDS[key].num ? Number(val) : val })}\n`);
    console.log(describeConfig(loadConfig()));
    return;
  }

  if (argv.includes('--clear')) {
    if (existsSync(USER_CFG)) {
      rmSync(USER_CFG, { force: true });
      console.log(`已删除 ${USER_CFG}`);
    } else {
      console.log(`没有用户配置文件（${USER_CFG}）`);
    }
    return;
  }

  const cfg = loadConfig();

  if (argv.includes('--test')) {
    await test(cfg);
    return;
  }

  console.log(describeConfig(cfg));

  // 压根没配 → 才提醒配置
  if (!cfg.apiKey) {
    console.log('\n还没配 key。配一次就行（存用户目录，更新 skill 不丢）：');
    console.log('  node config.mjs --set-key sk-xxx');
    return;
  }

  if (argv.includes('--no-check')) return;

  // 已经配了 → 直接验还能不能用，能用就不必再动
  process.stdout.write('\n检查 key 是否可用…');
  try {
    const { dim, ms } = await probe(cfg);
    process.stdout.write('\r');
    console.log(`✓ key 可用（${cfg.embedModel} · ${dim} 维 · ${ms}ms）—— 不用再配，直接跑 prepare`);
  } catch (e) {
    process.stdout.write('\r');
    console.log(`✗ key 不可用：${e.message}`);
    if (e.code === 30001) {
      console.log('   → 去硅基流动后台充值，充完跑 node config.mjs --test 复测');
    } else if (e.status === 401 || e.status === 403) {
      console.log('   → key 无效或已撤销，重新配：node config.mjs --set-key sk-新的');
    } else {
      console.log('   → 可能是网络问题，跑 node config.mjs --test 看三路详细结果');
    }
  }
}

const SELF = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
// 被 prepare / card import 时不能跑 CLI，只有直接执行才进入
if (invoked && invoked.toLowerCase() === SELF.toLowerCase()) {
  main().catch((e) => {
    console.error(`\nERROR: ${e.message}`);
    process.exit(1);
  });
}
