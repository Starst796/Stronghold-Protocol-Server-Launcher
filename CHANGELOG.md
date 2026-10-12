# 更新记录

## 1.1.10 — 2026-10-12

模组叠加：单行压缩的数据文件改为按 JSON 键做三方合并，两个内容模组因此可以共存。

### 新增

- **数据文件的语义合并（`launcher/lib/mods.mjs`）**：`data/assets.json`、`data/chess.json`、`data/backups.json` 等是压缩成一行的键值表，「1 行改动」就是整行替换，两个模组改同一个文件必然文本冲突——即使改的是不同记录。现在补丁未能应用时会**逐文件**处理：对这类文件取「补丁的前置内容」为 base、工作区为 ours、补丁的目标内容为 theirs，**按 JSON 键递归三方合并**，再写回规范的单行压缩格式。
  - 安全性由两条性质保证：这些文件能逐字节往返（`JSON.stringify(JSON.parse(text)) === text`），所以合并后格式与项目一致、文件里其它内容一个字节不动；合并是保守的——只合并能证明互不影响的改动，数组不做逐元素猜测，「一边删除一边修改」也算冲突，不会悄悄产出意思变了的文件。
  - 合并成功会写进日志（`语义合并：data/assets.json 按 JSON 键合并成功`）；真正改到同一项时给出具体的 JSON 路径（例如 `data/x.json 的 $.b 处被两个模组同时修改`）。
- **补丁解析与逐文件回退**：新增 `patchFileSections()`（把补丁拆成每个文件的完整前后文本）与 `resolvePatchFileByFile()`。整份补丁应用失败时逐文件尝试：直接应用 → JSON 语义合并 → 三方合并。

### 修复

- **`git apply --3way` 因索引过期而失效**：前面模组的改动是未暂存的，`--3way` 需要索引与工作区一致，于是报 `does not match index`；结果是**本可自动合并的文件**（实测如 `README.md`）被误判为失败。现在逐文件回退时先暂存工作区、结束后撤销暂存（改动必须保持未暂存，「还原为原版」和锁文件的"新增文件"列表都依赖这一点）。
- **`还原为原版` 对暂存状态更稳**：还原前先 `git reset`，即使上一次应用被中断、索引里还留着暂存内容，也能正确回到基线。
- **冲突提示更准确**：无法合并时不再笼统地说「多半与上游版本不匹配」，而是**列出具体重叠的文件**并说明是与另一个模组改了同一处（建议用 `conflicts` 声明）。

### 验证

- 合并规则 18 项单测（独立修改合并、数组/删除/同名新增的冲突判定、补丁解析）。
- 合成场景：两个模组改同一单行文件的不同记录 → 叠加成功且格式规范、改动保持未暂存、锁文件正确；改同一项 → 精确报冲突、目录保持干净、不写锁文件。
- 真实模组：对两个真实补丁的 `data/assets.json` 做**合并契约**校验（18,059 个"仅单侧改动"的叶子全部一致），并确认新增干员与皮肤改动都在；两者一起装时精确定位到 3 个真正重叠的源码文件。

## 1.1.9 — 2026-10-12

新增「模组」页（把社区 fork 的客制化当作补丁应用，可勾选、可一键还原）与「本地客户端素材」设置。

### 新增

- **本地客户端素材（`docs/DEPLOY.md` 第 6 节）**：新增「客户端目录」与「部署 / 修复时自动提取」两项配置，以及 `检测客户端` / `重新提取素材` 两个动作。启动器据安装目录里有没有 `data/local-assets.json` 与配置状态，给上游 `tools/setup.mjs` 传对应的旗标（`launcher/lib/repo.mjs` 的 `localExtractArgs()`）：关闭提取 → `--no-local`；已提取 → `--yes`（只报告条目数，不重复提取）；未提取且指定了目录 → `--local --game <dir>`；未提取且未指定 → `--local`（交给 setup 自己探测）。主界面「部署状态」新增「本地客户端素材」一行（条目数、3D 棋盘是否可用）。
- **模组管理（`launcher/lib/mods.mjs`）**：从**本项目自己的中转仓库**（默认 `Starst796/Stronghold-Protocol-Mods`，可在「配置 → 下载与更新」修改，也支持直接指向 `index.json` 的 URL）读取目录，把选中的模组按 `order` 应用到游戏的安装目录：先把跟踪文件还原到干净的上游版本（`git checkout -- .`），再按类型施加 `patch`（`git apply` 一整个 `git format-patch` 序列）或 `overlay`（复制清单文件）。完成后把 id、版本与**模组新增的文件列表**写入 `.cache/mods.lock.json`。
- **「还原为原版」**：撤销跟踪文件的改动，并逐一删除锁文件里记录的模组新增文件（顺带清理变空的目录）；你自己添加的未跟踪文件不会被删。
- **modded 标记**：启动服务器时带上 `SP_MODS=<ids>`（`launcher/lib/game.mjs`），顶部徽章与侧栏显示已启用的模组数量，供服务器与模组识别。
- **界面**：新增「模组」导航页（卡片式勾选、目录元信息、当前安装状态）、顶部 modded 徽章、终端新增「模组」日志通道，以及 `POST /api/mods/{refresh,select,apply,restore}`（`launcher/lib/httpd.mjs`）。
- **目录版本管理**：中转仓库的 `index.json` 用 `catalogVersion` / `updatedAt` 标记目录内容版本；启动器记录上次见到的版本，拉取到新版本时在终端提示 `模组目录已更新：v1.0.0 → v1.1.0`，「模组」页显示目录版本与最近拉取时间。中转仓库的 `tools/add-mod.mjs` 在改动目录时会自动提升该版本。
- **补丁应用更稳（`launcher/lib/mods.mjs`）**：补丁先按原样 `git apply`；上下文漂移时自动改用**三方合并**（`--3way`）重试，能化解「上游只是挪动了周边代码」这一大类问题。仍失败则中止并**把安装目录清理干净**（复位工作区、删除本次新增的文件），不会留下冲突标记或半成品。
- **版本预检（`checkBase()`）**：模组目录固定上游提交（`baseCommit` ↔ `base`），启动器在应用前比对安装目录的 `HEAD`，不一致时在「模组」页提示，并在点「应用」时**先说明再确认**；未经确认默认拒绝——补丁只保证在该提交上可用，否则可能失败、甚至「打上了但语义是错的」。

