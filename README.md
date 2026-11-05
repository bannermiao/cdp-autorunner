# cdp-server

通过 **Chrome 扩展 + WebSocket 桥接**控制真实浏览器的自动化 CLI 工具。

架构：`cdp-server CLI` → WebSocket → `CDP Bridge 扩展` → `chrome.debugger` → **真实 Chrome 标签页**

区别于 Puppeteer/Playwright 等 headless 方案，它在用户当前 Chrome 窗口中执行操作，**复用已有登录态，绕过反爬检测**，对目标网站完全不可见。

**零依赖**，核心为 **Go 单二进制** + Chrome 扩展，通过 GitHub Release 分发。

## 安装

从 [GitHub Releases](https://github.com/bannermiao/cdp-autorunner/releases) 下载对应平台二进制：

| 平台 | 文件 |
| --- | --- |
| Windows x64 | `cdp-server-win-x64.exe` |
| Linux amd64 | `cdp-server-linux-amd64.gz` |
| macOS amd64 | `cdp-server-darwin-amd64.gz` |
| macOS arm64 | `cdp-server-darwin-arm64.gz` |

将二进制放入 `scripts/` 目录：Windows 直接使用 `cdp-server.exe`；Linux/macOS 解压后重命名为 `cdp-server` 并赋予执行权限。

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

## Skill 目录

| 目录 | 类型 | 内容 |
| --- | --- | --- |
| `cdp-autorunner-skill/` | 核心 skill | CLI 命令参考 + 通用站点脚本（google / taobao / deepseek / douyin / ebay） |
| `skills/ebay-research-skill/` | 应用 skill | eBay 选品调研：列表 → 详情 → 成交记录 → HTML/xlsx/JSON 三份交付 |
| `skills/douyin-viral-blueprint/` | 应用 skill | 抖音爆款拆解：切镜抽帧 + 口播转写 + 评论聚类 → 单文件 HTML 报告 |
| `skills/douyin-topic-ideation/` | 应用 skill | 抖音爆款选题：读拆解报告 + 账号定位 → 10 条选题入库 + 可视化管理面板 |
| `skills/douyin-viral-collect/` | 应用 skill | 抖音爆款采集：按关键词 / 对标博主 / 推荐流批量浏览，详情接口拉数据预筛，只下载对口视频归档 |

核心 skill 提供通用的浏览器操作底座；应用 skill 是各自闭环的业务流程，目录内自带 `SKILL.md`、`references/`、`scripts/`，按各 `SKILL.md` 的 SOP 执行。

需要操作浏览器的 skill 各自持有 `scripts/cdp-server(.exe)`，通过同一个 daemon（`127.0.0.1:18765`）和同一个扩展工作，二进制版本需保持一致；只做本地分析 / 生成的 skill（`douyin-viral-blueprint`、`douyin-topic-ideation`）不依赖该二进制。

三个抖音相关的 skill 共用 `~/.douyin-viral-blueprint/` 存配置与数据：`config.json`（key）、`account.json`（账号定位）、`topics.json`（选题库）。

## 示例

可直接运行内置的示例脚本（需已启动 daemon 及扩展）：

```bash
# Google 搜索 — 搜索关键词并提取结果
node cdp-autorunner-skill/scripts/google/google-search.js "关键词"

# 淘宝购物车 — 提取购物车商品信息
node cdp-autorunner-skill/scripts/taobao/taobao-cart.js

# 淘宝搜索 — 搜索商品列表并提取数据
node cdp-autorunner-skill/scripts/taobao/taobao-search.js "商品名"

# DeepSeek 余额 — 查询 DeepSeek 账户余额
node cdp-autorunner-skill/scripts/deepseek/deepseek-balance.js

# eBay 快速调研 — 搜索产品并生成可视化报表（通用简版）
node cdp-autorunner-skill/scripts/ebay/ebay-research.js "产品名"

# 抖音下载 — 视频本体 + 详情 + 全量一级评论（分享短链/文案直接粘）
node cdp-autorunner-skill/scripts/douyin/douyin-download.js "https://v.douyin.com/xxxxxxx/" --out ./videos

# eBay 深度调研 — 60 个商品 3 并发，产出 HTML/xlsx/JSON 三份交付
node skills/ebay-research-skill/scripts/ebay/ebay-research.js "headlight" --limit 60 --concurrency 3

# 抖音爆款拆解 — 对下载好的素材做切镜/转写/评论聚类并出报告
node skills/douyin-viral-blueprint/scripts/prepare.mjs <视频目录>

# 抖音爆款选题 — 读拆解报告 + 账号定位，生成 10 条选题并起管理面板
node skills/douyin-topic-ideation/scripts/account.mjs
node skills/douyin-topic-ideation/scripts/topics.mjs save topics.new.json
node skills/douyin-topic-ideation/scripts/open.mjs
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
├── scripts/              ← 二进制放置目录（从 GitHub Release 下载）
├── docs/                 ← 发布流程文档
├── cdp-autorunner-skill/ ← 核心 skill：CLI 参考 + 通用站点脚本
└── skills/                     ← 应用 skill（各自独立的能力包）
    ├── ebay-research-skill/      ┃ eBay 选品调研
    ├── douyin-viral-blueprint/   ┃ 抖音爆款拆解
    ├── douyin-topic-ideation/    ┃ 抖音爆款选题：生成 + 选题库管理
    └── douyin-viral-collect/     ┃ 抖音爆款采集：批量浏览 + 预筛下载
```

发布流程见 `docs/RELEASE.md`。
