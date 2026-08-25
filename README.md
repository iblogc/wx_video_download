# 微信视频号下载机器人

Telegram 机器人 + 命令行工具，输入微信视频号分享链接即可下载视频。机器人部署在本机，通过 Telegram 使用，视频按短码缓存存储在本机 `~/Downloads/wx-videos`。

## 功能

- **Telegram 机器人**：私聊发链接直接下载；群聊自动识别微信视频号链接（无需 @），非微信链接静默忽略
- **回复式交互**：视频与进度消息回复到用户发的那条消息，一一对应；群聊还会 @ 原消息发送人触发提醒
- **视频标题**：视频消息显示标题，群聊时为「标题 + @发送人」
- **原文件按钮**：视频下方「获取原文件 x.x MB」按钮，点击发送未压缩原始文件（真实文件名）
- **离线补处理**：服务停机期间发的链接，启动后自动补处理，延迟处理的视频标题标注「（补发）」
- **多链接**：一条消息可包含多个链接，逐个下载；重复链接自动去重
- **视频缓存**：同一视频（按短码识别）只下载一次；同名文件先校验大小，一致直接复用
- **并发处理**：多任务并发执行（`maxTasks` 可配），达到上限回复排队位置；同一视频并发去重
- **进度消息**：解析/下载状态原地更新同一条消息，视频发出后才删除，不留中间消息
- **白名单**：可选限制使用人（配置文件动态生效，无需重启）
- **命令行工具**：`wxdl.mjs` 支持同样的解析下载

## 目录结构

```
wx-video/
├── bot.mjs            # Telegram 机器人主程序
├── lib.mjs            # 解析/下载核心（链接解析、签名、CDN 下载、XOR 还原）
├── wxdl.mjs           # 命令行下载工具
├── bot.sh             # 管理脚本（启动/停止/重启/状态/日志/开机自启）
├── bot.config.json    # 配置（token/目录/并发/白名单/代理，不入库）
├── bot.config.example.json  # 配置模板
├── logs/              # 按天日志（bot-YYYY-MM-DD.log）
└── test/              # mock Telegram 端到端测试（完全离线）
```

## 快速开始

1. **获取 token**：Telegram 里找 [@BotFather](https://t.me/BotFather) → `/newbot` → 按提示创建，拿到 token
2. **配置**：复制模板并填入 token：
   ```bash
   cd wx-video
   cp bot.config.example.json bot.config.json   # 编辑填入你的 token
   ```
3. **启动**：
   ```bash
   ./bot.sh start      # 启动
   ./bot.sh status     # 查看状态
   ./bot.sh log        # 实时查看当天日志（Ctrl+C 退出）
   ./bot.sh restart    # 重启
   ./bot.sh stop       # 停止
   ./bot.sh autostart on   # 只注册开机自启（不启动服务）
   ```

## 开机自启

```bash
./bot.sh autostart on     # 注册开机自启（登录时 launchd 自动启动）
./bot.sh autostart off    # 移除自启（运行中的服务不受影响）
./bot.sh autostart status # 查看自启状态
```

**启动服务和开机自启是两件事**：`autostart on` 只注册（下次登录自动启动），需要现在运行请单独 `./bot.sh start`。

> 实现说明：通过系统级 LaunchAgent（`/Library/LaunchAgents/com.wxvideo.bot.plist`，首次需一次 sudo 密码）。本机 home 位于外置卷 `外置卷`，用户级 LaunchAgent 无法加载（launchd 限制），crontab `@reboot` 在 macOS 用户级不可靠（已验证），因此采用系统级 LaunchAgent：登录即启动 + 崩溃自动重启。

> 网络要求：Telegram API 走代理（配置文件 `proxy` 字段优先，缺省读 `http_proxy`/`https_proxy` 环境变量），视频下载走直连。

## 配置（bot.config.json）

所有配置集中在 `bot.config.json`（含 token，已加入 .gitignore 不入库）：

```json
{
  "token": "123456:ABC-DEF...",          // @BotFather 获取（必填）
  "downloadDir": "~/Downloads/wx-videos", // 视频存储目录
  "maxTasks": 5,                          // 同时处理的任务数上限
  "allowedUsers": [],                     // 白名单（空 = 所有人可用）
  "proxy": { "host": "127.0.0.1", "port": 1080 }   // 代理（可删，删后读环境变量）
}
```

- `allowedUsers` 修改**即时生效**，无需重启；其余字段重启生效
- 白名单示例：`"allowedUsers": [123456789, 987654321]`

## 使用方式

**私聊**：直接发送微信视频号分享链接（或 `channels.weixin.qq.com` 链接、纯短码）。一条消息可包含多个链接，逐个下载。

**群聊**：发链接即自动下载（无需 @），非微信链接不会触发。

**流程**：
```
你: https://weixin.qq.com/sph/XXXX
Bot:  🔄 正在解析...          （回复到你的消息，原地更新）
Bot:  ⬇️ 正在下载（8.3 MB）...
Bot:  [视频] 只爱我一个不好吗？  ← 回复到你的消息，带标题
      └─ 📥 获取原文件 8.3 MB  （点击发送未压缩原文件）
```

**离线补处理**：服务未运行时你发的链接会暂存在 Telegram 服务器（最多 24 小时），服务启动后自动补下载，延迟处理的视频标题带「（补发）」标注。

限制：单视频 ≤ 50MB（Telegram 上传上限），超限的会提示并保留在本机。

## 日志

日志按天持久化在 `logs/bot-YYYY-MM-DD.log`（东八区日期）。每条日志带发送人/群信息 + 耗时：

```
[老同学群(-100123456789)][小明(@xiaoming, 123456789)] [补发] 收到群聊链接 2 条: A9TdAV4DFB, ...
[老同学群(-100123456789)][小明(@xiaoming, 123456789)] 任务进入池: 立即执行（活跃 1/5）
[老同学群(-100123456789)][小明(@xiaoming, 123456789)] 解析成功: 只爱我一个不好吗？ | 8.3 MB | 120ms
[老同学群(-100123456789)][小明(@xiaoming, 123456789)] 下载完成: ... | 4210ms
[老同学群(-100123456789)][小明(@xiaoming, 123456789)] 发送成功: ... | 上传 2100ms
```

格式：`[群名或聊天类型(chatId)][昵称(@username, userId)]` + 事件（进池/解析/下载/发送/原文件按钮/拒绝/失败）。

## 测试

全部测试使用 mock Telegram + 假网络，完全离线、不触碰生产数据目录，约 8 秒：

```bash
cd wx-video/test
node test_bot.mjs     # 主流程（下载/发送/原文件按钮/进度清理/回复）
node test_bot2.mjs    # 群聊识别 + 白名单 + 群聊@发送人
node test_bot3.mjs    # 缓存与并发去重
node test_bot4.mjs    # 任务池排队 + 多消息 + 同名文件复用
node test_bot5.mjs    # 离线补处理（补发标注）+ 多链接 + 去重
```

## 工作原理

1. 微信分享链接 `weixin.qq.com/sph/XXX` 重定向到官方预览页，但预览 API 对匿名用户不返回视频直链
2. 复用 miuistore.com 的解析服务：其签名 SDK（内嵌于 `lib.mjs`）生成签名，换取腾讯 CDN 直链（`finder.video.qq.com`）
3. CDN 流开头 N 字节被 XOR 混淆，密钥随响应下发，逐字节异或还原后即完整 MP4

依赖第三方解析服务（当前免费匿名可用）；若对方调整策略，机器人会明确报错。仅供学习研究，请尊重视频创作者版权。
