/**
 * test_bot3.mjs — 视频缓存与并发去重测试（mock Telegram API）
 *
 * 用户A(12345) 与 用户B(67890) 几乎同时发同一个视频链接：
 *   - 只发生 1 次真实下载（"正在下载"消息恰好 1 条）
 *   - 两人都收到视频（sendVideo × 2）
 *   - 用户B 目录有文件（硬链接），cache.json 有条目
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 18767;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    env: { ...process.env, TG_BOT_TOKEN: 'mocktoken', TEST_TG_BASE: 'http://127.0.0.1:' + PORT, http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '' },
  });
  bot.stdout.on('data', (d) => process.stdout.write('[bot] ' + d));
  bot.stderr.on('data', (d) => process.stdout.write('[bot-err] ' + d));

  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    if (sendVideoCount >= 2) break;
    await sleep(500);
  }

  const downloadingMsgs = sentMsgs.filter((m) => m.text.includes('正在下载'));
  const fileA = 'downloads/12345/只爱我一个不好吗？.mp4';
  const fileB = 'downloads/67890/只爱我一个不好吗？.mp4';
  const cache = JSON.parse(fs.readFileSync('downloads/cache.json', 'utf8'));

  const once = Object.keys(cache).length === 1;                 // 缓存仅 1 个条目 = 只真实下载一次
  const bothGot = sendVideoCount >= 2;                          // 两人都收到
  const bHas = fs.existsSync(fileB) && fs.statSync(fileB).size > 0;   // B 目录有文件
  const sameInode = fs.existsSync(fileA) && fs.existsSync(fileB)
    ? fs.statSync(fileA).ino === fs.statSync(fileB).ino         // 硬链接（同一 inode）
    : false;
  const cacheOk = cache['A9TdAV4DFB'] && cache['A9TdAV4DFB'].file;

  console.log('RESULT 仅下载一次:', once, '| 下载消息数:', downloadingMsgs.length);
  console.log('RESULT 两人都收到视频:', bothGot, '| sendVideo:', sendVideoCount);
  console.log('RESULT B目录有文件:', bHas, '| 与A同inode(硬链接):', sameInode);
  console.log('RESULT cache.json 条目:', cacheOk ? JSON.stringify(cache['A9TdAV4DFB']) : '缺失');

  bot.kill();
  server.close();
  process.exit(once && bothGot && bHas && sameInode && cacheOk ? 0 : 1);
});
