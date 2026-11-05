#!/usr/bin/env node
/**
 * prepare.mjs — 闸门校验 + 切镜抽帧 + 口播转写
 *
 * 用法:
 *   node prepare.mjs <视频目录> [--force] [--skip-asr]
 *
 * 前置（缺一即停，本 skill 不负责下载）:
 *   <视频目录>/video.mp4 / meta.json / comments.json
 *
 * 产出:
 *   media.json    切镜时间点、帧索引、拼图索引（帧号 ↔ 秒数）
 *   转写.txt      ASR 全文，句首带 [分:秒] —— 仅在有有效口播时生成
 *   口播.json     判为无有效口播（纯音乐/只有片尾口号）时的证据：原始识别 + 度量 + 原因
 *   拼图-NN.jpg   4 列 × 每张最多 16 格，末张按实际帧数裁掉空行；每格烧时间戳（字体缺失时不烧）
 *
 * 转写不直接落盘：先过 judgeSpeech 体检。字数 < speechMinChars 或语速 < speechMinRate
 * 就判为无口播，否则下游会把歌词当口播算出假语速、假覆盖率。
 *
 * key 走 config.mjs（硅基流动），配一次即可：node config.mjs --set-key sk-xxx
 *
 * 纯 Node 标准库，零 npm 依赖。需 ffmpeg 在 PATH 里。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { loadConfig } from './config.mjs';

// ---- 配置 ----

const MEDIA = {
  sceneThreshold: 0.3,   // 切镜灵敏度
  frameIntervalSec: 10,  // 抽帧基准间隔
  frameCap: 120,         // 总帧上限，超了自动放大间隔
  cols: 4,
  cellsPerSheet: 16,
  cellWidth: 480,
  timeoutMs: 600_000,    // 整片要解码两遍，长片子给足时间
};

/** drawtext 必须有字体文件；时间戳只有数字和冒号，拉丁字体就够 */
const FONT_CANDIDATES = [
  'C:/Windows/Fonts/arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
];

const ASR = {
  concurrency: 4,
  timeoutMs: 120_000,
  retries: 3,
  chunkSec: 60,   // 固定 60 秒切片：不影响计费，只影响并发粒度与单请求可靠性
};

// 水印/噪声词：只由这些词构成的句子不算口播内容
const NOISE = /^(抖音|抖音号|douyin|dou\+?|字幕|字幕by\S*|@\S+|点赞|关注|转发|评论|收藏|音乐|纯音乐|bgm|\d+)$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 闸门 ----

function gate(dir) {
  const need = ['video.mp4', 'meta.json', 'comments.json'];
  const missing = need.filter((f) => !existsSync(join(dir, f)));
  if (missing.length) {
    console.error(`\n素材不全，无法开始：${dir}`);
    missing.forEach((f) => console.error(`  缺失 ${f}`));
    console.error('\n本 skill 只做分析，不负责下载。请先跑：');
    console.error('  node <cdp-autorunner-skill>/scripts/douyin/douyin-download.js <链接或id> --out <目录>');
    process.exit(1);
  }
  const size = statSync(join(dir, 'video.mp4')).size;
  if (size < 100 * 1024) {
    console.error(`\nvideo.mp4 只有 ${(size / 1024).toFixed(0)} KB，像是下载中断的残片，重下一遍再分析`);
    process.exit(1);
  }
  console.log(`闸门通过：${basename(dir)}  video.mp4 ${(size / 1024 / 1024).toFixed(2)} MB`);
}

// ---- ffmpeg ----

function runFfmpeg(args, cwd, timeoutMs = MEDIA.timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', ...args], { cwd, windowsHide: true });
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('ffmpeg 超时')); }, timeoutMs);
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', () => { clearTimeout(timer); reject(new Error('起不来 ffmpeg —— 请确认它在 PATH 里')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(err);
      else reject(new Error(`ffmpeg 退出码 ${code}：${err.slice(-300)}`));
    });
  });
}

/** showinfo 里的帧时间点（秒）。不能用 metadata=print —— fps 产出的帧没 metadata */
function ptsTimes(log) {
  return [...log.matchAll(/n:\s*\d+\s+pts:\s*-?\d+\s+pts_time:([\d.]+)/g)].map((m) => Number(Number(m[1]).toFixed(2)));
}

