#!/usr/bin/env bash
# 微信视频下载机器人管理脚本
# 用法: ./bot.sh {start|stop|restart|status|log}
# 配置统一在 bot.config.json（token/downloadDir/maxTasks/allowedUsers/proxy，见 bot.config.example.json）

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT="$DIR/bot.mjs"
LOG_DIR="$DIR/logs"
LOG_FILE="$LOG_DIR/bot-$(TZ=Asia/Shanghai date +%F).log"
PID_FILE="$DIR/bot.pid"
CONFIG="$DIR/bot.config.json"

start() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "已在运行 (PID $(cat "$PID_FILE"))"
    return 0
  fi
  if [ ! -f "$CONFIG" ] || ! grep -q '"token"' "$CONFIG" 2>/dev/null; then
    echo "错误: $CONFIG 里未配置 token"
    echo "  参考: cp bot.config.example.json bot.config.json 并填入你的 token"
    exit 1
  fi
  mkdir -p "$LOG_DIR"
  # bot 内部按天写日志文件（logs/bot-YYYY-MM-DD.log），stdout 仅保留启动错误
  nohup "$NODE_BIN" "$BOT" > "$LOG_DIR/bot.out" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 1
  echo "已启动 (PID $(cat "$PID_FILE"))  日志: $LOG_FILE"
}

stop() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    kill "$(cat "$PID_FILE")" && rm -f "$PID_FILE" && echo "已停止"
  else
    rm -f "$PID_FILE"
    pkill -f "bot\.mjs" 2>/dev/null && echo "已停止" || echo "未在运行"
  fi
}

restart() { stop; sleep 1; start; }

status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "运行中 (PID $(cat "$PID_FILE"))"
    [ -f "$LOG_FILE" ] && tail -3 "$LOG_FILE"
  else
    echo "未运行"
  fi
}

log() {
  local f="$LOG_DIR/bot-$(TZ=Asia/Shanghai date +%F).log"
  if [ ! -f "$f" ]; then
    echo "今天暂无日志: $f"
    return 1
  fi
  tail -f "$f"
}

# ---------- 开机自启 ----------
# 说明: 用户 home 位于外置卷（外置卷），launchd 只从启动卷加载 LaunchAgent，
#       因此用 crontab @reboot 实现（登录后自动启动，无需 sudo）。
NODE_BIN="$(command -v node 2>/dev/null)"
if [ -z "$NODE_BIN" ]; then   # cron 环境 PATH 精简，探测常见安装位置
  for p in "$HOME/.local/share/fnm/node-versions"/*/installation/bin/node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$p" ] && { NODE_BIN="$p"; break; }
  done
fi
CRON_LINE="@reboot ${DIR}/bot.sh start"

autostart_on() {
  if [ -z "$NODE_BIN" ]; then
    echo "错误: 找不到 node"
    exit 1
  fi
  local tmp; tmp="$(mktemp)"
  crontab -l 2>/dev/null > "$tmp" || true
  if grep -qF "$CRON_LINE" "$tmp"; then
    echo "开机自启已存在，无需重复添加"
  else
    echo "$CRON_LINE" >> "$tmp"
    crontab "$tmp"
    echo "✅ 开机自启已启用（登录后自动启动机器人）"
  fi
  rm -f "$tmp"
}

autostart_off() {
  local tmp; tmp="$(mktemp)"
  crontab -l 2>/dev/null | grep -vF "$CRON_LINE" > "$tmp" || true
  crontab "$tmp"
  rm -f "$tmp"
  echo "✅ 开机自启已关闭"
}

autostart_status() {
  if crontab -l 2>/dev/null | grep -qF "$CRON_LINE"; then
    echo "已启用（crontab @reboot → ./bot.sh start）"
    crontab -l | grep -F "$CRON_LINE"
  else
    echo "未启用"
  fi
}

case "$1" in
  start)   start ;;
  stop)    stop ;;
  restart) restart ;;
  status)  status ;;
  log|logs) log ;;
  autostart)
    case "$2" in
      on) autostart_on ;;
      off) autostart_off ;;
      status) autostart_status ;;
      *) echo "用法: ./bot.sh autostart {on|off|status}" ; exit 1 ;;
    esac
    ;;
  *) echo "用法: ./bot.sh {start|stop|restart|status|log|autostart}" ; exit 1 ;;
esac
