# cdp-server

通过 **Chrome 扩展 + WebSocket 桥接**控制真实浏览器的自动化 CLI 工具。

架构：`cdp-server CLI` → WebSocket → `CDP Bridge 扩展` → `chrome.debugger` → **真实 Chrome 标签页**

区别于 Puppeteer/Playwright 等 headless 方案，它在用户当前 Chrome 窗口中执行操作，**复用已有登录态，绕过反爬检测**，对目标网站完全不可见。

**零 npm 依赖**，核心为 **Go 单二进制** + Chrome 扩展，npm 包仅用于分发和自动下载。

## 安装

```bash
npm install -g cdp-server
```

安装后自动下载当前平台二进制到 `scripts/` 目录。

## 使用

### 前置条件

安装 [CDP Bridge 扩展](https://chromewebstore.google.com/detail/cdp-bridge/nebfobgfljofcokgognlfkbnfmmdaccm)，启用后扩展在 `ws://127.0.0.1:18765` 监听 WebSocket 连接。

### CLI 命令

```bash
# 启动 WebSocket 中继 daemon
cdp-server start

# 浏览器控制
cdp-server browser goto "https://www.google.com"     # 导航到页面
cdp-server browser eval "document.title"              # 执行 JS 获取结果
cdp-server browser click ".btn"                        # 点击元素
cdp-server browser fill "#search" "关键词"              # 填充输入框
cdp-server browser screenshot                          # 截图（保存到当前目录）

# 停止 daemon
cdp-server stop
```

## 示例

通过 `npx` 可直接运行内置的示例脚本（需已启动 daemon 及扩展）：

```bash
# Google 搜索 — 搜索关键词并提取结果
npx google-search "关键词"

# 淘宝购物车 — 提取购物车商品信息
npx taobao-cart

# 淘宝搜索 — 搜索商品列表并提取数据
npx taobao-search "商品名"

# DeepSeek 余额 — 查询 DeepSeek 账户余额
npx deepseek-balance

# eBay 调研 — 搜索产品并生成可视化报表
npx ebay-research "产品名"
```

## 项目结构

```
cdp-server/
├── cdp-server/           ← Go 源码（CLI 工具）
│   ├── main.go           ┃ cobra 框架，支持 daemon 管理 + 浏览器控制
│   ├── cmd/              ┃   命令实现（browser goto/eval/click/...）
│   └── ws/               ┃   WebSocket 客户端（连接 Chrome 扩展）
├── cdp-extension/        ← Chrome 扩展源码（CDP Bridge）
│   ├── manifest.json     ┃   通过 chrome.debugger API 控制标签页
│   ├── background.js     ┃   WebSocket 服务端（ws://127.0.0.1:18765）
│   └── popup.html/js     ┃   弹出面板 UI
├── bin/cdp-server.js     ← npm CLI 入口，查找并调用 Go 二进制
├── postinstall.js        ← npm postinstall 钩子，自动下载二进制
└── package.json          ← npm 包定义
```
