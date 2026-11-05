#!/usr/bin/env node
/**
 * collect.js — 抖音爆款视频自动采集（浏览 → 富化 → 预筛 → 裁决 → 下载）
 *
 * 应用层 skill `douyin-viral-collect` 的执行体。CDP 能力和单条下载在
 * `cdp-autorunner-skill`，本脚本只负责「从哪找候选、要不要这条」。
 *
 * 用法：
 *   node collect.js plan   --source search --query "AI,AI工具" \
 *                          --dur short,mid --count 20 --focus topic \
 *                          --criteria "AI 实操演示，不要卖课" --out ./videos
 *   node collect.js next   --session <sid>
 *   node collect.js commit --session <sid> --keep "id1,id2" --skip "id3=广告"
 *   node collect.js comments [--ids "id1,id2"] [--limit 100] [--force]
 *   node collect.js status [--session <sid>]
 *
 * 采集入口（--source）：
 *   search  关键词搜索页，滚动提 id
 *   user    博主主页作品列表，滚动提 id
 *   feed    首页推荐流，切「下一条」逐条提 id
 *
 * 数据来源：
 *   列表页 DOM 只提视频 id，元数据全部来自页内 fetch `aweme/detail`。
 *   该接口必须在详情页上下文调用（搜索页会被页面 Service Worker 拦成 HTML），
 *   所以先开一个详情页当跳板，再在里面批量拉候选。
 *
 * 接口不返回：play_count（恒为 0）、完播率、涨粉数、流量来源、author.aweme_count。
 *
 * 产物：
 *   <out>/<id>/video.mp4 / meta.json / comments.json
 *   <out>/_collect/index.json                跨会话去重索引
 *   <out>/_collect/<sid>/{plan,batch-NN,verdict-NN,state}.json + covers/
 *
 * 纯 Node 标准库，零 npm 依赖。需 Node >= 18。
 */

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** 产物默认落全局，和选题库同一个根目录，方便面板统一管理 */
const DEFAULT_OUT = process.env.DOUYIN_COLLECT_DIR ||
  path.join(os.homedir(), '.douyin-viral-blueprint', 'collect');
const PANEL_PORTS = [8800, 8801, 8802, 8803, 8804, 8805, 8806, 8807, 8808, 8809];

// ---- 定位 cdp-autorunner-skill ----
//
// 两个 skill 的安装深度不一样：部署时都在 ~/.workbuddy/skills/ 平级，
// 开发时一个在项目根 cdp-autorunner-skill/、一个在 skills/ 下。
// 所以不写死相对路径，把能想到的候选都列出来，再挑一个「既有 douyin-download.js
// 又有 cdp-server 二进制」的 —— 源码目录通常没有二进制（不进 git），不能只按名字命中。
function findCoreSkill() {
  const binName = process.platform === 'win32' ? 'cdp-server.exe' : 'cdp-server';
  const candidates = [];

  if (process.env.CDP_SKILL_DIR) candidates.push(path.resolve(process.env.CDP_SKILL_DIR));

  // ① 从当前脚本向上逐级找同级目录
  let dir = __dirname;
  for (let i = 0; i < 4; i++) {
    dir = path.dirname(dir);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) if (/^cdp-autorunner-skill/.test(n)) candidates.push(path.join(dir, n));
  }

  // ② 再兜一层用户级 skill 目录（开发时源码目录没有二进制，真实可用的那份在安装目录）
  const userSkills = path.join(require('os').homedir(), '.workbuddy', 'skills');
  try {
    for (const n of fs.readdirSync(userSkills)) {
      if (/^cdp-autorunner-skill/.test(n)) candidates.push(path.join(userSkills, n));
    }
  } catch { /* 目录不存在就算了 */ }

  const usable = candidates.filter((d) => fs.existsSync(path.join(d, 'scripts', 'douyin', 'douyin-download.js')));
  if (!usable.length) {
    throw new Error('找不到 cdp-autorunner-skill —— 先安装该 skill，或用 CDP_SKILL_DIR 指定它的根目录');
  }
  const withBin = usable.find((d) => fs.existsSync(path.join(d, 'scripts', binName))) ||
    (process.env.CDP_SERVER ? usable[0] : null); // 显式指定了二进制就不强制目录里有
  if (!withBin) {
    throw new Error(
      `找到 cdp-autorunner-skill 但缺 cdp-server 二进制：${usable.join(' / ')}\n` +
      '  按核心 skill 的 I-0 下载，或用 CDP_SERVER 指定二进制路径',
    );
  }
  return path.join(withBin, 'scripts');
}

const CORE_DIR = findCoreSkill();
const CDP_BIN = process.env.CDP_SERVER ||
  path.join(CORE_DIR, process.platform === 'win32' ? 'cdp-server.exe' : 'cdp-server');
const DOWNLOAD_JS = path.join(CORE_DIR, 'douyin', 'douyin-download.js');

const SITE = 'https://www.douyin.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 各命令超时不同，不能共用一个值（见 SKILL.md「超时值不是统一的 30s」） */
const T = {
  newTab: 20_000,
  goto: 35_000,
  eval: 30_000,
  enrich: 60_000,   // 一批 10~20 条并发 fetch，留足
  click: 10_000,
  close: 15_000,
};

// ---- cdp 封装 ----

function cdp(args, timeout) {
  const r = spawnSync(CDP_BIN, ['browser', ...args], {
    encoding: 'utf-8', timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) {
    if (r.error.code === 'ENOENT') {
      throw new Error(`找不到 cdp-server（找的是 ${CDP_BIN}）—— 按 SKILL.md 的 I-0 下载二进制，或用 CDP_SERVER 指定路径`);
    }
    if (r.error.code === 'ETIMEDOUT') throw new Error(`命令超时（${timeout}ms）：${args[0]} —— 先确认扩展是否连上`);
    throw r.error;
  }
  const out = (r.stdout || '').trim();
  const err = (r.stderr || '').trim();
  if (r.status !== 0) throw new Error(err || out || `exit code ${r.status}`);
  if (/^(ERROR:\s*)+/i.test(out)) throw new Error(out.replace(/^(ERROR:\s*)+/i, ''));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.floor(Math.random() * (b - a));

/**
 * eval-target 的容错包装。SPA 二次导航会让扩展的 chrome.debugger 被 detach，
 * 报 `Detached while handling command` —— 偶发，退避重试即可。
 * 只重试基础设施类错误，业务错误（接口没数据）重试无意义。
 */
async function evalOn(target, script, timeout, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return cdp(['eval-target', target, script], timeout);
    } catch (e) {
      lastErr = e;
      if (!/detached|超时|timed out|no target|not found/i.test(e.message) || i === tries) break;
      if (process.env.CDP_DEBUG) console.error(`[eval-retry ${i}]`, e.message);
      await sleep(1_200 * i);
    }
  }
  throw lastErr;
}

