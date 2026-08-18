/**
 * test_bot4.mjs — 同 chat 多消息并发测试（mock Telegram + 假网络）
 *
 * 同一用户连发 3 条同一链接：
 *   - 3 条全部被处理（修复前：processing 去重导致后 2 条被丢弃）
 *   - 第 1 条真实下载，后 2 条命中缓存
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 18768;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wxbot-test-'));
const DL = path.join(TMP, 'dl');

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
  // 同一用户 (999) 同一轮连发 3 条同一链接
  for (let i = 1; i <= 3; i++) {
    updateQueue.push({ update_id: i, message: { message_id: i, chat: { id: 999, type: 'private' }, from: { id: 999 }, text: 'https://weixin.qq.com/sph/A9TdAV4DFB' } });
  }

  const bot = spawn('node', ['bot.mjs'], {
    env: {
      ...process.env,
      TG_BOT_TOKEN: 'mocktoken',
      TEST_TG_BASE: 'http://127.0.0.1:' + PORT,
      DOWNLOAD_DIR: DL,
      BOT_CONFIG: path.join(TMP, 'config.json'),
      FAKE_NETWORK: '1',
      http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '',
    },
  });
  bot.stdout.on('data', (d) => process.stdout.write('[bot] ' + d));
  bot.stderr.on('data', (d) => process.stdout.write('[bot-err] ' + d));

  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    if (sendVideoCount >= 3) break;
    await sleep(500);
  }

  const cache = JSON.parse(fs.readFileSync(path.join(DL, 'cache.json'), 'utf8'));
  const mp4s = fs.readdirSync(DL).filter((f) => f.endsWith('.mp4'));
  const chatMsgs = sentMsgs.filter((m) => m.chat === '999');
  const downloads = chatMsgs.filter((m) => m.text.includes('正在下载')).length;

  const allThree = sendVideoCount >= 3;                    // 3 条全部处理并回复
  const oneDownload = downloads === 1 && Object.keys(cache).length === 1;  // 只真实下载一次
  const oneFile = mp4s.length === 1;                       // 只有一个视频文件

  console.log('RESULT 3条全部处理:', allThree, '| sendVideo:', sendVideoCount);
  console.log('RESULT 仅下载一次:', oneDownload, '| 下载消息数:', downloads, '| cache条目:', Object.keys(cache).length);
  console.log('RESULT 单文件:', oneFile, '| 文件:', JSON.stringify(mp4s));
  console.log('RESULT 消息序列:', JSON.stringify(chatMsgs.map((m) => m.text)));

  bot.kill();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(allThree && oneDownload && oneFile ? 0 : 1);
});
