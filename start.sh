#!/usr/bin/env bash
#  卫戍协议：盟约 · 服务器启动器 —— macOS / Linux 入口
#
#  ./start.sh           启动启动器（浏览器会打开控制面板）
#  ./start.sh --no-open 不自动打开浏览器
#
#  若没有安装 Node.js 22+，本脚本会自动使用 runtime/ 里自带的运行时（解压即用，无需管理员），
#  找不到时再从官网下载。可用环境变量覆盖：
#    SP_NODE_VERSION=v24.21.0
#    SP_NODE_MIRROR=https://nodejs.org/dist     （国内可用 https://npmmirror.com/mirrors/node）
#    SP_NODE_DRY_RUN=1                          只检测不安装

set -u
cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
RUNTIME="$ROOT/runtime"
PORTABLE="$RUNTIME/node"
PORTABLE_NODE="$PORTABLE/bin/node"
NODE_MIN=22
NODE_VERSION="${SP_NODE_VERSION:-v24.21.0}"
NODE_MIRROR="${SP_NODE_MIRROR:-https://nodejs.org/dist}"
OS_NAME="$(uname -s)"

say() { printf '%s\n' "$*"; }

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64' ;;
    arm64|aarch64) printf 'arm64' ;;
    armv7l|armv7) printf 'armv7l' ;;
    *) printf '' ;;
  esac
}

node_major() {
  v="$("$1" -p 'process.versions.node' 2>/dev/null)" || return 1
  printf '%s' "${v%%.*}"
}

is_node_ok() {
  exe="${1:-}"
  [ -n "$exe" ] || return 1
  [ -x "$exe" ] || return 1
  m="$(node_major "$exe")" || return 1
  case "$m" in ''|*[!0-9]*) return 1 ;; esac
  [ "$m" -ge "$NODE_MIN" ]
}

# Echo the node to use, or nothing.
find_node() {
  if [ -f "$PORTABLE_NODE" ]; then
    # 从 exFAT / 网络盘 / Windows 解压时可能丢失执行权限，先尝试就地修复。
    [ -x "$PORTABLE_NODE" ] || chmod +x "$PORTABLE_NODE" 2>/dev/null || true
    # 直接跑一次比看执行位可靠（-x 在某些文件系统/模拟环境下不准）。
    if is_node_ok "$PORTABLE_NODE"; then
      printf '%s' "$PORTABLE_NODE"
      return 0
    fi
    # 注意：这里必须写 stderr —— find_node 的输出会被 $( ) 捕获。
    printf '  [提示] %s 无法执行或版本低于 %s，将重新准备便携运行时。\n' "$PORTABLE_NODE" "$NODE_MIN" >&2
  fi
  sys="$(command -v node 2>/dev/null || true)"
  if [ -n "$sys" ] && is_node_ok "$sys"; then printf '%s' "$sys"; return 0; fi
  return 1
}

# 便携运行时整体补一次执行权限（zip/exFAT/U 盘等场景）。
heal_portable_perms() {
  [ -d "$PORTABLE" ] || return 0
  chmod -R u+x "$PORTABLE/bin" 2>/dev/null || true
  return 0
}

first_match() {
  # shellcheck disable=SC2086
  for f in $1; do
    [ -e "$f" ] || continue
    printf '%s' "$f"
    return 0
  done
  return 1
}

extract_portable() {
  src="$1"
  arch="$(detect_arch)"
  if [ -z "$arch" ]; then
    say "  [错误] 无法识别的 CPU 架构：$(uname -m)。请手动安装 Node.js。"
    return 1
  fi
  tmp="$RUNTIME/_extract.$$"
  rm -rf "$tmp"
  mkdir -p "$tmp" || return 1
  say "  正在解压到 runtime/node …（无需管理员权限）"

  # 层层回退：先让 tar 按扩展名解压，再让它自动识别，最后用 Python 自带的
  # tarfile（内置 lzma/gzip 支持）—— 有些精简系统里 tar 需要外部的 xz/gzip 命令。
  unpacked=0
  case "$src" in
    *.tar.xz)  tar -xJf "$src" -C "$tmp" 2>/dev/null && unpacked=1 ;;
    *.tar.gz|*.tgz) tar -xzf "$src" -C "$tmp" 2>/dev/null && unpacked=1 ;;
  esac
  [ "$unpacked" = "1" ] || { tar -xf "$src" -C "$tmp" 2>/dev/null && unpacked=1; }
  if [ "$unpacked" != "1" ]; then
    py=""
    for c in python3 python; do
      if command -v "$c" >/dev/null 2>&1; then py="$c"; break; fi
    done
    if [ -n "$py" ]; then
      say "  tar 无法直接解压，改用 $py（内置 xz/gzip 支持）…"
      if "$py" -c 'import sys, tarfile; tarfile.open(sys.argv[1]).extractall(sys.argv[2])' "$src" "$tmp" 2>/dev/null; then
        unpacked=1
      fi
    fi
  fi
  if [ "$unpacked" != "1" ]; then
    say "  [错误] 解压失败：$src"
    say "         需要 tar（带 xz 支持）或 python3 之一。"
    rm -rf "$tmp"
    return 1
  fi

  inner="$(find "$tmp" -maxdepth 1 -mindepth 1 -type d | head -n 1)"
  if [ -z "$inner" ]; then
    say "  [错误] 压缩包结构异常。"
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$PORTABLE"
  mv "$inner" "$PORTABLE" || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
  heal_portable_perms
  return 0
}