// ---- 常量 ----

/** 时长档，单位秒。边界值归 mid：正好 180s / 1200s 都算 mid。 */
const BANDS = { short: [0, 180], mid: [180, 1200], long: [1200, Infinity] };

/**
 * 客观分权重。focus 决定「什么样算好」，同一套代码覆盖不同采集目的：
 *   topic   选题参考 —— 看数据能不能跑起来
 *   craft   结构表达 —— 看收藏率（实用型内容才值得逐帧学）
 *   account 账号打法 —— 看赞粉比（小号出圈最有借鉴意义）
 *   all     都要
 */
const FOCUS_W = {
  topic: { digg: 0.45, ratio: 0.40, qual: 0.15 },
  craft: { digg: 0.25, ratio: 0.25, qual: 0.50 },
  account: { digg: 0.30, ratio: 0.55, qual: 0.15 },
  all: { digg: 0.34, ratio: 0.33, qual: 0.33 },
};

// ---- 通用工具 ----

function bandOf(sec) {
  if (sec < 180) return 'short';
  if (sec <= 1200) return 'mid';
  return 'long';
}

function fmtDur(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m${String(r).padStart(2, '0')}s`;
}

function ageDays(ts) {
  if (!ts) return null;
  return Math.floor((Date.now() / 1000 - ts) / 86400);
}

function fmtAge(d) {
  if (d === null) return '-';
  if (d <= 0) return '今天';
  if (d < 30) return `${d}天前`;
  if (d < 365) return `${Math.floor(d / 30)}个月前`;
  return `${Math.floor(d / 365)}年前`;
}

/** 百分位（0..1），同值取同位次。用于池内相对比较 —— 不设绝对阈值。 */
function rankPct(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  idx.forEach(([, i], k) => { out[i] = values.length > 1 ? k / (values.length - 1) : 0.5; });
  return out;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function readJson(p, dflt = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; }
}

function writeJson(p, data) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

// ---- 会话与状态 ----

function collectRoot(out) { return path.join(out, '_collect'); }
function sessionDir(out, sid) { return path.join(collectRoot(out), sid); }

/**
 * 跨会话去重索引。两层：
 *   collected  已下载（永远跳过）
 *   skipped    agent 判过不要（默认也跳过，--retry-skipped 可重判）
 * 存的是精简快照，不存整份接口数据，避免索引越滚越大。
 */
function loadIndex(out) {
  return readJson(path.join(collectRoot(out), 'index.json'), { collected: {}, skipped: {} });
}

function saveIndex(out, idx) {
  writeJson(path.join(collectRoot(out), 'index.json'), idx);
}

function snapshot(item, status, extra = {}) {
  return {
    s: status,
    at: new Date().toISOString(),
    durSec: Math.round(item.durMs / 1000),
    digg: item.stats?.digg ?? null,
    fans: item.author?.fans ?? null,
    nick: item.author?.nick ?? null,
    desc: (item.desc || '').slice(0, 60),
    ...extra,
  };
}

// ---- ① 扫描：只提 id，不解析卡片字段 ----
//
// 为什么不从卡片拿数据：搜索页/主页卡片的时长、粉丝数不全，且依赖哈希类名，
// 改版就失效。接口字段完整且稳定，DOM 只干它最擅长的 —— 给出「有哪些 id」。

/** 从当前页所有视频链接里提取 id，边滚边累积（列表可能是虚拟滚动，DOM 会回收） */
const EXTRACT_IDS = [
  '(function(){',
  'var out=[];',
  'var as=document.querySelectorAll(\'a[href*="/video/"]\');',
  'for(var i=0;i<as.length;i++){',
  'var m=(as[i].getAttribute("href")||"").match(/video\\/(\\d{15,})/);',
  'if(m)out.push(m[1]);',
  '}',
  'var f=document.querySelector(\'[data-e2e="feed-video"]\');',
  'if(f){var v=f.getAttribute("data-e2e-vid");if(v)out.push(v);}',
  'return JSON.stringify(out);',
  '})()',
].join('');

async function newTab(url = 'about:blank') {
  const raw = cdp(['new-tab', url], T.newTab);
  const tid = raw.replace(/^NEW-TAB:\s*/, '').trim();
  if (!/^[0-9A-F]{16,}$/i.test(tid)) throw new Error(`new-tab 未返回 targetId（多半是扩展未连上）：${raw}`);
  return tid;
}

/** 滚动 + 提取，直到攒够 want 条**新** id 或滚够 maxScroll 次 */
async function scrollCollect(target, want, maxScroll, skip) {
  const seen = new Set();
  let idle = 0;
  for (let i = 0; i < maxScroll && seen.size < want; i++) {
    let list = [];
    try { list = JSON.parse(await evalOn(target, EXTRACT_IDS, T.eval)); } catch { /* 页面切换中，下一轮再试 */ }
    const before = seen.size;
    for (const id of list) if (!skip.has(id)) seen.add(id);
    if (seen.size >= want) break;
    // 连续三屏都没新增 = 列表见底或没滚到懒加载区，收工
    if (seen.size === before) { if (++idle >= 3) break; } else idle = 0;
    cdp(['scroll', String(jitter(1800, 2600))], 5_000);
    await sleep(jitter(900, 1600));
  }
  return [...seen];
}

async function scanSearch(plan, want, skip) {
  const kws = String(plan.query).split(',').map((s) => s.trim()).filter(Boolean);
  const ids = new Set();
  const target = await newTab();
  try {
    for (const kw of kws) {
      if (ids.size >= want) break;
      const url = `${SITE}/search/${encodeURIComponent(kw)}?type=video`;
      console.log(`   搜索「${kw}」`);
      cdp(['goto-target', target, url], T.goto);
      await sleep(jitter(2500, 3500));
      const got = await scrollCollect(target, want - ids.size, 12, new Set([...skip, ...ids]));
      got.forEach((id) => ids.add(id));
      console.log(`      +${got.length} 条新候选（累计 ${ids.size}）`);
      await sleep(jitter(800, 1500));
    }
  } finally {
    cdp(['close-tab', target], T.close);
  }
  return [...ids];
}

async function scanUser(plan, want, skip) {
  const raw = String(plan.query).split(',')[0].trim();
  const secUid = (raw.match(/user\/([A-Za-z0-9_-]+)/) || [])[1] || raw;
  const target = await newTab();
  try {
    console.log(`   博主主页 ${secUid.slice(0, 12)}…`);
    cdp(['goto-target', target, `${SITE}/user/${secUid}`], T.goto);
    await sleep(jitter(3000, 4000));
    return await scrollCollect(target, want, 14, skip);
  } finally {
    cdp(['close-tab', target], T.close);
  }
}

/**
 * 推荐流：一次只有一条，靠切「下一条」累积。
 * id 从 [data-e2e="feed-video"] 的 data-e2e-vid 属性取。
 * 切条用 video-switch-next-arrow 按钮，比滚轮可靠。
 */
async function scanFeed(plan, want, skip) {
  const target = await newTab(`${SITE}/?recommend=1`);
  const ids = new Set();
  try {
    await sleep(jitter(4000, 5500));
    for (let i = 0; i < want * 4 && ids.size < want; i++) {
      try {
        const id = (await evalOn(target, 'document.querySelector(\'[data-e2e="feed-video"]\')?.getAttribute("data-e2e-vid")||""', T.eval)).trim();
        if (/^\d{15,}$/.test(id) && !skip.has(id)) ids.add(id);
      } catch { /* 切换动画期间 DOM 短暂缺失，忽略 */ }
      if (ids.size >= want) break;
      try { cdp(['click', '[data-e2e="video-switch-next-arrow"]'], T.click); } catch { /* 到底了 */ }
      await sleep(jitter(1200, 2000));
    }
  } finally {
    cdp(['close-tab', target], T.close);
  }
  return [...ids];
}

// ---- ② 富化：详情页跳板 + 批量拉接口 ----
//
// 跳板 = 随便一条真实视频的详情页。作用是给 fetch 一个「同源且不被 SW 拦」的上下文。
// 搜索页上下文调 detail 会被 SW 拦成 HTML，必须用详情页上下文。
//
// 返回体只挑决策需要的字段，避免一次 eval 拉回上百 KB。直链（direct）留到下载用。

function enrichScript(ids) {
  return [
    '(async()=>{',
    'const Q="device_platform=webapp&aid=6383&channel=channel_pc_web&update_version_code=170400',
    '&pc_client_type=2&version_code=170400&version_name=17.4.0&cookie_enabled=true&platform=PC";',
    'const D="https://www.douyin.com/aweme/v1/web/aweme/detail/?"+Q+"&request_source=600&origin_type=video_page&aweme_id=";',
    `const ids=${JSON.stringify(ids)};`,
    'const one=async(id)=>{try{',
    'const r=await fetch(D+id,{credentials:"include"});',
    'const j=await r.json();const a=j&&j.aweme_detail;',
    'if(!a)return null;',
    'const au=a.author||{},v=a.video||{},s=a.statistics||{},m=a.music||{};',
    'const br=(v.bit_rate||[]).map(x=>x.bit_rate||0);',
    'const dl=((v.download_addr&&v.download_addr.url_list)||[])[0]||((v.play_addr&&v.play_addr.url_list)||[])[0]||null;',
    'const st=a.status||{};',
    'return {id:id,',
    'durMs:a.duration||v.duration||0,',
    'createTime:a.create_time||0,',
    'desc:(a.desc||"").slice(0,300),',
    'tags:((a.text_extra)||[]).map(x=>x.hashtag_name).filter(Boolean).slice(0,8),',
    'author:{nick:au.nickname||"",secUid:au.sec_uid||"",uniqueId:au.unique_id||"",',
    'fans:au.follower_count||0,totalFav:au.total_favorited||0,',
    'verify:au.verification_type||0,signature:(au.signature||"").slice(0,100)},',
    'stats:{digg:s.digg_count||0,comment:s.comment_count||0,share:s.share_count||0,collect:s.collect_count||0},',
    'video:{w:v.width||0,h:v.height||0,isLong:!!v.is_long_video,brMax:br.length?Math.max.apply(null,br):0,gears:br.length},',
    'music:{title:m.title||""},',
    'flags:{aigc:!!a.is_aigc_media,ads:!!a.is_ads,commerce:!!a.commerce_config_data,',
    'anchors:(a.anchors||[]).length,top:!!a.is_top,deleted:!!(st.is_delete||st.is_prohibited)},',
    'direct:dl,cover:((v.cover&&v.cover.url_list)||[])[0]||null};',
    '}catch(e){return null}};',
    'const out=await Promise.all(ids.map(one));',
    'return JSON.stringify(out.filter(Boolean));',
    '})()',
  ].join('');
}

/** 打开一条视频详情页当跳板；失败就换下一条候选试 */
async function openDetail(ids) {
  for (const id of ids.slice(0, 3)) {
    let target;
    try {
      // 直接带 URL 开新 tab：比 about:blank → goto 少一次导航，冷启动能省 2~3s
      target = await newTab(`${SITE}/video/${id}`);
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const n = Number(await evalOn(target, 'document.querySelectorAll(\'[data-e2e="video-detail"]\').length', T.eval)) || 0;
        if (n > 0) return target;
        await sleep(400);
      }
      cdp(['close-tab', target], T.close);
    } catch (e) {
      if (target) { try { cdp(['close-tab', target], T.close); } catch { /* ignore */ } }
      if (process.env.CDP_DEBUG) console.error('[jump]', id, e.message);
    }
  }
  throw new Error('无法打开详情页跳板 —— 检查抖音是否已登录、Chrome 是否堆积了过多标签页，或候选 id 全部失效');
}

/** 富化一批 id。每批 10 条并发，分批留余量。 */
async function enrich(ids) {
  if (!ids.length) return [];
  const target = await openDetail(ids);
  const out = [];
  try {
    for (let i = 0; i < ids.length; i += 10) {
      const chunk = ids.slice(i, i + 10);
      const r = JSON.parse(await evalOn(target, enrichScript(chunk), T.enrich));
      out.push(...r);
      if (i + 10 < ids.length) await sleep(jitter(300, 700));
    }
  } finally {
    cdp(['close-tab', target], T.close);
  }
  return out;
}

// ---- ③ 封面（agent 判图用）----

/**
 * 并发拉封面。为什么需要：抖音大量视频文案只有几个 tag、甚至完全为空，
 * 这时封面是唯一能判断「讲的是什么」的信号；有文案时封面也能验证是不是标题党。
 *
 * 属于增强项 —— 任一张失败都不影响主流程，对应字段留 null 即可。
 * 抖音 CDN 国内直连可达，不走代理（Node 内置 fetch 本来也读不到系统代理）。
 */
async function downloadCovers(items, dir, conc = 5) {
  const queue = items.filter((x) => x.cover);
  if (!queue.length) return 0;
  const coverDir = ensureDir(path.join(dir, 'covers'));
  let ok = 0;
  const worker = async () => {
    for (;;) {
      const it = queue.shift();
      if (!it) return;
      try {
        const res = await fetch(it.cover, {
          headers: { 'user-agent': UA, referer: `${SITE}/` },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1024) continue; // 多半是被拦截后的占位图
        const dest = path.join(coverDir, `${it.id}.jpg`);
        fs.writeFileSync(dest, buf);
        it.coverPath = dest;
        ok++;
      } catch { /* 封面失败不阻断采集 */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, queue.length) }, worker));
  return ok;
}

// ---- ④ 预筛 + 打分 ----

/** 返回 null 表示通过，否则返回淘汰原因（原因会记进日志，便于事后调参） */
function prefilter(item, plan, index) {
  if (index.collected[item.id]) return 'already-collected';
  if (index.skipped[item.id] && !plan.retrySkipped) return 'already-skipped';
  if (item.flags?.deleted) return 'deleted';
  const sec = item.durMs / 1000;
  if (!sec) return 'no-duration';
  if (!plan.dur.includes(bandOf(sec))) return `duration:${bandOf(sec)}`;
  return null;
}

/**
 * 客观分。全部用池内百分位，不用绝对阈值 ——
 * 赞粉比在候选池内可能跨数个数量级，固定阈值会误杀。
 */
function scoreItems(items, plan) {
  const w = FOCUS_W[plan.focus] || FOCUS_W.all;
  const digg = items.map((x) => x.stats.digg);
  const ratio = items.map((x) => x.stats.digg / Math.max(x.author.fans, 1000));
  const qual = items.map((x) => (x.stats.digg ? x.stats.collect / x.stats.digg : 0));
  const pDigg = rankPct(digg);
  const pRatio = rankPct(ratio);
  const pQual = rankPct(qual);

  items.forEach((it, i) => {
    const d = it.stats.digg || 0;
    const c = it.stats.collect || 0;
    const s = it.stats.share || 0;
    const cm = it.stats.comment || 0;
    const durSec = Math.round(it.durMs / 1000);

    it.durSec = durSec;
    it.band = bandOf(durSec);
    it.ageDays = ageDays(it.createTime);
    it.metrics = {
      // 赞粉比：低粉爆款的核心信号
      ratio: +(d / Math.max(it.author.fans, 1000)).toFixed(3),
      // 占作者历史总获赞比：这条内容在作者作品里的分量（aweme_count 拿不到，用它替代）
      favSharePct: it.author.totalFav ? +(d / it.author.totalFav * 100).toFixed(2) : null,
      collectRatePct: d ? +(c / d * 100).toFixed(1) : 0,
      shareRatePct: d ? +(s / d * 100).toFixed(1) : 0,
      commentRatePct: d ? +(cm / d * 100).toFixed(1) : 0,
    };
    it.proof = +(1 + 4 * (w.digg * pDigg[i] + w.ratio * pRatio[i] + w.qual * pQual[i])).toFixed(2);
    it.contentType = classifyContent(it.metrics);
  });

  return items.sort((a, b) => b.proof - a.proof);
}

/**
 * 内容性质标签。三率刻画内容形态，与「火不火」正交：
 * 收藏率高 = 工具/教程，分享率高 = 观点/情绪，评论率高 = 争议/共鸣。
 *
 * 收藏率经常超过 100%（收藏不需要先点赞），所以按「三率谁最突出」排优先级，
 * 而不是套固定区间。
 */
function classifyContent(m) {
  const c = m.collectRatePct;
  const s = m.shareRatePct;
  const cm = m.commentRatePct;
  if (c > 50) return '工具型';   // 收藏远高于点赞：存下来备用
  if (s > 30) return '传播型';   // 分享远高于点赞：转给别人看
  if (c > 15) return '实用型';
  if (cm > 5) return '讨论型';
  if (s > 10) return '传播型';
  return '常规型';
}

// ---- ⑤ 下载（并发） ----

function downloadOne(item, out, opts) {
  return new Promise((resolve) => {
    const args = [DOWNLOAD_JS, item.id, '--out', out, '--direct', item.direct];
    if (!opts.comments) args.push('--no-comments');
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    p.stdout.on('data', () => {});
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ id: item.id, ok: false, err: e.message }));
    p.on('close', (code) => resolve({ id: item.id, ok: code === 0, err: err.slice(-300) }));
  });
}

/**
 * 并发下载。为什么下载要并发而富化不用：
 * 富化是 20 条 518ms（接口多路复用），下载是 8~15s/条（纯带宽），
 * 全流程 96% 的时间压在这里。并发 3 + 每条随机错开，避免同时起流。
 */
async function downloadMany(items, out, opts) {
  const conc = Math.max(1, Math.min(opts.conc, items.length));
  const results = new Array(items.length);
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      const it = items[i];
      results[i] = await downloadOne(it, out, opts);
      process.stdout.write(results[i].ok ? '.' : 'x');
      if (i + 1 < items.length) await sleep(jitter(500, 1500));
    }
  };

  await Promise.all(Array.from({ length: conc }, worker));
  process.stdout.write('\n');
  return results;
}

// ---- ⑥ 评论（单开一个跳板页批量抓）----
//
// 为什么不复用核心 skill 的下载脚本抓评论：它只有 `--direct` 一个入口能跳过开页，
// 而 `--direct` 分支拿到直链就 return，走不到评论逻辑。
// 评论接口本来就能在同一个详情页上下文里批量调，没必要一条条开页。

function commentsScript(awemeId, limit) {
  return [
    '(async()=>{',
    'const Q="device_platform=webapp&aid=6383&channel=channel_pc_web&update_version_code=170400',
    '&pc_client_type=2&version_code=170400&version_name=17.4.0&cookie_enabled=true&platform=PC";',
    'const API="https://www.douyin.com/aweme/v1/web";',
    `const id=${JSON.stringify(awemeId)};`,
    'const PER=50;',
    'let c=0;',
    `const LIMIT=${Number(limit) || 0};`,
    'const out=[];',
    'while(out.length<LIMIT){',
    'const r=await fetch(API+"/comment/list/?"+Q+"&aweme_id="+id+"&cursor="+c+"&count="+PER+"&item_type=0",{credentials:"include"});',
    'if(!r.ok)return JSON.stringify({error:"HTTP "+r.status,comments:out});',
    'const j=await r.json();const p=(j&&j.comments)||[];',
    'if(!p.length)break;',
    'for(const x of p){',
    'if(out.length>=LIMIT)break;',
    'const U=x.user||{};',
    'out.push({cid:String(x.cid||""),createTime:x.create_time||null,digg:x.digg_count||0,',
    'text:x.text||"",uid:String(U.uid||""),nickname:U.nickname||"",region:x.ip_label||"",',
    'replyCount:x.reply_comment_total||0,',
    'reply:(x.reply_comment||[]).map(function(rc){var RU=rc.user||{};',
    'return {cid:String(rc.cid||""),digg:rc.digg_count||0,nickname:RU.nickname||"",text:rc.text||""};}),',
    'hot:!!x.is_hot,pinned:x.stick_position||0,authorDigged:!!x.is_author_digged});',
    '}',
    'c+=PER;',
    'if(j.has_more===0)break;',
    '}',
    'return JSON.stringify({comments:out});',
    '})()',
  ].join('');
}

/** 字段与 douyin-download.js 的 comments.json 保持一致，下游 blueprint 能直接吃 */
async function collectComments(ids, out, limit) {
  const todo = ids.filter((id) => fs.existsSync(path.join(out, id, 'video.mp4')));
  if (!todo.length) return [];
  console.log(`抓评论（前 ${limit} 条/视频，共 ${todo.length} 条）…`);
  const target = await openDetail(todo);
  const res = [];
  try {
    for (const id of todo) {
      try {
        const r = JSON.parse(await evalOn(target, commentsScript(id, limit), T.enrich));
        if (r.error) throw new Error(r.error);
        writeJson(path.join(out, id, 'comments.json'), {
          id,
          total: r.comments.length,
          fetchedAt: new Date().toISOString(),
          comments: r.comments,
        });
        res.push({ id, n: r.comments.length });
        process.stdout.write(`  ${id.slice(-6)}: ${r.comments.length} 条\n`);
      } catch (e) {
        res.push({ id, n: 0, err: e.message });
        process.stdout.write(`  ${id.slice(-6)}: 失败 ${e.message}\n`);
      }
      await sleep(jitter(400, 900));
    }
  } finally {
    cdp(['close-tab', target], T.close);
  }
  return res;
}

// ---- ⑦ 面板 ----

/** 探测正在跑的采集面板 */
async function findPanelPort() {
  for (const port of PANEL_PORTS) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/library`, { signal: AbortSignal.timeout(500) });
      if (!res.ok) continue;
      const j = await res.json();
      if (Array.isArray(j.items)) return port;
    } catch { /* 这个端口没起 */ }
  }
  return null;
}

