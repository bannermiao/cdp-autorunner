# 版本号更新 & 发布流程

> 本文档记录 cdp-server（CLI）、Chrome 扩展、skill 下载脚本三处版本号的更新与发布步骤，供下次发版参考。

## 一、版本号位置速查

| 位置 | 文件 | 示例 |
| --- | --- | --- |
| CLI 版本号 | `cdp-server/cmd/root.go`（`version` 命令输出） | `cdp-server v1.2.0` |
| 扩展版本号 | `cdp-extension/manifest.json`（`version` 字段） | `"version": "2.2.0"` |
| skill 下载版本号（bash） | `cdp-autorunner-skill/SKILL.md`（`I-0` 安装段） | `VERSION="v1.2.0"` |
| skill 下载版本号（PowerShell） | `cdp-autorunner-skill/SKILL.md`（`I-0` 安装段） | `$VERSION = "v1.2.0"` |
| skill version 输出示例 | `cdp-autorunner-skill/references/cdp-server-cli.md` | `cdp-server v1.2.0` |

> 注：CLI 与扩展版本号独立，不必一致（如 CLI v1.2.0 / 扩展 2.2.0）。

## 二、更新步骤

### 步骤 1：修改 CLI 版本号

`cdp-server/cmd/root.go`：

```go
fmt.Println("cdp-server vX.Y.Z")
```

### 步骤 2：修改扩展版本号

`cdp-extension/manifest.json`：

```json
"version": "X.Y.Z"
```

### 步骤 3：修改 skill 下载版本号（3 处）

- `cdp-autorunner-skill/SKILL.md`：`VERSION="vX.Y.Z"` 和 `$VERSION = "vX.Y.Z"`
- `cdp-autorunner-skill/references/cdp-server-cli.md`：`cdp-server vX.Y.Z` 输出示例

### 步骤 4：同步 skill 脚本（如有代码更新）

根目录新版脚本需同步到 skill，并改用 skill 惯例定位二进制：

```powershell
Copy-Item ebay-research.js        e:/skills/cdp-autorunner/cdp-autorunner-skill/scripts/ebay/ebay-research.js -Force
Copy-Item ebay-research-worker.js e:/skills/cdp-autorunner/cdp-autorunner-skill/scripts/ebay/ebay-research-worker.js -Force
```

同步后脚本中 `CDP_BIN` 定位须为 skill 惯例（从 `scripts/` 上级目录加载，即 `path.join(__dirname, '..', name)`），否则找不到二进制。

### 步骤 5：编译本机二进制并复制到 3 处

```powershell
cd e:/skills/cdp-autorunner/cdp-server
go build -o cdp-server.exe .                          # 输出即仓库内副本 cdp-server\cdp-server.exe
Copy-Item cdp-server.exe ..\scripts\cdp-server.exe -Force
Copy-Item cdp-server.exe ..\cdp-autorunner-skill\scripts\cdp-server.exe -Force
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
