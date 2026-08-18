# 微信视频号下载机器人

Telegram 机器人 + 命令行工具，输入微信视频号分享链接即可下载视频。机器人部署在本机，通过 Telegram 使用，视频按缓存复用存储在本机 `~/Downloads/wx-videos`。

## 功能

- **Telegram 机器人**：私聊发链接直接下载；群聊自动识别微信视频号链接（无需 @），非微信链接静默忽略
- **原文件按钮**：视频消息下方附带「获取原文件」按钮（显示文件大小），点击发送未压缩的原始文件
- **视频缓存**：同一视频（按短码识别）只下载一次，后续请求直接复用；并发请求同一视频自动去重
- **并发处理**：多任务并发执行（默认上限 5，可配），达到上限时新任务回复排队位置
- **进度消息**：解析/下载状态通过编辑同一条消息更新，完成后自动删除，不留中间消息
- **白名单**：可选限制使用人（配置文件动态生效，无需重启）
- **命令行工具**：`wxdl.mjs` 支持同样的解析下载

## 目录结构

```
wx-video/
├── bot.mjs            # Telegram 机器人主程序
├── lib.mjs            # 解析/下载核心（链接解析、签名、CDN 下载、XOR 还原）
├── wxdl.mjs           # 命令行下载工具
├── bot.sh             # 管理脚本（启动/停止/重启/状态/日志）
├── bot.config.json    # 配置（token/目录/并发/白名单/代理，不入库）
├── bot.config.example.json  # 配置模板
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
   ./bot.sh log        # 实时日志（Ctrl+C 退出）
   ./bot.sh restart    # 重启
   ./bot.sh stop       # 停止
   ```

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

**私聊**：直接发送微信视频号分享链接（或 `channels.weixin.qq.com` 链接、纯短码）。

**群聊**：发链接即自动下载，非微信链接不会触发。

**流程**：
```
用户: https://weixin.qq.com/sph/XXXX
Bot:  🔄 正在解析...          （同一条消息，原地更新）
Bot:  ⬇️ 正在下载（8.3 MB）...
Bot:  [视频文件]               （进度消息自动删除）
      └─ 📥 获取原文件 8.3 MB  （点击发送未压缩原文件）
```

限制：单视频 ≤ 50MB（Telegram 上传上限），超限的会提示并保留在本机。

## 测试

全部测试使用 mock Telegram + 假网络，完全离线、不触碰生产数据目录：

```bash
cd wx-video/test
node test_bot.mjs     # 主流程（下载/发送/原文件按钮/进度清理）
node test_bot2.mjs    # 群聊识别 + 白名单
node test_bot3.mjs    # 缓存与并发去重
node test_bot4.mjs    # 任务池排队 + 多消息处理
```

## 工作原理

1. 微信分享链接 `weixin.qq.com/sph/XXX` 重定向到官方预览页，但预览 API 对匿名用户不返回视频直链
2. 复用 miuistore.com 的解析服务：其签名 SDK（内嵌于 `lib.mjs`）生成签名，换取腾讯 CDN 直链（`finder.video.qq.com`）
3. CDN 流开头 N 字节被 XOR 混淆，密钥随响应下发，逐字节异或还原后即完整 MP4

依赖第三方解析服务（当前免费匿名可用）；若对方调整策略，机器人会明确报错。仅供学习研究，请尊重视频创作者版权。
