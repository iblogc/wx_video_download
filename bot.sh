#!/usr/bin/env bash
# 微信视频下载机器人管理脚本
# 用法: ./bot.sh {start|stop|restart|status|log|backfill}
# 配置统一在 bot.config.json（token/downloadDir/maxTasks/allowedUsers/proxy，见 bot.config.example.json）

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT="$DIR/bot.mjs"
LOG_DIR="$DIR/logs"
LOG_FILE="$LOG_DIR/bot-$(TZ=Asia/Shanghai date +%F).log"
PID_FILE="$DIR/bot.pid"
CONFIG="$DIR/bot.config.json"

agent_installed() { [ -f "$PLIST" ]; }

start() {
  if [ ! -f "$CONFIG" ] || ! grep -q '"token"' "$CONFIG" 2>/dev/null; then
    echo "错误: $CONFIG 里未配置 token"
    echo "  参考: cp bot.config.example.json bot.config.json 并填入你的 token"
    exit 1
  fi
  mkdir -p "$LOG_DIR"
  # bot 内部按天写日志文件（logs/bot-YYYY-MM-DD.log），stdout 仅保留启动错误
  if agent_installed; then
    # LaunchAgent 模式：交给 launchd 管理（登录自启 + 崩溃自愈）
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    launchctl kickstart -k "gui/$(id -u)/$LABEL"
    sleep 1
    echo "已通过 launchd 启动 (label: $LABEL)"
    return 0
  fi
  nohup "$NODE_BIN" "$BOT" > "$LOG_DIR/bot.out" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 1
  echo "已启动 (PID $(cat "$PID_FILE"))  日志: $LOG_FILE"
}

stop() {
  if agent_installed && launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)/$LABEL"
    rm -f "$PID_FILE"
    echo "已停止（launchd 卸载）"
    return 0
  fi
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    kill "$(cat "$PID_FILE")" && rm -f "$PID_FILE" && echo "已停止"
  else
    rm -f "$PID_FILE"
    pkill -f "bot\.mjs" 2>/dev/null && echo "已停止" || echo "未在运行"
  fi
}

restart() { stop; sleep 1; start; }

status() {
  if agent_installed && launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    echo "运行中 (launchd 管理)"
    [ -f "$LOG_FILE" ] && tail -3 "$LOG_FILE"
  elif [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
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
# 环境结论（实测）:
#   - macOS 用户级 crontab @reboot 不可靠（cron 登录时才启动，开机无会话时跳过）
#   - home 位于外置卷 外置卷，用户级 LaunchAgent 无法加载（launchctl I/O error）
#   - macOS 新版 AppleScript 登录项对脚本/.app 静默失败或卡授权
# 因此采用系统级 LaunchAgent（/Library/LaunchAgents，启动卷 ✓，需要一次 sudo 密码）：
#   登录即启动 + KeepAlive 崩溃自动重启，最可靠。
NODE_BIN="$(command -v node 2>/dev/null)"
if [ -z "$NODE_BIN" ]; then
  for p in "$HOME/.local/share/fnm/node-versions"/*/installation/bin/node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$p" ] && { NODE_BIN="$p"; break; }
  done
fi
CRON_LINE="@reboot ${DIR}/bot.sh start"
PLIST="/Library/LaunchAgents/com.wxvideo.bot.plist"
LABEL="com.wxvideo.bot"

autostart_on() {
  if [ -z "$NODE_BIN" ]; then
    echo "错误: 找不到 node"
    exit 1
  fi
  # 清理旧的 crontab 方式
  local tmp; tmp="$(mktemp)"
  crontab -l 2>/dev/null | grep -vF "$CRON_LINE" > "$tmp" || true
  crontab "$tmp" 2>/dev/null || true
  rm -f "$tmp"
  # 生成 plist
  cat > /tmp/com.wxvideo.bot.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${BOT}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/bot.out</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/bot.out</string>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
EOF
  # 需要 sudo（会提示输入密码）：只写入 plist 完成"开机自启注册"，
  # 不 bootstrap/load——启动服务是 ./bot.sh start 的事（两件事分开）
  sudo cp /tmp/com.wxvideo.bot.plist "$PLIST" || { echo "❌ 写入 $PLIST 失败（sudo 取消？）"; exit 1; }
  rm -f /tmp/com.wxvideo.bot.plist
  echo "✅ 开机自启已配置（下次登录时 launchd 自动启动机器人）"
  echo "   现在启动请执行: ./bot.sh start"
}

autostart_off() {
  # 清理历史登录项残留（早期"登录项自启"方案把 bot.mjs/bot.sh 加进了登录项，
  # 导致每次登录被默认应用（编辑器）打开）
  osascript -e 'tell application "System Events" to delete login item "bot.sh"' 2>/dev/null || true
  osascript -e 'tell application "System Events" to delete login item "bot.mjs"' 2>/dev/null || true
  # 只移除开机自启注册，不停止正在运行的服务（停止用 ./bot.sh stop）
  launchctl bootout "gui/$(id -u)/com.wxvideo.bot" 2>/dev/null || true
  sudo rm -f "$PLIST" 2>/dev/null || true
  echo "✅ 开机自启已关闭（运行中的服务不受影响，如需停止: ./bot.sh stop）"
}

autostart_status() {
  if [ ! -f "$PLIST" ]; then
    echo "未启用（无 ${PLIST}）"
    return 0
  fi
  if launchctl list | grep -q "$LABEL"; then
    echo "已启用，launchd 管理运行中"
  else
    echo "已配置但未加载（可能需重新登录或 launchctl load）"
  fi
}

case "$1" in
  start)   start ;;
  stop)    stop ;;
  restart) restart ;;
  status)  status ;;
  log|logs) log ;;
  backfill)
    # 补发历史视频到频道（可与运行中的机器人同时进行）：
    #   ./bot.sh backfill --dry-run          只列清单，不发送
    #   ./bot.sh backfill --limit 30         本批发 30 条（从最早的开始）
    shift
    exec "$NODE_BIN" "$BOT" --backfill "$@"
    ;;
  autostart)
    case "$2" in
      on) autostart_on ;;
      off) autostart_off ;;
      status) autostart_status ;;
      *) echo "用法: ./bot.sh autostart {on|off|status}" ; exit 1 ;;
    esac
    ;;
  *) echo "用法: ./bot.sh {start|stop|restart|status|log|backfill|autostart}" ; exit 1 ;;
esac
