---
name: ebay-research-skill
description: eBay 商品调研。用真实 Chrome（复用登录态）抓取搜索列表 → 详情页价格/卖家/好评率 → purchaseHistory 成交记录，输出 7/30/90 天销量与均价（金额统一换算成 USD、保留源币种）。一次产出三份：可视化 HTML 报表、Excel 明细(.xlsx，数值型可透视)、JSON 缓存。支持 --keywords 多关键词按 item_id 去重合并成一份。适用于 eBay 选品、竞品价格带、销量趋势调研。
---

# eBay 商品调研 Skill

> **强制规则**
> 1. 先跑 G-1 环境探测，探测不通过**立即中断**，输出问题描述 + 修复步骤，不带病执行
> 2. 抓取阶段交给脚本，它内部已有超时/重试/降级；agent 不要自己循环重跑整轮调研
> 3. 结果统一落在工作目录下的交付文件夹 `{cwd}/YYYY_MM_DD__关键词/`，一次跑三份文件都在里面
> 4. 禁止改用 agent-browser、WebFetch、Python requests 抓 eBay 数据

---

## 交付物

跑一次关键词调研，在工作目录下建交付文件夹 **`YYYY_MM_DD__关键词/`**，里面三份同名文件：

关键词会先洗成合法目录名：空格与标点斜杠 emoji 等一律压成一个 `_`（`LED head/lamp 12V*24V 🔥` → `LED_head_lamp_12V_24V`），中文保留，只有夹在文字中间的连字符保留；截到 60 字符；`con/NUL` 这类 Windows 保留名加前缀。**同一天同关键词重跑会自动加 `__02`、`__03`，不覆盖上一次结果。**

| 文件 | 用途 | 说明 |
|:-----|:-----|:-----|
| `<关键词>.html` | 预览、分发 | 自包含单文件，4 张图 + 可排序筛选表格；Chart.js 走 CDN，**打开需联网** |
| `<关键词>.xlsx` | 二次统计 | 单 sheet「商品数据」35 列，`item_id` 后紧跟链接、图片、命中关键词；源币种与 USD 双记录，7/30/90 天窗口 + GMV/中位数/标准差，价格与销量是数值型单元格，表头冻结 + 筛选 |
| `<关键词>.json` | 缓存 | 原始结构化快照。**留着它才能重出报表而不必重抓** |

想指定别的落盘位置：把根目录作为第二个参数，文件夹名规则不变（`node .../ebay-research.js "headlight" D:/research` → `D:/research/2026_10_22__headlight/`）。

```bash
cd {cwd}

# 常规：抓 60 个商品，3 个标签页并发
node "{skill_path}/scripts/ebay/ebay-research.js" "headlight" --limit 60 --concurrency 3

# 只出 Excel + JSON，不要 HTML
node "{skill_path}/scripts/ebay/ebay-research.js" "headlight" --limit 60 --no-report

# 多个关键词，结果合并成一份交付（按 item_id 去重，保留命中来源）
node "{skill_path}/scripts/ebay/ebay-research.js" --keywords "9438904619,9438904919,A9438904619,A9438904919" --concurrency 3

# 只要列表链接（最快，不进步骤 E-2）
node "{skill_path}/scripts/ebay/ebay-research.js" "headlight" --no-detail

# 用已有 JSON 重出报表 + Excel（改了口径/字段时用，省掉整轮重抓；产物就地覆盖在同目录）
node "{skill_path}/scripts/ebay/ebay-research.js" 2026_10_22__headlight/headlight.json
node "{skill_path}/scripts/ebay/ebay-research.js" 2026_10_22__headlight/headlight.json 交付版.html
```

参数：`--keywords "a,b,c"` 多关键词合并 · `--limit N` 抓前 N 个商品（多关键词时是**去重后**的前 N；默认全部）· `--concurrency N` 并发标签页数（默认 1 串行，建议 2~3）· `--no-detail` 只取列表链接 · `--no-report` 跳过 HTML。

## 多关键词合并

`--keywords` 传逗号分隔的词表，**流程不变**：每个词各跑一遍列表页 → 汇总后按 `item_id` 去重 → 只对去重结果做一遍详情与成交抓取（同一个商品被 3 个词命中也只抓 1 次，省时间也少触发反爬）→ 仍然只出一份交付。

