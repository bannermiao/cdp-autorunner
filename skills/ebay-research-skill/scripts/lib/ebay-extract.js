'use strict';
/**
 * ebay-extract.js — eBay 页面提取脚本与统计口径（主脚本与 Worker 共用，只此一份）
 */

const { toUsd } = require('./exchange-rate');

// 列表页：只取商品链接（标题/价格交给详情页，避免列表页字段缺漏）
const LIST_EXTRACT_JS = `
JSON.stringify(
  Array.from(document.querySelectorAll('li.s-card[data-listingid]'))
    .filter(item => !item.dataset.listingid.startsWith('2500'))
    .map(item => (item.querySelector('a.s-card__link')?.href || '').split('?')[0])
    .filter(link => link && link.includes('/itm/'))
)
`;

// 详情页：优先解析内嵌 $M_96613636_C 模块 JSON，页面改版没有该数据时回退 JSON-LD + DOM
const DETAIL_EXTRACT_JS = `
(function(){
  var scripts = document.querySelectorAll('script');
  var jsonRaw = null;
  var pattern = /\\$M_96613636_C=\\(window\\.\\$M_96613636_C\\|\\|\\[\\]\\)\\.concat\\((.*)\\)/;
  for (var i = 0; i < scripts.length; i++) {
    var m = pattern.exec(scripts[i].textContent);
    if (m) { jsonRaw = m[1]; break; }
  }
  var info = {
    item_id: null, title: null, sale_price: null, currency: null,
    image: null, sold: 0, compatible_vehicles: 0, specifics_item: null,
    seller_name: null, store_name: null, positive_rate: null
  };

  if (!jsonRaw) {
    var lds = document.querySelectorAll('script[type="application/ld+json"]');
    for (var li = 0; li < lds.length; li++) {
      try {
        var p = JSON.parse(lds[li].textContent);
        if (p && p['@type'] === 'Product') {
          if (p.name) info.title = p.name;
          if (p.image) {
            if (Array.isArray(p.image) && p.image.length > 0) {
              var f2 = p.image[0];
              info.image = typeof f2 === 'string' ? f2 : (f2.url || null);
            } else if (typeof p.image === 'string') info.image = p.image;
            else if (p.image.url) info.image = p.image.url;
          }
          if (p.offers) {
            if (p.offers.price != null) info.sale_price = parseFloat(p.offers.price);
            if (p.offers.priceCurrency) info.currency = p.offers.priceCurrency;
          }
          break;
        }
      } catch (e) {}
    }
    var sellerEl = document.querySelector('.x-sellercard-atf__about-seller');
    if (sellerEl) {
      var st = sellerEl.textContent.trim().replace(/\\s*\\([\\d,.]+\\)\\s*$/, '').trim();
      if (st) info.seller_name = st;
    }
    var cardEl = document.querySelector('.x-sellercard-atf');
    if (cardEl) {
      var rm2 = cardEl.textContent.match(/(\\d+(?:\\.\\d+)?)%\\s*positive/i);
      if (rm2) info.positive_rate = parseFloat(rm2[1]);
    }
    var qty2 = document.querySelectorAll('#qtyAvailability span');
    if (qty2.length > 0) {
      var sm2 = qty2[qty2.length - 1].textContent.trim().match(/([\\d,]+)\\s*sold/i);
      if (sm2) info.sold = parseInt(sm2[1].replace(/,/g, ''), 10) || 0;
    }
    return JSON.stringify(info);
  }

  var modules = {};
  try {
    var parsed = JSON.parse(jsonRaw);
    for (var j = 0; j < parsed.o.w.length; j++) {
      var mod = parsed.o.w[j];
      if (mod.length > 2 && 'model' in mod[2]) { modules = mod[2].model.modules; break; }
    }
  } catch (e) { throw new Error('解析商品脚本出错: ' + e.message); }

  if (modules.JSONLD && modules.JSONLD.product) {
    var p = modules.JSONLD.product;
    if (p.name) info.title = p.name;
    if (p.image) {
      if (Array.isArray(p.image) && p.image.length > 0) {
        var f = p.image[0];
        info.image = typeof f === 'string' ? f : (f.url || null);
      } else if (p.image.url) info.image = p.image.url;
    }
    if (p.offers) {
      if (p.offers.price) info.sale_price = p.offers.price;
      if (p.offers.priceCurrency) info.currency = p.offers.priceCurrency;
    }
  }

  var pv = modules.BUY_BOX && modules.BUY_BOX.binModel && modules.BUY_BOX.binModel.price && modules.BUY_BOX.binModel.price.value;
  if (pv) {
    if (pv.convertedFromValue != null) { info.sale_price = pv.convertedFromValue; info.currency = pv.convertedFromCurrency; }
    else if (pv.value != null) { info.sale_price = pv.value; info.currency = pv.currency; }
  }

  var qty = document.querySelectorAll('#qtyAvailability span');
  if (qty.length > 0) {
    var sm = qty[qty.length - 1].textContent.trim().match(/([\\d,]+)\\s*sold/i);
    if (sm) info.sold = parseInt(sm[1].replace(/,/g, ''), 10) || 0;
  }

  var s0 = modules.SELLER_CARD_ATF && modules.SELLER_CARD_ATF.sections && modules.SELLER_CARD_ATF.sections[0];
  if (s0) {
    if (s0.profileLogo) {
      info.seller_name = s0.profileLogo.title || null;
      info.store_name = (s0.profileLogo.action && s0.profileLogo.action.params && s0.profileLogo.action.params.store_name) || null;
    }
    if (s0.dataItems && s0.dataItems.length > 0) {
      var rm = (s0.dataItems[0].textSpans && s0.dataItems[0].textSpans[0] && s0.dataItems[0].textSpans[0].text || '').match(/([\\d.]+)%/);
      if (rm) info.positive_rate = parseFloat(rm[1]);
    }
  }

  var ct = modules.COMPATIBILITY_TABLE && modules.COMPATIBILITY_TABLE.paginatedTable;
  if (ct && ct.title && ct.title.textSpans && ct.title.textSpans.length > 0) {
    var nm = ct.title.textSpans[0].text.match(/(\\d+)/);
    if (nm) info.compatible_vehicles = parseInt(nm[1].replace(/[,.]/g, ''), 10) || 0;
  }

  var ft = modules.ABOUT_THIS_ITEM && modules.ABOUT_THIS_ITEM.sections && modules.ABOUT_THIS_ITEM.sections.features && modules.ABOUT_THIS_ITEM.sections.features.dataItems;
  if (ft) {
    var text = '';
    var keys = Object.keys(ft);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var val = ft[key];
      var v0 = val.values && val.values[0];
      if (!v0) continue;
      var t = v0._type === 'ExpandableTextualDisplayBlock'
        ? (v0.textualDisplays && v0.textualDisplays[0] && v0.textualDisplays[0].textSpans && v0.textualDisplays[0].textSpans[0] && v0.textualDisplays[0].textSpans[0].text)
        : (v0.textSpans && v0.textSpans[0] && v0.textSpans[0].text);
      if (t) text += key + ': ' + t + '\\n';
    }
    info.specifics_item = text || null;
  }

  return JSON.stringify(info);
})()
`;

