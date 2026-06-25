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

## 架构

```
cdp-server browser goto/eval/click... ──WS──→ CDP Bridge 扩展 ──→ 真实 Chrome
```

通过 Chrome 扩展的 `chrome.debugger` API 直接控制真实浏览器标签页，复用已有登录态，所有操作在用户当前 Chrome 窗口中执行。对目标网站完全不可见（非 headless，是真实浏览器环境）。

---

## 入参

| 变量 | 含义 |
|:-----|:-----|
| `{cwd}` | 当前工作目录（由 agent 平台提供） |
| `{skill_path}` | Skill 所在路径（由 agent 平台提供） |

---

## 文件结构

```
{skill_path}/
├── SKILL.md                          ← 本文件（SOP 流程）
├── references/
│   └── cdp-server-cli.md             ← cdp-server 命令参考文档
└── scripts/
    ├── cdp-server (或 cdp-server.exe) ← Go 单二进制（需下载，见 I-0）
    ├── ebay/                         ← eBay 调研脚本
    │   └── ebay-research.js          ← 搜索提取 + 可视化报表
    ├── google/                       ← Google 搜索脚本
    │   └── google-search.js          ← 搜索提取
    ├── deepseek/                     ← DeepSeek 平台脚本
    │   └── deepseek-balance.js       ← 账户余额查询
    └── taobao/                       ← 淘宝脚本
        ├── taobao-cart.js            ← 购物车商品提取
        └── taobao-search.js          ← 搜索商品列表
```

**无任何 npm 依赖**，`cdp-server` 为 Go 编译的单一可执行文件。
完整 CLI 命令参考见 `{skill_path}/references/cdp-server-cli.md`。

---

# 初始化 SOP（仅首次使用）

### 初始化清单

逐项完成，每项完成后标记 ✅。

#### [ ] I-0 下载 cdp-server 二进制（缺少时执行）

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
VERSION="v1.0.0"
curl -L -o "$BIN.gz" "https://github.com/bannermiao/cdp-autorunner/releases/download/$VERSION/$FILE"

# 解压（zip 格式的 .exe 不需要解压）
if [[ "$FILE" == *.gz ]]; then
  gzip -d "$BIN.gz"
  chmod +x "$BIN"
fi

echo "下载完成: $BIN"
```

PowerShell（Windows）下：
```powershell
cd {skill_path}/scripts
$VERSION = "v1.0.0"
Invoke-WebRequest -Uri "https://github.com/bannermiao/cdp-autorunner/releases/download/$VERSION/cdp-server-win-x64.exe" -OutFile "cdp-server.exe"
Write-Host "下载完成"
```

✅ 验证：`ls -la "{skill_path}/scripts/cdp-server"` 能找到二进制。
❌ 失败 → 检查网络或手动从 [Releases](https://github.com/bannermiao/cdp-autorunner/releases) 下载。

---

#### [ ] I-1 启动 daemon

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

#### [ ] I-2 安装 Chrome 扩展

1. 打开 Chrome → [CDP Bridge 扩展](https://chromewebstore.google.com/detail/cdp-bridge/nebfobgfljofcokgognlfkbnfmmdaccm) 并安装
2. 安装后打开 `chrome://extensions`，确认 `CDP Bridge` 已启用
3. 点击扩展图标，确认显示绿色指示灯 + "已连接"

❌ 未连接 → 检查 daemon 是否已启动（`...cdp-server status`）

#### [ ] I-3 验证初始化

```bash
cd {cwd}
"{skill_path}/scripts/cdp-server" browser goto "https://www.google.com"
```

✅ 验证：输出 `TITLE: Google`
❌ 失败 → 检查 daemon 是否运行、扩展是否已加载

---

# 自动化 SOP（每次使用）

### 步骤 G-1：确认 daemon 和扩展正常

```bash
"{skill_path}/scripts/cdp-server" status
```

检查 Chrome 扩展图标是否为绿色（已连接）。

### 步骤 G-2：cdp-server 命令参考

`cdp-server` 提供完整的浏览器控制能力，所有操作通过 `browser` 子命令执行。完整参考见 `{skill_path}/references/cdp-server-cli.md`。

```bash
# 命令格式
"{skill_path}/scripts/cdp-server" browser <命令> [参数...]
```

