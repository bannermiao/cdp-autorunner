#!/usr/bin/env node
/**
 * account.mjs — 账号定位档案（全局一份）
 *
 * 用法:
 *   node account.mjs                      查看档案与完整性
 *   node account.mjs --json               输出原始 JSON（给 agent 读）
 *   node account.mjs --path               只输出文件路径
 *   node account.mjs --set "赛道=游戏"     改一个字段（可重复）
 *   node account.mjs --save <文件|->        从 JSON 文件导入（- 表示 stdin）
 *   node account.mjs --missing            只输出缺哪些字段（引导式提问用）
 *
 * 存放: ~/.douyin-viral-blueprint/account.json
 *   与 douyin-viral-blueprint 的 config.json 同目录 —— 抖音系列共享，更新 skill 不丢。
 *
 * 必填两项：赛道、目标人群。缺了无法生成选题（没有锚点）。
 * 可选项缺失时，由 agent 依据 report.json 与已给信息推断补齐，并在 推断字段 里标注。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const SHARED_DIR = join(homedir(), '.douyin-viral-blueprint');
const FILE = join(SHARED_DIR, 'account.json');

/** 字段定义：必填、字符/条数限制、说明 */
const FIELDS = {
  赛道: { required: true, min: 2, max: 30, desc: '做哪个赛道，如「游戏」「效率工具」' },
  目标人群: { required: true, min: 4, max: 60, desc: '想吸引谁，越具体越好（年龄/处境/为什么看你）' },
  变现途径: { required: false, list: true, min: 2, max: 20, maxItems: 5, desc: '靠什么变现：带货 / 服务 / 引流 / 暂时没有' },
  '专长/职业': { required: false, list: true, min: 2, max: 20, maxItems: 5, desc: '凭什么讲这个：职业、经历、手上的资源' },
  补充: { required: false, min: 0, max: 200, desc: '边界与偏好，如「不接纯广告」' },
};

const SHARED_FIELDS = ['版本', '更新于', '推断字段', '推断依据'];

function empty() {
  return { 版本: 1, 赛道: '', 目标人群: '', 变现途径: [], '专长/职业': [], 补充: '', 推断字段: [], 推断依据: {}, 更新于: null };
}

function read() {
  if (!existsSync(FILE)) return empty();
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    return { ...empty(), ...j };
  } catch (e) {
    console.error(`档案读取失败，按空处理：${e.message}`);
    return empty();
  }
}

function writeAtomic(obj) {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  renameSync(tmp, FILE);
}

const charLen = (s) => [...String(s)].length;

/** 校验：返回 { 缺失[], 错误[] } */
function validate(acc) {
  const 缺失 = [];
  const 错误 = [];

  for (const [key, meta] of Object.entries(FIELDS)) {
    const v = acc[key];
    const isEmpty = meta.list ? !Array.isArray(v) || v.length === 0 : !String(v ?? '').trim();

    if (isEmpty) {
      if (meta.required) 缺失.push(key);
      continue;
    }

    if (meta.list) {
      if (!Array.isArray(v)) { 错误.push(`${key} 应为数组`); continue; }
      if (v.length > meta.maxItems) 错误.push(`${key} 最多 ${meta.maxItems} 项（现 ${v.length}）`);
      for (const item of v) {
        const n = charLen(item);
        if (n < meta.min || n > meta.max) 错误.push(`${key} 里「${item}」长度 ${n}，需 ${meta.min}–${meta.max} 字`);
      }
    } else {
      const n = charLen(v);
      if (n < meta.min) 错误.push(`${key} 只有 ${n} 字，至少 ${meta.min} 字 —— ${meta.desc}`);
      if (n > meta.max) 错误.push(`${key} 有 ${n} 字，超过 ${meta.max} 字`);
    }
  }

  // 推断字段必须是真实字段名
  if (Array.isArray(acc.推断字段)) {
    for (const f of acc.推断字段) if (!FIELDS[f]) 错误.push(`推断字段 里的「${f}」不是有效字段`);
  }
  return { 缺失, 错误 };
}