// 90 天成交记录页（purchaseHistory）→ {has_table, rows:[{priceStr, qty, dateStr}]}
// 优先按 tr.app-table__row 取；页面改版没这个 class 时退回「有 ≥4 个 td 的行」
// has_table 用来区分「没有成交」（表格在但没行 → 销量记 0）和「没读到页面」（表格都没 → 字段留空白）
const PURCHASE_HISTORY_EXTRACT_JS = `
(function(){
  var table = document.querySelector('table');
  if (!table) return JSON.stringify({ has_table: false, rows: [] });
  var rows = table.querySelectorAll('tr.app-table__row');
  if (!rows.length) rows = table.querySelectorAll('tr');
  var results = [];
  for (var i = 0; i < rows.length; i++) {
    var tds = rows[i].querySelectorAll('td');
    if (tds.length < 4) continue;
    var qty = parseInt(tds[2].textContent.trim().replace(/[^0-9]/g, ''), 10);
    if (isNaN(qty) || qty <= 0) continue;
    results.push({
      priceStr: tds[1].textContent.trim(),
      qty: qty,
      dateStr: tds[3].textContent.trim()
    });
  }
  return JSON.stringify({ has_table: true, rows: results });
})()
`;

const itemIdOf = (url) => (url.match(/\/itm\/(\d+)/) || [])[1] || '';