/** 起面板（detached，不阻塞采集）。已在跑就复用。返回端口或 null。 */
async function ensurePanel() {
  const running = await findPanelPort();
  if (running) return running;

  const opener = path.join(__dirname, 'open.mjs');
  if (!fs.existsSync(opener)) return null;
  try {
    const child = spawn(process.execPath, [opener], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch { return null; }

  for (let i = 0; i < 30; i++) {
    const p = await findPanelPort();
    if (p) {
      // 起来后再探一次：某些沙箱会把 detached 子进程立刻收走，避免报个假端口
      await sleep(800);
      return (await findPanelPort()) ? p : null;
    }
    await sleep(200);
  }
  return null;
}

/** 推一条给面板。面板没起就跳过，绝不阻断采集。 */
async function pushPanel(port, payload) {
  if (!port) return;
  try {
    await fetch(`http://127.0.0.1:${port}/api/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2_000),
    });
  } catch { /* ignore */ }
}

/** 面板展示用的条目视图 */
function libraryItem(it, sid) {
  return {
    id: it.id,
    desc: (it.desc || '').slice(0, 120),
    durationSec: it.durSec,
    cover: !!it.coverPath,
    author: { nickname: it.author.nick, follower: it.author.fans },
    stats: it.stats,
    score: { proof: it.proof, contentType: it.contentType },
    session: sid,
  };
}

// ---- ⑧ 命令 ----

function newSid() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function cmdPlan(opt) {
  if (!opt.source || !['search', 'user', 'feed'].includes(opt.source)) {
    throw new Error('--source 必须是 search / user / feed');
  }
  if (!opt.query) {
    throw new Error(opt.source === 'user' ? '--query 需要博主主页链接或 sec_uid' : '--query 需要关键词或方向描述');
  }

  const dur = (opt.dur || 'short,mid,long').split(',').map((s) => s.trim()).filter((s) => BANDS[s]);
  if (!dur.length) throw new Error('--dur 只认 short / mid / long');

  const out = path.resolve(opt.out || DEFAULT_OUT);
  ensureDir(out);

  if (opt.focus && !FOCUS_W[opt.focus]) {
    console.warn(`  未知 --focus "${opt.focus}"，按 all 处理（可选：${Object.keys(FOCUS_W).join(' / ')}）`);
  }

  const sid = newSid();
  const plan = {
    sid,
    source: opt.source,
    query: opt.query,
    dur,
    count: Number(opt.count) || 20,
    focus: FOCUS_W[opt.focus] ? opt.focus : 'all',
    criteria: opt.criteria || '',
    batchSize: Number(opt.batch) || 12,
    maxScan: Number(opt['max-scan']) || 200,
    comments: !opt['no-comments'],
    commentLimit: Number(opt['comment-limit']) || 100,
    conc: Number(opt.conc) || 3,
    retrySkipped: !!opt['retry-skipped'],
    createdAt: new Date().toISOString(),
  };

  writeJson(path.join(sessionDir(out, sid), 'plan.json'), plan);
  writeJson(path.join(sessionDir(out, sid), 'state.json'), {
    batch: 0, scanned: 0, collected: 0, skipped: 0, phase: 'new', pendingBatch: null, seenIds: [],
  });

  // 采集一开始就把面板拉起来，之后每采到一条实时推一条
  if (!opt['no-panel']) {
    const port = await ensurePanel();
    if (port) {
      plan.panelPort = port;
      writeJson(path.join(sessionDir(out, sid), 'plan.json'), plan);
    }
    console.log(port
      ? `面板 http://127.0.0.1:${port}`
      : '面板未启动（当前环境不允许后台进程）—— 需要时另开终端跑 node scripts/open.mjs');
  }

  console.log(`会话 ${sid} 已创建`);
  console.log(`  来源 ${plan.source}   目标 ${plan.count} 条   时长 ${plan.dur.join(' / ')}`);
  console.log(`  参考重点 ${plan.focus}   每批 ${plan.batchSize} 条   下载并发 ${plan.conc}`);
  if (plan.criteria) console.log(`  判定标准 ${plan.criteria}`);
  console.log(`\n下一步：node collect.js next --session ${sid} --out "${out}"`);
  return { sid, out };
}

/**
 * 取一批候选。全流程：扫描 → 剔重 → 富化 → 预筛 → 打分 → 落盘。
 * 返回 batch 文件路径与摘要，agent 读文件做语义裁决。
 */
async function cmdNext(opt) {
  const out = path.resolve(opt.out || DEFAULT_OUT);
  const sid = opt.session;
  if (!sid) throw new Error('缺少 --session');
  const plan = readJson(path.join(sessionDir(out, sid), 'plan.json'));
  if (!plan) throw new Error(`会话不存在：${sid}（--out 是否指向创建时的目录？）`);

  const statePath = path.join(sessionDir(out, sid), 'state.json');
  const state = readJson(statePath, { batch: 0, scanned: 0, collected: 0, skipped: 0 });

  // 上一批还没裁决就不要再取 —— 否则会重复扫同一片候选
  if (state.pendingBatch) {
    console.log(`上一批（batch-${String(state.pendingBatch).padStart(2, '0')}）还没裁决，先 commit`);
    return { pending: state.pendingBatch };
  }

  const index = loadIndex(out);
  const need = plan.count - state.collected;
  if (need <= 0) {
    state.phase = 'done';
    writeJson(statePath, state);
    console.log(`已完成：${state.collected}/${plan.count}`);
    return { done: true };
  }

  /// 上轮富化过、但没轮到投喂的候选优先复用。
  // 否则每轮会重复扫描并重新拉一遍接口。
  let passed = null;
  if (Array.isArray(state.pendingPool) && state.pendingPool.length) {
    passed = state.pendingPool.filter((it) => !index.collected[it.id] && !(index.skipped[it.id] && !plan.retrySkipped));
    state.pendingPool = [];
    console.log(`[批次 ${state.batch + 1}] 复用上轮剩余 ${passed.length} 条候选`);
    // 池子里的都被判过了（或索引已收录）就回退到扫描
    if (!passed.length) passed = null;
  }

  if (!passed) {
    // 扫描量 = 批次大小 × 6。预筛淘汰率很高（时长档常砍掉一半以上），
    // 而且必须跳过已处理过的 id，所以要按「新 id 数」而不是「DOM 里有多少条」来收。
    const want = Math.min(plan.batchSize * 6, plan.maxScan - state.scanned);
    if (want <= 0) {
      state.phase = 'done';
      writeJson(statePath, state);
      console.log(`扫描已达上限（--max-scan ${plan.maxScan}），停止。已采集 ${state.collected} 条`);
      return { exhausted: true };
    }

    console.log(`[批次 ${state.batch + 1}] 扫描中（目标 ${plan.batchSize} 条候选）…`);
    const scanner = plan.source === 'search' ? scanSearch : plan.source === 'user' ? scanUser : scanFeed;
    // 跳过三类：已采集、已判过不要、本会话已经扫过（被时长筛掉的那些）。
    // 第三类只记在会话里，不写进全局索引 —— 换时长档重采时它们还得能回来。
    const skip = new Set([
      ...Object.keys(index.collected),
      ...Object.keys(index.skipped),
      ...(state.seenIds || []),
    ]);
    const scanned = await scanner(plan, want, skip);
    state.scanned += scanned.length;
    console.log(`  扫到 ${scanned.length} 个新 id，开始富化…`);

    const fresh = scanned.filter((id) => !index.collected[id] && !(index.skipped[id] && !plan.retrySkipped));
    if (!fresh.length) {
      writeJson(statePath, state);
      console.log('  全部是已处理过的视频，可换关键词/换博主，或加 --retry-skipped');
      return { empty: true };
    }

    const rich = await enrich(fresh.slice(0, Math.min(fresh.length, plan.batchSize * 6)));
    console.log(`  富化 ${rich.length}/${fresh.length} 条`);

    // 记下本会话拉过的 id，下一轮不再重复富化同一批（被时长筛掉的尤其容易反复撞）
    state.seenIds = [...new Set([...(state.seenIds || []), ...rich.map((x) => x.id)])];

    passed = [];
    const dropped = {};
    for (const it of rich) {
      const why = prefilter(it, plan, index);
      if (why) { dropped[why] = (dropped[why] || 0) + 1; continue; }
      passed.push(it);
    }
    if (Object.keys(dropped).length) {
      console.log(`  预筛淘汰：${Object.entries(dropped).map(([k, v]) => `${k}×${v}`).join('  ')}`);
    }
  }

  if (!passed.length) {
    // 挨了一轮空：时长档把新扫到的都砍了。自动再扫一轮（真的空跑时不无限递归）。
    if (!state.retryOnce) {
      state.retryOnce = true;
      writeJson(statePath, state);
      console.log('  本批没有通过预筛的候选，再扫一轮…');
      return cmdNext(opt);
    }
    state.retryOnce = false;
    writeJson(statePath, state);
    console.log('  连续两轮无用候选。放宽 --dur、换关键词，或提高 --max-scan');
    return { empty: true };
  }

  const scored = scoreItems(passed, plan);
  // 投喂一批、剩下的进池子。池子里的下一轮直接用，不再重新扫描富化。
  const feed = scored.slice(0, plan.batchSize);

  const covOk = await downloadCovers(feed, sessionDir(out, sid));
  if (covOk) console.log(`  封面 ${covOk}/${feed.length} 张已就绪`);

  const batchNo = state.batch + 1;
  const batchName = `batch-${String(batchNo).padStart(2, '0')}.json`;

  // 交给 agent 的视图：只留判断需要的，直链不出现在这里（下载时脚本自己取）
  const batch = {
    session: sid,
    batch: batchNo,
    target: plan.count,
    collected: state.collected,
    scanned: state.scanned,
    source: plan.source,
    criteria: plan.criteria,
    focus: plan.focus,
    note: '按 proof 降序。proof 是池内相对分（1-5），不是绝对好坏。请按 criteria 判 relevance / craft，逐条给分。',
    items: feed.map((it) => ({
      id: it.id,
      dur: fmtDur(it.durSec),
      durSec: it.durSec,
      band: it.band,
      age: fmtAge(it.ageDays),
      ageDays: it.ageDays,
      author: {
        nick: it.author.nick,
        fans: it.author.fans,
        totalFav: it.author.totalFav,
        signature: it.author.signature,
      },
      stats: it.stats,
      metrics: it.metrics,
      proof: it.proof,
      contentType: it.contentType,
      desc: it.desc,
      tags: it.tags,
      flags: it.flags,
      music: it.music.title,
      quality: `${it.video.w}x${it.video.h} ${it.video.gears}档码率`,
      cover: it.coverPath || null,
      url: `${SITE}/video/${it.id}`,
    })),
  };

  writeJson(path.join(sessionDir(out, sid), batchName), batch);
  state.batch = batchNo;
  state.pendingBatch = batchNo;
  state.pendingItems = feed;
  state.pendingPool = scored.slice(plan.batchSize);
  state.retryOnce = false;
  state.phase = 'awaiting';
  writeJson(statePath, state);

  console.log(`\n批次 ${batchNo} 就绪：${batch.items.length} 条待裁决 → ${batchName}`);
  console.log(`目标 ${plan.count}，已采集 ${state.collected}，本轮扫描累计 ${state.scanned}`);
  console.log(`候选：${batch.items.map((x) => `${x.id.slice(-6)}(${x.band},proof ${x.proof})`).join(' ')}`);
  console.log(`\n裁决：node collect.js commit --session ${sid} --keep "id1,id2" --skip "id3=原因;id4=原因" --out "${out}"`);
  return { batch: batchNo, count: batch.items.length };
}

/**
 * 提交裁决：下载 keep → 记录 skip → 自动取下一批。
 * 一次调用完成「当前批落地 + 下一批就绪」，agent 每轮只花一次工具调用。
 */
async function cmdCommit(opt) {
  const out = path.resolve(opt.out || DEFAULT_OUT);
  const sid = opt.session;
  if (!sid) throw new Error('缺少 --session');
  const dir = sessionDir(out, sid);
  const plan = readJson(path.join(dir, 'plan.json'));
  if (!plan) throw new Error(`会话不存在：${sid}`);

  const statePath = path.join(dir, 'state.json');
  const state = readJson(statePath, {});
  if (!state.pendingItems || !state.pendingBatch) {
    console.log('没有待裁决的批次，先跑 next');
    return { nothing: true };
  }

  const keepIds = String(opt.keep || '').split(',').map((s) => s.trim()).filter(Boolean);
  const skipMap = new Map();
  String(opt.skip || '').split(';').map((s) => s.trim()).filter(Boolean).forEach((pair) => {
    const i = pair.indexOf('=');
    if (i > 0) skipMap.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  });

  const items = state.pendingItems;

  // --keep 里写了本批不存在的 id（多半是前缀抄错）时，绝不能静默按全 skip 处理 ——
  // 那等于把整批候选误判掉，而且索引里会永久留下 skipped 记录。
  const unknown = keepIds.filter((id) => !items.some((x) => x.id === id));
  if (unknown.length) {
    const hints = unknown.map((id) => {
      const near = items.find((x) => x.id.endsWith(id.slice(-6)));
      return near ? `  ${id}  → 本批里的近似 id 是 ${near.id}` : `  ${id}  → 本批没有以 ${id.slice(-6)} 结尾的候选`;
    });
    console.error(`ERROR: --keep 有 ${unknown.length} 个 id 不在本批候选中，已中止（未做任何记录）`);
    console.error(hints.join('\n'));
    console.error(`本批可用 id：${items.map((x) => x.id).join(', ')}`);
    throw new Error('keep id 不匹配，批次未推进。核对后重跑 commit');
  }

  const keepItems = items.filter((x) => keepIds.includes(x.id));
  // 没被 keep 的一律按跳过处理 —— agent 漏判比误判更少见，保守起见不重复投喂
  const skipItems = items.filter((x) => !keepIds.includes(x.id));

  // 下载前先落 skip，避免中途中断导致同一批重新投喂
  const index = loadIndex(out);
  const now = new Date().toISOString();
  skipItems.forEach((it) => {
    index.skipped[it.id] = snapshot(it, 'skipped', { why: skipMap.get(it.id) || 'agent-skip', session: sid });
  });
  saveIndex(out, index);

  const verdictName = `verdict-${String(state.pendingBatch).padStart(2, '0')}.json`;
  writeJson(path.join(dir, verdictName), {
    batch: state.pendingBatch,
    at: now,
    keep: keepItems.map((x) => x.id),
    skip: skipItems.map((x) => ({ id: x.id, why: skipMap.get(x.id) || 'agent-skip' })),
  });

  console.log(`裁决已记录：keep ${keepItems.length} / skip ${skipItems.length}`);

  // 直链可能缺失（图文、接口未下发），这类不下载但要说明
  const downloadable = keepItems.filter((x) => x.direct);
  const noDirect = keepItems.filter((x) => !x.direct);
  if (noDirect.length) {
    console.log(`  ${noDirect.length} 条没有直链（图文或接口未下发），跳过下载：${noDirect.map((x) => x.id.slice(-6)).join(' ')}`);
    const idx2 = loadIndex(out);
    noDirect.forEach((it) => { idx2.skipped[it.id] = snapshot(it, 'skipped', { why: 'no-direct-url', session: sid }); });
    saveIndex(out, idx2);
  }

  let ok = 0;
  if (downloadable.length) {
    console.log(`下载中（并发 ${plan.conc}）…`);
    const results = await downloadMany(downloadable, out, { conc: plan.conc, comments: plan.comments });
    const idx3 = loadIndex(out);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const it = downloadable[i];
      if (!r.ok) {
        idx3.skipped[it.id] = snapshot(it, 'skipped', { why: `download-fail:${(r.err || '').slice(0, 80)}`, session: sid });
        continue;
      }
      ok++;
      idx3.collected[it.id] = snapshot(it, 'collected', { session: sid, proof: it.proof, type: it.contentType });

      // 封面挪进视频目录，面板按 /cover/<id> 读
      if (it.coverPath && fs.existsSync(it.coverPath)) {
        try { fs.copyFileSync(it.coverPath, path.join(out, it.id, 'cover.jpg')); } catch { /* ignore */ }
      }

      // meta.json 由采集侧写：接口字段比下载脚本重新拉一遍更全，还带本次评分
      writeJson(path.join(out, it.id, 'meta.json'), {
        id: it.id,
        videoUrl: it.direct,
        cover: it.cover,
        author: {
          nickname: it.author.nick,
          follower: it.author.fans,
          totalFavorited: it.author.totalFav,
          signature: it.author.signature || null,
          uniqueId: it.author.uniqueId || null,
          verifyType: it.author.verify,
        },
        stats: {
          digg: it.stats.digg, comment: it.stats.comment,
          collect: it.stats.collect, share: it.stats.share,
        },
        durationSec: it.durSec,
        createTime: it.createTime,
        desc: it.desc,
        topics: it.tags,
        music: it.music,
        flags: it.flags,
        metrics: it.metrics,
        score: { proof: it.proof, contentType: it.contentType, focus: plan.focus },
        sourceUrl: `${SITE}/video/${it.id}`,
        collectedAt: now,
        fetchedAt: now,
      });

      await pushPanel(plan.panelPort, { type: 'new', item: libraryItem(it, sid) });
    }
    saveIndex(out, idx3);
    console.log(`下载完成 ${ok}/${downloadable.length}`);

    if (plan.comments) {
      const okIds = results.filter((r) => r.ok).map((r) => r.id);
      if (okIds.length) await collectComments(okIds, out, plan.commentLimit || 100);
    }
  }

  state.collected += ok;
  state.skipped += skipItems.length + (keepItems.length - ok);
  state.pendingItems = null;
  state.pendingBatch = null;
  state.phase = state.collected >= plan.count ? 'done' : 'new';
  writeJson(statePath, state);

  console.log(`\n进度：已采集 ${state.collected}/${plan.count}，跳过 ${state.skipped}`);

  if (state.collected >= plan.count) {
    console.log(`目标达成。产物在 ${out}`);
    return { done: true, collected: state.collected };
  }

  console.log('');
  return cmdNext(opt);
}

/**
 * 补抓评论。用于：采集时没开评论、或想加大条数重抓。
 * 默认只处理「有 video.mp4 但没 comments.json」的目录，--force 覆盖已有文件。
 */
async function cmdComments(opt) {
  const out = path.resolve(opt.out || DEFAULT_OUT);
  const limit = Number(opt.limit) || 100;

  let ids;
  if (opt.ids) {
    ids = String(opt.ids).split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    ids = fs.readdirSync(out)
      .filter((d) => /^\d{15,}$/.test(d) && fs.existsSync(path.join(out, d, 'video.mp4')))
      .filter((d) => opt.force || !fs.existsSync(path.join(out, d, 'comments.json')));
  }
  if (!ids.length) {
    console.log('没有需要抓评论的视频目录（加 --force 覆盖已有文件）');
    return [];
  }

  const res = await collectComments(ids, out, limit);
  const okN = res.filter((x) => x.n > 0).length;
  console.log(`\n完成：${okN}/${res.length} 条，共 ${res.reduce((a, b) => a + b.n, 0)} 条评论`);
  return res;
}

/** 打开面板：转交给 open.mjs（探测复用 / 起服务 / 开浏览器 / --stop） */
function cmdOpen(opt) {
  const args = [path.join(__dirname, 'open.mjs')];
  if (opt.port) args.push('--port', String(opt.port));
  if (opt.stop) args.push('--stop');
  if (opt['no-open']) args.push('--no-open');
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  process.exit(r.status ?? 0);
}

function cmdStatus(opt) {
  const out = path.resolve(opt.out || DEFAULT_OUT);
  const root = collectRoot(out);
  const sessions = fs.existsSync(root)
    ? fs.readdirSync(root).filter((d) => /^\d{8}-\d{6}$/.test(d)).sort().reverse()
    : [];
  const sid = opt.session || sessions[0];
  if (!sid) { console.log('还没有任何采集会话'); return; }

  const dir = sessionDir(out, sid);
  const plan = readJson(path.join(dir, 'plan.json'));
  const state = readJson(path.join(dir, 'state.json'), {});
  const index = loadIndex(out);

  console.log(`会话 ${sid}`);
  console.log(`  来源 ${plan.source}   query ${String(plan.query).slice(0, 40)}`);
  console.log(`  进度 ${state.collected || 0}/${plan.count}   跳过 ${state.skipped || 0}   扫描 ${state.scanned || 0}`);
  console.log(`  阶段 ${state.phase}${state.pendingBatch ? `（batch-${state.pendingBatch} 待裁决）` : ''}`);
  console.log(`  索引：已采集 ${Object.keys(index.collected).length} 条，已跳过 ${Object.keys(index.skipped).length} 条`);
  return { sid };
}

// ---- 参数解析与入口 ----

function parseArgs(argv) {
  const opt = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opt[key] = true;
      else { opt[key] = next; i++; }
    } else opt._.push(a);
  }
  return opt;
}

