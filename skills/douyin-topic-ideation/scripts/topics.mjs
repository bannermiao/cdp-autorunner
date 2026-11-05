#!/usr/bin/env node
/**
 * topics.mjs — 选题库读写与校验（全局一份）
 *
 * 用法:
 *   node topics.mjs save <json文件|->     校验后入库（纯追加，不删旧条）
 *   node topics.mjs list [--json]         看列表（默认表格）
 *   node topics.mjs show <id>             看一条的完整内容
 *   node topics.mjs edit <id> k=v ...     改简单字段（收藏/标签/备注/主题/看点）
 *   node topics.mjs rm <id>               删一条（直接删，操作前确认 id）
 *   node topics.mjs export --md|--csv|--json [--out 文件]
 *   node topics.mjs stats                 统计：条数、收藏、配比
 *   node topics.mjs --path                库文件路径
 *
 * 存放: ~/.douyin-viral-blueprint/topics.json
 *   与 config.json / account.json 同目录 —— 抖音系列共享，更新 skill 不丢。
 *
 * 校验规则见 references/topic-contract.md；其中「重拍/改写原作品」是本 skill 独有的一条。
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const SHARED_DIR = join(homedir(), '.douyin-viral-blueprint');
const FILE = join(SHARED_DIR, 'topics.json');
const ACCOUNT = join(SHARED_DIR, 'account.json');

const 定位 = ['泛选题', '人设选题', '转化选题'];
const 路径 = ['晒过程', '聊观点', '讲故事', '教知识'];
const 元素 = ['成本', '人群', '猎奇', '对比', '最差', '头牌', '怀旧', '荷尔蒙'];

const 配比 = { 泛选题: 6, 人设选题: 2, 转化选题: 2 };
const 每批 = 10;

const 空话词 = ['赋能', '抓手', '闭环', '打造', '提升', '全场景', '干货', '保姆级', '颗粒度', '方法论'];
const 元话术 = ['落点', '调性', '收住'];
/** 对应「选题服务于我，不是给原作品追加」：出现这些说法说明在改写原片，不是在开新题 */
const 回头词 = /(重拍|重做这条|改这条|这条重新|换个拍法重做|把这一段改成|原来的片子改)/;

const len = (s) => [...String(s ?? '')].length;

function read() {
  if (!existsSync(FILE)) return { 版本: 1, 选题: [] };
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    return { 版本: 1, 选题: Array.isArray(j.选题) ? j.选题 : [] };
  } catch (e) {
    console.error(`选题库读取失败：${e.message}`);
    process.exit(1);
  }
}

function writeAtomic(obj) {
  mkdirSync(dirname(FILE), { recursive: true });
  if (existsSync(FILE)) writeFileSync(`${FILE}.bak`, readFileSync(FILE));
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  renameSync(tmp, FILE);
}

