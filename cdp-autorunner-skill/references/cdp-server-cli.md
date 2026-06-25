---
name: cdp-server CLI 参考
description: cdp-server 命令参考文档，包含所有子命令、参数说明和示例。
---

# cdp-server CLI 参考文档

## 概览

`cdp-server` 是 Go 编译的单一二进制文件，零外部依赖，提供两个主要功能：

1. **daemon 管理** — WebSocket 中继服务（与 Chrome 扩展保持长连接）
2. **浏览器控制** — 通过 daemon 转发 CDP 协议命令到 Chrome 扩展，控制真实浏览器

---

## 全局用法

```
cdp-server [命令] [参数...]
cdp-server browser [子命令] [参数...]
```

---

## daemon 管理命令

管理 WS 中继服务的生命周期。

### `cdp-server start`

启动后台 daemon 进程（守护进程方式）。

```
cdp-server start
```

✅ 输出示例：
```
CDP Bridge daemon 已启动 (PID: 12345)
  WS: ws://127.0.0.1:18765
```

### `cdp-server stop`

停止后台 daemon。

```
cdp-server stop
```

✅ 输出示例：
```
daemon 已停止 (PID: 12345)
```

### `cdp-server status`

检查 daemon 运行状态。未运行时退出码为 1。

```
cdp-server status
```

✅ 输出示例：
```
daemon 正在运行 (PID: 12345)
```

### `cdp-server restart`

重启 daemon（stop + start）。

```
cdp-server restart
```

### `cdp-server daemon`

内部命令，直接在前台运行 WS 服务端（通常不手动使用，由 `start` 自动调用）。

### `cdp-server version`

显示版本信息。

```
cdp-server version
```

✅ 输出示例：
```
cdp-server v1.0.0
```

---

## browser 子命令

所有浏览器操作命令，需要通过 `cdp-server browser` 前缀调用。

### 导航与页面控制

#### `goto <url>`

导航到指定 URL。自动检测导航是否成功，失败时回退到 JS 导航。

```
cdp-server browser goto "https://www.example.com"
```

✅ 输出格式：
```
TITLE: Example Domain
```

#### `reload`

刷新当前页面。

```
cdp-server browser reload
```

✅ 输出：
```
RELOAD: ok
```

#### `scroll <像素>`

滚动页面。正数向下，负数向上。

```
cdp-server browser scroll 500    # 向下滚动 500 像素
cdp-server browser scroll -200   # 向上滚动 200 像素
```

✅ 输出：
```
SCROLL: 500
```

---

### JS 执行

#### `eval <代码> [文件]`

在浏览器中执行 JS 表达式。可选将结果写入文件。

```
cdp-server browser eval "document.title"
cdp-server browser eval "document.querySelector('h1')?.textContent"
cdp-server browser eval "JSON.stringify(Array.from(...))" output.json
```

✅ 输出格式：
```
(直接输出结果值)
```

#### `exec <文件路径>`

从本地文件读取 JS 代码并执行。解决 eval 中长代码的 shell 转义问题。

```
cdp-server browser exec script.js
```

✅ 输出格式：同 `eval`。

---

### 等待

#### `wait <毫秒>`

固定等待指定毫秒数。

```
cdp-server browser wait 3000
```

#### `waitfor <选择器> [超时ms]`

等待 DOM 中指定 CSS 选择器的元素出现。使用 MutationObserver 实现，快于固定等待。

```
cdp-server browser waitfor ".item" 5000
cdp-server browser waitfor "#results" 10000
```

✅ 找到时输出：
```
FOUND: .item
```

超时时输出（非错误）：
```
TIMEOUT: .item
```

#### `wait-response <pattern> [超时ms]`

等待匹配 URL 模式的网络请求完成。通过 Chrome debugger 的 `Network.responseReceived` 事件实现。

```
cdp-server browser wait-response "api.example.com/data" 15000
```

✅ 输出格式：
```
RESPONSE: https://api.example.com/data?page=1
```

---

### 元素交互

#### `click <选择器>`

点击匹配 CSS 选择器的元素。

```
cdp-server browser click ".btn-submit"
cdp-server browser click "#search-btn"
```

✅ 输出：
```
CLICK: .btn-submit
```

#### `fill <选择器> <文本>`

