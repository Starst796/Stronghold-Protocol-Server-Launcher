# 更新记录

## 1.1.7 — 2026-10-11

修复游戏更新后「更新到最新版本」与「下载素材」因上游索引过期而报错的问题。

### 修复

- **游戏更新新增干员后，素材同步会以「素材清单将缩小」失败，并且重跑也不变**：素材计划由游戏仓库的 `tools/fetch-assets.mjs` 生成，其中干员的战斗语音 / 音效来自上游索引（`charword_table.json`、`audio_data.json`、`models_data.json`），这些索引缓存在安装目录的 `.cache/` 下、只在缺失时才重新下载。如果游戏更新（例如 0.2.3 加入 Clementia `char_4231_clemnt`）晚于上次下载索引，新干员的 32 条音频条目就进不了新清单，`fetch-assets` 的「清单永不无故缩小」保护会保留仓库里的 `data/assets.json` 并以退出码 1 结束——启动器把它显示成 `✘ 下载素材 失败（退出码 1）`（更新流程里则是 `素材下载未完成（网络问题？）`），看起来像下载失败，其实文件都在、只是索引旧了。
- 现在素材同步会识别这一保护（`ERROR: data/assets.json NOT written — it would lose N entries`），自动补上 `--refresh-index` 重新拉取上游索引后重试一次——这正是 `fetch-assets` 自己打印的补救办法。索引新鲜时不会重试，也不会多下载任何内容。
- **「更新到最新版本」也会自愈**：`tools/setup.mjs` 里的素材同步被上述保护拦下时（它只在报告 `.cache/assets-report.json` 里写 `manifestWritten: false` 并告警），启动器会在其后补一步「补全美术 / 音频素材（必要时刷新上游索引）」重新同步。素材仍不完整时只警告（游戏可用占位图运行），不会把已经成功的代码更新判为失败。「一键部署」「修复安装」同样处理。

### 变更

- `launcher/lib/repo.mjs`：新增 `syncAssets()`（素材同步，失败时按需 `--refresh-index` 重试一次）与 `assetManifestHeld()`（读游戏报告，判断仓库清单是否被保护保留）。
- `launcher/lib/tasks.mjs`：自定义步骤（`run`）现在可以经 `ctx.trackChild()` 交出子进程，使「取消」仍能终止素材下载这类长任务。
- 「下载素材」改用 `syncAssets()` 运行：确实无法完成时仍然报失败（与更新流程的「只警告」相区分），同时保留可取消。

## 1.1.6 — 2026-10-05

修复 macOS / Linux 启动脚本的换行符（CRLF）问题。

### 修复

- **macOS 双击 `启动器.command` 报 `bad interpreter: /bin/bash^M`**：仓库里的 `start.sh` / `启动器.command` 本身是 LF，但在 Windows 上（`core.autocrlf=true`）检出后工作区会变成 CRLF；把工作区直接打成压缩包分发，CRLF 就让 shebang 变成 `#!/bin/bash\r`，macOS 找不到 `/bin/bash^M`。现在 `.gitattributes` 显式声明 `*.sh` / `*.command` 为 `text eol=lf`，无论本机 `core.autocrlf` 如何，检出与打包都保持 LF；发布用的 `*.bat` / `*.cmd` 依旧保持 CRLF，不受影响（见 1.1.2）。
- 把工作区里所有文本文件重新归一化为 LF 并提交，修好此前已经带着 CRLF 的副本。
- `启动器.command` 改用 `bash ./start.sh` 调用，不再依赖脚本的执行位。

### 变更

- `.gitattributes` 增加 `* text=auto eol=lf`，并为 `*.sh` / `*.command` 显式指定 `eol=lf`。

## 1.1.5 — 2026-10-04

未安装 git 时的启动提示。

### 新增

- **检测到没有 git 时给出非阻塞的安装指引**：启动器启动时（以及网页每次刷新时）检查 `PATH` 里是否有 `git`，缺失则在控制台横幅和网页顶部显示一条可关闭的提示，列出各平台安装命令（Windows 的 winget/scoop/choco、macOS 的 Homebrew/Xcode、Linux 的 apt/dnf/pacman）和官方下载页面，支持一键复制安装命令、可「不再提示」。游戏本身仍可用压缩包方式部署，不受影响。
- 启动器状态接口新增 `launcher.gitInstall` 字段（有 git 时为 `null`），供前端渲染上述指引。

