---
name: douyin-viral-blueprint
version: 2.0.0
display_name: 抖音爆款蓝图
display_name_en: Douyin Viral Blueprint
description: 抖音爆款蓝图。输入 cdp-autorunner-skill 下好的素材（video.mp4 / meta.json / comments.json），做切镜抽帧、口播转写、评论语义聚类，产出机器事实卡，再由 agent 对照事实写出拆解分析，渲染成单文件 HTML 报告。只做分析不负责下载，缺素材直接停。适用于「拆解某条抖音视频 / 分析这条视频为什么火 / 爆款视频逆向 / 复刻这条视频的打法」。
description_zh: 抖音爆款蓝图。输入 cdp-autorunner-skill 下好的素材（video.mp4 / meta.json / comments.json），做切镜抽帧、口播转写、评论语义聚类，产出机器事实卡，再由 agent 对照事实写出拆解分析，渲染成单文件 HTML 报告。只做分析不负责下载，缺素材直接停。适用于「拆解某条抖音视频 / 分析这条视频为什么火 / 爆款视频逆向 / 复刻这条视频的打法」。
description_en: Douyin Viral Blueprint. Given a video folder produced by cdp-autorunner-skill (video.mp4 / meta.json / comments.json), it detects shots, builds frame contact sheets, transcribes audio, clusters comments semantically, and produces a machine fact card; the agent then writes a breakdown analysis rendered as a single offline HTML report. Analysis only - it does not download. Use it to "break down a Douyin video / analyze why it went viral / reverse-engineer a hit / replicate its playbook".
agent_created: true
allowed-tools:
  - execute_command
  - read_file
  - write_to_file
  - replace_in_file
  - search_content
  - view_image
---

# 抖音爆款蓝图

## 规则

1. **只做分析，不下载**。素材必须由 `cdp-autorunner-skill` 的 `douyin-download.js` 产出
2. 三件产物缺任一 → **立即停止**，让用户先跑下载脚本；不要自己抓，不要 `--force` 绕过
3. 按 1 → 5 顺序执行，不跳步

## 输入

目录形如 `<out>/<视频id>/`：

| 文件 | 必需 | 用到什么 |
|:--|:--|:--|
| `video.mp4` | ✅ | 切镜、抽帧、抽音频转写 |
| `meta.json` | ✅ | 作者、赞评藏转、时长、文案、话题、封面、`createTime` |
| `comments.json` | ✅ | 一级评论全量（文本、点赞、时间、地区、昵称） |

`prepare` 第一步就是闸门校验，缺哪件报哪件，不会继续。

## 准备（key）

先跑一次不带参数的，它自己判断该不该配：

```bash
node {skill_path}/scripts/config.mjs
```

| 输出 | 含义 | 下一步 |
|:--|:--|:--|
| `✓ key 可用（… 1024 维 …）` | 已配好，且实测打通 | **不用再配**，直接进流程 |
| `还没配 key` | 从头到尾没配过 | 按下面「没配过」做 |
| `✗ key 不可用：…` | 配了但用不了 | 按下面「配了但不通」做 |

### 没配过