const USAGE = `
collect.js — 抖音爆款视频采集

  plan    创建采集会话
    --source search|user|feed   采集入口（必填）
    --query  <关键词/主页链接/方向描述>（必填；search 可用逗号给多个关键词）
    --dur    short,mid,long     时长档，默认全选
    --count  20                 目标条数
    --focus  topic|craft|account|all   参考重点，决定客观分权重
    --criteria "..."            判定标准（自然语言，回传给 agent）
    --batch  12                 每批投喂多少条候选
    --conc   3                  下载并发
    --max-scan 200              单会话最多扫多少条
    --comment-limit 100         每条视频抓多少评论（默认开，--no-comments 可关）
    --no-panel                  不启动采集面板
    --out    <目录>             产物目录，默认 ~/.douyin-viral-blueprint/collect

  next     取一批候选        --session <sid>
  commit   提交裁决          --session <sid> --keep "id1,id2" --skip "id3=原因;id4=原因"
  comments 补抓评论          [--ids "id1,id2"] [--limit 100] [--force]
  open     打开采集面板        [--port 8800] [--stop] [--no-open]
  status   查看进度          [--session <sid>]

时长档：short <3min ｜ mid 3-20min ｜ long >20min（边界值归 mid）
`;

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const cmd = opt._[0];
  if (cmd === 'plan') return cmdPlan(opt);
  if (cmd === 'next') return cmdNext(opt);
  if (cmd === 'commit') return cmdCommit(opt);
  if (cmd === 'open') return cmdOpen(opt);
  if (cmd === 'comments') return cmdComments(opt);
  if (cmd === 'status') return cmdStatus(opt);
  console.log(USAGE);
  process.exit(cmd ? 1 : 0);
}

main().catch((e) => {
  console.error(`\nERROR: ${e.message}`);
  process.exit(1);
});
