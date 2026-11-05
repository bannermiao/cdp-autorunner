---
name: douyin-topic-ideation
version: 1.0.0
display_name: 抖音爆款选题
display_name_en: Douyin Viral Topics
description: 抖音爆款选题。读取 douyin-viral-blueprint 产出的 report.json（他人作品的拆解分析）作为依据，结合全局账号定位，按薛辉创作方法生成一批 10 条可直接开拍的选题（泛选题 6 / 人设 2 / 转化 2），校验后存入本地选题库，并提供可视化面板做修改、删除、导出。适用于「根据这份拆解给我出选题 / 我接下来拍什么 / 把这些分析变成一个选题清单」；说「打开选题板 / 看看选题 / 管理选题」时启动并打开本地可视化面板。选题服务于自己，不是给原作品续写。
description_zh: 抖音爆款选题。读取 douyin-viral-blueprint 产出的 report.json（他人作品的拆解分析）作为依据，结合全局账号定位，按薛辉创作方法生成一批 10 条可直接开拍的选题（泛选题 6 / 人设 2 / 转化 2），校验后存入本地选题库，并提供可视化面板做修改、删除、导出。适用于「根据这份拆解给我出选题 / 我接下来拍什么 / 把这些分析变成一个选题清单」；说「打开选题板 / 看看选题 / 管理选题」时启动并打开本地可视化面板。选题服务于自己，不是给原作品续写。
description_en: Douyin Topic Ideation. Reads a report.json produced by douyin-viral-blueprint (a breakdown of someone else's video) and the global account profile, then generates a batch of 10 shootable topics using the Xuehui method (6 generic / 2 persona / 2 conversion). Validated and saved into a local topic library with a visual panel for editing, deleting and exporting. Use it to "give me topics from this breakdown / what should I shoot next / turn this analysis into a topic list", or to open the local board ("open my topic board"). Topics serve YOU, not the original video.
agent_created: true
allowed-tools:
  - execute_command
  - read_file
  - write_to_file
  - search_content
---

# 抖音爆款选题

## 规则

1. **report.json 是别人的作品，只作依据**。可以用它看赛道、人群、评论区在聊什么；不许拿它当「要重拍的对象」
2. **选题服务于「我」**。判断标准：这条拍出来是我账号的内容，不是原作者的续集。出现「重拍 / 改这条」口吻直接判不合格
3. 每批**恰好 10 条**，配比 6 / 2 / 2，缺一条都不入库
4. 账号档案全局一份，缺必填项先引导补齐，补齐前不生成
5. 用户说「打开选题板 / 看选题 / 管理选题」这类话，直接跑 `open.mjs`，不要先问要不要启动、用哪个端口

## 输入

| 输入 | 来源 | 必需 |
|:--|:--|:--|
| `report.json` × 1..N | `douyin-viral-blueprint` 产出 | ✅ 至少一份 |
| 账号档案 | `~/.douyin-viral-blueprint/account.json` | ✅ 赛道与目标人群 |
| 方法论 | `references/xuehui/` 四份（thinking / content-sop / expression / quotes） | ✅ 生成前必读 |

`report.json` 在蓝图跑完的视频目录里，与 `card.json`、`report.html` 同级。整条链路只读 `report.json`，别的不碰。

## 第一步：账号档案

```bash
node {skill_path}/scripts/account.mjs            # 看档案与完整性（已配会直接显示内容）
node {skill_path}/scripts/account.mjs --missing  # 只输出缺项，JSON
node {skill_path}/scripts/account.mjs --json     # 原始 JSON
```

按输出分三种情况：

| 输出 | 处理 |
|:--|:--|
| `✓ 档案完整` | 直接进第二步，**不要再问用户** |
| `✗ 还缺 N 个必填项` | 引导提问，问完写回 |
| 字段后带「（推断，请核对）」 | 提一句「这几个是我猜的，不对就说」，用户认可就不动 |

### 引导提问（只在缺的时候问）

必填两项，问不出来就没法开工：

1. **你做哪个赛道？**（游戏 / 效率工具 / 美妆…）
2. **想吸引谁？**给年龄、处境、为什么看你，不要写「年轻人」这种

可选两项，缺了可以推断：

3. **靠什么变现？**带货 / 服务 / 引流 / 暂时没有
4. **你凭什么讲这个？**职业、经历、手上有的资源

提问要求：

- **一轮问完**，不要挤牙膏一次问一个
- **先给提案再让改**：从 report.json 里读出线索，直接给一个猜测让用户点头，比空问四个问题快得多。例：「评论区一半在聊礼包价格，目标人群是不是『在意氪金性价比的老玩家』？」
- 只问缺的，已有的字段不重复问

### 写回档案

```bash
node {skill_path}/scripts/account.mjs --set "赛道=游戏" "目标人群=30+ 有魔兽情结的老玩家"
node {skill_path}/scripts/account.mjs --set "变现途径=外设带货,代练" "专长/职业=十年魔兽玩家"
```

**推断来的字段**用 JSON 写入并标注来源：

```bash
node {skill_path}/scripts/account.mjs --save - <<'EOF'
{
  "赛道": "游戏",
  "目标人群": "30 岁以上有魔兽情结的老玩家",
  "变现途径": ["外设带货"],
  "专长/职业": ["十年魔兽玩家"],
  "推断字段": ["变现途径", "专长/职业"],
  "推断依据": {
    "变现途径": "评论区在问外设与代练报价",
    "专长/职业": "作者本人在评论区回答版本历史问题"
  }
}
EOF
```

推断必须**有据可依**（来自 report.json 的评论簇或话题），不能凭空安一个人设。写完后提醒用户核对这几项。

## 第二步：从报告里取什么

| 字段 | 用途 |
|:--|:--|
| `维度.话题/行业` | 选题的赛道坐标，直接进 `来源.话题` |
| `维度.目标观众` | 人群锚点，进 `来源.观众` |
| `评论.聚类.簇` | 观众真实在聊什么 —— 最好的选题来源，一簇常常能开一条题 |
| `评论.聚类.分布` | 哪类情绪占多数（有内容 / 情绪 / 意向 / 灌水） |
| `评估.该学的` | 这条赛道上被验证有效的打法 |
| `评估.六轴` | 哪一维强、哪一维弱，决定选题往哪补 |
| `视频.话题`、`视频.文案` | 内容主张，判断赛道用 |

**不要用**：`评估.下次怎么拍`、`结构`、`高亮`、`口播总结`、`一句话结论` —— 这几个字段都在讲「这条片子怎么拍的」，一用就写成续写。

一句话：**看它的赛道与人群，不看它的拍法**。

## 第三步：生成 10 条

生成前读完 `references/xuehui/` 四份，把方法用于当前赛道与人群，不模仿薛辉本人的身份，也不照搬例句。

配比固定：泛选题 6 / 人设选题 2 / 转化选题 2。

- **泛选题**：赛道通用内容，不依赖「我」是谁
- **人设选题**：靠我的经历、立场、判断立住，锚在 `专长/职业` 上
- **转化选题**：承接 `变现途径`，卖点不能编

字段与写法细则见 `references/topic-contract.md`（主题 6–30 字、看点 10–90 字、结构 3–5 段…）。

最容易犯的两条：**10 条只换标题或对象**（观看体验必须真的不同）、**编经历和数据**（没素材就走泛选题）。其余写法细则与反例见契约。

## 第四步：入库

写一个 JSON（字段见契约），调 `save`：

```bash
node {skill_path}/scripts/topics.mjs save topics.new.json
# 或直接管道
node {skill_path}/scripts/topics.mjs save - <<'EOF'
{ "选题": [ ... 10 条 ... ], "来源": { "报告": "...", "话题": "...", "观众": "..." } }
EOF
```

`save` 会逐条核对：条数、配比、字数、段数、爆款元素、主题重复（含跨批次）、空话词、元话术、「重拍」口吻。档案缺 `专长/职业` 或 `变现途径` 时只提醒，不拦入库。

- 通过 → 追加进 `~/.douyin-viral-blueprint/topics.json`，**只追加，不删旧条**
- 不通过 → 打印「待补」，改完再调一次。**不要绕过校验直接改库文件**

## 第五步：管理与导出

### 「打开选题板」

用户说 **打开选题板 / 开选题库 / 看看现在有哪些选题 / 管理一下选题** 之类，就是这件事 —— 直接执行，不要先确认要不要启动、用哪个端口：

```bash
node {skill_path}/scripts/open.mjs          # 已在跑就直接打开页面，没跑就起服务并打开
node {skill_path}/scripts/open.mjs --stop   # 用户说「关掉 / 停掉」时
node {skill_path}/scripts/manage.mjs        # 需要固定端口时（--port 8791）
```

- 探测 8790–8799，命中即复用，**不会重复起进程**；连跑两次第二句会提示「选题库已在运行」
- 打不开浏览器（沙箱 / 无桌面环境）→ 把 `http://127.0.0.1:8790` 直接交给用户，别反复重试
- 面板是给人看的，agent 不代点按钮

### 面板能做的事

- 改主题 / 看点 / 结构 / 标签 / 备注，收藏（★）
- 新增、单条删除、勾选批量删除（全选本页 / 删除选中 N 条）
- 按收藏 / 定位 / 关键词筛选；筛选栏右侧的导出下拉**只导出当前筛选结果**（.md / .csv / .json）
- 分页：默认每页 20 条（可切 50 / 100 / 全部），底部显示「第 x–y 条，共 N 条」

分页只影响显示：**勾选与「全选本页」只作用当前页**，已选条目翻页后仍保留，批量删除按已选条数生效；**导出始终是全部筛选结果**，不是当前页。

面板里手工新增或删除的条目不受「10 条 / 6·2·2」约束 —— 校验只在 `save` 入库时跑。

命令行侧：

```bash
node {skill_path}/scripts/topics.mjs list              # 表格 + 统计
node {skill_path}/scripts/topics.mjs list --json       # 给程序读
node {skill_path}/scripts/topics.mjs show <id>
node {skill_path}/scripts/topics.mjs edit <id> 收藏=是
node {skill_path}/scripts/topics.mjs rm <id>            # 删除（直接删，不可恢复）
node {skill_path}/scripts/topics.mjs export --md --out 选题.md
```

## 文件结构

```
{skill_path}/
├── SKILL.md
├── references/
│   ├── topic-contract.md        选题字段、配比与校验规则
│   └── xuehui/                  薛辉方法论四份（thinking / content-sop / expression / quotes）
├── scripts/
│   ├── account.mjs              账号档案读写与校验
│   ├── topics.mjs               选题库读写与校验（CLI）
│   ├── open.mjs                 一条命令开面板（探测复用 / 起服务 / --stop）
│   └── manage.mjs               本地服务：API + 静态页
├── web/                         面板源码（改样式要重新构建 CSS）
│   ├── index.html
│   ├── app.js                   Vue 3 应用
│   ├── input.css                Tailwind 入口
│   └── tailwind.config.js
└── assets/
    ├── vue.global.prod.js       Vue 3 运行时（155 KB）
    └── manage.css               Tailwind + Flowbite 构建产物（28 KB）
```

改了 `web/` 下的样式或类名，要重新构建 CSS（一次性，产物是 `assets/manage.css`）：

```bash
npm i -D tailwindcss@3 flowbite@2
NODE_PATH=$(pwd)/node_modules npx tailwindcss \
  -c web/tailwind.config.js -i web/input.css -o assets/manage.css \
  --content "$(pwd)/web/**/*.{html,js}" --minify
```

数据全在 `~/.douyin-viral-blueprint/`，与 `douyin-viral-blueprint` 的 `config.json` 同目录：

```
account.json   账号定位（本 skill 写）
topics.json    选题库（本 skill 写）
topics.json.bak  每次写入前自动备份
config.json    key 与模型（蓝图 skill 管，本 skill 不碰）
```

## 依赖

只有两项：**Node ≥ 18**（全部脚本）和 **`report.json`**（生成依据；缺了先跑 `douyin-viral-blueprint`）。

全程离线：不调模型、不抓网络，Vue 与 CSS 都已内联在 `assets/`。选题完全由 agent 读报告 + 方法论生成。

## 经验沉淀

### 最佳实践

**档案先读再问。**
有档案就不打扰用户，只有必填项缺失时才开口，且一次问完。

**推断要留痕。**
推断来的字段写进 `推断字段`，面板会标「含推断字段，建议核对」。用户改过一次就不再是推断。

**选题从评论簇里长出来。**
`评论.聚类.簇` 是选题质量的主要来源 —— 一簇观众诉求往往就是一条题的题眼。只从 `维度` 出题会得到一堆正确但没人想看的泛选题。

**人设与转化选题要靠档案立住。**
6/2/2 是内容角色的配比，不是标题模板。缺 `专长/职业` 就先按评论簇推断并标注，推断不出时宁可换成泛选题 —— 编出来的第一条就会被用户识破。`save` 对这两种情况只提醒不拦。

**入库只追加。**
`save` 永远不删旧条，删除交人工（面板或 `rm`），避免 agent 一次重跑把库清了。

### 踩过的坑

**「重拍这条」是最容易犯的错。**
看到 `评估.下次怎么拍` 就想照着写，写出来的是给原作品的建议。校验器拦「重拍 / 改这条」这类措辞，但真正的防线是别读那个字段。

**面板里不要用 `alert` / `confirm`。**
内嵌 webview 会拦截原生弹窗，`confirm()` 直接返回 false —— 表现是「点删除没反应」。确认类交互一律用自建 modal。

**静态服务的 MIME 要从文件路径推，不是从 URL。**
`/` 没有扩展名，按 URL 推会得到空串 → `application/octet-stream`；curl 看是 200，Chrome 却当成下载直接 abort，表现为「导航没反应、标题还是上一个页面」。排查先看响应头：`curl -D - -o /dev/null http://127.0.0.1:port/`。

**改前端类名后必须重建 CSS。**
不重建时新类名没有定义，视觉直接失效（弹窗变通栏白条就是典型）。构建要传绝对路径的 `--content`（否则扫不到 `app.js`），`flowbite/plugin` 要靠 `NODE_PATH` 解析，类名一律用 ASCII。

**页面底色别用 `@apply` 设在 `@layer base`。**
`@layer base { html, body { @apply bg-gray-950 } }` 构建后会被 preflight 冲掉（实测产物里没有 `#030712`）。
底色、文字色直接写原始声明（`background-color: #030712`），只把组件样式放 `@layer components`。

**写库一律 `.tmp` + `rename`。**
进程被 Ctrl+C 打断时直接 `writeFileSync` 会留下半个 JSON，原子改名保证旧文件完好。