function readAccount() {
  if (!existsSync(ACCOUNT)) return null;
  try {
    return JSON.parse(readFileSync(ACCOUNT, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** 校验一批（恰好 10 条）。existing 用于跨批次判重 */
function validateBatch(batch, existing = [], account = null) {
  const 待补 = [];
  const 提醒 = [];

  if (!Array.isArray(batch)) return { 待补: ['选题 必须是数组'], 提醒: [] };
  if (batch.length !== 每批) 待补.push(`必须恰好 ${每批} 条（现 ${batch.length} 条）`);

  const 计数 = { 泛选题: 0, 人设选题: 0, 转化选题: 0 };
  batch.forEach((t, i) => {
    const n = i + 1;
    const 主题 = String(t.主题 ?? '').trim();
    const 看点 = String(t.看点 ?? '').trim();

    if (!主题) 待补.push(`第 ${n} 条缺 主题`);
    else if (len(主题) < 6 || len(主题) > 30) 待补.push(`第 ${n} 条 主题 ${len(主题)} 字，需 6–30 字：${主题}`);

    if (!看点) 待补.push(`第 ${n} 条缺 看点（写清观众为什么在意、能拿到什么，10–90 字）`);
    else if (len(看点) < 10 || len(看点) > 90) 待补.push(`第 ${n} 条 看点 ${len(看点)} 字，需 10–90 字`);

    if (!定位.includes(t.内容定位)) 待补.push(`第 ${n} 条 内容定位 必须是 ${定位.join(' / ')}`);
    else 计数[t.内容定位]++;

    if (!路径.includes(t.创作路径)) 待补.push(`第 ${n} 条 创作路径 必须是 ${路径.join(' / ')}`);

    const els = Array.isArray(t.爆款元素) ? t.爆款元素 : [];
    if (els.length < 1 || els.length > 2) 待补.push(`第 ${n} 条 爆款元素 需 1–2 个`);
    for (const e of els) if (!元素.includes(e)) 待补.push(`第 ${n} 条 爆款元素「${e}」不在名单里`);

    const 结构 = Array.isArray(t.结构) ? t.结构 : [];
    if (结构.length < 3 || 结构.length > 5) 待补.push(`第 ${n} 条 结构 需 3–5 段（现 ${结构.length}）`);
    结构.forEach((s, si) => {
      const 段名 = String(s?.段名 ?? '').trim();
      const 要点 = String(s?.要点 ?? '').trim();
      if (len(段名) < 2 || len(段名) > 8) 待补.push(`第 ${n} 条第 ${si + 1} 段 段名 ${len(段名)} 字，需 2–8 字`);
      if (len(要点) < 4 || len(要点) > 120) 待补.push(`第 ${n} 条第 ${si + 1} 段 要点 ${len(要点)} 字，需 4–120 字`);
    });

    // 空话词只在主题里查；元话术三处都查
    const 空 = 空话词.find((w) => 主题.includes(w));
    if (空) 待补.push(`第 ${n} 条 主题有空话词「${空}」，换成具体说法`);

    const 文本全集 = [主题, 看点, ...结构.flatMap((s) => [String(s?.段名 ?? ''), String(s?.要点 ?? '')])];
    const 元 = 元话术.find((w) => 文本全集.some((x) => x.includes(w)));
    if (元) 待补.push(`第 ${n} 条有元话术「${元}」（在说自己在干什么）—— 直接写那句台词或那个动作`);

    if (回头词.test(文本全集.join(' '))) 待补.push(`第 ${n} 条像在改写原作品（重拍/改这条）—— 选题要开新题，不是给原片续命`);
  });

  // 配比
  for (const k of 定位) {
    if (计数[k] !== 配比[k]) 待补.push(`${k} 需 ${配比[k]} 条（现 ${计数[k]} 条）`);
  }

  // 批内判重
  const 主题们 = batch.map((t) => String(t.主题 ?? '').trim()).filter(Boolean);
  const seen = new Map();
  主题们.forEach((t) => seen.set(t, (seen.get(t) ?? 0) + 1));
  for (const [t, c] of seen) if (c > 1) 待补.push(`主题重复：${t}`);

  // 跨批次判重（相似度用去标点后的字面比对，够用）
  const norm = (s) => String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
  const 旧 = new Set(existing.map((t) => norm(t.主题)));
  for (const t of 主题们) if (旧.has(norm(t))) 待补.push(`库里已有同主题：${t}（换角度或改写）`);

  // 人设 / 转化 选题的底座
  if (account) {
    const 有专长 = Array.isArray(account['专长/职业']) && account['专长/职业'].length;
    const 有变现 = Array.isArray(account.变现途径) && account.变现途径.length;
    if (!有专长 && 计数.人设选题 > 0) 提醒.push('账号档案里没有「专长/职业」，人设选题容易被编出来 —— 补一下或让 agent 推断');
    if (!有变现 && 计数.转化选题 > 0) 提醒.push('账号档案里没有「变现途径」，转化选题的卖点容易空 —— 补一下或让 agent 推断');
  }

  return { 待补: [...new Set(待补)], 提醒: [...new Set(提醒)] };
}

function summarize(t) {
  return `${t.主题}`;
}

function table(list) {
  if (!list.length) return '（选题库是空的）';
  const rows = list.map((t, i) => {
    const 定位短 = { 泛选题: '泛', 人设选题: '人', 转化选题: '转' }[t.内容定位] ?? '?';
    return [
      String(i + 1).padStart(2),
      定位短,
      t.收藏 ? '★' : '·',
      `${t.主题}`,
      (t.来源?.报告 ?? '').slice(0, 12),
      (t.id ?? '').slice(0, 8),
    ];
  });
  const head = ['#', '类', '藏', '主题', '来源', 'id'];
  const w = head.map((h, i) => Math.max(len(h), ...rows.map((r) => len(r[i]))));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join('  ');
  return [line(head), w.map((x) => '─'.repeat(x)).join('  '), ...rows.map(line)].join('\n');
}

function stats(list) {
  const by定位 = {};
  for (const t of list) by定位[t.内容定位] = (by定位[t.内容定位] ?? 0) + 1;
  const 收藏数 = list.filter((t) => t.收藏).length;
  const lines = [];
  lines.push(`共 ${list.length} 条（收藏 ${收藏数}）`);
  lines.push('');
  lines.push('内容定位：');
  for (const k of 定位) lines.push(`  ${k.padEnd(6)} ${String(by定位[k] ?? 0).padStart(3)}`);
  return lines.join('\n');
}

function toMd(list) {
  const out = [];
  for (const t of list) {
    out.push(`## ${t.收藏 ? '★ ' : ''}${t.主题}`);
    out.push('');
    out.push(`- 看点：${t.看点}`);
    out.push(`- 定位：${t.内容定位} ｜ 路径：${t.创作路径} ｜ 元素：${(t.爆款元素 ?? []).join('、')}`);
    if (t.标签?.length) out.push(`- 标签：${t.标签.join('/')}`);
    if (t.结构?.length) {
      out.push('');
      t.结构.forEach((s, i) => out.push(`${i + 1}. **${s.段名}**：${s.要点}`));
    }
    if (t.备注) {
      out.push('');
      out.push(`> ${t.备注}`);
    }
    if (t.来源?.报告) {
      out.push('');
      out.push(`<sub>来源：${t.来源.报告} ｜ ${t.来源.话题 ?? ''} ｜ ${t.来源.观众 ?? ''}</sub>`);
    }
    out.push('');
  }
  return out.join('\n');
}

function toCsv(list) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['主题', '看点', '内容定位', '创作路径', '爆款元素', '收藏', '标签', '备注', '来源报告', '生成于'];
  const rows = list.map((t) => [
    t.主题, t.看点, t.内容定位, t.创作路径,
    (t.爆款元素 ?? []).join('/'), t.收藏 ? '是' : '',
    (t.标签 ?? []).join('/'), t.备注 ?? '', t.来源?.报告 ?? '', t.生成于 ?? '',
  ]);
  return [head, ...rows].map((r) => r.map(esc).join(',')).join('\n');
}

function findIndex(list, idLike) {
  const i = list.findIndex((t) => t.id === idLike || String(t.id ?? '').startsWith(idLike));
  return i;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === '--path') {
    console.log(FILE);
    return;
  }

  if (!cmd) {
    console.error('用法见文件头：save / list / show / edit / status / rm / export / stats');
    process.exit(1);
  }

  if (cmd === 'save') {
    const src = argv[1];
    if (!src) {
      console.error('用法: node topics.mjs save <json文件|->');
      process.exit(1);
    }
    let raw;
    try {
      raw = src === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(src), 'utf8');
    } catch (e) {
      console.error(`读不到输入：${e.message}`);
      process.exit(1);
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      console.error(`不是合法 JSON：${e.message}`);
      process.exit(1);
    }

    const batch = Array.isArray(payload) ? payload : payload.选题;
    const 来源 = Array.isArray(payload) ? {} : { ...payload.来源 };
    const lib = read();
    const account = readAccount();
    const { 待补, 提醒 } = validateBatch(batch, lib.选题, account);

    if (待补.length) {
      console.error(`待补（没写入，${待补.length} 项）：`);
      待补.forEach((x) => console.error(`  - ${x}`));
      console.error('\n改完再调一次 save。');
      process.exit(1);
    }

    const 生成于 = new Date().toISOString();
    const 新条 = batch.map((t) => ({
      id: randomUUID(),
      主题: String(t.主题).trim(),
      看点: String(t.看点).trim(),
      内容定位: t.内容定位,
      创作路径: t.创作路径,
      爆款元素: t.爆款元素,
      结构: t.结构.map((s) => ({ 段名: String(s.段名).trim(), 要点: String(s.要点).trim() })),
      收藏: false,
      标签: [],
      备注: '',
      来源,
      生成于,
      更新于: 生成于,
    }));

    // 纯追加：只往后接新条，绝不自动删旧选题；删除一律人工
    writeAtomic({ 版本: 1, 选题: [...lib.选题, ...新条] });

    console.log(`✓ 已入库 ${新条.length} 条 → ${FILE}`);
    if (提醒.length) {
      console.log('\n提醒：');
      提醒.forEach((x) => console.log(`  - ${x}`));
    }
    console.log('\n下一步：node manage.mjs 打开面板修改/删除，或 node topics.mjs list');
    return;
  }

  if (cmd === 'list') {
    const lib = read();
    if (argv.includes('--json')) {
      console.log(JSON.stringify(lib.选题, null, 2));
      return;
    }
    const list = lib.选题;
    console.log(table(list));
    console.log('');
    console.log(stats(lib.选题));
    return;
  }

  if (cmd === 'show') {
    const lib = read();
    const i = findIndex(lib.选题, argv[1]);
    if (i < 0) {
      console.error(`找不到：${argv[1]}`);
      process.exit(1);
    }
    console.log(JSON.stringify(lib.选题[i], null, 2));
    return;
  }

  if (cmd === 'edit') {
    const lib = read();
    const i = findIndex(lib.选题, argv[1]);
    if (i < 0) {
      console.error(`找不到：${argv[1]}`);
      process.exit(1);
    }
    const allow = ['主题', '看点', '收藏', '标签', '备注', '内容定位', '创作路径'];
    let changed = 0;
    for (const pair of argv.slice(2)) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1).trim();
      if (!allow.includes(k)) {
        console.error(`不能改 ${k}（可改：${allow.join(' / ')}；结构用 manage.mjs 改）`);
        process.exit(1);
      }
      if (k === '标签') lib.选题[i][k] = v ? v.split(/[,;；|]/).map((s) => s.trim()).filter(Boolean) : [];
      else if (k === '收藏') lib.选题[i][k] = /^(1|true|是|y|yes)$/i.test(v);
      else if (k === '内容定位') {
        if (!定位.includes(v)) {
          console.error(`内容定位 必须是 ${定位.join(' / ')}`);
          process.exit(1);
        }
        lib.选题[i][k] = v;
      } else if (k === '创作路径') {
        if (!路径.includes(v)) {
          console.error(`创作路径 必须是 ${路径.join(' / ')}`);
          process.exit(1);
        }
        lib.选题[i][k] = v;
      } else {
        lib.选题[i][k] = v;
      }
      changed++;
    }
    if (!changed) {
      console.error('没有给出 字段=值');
      process.exit(1);
    }
    lib.选题[i].更新于 = new Date().toISOString();
    writeAtomic(lib);
    console.log(`✓ 已改 ${changed} 个字段：${lib.选题[i].主题}`);
    return;
  }

  if (cmd === 'rm') {
    const lib = read();
    const i = findIndex(lib.选题, argv[1]);
    if (i < 0) {
      console.error(`找不到：${argv[1]}`);
      process.exit(1);
    }
    const t = lib.选题[i];
    lib.选题.splice(i, 1);
    writeAtomic(lib);
    console.log(`✓ 已删除：${t.主题}（剩 ${lib.选题.length} 条）`);
    return;
  }

  if (cmd === 'export') {
    const lib = read();
    const list = lib.选题;
    let body;
    let ext;
    if (argv.includes('--md')) { body = toMd(list); ext = 'md'; }
    else if (argv.includes('--csv')) { body = toCsv(list); ext = 'csv'; }
    else if (argv.includes('--json')) { body = JSON.stringify({ 版本: 1, 选题: list }, null, 2); ext = 'json'; }
    else {
      console.error('用法: export --md|--csv|--json [--out 文件]');
      process.exit(1);
    }
    const outIdx = argv.indexOf('--out');
    const out = outIdx >= 0 ? resolve(argv[outIdx + 1]) : join(process.cwd(), `选题.${ext}`);
    writeFileSync(out, body + '\n', 'utf8');
    console.log(`✓ 已导出 ${list.length} 条 → ${out}`);
    return;
  }

  if (cmd === 'stats') {
    console.log(stats(read().选题));
    return;
  }

  console.error(`未知命令：${cmd}`);
  process.exit(1);
}

main();