function timestampFilter() {
  const font = FONT_CANDIDATES.find((f) => existsSync(f));
  if (!font) return null;
  const esc = font.replace(/([A-Za-z]):\//, '$1\\:/'); // C:/ → C\:/（ffmpeg 要转义盘符冒号）
  return `drawtext=fontfile='${esc}':text='%{pts\\:hms}':x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=5`;
}

async function detectShots(videoPath) {
  const log = await runFfmpeg(['-y', '-i', videoPath, '-vf', `select='gt(scene,${MEDIA.sceneThreshold})',showinfo`, '-an', '-f', 'null', '-'], process.cwd());
  return ptsTimes(log);
}

/** 抽帧 + 拼图单趟出图，不落中间帧 */
async function buildSheets(videoPath, outDir, durationSec) {
  const interval = Math.max(MEDIA.frameIntervalSec, Math.ceil(durationSec / MEDIA.frameCap));
  const rows = Math.ceil(MEDIA.cellsPerSheet / MEDIA.cols);
  const stamp = timestampFilter();
  const filters = [
    `fps=1/${interval}`,
    `scale=${MEDIA.cellWidth}:-1`,
    stamp,
    'showinfo',
    `tile=${MEDIA.cols}x${rows}:padding=4:color=0x0a0a0a`,
  ].filter(Boolean).join(',');

  const log = await runFfmpeg(
    ['-y', '-i', videoPath, '-vf', filters, '-fps_mode', 'passthrough', '-q:v', '3', '-start_number', '1', '拼图.tmp-%02d.jpg'],
    outDir,
  );
  const times = ptsTimes(log);
  const files = readdirSync(outDir).filter((f) => /^拼图\.tmp-\d+\.jpg$/.test(f)).sort();
  if (!files.length) throw new Error('抽帧拼图没有产出（ffmpeg 静默失败？）');
  if (!times.length) throw new Error('抽帧没取到时间戳（showinfo 无输出？）');

  for (const old of readdirSync(outDir).filter((f) => /^拼图-\d+\.jpg$/.test(f))) rmSync(join(outDir, old), { force: true });

  const sheets = [];
  for (let b = 0; b < files.length; b++) {
    const from = b * MEDIA.cellsPerSheet + 1;
    const to = Math.min(from + MEDIA.cellsPerSheet - 1, times.length);
    const name = `拼图-${String(b + 1).padStart(2, '0')}.jpg`;
    renameSync(join(outDir, files[b]), join(outDir, name));

    // 末张没填满时整行空位裁掉：否则报告里是一整块空白，看着像图没加载
    const usedRows = Math.ceil((to - from + 1) / MEDIA.cols);
    if (usedRows < rows) {
      const cut = `拼图.crop-${String(b + 1).padStart(2, '0')}.jpg`;
      await runFfmpeg(['-y', '-i', name, '-vf', `crop=iw:trunc(ih*${usedRows}/${rows}):0:0`, '-q:v', '3', cut], outDir);
      rmSync(join(outDir, name), { force: true });
      renameSync(join(outDir, cut), join(outDir, name));
    }

    sheets.push({
      文件: name, 帧从: from, 帧到: to, 格: `${MEDIA.cols}×${usedRows}`,
      秒从: times[from - 1], 秒到: times[to - 1],
      空位: MEDIA.cellsPerSheet - (to - from + 1),
      字节: statSync(join(outDir, name)).size,
    });
  }

  return {
    帧: {
      张数: times.length, 间隔秒: interval, 列: MEDIA.cols, 烧时间戳: !!stamp,
      索引: times.map((秒, i) => ({ 序号: i + 1, 秒 })),
    },
    拼图: sheets,
  };
}

async function probeDuration(videoPath) {
  try {
    const log = await runFfmpeg(['-i', videoPath, '-f', 'null', '-'], process.cwd(), 60_000);
    const m = log.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (!m) return 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  } catch (e) {
    const m = String(e.message).match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (!m) return 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
}

// ---- ASR ----

const wavSeconds = (file) => Math.max(0, (statSync(file).size - 44) / 32_000);

const stamp = (sec) => {
  const m = Math.floor(sec / 60);
  const rest = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${rest.toFixed(1).padStart(4, '0')}`;
};

async function asrOne(file, cfg) {
  const buf = readFileSync(file);
  let last = null;
  for (let attempt = 0; attempt < ASR.retries; attempt++) {
    try {
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: 'audio/wav' }), 'chunk.wav');
      fd.append('model', cfg.asrModel);
      if (cfg.language) fd.append('language', cfg.language);
      fd.append('response_format', 'verbose_json'); // 只有它能给句级时间戳
      const res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.apiKey}` },
        body: fd,
        signal: AbortSignal.timeout(ASR.timeoutMs),
      });
      if (!res.ok) throw new Error(`ASR HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      const lines = (j.segments ?? [])
        .map((x) => ({ start: Number.isFinite(Number(x?.start)) ? Number(x.start) : null, text: String(x?.text ?? '').trim() }))
        .filter((x) => x.text);
      if (lines.length) return lines;
      const whole = String(j.text ?? '').trim();
      return whole ? [{ start: null, text: whole }] : [];
    } catch (e) {
      last = e;
      await sleep(1200 * (attempt + 1));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** 有效字：汉字算 1，英文数字算 0.5（与 card.mjs 的 spokenChars 同口径） */
function speechChars(s) {
  const t = String(s).replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '');
  const han = (t.match(/\p{Script=Han}/gu) || []).length;
  const lat = (t.match(/[A-Za-z0-9]/g) || []).length;
  return han + Math.floor(lat / 2);
}

/**
 * 转写结果体检：区分「真口播」与「歌词 / 环境音 / 水印」。
 * ASR 对纯音乐类视频照样会出几句词（主题曲歌词、片尾"抖音"），
 * 如果直接落 转写.txt，下游会把它当口播算语速、覆盖率，报告里全是假数据。
 */
function judgeSpeech(lines, durSec, cfg) {
  const 逐句 = lines.map((l) => ({ ...l, 字: speechChars(l.s) }));
  const 去噪 = 逐句.filter((l) => !NOISE.test(l.s.replace(/[\s，。,.!！?？、~～]+/g, '')));
  const 净字 = 去噪.reduce((a, x) => a + x.字, 0);
  const 每分钟 = durSec > 0 ? Math.round(净字 / (durSec / 60)) : 0;
  const 度量 = {
    句数: lines.length,
    总字: 逐句.reduce((a, x) => a + x.字, 0),
    净字,
    每分钟,
    去噪句数: 去噪.length,
    时长秒: Math.round(durSec),
  };

  const minChars = cfg.speechMinChars;
  const minRate = cfg.speechMinRate;
  if (!去噪.length) return { 有效: false, 度量, 原因: '识别结果全是水印 / 噪声词' };
  if (净字 < minChars) return { 有效: false, 度量, 原因: `有效字数 ${净字}，低于阈值 ${minChars}` };
  if (每分钟 < minRate) {
    return { 有效: false, 度量, 原因: `语速 ${每分钟} 字/分，低于口播阈值 ${minRate}（多为歌词或环境音）` };
  }
  return { 有效: true, 度量 };
}

async function transcribe(videoPath, outDir, cfg) {
  const wav = join(outDir, '.audio.wav');
  await runFfmpeg(['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], outDir, MEDIA.timeoutMs);

  const total = Math.ceil(wavSeconds(wav));
  if (!total) throw new Error('抽出来的音频是空的（视频没有音轨？）');

  const chunks = [];
  for (let i = 0; i < Math.ceil(total / ASR.chunkSec); i++) {
    const start = i * ASR.chunkSec;
    const len = Math.min(ASR.chunkSec, total - start);
    const file = join(outDir, `.chunk-${String(i + 1).padStart(3, '0')}.wav`);
    await runFfmpeg(['-y', '-i', wav, '-ss', String(start), '-t', String(len), '-c', 'copy', file], outDir, 60_000);
    chunks.push({ file, offset: start });
  }

  console.log(`   切了 ${chunks.length} 片，并发 ${ASR.concurrency} 上传…`);
  const results = new Array(chunks.length).fill(null);
  let cursor = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(ASR.concurrency, chunks.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= chunks.length) return;
        results[i] = await asrOne(chunks[i].file, cfg);
        done++;
        process.stdout.write(`\r   转写 ${done}/${chunks.length} 片…`);
      }
    }),
  );
  process.stdout.write('\n');

  const lines = [];
  results.forEach((segs, i) => {
    const offset = chunks[i].offset;
    for (const s of segs ?? []) lines.push({ t: Number(((s.start ?? 0) + offset).toFixed(2)), s: s.text });
  });
  lines.sort((a, b) => a.t - b.t);

  // 同一时间点相邻重复句去重（切片边界会各吐半句）
  const merged = [];
  for (const l of lines) {
    const prev = merged[merged.length - 1];
    if (prev && prev.s === l.s && Math.abs(prev.t - l.t) < 1.5) continue;
    merged.push(l);
  }

  const verdict = judgeSpeech(merged, total, cfg);
  const text = merged.map((x) => `[${stamp(x.t)}] ${x.s}`).join('\n');

  if (verdict.有效) {
    writeFileSync(join(outDir, '转写.txt'), text + '\n', 'utf8');
    rmSync(join(outDir, '口播.json'), { force: true });
  } else {
    // 证据留着：原始识别文本 + 度量，人工能核对是不是真的没口播
    rmSync(join(outDir, '转写.txt'), { force: true });
    writeFileSync(
      join(outDir, '口播.json'),
      JSON.stringify(
        {
          判定: '无有效口播',
          原因: verdict.原因,
          度量: verdict.度量,
          阈值: { 有效字数: cfg.speechMinChars, 语速: cfg.speechMinRate },
          原始识别: merged,
          说明: '判为纯音乐 / 无口播，不生成 转写.txt。card.json 不带 口播稿，报告不画口播板块。',
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
  }

  for (const c of chunks) rmSync(c.file, { force: true });
  for (const f of ['.audio.wav', '.audio.wav.tmp']) rmSync(join(outDir, f), { force: true });
  return { lines: merged, verdict };
}

// ---- 主流程 ----

async function main() {
  const argv = process.argv.slice(2);
  const dir = argv.find((a) => !a.startsWith('--'));
  const force = argv.includes('--force');
  const skipAsr = argv.includes('--skip-asr');
  if (!dir) {
    console.error('用法: node prepare.mjs <视频目录> [--force] [--skip-asr]');
    process.exit(1);
  }
  const abs = resolve(dir);
  if (!existsSync(abs)) {
    console.error(`目录不存在：${dir}`);
    process.exit(1);
  }

  gate(abs);

  const videoPath = join(abs, 'video.mp4');
  const mediaFile = join(abs, 'media.json');
  const asrFile = join(abs, '转写.txt');
  const speechFile = join(abs, '口播.json');

  // ① 画面
  let media = force ? null : (existsSync(mediaFile) ? JSON.parse(readFileSync(mediaFile, 'utf8')) : null);
  if (media && existsSync(join(abs, media.拼图?.[0]?.文件 ?? '拼图-01.jpg'))) {
    console.log(`画面已有，跳过（${media.拼图.length} 张拼图 / 切镜 ${media.切镜数} 次）`);
  } else {
    console.log('切镜 + 抽帧拼图…');
    const duration = await probeDuration(videoPath);
    if (!duration) throw new Error('读不到视频时长（文件损坏？）');
    try {
      const shots = await detectShots(videoPath);
      const sheets = await buildSheets(videoPath, abs, duration);
      media = { 切镜数: shots.length, 切镜: shots, ...sheets };
      console.log(`   切镜 ${shots.length} 次 / 抽帧 ${sheets.帧.张数} 张 / 拼图 ${sheets.拼图.length} 张`);
    } catch (e) {
      // 画面失败不阻断：报告侧把画面维度写进缺口
      media = { 切镜数: 0, 切镜: [], 失败: e.message };
      console.error(`   画面加工失败（不阻断）：${e.message}`);
    }
    writeFileSync(mediaFile, JSON.stringify(media, null, 2), 'utf8');
  }

  // ② 口播
  if (skipAsr) {
    console.log('跳过转写（--skip-asr）');
  } else if ((existsSync(asrFile) || existsSync(speechFile)) && !force) {
    console.log(
      existsSync(asrFile)
        ? '转写已有，跳过'
        : '已判定无有效口播，跳过（要重判加 --force）',
    );
  } else {
    const cfg = loadConfig();
    if (!cfg.apiKey) {
      console.log('没有配置 key，跳过转写（报告将缺口播维度）—— 配一次：node config.mjs --set-key sk-xxx');
    } else {
      console.log('口播转写…');
      try {
        const { lines, verdict } = await transcribe(videoPath, abs, cfg);
        if (verdict.有效) {
          console.log(`   口播 ${lines.length} 句 / ${verdict.度量.每分钟} 字每分 → 转写.txt`);
        } else {
          console.log(`   无有效口播：${verdict.原因}`);
          console.log('   → 判为纯音乐，不生成 转写.txt（识别原文与度量见 口播.json）');
        }
      } catch (e) {
        console.error(`   转写失败（不阻断）：${e.message}`);
      }
    }
  }

  console.log('\nprepare 完成。下一步：node card.mjs ' + abs);
}

main().catch((e) => {
  console.error(`\nERROR: ${e.message}`);
  process.exit(1);
});
