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
  nohup node "$BOT" > "$LOG_DIR/bot.out" 2>&1 &
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

case "$1" in
  start)   start ;;
  stop)    stop ;;
  restart) restart ;;
  status)  status ;;
  log|logs) log ;;
  *) echo "用法: ./bot.sh {start|stop|restart|status|log}" ; exit 1 ;;
esac