## 1.1.4 — 2026-10-04

服务器下载处增加了本人部署的Gitee镜像源。

## 1.1.3 — 2026-10-04

自动更新测试。

## 1.1.2 — 2026-10-04

真正修复 Windows 下双击 `启动器.bat` 报「不是内部或外部命令」/ 乱码的问题。

### 修复

- **根因是换行符，不是 `chcp`**：`启动器.bat` 是 UTF-8 且含中文，但提交时被 Git（`core.autocrlf`）把 CRLF 归一化成了纯 LF。cmd.exe 解析「纯 LF 换行 + 多字节字符」的批处理时，按字节计算的行游标会错位，于是把 `if defined …`、`!ZIP!`、`!MSI!`、`SP_NODE_DRY_RUN` 等片段当成命令执行，屏幕上一片乱码；从 GitHub 直接下载的 ZIP 用的正是仓库里的 blob，必然复现。现在新增 `.gitattributes`（`*.bat -text diff`）关闭批处理的换行归一化，让仓库 blob、`git clone` 与 GitHub ZIP 下载都保持 CRLF，问题消失。
- 顺带把 `chcp 65001` 提到 `@echo off` 之后、所有非 ASCII 内容之前（原先排在三行中文注释之后），与游戏本体的 `start-windows.bat` 写法一致。

## 1.1.1 — 2026-10-04

Windows 入口脚本的首轮修复（不完整）。

### 修复

- 把 `chcp 65001` 移动到所有非 ASCII 内容之前。这一步本身不足以解决问题，真正的原因见 1.1.2。

## 1.1.0 — 2026-10-04

启动器自身的更新能力，以及更新日志的可读性修复。

### 新增

- **启动器自我更新**：启动时会（在控制面板打开之前、此时没有任何对局在运行）检查本项目 `origin` 仓库并快进到最新版本，然后自动重启；也可以在「主界面 → 启动器更新」里手动检查 / 更新 / 重启。仓库无法访问、本地有未提交改动时会自动跳过，不影响使用。
- 「配置 → 启动器更新」：可开关「启动时自动更新启动器」，也可以手动指定仓库地址（留空则使用 `origin`）。

### 修复

- **「打开安装目录 / 打开启动器目录」按钮点了没反应**：`explorer.exe` 配合 `windowsHide` 会创建一个**永远不显示**的窗口——它存在于系统窗口列表里，但屏幕上什么都看不到，所以看起来像没反应，反复点击还会在后台堆一堆隐形窗口。Windows 上改为经 `cmd /c start "" <目录>` 打开，窗口既可见又会被带到前台；路径含 cmd 元字符时退回可见的 explorer 窗口。macOS / Linux 不受影响。
- 打开目录失败时不再静默：现在会提示具体原因和完整路径。

### 改进

- **更新日志按 Markdown 渲染**：标题、列表、链接、行内代码、加粗都会正确显示，不再是原始的 `###` / `-` 文本。
- 「关于」页新增「启动器更新历史」。

## 1.0.0 — 2026-10-04

首个版本。

- 选择下载源（GitHub 官方 + 多个加速镜像）一键部署《卫戍协议：盟约》，自动安装依赖并下载美术 / 音频素材（可中断续传）。
- 一键启动 / 停止 / 重启服务器，探测 `/healthz` 就绪后自动打开浏览器，列出可分享的局域网地址。
- 内置实时日志终端：ANSI 颜色、时间戳、按通道过滤、导出日志。
- 六套启动预设（对应游戏的 `PORT` / `HOST` / `SP_COMBAT` / `SP_VERIFY` / `TRUST_PROXY` / `DEBUG`），可保存自定义预设。
- 游戏版本检测与更新，显示版本号和更新历史（`CHANGELOG.md` + `git log`）。
- 随包附带 Windows / macOS / Linux 三平台的 Node.js 运行时，没装 Node 也能直接开。
