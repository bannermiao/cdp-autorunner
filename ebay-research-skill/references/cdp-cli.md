---
name: cdp-server CLI（eBay 调研用到的部分）
description: cdp-server 命令与输出格式参考，覆盖本 skill 的抓取、并发、探测所需命令。完整命令表见 cdp-autorunner-skill/references/cdp-server-cli.md。
---

# cdp-server CLI 参考

`cdp-server` 是 Go 单二进制：`start/stop/status/restart` 管 daemon，`browser <子命令>` 操作真实 Chrome。

```
cdp-server [daemon命令]
cdp-server browser [子命令] [参数...]
```

---

## daemon 管理

| 命令 | 输出 |
|:-----|:-----|
| `start` | `CDP Bridge daemon 已启动 (PID: ...)` + `WS: ws://127.0.0.1:18765` |
| `status` | `daemon 正在运行 (PID: ...)`；未运行退出码 1 |
| `stop` | 先请求 `http://127.0.0.1:18765/shutdown` 优雅关闭，再 SIGTERM pid 文件里的进程 |
| `restart` | stop + start |
| `daemon` | 内部命令，前台跑 WS 服务端（沙箱环境需要长驻时手动用） |
| `version` | `cdp-server v1.4.0` |

PID 文件在二进制同目录的 `.cdp-server.pid`。pid 文件丢了 `stop` 就杀不掉还在跑的进程，需手动结束。

---

## 导航

```
browser goto <url>          → TITLE: <页面标题>
browser reload              → RELOAD: ok
browser scroll <px>         → SCROLL: 500        # 正数向下
```

`goto` 会自动检测导航是否成功，失败回退 JS 导航。

## 标签页与并发

```
browser new-tab [url]                 → NEW-TAB: <targetId>
browser close-tab [targetId]          → CLOSE-TAB: <targetId>   # 不给参数关当前活动页
browser switch-tab <n>                → SWITCH-TAB: ok          # 从 0 开始
browser goto-target <tid> <url>       → TITLE: ...
browser eval-target <tid> <js> [文件]
browser waitfor-target <tid> <sel> [ms]
```

`new-tab` 返回的 `targetId` 可以给三个 `*-target` 命令复用，一个 target 一条链：`attach(targetId) → 操作 → detach`，多个 Worker 因此能并行。
注意扩展端 attach 存在单例竞争：并发建 tab 时先建的 target 可能挂起后续命令，所以要错峰建、建完先 `eval-target <tid> "1+1"` 预热验证。

## 执行 JS

```
browser eval <js> [输出文件]      # 表达式结果直接打印；结果写文件时给第二个参数
browser exec <文件路径>            # 从文件读 JS，绕开 shell 转义
```

约束：
- 提交给 `eval` 的代码写成**单行 IIFE** `(function(){...})()`，别带多行缩进和 `//` 注释（`join('')` 会把注释后面的代码吃掉）
- 返回对象/数组**必须 `JSON.stringify()` 包裹**，扩展不能直接序列化
- 多行代码走 `exec` 临时文件更稳

## 查询

```
browser text <sel>              → 元素 textContent
browser html <sel>              → outerHTML
browser attr <sel> <属性>        → 属性值
browser count <sel>             → 匹配数量，如 42
browser css <sel>               → 全部文本，JSON 数组
browser css <sel> @<属性>        → 全部属性值，JSON 数组
browser css <sel> html          → 全部 outerHTML，JSON 数组
```

探测页面的常用组合：`count` 先验选择器命中数 → `css` 批量取 → `eval "JSON.stringify(Array.from(document.querySelectorAll('.card'),e=>e.textContent.trim()).slice(0,3))"` 采样看质量。

## 交互

```
browser click <sel>       → CLICK: .btn
browser fill <sel> <文本>  → FILL: #search = 文本     # 自动触发 input/change
browser hover <sel>       → HOVER: .menu
browser select <sel> <值>  → SELECT: #sort = price
```

`hover/select/frame` 等其余命令在通用 skill 的参考文档里，本调研流程没用到。

## 等待

```
browser wait <ms>                       # 固定等
browser waitfor <sel> [ms]              → FOUND: <sel>  或  TIMEOUT: <sel>
browser wait-response <关键词> [ms]      → RESPONSE: <完整URL>
browser waitfor-target <tid> <sel> [ms] → FOUND / TIMEOUT
```

- `waitfor` 用 MutationObserver，比固定等待快；**超时返回 `TIMEOUT` 且退出码 0**，不是错误，必须按返回文本判断（本 skill 用它当「页面异常/被反爬」的信号）
- 跨页面导航别用 `waitfor`：observer 随旧页面销毁，改轮询 `eval "location.href"`
- `wait-response` 只认调用之后发出的请求，之前的不补；请求加载失败按错误返回

## 截图

```
browser screenshot [文件]     → FILE: /abs/path/screenshot-<时间戳>.png
```

---

## 超时表

下表是 **cdp-server CLI 自己**那一层（`defaultTimeout = 30s` 只是兜底，每条命令自己传）。业务脚本外层还有一层包装器超时（`scripts/lib/cdp-client.js`），刻意比这里宽 5s，以免 CLI 还在等就被包装器 kill 掉、误报成超时。改这里的表时记得同步那边。

| 超时 | 命令 |
|--:|:--|
| 30s | `eval` · `exec` · `goto-target` · `eval-target` |
| 15s | `new-tab` · `close-tab` |
| 10s | `click` · `fill` · `text` · `html` · `attr` · `count` |
| 5s | `scroll` · `hover` |
| `timeoutMs+2s` | `waitfor` · `waitfor-target`（默认 12s） |

**看到 `ERROR: 命令超时 (Xs)` 的第一反应是探扩展在不在线，不是加大等待。**
旧版本（≤ v1.3.0 CLI / ≤ 2.3.0 扩展）在扩展未连接时会静默挂满整个超时才报超时——实测 `start` 后立刻 `eval "1+1"` 耗时 30449ms。v1.3.1 起修好了，但排查顺序仍然应该是：

```bash
cdp-server browser new-tab "about:blank"   # 秒回 = 在线；超时 = 没连上
```

超时被 kill 的只是 cdp-server 子进程，**扩展端不受影响**：页面上的动作可能还在跑，重试前先 `wait` 一下再发下一条。

---

## 输出约定汇总

| 前缀 | 来源 |
|:-----|:-----|
| `TITLE:` | `goto` / `goto-target` |
| `NEW-TAB:` | `new-tab` |
| `CLOSE-TAB:` / `SWITCH-TAB:` / `RELOAD:` / `SCROLL:` / `CLICK:` / `FILL:` / `HOVER:` / `SELECT:` | 对应交互命令 |
| `FOUND:` / `TIMEOUT:` | `waitfor` / `waitfor-target`（两者都是退出码 0） |
| `RESPONSE:` | `wait-response` |
| `FILE:` | `screenshot` |
| `ERROR:` | 任何失败，写 stderr |

脚本侧（`scripts/lib/cdp-client.js`）按这张表判成功：退出码非 0 视为异常，`TIMEOUT:` 视为「页面异常/反爬」而不是异常。