- 每条记录带两个字段：`keyword`（首个命中的词）和 `keywords`（全部命中的词，逗号分隔）；Excel 里是「命中关键词」列，报表里可直接搜索/排序
- 交付目录与文件名用 `首个关键词+Nkw`，例如 `2026_10_22__9438904619_3kw/9438904619_3kw.xlsx`
- 报表标题会列出全部关键词
- 某个词的结果页渲染正常但没卡片 → 只说明该词无结果，脚本会在合并阶段打印每个词各自的命中数；结果页容器都等不到则直接报错退出（不会把坏链路说成「没货」）
- 词与词之间用逗号/分号/换行都可以；想按词分别出报告就分多次跑，日期目录会各自加 `__02`

---

## 架构

```
ebay-research.js ──spawn──→ cdp-server CLI ──WS(127.0.0.1:18765)──→ CDP Bridge 扩展 ──chrome.debugger──→ 真实 Chrome 标签页
```

跑在用户当前 Chrome 里：非 headless、真实浏览器指纹、登录态自动可用，eBay 看到的是正常用户页面。代价是页面上会有扩展的调试提示条，抓取期间**不要手动切换/关闭那些标签页**。

与 `cdp-autorunner-skill` 的关系：两者是同一个 daemon + 同一个扩展，端口都是 `18765`。只要有一个装好并能用，另一个不用重复装扩展；二进制各自持有一份，**版本要一致**，否则一边起的 daemon 协议不匹配另一边会报错。

---

## 入参与文件结构

| 变量 | 含义 |
|:-----|:-----|
| `{cwd}` | 当前工作目录（结果落这里） |
| `{skill_path}` | 本 skill 目录 |

```
{skill_path}/
├── SKILL.md
├── references/
│   └── cdp-cli.md                     ← cdp-server 命令参考（调研流程用到的部分）
└── scripts/
    ├── cdp-server(.exe)               ← Go 单二进制，缺失时见 I-0
    ├── ebay/
    │   ├── ebay-research.js           ← 主脚本：列表 → 详情 → 三份交付
    │   └── ebay-research-worker.js    ← 并发子进程（由主脚本 fork，独占一个标签页）
    ├── lib/
    │   ├── cdp-client.js              ← cdp-server 调用层、包装器超时、eval/exec 压平
    │   ├── ebay-extract.js            ← 页面提取 JS + 价格/日期/币种/窗口统计（唯一一份）
    │   ├── exchange-rate.js           ← USD 换算：取汇率、缓存、fetch 失败退回 curl
    │   ├── ebay-report.js             ← HTML 报表生成
    │   └── ebay-xlsx.js               ← Excel 生成（COLUMNS 与数值口径在这）
    └── vendor/
        ├── exceljs.bundle.js          ← esbuild 打包的 exceljs，运行时免 npm install
        └── exceljs.entry.js           ← 打包入口（升级时按顶部注释重新生成）
```

浏览器侧只需 Chrome + 扩展；Node 侧无需 `npm install`（依赖已内置在 `vendor/`）。

---

# 初始化 SOP（仅首次使用）

逐项完成，每项都要看到 ✅ 再走下一项。

### [ ] I-0 下载 cdp-server 二进制（`scripts/` 下没有时执行）

```bash
cd "{skill_path}/scripts"
VERSION="v1.4.0"                     # 与 cdp-server release 保持一致

case "$OSTYPE" in
  msys*|cygwin*|win32*)  ASSET="cdp-server-win-x64.exe";  BIN="cdp-server.exe" ;;
  darwin*)               ASSET=$([ "$(uname -m)" = "arm64" ] && echo "cdp-server-darwin-arm64.gz" || echo "cdp-server-darwin-amd64.gz"); BIN="cdp-server" ;;
  *)                     ASSET="cdp-server-linux-amd64.gz"; BIN="cdp-server" ;;
esac

URL="https://github.com/bannermiao/cdp-autorunner/releases/download/$VERSION/$ASSET"
if [ "${ASSET##*.}" = "gz" ]; then
  curl -fsSL "$URL" -o "$BIN.gz" && gzip -dc "$BIN.gz" > "$BIN" && rm -f "$BIN.gz"
else
  curl -fsSL "$URL" -o "$BIN"           # Windows 的 exe 不带 gz，直接落成 cdp-server.exe
fi
[ "$BIN" = "cdp-server" ] && chmod +x "$BIN"
ls -la "$BIN"
```

PowerShell（Windows）：
```powershell
cd "{skill_path}\scripts"
$VERSION = "v1.4.0"
Invoke-WebRequest -Uri "https://github.com/bannermiao/cdp-autorunner/releases/download/$VERSION/cdp-server-win-x64.exe" -OutFile "cdp-server.exe"
```