#### 导航控制
| 命令 | 说明 | 示例 |
|:-----|:-----|:------|
| `goto <url>` | 导航到页面 | `goto "https://example.com"` |
| `reload` | 刷新页面 | `reload` |
| `scroll <px>` | 滚动（正数向下） | `scroll 500` |
| `new-tab [url]` | 新建标签页 | `new-tab "https://..."` |
| `switch-tab <n>` | 切换标签页（从0开始） | `switch-tab 0` |
| `close-tab` | 关闭当前标签页 | `close-tab` |

#### 元素查询
| 命令 | 说明 | 示例 |
|:-----|:-----|:------|
| `text <选择器>` | 取元素文本 | `text "h1"` |
| `html <选择器>` | 取元素 outerHTML | `html ".content"` |
| `attr <选择器> <属性>` | 取元素属性 | `attr "img" "src"` |
| `count <选择器>` | 统计元素数量 | `count ".item"` |
| `css <选择器>` | 批量取文本（JSON数组） | `css ".item .title"` |
| `css <选择器> @属性` | 批量取属性 | `css ".item img" @src` |
| `css <选择器> html` | 批量取 HTML | `css ".item" html` |
| `eval <代码>` | 执行任意 JS | `eval "document.title"` |
| `exec <文件>` | 从文件执行 JS | `exec script.js` |

#### 元素交互
| 命令 | 说明 | 示例 |
|:-----|:-----|:------|
| `click <选择器>` | 点击元素 | `click ".btn"` |
| `fill <选择器> <文本>` | 输入文本 | `fill "#search" "手机"` |
| `hover <选择器>` | 悬停 | `hover ".menu"` |
| `select <选择器> <值>` | 选择下拉框 | `select "#sort" "price"` |

#### 等待策略
| 命令 | 说明 | 示例 |
|:-----|:-----|:------|
| `wait <毫秒>` | 固定等待 | `wait 3000` |
| `waitfor <选择器> [超时]` | 等待元素出现（推荐） | `waitfor ".result" 10000` |
| `wait-response <关键词> [超时]` | 等待网络请求完成 | `wait-response "api.com/data" 15000` |

#### 其他
| 命令 | 说明 | 示例 |
|:-----|:-----|:------|
| `screenshot [文件]` | 截图 | `screenshot page.png` |

> 💡 提取的数据用 `write_to_file` 工具保存到 `{cwd}`，也可用 `browser eval "..." output.json` 直接写文件。

---

## 示例

### eBay 商品调研

`scripts/ebay/ebay-research.js` 演示了完整的业务脚本模式——通过 `cdp-server` CLI 实现搜索提取 + 可视化报表：

```bash
cd {cwd}

# 搜索提取，保存 JSON
node {skill_path}/scripts/ebay/ebay-research.js "headlight"

# 搜索提取 + 自动生成 HTML 报表
node {skill_path}/scripts/ebay/ebay-research.js "headlight" --report

# 已有 JSON 数据生成报表
node {skill_path}/scripts/ebay/ebay-research.js data.json
```

### Google 搜索提取

`scripts/google/google-search.js` 演示了 CDP `fill` + `key` 组合实现完整的 Google 搜索流程——输入关键词 → 回车搜索 → 等待结果渲染 → 提取标题列表：

```bash
cd {cwd}

# 搜索并打印前 10 条结果
node {skill_path}/scripts/google/google-search.js "什么是CDP"

# 搜索并保存结果到 JSON 文件
node {skill_path}/scripts/google/google-search.js "什么是CDP" results.json
```

包含的关键技术点：
- CDP `Input.insertText` 插入真实文本（触发原生 `input` 事件）
- CDP `Input.dispatchKeyEvent` 发送回车（浏览器协议级别，`isTrusted=true`）
- `location.href` 轮询检测页面导航完成，替代跨页面 `waitfor`

### DeepSeek 账户余额查询

`scripts/deepseek/deepseek-balance.js` 演示了 SPA 页面数据提取——导航到 React 应用后，定位 CSS Modules 生成的哈希 class，提取余额和当月消费：

```bash
cd {cwd}

# 查询余额和当月消费
node {skill_path}/scripts/deepseek/deepseek-balance.js

# 保存为 JSON 文件
node {skill_path}/scripts/deepseek/deepseek-balance.js balance.json
```

