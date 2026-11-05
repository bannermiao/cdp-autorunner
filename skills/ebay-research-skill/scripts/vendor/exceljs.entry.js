// esbuild 入口：把 exceljs 打成单文件 scripts/vendor/exceljs.bundle.js，运行时免 npm install。
//
// 需要重新打包时（升级 exceljs / 换 Node）在本目录执行：
//   npm install --no-save exceljs@4 esbuild
//   npx esbuild exceljs.entry.js --bundle --platform=node --format=cjs --target=node18 \
//       --minify --legal-comments=none --outfile=exceljs.bundle.js
//   rm -rf node_modules package-lock.json package.json
//
// skill 目录本身不保留任何 npm 工程文件，只留 exceljs.bundle.js。
module.exports = require('exceljs');
