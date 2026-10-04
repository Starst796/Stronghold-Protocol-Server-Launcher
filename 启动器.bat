@echo off
chcp 65001 >nul
rem  卫戍协议：盟约 · 服务器启动器 —— Windows 入口
rem  双击本文件即可运行。若没装 Node.js，会优先使用 runtime\ 里自带的安装包，
rem  找不到时自动从官网下载再安装，装好后继续启动。
setlocal EnableDelayedExpansion
cd /d "%~dp0"
set "ROOT=%~dp0"
set "NODE_MIN=22"
if not defined SP_NODE_VERSION set "SP_NODE_VERSION=v24.21.0"
if not defined SP_NODE_MIRROR  set "SP_NODE_MIRROR=https://nodejs.org/dist"

set "NODE_EXE="
call :find_node
if defined NODE_EXE goto :run

echo.
echo   ==================================================================
echo     未检测到 Node.js %NODE_MIN% 或更高版本（游戏和启动器都需要它）。
echo   ==================================================================
call :bootstrap
if "%SP_NODE_DRY_RUN%"=="1" goto :dry_end
if errorlevel 1 goto :fail
call :find_node
if not defined NODE_EXE goto :fail

:run
echo   使用 Node：!NODE_EXE!
"!NODE_EXE!" "%ROOT%launcher\index.mjs" %*
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo   启动器已退出（代码 %EXITCODE%）。按任意键关闭窗口。
  pause >nul
)
exit /b %EXITCODE%

rem ------------------------------------------------------------------ 查找可用的 node
:find_node
rem 1) 整合包自带的便携运行时（runtime\node\node.exe）
if exist "%ROOT%runtime\node\node.exe" (
  set "NODE_EXE=%ROOT%runtime\node\node.exe"
  exit /b 0
)
rem 2) 常见安装位置
for %%D in (
  "%ProgramFiles%\nodejs\node.exe"
  "%ProgramFiles(x86)%\nodejs\node.exe"
  "%LOCALAPPDATA%\Programs\nodejs\node.exe"
) do if not defined NODE_EXE if exist %%D set "NODE_EXE=%%~fD"
rem 3) PATH
if not defined NODE_EXE for /f "usebackq delims=" %%P in (`where node 2^>nul`) do if not defined NODE_EXE set "NODE_EXE=%%P"
rem 4) 版本必须 >= NODE_MIN
if defined NODE_EXE call :check_version "!NODE_EXE!"
exit /b 0

:check_version
set "MAJOR="
for /f "usebackq tokens=1 delims=." %%V in (`"%~1" -p process.versions.node 2^>nul`) do set "MAJOR=%%V"
if not defined MAJOR (
  set "NODE_EXE="
  exit /b 0
)
if !MAJOR! LSS %NODE_MIN% (
  echo   ! 检测到 Node.js v!MAJOR!.x，版本过低（需要 v%NODE_MIN%+）：%~1
  set "NODE_EXE="
)
exit /b 0

rem ------------------------------------------------------------------ 引导安装
:bootstrap
rem A) 整合包内的 Windows 便携运行时（zip，免管理员）
set "ZIP="
for %%F in ("%ROOT%runtime\node-*-win-x64.zip" "%ROOT%runtime\node-win-x64.zip") do if not defined ZIP if exist %%F set "ZIP=%%~fF"
if defined ZIP (
  echo   找到整合包内的便携运行时：!ZIP!
  if "%SP_NODE_DRY_RUN%"=="1" exit /b 0
  echo   正在解压到 runtime\node …（无需管理员权限）
  call :unzip_win "!ZIP!"
  if errorlevel 1 (
    echo   [错误] 解压失败。
    exit /b 1
  )
  echo   完成。
  exit /b 0
)

rem B) 整合包内的官方安装程序（msi）
set "MSI="
for %%F in ("%ROOT%runtime\node-*-x64.msi" "%ROOT%runtime\node-x64.msi") do if not defined MSI if exist %%F set "MSI=%%~fF"
if defined MSI (
  echo   找到整合包内的安装程序：!MSI!
  if "%SP_NODE_DRY_RUN%"=="1" exit /b 0
  echo   正在打开安装程序，请在窗口里按提示完成安装（会请求管理员权限）…
  start /wait "" msiexec /i "!MSI!"
  echo   安装程序已结束，继续检测 Node.js…
  exit /b 0
)

rem C) 联网下载官方安装程序
echo   整合包内没有安装程序，将从官网下载：%SP_NODE_MIRROR%/%SP_NODE_VERSION%
echo   （下载慢或失败时，可设置环境变量 SP_NODE_MIRROR 指向国内镜像）…
if "%SP_NODE_DRY_RUN%"=="1" exit /b 0
set "DL_MSI=%TEMP%\node-%SP_NODE_VERSION%-x64.msi"
if exist "%DL_MSI%" del /q "%DL_MSI%" >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -Uri '%SP_NODE_MIRROR%/%SP_NODE_VERSION%/node-%SP_NODE_VERSION%-x64.msi' -OutFile '%DL_MSI%' -UseBasicParsing } catch { Write-Host ('下载失败：' + $_.Exception.Message); exit 1 }"
if errorlevel 1 (
  echo   [错误] 下载失败。请检查网络或手动安装：https://nodejs.org/zh-cn/download
  exit /b 1
)
echo   下载完成，正在打开安装程序…
start /wait "" msiexec /i "%DL_MSI%"
exit /b 0

:dry_end
echo.
echo   [dry-run] 以上只是检测结果，没有真的安装。去掉 SP_NODE_DRY_RUN 即可自动安装。
exit /b 1

:unzip_win
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $zip='%~1'; $dest='%ROOT%runtime'; $tmp=Join-Path $dest '_unzip'; if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }; Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force; $d=Get-ChildItem $tmp -Directory | Select-Object -First 1; if (-not $d) { throw '压缩包结构异常' }; if (Test-Path (Join-Path $dest 'node')) { Remove-Item (Join-Path $dest 'node') -Recurse -Force }; Move-Item $d.FullName (Join-Path $dest 'node'); Remove-Item $tmp -Recurse -Force"
exit /b %ERRORLEVEL%

:fail
echo.
echo   [错误] 未能自动安装 Node.js。请手动安装 22 或更高版本（22 / 24 LTS）后重试：
echo     https://nodejs.org/zh-cn/download
echo     winget install OpenJS.NodeJS.LTS
echo.
if not "%SP_NODE_DRY_RUN%"=="1" pause
exit /b 1
