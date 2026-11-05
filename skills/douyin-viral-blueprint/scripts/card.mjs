#!/usr/bin/env node
/**
 * card.mjs — 派生事实卡 + 评论语义聚类
 *
 * 用法:
 *   node card.mjs <视频目录> [--force] [--no-llm] [--rebuild-comments]
 *
 *   --force             重跑（card.json 已存在时默认跳过）
 *   --no-llm            评论走字数口径，不调接口
 *   --rebuild-comments  评论没变也强制重算聚类（默认按指纹复用）
 *
 * 输入: meta.json / comments.json / media.json，以及 转写.txt 或 口播.json（prepare.mjs 产出）
 * 产出: card.json（事实卡，勿手改）+ labels.json（评论逐条标注，旁路）
 *
 * 有 key 走语义链路（embedding → 近重复组 → LLM 标注 → k-means）；
 * 无 key / 调用失败自动退字数口径（无水评率与标签分布，簇仍会算）。
 * 评论指纹一致时直接复用上次聚类，不重复调计费接口。
 *
 * 纯 Node 标准库，零 npm 依赖。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// ---- 评论清洗（口径与 kiln 一致）----

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}]|\u{FE0F}/gu;
const 水词 = new Set(['666', '777', '888', '999', '哈哈哈', '来了', '支持', '打卡', '路过', '沙发', '第一', '转发了', '好', '不错']);

/** 剥 @提及、[表情占位]、emoji、空白标点，只留实义字符 */
function clean(t) {
  return String(t || '')
    .replace(/@[^\s@，,。.！!？?、]+/g, '')
    .replace(/\[[^\]]{1,6}\]/g, '')
    .replace(EMOJI, '')
    .replace(/[\s\p{P}\u00a1-\u00bf\u2000-\u206F]+/gu, '');
}

/** 有效评论：汉字 ≥6 或字母数字 ≥4，且不是纯水词 */
function isValid(t) {
  const c = clean(t);
  const cjk = (c.match(/[一-龥]/g) || []).length;
  const alnum = (c.match(/[A-Za-z0-9]/g) || []).length;
  if (cjk < 6 && alnum < 4) return false;
  return !水词.has(c);
}

// ---- 向量与聚类 ----

const norm = (v) => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};
const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

function kmeans(V, k, iters = 20) {
  const n = V.length;
  const centers = Array.from({ length: k }, (_, i) => [...V[Math.floor((i * n) / k)]]);
  const assign = new Array(n).fill(0);
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = -Infinity;
      for (let c = 0; c < k; c++) {
        const d = dot(V[i], centers[c]);
        if (d > bestD) { bestD = d; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; moved = true; }
    }
    const sums = Array.from({ length: k }, () => new Array(V[0].length).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      counts[assign[i]]++;
      for (let d = 0; d < V[0].length; d++) sums[assign[i]][d] += V[i][d];
    }
    for (let c = 0; c < k; c++) if (counts[c]) centers[c] = norm(sums[c]);
    if (!moved) break;
  }
  return { assign, centers };
}

/** 平均轮廓系数（cosine 距离），越大分簇越合理 */
function silhouette(V, assign) {
  const n = V.length;
  const k = new Set(assign).size;
  if (k < 2 || k >= n) return -1;
  const byCluster = new Map();
  for (let i = 0; i < n; i++) {
    if (!byCluster.has(assign[i])) byCluster.set(assign[i], []);
    byCluster.get(assign[i]).push(i);
  }
  let total = 0;
  for (let i = 0; i < n; i++) {
    const own = byCluster.get(assign[i]);
    if (own.length <= 1) continue;
    let a = 0;
    for (const j of own) if (j !== i) a += 1 - dot(V[i], V[j]);
    a /= own.length - 1;
    let b = Infinity;
    for (const [c, members] of byCluster) {
      if (c === assign[i]) continue;
      let d = 0;
      for (const j of members) d += 1 - dot(V[i], V[j]);
      b = Math.min(b, d / members.length);
    }
    total += (b - a) / Math.max(a, b);
  }
  return total / n;
}

