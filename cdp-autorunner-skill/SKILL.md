---
name: CDP-autorunner-skill
description: CDP Bridge 浏览器自动化工具。通过 Chrome 扩展直接控制真实浏览器执行导航、点击、填表、截图、JS 注入等操作，复用已有登录态，绕过反爬检测。适用于需要操作真实浏览器的任何 Web 自动化场景。
allowed-tools:
  - execute_command
  - read_file
  - search_content
  - write_to_file
  - replace_in_file
---

# CDP Bridge Skill

> **强制规则**
> 1. 严格按照 SOP 顺序执行，不可跳步
> 2. 执行中遇到任何错误，**立即中断**，输出问题描述 + 可行解决方案，不继续执行
> 3. 所有结果文件输出到当前工作目录（`{cwd}`）
> 4. 禁止使用 agent-browser、WebFetch、Python requests 等方式提取数据

---

## 入参

| 变量 | 含义 |
|:-----|:-----|
| `{cwd}` | 当前工作目录（由 agent 平台提供） |
| `{skill_path}` | Skill 所在路径（由 agent 平台提供） |

## 文件结构

```
{skill_path}/
├── SKILL.md                          ← 本文件（SOP 流程）
├── references/
│   └── cdp-server-cli.md             ← cdp-server 命令参考文档
└── scripts/
    ├── cdp-server (或 cdp-server.exe) ← Go 单二进制（需下载，见 I-0）
    ├── ebay/                         ← eBay 调研脚本
    │   ├── ebay-research.js          ← 搜索提取 + 可视化报表（支持并发）
    │   ├── ebay-research-worker.js   ← 并发子进程（由主脚本 fork）
    │   └── ebay-report.js            ← 独立报表生成
    ├── google/                       ← Google 搜索脚本
    │   └── google-search.js          ← 搜索提取
    ├── deepseek/                     ← DeepSeek 平台脚本
    │   └── deepseek-balance.js       ← 账户余额查询
    ├── douyin/                       ← 抖音脚本
    │   └── douyin-download.js        ← 单条视频下载 + 评论存档（mp4 / meta.json / comments.json）
    └── taobao/                       ← 淘宝脚本
        ├── taobao-cart.js            ← 购物车商品提取
        └── taobao-search.js          ← 搜索商品列表
```

新业务脚本放 `scripts/<业务名>/`，参考 `douyin/douyin-download.js` 的写法（零依赖、`spawnSync` 调 CLI、`__dirname` 定位二进制）。
完整 CLI 命令参考见 `{skill_path}/references/cdp-server-cli.md`。

---

# 初始化 SOP（仅首次使用）

逐项完成，每项完成后标记 ✅。

## [ ] I-0 下载 cdp-server 二进制（缺少时执行）

如果 `{skill_path}/scripts/cdp-server` 或 `{skill_path}/scripts/cdp-server.exe` 不存在，从 GitHub Releases 下载：

```bash
cd {skill_path}/scripts

# 判断平台
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
  FILE="cdp-server-win-x64.exe"
  BIN="cdp-server.exe"
elif [[ "$OSTYPE" == "darwin"* ]]; then
  ARCH=$(uname -m)
  FILE=$([ "$ARCH" = "arm64" ] && echo "cdp-server-darwin-arm64.gz" || echo "cdp-server-darwin-amd64.gz")
  BIN="cdp-server"
else
  FILE="cdp-server-linux-amd64.gz"
  BIN="cdp-server"
fi

# 下载
VERSION="v1.4.3"
curl -L -o "$BIN.gz" "https://github.com/bannermiao/cdp-autorunner/releases/download/$VERSION/$FILE"

# 解压（.exe 不需要解压）
if [[ "$FILE" == *.gz ]]; then
  gzip -d "$BIN.gz"
  chmod +x "$BIN"
fi

echo "下载完成: $BIN"
```

PowerShell（Windows）下：

```powershell
cd {skill_path}/scripts
$VERSION = "v1.4.3"
Invoke-WebRequest -Uri "https://github.com/bannermiao/cdp-autorunner/releases/download/$VERSION/cdp-server-win-x64.exe" -OutFile "cdp-server.exe"
Write-Host "下载完成"
```