1. 打开 [cloud.siliconflow.cn](https://cloud.siliconflow.cn) 注册登录
2. 左侧「API 密钥」→ 新建 → 复制 `sk-` 开头那串
3. 账户里要有余额：三个接口都计费，跑一条 60 秒视频约几分钱
4. 写进配置：

```bash
node {skill_path}/scripts/config.mjs --set-key sk-xxx
node {skill_path}/scripts/config.mjs --test
```

写 `~/.douyin-viral-blueprint/config.json`（用户目录，更新 skill 不会丢）。

### 配了但不通

| 提示 | 原因 | 处理 |
|:--|:--|:--|
| `30001` | 余额不足 | 硅基流动后台充值，再 `--test` 复测 |
| `401` / `403` | key 无效或已撤销 | `--set-key sk-新的` |
| `404` | baseUrl 路径不对 | 要形如 `https://xxx/v1` |
| `fetch failed` | 网络抖动 | 已内置重试，仍失败再跑 `--test` 看三路 |

`--test` 逐个探三路，全通才往下跑：

```
✓ embedding   BAAI/bge-m3  →  1024 维
✓ chat        Qwen/Qwen3-8B  →  "好"
✓ asr         FunAudioLLM/SenseVoiceSmall  →  可上传
```

### 三个模型

一把 key 全包：

| 用途 | 模型 |
|:--|:--|
| ASR 转写 | `FunAudioLLM/SenseVoiceSmall` |
| 评论 embedding | `BAAI/bge-m3` |
| 评论标注 | `Qwen/Qwen3-8B` |

### 不配会怎样

| 环节 | 降级 |
|:--|:--|
| ASR | 不转写，`card.口播判定` 标「未转写」，报告缺口播两块 |
| embedding | 评论退字数口径：无簇、无标签分布、无模板组 |
| 标注 | 单条标 `unlabeled`，不阻断，簇仍能算 |

### 其他

- `--no-check` 只看配置值、不探活（离线或想快速看一眼时用）
- 换模型或调阈值：`node config.mjs --set speechMinRate=80`，字段见 `scripts/config.mjs` 的 `FIELDS`
- 优先级：环境变量 `DR_*` > `<当前目录>/dr.config.json` > 用户目录 > `<skill>/config.json`

## 命令

| 命令 | 作用 |
|:--|:--|
| `prepare.mjs <目录>` | 闸门 → 切镜 → 抽帧拼图 → ASR |
| `card.mjs <目录>` | 事实卡 + 评论聚类 → `card.json` |
| `check.mjs <目录>` | 校验 `report.json`，输出待补 / 提醒 |
| `check.mjs <目录> --write` | 校验并把结果写回 `report.json` 的 `状态` |
| `check.mjs --contract` | 打印契约（字段、取值范围、校验规则） |
| `report.mjs <目录> [--out <文件名>]` | 渲染单文件 `report.html` |
| `config.mjs` | 看配置；已配了就用一次 embedding 实测验通 |

通用参数：

| 参数 | 适用 | 作用 |
|:--|:--|:--|
| `--force` | prepare / card | 重跑该步（已存在的产物默认跳过） |
| `--skip-asr` | prepare | 不转写 |
| `--no-llm` | card | 评论走字数口径，不调接口 |
| `--rebuild-comments` | card | 评论没变也强制重算聚类 |
| `--no-check` | config | 只看配置值，不发请求 |

`card` 默认按评论指纹复用上次聚类：评论没变时 `--force` 也直接复用，不重复烧计费接口。

## 流程

### 1. 准备素材

```bash
node {skill_path}/scripts/prepare.mjs <视频目录>
```

产出 `media.json`（切镜点、帧索引、拼图索引）、`拼图-NN.jpg`，以及 `转写.txt` **或** `口播.json` 二者之一。

- 转写按 60 秒切片并发上传，拼回时间戳
- **转写先体检**：有效字数 < 20 或语速 < 60 字/分判为「无有效口播」，此时不写 `转写.txt`，改写 `口播.json`（原始识别 + 度量 + 原因）。纯音乐、只念片尾口号的预告都属此类
- 拼图失败不阻断，只记 `media.失败`，报告侧把画面维度写进缺口
- 没有 key 时加 `--skip-asr`
- 只想重跑转写：删掉 `转写.txt`/`口播.json` 再跑（画面已有会自动跳过，不必 `--force` 重算拼图）

### 2. 派生事实卡

```bash
node {skill_path}/scripts/card.mjs <视频目录>
```

`card.json` 包含：

| 块 | 内容 |
|:--|:--|
| `视频` | 时长、赞评藏转、三组比值、文案、话题、章节 |
| `内容轴` | 语速、口播覆盖率、口播段数、首句秒、切镜每分钟 |
| `密度曲线` / `密度统计` | 30 秒分桶的字数曲线与均值、低洼、前后半；无口播时不存在 |
| `口播判定` | 仅当无有效口播或未转写时出现，写明原因 |
| `评论` | 指纹、水评率、标签分布、模板组、主题簇（含 PCA 2D）、时间分布、地区 Top |

- 无有效口播时语速 / 覆盖率 / 首句秒为 `null`、段数 0，**但切镜每分钟照常给**（纯画面视频的节奏全靠它）
- **簇名不在这里起**：机器只聚簇，名字归第 3 步

### 3. 写 report.json

读 `card.json`，打开拼图看画面，写 `report.json`。

**看图的正确做法**

1. 拼图是 `<视频目录>/拼图-01.jpg`，用绝对路径直接打开看
2. 看过的张号写进 `report.已看`（如 `[1, 2]`）。有拼图却一张没看过 → 判待补
3. 依据里引用的格号（`拼图-02.jpg 第 6 格`）只能来自看过的张，没看过就引用 → 判待补
4. 格号对应秒数查 `media.json` 的 `帧从/帧到`，不靠眼算

**写作要求**（细则见 `references/report-contract.md`，颗粒度基准见 `references/analysis-sample.md`）：

- 每个判断都带依据指针（`内容轴.切镜每分钟`、`拼图-01.jpg 第 4 格`），指针里不写数值
- 评论簇逐簇起名，漏一簇判待补
- 数量硬约束：一句话结论 10–200 字、过程 4–8 步、结构 2–8 段、维度两个键各 2–4 条
- 不许出现「相比另一条 / 平台均值 / 行业经验」
- `card.口播判定` 存在时，高亮与口播总结交空数组，缺口写清楚「无有效口播 + 原因」

```bash
node {skill_path}/scripts/check.mjs <视频目录> --contract   # 写之前先看契约
```

### 4. 校验

```bash
node {skill_path}/scripts/check.mjs <视频目录>
```

| 输出 | 含义 | 处理 |
|:--|:--|:--|
| 待补 | 缺内容或违规，硬拦 | 补齐后重跑，清零才算交付 |
| 提醒 | 写法问题 | 机器提示，人工判断 |

`待补` 的常见项：漏判断项 / 六轴有 null / 指标有底座却写 null / 过程不在 4–8 步 / 结构段数或间隔不对 / 高亮数量或角色不足 / 评论簇漏名 / 引用了没看过的拼图张 / 正文有自我修正括注。

`提醒` 的常见项：依据里写了数值 / 正文数字正好等于 card 现值 / 指针指向不存在的字段 / 拼图格号越界 / 高亮起秒对不上任何一句 / 段名超 6 字。

### 5. 出报告

```bash
node {skill_path}/scripts/report.mjs <视频目录>
```

单文件 `report.html`：CSS、ECharts、抽帧图全部内联，**零外部请求，断网也能显示图表**，双击即开。约 900 KB～1 MB。
`assets/echarts.min.js` 缺失时自动退回 CDN。

## 报告板块

渲染顺序固定，缺素材时整块不画，不留空壳。

| 板块 | 内容 | 来源 |
|:--|:--|:--|
| 指标卡 + 一句话结论 | 时长 / 赞 / 藏 / 评 / 转 + 一句结论 | `card.视频` + `report.一句话结论` |
| 六轴画像 | 雷达 + 每轴名称 / 说明 / 10 格刻度 / 分数 | `report.评估.六轴` |
| 结构 · 平台章节 / AI 划分 | 分段色条 + 每段概括 | `report.结构`，平台给了章节则用 `card.视频.章节` |
| 视频抽帧 | 拼图轮播（标格号与覆盖秒段，可点开放大） | `card.画面.拼图` |
| 整体分析 | 判断八项 + 该学的 / 别学的 | `report.判断` + `report.评估` |
| 口播内容 | 全文上色 + 右侧位置标尺 + 口播总结 | `card.口播稿` + `report.高亮` + `report.口播总结` |
| 口播节奏 | 密度曲线 + 一句解读 | `card.密度曲线` + `report.评估.解读.口播节奏` |
| 评论分析（语义 / 字数） | 水评率 → 标签分布 → 主题簇榜 → 长尾 / 地域 → 结论句 | `card.评论.*` + `report.评估.评论簇` |
| 维度提炼 | 话题/行业 · 目标观众（值 + 依据） | `report.维度` |
| 缺口 | 这次缺什么、为什么影响结论 | `report.缺口` |

## 结构与产出

```
{skill_path}/
├── SKILL.md
├── references/  report-contract.md（契约）· analysis-sample.md（写作样本）
├── assets/      report-template.html · echarts.min.js（734 KB，内联进报告）
└── scripts/     config · prepare · card · check · report

<视频目录>/
├── video.mp4 / meta.json / comments.json    ← 下载产出，本 skill 不改
├── media.json      切镜与拼图索引（帧号 ↔ 秒数）
├── 转写.txt        ASR 全文；判为无口播时不生成
├── 口播.json       无有效口播时的判定证据
├── 拼图-01.jpg …   抽帧网格
├── card.json       事实卡（机器派生，勿手改）
├── labels.json     评论逐条标注（旁路）
├── report.json     agent 产物
└── report.html     最终报告
```

## 依赖

| 依赖 | 用途 | 缺失时 |
|:--|:--|:--|
| `ffmpeg`（PATH 内） | 切镜、抽帧、抽音频 | 硬失败，`prepare` 报错 |
| 硅基流动 key | ASR / embedding / 标注 | ASR 与聚类降级，报告缺口播与簇 |
| 能读图的模型 | agent 看拼图 | 画面维度只能留空 |
| `assets/echarts.min.js` | 报告图表 | 自动退回 CDN |

## 经验沉淀

### 最佳实践

**先 `--test` 再跑链路。**
三路任一不通都会让报告掉一块，先花 3 秒确认，别等跑完 20 分钟才发现。

**转写先体检再落盘。**
ASR 对纯音乐照样吐几句词（歌词、片尾「抖音」），直接当口播会算出 20 字/分的假语速。

**格号查 `media.json`。**
拼图有没有烧时间戳取决于字体文件在不在，`帧从/帧到` 才是唯一可靠换算。

**别重复跑聚类。**
`card` 默认按评论指纹复用；只有换了评论或改了聚类参数才加 `--rebuild-comments`。

**评论数是快照。**
同一视频两次采集 148→160 属正常。报告写「实取 N 条」，不写平台宣称总数。

**看过的张才许引用。**
`已看` 是自报，没有工具替你记账。宁可把画面维度写进缺口，也别填没看过的张号。

**待补清零才算交付。**
待补是硬拦，提醒是人判断。

### 踩过的坑

**「无有效口播」≠「没转写」。**
不区分这两件事，agent 会在缺口里写「未转写（缺 key）」，其实是纯音乐。`card.口播判定` 就是用来区分三种状态的。

**簇号会变。**
`--rebuild-comments` 之后 k-means 可能换 k、换簇号，旧簇名立刻张冠李戴。重算评论就要重写 `评估.评论簇`。

**字节 CDN 没有 echarts。**
`cdn.bytedance.com`、`lf*-cdn-tos.bytecdntp.com` 各类路径全 404，连 jquery 也是。国内可用 `cdn.staticfile.net`、`registry.npmmirror.com`。

**`echarts.common.min.js` / `simple` 不含雷达。**
`setOption` 不报错，`getOption().series` 返回空数组，静默丢弃。要用全量包。

**4.3.0 没有 `itemStyle.borderRadius`。**
5.x 才有，4.x 静默忽略。报告固定在 4.3.0，配置只用两版都支持的写法。

**改动模板时注意三件事。**
`#radar` 的注入要等 `app.innerHTML = ...` 之后（否则节点还不存在）；图表代码别引用 `if` 块内定义的变量（一个 `ReferenceError` 能让四张图全不画）；所有交给 `ffmpeg` 或 `writeFileSync` 的路径先 `resolve()`。

**首次 HTTPS 请求偶发 `fetch failed`。**
DNS/TLS 首握手会失败，同一请求第二次就 200。`config --test` 已内置一次重试。

**本地预览要起 http，不要用 `file://`。**
Chrome 扩展默认没有「允许访问文件网址」，`file://` 会落到 `chrome-error`。报告本身双击是可用的，只是自动化验证得走 `http://127.0.0.1:port/`。另外 `browser screenshot` 截的是活动 tab，不是 `eval-target` 指的 tab。