### 变更

- **为什么需要中转仓库**：fork 的客制化改的是**游戏源码**，而上游的内容包（`docs/PACKS.md`）目前只加载 `lang`、`data` 类型仍在计划中，且明确**不加载第三方代码**；本项目也没有上游的合并权限。因此每个 fork 由中转仓库针对一个固定的上游版本打包一次，由启动器应用——代价是上游发新版后所有模组都要重打包（中转仓库 `tools/add-mod.mjs` 负责打包）。
- **更新与模组互斥**：检测到已应用模组时，「更新到最新版本」会拒绝并提示先「还原为原版」（或勾选「强制更新」丢弃模组，此时会自动清除锁文件），避免 `git merge --ff-only` 因工作区改动而失败得莫名其妙。
- **包类型**：`patch` / `overlay` 可应用；`profile`（整份 fork，例如莱茵扩展是自带启动器的独立发行版）只列示、不可应用。
- `launcher/lib/config.mjs`：新增 `MODS_REPO_URL`、配置项 `modsRepoUrl`、`enabledMods`、`clientDir`、`extractLocal`。
- `launcher/lib/events.mjs`：新增日志通道 `mods`。
- 需要安装目录是 git 检出且本机有 `git`；压缩包解压的安装会在页面上提示无法应用。
- README 补「本地客户端素材」「模组」两节与相关常见问题。

## 1.1.8 — 2026-10-11

素材下载跟随「下载源」，并在直连下不完时自动改用镜像重试。

### 修复

- **选了加速源，素材却仍走 GitHub 直连**：约 250 MB 的美术 / 音频由游戏自带的 `tools/fetch-assets.mjs` 下载，启动器此前只传 `--concurrency`，所以「下载源」即使选了 gh-proxy / ghfast / ghproxy.net / Gitee，素材照样从直连取——正是这些源想绕开的那条路。现在每个内置源都带一条素材路线（`launcher/lib/config.mjs` 的 `assetRouteOf()`）：`github` / `gitclone` → 直连；加速源 → `--asset-source=mirror` 并把该源的代理前缀用 `SP_GITHUB_PROXY` 一起传给工具；Gitee 源用工具的默认镜像前缀。「一键部署」「修复安装」「更新到最新版本」里的 `setup.mjs` 步骤同样带上这条路线，与「下载素材」保持一致。
- **直连下不完时自动改用镜像**：这类网络会表现为 `downloaded this run : 224.0 MB (ok 5125, missing 56, errors 167)`、spine `err=166`——跑 1655 秒仍缺 140 个文件，随后因为 23 个干员的 skel/atlas 没下到（整棵 Spine 子树消失）加索引过期的 32 条，触发清单缩小保护（共 2486 条），而工具自己提示的补救办法正是 `--asset-source=mirror`。现在素材同步在直连失败后会自动改用 `--asset-source=mirror` + `--refresh-index` 再试一次（镜像只按格式和大小校验，连续失败时工具内部仍会回退直连与 jsDelivr）；若「下载源」本身就是加速源，则不再多试一次，也不会在索引新鲜时触发重试。
- 修复过程中用过的补救会写进日志（`直连 GitHub 未能下完素材；改用 GitHub 镜像…`）和失败提示（`已刷新上游索引` / `已改用 GitHub 镜像`），不再是笼统的「网络问题？」。

### 变更

- `launcher/lib/config.mjs`：`SOURCES` 每项新增 `asset` 路线，导出 `assetRouteOf(cfg)`。
- `launcher/lib/repo.mjs`：`syncAssets()` 传 `--asset-source`（按需 `SP_GITHUB_PROXY`），新增镜像兜底，返回 `{ ok, code, refreshed, mirrored }`。
- `launcher/index.mjs`：`setupEnv()` 统一生成 `setup.mjs` 步骤的环境（`SP_LAUNCHER` + `SP_ASSET_SOURCE` + 按需 `SP_GITHUB_PROXY`）。
- README「下载源」补上遗漏的 `gitee-starst796`，并说明素材下载如何跟随所选源。

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