包含的关键技术点：
- **DOM 探测**：先用 `eval` 内联脚本批量提取页面可见文本，发现 `充值余额 ¥19.60` 关键词，再精确定位到 `.a0cde8c1` 卡片容器
- **正则取值**：用 `match(/¥([\d,.]+)/)` 精准提取 `¥` 后面的数字，避免 `UTC+0` 等干扰
- **CSS Modules 哈希 class**：React 随机生成的 class 名（如 `.a0cde8c1`）在当前页面版本中稳定可用

### 淘宝商品搜索

`scripts/taobao/taobao-search.js` 演示了 SPA 搜索结果页的结构探测——处理淘宝搜索的 CSS Modules 哈希 class，从动态渲染的商品卡片中提取标题、价格、销量和店铺名：

```bash
cd {cwd}

# 搜索商品
node {skill_path}/scripts/taobao/taobao-search.js "512G M2 NVMe 固态"

# 搜索并保存为 JSON
node {skill_path}/scripts/taobao/taobao-search.js "DDR5 内存 16G" results.json
```

包含的关键技术点：
- **SPA 搜索页渲染等待**：`goto` 后 `wait(4000)` 等待淘宝搜索结果动态加载
- **CSS Modules 双卡片容器**：商品卡片包裹在 `.doubleCardWrapperAdapt` 内（淘宝哈希 class），`querySelectorAll` 批量提取
- **正则去干扰**：价格用 `¥(\d{2,4})(?=\+|优惠)` 匹配 2-4 位数字后紧跟 `+` 或 `优惠`，避免与销量数字粘连
- **标题单独提取**：通过 `[class*="title"]` 定位独立标题元素，比从拼接文本中切分更准确
- **去重机制**：用标题前 15 字符做 key 去重，过滤同款不同规格的重复卡片

---

# DOM 探测方法论（脚本编写指南）

当面对不熟悉的网站时，用 `cdp-server` 本身的探测命令快速摸清页面结构，远比猜测选择器高效。按以下层次逐级深入。

## D-1：确认页面状态

```bash
# 确认页面到达
"{skill_path}/scripts/cdp-server" browser eval "document.title"
# 确认 URL
"{skill_path}/scripts/cdp-server" browser eval "location.href"
```

如果 title/URL 不符合预期，检查是否需要先登录、或执行额外操作。

## D-2：定位目标元素

### 盲猜法（最快，优先使用）

先尝试网站最通用的语义标签：

```bash
# 看有多少个标题级元素
"{skill_path}/scripts/cdp-server" browser count "h1, h2, h3"
# 看列表容器
"{skill_path}/scripts/cdp-server" browser count "li"
# 看表格
"{skill_path}/scripts/cdp-server" browser count "table tr"
# 取第一个 h3 的文本，确认是否是目标
"{skill_path}/scripts/cdp-server" browser text "h3"
```

### 属性探测法

```bash
# 看所有输入框的 name/type/id
"{skill_path}/scripts/cdp-server" browser css "input" @name
"{skill_path}/scripts/cdp-server" browser css "input" @type
"{skill_path}/scripts/cdp-server" browser css "textarea" @name

# 看所有带 class 中相关关键词的元素
"{skill_path}/scripts/cdp-server" browser count "[class*='search']"
"{skill_path}/scripts/cdp-server" browser count "[class*='result']"
"{skill_path}/scripts/cdp-server" browser count "[class*='item']"
"{skill_path}/scripts/cdp-server" browser count "[class*='title']"

# 看链接的文本，了解页面内容分布
"{skill_path}/scripts/cdp-server" browser css "a[href]"
```

### 内容取样法

```bash
# 取页面顶部一段 HTML 看结构
"{skill_path}/scripts/cdp-server" browser eval "document.body.innerHTML.substring(0, 3000)"

# 或直接看某个区域的 outerHTML
"{skill_path}/scripts/cdp-server" browser html "main"
"{skill_path}/scripts/cdp-server" browser html "#content"
"{skill_path}/scripts/cdp-server" browser html ".container"
```

## D-3：交互探测

需要操作交互（点击、填表）时，先确认元素是否可交互：

```bash
# 确认元素存在
"{skill_path}/scripts/cdp-server" browser count "#search-box"

# 确认元素可见（getBoundingClientRect 判断）
"{skill_path}/scripts/cdp-server" browser eval "!!(document.querySelector('#search-box')?.getBoundingClientRect()?.width)"

# 测试点击/输入是否触发效果
"{skill_path}/scripts/cdp-server" browser click "#search-box"
"{skill_path}/scripts/cdp-server" browser fill "#search-box" "测试关键词"

# 看输入后页面是否有变化
"{skill_path}/scripts/cdp-server" browser eval "document.querySelector('#search-box')?.value"
```

