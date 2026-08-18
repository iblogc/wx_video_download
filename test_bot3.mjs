/**
 * test_bot3.mjs — 视频缓存与并发去重测试（mock Telegram + 假网络）
 *
 * 用户A(12345) 与 用户B(67890) 几乎同时发同一个视频链接：
 *   - 只发生 1 次真实下载（cache 仅 1 条）
 *   - 两人都收到视频（sendVideo × 2）
 *   - 平铺目录只有一个文件
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 18767;
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
  // 两用户几乎同时发同一链接
  updateQueue.push({ update_id: 1, message: { message_id: 1, chat: { id: 12345, type: 'private' }, from: { id: 12345 }, text: 'https://weixin.qq.com/sph/A9TdAV4DFB' } });
  updateQueue.push({ update_id: 2, message: { message_id: 2, chat: { id: 67890, type: 'private' }, from: { id: 67890 }, text: 'https://weixin.qq.com/sph/A9TdAV4DFB' } });

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
    if (sendVideoCount >= 2) break;
    await sleep(500);
  }

  const mp4s = fs.readdirSync(DL).filter((f) => f.endsWith('.mp4'));
  const cache = JSON.parse(fs.readFileSync(path.join(DL, 'cache.json'), 'utf8'));

  const once = Object.keys(cache).length === 1;                 // 缓存仅 1 个条目 = 只真实下载一次
  const bothGot = sendVideoCount >= 2;                          // 两人都收到
  const oneFile = mp4s.length === 1 && mp4s[0] === '测试视频.mp4';
  const cacheOk = cache['A9TdAV4DFB'] && cache['A9TdAV4DFB'].file === '测试视频.mp4';

  console.log('RESULT 仅下载一次:', once, '| 下载消息数:', sentMsgs.filter((m) => m.text.includes('正在下载')).length);
  console.log('RESULT 两人都收到视频:', bothGot, '| sendVideo:', sendVideoCount);
  console.log('RESULT 平铺单文件:', oneFile, '| 文件:', JSON.stringify(mp4s));
  console.log('RESULT cache.json 条目:', cacheOk ? JSON.stringify(cache['A9TdAV4DFB']) : '缺失');

  bot.kill();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(once && bothGot && oneFile && cacheOk ? 0 : 1);
});