download_artifact() {
  arch="$(detect_arch)"
  [ -n "$arch" ] || return 1
  case "$OS_NAME" in
    Darwin) name="node-$NODE_VERSION-darwin-$arch.tar.gz" ;;
    Linux) name="node-$NODE_VERSION-linux-$arch.tar.xz" ;;
    *) return 1 ;;
  esac
  url="$NODE_MIRROR/$NODE_VERSION/$name"
  out="$RUNTIME/.download-$name"
  say "  正在下载 $url"
  say "  （较慢时可设置 SP_NODE_MIRROR，例如国内镜像 https://npmmirror.com/mirrors/node）"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --retry-delay 2 -o "$out" "$url" || { rm -f "$out"; return 1; }
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$out" "$url" || { rm -f "$out"; return 1; }
  else
    say "  [错误] 系统里没有 curl 或 wget，无法自动下载。"
    return 1
  fi
  extract_portable "$out"
  rc=$?
  rm -f "$out"
  return $rc
}

bootstrap() {
  arch="$(detect_arch)"
  say ""
  say "  正在准备 Node.js ${NODE_VERSION}（自己解压，不需要管理员权限）…"

  case "$OS_NAME" in
    Darwin)
      art="$(first_match "$RUNTIME/node-*-darwin-$arch.tar.gz $RUNTIME/node-*-darwin-$arch.tgz" || true)"
      if [ -n "$art" ]; then
        say "  找到整合包内的运行时：$(basename "$art")"
        extract_portable "$art" && return 0
      fi
      pkg="$(first_match "$RUNTIME/node-*.pkg" || true)"
      if [ -n "$pkg" ]; then
        say "  找到官方安装程序：$(basename "$pkg")"
        say "  正在打开安装程序，请按提示完成安装…"
        open -W "$pkg" && return 0
      fi
      download_artifact
      return $?
      ;;
    Linux)
      art="$(first_match "$RUNTIME/node-*-linux-$arch.tar.xz $RUNTIME/node-*-linux-$arch.tar.gz" || true)"
      if [ -n "$art" ]; then
        say "  找到整合包内的运行时：$(basename "$art")"
        extract_portable "$art" && return 0
      fi
      download_artifact
      return $?
      ;;
    *)
      say "  [错误] 不支持的系统：$OS_NAME。请手动安装 Node.js。"
      return 1
      ;;
  esac
}

list_candidates() {
  say "  [dry-run] runtime 目录内容："
  if [ -d "$RUNTIME" ]; then
    for f in "$RUNTIME"/node-*; do
      [ -e "$f" ] || continue
      say "    - $(basename "$f")"
    done
  else
    say "    （没有 runtime 目录）"
  fi
}

# ------------------------------------------------------------------ main
heal_portable_perms
NODE="$(find_node || true)"
if [ -z "$NODE" ]; then
  say ""
  say "  =================================================================="
  say "    未检测到 Node.js ${NODE_MIN} 或更高版本（游戏和启动器都需要它）。"
  say "  =================================================================="
  if [ "${SP_NODE_DRY_RUN:-}" = "1" ]; then
    list_candidates
    say "  [dry-run] 只检测，不执行安装。"
    exit 1
  fi
  bootstrap
  NODE="$(find_node || true)"
fi

if [ -z "$NODE" ]; then
  say ""
  say "  [错误] 未能自动准备好 Node.js。请手动安装 22 或更高版本（22 / 24 LTS）后重试："
  say "    https://nodejs.org/zh-cn/download"
  say "    macOS:  brew install node@22"
  say "    Linux:  见发行版文档，或从 https://nodejs.org/zh-cn/download 下载官方 tar.xz 解压"
  exit 1
fi

say "  使用 Node：$NODE"
exec "$NODE" "$ROOT/launcher/index.mjs" "$@"
