# 版本号更新 & 发布流程

> 本文档记录 cdp-server（CLI）、Chrome 扩展、各 skill 下载版本的更新与发布步骤。

## 一、版本号位置速查

| 位置 | 文件 | 示例 |
| --- | --- | --- |
| CLI 版本号 | **不再手改**：构建时由 git tag 注入（`-X cdp-server/cmd.version`），源码里是 `var version = "dev"` | `cdp-server v1.4.2` |
| 扩展版本号 | `cdp-extension/manifest.json`（`version` 字段） | `"version": "2.2.0"` |
| 扩展页面显示版本号 | `cdp-extension/popup.html`（`brand-ver`） | `v2.2.0 · Developer Tool` |
| skill 下载版本号（bash） | `cdp-autorunner-skill/SKILL.md`（`I-0` 安装段） | `VERSION="v1.4.2"` |
| skill 下载版本号（PowerShell） | `cdp-autorunner-skill/SKILL.md`（`I-0` 安装段） | `$VERSION = "v1.4.2"` |
| skill version 输出示例 | `cdp-autorunner-skill/references/cdp-server-cli.md` | `cdp-server v1.4.2` |
| 应用 skill 下载版本号 | `skills/*/SKILL.md`（含 `I-0` 安装段的 skill，如 `ebay-research-skill`；bash 与 PowerShell 各一处） | `VERSION="v1.4.2"` |
| 应用 skill version 输出示例 | `skills/ebay-research-skill/references/cdp-cli.md` | `cdp-server v1.4.2` |

> 注：CLI 与扩展版本号独立，不必一致（如 CLI v1.2.0 / 扩展 2.2.0）。

## 二、更新步骤

### 步骤 1：CLI 版本号（无需手改）

版本号在构建时由 tag 注入，源码里只有默认值：

```go
// cdp-server/cmd/root.go
var version = "dev"
```

`release.yml` 里：

```yaml
LDFLAGS="-X cdp-server/cmd.version=${{ github.ref_name }}"
```

所以你只需要打 tag，`--version` 自动等于 tag 名。本地 `go build` 不带 ldflags 时输出 `cdp-server dev`。

### 步骤 2：修改扩展版本号（2 处）

- `cdp-extension/manifest.json`：

```json
"version": "X.Y.Z"
```

- `cdp-extension/popup.html`（页面右上角显示，格式 `vX.Y.Z · Developer Tool`）：

```html
<span class="brand-ver">vX.Y.Z · Developer Tool</span>
```

> 注意：两处必须一致，否则扩展页面显示的版本号与实际不符。

### 步骤 3：修改 skill 下载版本号（每个 skill 的 bash / PowerShell 各 1 处）

- `cdp-autorunner-skill/SKILL.md`：`VERSION="vX.Y.Z"` 和 `$VERSION = "vX.Y.Z"`
- `cdp-autorunner-skill/references/cdp-server-cli.md`：`cdp-server vX.Y.Z` 输出示例
- `skills/*/SKILL.md`：含下载段的 skill 同样改 bash 与 PowerShell 两处（如 `skills/ebay-research-skill/SKILL.md`）
- `skills/*/references/*.md`：出现 `cdp-server vX.Y.Z` 输出示例的一并改（如 `skills/ebay-research-skill/references/cdp-cli.md`）

### 步骤 4：skill 脚本归属

脚本只存在各自的 skill 目录，不跨目录复制：

| skill | 脚本位置 |
| --- | --- |
| `cdp-autorunner-skill` | `cdp-autorunner-skill/scripts/<站点>/`（google / taobao / deepseek / douyin / ebay） |
| 应用 skill | `skills/<skill-name>/scripts/`，按该 skill 内部结构分层（如 `ebay-research-skill/scripts/{ebay,lib,vendor}`） |

需要调用二进制的 skill，脚本用 `__dirname` 从 `scripts/` 上级目录定位（`path.join(__dirname, '..', name)`），不读仓库根路径。

### 步骤 5：编译本机二进制并复制到各 skill

```powershell
cd e:/skills/cdp-autorunner/cdp-server
go build -o cdp-server.exe .                          # 输出即仓库内副本 cdp-server\cdp-server.exe
Copy-Item cdp-server.exe ..\scripts\cdp-server.exe -Force
Copy-Item cdp-server.exe ..\cdp-autorunner-skill\scripts\cdp-server.exe -Force
Copy-Item cdp-server.exe ..\skills\ebay-research-skill\scripts\cdp-server.exe -Force
```

> 注意：`bin/` 目录已于 2026-08-20 随 npm 发布内容一并删除，**不要再复制到 `bin/`**。

### 步骤 6：验证版本

```powershell
scripts\cdp-server.exe version
# 输出：cdp-server vX.Y.Z
```

### 步骤 7：重新打包扩展

Chrome Web Store 要求 zip 直接包含 `manifest.json`（不含外层目录）：

```powershell
cd e:/skills/cdp-autorunner
Compress-Archive -Path cdp-extension\* -DestinationPath cdp-extension.zip -Force
```

打包后抽查 zip 内 `manifest.json` 版本号是否为 `X.Y.Z`。

### 步骤 8：提交、打 tag、推送

```powershell
cd e:/skills/cdp-autorunner
git add -A
git commit -m "chore(release): bump versions to vX.Y.Z (cli/extension)"
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

### 步骤 9：核验 GitHub Release 资产

`.github/workflows/release.yml` 在 `push tags 'v*'` 时自动交叉编译并上传 4 个资产。等待 Actions 完成后核验：

```powershell
gh release view vX.Y.Z --json name,assets
```

4 个资产须齐全：

| 资产 | 平台 |
| --- | --- |
| `cdp-server-win-x64.exe` | Windows x64 |
| `cdp-server-linux-amd64.gz` | Linux amd64 |
| `cdp-server-darwin-amd64.gz` | macOS amd64 |
| `cdp-server-darwin-arm64.gz` | macOS arm64 |

### 步骤 10：发布扩展（手动）

登录 [Chrome Web Store 开发者后台](https://chrome.google.com/webstore/devconsole)，上传 `cdp-extension.zip` 提交审核，填写更新日志。

## 三、注意事项

1. **无需 npm 发布**：CLI 通过 GitHub Release 分发，`npm publish` 已废弃（2026-08-20 移除 `package.json`/`postinstall.js`/`.npmignore`/`bin/`）。
2. **skill 不单独管理版本**：跟随仓库 git 走，仅在 `SKILL.md` 中维护 cdp-server 下载版本号。
3. `release.yml` 触发条件是 `push: tags: 'v*'`，务必先 `git push origin main` 再推 tag（或确认 main 已包含最新提交）。
4. 若 skill 脚本有变更，务必与版本号改动同一 commit 提交，避免文档与脚本脱节。
