Chrome Web Store 上架信息

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

扩展名称：CDP Bridge

短描述（132 字符以内）：
通过 WebSocket 桥接外部工具与 Chrome 真实标签页的调试扩展

类别：开发者工具 (Developer Tools)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

详细描述：

CDP Bridge 是一款 Chrome 扩展，它在 ws://127.0.0.1:18765 上开启一个 WebSocket 服务端，通过 chrome.debugger API 将外部工具与真实的浏览器标签页桥接起来。

任何兼容 CDP 的客户端都可以连接到扩展，发送 Chrome DevTools 协议命令，像使用 Chrome 开发者工具一样以编程方式控制真实浏览器标签页。

━━ 工作原理 ━━

1. 安装并启用扩展
2. 扩展在 ws://127.0.0.1:18765 监听 WebSocket 连接
3. 外部客户端发送包含 CDP 命令（或原始 JavaScript）的 JSON 消息
4. 扩展通过 chrome.debugger 在真实标签页上执行命令
5. 结果通过 WebSocket 返回给客户端

━━ 主要功能 ━━

- WebSocket 桥接：在本地端口监听 WebSocket 连接，接收外部工具指令
- CDP 命令执行：在真实标签页上执行任意 Chrome DevTools 协议方法（Page.navigate、Runtime.evaluate、DOM.getDocument 等）
- JavaScript 注入：在真实标签页上下文中运行任意 JavaScript 代码并获取返回值
- 批量命令：支持变量替换的顺序 CDP 命令批量执行
- 标签页管理：查询所有打开的标签页，按 ID 附加到指定标签页
- 自动标签页发现：客户端连接时自动推送当前所有标签页列表
- 实时标签页同步：标签页创建/更新/关闭事件自动推送给已连接的客户端
- 可视状态指示：扩展图标显示连接状态（绿色=已连接，红色=未连接）
- 自动重连：持续探测 WebSocket 端点，自动重连
- 心跳保活：定期心跳检测维持稳定连接

━━ 支持的命令格式 ━━

{"cmd":"exec","code":"..."}             在标签页中执行 JavaScript
{"cmd":"cdp","method":"Page.navigate",  执行 CDP 方法
         "params":{...}}
{"cmd":"tabs"}                          列出所有打开的标签页
{"cmd":"batch","commands":[...]}        批量执行多个命令

━━ 使用场景 ━━

- 构建自定义浏览器自动化工具
- 通过协议适配器将 Playwright/Puppeteer 连接到真实 Chrome 标签页
- 以编程方式调试和检查网页
- 从已验证登录态的浏览器会话中提取数据
- 将浏览器控制集成到现有工具链中

━━ 权限说明 ━━

debugger       附加到标签页并发送 CDP 命令——核心功能
tabs           查询和管理浏览器标签页
alarms         定时连接探测和心跳保活
http://127.0.0.1/*  访问本地 WebSocket 端点

━━ 隐私说明 ━━

- 所有通信仅在本地进行（127.0.0.1 WebSocket）
- 不会向任何外部服务器发送数据
- 不会收集、存储或传输任何用户数据
- 完全开源，代码可审计
