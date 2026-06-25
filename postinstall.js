/**
 * postinstall.js — 安装后自动下载对应平台的 cdp-server 二进制
 *
 * 从 GitHub Releases 下载当前平台对应的 cdp-server 可执行文件。
 * 如果本地已有二进制（手动编译），则跳过下载。
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const REPO = 'bannermiao/cdp-autorunner';
const VERSION = 'v' + (process.env.npm_package_version || '1.0.0');

const PLATFORM_MAP = {
  'win32-x64':  { name: 'cdp-server-win-x64.exe', zip: false },
  'darwin-x64': { name: 'cdp-server-darwin-amd64', zip: true },
  'darwin-arm64': { name: 'cdp-server-darwin-arm64', zip: true },
  'linux-x64':  { name: 'cdp-server-linux-amd64', zip: true },
};

function getTarget() {
  var key = process.platform + '-' + process.arch;
  var info = PLATFORM_MAP[key];
  if (!info) {
    console.error('不支持的平台: ' + key);
    console.error('支持的平台: ' + Object.keys(PLATFORM_MAP).join(', '));
    process.exit(1);
  }
  return info;
}

function download(url, dest) {
  return new Promise(function(resolve, reject) {
    var file = fs.createWriteStream(dest);
    console.log('下载: ' + url);
    https.get(url, function(res) {
      if (res.statusCode !== 200) {
        reject(new Error('下载失败 (HTTP ' + res.statusCode + ')'));
        return;
      }
      res.pipe(file);
      file.on('finish', function() {
        file.close();
        resolve();
      });
    }).on('error', function(err) {
      fs.unlink(dest, function() {});
      reject(err);
    });
  });
}

async function main() {
  // 目标路径：在 scripts/ 目录下
  var targetDir = path.join(__dirname, 'scripts');
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  var target = getTarget();
  var binaryName = process.platform === 'win32' ? 'cdp-server.exe' : 'cdp-server';
  var binaryPath = path.join(targetDir, binaryName);

  // 如果已有二进制，跳过下载
  if (fs.existsSync(binaryPath)) {
    console.log('cdp-server 已存在: ' + binaryPath);
    return;
  }

  var fileName = target.zip ? target.name + '.gz' : target.name;
  var url = 'https://github.com/' + REPO + '/releases/download/' + VERSION + '/' + fileName;
  var tmpPath = path.join(targetDir, '.download.tmp');

  try {
    await download(url, tmpPath);
    // 如果是 gz 压缩，需要解压
    if (target.zip) {
      var zlib = require('zlib');
      var gunzip = require('util').promisify(zlib.gunzip);
      var compressed = fs.readFileSync(tmpPath);
      var decompressed = await gunzip(compressed);
      fs.writeFileSync(binaryPath, decompressed);
      fs.unlinkSync(tmpPath);
    } else {
      fs.renameSync(tmpPath, binaryPath);
    }
    // 可执行权限（Unix）
    if (process.platform !== 'win32') {
      fs.chmodSync(binaryPath, 0o755);
    }
    console.log('✅ cdp-server 已下载: ' + binaryPath);
  } catch (err) {
    console.error('❌ 下载失败:', err.message);
    console.log('');
    console.log('你可以手动下载:');
    console.log('  ' + url);
    console.log('然后放到: ' + binaryPath);
    // 清理临时文件
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    process.exit(1);
  }
}

main();