✅ 验证：`ls -la "{skill_path}/scripts/cdp-server"` 能找到二进制。
❌ 失败 → 检查网络或手动从 [Releases](https://github.com/bannermiao/cdp-autorunner/releases) 下载。

> ⚠️ 下载后核对文件大小（Windows 约 10 MB）。小于 6 MB 说明被中断，二进制不完整，运行会报 `Exec format error` 或 `不是有效应用` —— 删掉重下。

## [ ] I-1 启动 daemon

```bash
"{skill_path}/scripts/cdp-server" start
```

✅ 验证：输出 `CDP Bridge daemon 已启动 (PID: ...)`。
❌ 失败 → 端口 18765 被占用，`"{skill_path}/scripts/cdp-server" stop` 后重试。

管理命令：

```bash
"{skill_path}/scripts/cdp-server" status     # 检查运行状态
"{skill_path}/scripts/cdp-server" stop       # 停止 daemon
"{skill_path}/scripts/cdp-server" restart    # 重启 daemon
```

> ⚠️ 在 agent 沙箱里 `start` 起不来（下一条命令就 `connection refused`）。改用长驻后台任务跑 `"{skill_path}/scripts/cdp-server" daemon`。见「经验沉淀 → 环境与进程」。

## [ ] I-2 安装 Chrome 扩展

**方式 A（能开 Chrome 应用商店）**

1. 打开 Chrome → [CDP Bridge 扩展](https://chromewebstore.google.com/detail/cdp-bridge/nebfobgfljofcokgognlfkbnfmmdaccm) 并安装
2. 打开 `chrome://extensions`，确认 `CDP Bridge` 已启用
3. 点击扩展图标，确认显示绿色指示灯 + "已连接"

**方式 B（国内打不开商店 —— 用 release 里的离线包）**

```bash
VERSION="v1.4.3"
curl -L -o cdp-extension.zip "https://github.com/bannermiao/cdp-autorunner/releases/download/$VERSION/cdp-extension.zip"
unzip -o cdp-extension.zip -d <扩展存放目录>
```

`chrome://extensions` → 右上角开 **开发者模式** → **加载已解压的扩展程序** → 选中解压出的 `cdp-extension/`（含 `manifest.json` 那一层）。

> `cdp-extension.zip` 只有 **v1.4.1 及以后**的 release 才有。离线加载的扩展不会自动更新，升级 CLI 后要重下 zip 覆盖目录，再在 `chrome://extensions` 点刷新。

❌ 未连接 → 检查 daemon 是否已启动（`...cdp-server status`）

## [ ] I-3 验证初始化

```bash
cd {cwd}
"{skill_path}/scripts/cdp-server" browser goto "https://www.google.com"
```

✅ 验证：输出 `TITLE: Google`
❌ 失败 → 检查 daemon 是否运行、扩展是否已加载

---

# 自动化 SOP（每次使用）

## G-1 确认 daemon 和扩展正常

```bash
"{skill_path}/scripts/cdp-server" status
"{skill_path}/scripts/cdp-server" browser new-tab "about:blank"   # 秒回 = 扩展在线
```

`new-tab` 返回 `NEW-TAB: <targetId>` 说明扩展已连上；超时说明扩展没连，先看「错误处理 → 命令超时」。用完关掉：`browser close-tab <targetId>`。

## G-2 命令参考

所有浏览器操作通过 `browser` 子命令执行，完整参考见 `{skill_path}/references/cdp-server-cli.md`。

```bash
"{skill_path}/scripts/cdp-server" browser <命令> [参数...]
```

### 导航控制

| 命令 | 说明 | 示例 |
|:-----|:-----|:------|
| `goto <url>` | 导航到页面 | `goto "https://example.com"` |
| `reload` | 刷新页面 | `reload` |
| `scroll <px>` | 滚动（正数向下） | `scroll 500` |
| `new-tab [url]` | 新建标签页（返回 targetId） | `new-tab "https://..."` |
| `switch-tab <n>` | 切换标签页（从 0 开始） | `switch-tab 0` |
| `close-tab [targetId]` | 关闭标签页（指定 targetId 并发安全） | `close-tab $TID` |

### 多 target 并发

| 命令 | 说明 | 示例 |
|:-----|:-----|:------|
| `goto-target <targetId> <url>` | 在指定 target 上导航 | `goto-target $TID "https://..."` |
| `eval-target <targetId> <代码>` | 在指定 target 上执行 JS | `eval-target $TID "document.title"` |
| `waitfor-target <targetId> <选择器> [超时]` | 在指定 target 上等待元素 | `waitfor-target $TID ".item" 5000` |

```bash
# 每个并发单元一个独立标签页，互不干扰
T1=$("{skill_path}/scripts/cdp-server" browser new-tab "about:blank" | sed 's/NEW-TAB: //')
T2=$("{skill_path}/scripts/cdp-server" browser new-tab "about:blank" | sed 's/NEW-TAB: //')

"{skill_path}/scripts/cdp-server" browser goto-target "$T1" "https://example.com/page1"
"{skill_path}/scripts/cdp-server" browser goto-target "$T2" "https://example.com/page2"
"{skill_path}/scripts/cdp-server" browser eval-target "$T1" "document.title"
"{skill_path}/scripts/cdp-server" browser eval-target "$T2" "document.title"

"{skill_path}/scripts/cdp-server" browser close-tab "$T1"
"{skill_path}/scripts/cdp-server" browser close-tab "$T2"
```

### 元素查询

| 命令 | 说明 | 示例 |
|:-----|:-----|:------|
| `text <选择器>` | 取元素文本 | `text "h1"` |
| `html <选择器>` | 取元素 outerHTML | `html ".content"` |
| `attr <选择器> <属性>` | 取元素属性 | `attr "img" "src"` |
| `count <选择器>` | 统计元素数量 | `count ".item"` |
| `css <选择器>` | 批量取文本（JSON 数组） | `css ".item .title"` |
| `css <选择器> @属性` | 批量取属性 | `css ".item img" @src` |
| `css <选择器> html` | 批量取 HTML | `css ".item" html` |
| `eval <代码>` | 执行任意 JS | `eval "document.title"` |
| `exec <文件>` | 从文件执行 JS | `exec script.js` |

### 元素交互

| 命令 | 说明 | 示例 |
|:-----|:-----|:------|
| `click <选择器>` | 点击元素 | `click ".btn"` |
| `fill <选择器> <文本>` | 输入文本 | `fill "#search" "手机"` |
| `hover <选择器>` | 悬停 | `hover ".menu"` |
| `select <选择器> <值>` | 选择下拉框 | `select "#sort" "price"` |

### iframe 操作

| 命令 | 说明 | 示例 |
|:-----|:-----|:------|
| `frame <iframe选择器> eval <代码>` | 在 iframe 中执行 JS | `frame "#desc_ifr" eval "document.title"` |
| `frame <iframe选择器> text <选择器>` | 取 iframe 内元素文本 | `frame "#desc_ifr" text "#policybox"` |
| `frame <iframe选择器> html <选择器>` | 取 iframe 内元素 HTML | `frame "#desc_ifr" html "title"` |
| `frame <iframe选择器> click <选择器>` | 点击 iframe 内元素 | `frame "#desc_ifr" click "label[for='tab4']"` |
| `frame <iframe选择器> fill <选择器> <文本>` | 在 iframe 内输入文本 | `frame "#desc_ifr" fill "#search" "keyword"` |
| `frame <iframe选择器> css <选择器>` | 批量提取 iframe 内元素 | `frame "#desc_ifr" css "h1"` |

> 同域与跨域（OOPIF）iframe 都支持：同域走 `contentDocument`，跨域走 `chrome.debugger.attach({targetId})` 附着到独立 CDP 目标。

### 等待策略

| 命令 | 说明 | 示例 |
|:-----|:-----|:------|
| `wait <毫秒>` | 固定等待 | `wait 3000` |
| `waitfor <选择器> [超时]` | 等待元素出现（推荐） | `waitfor ".result" 10000` |
| `wait-response <关键词> [超时]` | 等待网络请求完成 | `wait-response "api.com/data" 15000` |

### 其他

| 命令 | 说明 | 示例 |
|:-----|:-----|:------|
| `screenshot [文件]` | 截图 | `screenshot page.png` |

> 提取的数据用 `write_to_file` 保存到 `{cwd}`，也可用 `browser eval "..." output.json` 直接写文件。

## G-3 示例脚本

均为零 npm 依赖的 Node 脚本，需先完成初始化。

### eBay 商品调研

```bash
cd {cwd}
node {skill_path}/scripts/ebay/ebay-research.js "headlight"                          # 搜索提取 → JSON
node {skill_path}/scripts/ebay/ebay-research.js "headlight" --report                 # 提取 + HTML 报表
node {skill_path}/scripts/ebay/ebay-research.js "headlight" --limit 20 --concurrency 3 --report
node {skill_path}/scripts/ebay/ebay-research.js data.json                            # 已有 JSON → 报表
node {skill_path}/scripts/ebay/ebay-report.js data.json [output.html]                # 独立报表
```

`--concurrency N` 为多 Worker 并发，每个 Worker 用 `new-tab` 开自己的标签页并行抓取。

### Google 搜索提取

```bash
node {skill_path}/scripts/google/google-search.js "什么是CDP"              # 打印前 10 条
node {skill_path}/scripts/google/google-search.js "什么是CDP" results.json  # 存 JSON
```

### DeepSeek 账户余额

```bash
node {skill_path}/scripts/deepseek/deepseek-balance.js              # 打印余额与当月消费
node {skill_path}/scripts/deepseek/deepseek-balance.js balance.json  # 存 JSON
```

### 抖音视频下载

```bash
node {skill_path}/scripts/douyin/douyin-download.js 7400000000000000000 --out ./videos
node {skill_path}/scripts/douyin/douyin-download.js "https://v.douyin.com/xxxxxxx/"
node {skill_path}/scripts/douyin/douyin-download.js "7.53 复制打开抖音，看看【某人的作品】 https://v.douyin.com/xxxx/ 复制此链接"
node {skill_path}/scripts/douyin/douyin-download.js <id> --comment-limit 200   # 只取前 200 条评论
node {skill_path}/scripts/douyin/douyin-download.js <id> --no-comments        # 只下视频
```

输入认四种：纯 id、标准链接、`iesdouyin.com/share/video/<id>`、`v.douyin.com` 短链（整段分享文案可直接粘）。

产物 `<out>/<视频id>/`：`video.mp4`、`meta.json`（作者/赞评藏转/时长/文案/话题/封面/直链）、`comments.json`（一级评论全量：昵称、地区、点赞、文本、内嵌回复、热评/置顶/折叠标记、作者是否赞过/回过）。

### 淘宝商品搜索

```bash
node {skill_path}/scripts/taobao/taobao-search.js "512G M2 NVMe 固态"
node {skill_path}/scripts/taobao/taobao-search.js "DDR5 内存 16G" results.json
node {skill_path}/scripts/taobao/taobao-cart.js     # 提取购物车商品
```

---

# DOM 探测方法论（写新站脚本前先做这一步）

用 `cdp-server` 的探测命令摸清页面结构，比猜选择器快得多。

## D-1 确认页面状态

```bash
"{skill_path}/scripts/cdp-server" browser eval "document.title"
"{skill_path}/scripts/cdp-server" browser eval "location.href"
```

title/URL 不符合预期 → 可能没登录，或需要额外操作。

## D-2 定位目标元素

```bash
# 盲猜语义标签
"{skill_path}/scripts/cdp-server" browser count "h1, h2, h3"
"{skill_path}/scripts/cdp-server" browser count "li"
"{skill_path}/scripts/cdp-server" browser count "table tr"
"{skill_path}/scripts/cdp-server" browser text "h3"

# 按属性探测
"{skill_path}/scripts/cdp-server" browser css "input" @name
"{skill_path}/scripts/cdp-server" browser css "input" @type
"{skill_path}/scripts/cdp-server" browser count "[class*='search']"
"{skill_path}/scripts/cdp-server" browser count "[class*='result']"
"{skill_path}/scripts/cdp-server" browser count "[class*='item']"
"{skill_path}/scripts/cdp-server" browser count "[class*='title']"

# 内容取样
"{skill_path}/scripts/cdp-server" browser html "main"
"{skill_path}/scripts/cdp-server" browser eval "document.body.innerHTML.substring(0, 3000)"
```

## D-3 交互探测

```bash
"{skill_path}/scripts/cdp-server" browser count "#search-box"    # 元素存在吗
"{skill_path}/scripts/cdp-server" browser eval "!!(document.querySelector('#search-box')?.getBoundingClientRect()?.width)"   # 可见吗
"{skill_path}/scripts/cdp-server" browser fill "#search-box" "测试关键词"
"{skill_path}/scripts/cdp-server" browser eval "document.querySelector('#search-box')?.value"   # 输入生效了吗
```

## D-4 提取确认

```bash
# 先采样 3 条，确认字段对
"{skill_path}/scripts/cdp-server" browser eval "JSON.stringify(Array.from(document.querySelectorAll('.item-title'),e=>e.textContent?.trim()).slice(0,3))"
"{skill_path}/scripts/cdp-server" browser eval "Array.from(document.querySelectorAll('.item')).slice(0,2).map(e=>e.outerHTML.substring(0,500))"
```

## 常见选择器速查

| 目标 | 常用选择器 |
|:-----|:--------------|
| 搜索输入框 | `input[name="q"]`、`textarea[name="q"]`、`#search`、`input[type="search"]` |
| 搜索按钮 | `button[type="submit"]`、`input[type="submit"]`、`.search-btn` |
| 结果列表容器 | `#results`、`.results`、`#center_col`、`[class*="result"]` |
| 结果标题 | `h3`、`h2`、`.title`、`[class*="title"] a` |
| 结果链接 | `a[href]`（配 `@href` 批量取） |
| 分页 | `.pagination`、`[aria-label*="page"]`、`nav a` |
| 下一页 | `a[rel="next"]`、`.next`、`[aria-label="Next"]` |

---

# 错误处理

| 错误 | 原因 | 方案 |
|:-----|:-----|:-----|
| `dial tcp 127.0.0.1:18765 ... refused` | daemon 未启动 | `cdp-server start` |
| 扩展未连接 | 扩展未加载 / SW 休眠 | 检查 `chrome://extensions` |
| **命令超时（先查这条）** | ① 扩展未连接（最常见）② 页面真的慢 | 先探扩展在线，再看页面 |
| `Detached while handling command` | 页面在 eval 期间二次导航，debugger 被踢 | 重试一次即可 |
| 返回结果为空 | 选择器不匹配 | 用 `text` / `html` / `css` 命令调试 |

## `命令超时` 怎么判

不要加大 wait，先探扩展在不在线：

```bash
"{skill_path}/scripts/cdp-server" browser new-tab "about:blank"   # 秒回 = 扩展在线；超时 = 没连上
```

没连上就每 3s 重探，最多等 60~150s（扩展靠 `chrome.alarms` 定期探测 daemon，重连时延不确定）。

## 各命令超时值不一样

`defaultTimeout = 30s` 只是兜底，实际由各命令自传：

| 超时 | 命令 |
|--:|:--|
| 30s | `eval` · `exec` · `goto-target` · `eval-target` |
| 15s | `new-tab` · `close-tab` |
| 10s | `click` · `fill` · `text` · `html` · `attr` · `count` |
| 5s | `scroll` · `hover` |
| `timeoutMs+2s` | `waitfor` · `waitfor-target`（默认 12s） |

别按单一数字设计重试逻辑。

---

# 经验沉淀

写新脚本、调不通、遇到怪现象时先翻这里。

## 环境与进程

**daemon 在 agent 沙箱里活不过一次工具调用。**
Windows Job Object 的 `KILL_ON_JOB_CLOSE` 会把 `DETACHED_PROCESS` 一起收走。现象：`start` 报启动成功，下一条命令立刻 `dial tcp 127.0.0.1:18765: connectex: refused`。

- 对策：把 `cdp-server daemon` 作为**长驻后台任务**启动（前台阻塞模式），别用 `start`
- 也可以换成计划任务 / 服务托管

**僵尸 daemon。**
`status` 报「进程还在 (PID: xxx)，但端口 18765 无响应」= 上一次残留的死进程。先 `stop` 再起，否则新 daemon 抢不到端口。

**`start` 成功不等于能干活。**
扩展靠 `chrome.alarms` 探测 daemon，重连时延不确定。起完必须先用 `new-tab about:blank` 探一次，通了再发业务命令。

**登录态直接复用。**
操作的是用户当前真实 Chrome 窗口，目标网站的 Cookie 自动可用，不需要也不能自己传。

**二进制下载要核对大小。**
中断的下载会得到半截 exe（有合法 PE 头但节区不完整），执行报 `Exec format error` 或「不是此操作系统平台的有效应用」。Windows 完整包约 10 MB。

## 页面就绪判定

**看 DOM，不看 URL。**
同一内容常有多种 URL 形态（抖音详情页既有 `/video/<id>` 也有 `/jingxuan?modal_id=<id>`），失效时还会被回落到推荐流。URL 匹配既啰嗦又容易误判。

**判据只盯一个容器就够。**
点赞/评论/收藏/转发四个按钮都挂在同一个容器下，容器在就等于整组在，不必逐个 `count`。抖音实测：`[data-e2e="video-detail"]` 包含四个按钮各 1 个，首页为 0。

**列表页的按钮会骗人。**
抖音首页推荐流的卡片也带 `video-player-digg` / `feed-comment-icon`（各 2 个）。只数互动框会把首页误判成详情页。要选那种**只在目标状态出现**的容器。

**容器在 ≠ 是你请求的那条。**
视频失效时平台会塞一条别人的内容进来。真正的校验是**数据接口**：按目标 id 查，查不到就报错，不会下错片。两层判定的分工是「DOM 决定能不能采，接口决定是不是这条」。

**先采样再全量。**
`slice(0,3)` 确认字段对不对，再批量提取，比事后排查空数组快。

## JS 注入与执行

**一律单行 IIFE。**
提交给 `eval` / `exec` 的代码写成 `(function(){...})()` 或 `(async()=>{...})()`，不要多行缩进 —— 扩展侧的多行 eval 会报 `Unexpected token 'var'`。

**`join('')` 会吞代码。**
```js
// ❌ 拼接后 `// 注释` 把后面的代码全注释掉
['(function(){', '  // 注释', '  doSomething();', '})()'].join('')
// ✅ 用 join('\n')，或干脆不加注释
```

**返回对象数组必须 `JSON.stringify()`。**
扩展不支持直接序列化对象，`querySelectorAll` 的 NodeList 还要先 `Array.from()`。

**id 要注入，别从 `location` 里抠。**
页面形态可能变（modal 打开时 `location.pathname` 没有视频 id），注入进来的 id 永远是对的。

**一次别拉太多。**
`eval-target` 超大返回值会拖慢甚至超时。翻页类抓取每批 500~1000 条为宜，Node 侧循环累积。

**长 JS 用文件。**
shell 转义长代码很痛苦，写 `.js` 文件用 `exec` 执行。

## 命令稳定性

**`Detached while handling command` 是常态，不是异常。**
SPA 页面在 eval 期间二次导航，扩展的 `chrome.debugger` 被踢，命令直接失败。重试即可。

**重试要有选择。**
只对 `detached` / 超时 / `no target` 这类基础设施错误退避重试（1.2s、2.4s）。业务错误（HTTP 4xx、数据为空）重试没有意义，重试反而把「东西真没了」误判成网络抖动。

**超时杀掉的是子进程，不是页面操作。**
`cdp-server` 被 kill 后，扩展端的操作可能还在跑。重试前先 `wait` 一下。

## 正则提取

```js
// 陷阱 1：字符串里的 \\d 才是"反斜杠+d"，要数字用 [0-9]
item.price.replace(/[^0-9.]/g, '')

// 陷阱 2：价格与销量粘连 —— "¥2794000+人付款" 是 ¥279 + 4000人付款
txt.match(/¥(\d{2,4})(?=\+|优惠|$)/)

// 陷阱 3：干扰数字 —— "UTC+0 时间 ¥125.92" 里 0 会被先匹配
txt.match(/¥([\d,.]+)/)
```

## 等待策略

| 场景 | 方法 | 说明 |
|:-----|:-----|:------|
| 等元素渲染 | `waitfor` | MutationObserver 监听，推荐 |
| 等页面导航 | 轮询 `location.href` | `waitfor` 的 observer 会随旧页面销毁 |
| 固定等待 | `wait` | SPA 首屏兜底 |
| 等网络请求 | `wait-response` | 只认调用时刻起发出的请求 |

经验值：淘宝搜索页 `goto` 后 4000ms；Google 搜索提交后 1500ms。

## 翻页

不要改 URL 参数 —— SPA 会拦截重写。找到页码按钮点它：

```bash
echo '(function(){var b=document.querySelectorAll(".next-pagination button");for(var i=0;i<b.length;i++){if(b[i].textContent.trim()==="2"){b[i].click();}})()' > page2.js
"{skill_path}/scripts/cdp-server" browser exec page2.js
```

## 哈希 class

React / CSS Modules 生成随机类名（`doubleCardWrapperAdapt--mEcC7olq`），在当前部署版本内稳定，改版就变。

```js
document.querySelectorAll('[class*="doubleCardWrapperAdapt"]')   // 前缀匹配
'.trade-price-integer'                                          // 框架层固定类名，最稳
```

优先级：框架层固定类名 > `[class*=]` 前缀匹配 > 完整哈希名。

## 网络与代理

**Node 内置 fetch 既不读 `HTTP(S)_PROXY`，也不读 Windows 系统代理。**
要用代理必须靠 `NODE_USE_ENV_PROXY=1`（Node ≥ 22），且要在**进程启动前**就位 —— 进程内补设无效。

**代理取值三级**：env `HTTPS_PROXY` > Windows 注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 的 `ProxyEnable`/`ProxyServer` > 直连。国内用户通常只在 Clash / v2rayN 里开系统代理，不设环境变量。

**socks 代理走不了内置 fetch。** 检测到 `socks=` 时应显式提示改直连，不要静默失败。

## 进程清理

两层进程，边界不同：

| 层 | 谁 | 谁能关 |
|:--|:--|:--|
| daemon | `cdp-server start` 起的单实例，PID 写 `scripts/.cdp-server.pid` | `stop` |
| Worker + 标签页 | 并发脚本 `fork` 出的 Node 进程 + 各自 `new-tab` 的标签页 | 脚本自己；`stop` 管不到 |

```bash
"{skill_path}/scripts/cdp-server" stop

# 残留 Worker（Windows）
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*ebay-research*' } | ForEach-Object { taskkill /PID $_.ProcessId /F }

# daemon 活着但 pid 文件丢了
taskkill /F /IM cdp-server.exe    # Windows
pkill -f cdp-server              # macOS / Linux
```

**顺序别搞反**：先让业务脚本自然结束（或 Ctrl+C 等 Worker 退出），再 `stop` daemon。反过来会让 Worker 拿不到 daemon，全部报错。

## 脚本编写检查清单

1. 页面到了吗 → `eval "document.title"` + `location.href`
2. 要登录吗 → 重定向到 login 页就让用户在 Chrome 里手动登一次
3. 渲染完了吗 → SPA 加 `wait` / `waitfor`，或等一个只在该状态出现的容器
4. 选择器对吗 → 先 `count` 验证数量
5. JS 能跑吗 → 单行 IIFE，长了写文件走 `exec`
6. 数据对吗 → `slice(0,3)` 采样，再全量
7. 要翻页吗 → `click` 页码按钮，别改 URL