/** 幂迭代求前两个主成分，降到 2D 给前端布局 */
function pca2d(V) {
  const n = V.length;
  if (!n) return [];
  const dim = V[0].length;
  const mean = new Array(dim).fill(0);
  for (const v of V) for (let d = 0; d < dim; d++) mean[d] += v[d] / n;
  const X = V.map((v) => v.map((x, d) => x - mean[d]));

  const topVec = (exclude) => {
    let vec = new Array(dim).fill(0).map((_, i) => Math.sin(i + 1));
    for (let it = 0; it < 60; it++) {
      const next = new Array(dim).fill(0);
      for (const row of X) {
        const p = dot(row, vec);
        for (let d = 0; d < dim; d++) next[d] += p * row[d];
      }
      if (exclude) {
        const proj = dot(next, exclude);
        for (let d = 0; d < dim; d++) next[d] -= proj * exclude[d];
      }
      const len = Math.hypot(...next) || 1;
      vec = next.map((x) => x / len);
    }
    return vec;
  };

  const pc1 = topVec(null);
  const pc2 = topVec(pc1);
  return X.map((row) => [dot(row, pc1), dot(row, pc2)]);
}

/** 簇关键词：取成员文本里出现 ≥2 次的 2 字片段 */
function keywords(members) {
  const freq = new Map();
  for (const t of members) {
    const s = clean(t);
    for (let i = 0; i + 1 < s.length; i++) {
      const g = s.slice(i, i + 2);
      if (!/[一-龥]/.test(g)) continue;
      freq.set(g, (freq.get(g) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([g]) => g);
}

// ---- 远端调用 ----

async function postJSON(cfg, path, body, timeoutMs) {
  let last = null;
  for (let attempt = 0; attempt < cfg.retries; attempt++) {
    try {
      const res = await fetch(`${cfg.baseUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs || cfg.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 160)}`);
      const j = await res.json();
      // 硅基流动余额不足等业务错：HTTP 200 但带 code
      if (j && typeof j.code === 'number' && j.code !== 200 && j.code !== 0) {
        throw new Error(`接口返回 code=${j.code} ${j.message || ''}`.trim());
      }
      return j;
    } catch (e) {
      last = e;
      await sleep(900 * (attempt + 1));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** embedding：批 ≤32（服务端硬上限），受并发约束 */
async function embedAll(texts, cfg) {
  const out = new Array(texts.length);
  let cursor = 0;
  const BATCH = 32;
  const worker = async () => {
    for (;;) {
      const start = cursor;
      cursor += BATCH;
      if (start >= texts.length) return;
      const slice = texts.slice(start, start + BATCH);
      const j = await postJSON(cfg, '/embeddings', { model: cfg.embedModel, input: slice });
      j.data.forEach((d, i) => { out[start + i] = norm(d.embedding); });
    }
  };
  await Promise.all(Array.from({ length: Math.min(cfg.concurrency, Math.ceil(texts.length / BATCH)) }, worker));
  return out;
}

// ---- LLM 标注 ----

const LABELS = ['water', 'emotion', 'ai_assist', 'intent', 'substance', 'spam'];
const SYS_LABEL = `你是抖音评论区分析器。给每条评论打且仅打一个标签：
- water：纯应景无信息（666/233/哈哈哈/来了/打卡/沙发/纯表情/纯@人接龙/"支持"；客套话如"谢谢分享""来支持啦"也算 water）
- emotion：情绪表达、共鸣、应援，无具体信息（"看哭了""听不懂""太顶了"）
- ai_assist：指挥评论区里的 AI 助手干活（"@豆包 总结""@豆包 提取文字"）
- intent：购买/价格/资源/追更/求教意向（"收费吗""求链接""怎么开通""有货吗""多少钱"）
- substance：有信息量——具体提问、故障/使用反馈、进度汇报（"我已经做完了"算这个）、经验讨论、对内容的具体评价、晒成果
- spam：广告、引流、复读视频标题蹭热度、模板控评、与视频无关的内容
边界规则：短但有意图的是 intent 不是 water；夸奖带具体信息（"时长很短但全是干货"）是 substance。
只输出 JSON 数组，形如 [{"i":1,"label":"substance"}]，不要其它文字。`;

const LLM_BATCH = 30;

async function labelBatch(items, cfg) {
  const body = {
    model: cfg.labelModel,
    messages: [
      { role: 'system', content: SYS_LABEL },
      { role: 'user', content: JSON.stringify(items.map((t, i) => ({ i: i + 1, t: t.slice(0, 120) }))) },
    ],
    temperature: 0,
    max_tokens: 2000,
  };
  const j = await postJSON(cfg, '/chat/completions', body, 90_000);
  const text = j?.choices?.[0]?.message?.content ?? '';
  const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
  const map = new Map();
  for (const x of arr) {
    const n = Number(x?.i);
    const l = String(x?.label || '');
    if (n >= 1 && n <= items.length && LABELS.includes(l)) map.set(n - 1, l);
  }
  return map;
}

/** 逐条标注；整批失败时对半拆再试，最多两层（再拆只是多烧请求） */
async function labelAll(texts, cfg, depth = 0) {
  const out = new Array(texts.length).fill(null);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const start = cursor;
      cursor += LLM_BATCH;
      if (start >= texts.length) return;
      const items = texts.slice(start, start + LLM_BATCH);
      try {
        const map = await labelBatch(items, cfg);
        for (const [i, l] of map) out[start + i] = l;
      } catch (e) {
        if (depth < 2 && items.length > 8) {
          const half = Math.ceil(items.length / 2);
          const left = await labelAll(items.slice(0, half), cfg, depth + 1);
          const right = await labelAll(items.slice(half), cfg, depth + 1);
          left.forEach((l, i) => { out[start + i] = l; });
          right.forEach((l, i) => { out[start + half + i] = l; });
        } else {
          console.error(`   标注批失败（留 unlabeled）：${e.message}`);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(cfg.concurrency, Math.ceil(texts.length / LLM_BATCH)) }, worker));
  return out;
}

/** 近重复模板组：cosine ≥0.95 且 ≥5 条，并查集合并 */
function nearDupGroups(V, minSize = 5) {
  const parent = V.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 0; i < V.length; i++) {
    for (let j = i + 1; j < V.length; j++) if (dot(V[i], V[j]) >= 0.95) parent[find(i)] = find(j);
  }
  const groups = new Map();
  V.forEach((_, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  });
  return [...groups.values()].filter((g) => g.length >= minSize).sort((a, b) => b.length - a.length);
}

// ---- 评论分析主流程 ----

/** 评论指纹：条数 + 每条文本/点赞/时间/地区。用来判断「评论没变就别重跑计费接口」 */
function commentFingerprint(rows) {
  const h = createHash('sha1');
  h.update(String(rows.length));
  for (const r of rows) h.update(`\u0001${r.text}\u0001${r.like}\u0001${r.t ?? ''}\u0001${r.region}`);
  return h.digest('hex').slice(0, 16);
}

async function analyzeComments(rows, cfg, useLLM) {
  const total = rows.length;
  const valid = rows.filter((r) => isValid(r.text));

  // 降级：字数口径
  const 字数口径 = () => ({
    total, validCount: valid.length,
    水评率: total ? Number(((total - valid.length) / total).toFixed(3)) : 0,
    口径: '字数', 分布: null, 模板组: [], 簇: [], 明细: null,
  });

  if (!useLLM) {
    console.log('   --no-llm：评论走字数口径');
    return 字数口径();
  }
  if (!cfg.apiKey) {
    console.log('   没有配置 key，评论走字数口径（无簇、无标签分布、无模板组）');
    console.log('   配一次：node config.mjs --set-key sk-xxx');
    return 字数口径();
  }

  const texts = valid.map((r) => clean(r.text));
  let V;
  try {
    console.log(`   embedding ${texts.length} 条…`);
    V = await embedAll(texts, cfg);
  } catch (e) {
    console.error(`   embedding 失败，退字数口径：${e.message}`);
    return 字数口径();
  }

  // 标注（失败单条留 unlabeled，不阻断）
  console.log(`   标注 ${texts.length} 条…`);
  const labels = await labelAll(texts, cfg);
  const labeled = labels.map((l) => l || 'unlabeled');

  const dist = {};
  for (const l of labeled) dist[l] = (dist[l] || 0) + 1;

  // 模板组：同义复读按多数票定标签
  const groups = nearDupGroups(V);
  const 模板组 = groups.slice(0, 12).map((g, gi) => {
    const votes = {};
    for (const i of g) votes[labeled[i]] = (votes[labeled[i]] || 0) + 1;
    const label = Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
    const likes = g.reduce((s, i) => s + (valid[i].like || 0), 0);
    const rep = [...g].sort((a, b) => (valid[b].like || 0) - (valid[a].like || 0))[0];
    return { 代表句: valid[rep].text.slice(0, 60), 条数: g.length, 赞合计: likes, 归并标签: label, 组: gi + 1 };
  });

  // 聚类只吃有内容的三类
  const 可聚类 = ['substance', 'intent', 'emotion'];
  const idx = labeled.map((l, i) => (可聚类.includes(l) ? i : -1)).filter((i) => i >= 0);

  let 簇 = [];
  if (idx.length >= 8) {
    const W = idx.map((i) => V[i]);
    const kMin = Math.max(2, Math.min(4, Math.floor(idx.length / 10)));
    const kMax = Math.max(kMin, Math.min(8, Math.floor(idx.length / 6)));
    let best = null;
    for (let k = kMin; k <= kMax; k++) {
      const { assign } = kmeans(W, k);
      const sc = silhouette(W, assign);
      if (!best || sc > best.sc) best = { k, assign, sc };
    }
    const coords = pca2d(W);
    const byCluster = new Map();
    best.assign.forEach((c, i) => {
      if (!byCluster.has(c)) byCluster.set(c, []);
      byCluster.get(c).push(i);
    });
    簇 = [...byCluster.entries()]
      .filter(([, members]) => members.length >= 3)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([c, members], ci) => {
        const likes = members.reduce((s, i) => s + (valid[idx[i]].like || 0), 0);
        const rep = members
          .slice()
          .sort((a, b) => (valid[idx[b]].like || 0) - (valid[idx[a]].like || 0))
          .slice(0, 3)
          .map((i) => valid[idx[i]].text.slice(0, 60));
        return {
          id: ci + 1,
          成员数: members.length,
          赞合计: likes,
          代表句: rep,
          关键词: keywords(members.map((i) => valid[idx[i]].text)),
          x: Number(avg(members.map((i) => coords[i][0])).toFixed(3)),
          y: Number(avg(members.map((i) => coords[i][1])).toFixed(3)),
        };
      });
    console.log(`   聚类 ${簇.length} 簇（k=${best.k}，轮廓 ${best.sc.toFixed(3)}）`);
  } else {
    console.log(`   有效评论 ${idx.length} 条，不足 8 条不聚类`);
  }

  // 明细旁路
  const 明细 = valid.map((r, i) => ({
    i, txt: r.text, like: r.like, t: r.t ?? null,
    label: labeled[i],
    模板组: groups.findIndex((g) => g.includes(i)) + 1 || null,
    簇: (() => {
      const pos = idx.indexOf(i);
      return pos < 0 ? null : null;
    })(),
  }));

  return {
    total,
    validCount: valid.length,
    水评率: total ? Number((((dist.water || 0) + (dist.spam || 0)) / total).toFixed(3)) : 0,
    口径: '语义',
    分布: dist,
    模板组,
    簇,
    明细,
  };
}

// ---- 地区与时间分布 ----

const PROVINCES = new Set([
  '北京', '天津', '上海', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽',
  '福建', '江西', '山东', '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西',
  '甘肃', '青海', '台湾', '内蒙古', '广西', '西藏', '宁夏', '新疆', '香港', '澳门',
]);

const 归一 = (s) => String(s || '').replace(/^中国(?=台湾|香港|澳门)/, '');

function regionFacts(rows) {
  const top = new Map();
  let 境内 = 0, 境外 = 0, 未知 = 0;
  const 省 = new Set();
  const 境外地区 = new Set();
  for (const r of rows) {
    const g = 归一(r.region);
    if (!g) { 未知++; continue; }
    if (PROVINCES.has(g)) {
      境内++; 省.add(g);
      top.set(g, (top.get(g) || 0) + 1);
    } else if (/未知|IP/.test(g)) {
      未知++;
    } else {
      境外++; 境外地区.add(g);
    }
  }
  return {
    地区Top: [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([名, 条数]) => ({ 名, 条数 })),
    覆盖省级行政区: 省.size,
    境内条数: 境内,
    境外条数: 境外,
    IP未知条数: 未知,
    境外地区: [...境外地区].slice(0, 10),
  };
}

function timeFacts(rows, publishSec) {
  if (!publishSec) return null;
  const buckets = [
    ['≤1天', 1], ['≤3天', 3], ['≤7天', 7], ['≤14天', 14],
    ['≤30天', 30], ['≤60天', 60], ['≤120天', 120], ['>120天', Infinity],
  ];
  const out = {};
  let 已用 = 0;
  for (const r of rows) {
    if (!r.t) continue;
    const days = (r.t - publishSec) / 86400;
    if (days < 0) continue;
    const b = buckets.find(([, d]) => days <= d);
    if (b) { out[b[0]] = (out[b[0]] || 0) + 1; 已用++; }
  }
  if (!已用) return null;
  const sorted = {};
  for (const [name] of buckets) if (out[name]) sorted[name] = out[name];
  return sorted;
}

// ---- 转写与内容轴 ----

function parseTranscript(file) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const m = line.match(/^\[(\d+):([\d.]+)\]\s*(.+)$/);
    if (!m) continue;
    out.push({ t: Number(m[1]) * 60 + Number(m[2]), s: m[3].trim() });
  }
  return out;
}

const spokenChars = (s) => {
  const c = clean(s);
  return (c.match(/[一-龥]/g) || []).length + Math.floor((c.match(/[A-Za-z0-9]/g) || []).length / 2);
};

const BUCKET = 30;

function contentFacts(segs, durSec, shots) {
  if (!durSec) return {};
  const 切镜每分钟 = shots == null ? null : Number((shots / (durSec / 60)).toFixed(2));

  // 无有效口播（纯音乐 / 只有片尾口号）时仍要给出切镜密度 ——
  // 纯画面视频的节奏全靠这一项，不能因为没口播稿就把整个内容轴丢掉。
  if (!segs.length) {
    return {
      内容轴: { 语速: null, 口播覆盖率: null, 口播段数: 0, 首句秒: null, 切镜每分钟 },
    };
  }

  const total = segs.reduce((a, x) => a + spokenChars(x.s), 0);
  const last = segs[segs.length - 1].t;
  const n = Math.max(1, Math.ceil(durSec / BUCKET));
  const curve = new Array(n).fill(0);
  for (const x of segs) curve[Math.min(n - 1, Math.floor(x.t / BUCKET))] += spokenChars(x.s);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const half = Math.floor(n / 2);
  const mean = sum(curve) / n;
  let min = Infinity, minAt = 0;
  curve.forEach((v, i) => { if (v < min) { min = v; minAt = i * BUCKET; } });
  return {
    内容轴: {
      语速: Math.round(total / (durSec / 60)),
      口播覆盖率: Number((last / durSec).toFixed(2)),
      口播段数: segs.length,
      首句秒: segs[0].t,
      切镜每分钟,
    },
    密度曲线: curve,
    密度统计: {
      均值: Math.round(mean),
      最低: min,
      最低秒: minAt,
      低洼数: curve.filter((v) => v < mean * 0.5).length,
      零桶数: curve.filter((v) => v === 0).length,
      前半: half > 0 ? Math.round(sum(curve.slice(0, half)) / half) : 0,
      后半: n - half > 0 ? Math.round(sum(curve.slice(half)) / (n - half)) : 0,
    },
  };
}

// ---- 主流程 ----

async function main() {
  const argv = process.argv.slice(2);
  const raw = argv.find((a) => !a.startsWith('--'));
  const force = argv.includes('--force');
  const noLLM = argv.includes('--no-llm');
  if (!raw) {
    console.error('用法: node card.mjs <视频目录> [--force] [--no-llm]');
    process.exit(1);
  }
  const dir = resolve(raw);
  const cardFile = join(dir, 'card.json');
  if (existsSync(cardFile) && !force) {
    console.log(`card.json 已存在，跳过（--force 重跑）：${cardFile}`);
    return;
  }

  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const cj = JSON.parse(readFileSync(join(dir, 'comments.json'), 'utf8'));
  const media = existsSync(join(dir, 'media.json')) ? JSON.parse(readFileSync(join(dir, 'media.json'), 'utf8')) : null;

  const rows = (cj.comments || []).map((c) => ({
    text: String(c.text || ''),
    like: Number(c.digg || 0),
    t: c.createTime ? Number(c.createTime) : null,
    region: String(c.region || ''),
    nickname: String(c.nickname || ''),
  }));
  const segs = parseTranscript(join(dir, '转写.txt'));
  const speechFile = join(dir, '口播.json');
  // 三种状态要说清：有口播 / 判为纯音乐 / 根本没跑 ASR。混成一种，agent 会写错缺口原因。
  const speechJudgement = segs.length
    ? null
    : existsSync(speechFile)
      ? JSON.parse(readFileSync(speechFile, 'utf8'))
      : { 判定: '未转写', 原因: '既没有 转写.txt 也没有 口播.json —— ASR 未跑或失败，口播维度缺底座' };
  const cfg = loadConfig();
  const durSec = Number(meta.durationSec || 0);
  const shots = media?.切镜数 ?? null;

  console.log(
    speechJudgement
      ? `评论 ${rows.length} 条 / ${speechJudgement.判定} / 时长 ${durSec}s`
      : `评论 ${rows.length} 条 / 口播 ${segs.length} 句 / 时长 ${durSec}s`,
  );

  const 指纹 = commentFingerprint(rows);
  const prevCard = existsSync(cardFile) ? JSON.parse(readFileSync(cardFile, 'utf8')) : null;
  const 可复用 =
    !argv.includes('--rebuild-comments') &&
    !noLLM &&
    prevCard?.评论?.指纹 === 指纹 &&
    prevCard?.评论?.聚类?.口径 === '语义';

  if (noLLM && prevCard?.评论?.聚类?.口径 === '语义') {
    console.log('注意：--no-llm 会把已有的语义口径降级为字数口径（簇与标签分布都会丢）');
  }

  let comment;
  if (可复用) {
    console.log(`评论未变（指纹 ${指纹}），复用上次聚类，不重复调计费接口`);
    comment = {
      total: prevCard.评论.采到,
      validCount: prevCard.评论.有效数,
      水评率: prevCard.评论.聚类.水评率,
      口径: prevCard.评论.聚类.口径,
      分布: prevCard.评论.聚类.分布,
      模板组: prevCard.评论.聚类.模板组,
      簇: prevCard.评论.聚类.簇,
      明细: null,
    };
  } else {
    comment = await analyzeComments(rows, cfg, !noLLM);
  }

  const stats = meta.stats || {};
  const ratio = (a, b) => (Number(b) ? Number((Number(a) / Number(b)).toFixed(3)) : null);

  const card = {
    视频: {
      id: meta.id,
      标题: (meta.desc || '').slice(0, 60),
      文案: meta.desc || '',
      作者: meta.author || null,
      时长秒: durSec,
      发布时间: meta.createTime || null,
      数据: {
        赞: stats.digg ?? null, 评: stats.comment ?? null,
        藏: stats.collect ?? null, 转: stats.share ?? null, 播: stats.play ?? null,
      },
      比例: {
        藏赞比: ratio(stats.collect, stats.digg),
        评赞比: ratio(stats.comment, stats.digg),
        转赞比: ratio(stats.share, stats.digg),
      },
      话题: meta.topics || [],
      封面: meta.cover || null,
      章节: Array.isArray(meta.chapterList) ? meta.chapterList : [],
    },
    口播稿: segs,
    // prepare 判为纯音乐时会写 口播.json：让 agent 知道「不是漏转写，是真没口播」，
    // 别在缺口里写「未转写」，也别在口播维度编内容。
    ...(speechJudgement ? { 口播判定: speechJudgement } : {}),
    ...contentFacts(segs, durSec, shots),
    画面: media?.失败
      ? { 失败: media.失败 }
      : media
        ? { 切镜数: media.切镜数, 切镜: media.切镜, 帧: media.帧, 拼图: media.拼图 }
        : { 失败: '没有 media.json（prepare 未跑或失败）' },
    评论: {
      指纹,
      采到: comment.total,
      有效数: comment.validCount,
      聚类: {
        总条数: comment.total,
        有效数: comment.validCount,
        水评率: comment.水评率,
        口径: comment.口径,
        分布: comment.分布,
        模板组: comment.模板组,
        簇: comment.簇,
      },
      ...regionFacts(rows),
      时间分布: timeFacts(rows, meta.createTime || null),
    },
    生成于: new Date().toISOString(),
  };

  writeFileSync(cardFile, JSON.stringify(card, null, 2), 'utf8');
  if (comment.明细) writeFileSync(join(dir, 'labels.json'), JSON.stringify(comment.明细, null, 2), 'utf8');

  console.log(`\ncard 完成：${cardFile}`);
  console.log(`  评论口径 ${comment.口径} / 水评率 ${(comment.水评率 * 100).toFixed(1)}% / 簇 ${comment.簇.length}`);
  console.log('下一步：让 agent 读 card.json 与拼图，写 report.json，再跑 check.mjs');
}

main().catch((e) => {
  console.error(`\nERROR: ${e.message}`);
  process.exit(1);
});