✅ 验证：`"{skill_path}/scripts/cdp-server.exe" version`（macOS/Linux 去掉 `.exe`）输出 `cdp-server v1.4.0`。
❌ 失败 → 检查网络；代理机器注意 `curl` 是否走到了系统代理；也可手动从 [Releases](https://github.com/bannermiao/cdp-autorunner/releases) 下载对应资产放进 `scripts/`。

### [ ] I-1 启动 daemon

```bash
"{skill_path}/scripts/cdp-server" start     # Windows 加 .exe
```

✅ 输出 `CDP Bridge daemon 已启动 (PID: ...)`。
❌ 端口 18765 被占用 → 多半是 `cdp-autorunner-skill` 或别处的 daemon 已经在跑；两边版本一致时直接复用它，跳过 start。

⚠️ `status` / `stop` **只认二进制同目录下的 `.cdp-server.pid` 文件**。pid 文件丢了就会出现「status 说没运行、实际有个不监听的孤儿进程」这种状态——此时 `stop` 无效，只能按注意事项 4 手动结束；换目录安装（本 skill 与兄弟 skill 各一份二进制）尤其容易碰到，各目录的 pid 文件互不相干。

管理命令：`status` 查状态 · `stop` 停 · `restart` 重启。

### [ ] I-2 安装 Chrome 扩展

1. Chrome 打开 [CDP Bridge 扩展](https://chromewebstore.google.com/detail/cdp-bridge/nebfobgfljofcokgognlfkbnfmmdaccm) 安装
2. `chrome://extensions` 确认已启用
3. 点扩展图标：**绿色指示灯 + 已连接**

❌ 未连接 → 先 `... cdp-server status` 确认 daemon 在跑。

### [ ] I-3 验证初始化

```bash
cd {cwd}
"{skill_path}/scripts/cdp-server" browser new-tab "about:blank"   # 秒回 targetId = 扩展已连上
"{skill_path}/scripts/cdp-server" browser goto "https://www.ebay.com"
```

✅ 看到 `NEW-TAB: <targetId>` 与 `TITLE: Electronic parts ...`（eBay 首页标题随站点变）。
❌ 秒回失败/挂到超时 → 按「错误处理」的超时判定顺序查，不要先加等待时间。

---

# 调研 SOP（每次执行）

### G-1 环境探测（必做，不通过就停）

```bash
"{skill_path}/scripts/cdp-server" status
"{skill_path}/scripts/cdp-server" browser new-tab "about:blank"
```

第一条查 daemon，第二条查扩展。**第二条挂满超时就是扩展没连上**（Chrome 关了、扩展被禁用、Service Worker 被休眠后还没重连）。探通再干活；没通就每 3s 重探、最多等 60~150s，还不行就中断报给用户。

> daemon 刚启动就发命令容易撞上这个超时——扩展靠 `chrome.alarms` 定期回连，有延迟。

### ⚠️ 登录提醒（不强制，只转达一次）

销量那一半来自 `purchaseHistory`，**需要 eBay 登录态**。未登录时价格、标题、卖家、好评率照常抓到，只有 7/30/90 天销量与成交均价会是空白。

- 不拦流程、不替用户登录、也不反复催；开跑前把这句转达给用户一次就够，脚本自己也会打印同样的提醒
- 用户没登录也要跑：直接跑，交付物照样可用，缺的只是销量列
- 跑完发现销量整列空白 → 提示他在 Chrome 里登录 `www.ebay.com` 后重跑同一关键词，新结果落到 `__02` 目录，不会覆盖上一次

### E-1 列表页 → 商品链接

```bash
cd {cwd}
node "{skill_path}/scripts/ebay/ebay-research.js" "headlight" --limit 60 --concurrency 3
```

主脚本打开 `https://www.ebay.com/sch/i.html?_nkw=<关键词>&_ipg=240`，等 `ul.srp-results` 出现，然后**连续两次采样数量一致**才认定懒加载结束（最多 6 次 × 1.5s）。选择器：`li.s-card[data-listingid]`，剔除 `data-listingid` 以 `2500` 开头的推广位，只留 `/itm/` 链接。

### E-2 详情页 + 成交记录（7/30/90 天）

每个商品两步：

1. 详情页 `https://www.ebay.com/itm/<id>` → 等 `.x-buybox-cta li`（等不到再退一步等 `h1`）→ 跑提取脚本，优先解析页面内嵌的 `$M_96613636_C` 模块 JSON（BUY_BOX / JSONLD / SELLER_CARD_ATF / COMPATIBILITY_TABLE / ABOUT_THIS_ITEM），页面改版没这个变量时自动回退 JSON-LD + DOM
2. 成交记录 `https://www.ebay.com/bin/purchaseHistory?item=<id>` → 等 `table` → 逐行取 价格/销量/日期，然后**按天合并**（同日销量累加、价格取当日最高），再切 **7 / 30 / 90 天**三个窗口各出一组 销量+均价+最低价+最高价；整体口径（GMV、中位数、标准差、特惠件数、币种）也限定在 90 天窗口内。价格显示为 0 的行判成**特惠成交**：计入销量，不计入任何价格统计

单条失败重试 3 次（间隔递增），仍失败写成空记录，不中断整轮。

整轮跑完后还有一次**收尾补抓**：把「详情没拿到标题」或「成交页没读到（`sold_*` 为空白）」的条目串行再试一遍，只回填拿到的值、不会用空值覆盖已有的好数据。日志会打印 `[补抓] N 个条目未完成…` 和每个条目的结果，最后是 `[补抓] 尝试 N 个，补回 M 个`。实测 1% 左右的成交页空白基本都能在这一步补回来。

### E-3 交付

脚本收尾自动建交付目录并写三份文件（见「交付物」）。看到 `[交付] 目录: ...` 与 `COUNT / JSON / XLSX / HTML` 四行输出即成功，把目录路径报给用户。

### E-4 需要改口径时

改字段/列 → `scripts/lib/ebay-xlsx.js` 的 `COLUMNS`；改提取逻辑 → `scripts/lib/ebay-extract.js`（**只这一份**，主脚本与 Worker 都 require 它）；改报表 → `scripts/lib/ebay-report.js`。改完用 JSON 缓存重出报表验证，别急着重抓：

```bash
node "{skill_path}/scripts/ebay/ebay-research.js" 2026_10_22__headlight/headlight.json
```

---

## 并发机制

`--concurrency N` 时主脚本 `fork` N 个 Worker，每个 Worker 自己 `new-tab` 拿一个 `targetId`，之后全部走 `goto-target` / `waitfor-target` / `eval-target`，互不干扰；结束时按 `targetId` 精确关闭自己的标签页。

两个必须知道的限制：

- **扩展端 `chrome.debugger` attach 有单例竞争**。多个 Worker 同时 `new-tab` 时，先建的那个 target 后续命令可能挂起（表现：详情页开了但程序不动）。脚本用「Worker 错峰 800ms 启动 + 建 tab 后立刻 `eval-target '1+1'` 预热验证 + 失败重建（最多 3 次）」绕开，**不要**为了快把并发拉到 4 以上。
- **并发要求二进制和扩展都支持多 target**。老版本没有 `*-target` 命令；`--concurrency 1`（默认串行，走活动标签页）在老版本上仍可用。

串行模式（不传 `--concurrency`）直接操作**当前活动标签页**，抓取期间用户切标签页会打偏，速度也慢一半以上——除非只想跑三五个，否则用并发。

实测耗时基准（`headlight`，240 个商品 × 3 并发，全程无中断）：**14 分 50 秒**，其中列表页 5s、详情+成交 810s、收尾关标签页 15s；折算约 **3.4s/商品**，吞吐稳定在 15~23 个/分钟，13 分钟内没有衰减。30 个商品的常规调研约 2 分钟。跑全量前先把预计时长告诉用户，别让人干等。

---

## 数据字段

JSON / Excel 同名字段。成交相关全部来自 purchaseHistory，**按天合并**（同一天多笔：销量累加，当日价格取最高）。

| 字段 | 含义 | 备注 |
|:-----|:-----|:-----|
| `item_id` / `url` / `title` | 商品标识与标题 | 标题已做 HTML 实体解码（`&amp;`→`&`） |
| `sale_price` / `currency` | 当前售价与币种 | `BUY_BOX` 有 `convertedFromValue` 时用它（原币种价，非美元换算价） |
| `sold` | 页面展示的总销量 | |
| `seller_name` / `store_name` | 卖家账号 / 店铺名 | |
| `positive_rate` | 好评率百分数 | |
| `compatible_vehicles` | 适配车辆数 | 汽配类目热度信号 |
| `specifics_item` | Item Specifics 全部属性 | 多行文本，Excel 里已开自动换行 |
| `sold_7days` / `sold_30days` / `sold_90days` | 三个窗口的销量合计 | 窗口含今天：`today-(N-1) ~ today` |
| `avg_price_*days` / `min_price_*days` / `max_price_*days` | 各窗口成交均价/最低价/最高价 | **不含特惠价**（价格为 0 的那些行） |
| `gmv_90days` | 90 天成交额 | Σ(当日最高价 × 当日销量) |
| `median_price_90days` / `std_price_90days` | 90 天成交价的中位数 / 样本标准差(n-1) | 只有 1 个价格样本时标准差为 null |
| `special_qty_90days` | 90 天里的特惠成交件数 | 价格显示为 0 的行，计销量不计价格 |
| `sale_price_usd` | 详情页现价的 USD 换算值 | 现价的 `sale_price` + `currency` 原样保留，USD 是另算的一份，不是覆盖 |
| `price_basis` | 这批金额统计的计价基准 | `USD`（取到汇率）/ `SOURCE`（没取到，按页面原币种混算） |
| `fx_date` | 所用汇率的日期 | 取不到汇率时为 null |
| `sales_currency` / `sales_currencies` | 成交记录页首个币种 / 出现过的全部币种 | 混币种时（eBay.de 上 EUR 与 US $ 并存）靠后者发现 |
| `unpriced_qty_90days` | 计入销量但没进价格统计的件数 | 认不出币种、或汇率表里没有该币种；与 `special_qty_90days`（特惠价为 0）分开的两类 |

空白与 0 的语义（Excel 与 JSON 一致）：

- `sold_*` = **0**：成交表格读到了，但窗口内没有成交
- `sold_*` / 价格字段 = **null（Excel 空白）**：purchaseHistory 页面连表格都没取到（掉登录、改版、反爬）
- 价格字段 null 而销量有值：窗口内只有特惠成交，没有非特价成交

日期支持英/德/中三种站点 locale：`18 Jun 2025 at 5:24:27am CST`、`30 Mai 2025 18:37:57 MEZ`、`于2025 年 4 月 14 日 21:43:52 CST`。解析不出来的行不计入统计。

要调窗口（比如加 15/60 天）：改 `scripts/lib/ebay-extract.js` 顶部的 `WINDOWS = [7, 30, 90]`，字段名和 Excel 列会跟着 `SALES_FIELDS` 生成，报表列需要另在 `ebay-xlsx.js` / `ebay-report.js` 里加。

---

## 币种与 USD 换算

汇率取自 `https://api.exchangerate.fun/latest?base=USD`（免费、无 Key、每小时刷新）。返回的 `rates[cur]` 是「1 USD 兑多少 cur」，所以原币种金额要 **除** 以它才得到 USD。

- 每一笔成交按**它自己那行的币种**换算完再合并统计，所以同一商品记录里 EUR 与 `US $` 并存也不会把两种钱直接相加
- 认不出币种、或汇率表里没有该币种 → 该行只计销量、不进价格统计，累计在 `unpriced_qty_90days`（不猜成 USD）
- 一轮调研只请求一次：结果缓存在系统临时目录 `ebay-research-fx.json`，24h 内复用；拿 JSON 离线重出报表也走这份缓存。并发时汇率由主进程取好再通过 IPC 发给 Worker，Worker 不重复打接口
- 取数两条路：Node fetch 失败自动退回 `curl`（这台机实测就是这种情况——Node 出不了网、代理只在系统层面）。两者都不通时 `price_basis=SOURCE`、`fx_date=null`，金额按原币种混算，Excel 表头和报表副标题都会写明
- Excel 的金额列表头动态标注 `(USD)` / `(原币种)`；`现价`/`现币种`/`现价USD`/`计价基准` 四列把源值和换算值同时留着

---

## cdp-server 命令速查

调研流程只用到这些，完整说明见 `{skill_path}/references/cdp-cli.md`。

```bash
"{skill_path}/scripts/cdp-server" browser <命令> [参数...]
```

| 命令 | 说明 |
|:-----|:-----|
| `goto <url>` / `reload` / `scroll <px>` | 活动标签页导航 |
| `new-tab [url]` / `close-tab [targetId]` / `switch-tab <n>` | 标签页管理，`close-tab` 给 targetId 才并发安全 |
| `goto-target <tid> <url>` / `eval-target <tid> <js>` / `waitfor-target <tid> <sel> [ms]` | 指定标签页操作，并发核心 |
| `eval <js> [out.json]` / `exec <file>` | 执行 JS（多行代码走 `exec`） |
| `text/html/attr/count/css <sel> [@attr\|html]` | 元素查询 |
| `click/fill/hover/select` | 交互 |
| `wait <ms>` / `waitfor <sel> [ms]` / `wait-response <kw> [ms]` | 等待 |
| `screenshot [file]` | 截图 |

---

## 错误处理

| 现象 | 原因 | 处置 |
|:-----|:-----|:-----|
| 连接 daemon 失败 | daemon 没起 | `cdp-server start` |
| 扩展未连接 | 扩展禁用 / Chrome 没开 / SW 休眠 | 看 `chrome://extensions` 与扩展图标 |
| **`ERROR: 命令超时 (Xs)`** | **① 扩展没连上（最常见）② 页面真的慢** | **先 `new-tab about:blank` 探一次：秒回=在线，超时=没连上。别急着加 wait** |
| 命令耗时突然变长（日志里 `[cdp:slow] goto 10000ms+`，平时约 1.5s） | daemon 或扩展正在掉线边缘 | 先 `status` + `new-tab about:blank` 探一遍再继续；这种状态下抓到的「0 条」不可信 |
| 抛错「列表页没有结果容器」 | 链路中断 / 被反爬 / 页面改版 | 按报错里的顺序排查；确认是搜索词本身没货的话，脚本会打印每个词的命中数，容器等到但卡片为 0 才是真无结果 |
| 大量记录只有 url 没标题 | 详情被反爬（`waitfor` 返回 `TIMEOUT`） | 降并发到 1~2，隔一段再跑；脚本对每条只重试 3 次 |
| 销量整列空白（7/30/90 全空，价格照常） | **没登录**（最常见）/ purchaseHistory 改版 | 让他登录后重跑；或在 Chrome 里手动打开 `https://www.ebay.com/bin/purchaseHistory?item=<某id>` 看表格还在不在。注意 `sold_*=0` 是「有表格但窗口内没成交」，`空白` 才是「没读到页面」 |
| 金额是原币种混算（`fx_date` 空、表头写 `(原币种)`） | 汇率没取到：Node fetch 和 curl 兜底都不通 | 看开跑时 `[汇率]` 那行提示；换能出网的机器重跑，`price_basis` 就会变回 `USD` |
| Worker 异常退出 | daemon 中途被 stop / 扩展掉线 | 主脚本会直接报错终止（不会静默挂住），排查后重跑 |

超时有**两层**，别混着看：

- **cdp-server CLI 自己**：`eval/exec/goto-target/eval-target` 30s、`new-tab/close-tab` 15s、`click/fill/text/html/attr/count` 10s、`waitfor` = 传入超时+2s（详见 `references/cdp-cli.md`）
- **脚本包装器**（`scripts/lib/cdp-client.js`）刻意**比 CLI 宽 5s**，避免 CLI 还在等就被我们提前 kill 掉、误报成超时

被 kill 的只是 cdp-server 子进程，**扩展端页面动作还在跑**，重试前先 `wait` 一下。

---

## 注意事项

1. **daemon 常驻**：`cdp-server start` 是守护进程，关终端不影响。例外：agent 沙箱（Windows Job Object 带 `KILL_ON_JOB_CLOSE`）里 `DETACHED_PROCESS` 逃不出去，工具调用一结束 daemon 就没了——这种情况把 `cdp-server daemon` 当长驻后台任务起，或交给计划任务/服务。
2. **Excel 依赖只有 `scripts/vendor/exceljs.bundle.js` 这一个文件**，skill 目录不保留 `package.json` / `node_modules`。要升级 exceljs：按 `scripts/vendor/exceljs.entry.js` 顶部注释临时装 `exceljs + esbuild` 重新打包，打完把 npm 文件删干净。
3. **HTML 报表打开要联网**（Chart.js 走 jsDelivr CDN）。要完全离线分发就把 CDN 文件下载后改成相对路径引用。
4. **残留清理**：Ctrl+C 或 daemon 被先 `stop` 会留下 Worker 进程和标签页。顺序应该是让脚本自然结束再 `stop daemon`；兜底：`taskkill /F /IM node.exe`（Windows）或 `pkill -f cdp-server`，标签页手动关。
5. **别改 `{skill_path}/scripts/lib/` 之外的重复实现**：提取逻辑只有 `ebay-extract.js` 一份，主脚本和 Worker 都 require 它。历史上这里踩过两份各自演化的坑。
