# cdp-server

通过 Chrome 扩展控制真实浏览器的自动化工具。零 npm 依赖，Go 单二进制。

## 安装

```bash
npm install -g cdp-server
```

安装后会自动下载当前平台的二进制文件。

## 使用

```bash
# 启动 daemon
cdp-server start

# 浏览器控制
cdp-server browser goto "https://www.google.com"
cdp-server browser eval "document.title"
cdp-server browser click ".btn"
cdp-server browser fill "#search" "关键词"
cdp-server browser screenshot

# 停止 daemon
cdp-server stop
```

## 业务脚本

```bash
# Google 搜索
npx google-search "关键词"

# 淘宝购物车
npx taobao-cart

# 淘宝搜索
npx taobao-search "商品名"

# DeepSeek 余额
npx deepseek-balance
```

## 发布

```bash
# 打 tag 自动触发 GitHub Actions 编译+发布
git tag v1.0.0
git push origin v1.0.0
```
