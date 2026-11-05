#!/usr/bin/env node
/**
 * douyin-download.js — 抖音视频下载 + 评论区存档
 *
 * 用法:
 *   node douyin-download.js <分享链接|视频链接|视频id> [--out <目录>] [--no-comments] [--comment-limit N]
 *
 * 示例:
 *   node douyin-download.js "https://v.douyin.com/xxxxxxx/"
 *   node douyin-download.js "https://www.douyin.com/video/7400000000000000000"
 *   node douyin-download.js 7400000000000000000 --out ./videos
 *   node douyin-download.js 7400000000000000000 --comment-limit 200   # 只要前 200 条评论
 *   node douyin-download.js 7400000000000000000 --no-comments         # 只下视频
 *
 * 输出（默认当前目录）:
 *   <out>/<视频id>/video.mp4      视频本体
 *   <out>/<视频id>/meta.json      详情事实（作者/统计/时长/文案/直链）
 *   <out>/<视频id>/comments.json  一级评论全量（含内嵌回复、地区、点赞）
 *
 * 流程（抽自 kiln 采集引擎 apps/daemon/src/engine/douyin.ts，去掉抽帧与 ASR）:
 *   ① 短链跟随重定向 → 正则抓视频 id
 *   ② 开页面 → goto → 等 [data-e2e="video-detail"] 容器出现（10s 超时）
 *   ③ 页内 fetch 详情接口（credentials:include 复用登录态）→ 校验 aweme_detail + 拿直链
 *   ④ 页内 fetch 评论接口 → 按 cursor 翻页直到见底
 *   ⑤ 直链 + referer 下载 → 流式落盘
 *
 * 纯 Node 标准库，零 npm 依赖。需 Node >= 18（原生 fetch），走代理需 Node >= 22。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---- 代理自愈 ----
//
// Node 内置 fetch 既不读 HTTP(S)_PROXY，也不读 Windows 系统代理，必须靠 NODE_USE_ENV_PROXY=1
// 且要在进程启动前就位。国内用户通常只在 Clash / v2rayN 里开「系统代理」，不会设环境变量，
// 所以这里的代理来源按优先级取：
//   ① env HTTPS_PROXY / HTTP_PROXY / ALL_PROXY（CI、容器、显式配置）
//   ② 没有 env 时读 Windows 系统代理（注册表 HKCU Internet Settings 的 ProxyEnable / ProxyServer）
//   ③ 都没有 → 直连
// 定了代理就带开关重启自身一次（CDP_PROXY_RESOLVED 防递归）。

function withScheme(hostPort) {
  const v = String(hostPort || '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[^:/\s=]+(:\d+)?$/.test(v)) return `http://${v}`; // 裸 host:port → 按 http 代理（CONNECT 隧道对 https 一样有效）
  return null;
}

/** "127.0.0.1:7890" / "http=127.0.0.1:7890;https=..." → 带 scheme 的代理 URL */
function parseProxyServer(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const named = /(?:^|[;\s])https?=([^\s;]+)/.exec(s);
  if (named) return withScheme(named[1]);
  if (s.includes('=') && s.includes(';')) return null; // 只剩 socks= 之类，内置 fetch 走不了
  return withScheme(s);
}

function windowsSystemProxy() {
  if (process.platform !== 'win32') return null;
  const cmd =
    "$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue; " +
    'if($p.ProxyEnable -eq 1){$p.ProxyServer}';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
    encoding: 'utf-8', timeout: 8_000, windowsHide: true,
  });
  if (r.status !== 0 || !r.stdout) return null;
  return parseProxyServer(r.stdout.trim());
}

if (!process.env.CDP_PROXY_RESOLVED) {
  const envProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
  const proxy = envProxy ? parseProxyServer(envProxy) : windowsSystemProxy();
  if (envProxy && !proxy) {
    console.log(`代理 ${envProxy} 是内置 fetch 用不了的协议（socks 等），本次直连`);
  }
  if (proxy) {
    if (process.env.CDP_DEBUG) console.error('[proxy]', proxy, envProxy ? '(env)' : '(system)');
    const r = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_USE_ENV_PROXY: '1',
        NODE_NO_WARNINGS: '1',
        HTTPS_PROXY: proxy,
        HTTP_PROXY: proxy,
        CDP_PROXY_RESOLVED: '1',
      },
    });
    process.exit(r.status ?? 1);
  }
}

