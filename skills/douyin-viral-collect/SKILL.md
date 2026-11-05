---
name: douyin-viral-collect
version: 1.0.0
display_name: 抖音爆款采集
display_name_en: Douyin Viral Collect
description: 抖音爆款/优质参考视频自动采集。按赛道关键词、对标博主主页或首页推荐流批量浏览，用详情接口拉全量数据，按数据指标预筛后交给 agent 逐条判定，只下载对口的视频并归档。适用于「帮我找一批 XX 赛道的爆款视频 / 采集讲 AI 的低粉爆款 / 把这个博主最近的作品扒下来 / 扫一批对标视频做参考」。只负责采集和下载，不做拆解分析。
description_zh: 抖音爆款/优质参考视频自动采集。按赛道关键词、对标博主主页或首页推荐流批量浏览，用详情接口拉全量数据，按数据指标预筛后交给 agent 逐条判定，只下载对口的视频并归档。适用于「帮我找一批 XX 赛道的爆款视频 / 采集讲 AI 的低粉爆款 / 把这个博主最近的作品扒下来 / 扫一批对标视频做参考」。只负责采集和下载，不做拆解分析。
description_en: Douyin viral / reference video collector. Browses by keyword search, a creator's profile, or the home feed, pulls full metadata from Douyin's detail API, pre-filters on metrics, hands candidates to the agent for per-item judgement, and downloads only the on-target ones. Use it when asked to "find a batch of viral videos in a niche / collect low-follower hits about AI / scrape this creator's recent posts / gather reference videos". Collection and download only - no breakdown analysis.
agent_created: true
allowed-tools:
  - execute_command
  - read_file
  - write_to_file
  - view_image
---

# 抖音爆款采集

## 规则

1. 只做采集和下载。拆解交给 `douyin-viral-blueprint`，选题交给 `douyin-topic-ideation`
2. 判断权在 agent。脚本只给数据和相对分，`--keep` / `--skip` 必须由你按用户标准逐条判
3. 不要自己抓数据。所有采集走 `scripts/collect.js`，不要用 WebFetch、curl、Python requests 碰抖音
4. 一轮一轮推进，不跳步

## 前置检查

CDP 能力在 `cdp-autorunner-skill`，本 skill 不自带。脚本自动定位它，失败时用 `CDP_SKILL_DIR` 指定根目录。

开始前确认该 skill 已初始化：daemon 在跑、Chrome 扩展已连接（按其 SKILL.md 的 G-1 检查）。未就绪先完成它的初始化 SOP。

---

## 第一步：引导（两轮）

**第 1 问单独问采集入口**，第 4 问的内容取决于它。

| 入口 | `--source` | 适用 |
|:--|:--|:--|
| 关键词搜索 | `search` | 用户说的是某个赛道或品类 |
| 博主主页 | `user` | 用户给了具体账号或主页链接 |
| 首页推荐流 | `feed` | 用户说随便刷刷，靠账号画像 |

**第 2 轮问齐四项**：

| # | 问什么 | 参数 | 默认 |
|:--|:--|:--|:--|
| 2 | 视频时长：`short` / `mid` / `long`（可多选） | `--dur` | 三档全选 |
| 3 | 采集数量 | `--count` | 20 |
| 4 | 依入口而定：search → 关键词（逗号分隔可多个）／user → 主页链接／feed → 方向描述 | `--query` | 必填 |
| 5 | 参考重点：`topic` 选题／`craft` 结构表达／`account` 账号打法／`all` 都要 | `--focus` | `all` |

再问一句**判定标准**（`--criteria`），写成能直接执行的条件，例如：

> AI 实操演示和观点，不要卖课、不要纯搬运、不要 AI 生成内容

用户不给就按入口拟一条让他确认。

时长档：`short` 小于 3 分钟 ｜ `mid` 3–20 分钟 ｜ `long` 大于 20 分钟，边界值归 mid。用户给的范围跨档时（如「10 分钟以下」），用 `--dur short,mid` 粗筛，精确边界在裁决时按 `durSec` 卡。

---

## 第二步：建会话

```bash
node {skill_path}/scripts/collect.js plan \
  --source search --query "AI,AI工具" \
  --dur short,mid --count 20 --focus topic \
  --criteria "AI 实操演示和观点，不要卖课、不要纯搬运"
```

产物默认落 `~/.douyin-viral-blueprint/collect/`，`--out` 可改。记下输出的 `sid`。

`plan` 会顺带启动采集面板（端口 8800–8809），之后每采到一条实时推一条。不要面板加 `--no-panel`。

---

## 第三步：循环「取一批 → 裁决 → 提交」

### 3.1 取一批候选

```bash
node {skill_path}/scripts/collect.js next --session <sid>
```

