/**
 * test_bot2.mjs — 群聊识别与白名单场景测试（mock Telegram + 假网络）
 *
 * 阶段A（无白名单配置）: 群聊带微信链接(不@)→下载; 群聊带普通链接→忽略
 * 阶段B（写入白名单）:   白名单外私聊 → 拒绝（验证配置动态生效）
 * 数据/配置全部在临时目录，不触碰生产。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 18766;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wxbot-test-'));
const DL = path.join(TMP, 'dl');
const CFG = path.join(TMP, 'config.json');

let updateQueue = [];
let sentMsgs = [];        // { chat, text }
let sendVideoCount = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const method = url.pathname.split('/').pop();
  res.setHeader('content-type', 'application/json');
  switch (method) {
    case 'getMe':
      return res.end(JSON.stringify({ ok: true, result: { username: 'TestBot' } }));
    case 'getUpdates':
      return res.end(JSON.stringify({ ok: true, result: updateQueue.splice(0, updateQueue.length) }));
    case 'sendMessage':
      sentMsgs.push({ chat: url.searchParams.get('chat_id'), text: url.searchParams.get('text') });
      return res.end(JSON.stringify({ ok: true }));
    case 'sendChatAction':
      return res.end(JSON.stringify({ ok: true }));
    case 'setMyCommands':
      return res.end(JSON.stringify({ ok: true }));
    case 'sendVideo': {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { sendVideoCount++; res.end(JSON.stringify({ ok: true })); });
      return;
    }
    default:
      return res.end(JSON.stringify({ ok: false, description: 'unknown ' + method }));
  }
});

server.listen(PORT, async () => {
  // 阶段A 场景1: 群聊微信链接（不@，带上下文文字）
  updateQueue.push({ update_id: 1, message: { message_id: 1, chat: { id: 111, type: 'group' }, from: { id: 111 }, text: '看这个 https://weixin.qq.com/sph/A9TdAV4DFB 好好笑' } });
  // 阶段A 场景2: 群聊普通链接（不@）
  updateQueue.push({ update_id: 2, message: { message_id: 2, chat: { id: 222, type: 'group' }, from: { id: 222 }, text: '今天天气不错 https://example.com/abc' } });

  const bot = spawn('node', ['bot.mjs'], {
    env: {
      ...process.env,
      TG_BOT_TOKEN: 'mocktoken',
      TEST_TG_BASE: 'http://127.0.0.1:' + PORT,
      DOWNLOAD_DIR: DL,
      BOT_CONFIG: CFG,
      FAKE_NETWORK: '1',
      http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '',
    },
  });
  bot.stdout.on('data', (d) => process.stdout.write('[bot] ' + d));
  bot.stderr.on('data', (d) => process.stdout.write('[bot-err] ' + d));

  // 等场景1 下载完成
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    if (sendVideoCount >= 1) break;
    await sleep(500);
  }

  // 阶段B: 写入白名单（不重启，验证动态读取），发白名单外私聊消息
  fs.writeFileSync(CFG, JSON.stringify({ allowedUsers: [999] }));
  updateQueue.push({ update_id: 3, message: { message_id: 3, chat: { id: 333, type: 'private' }, from: { id: 333 }, text: 'https://weixin.qq.com/sph/A9TdAV4DFB' } });
  const t1 = Date.now();
  while (Date.now() - t1 < 10000) {
    if (sentMsgs.some((m) => m.chat === '333')) break;
    await sleep(500);
  }

  const scene1 = sendVideoCount >= 1;                                  // 群聊微信链接下载成功
  const scene2 = !sentMsgs.some((m) => m.chat === '222');              // 非微信链接群聊完全无回复
  const scene3 = sentMsgs.some((m) => m.chat === '333' && m.text.includes('仅限指定用户'));
  console.log('RESULT 场景1 群聊微信链接下载:', scene1);
  console.log('RESULT 场景2 非微信链接忽略:', scene2);
  console.log('RESULT 场景3 白名单动态拒绝:', scene3);
  console.log('RESULT 消息:', JSON.stringify(sentMsgs.map((m) => m.chat + ':' + m.text)));

  bot.kill();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(scene1 && scene2 && scene3 ? 0 : 1);
});
