#!/bin/bash
#  卫戍协议：盟约 · 服务器启动器 —— macOS 双击入口
#
#  在「访达」里双击本文件即可。若提示「无法打开，因为它来自身份不明的开发者」，
#  请右键 →「打开」→「打开」；或在该文件夹里执行：bash start.sh
cd "$(dirname "$0")" || exit 1

chmod +x ./start.sh 2>/dev/null || true

# 出错时不要立刻关窗口，让用户能看到错误信息。
# 显式用 bash 执行，避免 start.sh 在 exFAT / 网络盘上丢掉执行位后无法直接运行。
bash ./start.sh "$@"
code=$?
if [ "$code" -ne 0 ]; then
  echo
  echo "  启动器已退出（代码 $code）。按回车键关闭窗口。"
  read -r _
fi
exit "$code"
