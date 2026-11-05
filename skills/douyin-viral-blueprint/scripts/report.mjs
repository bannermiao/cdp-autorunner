#!/usr/bin/env node
/**
 * report.mjs — 把 card.json + report.json 渲染成单文件 HTML
 *
 * 用法:
 *   node report.mjs <视频目录> [--out <文件名>]
 *
 * 输入: card.json（必需）+ report.json（必需，agent 产物）
 * 产出: report.html —— 单文件，抽帧图 base64 内嵌，拷走即可看
 *
 * ECharts（assets/echarts.min.js，4.3.0 全量 734 KB）直接内联进 HTML，零外部请求，断网可看。
 * 该文件缺失时退回 CDN 多源加载，报告就变成联网才能出图 —— 打包必须带上它。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, '..', 'assets', 'report-template.html');

function main() {
  const argv = process.argv.slice(2);
  const raw = argv.find((a) => !a.startsWith('--'));
  const outIdx = argv.indexOf('--out');
  if (!raw) {
    console.error('用法: node report.mjs <视频目录> [--out report.html]');
    process.exit(1);
  }
  const dir = resolve(raw);
  const cardFile = join(dir, 'card.json');
  const reportFile = join(dir, 'report.json');

  if (!existsSync(cardFile)) {
    console.error(`缺 card.json：先跑 node card.mjs ${raw}`);
    process.exit(1);
  }
  if (!existsSync(reportFile)) {
    console.error(`缺 report.json：agent 还没写报告。先按 references/report-contract.md 写好再渲染`);
    process.exit(1);
  }

  const card = JSON.parse(readFileSync(cardFile, 'utf8'));
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  if (!existsSync(TEMPLATE)) {
    console.error(`模板缺失：${TEMPLATE}`);
    process.exit(1);
  }

  // 抽帧图内嵌成 dataURL（kiln 的「下载报告」就是这么做的）：
  // 报告变成真正单文件，拷走/发人都能看，不依赖同目录图片。
  let inlined = 0;
  const sheets = card?.画面?.拼图;
  if (Array.isArray(sheets)) {
    for (const p of sheets) {
      const f = join(dir, p.文件 || '');
      if (!p.文件 || !existsSync(f)) continue;
      p.dataUrl = `data:image/jpeg;base64,${readFileSync(f).toString('base64')}`;
      inlined++;
    }
  }

  // ECharts 内联：报告彻底离线可用，不依赖任何 CDN。
  // assets/echarts.min.js 缺失时退回到 CDN 加载（保证还能出图）。
  const ECHARTS = join(HERE, '..', 'assets', 'echarts.min.js');
  let echartsJs;
  let ecMode;
  if (existsSync(ECHARTS)) {
    const src = readFileSync(ECHARTS, 'utf8');
    echartsJs = src.includes('</script') ? src.replace(/<\/script/gi, '<\\/script') : src;
    ecMode = `内联 ${(Buffer.byteLength(echartsJs, 'utf8') / 1024).toFixed(0)} KB`;
  } else {
    echartsJs = `window.__ec = new Promise(function(resolve){
      var srcs=['https://cdn.staticfile.net/echarts/4.3.0/echarts.min.js',
                'https://registry.npmmirror.com/echarts/4.3.0/files/dist/echarts.min.js'];
      var i=0; function next(){ if(i>=srcs.length) return resolve(null);
        var s=document.createElement('script'); s.src=srcs[i++];
        s.onload=function(){resolve(window.echarts||null)}; s.onerror=next;
        document.head.appendChild(s); } next();
    });`;
    ecMode = 'CDN（assets/echarts.min.js 缺失）';
  }

  let html = readFileSync(TEMPLATE, 'utf8').replace('/*__ECHARTS__*/', () => echartsJs);
  html = html.replace(
    '/*__DATA__*/null',
    () => JSON.stringify({ card, report }).replace(/<\//g, '<\\/'),
  );

  const out = outIdx >= 0 ? resolve(argv[outIdx + 1]) : join(dir, 'report.html');
  writeFileSync(out, html, 'utf8');

  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
  console.log(`报告已生成：${out}（${kb} KB｜抽帧内嵌 ${inlined} 张｜ECharts ${ecMode}）`);
}

main();
