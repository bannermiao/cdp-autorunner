#!/usr/bin/env node
/**
 * cdp-server CLI 入口
 * 找到 postinstall 下载的二进制并执行
 */
var { spawnSync } = require('child_process');
var path = require('path');
var fs = require('fs');

var binaryName = process.platform === 'win32' ? 'cdp-server.exe' : 'cdp-server';

// 查找二进制：优先 node_modules/.bin/，其次 scripts/
var searchPaths = [
  path.join(__dirname, '..', 'scripts', binaryName),
  path.join(__dirname, '..', '..', '.bin', binaryName),
  path.join(__dirname, '..', 'node_modules', '.bin', binaryName),
];

var binPath = null;
for (var i = 0; i < searchPaths.length; i++) {
  if (fs.existsSync(searchPaths[i])) {
    binPath = searchPaths[i];
    break;
  }
}

if (!binPath) {
  console.error('错误: 未找到 cdp-server 二进制');
  console.error('请运行 npm install 或手动下载后放入 scripts/ 目录');
  process.exit(1);
}

var result = spawnSync(binPath, process.argv.slice(2), {
  stdio: 'inherit',
  windowsHide: true,
});

process.exit(result.status);