## D-4：提取确认

目标元素找到后，确认提取结果的质量：

```bash
# 看前 3 条的文本
"{skill_path}/scripts/cdp-server" browser eval "JSON.stringify(Array.from(document.querySelectorAll('.item-title'),e=>e.textContent?.trim()).slice(0,3))"

# 看前 3 条的 HTML 上下文（确认是否包含需要的字段）
"{skill_path}/scripts/cdp-server" browser eval "Array.from(document.querySelectorAll('.item')).slice(0,2).map(e=>e.outerHTML.substring(0,500))"
```

## 常见选择器速查

| 目标 | 常用选择器模式 |
|:-----|:--------------|
| 搜索输入框 | `input[name="q"]`、`textarea[name="q"]`、`#search`、`input[type="search"]` |
| 搜索按钮 | `button[type="submit"]`、`input[type="submit"]`、`.search-btn` |
| 结果列表容器 | `#results`、`.results`、`#search`、`#center_col`、`[class*="result"]` |
| 结果标题 | `h3`、`h2`、`.title`、`[class*="title"] a` |
| 结果链接 | `a[href]`（结合 `@href` 批量取） |
| 分页 | `.pagination`、`[aria-label*="page"]`、`nav a` |
| 下一页 | `a[rel="next"]`、`.next`、`[aria-label="Next"]` |

## 探测后的脚本编写要点

1. **用 URL 轮询代替 `waitfor` 跨页面等待**：发送交互后（如点击、回车），页面可能导航到新 URL。此时 `waitfor` 的 MutationObserver 会随旧页面销毁。改用 `location.href` 轮询检测新页面到达。
2. **提取时总是 `JSON.stringify()` + `Array.from()`**：`querySelectorAll` 返回的是 NodeList，必须 `Array.from()` 转为数组再用 `map` 提取字段，然后 `JSON.stringify` 序列化。
3. **先用 `count` 验证、再用 `css` 提取**：少走弯路，避免提取空数组后还要排查是"没数据"还是"选择器不对"。
4. **复杂提取用 `exec` 写临时文件**：长 JS 代码在 shell 中转义很麻烦，用 `exec` 从文件执行。
5. **数据导出用 `eval "..." output.json`**：`cdp-server` 的 `eval` 支持第二个参数直接写文件。

---

## 错误处理

| 错误 | 原因 | 方案 |
|:-----|:-----|:-----|
| 连接 daemon 失败 | daemon 未启动 | `"{skill_path}/scripts/cdp-server" start` |
| 扩展未连接 | 扩展未加载或 SW 休眠 | 检查 chrome://extensions 中扩展状态 |
| 命令超时 | 页面加载慢或无响应 | 增加 wait / waitfor 时间 |
| 返回结果为空 | 选择器不匹配 | 用 text / html / css 命令调试 |

---

## 注意事项

1. **daemon 保持后台运行**：`cdp-server start` 后守护进程方式运行，关闭终端不影响
2. **扩展自动连接**：扩展会定期探测 daemon，在线后自动连接
3. **登录态复用**：操作的是当前真实 Chrome 窗口，目标网站的登录态自动可用
4. **cdp-server 是 Go 单二进制**：无需 Node.js 即可运行 daemon；ebay-research.js 等 Node 业务脚本按需使用
5. **eval 返回对象数组时必须用 `JSON.stringify()` 包裹**，Chrome 扩展不支持直接序列化
6. **业务脚本（如 ebay/ 下的脚本）放在 `scripts/<业务名>/` 目录**，便于多业务扩展

---

# 最佳实践（实战踩坑总结）

以下是从 eBay、Google、DeepSeek、淘宝 四个案例中提炼的实战经验。

## JS 代码拼接与转义

Node 脚本中嵌入的 JS 代码需要通过字符串拼接发送到浏览器执行，有几种写法：

