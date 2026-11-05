#!/usr/bin/env node
/**
 * check.mjs — 报告交付校验（逐条照搬 kiln 的 engine/reportCheck.ts）
 *
 * 用法:
 *   node check.mjs <视频目录> [--contract] [--write]
 *
 *   --contract  打印契约（references/report-contract.md）
 *   --write     把结果写进 report.json 的「状态」字段（供渲染显示）
 *
 * 分两档（与 kiln 一致）：
 *   待补 = 契约没满足（小节缺、键名不对、条数不对）→ 必须补齐后重交
 *   提醒 = 写法问题（抄数值、指针指向不存在的字段、时间超界）→ 不阻断，但要改
 *
 * 校验器查不出「写得浅」—— 那是样本与写作能力的活。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = join(HERE, '..', 'references', 'report-contract.md');

// 与 kiln packages/shared/src/types.ts 一字不差
const REPORT_AXES = ['涨粉力', '变现力', '传播力', '收藏力', '互动力', '长尾力'];
const REPORT_METRICS = ['语速', '口播覆盖率', '切镜每分钟', '首句秒', '藏赞比', '评赞比', '转赞比', '长尾天数'];
const REPORT_JUDGMENTS = ['赛道', '形态', '特点', '人群', '开场', '结尾', '选题位', '论点'];

const 文本项 = (x) => (typeof x === 'string' ? x : '');

/** 递归收集 card 里的数值（深度 ≤3）与字段路径，供「抄数值」与「指针有效性」两类检查用 */
function walkCard(node, path, nums, paths, depth = 0) {
  if (depth > 3 || node == null) return;
  if (typeof node === 'number') {
    if (Number.isFinite(node) && node !== 0) nums.add(Math.round(node * 100) / 100);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) walkCard(item, path, nums, paths, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      paths.add([...path, k].join('.'));
      walkCard(v, [...path, k], nums, paths, depth + 1);
    }
  }
}

/**
 * 已看张：本轮真打开过的拼图张号。没有工具自动记录，由 report.json 的 `已看` 自报。
 * 传了才核对「格号只能来自真打开过的张」。
 */