const WINDOWS = [7, 30, 90];

// 窗口字段 + 整体口径字段。抓不到成交记录时一律 null（Excel 里是空白，不是 0）
const SALES_FIELDS = (() => {
  const f = [];
  for (const w of WINDOWS) f.push(`sold_${w}days`, `avg_price_${w}days`, `min_price_${w}days`, `max_price_${w}days`);
  return f.concat([
    'gmv_90days', 'median_price_90days', 'std_price_90days',
    'special_qty_90days', 'unpriced_qty_90days',
    'sales_currency', 'sales_currencies', 'fx_date', 'price_basis',
  ]);
})();

const EMPTY_SALES = Object.fromEntries(SALES_FIELDS.map((k) => [k, null]));

function emptyItem(url) {
  return {
    item_id: itemIdOf(url) || null,
    url,
    title: null, sale_price: null, currency: null,
    image: null, sold: 0, compatible_vehicles: 0, specifics_item: null,
    seller_name: null, store_name: null, positive_rate: null,
    sale_price_usd: null,
    ...EMPTY_SALES,
  };
}

// 轮级事实一次性盖到每条记录上：USD 换算值 + 计价基准 + 汇率日期。
// 必须在组装完所有字段之后再调用——成交记录抓不到时会被 EMPTY_SALES 把这些字段冲成 null。
function stampFx(item, fx) {
  item.sale_price_usd = toUsd(item.sale_price, item.currency, fx);
  item.price_basis = fx ? 'USD' : 'SOURCE';
  item.fx_date = fx ? fx.date : null;
  return item;
}

// 价格串 → number。规则：最后一个分隔符是小数点，另一个是千分位。
// 原实现把「先出现的逗号」一律当小数点，$1,234.56 会读成 1.234。
function parsePrice(priceStr) {
  let c = String(priceStr).replace(/[^\d,.]/g, '');
  if (!c) return 0;
  const li = c.lastIndexOf(',');
  const ld = c.lastIndexOf('.');
  if (li > -1 && ld > -1) {
    c = li > ld ? c.replace(/\./g, '').replace(',', '.') : c.replace(/,/g, '');
  } else if (li > -1) {
    c = /^\d{1,3}(,\d{3})+$/.test(c) ? c.replace(/,/g, '') : c.replace(',', '.');
  } else if (ld > -1) {
    c = /^\d{1,3}(\.\d{3})+$/.test(c) ? c.replace(/\./g, '') : c;
  }
  c = c.replace(/[^\d.]/g, '');
  const n = parseFloat(c);
  return isNaN(n) ? 0 : n;
}

const pad2 = (x) => String(x).padStart(2, '0');

