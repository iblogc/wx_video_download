/**
 * test_bot.mjs — bot.mjs 端到端测试（mock Telegram + 假网络，完全离线）
 *
 * 流程: 起本地 mock Telegram server → spawn bot.mjs（临时数据目录 + FAKE_NETWORK）→
 *       注入一条私聊链接消息 → 断言下载文件生成、sendVideo 收到、
 *       注入"获取原文件"callback → 断言 sendDocument 收到。
 * 不触碰生产数据目录（~/Downloads/wx-videos）。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 18765;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wxbot-test-'));
const DL = path.join(TMP, 'dl');

let updateQueue = [];
let sendVideoCount = 0, sendDocumentCount = 0;
let callbackData = null;
let callbackInjected = false;

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
      console.log('[mock] sendMessage:', url.searchParams.get('text'));
      return res.end(JSON.stringify({ ok: true, result: { message_id: 9 } }));
    case 'sendChatAction':
      return res.end(JSON.stringify({ ok: true }));
    case 'answerCallbackQuery':
      return res.end(JSON.stringify({ ok: true }));
    case 'setMyCommands':
      return res.end(JSON.stringify({ ok: true }));
    case 'sendVideo':
    case 'sendDocument': {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        const m = text.match(/name="reply_markup"\r\n\r\n([^\r]+)/);
        if (m) {
          try { callbackData = JSON.parse(m[1]).inline_keyboard[0][0].callback_data; } catch {}
        }
        if (method === 'sendVideo') sendVideoCount++;
        else sendDocumentCount++;
        console.log('[mock] ' + method + ' bytes=' + buf.length);
        res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      });
      return;
    }
    default:
      return res.end(JSON.stringify({ ok: false, description: 'unknown ' + method }));
  }
});

const file = path.join(DL, '测试视频.mp4');

server.listen(PORT, async () => {
  updateQueue.push({
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: 12345, type: 'private' },
      from: { id: 12345, is_bot: false },
      text: 'https://weixin.qq.com/sph/A9TdAV4DFB',
    },
  });

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
    if (sendVideoCount >= 1 && !callbackInjected && callbackData) {
      callbackInjected = true;
      updateQueue.push({
        update_id: 2,
        callback_query: {
          id: 'c1', from: { id: 12345, is_bot: false },
          message: { message_id: 1, chat: { id: 12345 } },
          data: callbackData,
        },
      });
      console.log('[test] 注入原文件 callback:', callbackData);
    }
    if (sendDocumentCount >= 1 && callbackInjected) break;
    await sleep(500);
  }

  const okFile = fs.existsSync(file) && fs.statSync(file).size > 0;
  console.log('RESULT 假网络下载文件存在:', okFile, okFile ? '(' + fs.statSync(file).size + ' bytes)' : '');
  console.log('RESULT sendVideo:', sendVideoCount, '| sendDocument:', sendDocumentCount);
  bot.kill();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(okFile && sendVideoCount >= 1 && sendDocumentCount >= 1 ? 0 : 1);
});