```js
// ❌ 错误：join('') 会导致 // 注释吞掉后续代码
var code = [
  '(function(){',
  '  // 注释',       // 同行后续代码被注释掉！
  '  doSomething();',
  '})()'
].join('');

// ✅ 正确：使用单行 IIFE，去掉注释或用 join('\n')
var code = '(function(){var x=1;return JSON.stringify(x);})()';

// ✅ 复杂逻辑：用 exec 从文件执行（但必须写为单行 IIFE）
// 原因：扩展侧的多行 eval 可能报 "Unexpected token 'var'"
```

**关键规则**：提交给 `eval` 或 `exec` 的 JS 代码，**写为单行 IIFE `(function(){...})()`**，不要有多行缩进和注释。

## 正则提取的常见陷阱

### 陷阱 1：`\d` 在正则字面量中不是数字类

```js
// ❌ 错误：\\d 在正则字面量中是"反斜杠+d"，不是数字
item.price.replace(/[^\\d.]/g, '')  // => 匹配不到数字

// ✅ 正确：用 [0-9] 或 \D 取反
item.price.replace(/[^0-9.]/g, '')
```

### 陷阱 2：多规格商品的价格粘连

淘宝商品标题和销售数据拼接后，价格数字会和销量连在一起。

```js
// 原始文本: "¥2794000+人付款"  (¥279 + 4000人付款)
// ❌ ¥(\d+) 会匹配整串 "2794000"
// ✅ 限定位数 + 前瞻
txt.match(/¥(\d{2,4})(?=\+|优惠|$)/)  // 正确提取 ¥279
```

### 陷阱 3：文本中的干扰数字

```js
// "六月消费（按 UTC+0 时间）¥125.92CNY"
// ❌ [\d,.]+ 先匹配到 "0" (UTC+0 中的 0)
// ✅ 匹配 ¥ 后面的数字
txt.match(/¥([\d,.]+)/)  // 正确提取 125.92
```

## 等待策略选择

| 场景 | 方法 | 说明 |
|:-----|:-----|:------|
| 页面内等待元素渲染 | `waitfor` | MutationObserver 监听 DOM，推荐 |
| 页面导航到新 URL | `location.href` 轮询 | `waitfor` 的 observer 会随旧页面销毁 |
| 固定等待 | `wait` | 简单粗暴，SPA 首屏渲染可用 |
| 等网络请求完成 | `wait-response` | 监听 Network.responseReceived |

**经验值**：淘宝搜索页 `goto` 后等 4000ms，Google 搜索 `form.submit()` 后等 1500ms。

## 翻页操作

```bash
# ❌ URL 参数方式（SPA 会拦截重写）
# ✅ 找到页码按钮后 click
# 方法 1：用 exec 执行单行 JS 点击
echo '(function(){var btns=document.querySelectorAll(".next-pagination button");for(var i=0;i<btns.length;i++){if(btns[i].textContent.trim()==="2"){btns[i].click();}})()' > page2.js
"{skill_path}/scripts/cdp-server" browser exec page2.js
```

淘宝翻页参数：页码按钮 css 选择器 `.next-pagination button` 中文本为页码的按钮。

## CSS Modules 哈希 class 处理

React/CSS Modules 会生成随机类名（如 `doubleCardWrapperAdapt--mEcC7olq`）。这些类名在**当前部署版本中稳定**，但随版本更新可能变。

```js
// ✅ 用属性选择器匹配前缀
document.querySelectorAll('[class*="doubleCardWrapperAdapt"]')

// ✅ 多个特征组合
'[class*="cartShopName"],[class*="shopName"]'

// ✅ 稳定 class 前缀（淘宝框架层类名不变）
'.trade-price-integer'
'.next-pagination'
```

优先选择框架层不变的类名（如 `.trade-price-integer`），其次再用 `[class*="xxx"]` 匹配哈希类名前缀。

## 脚本编写检查清单

编写新站脚本时，按以下顺序排查：

1. **页面到了吗？** → `eval "document.title"` + `eval "location.href"`
2. **需要登录吗？** → 若重定向到 login 页，让用户在 Chrome 中手动登录
3. **等渲染了吗？** → SPA 页 `goto` 后加 `wait` 或 `waitfor`
4. **选择器对吗？** → 先用 `count` 验证匹配数
5. **JS 能跑吗？** → 复杂逻辑写单行 IIFE 用 `exec` 文件执行
6. **数据对吗？** → 先 `slice(0,3)` 采样验证，再全量提取
7. **翻页来了吗？** → 用 `click` 点击页码按钮，不走 URL 参数
