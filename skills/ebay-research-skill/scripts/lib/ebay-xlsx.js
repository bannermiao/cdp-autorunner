'use strict';
/**
 * ebay-xlsx.js — 输出 .xlsx 明细表，供后期进一步统计（透视/求和/筛选）
 *
 * 口径：价格、销量、好评率写成数值型单元格（不带货币符号），没抓到的留空白而不是 0，
 * 免得空白项被当成 0 拉低后续均值；item_id / 链接 / 属性走文本，长数字不会变科学计数。
 * 币种由 currency 列说明。
 */

const COLUMNS = [
  { header: 'item_id', key: 'item_id', width: 16 },
  { header: '链接', key: 'url', width: 46 },
  { header: '图片', key: 'image', width: 46 },
  { header: '标题', key: 'title', width: 60 },
  { header: '命中关键词', key: 'keywords', width: 26 },
  { header: '现价', key: 'sale_price', width: 11, numFmt: '#,##0.00' },
  { header: '现币种', key: 'currency', width: 9 },
  { header: '现价USD', key: 'sale_price_usd', width: 11, numFmt: '#,##0.00' },
  { header: '计价基准', key: 'price_basis', width: 10 },
  { header: '总销量', key: 'sold', width: 10, numFmt: '#,##0' },
  { header: '好评率%', key: 'positive_rate', width: 9, numFmt: '0.0' },
  { header: '适配车辆数', key: 'compatible_vehicles', width: 11, numFmt: '#,##0' },
  { header: '7天销量', key: 'sold_7days', width: 10, numFmt: '#,##0' },
  { header: '7天均价', key: 'avg_price_7days', width: 11, numFmt: '#,##0.00', basis: true },
  { header: '7天最低价', key: 'min_price_7days', width: 12, numFmt: '#,##0.00', basis: true },
  { header: '7天最高价', key: 'max_price_7days', width: 12, numFmt: '#,##0.00', basis: true },
  { header: '30天销量', key: 'sold_30days', width: 11, numFmt: '#,##0' },
  { header: '30天均价', key: 'avg_price_30days', width: 11, numFmt: '#,##0.00', basis: true },
  { header: '30天最低价', key: 'min_price_30days', width: 12, numFmt: '#,##0.00', basis: true },
  { header: '30天最高价', key: 'max_price_30days', width: 12, numFmt: '#,##0.00', basis: true },
  { header: '90天销量', key: 'sold_90days', width: 11, numFmt: '#,##0' },
  { header: '90天均价', key: 'avg_price_90days', width: 11, numFmt: '#,##0.00', basis: true },
  { header: '90天最低价', key: 'min_price_90days', width: 12, numFmt: '#,##0.00', basis: true },
  { header: '90天最高价', key: 'max_price_90days', width: 12, numFmt: '#,##0.00', basis: true },
  { header: '90天成交额', key: 'gmv_90days', width: 13, numFmt: '#,##0.00', basis: true },
  { header: '90天中位价', key: 'median_price_90days', width: 12, numFmt: '#,##0.00', basis: true },
  { header: '90天价标差', key: 'std_price_90days', width: 12, numFmt: '#,##0.00', basis: true },
  { header: '特惠件数', key: 'special_qty_90days', width: 10, numFmt: '#,##0' },
  { header: '未换算件数', key: 'unpriced_qty_90days', width: 11, numFmt: '#,##0' },
  { header: '成交币种', key: 'sales_currency', width: 10 },
  { header: '成交币种集合', key: 'sales_currencies', width: 14 },
  { header: '汇率日期', key: 'fx_date', width: 12 },
  { header: '卖家', key: 'seller_name', width: 22 },
  { header: '店铺', key: 'store_name', width: 22 },
  { header: '商品属性', key: 'specifics_item', width: 60, wrap: true },
];

// 文本列 = 没有 numFmt 的列。数值列里没抓到的一律留空白，不写成 0 污染后续均值/占比。
const toCell = (col, v) => {
  if (!col.numFmt) return v == null ? '' : String(v);
  const n = Number(v);
  return (v == null || v === '' || isNaN(n)) ? null : n;
};

// exceljs 已用 esbuild 打进 scripts/vendor/exceljs.bundle.js，随 skill 分发，运行时不需要 node_modules。
function loadExcelJS() {
  try {
    return require('../vendor/exceljs.bundle.js');
  } catch (e) {
    throw new Error('缺少 scripts/vendor/exceljs.bundle.js，重新打包方法见 scripts/vendor/exceljs.entry.js');
  }
}

// 数据行固定行高。Excel 用「磅」，150px ÷ 1.333 ≈ 112.5pt
const ROW_HEIGHT_PT = 112.5;

async function writeXlsx(items, outputFile) {
  const ExcelJS = loadExcelJS();

  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const ws = wb.addWorksheet('商品数据', { views: [{ state: 'frozen', ySplit: 1 }] });

  // 金额列表头按这批数据声明的计价基准标注。只看明确带 price_basis 的行——
  // 个别成交页没读到的行不该把整表的标注翻成原币种；老缓存完全没这字段时才用保守回退
  const declared = items.filter((i) => i.price_basis);
  const basisLabel = declared.length
    ? (declared.some((i) => i.price_basis === 'SOURCE') ? '原币种' : 'USD')
    : (items.some((i) => i.sale_price || i.gmv_90days) ? '原币种' : 'USD');
  ws.columns = COLUMNS.map((c) => ({
    header: c.basis ? `${c.header}(${basisLabel})` : c.header,
    key: c.key,
    width: c.width,
  }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).height = 28;
  ws.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' };

  for (const item of items) {
    const row = ws.addRow(COLUMNS.map((c) => toCell(c, item[c.key])));
    row.height = ROW_HEIGHT_PT;
    COLUMNS.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      if (c.numFmt) cell.numFmt = c.numFmt;
      cell.alignment = { horizontal: c.wrap ? 'left' : 'center', vertical: 'middle', wrapText: !!c.wrap };
    });
  }

  if (items.length) {
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: items.length + 1, column: COLUMNS.length },
    };
  }

  await wb.xlsx.writeFile(outputFile);
  return { outputFile, rows: items.length };
}

module.exports = { writeXlsx, COLUMNS };