在输入框中填入文本。自动触发 `input` 和 `change` 事件。

```
cdp-server browser fill "#search" "keyword"
cdp-server browser fill "#email" "user@example.com"
```

✅ 输出：
```
FILL: #search = keyword
```

#### `hover <选择器>`

鼠标悬停到元素上（触发 mouseenter / mouseover 事件）。

```
cdp-server browser hover ".menu-item"
```

✅ 输出：
```
HOVER: .menu-item
```

#### `select <选择器> <值>`

选择下拉框（`<select>`）的选项值。

```
cdp-server browser select "#sort" "price"
cdp-server browser select "#per-page" "50"
```

✅ 输出：
```
SELECT: #sort = price
```

---

### 元素查询

#### `text <选择器>`

获取匹配元素的 textContent。

```
cdp-server browser text "h1"
cdp-server browser text ".title"
```

✅ 输出：
```
Page Title Here
```

#### `html <选择器>`

获取匹配元素的 outerHTML。

```
cdp-server browser html ".card"
```

✅ 输出：
```
<div class="card">...</div>
```

#### `attr <选择器> <属性名>`

获取匹配元素的指定属性值。

```
cdp-server browser attr "a.link" "href"
cdp-server browser attr "img" "src"
```

✅ 输出：
```
https://www.example.com/page
```

#### `count <选择器>`

统计匹配 CSS 选择器的元素数量。

```
cdp-server browser count ".item"
```

✅ 输出：
```
42
```

#### `css <选择器> [@属性|html]`

批量获取所有匹配元素的文本（默认）、属性值或 HTML。返回 JSON 数组。

```
# 取所有标题文本
cdp-server browser css ".item .title"

# 取所有图片的 src 属性（用 @ 前缀）
cdp-server browser css ".item img" @src

# 取所有项的 outerHTML
cdp-server browser css ".item" html
```

✅ 输出格式：
```json
["标题1", "标题2", "标题3"]
```

---

### 截图

#### `screenshot [文件]`

截取当前页面截图。不指定文件名时自动生成 `screenshot-{时间戳}.png`。

```
cdp-server browser screenshot
cdp-server browser screenshot page.png
```

✅ 输出：
```
FILE: /current/dir/screenshot-1719298800000.png
```

---

### 标签页管理

#### `new-tab [url]`

新建标签页，可选指定初始 URL。

```
cdp-server browser new-tab
cdp-server browser new-tab "https://www.example.com"
```

✅ 输出：
```
NEW-TAB: {targetId}
```

#### `switch-tab <索引>`

切换到指定索引的标签页（从 0 开始）。

```
cdp-server browser switch-tab 0
cdp-server browser switch-tab 1
```

✅ 输出：
```
SWITCH-TAB: ok
```

#### `close-tab`

关闭当前活动的标签页。

```
cdp-server browser close-tab
```

✅ 输出：
```
CLOSE-TAB: ok
```

---

## 组合使用示例

### 批量提取列表数据

```bash
# 1. 启动 daemon（如未运行）
cdp-server start

# 2. 导航到目标页面
cdp-server browser goto "https://www.example.com/list"

# 3. 等待列表渲染
cdp-server browser waitfor ".item" 5000

# 4. 统计总数
cdp-server browser count ".item"

# 5. 提取标题列表
cdp-server browser css ".item .title"

# 6. 截图
cdp-server browser screenshot
```

### 等待 API 响应

```bash
cdp-server browser goto "https://www.example.com"
cdp-server browser wait-response "api.example.com" 10000
```

### 多标签页操作

```bash
cdp-server browser goto "https://www.example.com/page1"
cdp-server browser new-tab "https://www.example.com/page2"
cdp-server browser switch-tab 0
cdp-server browser close-tab
```

---

## 错误处理

| 现象 | 原因 | 解决方案 |
|:-----|:-----|:---------|
| `ERROR: 连接 daemon 失败` | daemon 未运行 | `cdp-server start` |
| `ERROR: 扩展未连接` | Chrome 扩展未加载或 SW 休眠 | 检查 chrome://extensions |
| `ERROR: 命令超时 (30s)` | 页面加载慢或无响应 | 检查网络，或增加 wait 时间 |
| 返回空结果 | CSS 选择器不匹配 | 确认页面 DOM 结构 |