产出 `<out>/_collect/<sid>/batch-NN.json`，封面在 `<sid>/covers/`。

### 3.2 裁决

读 batch 文件，逐条按 `criteria` 判。四个判断依据：

| 字段 | 怎么用 |
|:--|:--|
| `desc` + `tags` + `author.signature` | 赛道对不对口。签名常比文案更能说明账号定位 |
| `metrics.ratio` 赞粉比 | 低粉爆款信号。用相对高低比，不要套绝对阈值 |
| `metrics.favSharePct` 占作者总获赞比 | 这条在作者作品里的分量，越高越是孤篇爆款 |
| `contentType` + 三率 | 工具型（收藏高）／传播型（分享高）／讨论型（评论高） |

`proof` 是池内相对分（1–5），不是绝对好坏，只用来决定先看谁。

`cover` 是封面图绝对路径。**文案为空或只有 tag 的视频必须用 `view_image` 看图再判**；有文案时也可看图核对是否标题党。

### 3.3 提交

```bash
node {skill_path}/scripts/collect.js commit --session <sid> \
  --keep "id1,id2" --skip "id3=纯卖课;id4=搬运"
```

`commit` 会记 skip、并发下载 keep、写 `meta.json` 和 `comments.json`、更新索引，并自动取下一批。重复到输出「目标达成」或「扫描已达上限」。

全都不想要就 `--keep ""`。

---

## 产出

默认根目录 `~/.douyin-viral-blueprint/collect/`，可用 `--out` 或 `DOUYIN_COLLECT_DIR` 改：

```
collect/
├── library.json             面板数据源（收藏 / 删除状态）
├── index.json               跨会话去重索引
├── <视频id>/
│   ├── video.mp4            视频本体
│   ├── meta.json            接口事实 + 本次评分（作者/赞藏评转/时长/文案/话题/直链/指标）
│   ├── comments.json        一级评论（含内嵌回复、地区、点赞、热评标记）
│   └── cover.jpg            封面
└── _collect/<sid>/          会话过程（plan / batch / verdict / covers / state）
```

`meta.json` 字段与 `cdp-autorunner-skill` 的 `douyin-download.js` 一致，可直接喂给 `douyin-viral-blueprint`。

评论默认抓每条前 100 条。不要评论加 `--no-comments`，改条数用 `--comment-limit`。

补抓评论：

```bash
node {skill_path}/scripts/collect.js comments [--limit 200] [--force] [--ids "id1,id2"]
```

默认只处理「有 video.mp4 但没 comments.json」的目录。

---

## 面板

`plan` 时自动启动，也可以手动开：

```bash
node {skill_path}/scripts/collect.js open          # 已在跑就复用
node {skill_path}/scripts/collect.js open --stop   # 关掉
```

端口 8800–8809，命中即复用。卡片显示封面、时长、点赞、评论、收藏、转发，点封面弹窗播放；支持收藏、删除、勾选批量删除。

**批量生成报告**：勾选若干条后点按钮，弹窗给出一段可直接发给助手的提示词：

```
将 ~/.douyin-viral-blueprint/collect 下的 <id1>、<id2> 视频用 douyin-viral-blueprint 技能生成报告
```

面板不代跑，提示词由用户自己复制回来。

---

## 接口限制

元数据全部来自 `aweme/detail`，完整度由接口决定。拿不到的字段：

| 字段 | 情况 | 替代 |
|:--|:--|:--|
| `play_count` | 恒为 0 | 用点赞当量级代理 |
| 完播率 / 涨粉数 / 流量来源 | 不返回 | 只能用赞藏评转 |
| `author.aweme_count` | 不返回 | 用 `favSharePct` 替代 |

不要向用户承诺接口给不了的指标。

---

## 异常处理

| 现象 | 处理 |
|:--|:--|
| 找不到 cdp-autorunner-skill | 未安装或路径不对，用 `CDP_SKILL_DIR` 指定根目录 |
| 无法打开详情页跳板 | 抖音未登录，或 Chrome 标签页过多。登录并关闭多余标签后重跑 |
| 出现滑块或验证码 | 立即停，让用户人工过。不要重试 |
| 全部是已处理过的视频 | 换关键词或博主，或加 `--retry-skipped` |
| 下载失败率高 | 降 `--conc` 到 1；直链有时效，隔天重跑 |
| 候选不够 | 放宽 `--dur`、加关键词、提高 `--max-scan` |
| 面板没反应 | 跑 `collect.js open` 看端口；已有一份在跑会自动复用，不会重复起 |

## 注意

- 低粉爆款稀疏，凑 20 条可能扫 100 条以上。候选质量差是样本问题，不要为此调高判据
- 索引跨会话共享，同一赛道第二次采集会更快