function checkReport(r, card, 已看张) {
  const 待补 = [];
  const 提醒 = [];

  // ① 判断八项
  const 判断项 = new Set((r.判断 ?? []).map((j) => String(j.项 ?? '')));
  for (const 项 of REPORT_JUDGMENTS) if (!判断项.has(项)) 待补.push(`判断·${项}`);
  for (const j of r.判断 ?? []) if (!Array.isArray(j.依据) || j.依据.length === 0) 提醒.push(`判断·${j.项} 没有依据指针`);

  // ② 分值键名与值域
  const 稿 = Array.isArray(card?.口播稿) ? card.口播稿 : [];

  const 查分值 = (组名, 键们, got, 允许空) => {
    for (const k of 键们) {
      const v = got?.[k];
      if (v === undefined) { 待补.push(`${组名}·${k}`); continue; }
      if (v === null) { if (!允许空) 待补.push(`${组名}·${k}`); continue; }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 10) 待补.push(`${组名}·${k} 必须是 0–10 整数`);
    }
  };
  查分值('六轴', REPORT_AXES, r.评估?.六轴, false);
  查分值('指标', REPORT_METRICS, r.评估?.指标, true);

  // ②a 有底座就必须给分：card 里明明有数据，报告写 null 说明这项没评（不是"没底座"）
  const 时间桶 = card?.评论?.时间分布;
  const 有长尾底座 = !!时间桶 && typeof 时间桶 === 'object' && Object.keys(时间桶).length > 0;
  const 底座 = {
    语速: 稿.length > 0,
    口播覆盖率: 稿.length > 0,
    首句秒: 稿.length > 0,
    切镜每分钟: card?.内容轴?.切镜每分钟 != null,
    藏赞比: card?.视频?.比例?.藏赞比 != null,
    评赞比: card?.视频?.比例?.评赞比 != null,
    转赞比: card?.视频?.比例?.转赞比 != null,
    长尾天数: 有长尾底座,
  };
  const 漏评 = Object.keys(底座).filter((k) => 底座[k] && r.评估?.指标?.[k] === null);
  if (漏评.length) {
    待补.push(`指标·${漏评.join('、')} 有底座却写 null —— card 里有这项数据，就要给 0–10 的分`);
  }

  // ②b 评论簇命名：card 聚出 ≥2 簇时，评估.评论簇 必须逐簇给名
  const 簇们 = card?.评论?.聚类?.簇 ?? [];
  if (簇们.length >= 2) {
    const 命名 = Array.isArray(r.评估?.评论簇) ? r.评估.评论簇 : [];
    const 已名 = new Set(命名.map((x) => Number(x.簇)));
    const 缺 = 簇们.map((c) => c.id).filter((id) => !已名.has(id));
    if (缺.length) 待补.push(`评论簇·漏了簇 ${缺.join('、')}（card.评论.聚类 共 ${簇们.length} 簇，每簇都要「名+一句话」）`);
  }

  // ③ 过程：4–8 步
  const 过程 = Array.isArray(r.过程) ? r.过程.filter((x) => 文本项(x).trim()) : [];
  if (过程.length < 4 || 过程.length > 8) 待补.push(`过程·4–8 步（现 ${过程.length}）`);

  // ④ 结构划分：平台给了 ≥2 段时不该再分
  const 章节 = Array.isArray(card?.视频?.章节) ? card.视频.章节 : [];
  const 结构 = Array.isArray(r.结构) ? r.结构 : [];
  if (章节.length > 1) {
    if (结构.length) 提醒.push(`结构·平台已给 ${章节.length} 段章节，这份报告不再自拟分段（写了也不渲染）`);
  } else if (结构.length < 2 || 结构.length > 8) {
    待补.push(`结构·2–8 段（现 ${结构.length}）`);
  }
  if (结构.length && 章节.length <= 1) {
    if (Number(结构[0].起始秒) > 5) 提醒.push('结构·第一段没从 00:00 起');
    for (let i = 1; i < 结构.length; i++) if (Number(结构[i].起始秒) - Number(结构[i - 1].起始秒) < 15) 提醒.push(`结构·第 ${i + 1} 段与前一段间隔不足 15 秒`);
    for (const s of 结构) if (String(s.段名 ?? '').length > 6) 提醒.push(`结构·段名超 6 字：${s.段名}`);
  }

  // ⑤ 口播高亮（以「有口播」为前提）
  const 末句 = 稿.length ? 稿[稿.length - 1].t : null;

  const 口播依据数 = Array.isArray(r.依据?.口播) ? r.依据.口播.length : 0;
  if (稿.length && 口播依据数 === 0) 待补.push('依据·口播·口播稿存在却一条口播依据都没给');

  const 高亮 = Array.isArray(r.高亮) ? r.高亮 : [];
  const 角色们 = new Set(高亮.map((h) => String(h.角色 ?? '')));
  if (稿.length) {
    // 偏离点（唯一一处）：kiln 固定要求 4–8 处高亮，前提是稿子够长。
    // 实测预告类视频 ASR 常只出 2–3 句（主题曲/片尾音效），凑 4 处只能重复盖同一句。
    // 所以下限取 Math.min(4, 稿句数)，长稿仍是 4–8，短稿按实际可标数量。
    const 高亮下限 = Math.min(4, 稿.length);
    if (高亮.length < 高亮下限 || 高亮.length > 8) 待补.push(`高亮·${高亮下限}–8 处（现 ${高亮.length}）`);
    if (稿.length >= 2 && 角色们.size < 2) 待补.push('高亮·至少 2 类');
  }
  let 盖住 = 0;
  for (const h of 高亮) {
    const 起 = Number(h.起秒);
    const 止 = h.止秒 == null ? 起 : Number(h.止秒);
    if (末句 != null && 起 > 末句 + 30) { 提醒.push(`高亮·${起}s 超出片尾`); continue; }
    if (稿.length && !稿.some((x) => Math.abs(x.t - 起) <= 2)) 提醒.push(`高亮·${起}s 对不上任何一句口播（取 口播稿[i].t）`);
    盖住 += 稿.filter((x) => x.t >= 起 - 2 && x.t <= 止 + 2).length;
  }
  // 短稿豁免：稿子只有 2–3 句时，标 2 处就是 100%，这条规则本是为长稿设计的
  if (稿.length > 3 && 盖住 / 稿.length > 0.3) 提醒.push(`高亮·盖住了 ${Math.round((盖住 / 稿.length) * 100)}% 的口播句（超三成）—— 挑句子，别划段落`);

  // ⑤b 口播总结：有口播稿必须 3–6 条
  const 总结条 = Array.isArray(r.口播总结) ? r.口播总结.filter((x) => 文本项(x).trim()) : [];
  // 同上：短稿时按实际句数取下限，长稿仍是 3–6
  const 总结下限 = Math.min(3, 稿.length);
  if (稿.length && (总结条.length < 总结下限 || 总结条.length > 6)) 待补.push(`口播总结·${总结下限}–6 条（现 ${总结条.length}）`);

  // ⑥ 依据小节不许有数
  const 依据文本 = Object.values(r.依据 ?? {}).flat().join(' ');
  const 依据带数 = [...依据文本.matchAll(/(?<![\d.])(\d{3,})(?:\.\d+)?(?![\d])/g)].map((m) => m[1]);
  if (依据带数.length) 提醒.push(`依据·出现了 ${依据带数.length} 个数值（只该写素材位置与字段路径）`);

  // ⑦ 抄数值 + ⑧ 指针有效性（都要 card）
  if (card) {
    const nums = new Set();
    const paths = new Set();
    walkCard(card, [], nums, paths);
    const 正文 = [
      ...过程,
      ...(r.判断 ?? []).map((j) => 文本项(j.结论)),
      ...(r.评估?.该学的 ?? []), ...(r.评估?.别学的 ?? []), ...(r.评估?.下次怎么拍 ?? []),
    ].join(' ');
    const 抄 = new Set([...正文.matchAll(/(?<![\d.])(\d{3,})(?:\.\d+)?(?![\d])/g)].map((m) => Number(m[1])).filter((n) => nums.has(n)));
    if (抄.size) 提醒.push(`数据·正文里有 ${抄.size} 个数字正好等于本条 card 现值（${[...抄].slice(0, 4).join('、')}）—— 改写字段路径，数字由机器渲染`);

    const 指针集 = new Set();
    const 收 = (arr) => { for (const p of Array.isArray(arr) ? arr : []) 指针集.add(文本项(p)); };
    for (const list of Object.values(r.依据 ?? {})) 收(list);
    for (const j of r.判断 ?? []) 收(j.依据);

    const 坏 = [...指针集].filter((p) => {
      const head = p.split(/[ \u3000]/)[0];
      if (!head.includes('.') || /\.(jpg|jpeg|png|webp|json|txt|md)$/i.test(head)) return false;
      return !paths.has(head);
    });
    if (坏.length) 提醒.push(`指针·${坏.length} 个依据指向不存在的字段（${坏.slice(0, 3).join('、')}）`);

    // 拼图格号得真存在：张号 ≤ 总张数，格号 ≤ 那张的实际格数（末张常常不满 16 格）
    const 拼图 = Array.isArray(card.画面?.拼图) ? card.画面.拼图 : [];

    const 画面依据数 = Array.isArray(r.依据?.画面) ? r.依据.画面.length : 0;
    if (拼图.length && 画面依据数 === 0) 待补.push('依据·画面·有拼图证据却一条画面依据都没给');
    const 错格 = [...指针集].flatMap((p) => {
      const m = /拼图-(\d+)\.jpg\s*第\s*(\d+)\s*格/.exec(p);
      if (!m) return [];
      const sheet = 拼图.find((s) => s.文件 === `拼图-${m[1]}.jpg`);
      if (!sheet) return [`没有 拼图-${m[1]}.jpg（这份素材一共 ${拼图.length} 张）`];
      const 格数 = sheet.帧到 - sheet.帧从 + 1;
      return Number(m[2]) > 格数 ? [`${sheet.文件} 只有 ${格数} 格，指到了第 ${m[2]} 格`] : [];
    });
    if (错格.length) 提醒.push(`指针·${错格.length} 个拼图格号越界（${错格.slice(0, 2).join('；')}）`);

    // 格号对账：格号只能来自真打开过的张（硬规矩 2 的机器化）
    if (已看张) {
      if (拼图.length && 已看张.size < Math.min(2, 拼图.length)) {
        待补.push(`画面·至少打开看过 ${Math.min(2, 拼图.length)} 张拼图（开场一张 + 中间一张），并在 report.已看 里如实记录`);
      }
      const 越看 = [...new Set([...指针集].flatMap((p) => {
        const m = /拼图-(\d+)\.jpg/.exec(p);
        return m ? [Number(m[1])] : [];
      }))].filter((n) => !已看张.has(n));
      if (越看.length) 待补.push(`画面·引用了没看过的 拼图-${越看.map((n) => String(n).padStart(2, '0')).join('、')} —— 先打开看过，或改掉指针`);
    }
  }

  // ⑨ 结论里不许漏机器细节：字段路径、内部组号、反引号里的英文键名
  const 读者文本 = [
    ...(r.判断 ?? []).map((j) => 文本项(j.结论)),
    ...(r.口播总结 ?? []),
    ...(r.评估?.该学的 ?? []), ...(r.评估?.别学的 ?? []), ...(r.评估?.下次怎么拍 ?? []),
  ].join('\n');
  const 上下文 = (m) => 读者文本.slice(Math.max(0, (m.index ?? 0) - 10), (m.index ?? 0) + m[0].length + 6).trim();
  const 命中 = (re, 取 = (m) => m[0]) => [...读者文本.matchAll(re)].map(取).map((s) => s.trim()).filter(Boolean);
  const 漏 = [
    ...命中(/(?:评论区|结果区|内容轴|密度统计|画面|素材|口播稿|视频|评论)\.[\u4e00-\u9fa5A-Za-z]/g, 上下文),
    ...命中(/\bG\d+\b/g, 上下文),
    ...命中(/`([^`]+)`/g, (m) => (/^[a-z][a-z0-9_]{2,}$/.test(m[1]) ? 上下文(m) : '')),
  ];
  if (漏.length) 提醒.push(`结论·${漏.length} 处漏了机器细节（${漏.slice(0, 3).join('、')}）—— 写给读者的句子要翻成人话，指针留在依据里`);

  // ⑨b 一句话结论与维度：报告顶部 / 底部靠它们，缺了就是空块
  const 结论句 = 文本项(r.一句话结论);
  if (!结论句) 待补.push('一句话结论·缺（报告顶部就靠这一句）');
  else if (结论句.length < 10) 待补.push(`一句话结论·只有 ${结论句.length} 字，至少 10 字说清判断`);
  else if (结论句.length > 200) 提醒.push(`一句话结论·${结论句.length} 字，超过 200 字该收了`);

  for (const key of ['话题/行业', '目标观众']) {
    const arr = Array.isArray(r.维度?.[key]) ? r.维度[key].filter((x) => 文本项(x?.值)) : [];
    if (!arr.length) 待补.push(`维度·${key} 一条都没写`);
    else if (arr.length < 2) 提醒.push(`维度·${key} 只有 ${arr.length} 条（建议 2–4 条）`);
  }

  // ⑩ 自我修正旁白
  const 交付正文 = [
    文本项(r.一句话结论),
    ...过程,
    ...(r.判断 ?? []).map((j) => 文本项(j.结论)),
    ...(r.口播总结 ?? []),
    ...(r.评估?.该学的 ?? []), ...(r.评估?.别学的 ?? []), ...(r.评估?.下次怎么拍 ?? []),
  ].join('\n');
  const 自改 = [...new Set([...交付正文.matchAll(
    /[（(][^（()）]{0,60}(?:修正|更正|纠正|重新计算|重新核对|重新确认)[^（()）]{0,80}[)）]|(?:^|\n)(?:修正|更正|纠正)[：:]/g,
  )].map((m) => m[0].trim().slice(0, 30)))];
  if (自改.length) 待补.push(`正文·${自改.length} 处自我修正括注（${自改.slice(0, 2).join('；')}）—— 哪一步有错就直接改写那一步，交付里不留修正过程`);

  return { 待补, 提醒 };
}

function main() {
  const argv = process.argv.slice(2);
  const raw = argv.find((a) => !a.startsWith('--'));

  if (argv.includes('--contract')) {
    if (!existsSync(CONTRACT)) {
      console.error(`契约文件缺失：${CONTRACT}`);
      process.exit(1);
    }
    console.log(readFileSync(CONTRACT, 'utf8'));
    return;
  }

  if (!raw) {
    console.error('用法: node check.mjs <视频目录> [--contract] [--write]');
    process.exit(1);
  }
  const dir = resolve(raw);
  const cardFile = join(dir, 'card.json');
  const reportFile = join(dir, 'report.json');
  if (!existsSync(cardFile)) { console.error(`缺 card.json：先跑 node card.mjs ${raw}`); process.exit(1); }
  if (!existsSync(reportFile)) { console.error(`缺 report.json：agent 还没写报告`); process.exit(1); }

  const card = JSON.parse(readFileSync(cardFile, 'utf8'));
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));

  // 已看张自报：report.已看 数组；没写就跳过观看类检查（与 kiln 不传 已看张 时一致）
  const 已看张 = Array.isArray(report.已看) && report.已看.length ? new Set(report.已看.map(Number)) : undefined;

  const { 待补, 提醒 } = checkReport(report, card, 已看张);

  if (待补.length) {
    console.log(`待补（${待补.length}）：`);
    待补.forEach((x) => console.log(`  - ${x}`));
  } else {
    console.log('待补：无');
  }
  if (提醒.length) {
    console.log(`\n提醒（${提醒.length}）：`);
    提醒.forEach((x) => console.log(`  - ${x}`));
  }

  if (argv.includes('--write')) {
    report.状态 = { 待补, 提醒, 校验于: new Date().toISOString() };
    writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
    console.log('\n结果已写入 report.json 的「状态」字段');
  }

  if (待补.length) {
    console.log('\n补齐后重跑本命令；全部清零再跑 report.mjs。');
    process.exit(1);
  }
  console.log('\n契约通过。下一步：node report.mjs ' + raw);
}

main();
