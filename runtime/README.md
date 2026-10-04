# runtime/ —— 随整合包附带的 Node.js 运行时

启动器**本身也是 Node.js 程序**，所以在没有安装 Node.js 的电脑上，由 `启动器.bat` / `start.sh`
读取本目录、自动装好 Node 之后再启动界面。**普通用户不需要手动操作这个目录。**

## 目录里放了什么

| 文件 | 平台 | 使用方式 |
| --- | --- | --- |
| `node-v24.21.0-x64.msi` | Windows x64 | 官方安装程序，自动用 `msiexec` 打开（会请求管理员权限） |
| `node-v24.21.0-darwin-arm64.tar.gz` | macOS Apple Silicon | 官方**便携版**，解压到 `runtime/node/`，无需管理员权限 |
| `node-v24.21.0-darwin-x64.tar.gz` | macOS Intel | 同上 |
| `node-v24.21.0-linux-x64.tar.xz` | Linux x64 | 同上 |

> 为什么 macOS 用 tar.gz 而不是 `.pkg`？官方的 `.pkg` 只有 Intel 版本（约 89 MB），
> Apple Silicon 根本没有 `.pkg`；而便携版体积更小、两种架构都覆盖、且**不需要管理员密码**。
> 如果你更希望用 `.pkg`，把任意 `node-*.pkg` 放进本目录即可 —— macOS 上会优先用便携版，
> 没有便携版时才会打开 `.pkg`。

## 自动获取 / 手动补充

启动脚本按这个顺序找 Node.js：

1. 本目录已解压好的 `runtime/node/bin/node`（或 Windows 的 `runtime\node\node.exe`）
2. 系统里已安装且版本 ≥ 22 的 `node`
3. 本目录里的便携版压缩包 → 自动解压
4. 本目录里的 `.msi` / `.pkg` → 自动打开安装程序
5. 都没有 → 从 nodejs.org 下载（也可用镜像）

所以**删掉某个平台的包不会导致失败**，只是那一平台第一次运行需要联网下载。

## 更新到新的 Node 版本

```bash
# macOS / Linux
SP_NODE_VERSION=v24.21.0 \
  curl -fL -o runtime/node-v24.21.0-darwin-arm64.tar.gz \
  https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz
```

```powershell
# Windows PowerShell
curl.exe -L --fail -o runtime\node-v24.21.0-x64.msi `
  https://nodejs.org/dist/v24.21.0/node-v24.21.0-x64.msi
```

启动脚本对版本号只做「≥ 22」的检查，文件名里的版本可以随意；包名请保持
`node-*-<平台>-<架构>.tar.gz` / `node-*-x64.msi` 的形式，脚本按通配符查找。

## 相关环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SP_NODE_VERSION` | `v24.21.0` | 需要联网下载时使用的版本 |
| `SP_NODE_MIRROR` | `https://nodejs.org/dist` | 下载镜像（国内可用 `https://npmmirror.com/mirrors/node`） |
| `SP_NODE_DRY_RUN` | 空 | 设为 `1` 时只检测、只打印会做什么，不执行安装（排查用） |

## 版权

本目录里的文件是 Node.js 官方发行包，版权归 [Node.js 项目](https://nodejs.org/) 及其贡献者所有，
以 MIT 许可证分发。它们不属于本项目，只是为了让用户免去自己安装 Node 的步骤。