const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

// ---- 定位 cdp-server ----

const CDP_BIN = (() => {
  const name = process.platform === 'win32' ? 'cdp-server.exe' : 'cdp-server';
  const full = path.join(__dirname, '..', name);
  if (fs.existsSync(full)) return full;
  return name;
})();

const SITE = 'https://www.douyin.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 各命令超时不同，不能共用一个值（见 SKILL.md「超时值不是统一的 30s」） */
const T = { newTab: 20_000, goto: 30_000, eval: 30_000, comment: 60_000, close: 15_000, probe: 8_000 };

function cdp(args, timeout) {
  const r = spawnSync(CDP_BIN, ['browser', ...args], {
    encoding: 'utf-8', timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) {
    if (r.error.code === 'ENOENT') {
      throw new Error(`找不到 cdp-server（应在 ${path.join(__dirname, '..')}）—— 先按 SKILL.md 的 I-0 下载二进制`);
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

/**
 * eval-target 的容错包装。
 * 抖音详情页会在 eval 期间二次导航，扩展的 chrome.debugger 会被 detach，
 * 报 `Detached while handling command` —— 偶发，重试一次就好（kiln 那边也是 retry 3 次）。
 */
async function evalOn(target, script, timeout, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return cdp(['eval-target', target, script], timeout);
    } catch (e) {
      lastErr = e;
      const retriable = /detached|超时|timed out|no target|not found/i.test(e.message);
      if (!retriable || i === tries) break;
      if (process.env.CDP_DEBUG) console.error(`[eval-retry ${i}]`, e.message);
      await sleep(1_200 * i);
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- ① 解析视频 id ----
//
// 输入有三种形态，都要认：
//   ① 纯 id          7400000000000000000
//   ② 标准链接        https://www.douyin.com/video/7400000000000000000
//                    https://www.iesdouyin.com/share/video/7400000000000000000/（老分享页，URL 自带 id）
//   ③ 分享短链        https://v.douyin.com/xxxxxxx/ —— 不带 id，必须跟重定向
// 分享文案（"7.53 复制打开抖音，看看【xxx的作品】... https://v.douyin.com/xxx/ 复制此链接..."）也能直接粘：
// URL 后面常紧跟中文标点，正则要把非 ASCII 字符切掉，否则会把"复制此链接"一起吃掉。

const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/;

function parseInput(input) {
  const s = String(input || '').trim();
  const id = s.match(/(\d{15,})/)?.[1];
  if (id) return { id, url: `${SITE}/video/${id}` };
  const m = s.match(URL_RE);
  if (!m) throw new Error(`无法从输入解析出链接或视频 id：${s}`);
  return { id: null, url: m[0] };
}

/** 短链跟重定向拿 id：先试 Node（快），拿不到再交给浏览器（有登录态、真实 UA） */
async function resolveShortUrl(shortUrl) {
  try {
    const res = await fetch(shortUrl, {
      redirect: 'follow',
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(15_000),
    });
    const id = (res.url || '').match(/(\d{15,})/)?.[1];
    if (id) return id;
  } catch (e) {
    if (process.env.CDP_DEBUG) console.error('[resolve-node]', e.message);
  }
  return null;
}

// ---- 详情脚本（页内 fetch，复用 Cookie 直调 web 接口）----

/**
 * 在视频页内执行，返回 JSON 字符串。
 * 直链优先级：download_addr（无水印）> play_addr。
 * 视频 id 直接注入，不从 location 解析 —— 详情页有时会以 /jingxuan?modal_id=<id> 形式打开。
 * 单行 IIFE —— 扩展侧多行 eval 会报 "Unexpected token 'var'"。
 */
function detailScript(awemeId) {
  return [
    '(async()=>{',
    'const Q="device_platform=webapp&aid=6383&channel=channel_pc_web&update_version_code=170400',
    '&pc_client_type=2&version_code=170400&version_name=17.4.0&cookie_enabled=true&platform=PC";',
    'const API="https://www.douyin.com/aweme/v1/web";',
    `const id=${JSON.stringify(awemeId)};`,
    'const r=await fetch(API+"/aweme/detail/?"+Q+"&aweme_id="+id+"&request_source=600&origin_type=video_page",{credentials:"include"});',
    'if(!r.ok)return JSON.stringify({error:"HTTP "+r.status});',
    'const j=await r.json();const a=j&&j.aweme_detail;',
    'if(!a)return JSON.stringify({error:"接口没返回 aweme_detail（视频可能已下架/私密，或未登录、触发了风控）"});',
    'const v=a.video||{};const au=a.author||null;const s=a.statistics||{};',
    'const url=(((v.download_addr&&v.download_addr.url_list)||(v.play_addr&&v.play_addr.url_list)||[null])[0]);',
    'return JSON.stringify({',
    'id:id,',
    'videoUrl:url,',
    'isImages:Array.isArray(a.images)&&a.images.length>0,',
    'author:au?{nickname:au.nickname,follower:au.follower_count,signature:au.signature||null,uniqueId:au.unique_id||null,region:au.ip_location||null}:null,',
    'stats:{play:s.play_count,digg:s.digg_count,comment:s.comment_count,collect:s.collect_count,share:s.share_count},',
    'durationSec:Math.round((a.duration||v.duration_ms||0)/1000),',
    'createTime:a.create_time||null,',
    'desc:(a.desc||"").slice(0,300),',
    'topics:((a.text_extra)||[]).map(x=>x.hashtag_name).filter(Boolean).slice(0,8),',
    'cover:((v.cover&&v.cover.url_list)||(v.origin_cover&&v.origin_cover.url_list)||[])[0]||null',
    '});',
    '})()',
  ].join('');
}

// ---- 评论脚本（同一套页内 fetch，按 cursor 翻页）----

/**
 * 拉一批一级评论。cursor 语义 = 页偏移 × PER（与抖音接口一致，不是时间戳）。
 * 返回 { comments, nextCursor, bottom }；bottom 为真表示没更多了。
 * id 同样注入 —— kiln 原版从 location.pathname 取，在 modal 形态下会拿到错的 id。
 */
function commentsScript(awemeId, cursor, limit) {
  return [
    '(async()=>{',
    'const Q="device_platform=webapp&aid=6383&channel=channel_pc_web&update_version_code=170400',
    '&pc_client_type=2&version_code=170400&version_name=17.4.0&cookie_enabled=true&platform=PC";',
    'const API="https://www.douyin.com/aweme/v1/web";',
    `const id=${JSON.stringify(awemeId)};`,
    'const PER=50;',
    `let c=${Number(cursor) || 0};`,
    `const LIMIT=${Number(limit) || 0};`,
    'const out=[];let bottom=false;',
    'while(LIMIT===0||out.length<LIMIT){',
    'const r=await fetch(API+"/comment/list/?"+Q+"&aweme_id="+id+"&cursor="+c+"&count="+PER+"&item_type=0",{credentials:"include"});',
    'if(!r.ok)return JSON.stringify({error:"HTTP "+r.status,comments:out});',
    'const j=await r.json();const p=(j&&j.comments)||[];',
    'if(!p.length){bottom=true;break;}',
    'for(const x of p){',
    'const U=x.user||{};',
    'out.push({',
    'cid:String(x.cid||""),',
    'createTime:x.create_time||null,',
    'digg:x.digg_count||0,',
    'text:x.text||"",',
    'uid:String(U.uid||""),',
    'nickname:U.nickname||"",',
    'region:x.ip_label||"",',
    'level:x.level||0,',
    'replyCount:x.reply_comment_total||0,',
    'reply:(x.reply_comment||[]).map(function(r){var RU=r.user||{};return {cid:String(r.cid||""),createTime:r.create_time||null,digg:r.digg_count||0,nickname:RU.nickname||"",text:r.text||""};}),',
    'hot:!!x.is_hot,',
    'pinned:x.stick_position||0,',
    'folded:!!x.is_folded,',
    'authorDigged:!!x.is_author_digged,',
    'authorReplied:!!(x.reply_comment&&x.reply_comment.length)',
    '});',
    '}',
    'c+=PER;',
    'if(j.has_more===0){bottom=true;break;}',
    '}',
    'return JSON.stringify({comments:out,nextCursor:c,bottom:bottom,remain:LIMIT===0?null:Math.max(0,LIMIT-out.length)});',
    '})()',
  ].join('');
}

// ---- 打开页面（等详情容器）----
//
// 判定不看 URL。抖音详情页有两种形态（/video/<id> 与 /jingxuan?modal_id=<id>），
// 视频下架时还会回落到推荐流，靠 URL 匹配既啰嗦又容易误判。
// 直接看 DOM 事实：只盯一个容器 `[data-e2e="video-detail"]`。
// 点赞 / 评论 / 收藏 / 转发四个互动框都挂在它下面（实测各 1 个），容器在 = 整组在，
// 没必要逐个 count。10 秒还不出现 = 页面没到详情态，直接报错，不空耗。
//
// 注意两点实测事实：
//   ① 首页 / 推荐流的视频卡片也有互动框（digg / comment 各 2 个），所以不能只数互动框；
//      `video-detail` 只在详情态出现（首页实测 0），拿它当唯一判据才准。
//   ② 容器在只证明「这是某条视频的详情页」，不证明「是你给的那条」——
//      视频失效时抖音会塞一条别人的 modal 进来。真正校验 id 的是第三步的详情接口：
//      按注入的 id 查，查不到 aweme_detail 就报错，不会下错片。

const UI_CONTAINER = '[data-e2e="video-detail"]';
const UI_PROBE = `JSON.stringify({h:location.href,d:document.querySelectorAll('${UI_CONTAINER}').length})`;
const UI_READY_MS = 10_000;

/** 打开 url 并等详情容器出现；返回 { target, href }。失败自动关 tab。 */
async function openDetailPage(url) {
  const raw = cdp(['new-tab', 'about:blank'], T.newTab);
  const target = raw.replace(/^NEW-TAB:\s*/, '').trim();
  if (!/^[0-9A-F]{16,}$/i.test(target)) {
    throw new Error(`new-tab 未返回 targetId（多半是扩展未连上）：${raw}`);
  }

  try {
    cdp(['goto-target', target, url], T.goto);

    const deadline = Date.now() + UI_READY_MS;
    let href = '';
    let d = 0;
    for (;;) {
      try {
        const out = cdp(['eval-target', target, UI_PROBE], T.eval);
        if (process.env.CDP_DEBUG) console.error('[probe]', out);
        const j = JSON.parse(out);
        href = j.h || href;
        d = j.d || 0;
        if (d > 0) return { target, href };
      } catch (e) {
        if (process.env.CDP_DEBUG) console.error('[probe-err]', e.message);
      }
      if (Date.now() > deadline) break;
      await sleep(400);
    }

    const hint = /login|passport/.test(href)
      ? '被登录墙拦了 —— 先在 Chrome 里确认已登录抖音'
      : `详情容器 ${UI_CONTAINER} 没出现（命中 ${d} 个）—— 这个地址没进视频详情态`;
    throw new Error(`${UI_READY_MS / 1000}s 内没等到视频详情（最终地址：${href || '未知'}）\n   ${hint}`);
  } catch (e) {
    cdp(['close-tab', target], T.close);
    throw e;
  }
}

/** 从落地地址里抠视频 id：/video/<id> 或 ?modal_id=<id> */
function extractId(href) {
  return (href || '').match(/\/video\/(\d{15,})/)?.[1] ||
    (href || '').match(/modal_id=(\d{15,})/)?.[1] ||
    null;
}

// ---- 下载（流式落盘）----

async function download(url, dest) {
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: { referer: `${SITE}/`, 'user-agent': UA },
      signal: AbortSignal.timeout(600_000),
    });
  } catch (e) {
    const cause = e.cause ? `（${e.cause.code || e.cause.message}）` : '';
    throw new Error(`直链请求失败：${e.message}${cause} —— 代理不通或直链已过期，重跑一次即可（直链有时效）`);
  }
  if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}`);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  return fs.statSync(dest).size;
}

// ---- 评论区抓取（Node 侧翻页）----

/** 每批 eval 拉多少条（kiln 用 1000；这里 500，单次返回体积更稳） */
const COMMENT_BATCH = 500;
/** 兜底上限，防止异常 has_more 无限翻 */
const COMMENT_HARD_CAP = 50_000;

/** 反复 eval 取评论，直到见底或达到 limit；limit=0 表示拉到见底。 */
async function collectComments(target, id, limit) {
  const all = [];
  let cursor = 0;
  for (;;) {
    const want = limit > 0 ? Math.min(COMMENT_BATCH, limit - all.length) : COMMENT_BATCH;
    if (want <= 0) break;

    const batch = JSON.parse(await evalOn(target, commentsScript(id, cursor, want), T.comment));
    if (batch.error) throw new Error(`评论接口 ${batch.error}`);
    all.push(...(batch.comments || []));
    const shown = limit > 0 ? Math.min(all.length, limit) : all.length;
    process.stdout.write(`\r   评论 ${shown} 条…`);

    if (batch.bottom) break;
    if (limit > 0 && all.length >= limit) break;
    if (!batch.nextCursor || batch.nextCursor === cursor) break;
    cursor = batch.nextCursor;
    if (all.length >= COMMENT_HARD_CAP) break;
  }
  process.stdout.write('\n');
  return limit > 0 ? all.slice(0, limit) : all;
}

// ---- 主流程 ----

async function main() {
  const argv = process.argv.slice(2);
  const opts = { out: process.cwd(), comments: true, commentLimit: 0 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = path.resolve(argv[++i] || '.');
    else if (a === '--no-comments') opts.comments = false;
    else if (a === '--comment-limit') opts.commentLimit = Number(argv[++i]) || 0;
    else positional.push(a);
  }
  const outDir = opts.out;
  const input = positional[0];

  if (!input) {
    console.error('用法: node douyin-download.js <分享链接|视频链接|视频id> [--out <目录>] [--no-comments] [--comment-limit N]');
    process.exit(1);
  }

  console.log('① 解析链接…');
  const parsed = parseInput(input);
  let id = parsed.id;
  if (!id) {
    console.log(`   分享短链，跟重定向… ${parsed.url}`);
    id = await resolveShortUrl(parsed.url);
  }
  console.log(id ? `   视频 id: ${id}` : '   短链没解析出 id，交给浏览器落地后再认');

  console.log('② 打开视频页…');
  const page = await openDetailPage(id ? `${SITE}/video/${id}` : parsed.url);
  const target = page.target;

  try {
    if (!id) {
      id = extractId(page.href);
      if (!id) throw new Error(`分享链接落到的不是视频详情页（最终地址：${page.href}）`);
      console.log(`   视频 id: ${id}`);
    }

    console.log('③ 取详情与直链…');
    const detail = JSON.parse(await evalOn(target, detailScript(id), T.eval));
    if (detail.error) throw new Error(`详情接口：${detail.error}`);
    if (!detail.videoUrl) {
      throw new Error(detail.isImages ? '这是图文作品，没有视频可下' : '没有下载直链（接口未下发 download_addr / play_addr）');
    }

    const dir = path.join(outDir, id);
    const dest = path.join(dir, 'video.mp4');
    fs.mkdirSync(dir, { recursive: true });

    // ④ 评论区：跟 kiln 采集一致 —— 详情一拿到就抓，共用同一份登录态；
    //    失败不阻断下载（视频是主体，评论是附属事实）。
    if (opts.comments) {
      console.log('④ 抓评论…');
      try {
        const comments = await collectComments(target, id, opts.commentLimit);
        fs.writeFileSync(
          path.join(dir, 'comments.json'),
          JSON.stringify({ id, total: comments.length, fetchedAt: new Date().toISOString(), comments }, null, 2),
          'utf8',
        );
        console.log(`   一级评论 ${comments.length} 条 → comments.json`);
      } catch (e) {
        console.log(`   评论抓取失败（不影响视频下载）：${e.message}`);
      }
    }

    console.log('⑤ 下载中…');
    const bytes = await download(detail.videoUrl, dest);

    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({ ...detail, fetchedAt: new Date().toISOString(), sourceUrl: `${SITE}/video/${id}` }, null, 2),
      'utf8',
    );

    console.log(`\n完成：${dest}`);
    console.log(`大小：${(bytes / 1024 / 1024).toFixed(2)} MB  时长：${detail.durationSec}s`);
    console.log(`作者：${detail.author?.nickname ?? '-'}  文案：${(detail.desc || '').slice(0, 40)}`);
    console.log(`元数据：${dir}\\meta.json${opts.comments ? '  + comments.json' : ''}`);
  } finally {
    cdp(['close-tab', target], T.close);
  }
}

main().catch((e) => {
  console.error(`\nERROR: ${e.message}`);
  process.exit(1);
});