// 本地时区格式化。不能用 toISOString：UTC+8 下 "Mar 12" 会被挪成 2025-03-11
function toYmd(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const EN_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// 德语市场（ebay.de）的月份缩写：Mrz/Mai/Okt/Dez 与带变音的 Mär
const DE_MONTHS = { mrz: 3, mai: 5, okt: 10, dez: 12, mär: 3, jan: 1, feb: 2, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, nov: 11 };

const monthToIndex = (name) => {
  const k = String(name).toLowerCase().slice(0, 3);
  return DE_MONTHS[k] || EN_MONTHS[k] || null;
};

const ymd = (y, mo, d) => {
  const Y = Number(y), M = Number(mo), D = Number(d);
  if (!Y || !M || !D || M < 1 || M > 12 || D < 1 || D > 31) return null;
  return `${Y}-${pad2(M)}-${pad2(D)}`;
};

// 成交记录页的日期至少三种写法（多站点 locale）：
//   EN: 18 Jun 2025 at 5:24:27am CST
//   DE: 30 Mai 2025 18:37:57 / 24 Mrz 2025 10:55:15 MEZ
//   CN: 于2025 年 4 月 14 日 21:43:52 CST
// 解析不出来返回 null（该行不计入统计）
function parseDate(dateStr) {
  const raw = String(dateStr).trim();
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return ymd(iso[1], iso[2], iso[3]);

  const cn = raw.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})/);
  if (cn) return ymd(cn[1], cn[2], cn[3]);

  // 丢掉 " at 5:24:27am CST" / " 18:37:57 MEZ" 这类时间与时区尾巴
  const body = raw.split(/\s+at\s+/)[0]
    .replace(/[,.]/g, ' ')
    .replace(/['’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const dmy = body.match(/^(\d{1,2})\s+([^\s]{3,})\s+(\d{4})/);
  if (dmy) {
    const mo = monthToIndex(dmy[2]);
    return mo ? ymd(dmy[3], mo, dmy[1]) : null;
  }
  const mdy = body.match(/^([^\s]{3,})\s+(\d{1,2})\s+(\d{4})/);
  if (mdy) {
    const mo = monthToIndex(mdy[1]);
    return mo ? ymd(mdy[3], mo, mdy[2]) : null;
  }
  return null;
}

// 币种识别：eBay 各站点价格串写法不一（US $95.99 / EUR 47,49 / £1,234.56 / kr 1 234,56）
// 先匹配带国家的符号组合，再抓三位 ISO 代码，裸 $ 记 USD（eBay 用 "AU $"、"CA $" 区分其他美元），认不出返回 null
const CURRENCY_PREFIX = [
  ['US $', 'USD'], ['AU $', 'AUD'], ['CA $', 'CAD'], ['NZ $', 'NZD'],
  ['HK $', 'HKD'], ['SG $', 'SGD'], ['€', 'EUR'], ['£', 'GBP'],
  ['¥', 'JPY'], ['kr', 'SEK'], [' zł', 'PLN'],
];

function detectCurrency(priceStr) {
  const s = String(priceStr || '');
  for (const [token, code] of CURRENCY_PREFIX) if (s.includes(token)) return code;
  const iso = s.match(/\b([A-Z]{3})\b/);
  if (iso) return iso[1];
  if (s.includes('$')) return 'USD';
  return null;
}

const round2 = (n) => Math.round(n * 100) / 100;

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// 样本标准差（ddof=1），与 pandas .std() 对齐；不足 2 个样本返回 null
function sampleStd(nums) {
  if (nums.length < 2) return null;
  const m = nums.reduce((a, b) => a + b, 0) / nums.length;
  const v = nums.reduce((a, b) => a + (b - m) ** 2, 0) / (nums.length - 1);
  return Math.sqrt(v);
}

/**
 * 成交记录 → 7/30/90 天窗口 + 整体口径。
 *
 * 给了汇率表 fx 时，每一行按**它自己的原币种**先换成 USD 再统计，所以同一商品记录里
 * EUR 与 US $ 混着出现也能加到一起；price_basis 记下这批数是 'USD' 还是 'SOURCE'（原币种）。
 *
 * 口径（沿用 parseHtml.py）：
 *   同一天多笔合并：qty 累加，当日价格取最高
 *   价格为 0 = 特惠/促销价，销量计入总量但不进价格统计，单列 special_qty_90days
 *   认不出币种 / 汇率表里没有该币种 → 只计销量、不进价格统计，记进 unpriced_qty_90days
 *   窗口「近 N 天」含今天：today-(N-1) ~ today
 *   某窗口没有非特惠成交 → 价格字段 null（Excel 里空白）
 */
function calcSalesStats(rawRows, fx) {
  const byDate = new Map();
  const currencies = new Set();
  let firstCurrency = null;

  for (const r of rawRows) {
    const date = parseDate(r.dateStr);
    if (!date) continue;
    const qty = Number(r.qty) || 0;
    const cur = detectCurrency(r.priceStr);
    if (cur) { currencies.add(cur); if (!firstCurrency) firstCurrency = cur; }

    const day = byDate.get(date) || { date, qty: 0, price: 0, special_qty: 0, unpriced_qty: 0 };
    day.qty += qty;
    const src = parsePrice(r.priceStr);
    if (src <= 0) {
      day.special_qty += qty;
    } else {
      // 有汇率表但认不出币种时不去猜（当成 USD 会算错），归到未换算
      const usd = fx ? (cur ? toUsd(src, cur, fx) : null) : src;
      if (usd == null) day.unpriced_qty += qty;
      else if (usd > day.price) day.price = usd;
    }
    byDate.set(date, day);
  }

  const daily = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const today = new Date();
  const out = {
    ...EMPTY_SALES,
    sales_currency: firstCurrency,
    sales_currencies: currencies.size ? [...currencies].sort().join(',') : null,
    fx_date: fx ? fx.date : null,
    price_basis: fx ? 'USD' : 'SOURCE',
  };

  // 窗口「近 N 天」= today-(N-1) ~ today，含今天
  const windowRows = (w) => {
    const start = toYmd(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (w - 1)));
    return daily.filter((d) => d.date >= start);
  };

  for (const w of WINDOWS) {
    const inWin = windowRows(w);
    const priced = inWin.filter((d) => d.price > 0);
    out[`sold_${w}days`] = inWin.reduce((s, d) => s + d.qty, 0);
    if (priced.length) {
      const prices = priced.map((d) => d.price);
      out[`avg_price_${w}days`] = round2(prices.reduce((a, b) => a + b, 0) / prices.length);
      out[`min_price_${w}days`] = Math.min(...prices);
      out[`max_price_${w}days`] = Math.max(...prices);
    }
  }

  // 整体口径也限定在 90 天窗口内，字段名与统计范围保持一致
  const in90 = windowRows(90);
  const priced = in90.filter((d) => d.price > 0);
  if (priced.length) {
    const prices = priced.map((d) => d.price);
    out.gmv_90days = round2(priced.reduce((s, d) => s + d.price * d.qty, 0));
    out.median_price_90days = round2(median(prices));
    const sd = sampleStd(prices);
    out.std_price_90days = sd === null ? null : round2(sd);
  }
  out.special_qty_90days = in90.reduce((s, d) => s + d.special_qty, 0);
  out.unpriced_qty_90days = in90.reduce((s, d) => s + d.unpriced_qty, 0);
  return out;
}