function describe(acc) {
  const { 缺失, 错误 } = validate(acc);
  const lines = [];
  lines.push(`档案：${FILE}${existsSync(FILE) ? '' : '（尚不存在）'}`);
  lines.push('');
  for (const [key, meta] of Object.entries(FIELDS)) {
    const v = acc[key];
    const inferred = Array.isArray(acc.推断字段) && acc.推断字段.includes(key);
    const shown = meta.list
      ? (Array.isArray(v) && v.length ? v.join(' / ') : '—')
      : (String(v ?? '').trim() || '—');
    const tag = !String(v ?? '').trim() && (!meta.list || !v?.length)
      ? (meta.required ? '【必填·缺】' : '（可选·空）')
      : inferred ? '（推断，请核对）' : '';
    lines.push(`  ${key.padEnd(8)} ${shown}${tag ? '  ' + tag : ''}`);
  }

  lines.push('');
  if (!缺失.length && !错误.length) {
    lines.push('✓ 档案完整，可以直接生成选题（配比 6 / 2 / 2）');
    return lines.join('\n');
  }
  if (缺失.length) {
    lines.push(`✗ 还缺 ${缺失.length} 个必填项：${缺失.join('、')}`);
    for (const k of 缺失) lines.push(`   - ${k}：${FIELDS[k].desc}`);
  }
  if (错误.length) {
    lines.push(`✗ ${错误.length} 处不合规：`);
    for (const e of 错误) lines.push(`   - ${e}`);
  }
  const 可选缺 = Object.entries(FIELDS).filter(([k, m]) => !m.required && (m.list ? !acc[k]?.length : !String(acc[k] ?? '').trim())).map(([k]) => k);
  if (可选缺.length) {
    lines.push('');
    lines.push(`可选项为空：${可选缺.join('、')} —— 可让 agent 依据素材推断补齐（会在 推断字段 标注），也可以直接问用户`);
  }
  return lines.join('\n');
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--path')) {
    console.log(FILE);
    return;
  }

  if (argv.includes('--json')) {
    console.log(JSON.stringify(read(), null, 2));
    return;
  }

  if (argv.includes('--missing')) {
    const acc = read();
    const { 缺失, 错误 } = validate(acc);
    const 可选缺 = Object.entries(FIELDS)
      .filter(([k, m]) => !m.required && (m.list ? !acc[k]?.length : !String(acc[k] ?? '').trim()))
      .map(([k]) => k);
    console.log(JSON.stringify({ 缺失必填: 缺失, 缺失可选: 可选缺, 错误 }, null, 2));
    return;
  }

  if (argv.includes('--save')) {
    const src = argv[argv.indexOf('--save') + 1];
    if (!src) {
      console.error('用法: node account.mjs --save <json文件|->');
      process.exit(1);
    }
    let raw;
    try {
      raw = src === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(src), 'utf8');
    } catch (e) {
      console.error(`读不到输入：${e.message}`);
      process.exit(1);
    }
    let patch;
    try {
      patch = JSON.parse(raw);
    } catch (e) {
      console.error(`不是合法 JSON：${e.message}`);
      process.exit(1);
    }

    const next = { ...read(), ...patch, 更新于: new Date().toISOString() };
    const { 缺失, 错误 } = validate(next);
    if (缺失.length || 错误.length) {
      console.error('档案没通过校验，未写入：');
      缺失.forEach((k) => console.error(`  缺 ${k}：${FIELDS[k].desc}`));
      错误.forEach((e) => console.error(`  ${e}`));
      process.exit(1);
    }
    writeAtomic(next);
    console.log(`✓ 已写入 ${FILE}`);
    console.log(describe(next));
    return;
  }

  const setIdx = argv.indexOf('--set');
  if (setIdx >= 0) {
    const acc = read();
    let i = setIdx + 1;
    let changed = 0;
    while (i < argv.length && !argv[i].startsWith('--')) {
      const pair = argv[i];
      const eq = pair.indexOf('=');
      if (eq < 0) {
        console.error(`格式应为 字段=值：${pair}`);
        process.exit(1);
      }
      const key = pair.slice(0, eq).trim();
      const val = pair.slice(eq + 1).trim();
      if (!(key in FIELDS) && !SHARED_FIELDS.includes(key)) {
        console.error(`未知字段：${key}\n可用: ${Object.keys(FIELDS).join(' / ')}`);
        process.exit(1);
      }
      if (FIELDS[key]?.list) {
        acc[key] = val ? val.split(/[,，;；|]/).map((s) => s.trim()).filter(Boolean) : [];
      } else {
        acc[key] = val;
      }
      // 手改过的字段，不再标为推断
      if (Array.isArray(acc.推断字段)) acc.推断字段 = acc.推断字段.filter((f) => f !== key);
      if (acc.推断依据 && key in acc.推断依据) delete acc.推断依据[key];
      changed++;
      i++;
    }
    if (!changed) {
      console.error('没有给出 字段=值');
      process.exit(1);
    }
    acc.更新于 = new Date().toISOString();
    const { 缺失, 错误 } = validate(acc);
    writeAtomic(acc);
    if (缺失.length || 错误.length) {
      console.log('已保存，但档案还不完整：');
      console.log(describe(acc));
      return;
    }
    console.log(`✓ 已更新 ${changed} 个字段`);
    console.log(describe(acc));
    return;
  }

  console.log(describe(read()));
}

main();
