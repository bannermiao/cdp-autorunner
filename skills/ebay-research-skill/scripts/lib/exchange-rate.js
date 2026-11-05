'use strict';
/**
 * exchange-rate.js — 统一 USD 口径用的实时汇率（api.exchangerate.fun，免费无 Key，每小时刷新）
 *
 * 响应里 rates[cur] = 「1 USD 兑换多少 cur」，所以原币种金额换 USD 是 **除** 以该汇率。
 * 取数走两条路：Node fetch 失败就用 curl（有些机器 Node 出不了网、代理只在系统层面）。
 * 结果缓存到临时目录，一轮调研只取一次，离线重出报表也能复用；缓存过旧会标注来源。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const API = 'https://api.exchangerate.fun/latest?base=USD';
const CACHE_FILE = path.join(os.tmpdir(), 'ebay-research-fx.json');
const FRESH_MS = 24 * 3600 * 1000;        // 24h 内直接用缓存
const STALE_OK_MS = 7 * 24 * 3600 * 1000; // 拉不到新数据时，7 天内的旧汇率仍可用

const round2 = (n) => Math.round(n * 100) / 100;

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

function readCache() {
  try {
    const o = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!o || !o.rates || !o.timestamp) return null;
    return o;
  } catch (_) {
    return null;
  }
}

function writeCache(o) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(o), 'utf8'); } catch (_) {}
}

function fetchWithNode(timeoutMs) {
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    const timer = setTimeout(() => { try { ac.abort(); } catch (_) {} reject(new Error('fx 超时')); }, timeoutMs);
    fetch(API, { signal: ac.signal })
      .then((r) => { if (!r.ok) throw new Error(`fx http ${r.status}`); return r.json(); })
      .then((d) => { clearTimeout(timer); resolve(d); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

function fetchWithCurl(timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', ['-fsS', '--max-time', String(Math.ceil(timeoutMs / 1000)), API], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} reject(new Error('curl 超时')); }, timeoutMs + 3000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !out.trim()) return reject(new Error(`curl 取汇率失败 exit=${code} ${err.trim()}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

/**
 * 取汇率。返回 { rates, date, source } 或 null（完全取不到且没有可用缓存）。
 * source: live 现取 · cache 24h 内缓存 · stale 拉取失败的旧缓存
 */
async function getFx() {
  const cached = readCache();
  if (cached && Date.now() - cached.timestamp < FRESH_MS) {
    return { rates: cached.rates, date: ymd(cached.timestamp), source: 'cache' };
  }

  let data = null;
  try {
    data = await fetchWithNode(15000);
  } catch (e) {
    try { data = await fetchWithCurl(20000); } catch (e2) { data = null; }
  }

  if (data && data.rates && data.rates.USD !== undefined) {
    const stamp = { rates: data.rates, timestamp: (data.timestamp || Date.now() / 1000) * 1000 };
    writeCache(stamp);
    return { rates: stamp.rates, date: ymd(stamp.timestamp), source: 'live' };
  }

  if (cached && Date.now() - cached.timestamp < STALE_OK_MS) {
    return { rates: cached.rates, date: ymd(cached.timestamp), source: 'stale' };
  }
  return null;
}

// 原币种金额 → USD。cur 为空或 USD 直接返回；币种不在汇率表里返回 null（不臆造）
function toUsd(amount, currency, fx) {
  const v = Number(amount);
  if (amount == null || amount === '' || isNaN(v)) return null;
  const cur = String(currency || '').toUpperCase();
  if (!cur || cur === 'USD') return round2(v);
  const rate = fx && fx.rates ? Number(fx.rates[cur]) : 0;
  if (!(rate > 0)) return null;
  return round2(v / rate);
}

function hasRate(currency, fx) {
  const cur = String(currency || '').toUpperCase();
  if (!cur || cur === 'USD') return true;
  return !!(fx && fx.rates && Number(fx.rates[cur]) > 0);
}

module.exports = { getFx, toUsd, hasRate, API, CACHE_FILE };