// eBay 的 JSON-LD / 模块 JSON 里标题常带 HTML 实体（LED DRL &amp; Turn Signal），
// 不解码会原样进 Excel 和报表
const NAMED_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  '&nbsp;': ' ', '&ndash;': '–', '&mdash;': '—', '&middot;': '·',
  '&reg;': '®', '&trade;': '™', '&deg;': '°', '&hellip;': '…', '&plusmn;': '±',
};

function decodeEntities(s) {
  if (!s) return s;
  let out = String(s);
  for (let pass = 0; pass < 2; pass++) {
    out = out
      .replace(/&#(\d+);/g, (m, d) => safeCodePoint(parseInt(d, 10)))
      .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeCodePoint(parseInt(h, 16)))
      .replace(/&[a-zA-Z]+;/g, (m) => (NAMED_ENTITIES[m] === undefined ? m : NAMED_ENTITIES[m]));
  }
  return out;
}

const safeCodePoint = (n) => {
  try { return String.fromCodePoint(n); } catch (_) { return ''; }
};

const TEXT_FIELDS = ['title', 'seller_name', 'store_name', 'specifics_item', 'image', 'url'];

// 统一清洗：解码实体 + 收掉多余空白
function sanitizeItem(item) {
  for (const k of TEXT_FIELDS) {
    if (typeof item[k] === 'string') item[k] = decodeEntities(item[k]).replace(/[ \t]+/g, ' ').trim();
  }
  return item;
}

module.exports = {
  LIST_EXTRACT_JS,
  DETAIL_EXTRACT_JS,
  PURCHASE_HISTORY_EXTRACT_JS,
  itemIdOf,
  emptyItem,
  stampFx,
  WINDOWS,
  SALES_FIELDS,
  EMPTY_SALES,
  parsePrice,
  parseDate,
  detectCurrency,
  calcSalesStats,
  decodeEntities,
  sanitizeItem,
};
