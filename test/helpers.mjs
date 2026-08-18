/**
 * helpers.mjs — 测试公共设施
 *   - startMockTelegram: 本地 mock Telegram API（记录全部调用，可注入 update）
 *   - spawnBot: 启动 bot 指向 mock，数据/配置全在临时目录 + FAKE_NETWORK
 *   - waitFor / sleep: 轮询等待
 * 测试完全不触碰生产数据目录（~/Downloads/wx-videos）。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function startMockTelegram(port) {
  const stats = {
    texts: [],          // { chat, text, msgId }
    videos: 0, documents: 0, edits: 0, deletes: 0, actions: [], answers: [],
    button: null,       // 最近一次 sendVideo 的按钮
    callbackData: null,
  };
  let msgSeq = 100;
  const queue = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const method = url.pathname.split('/').pop();
    res.setHeader('content-type', 'application/json');
    switch (method) {
      case 'getMe':
        return res.end(JSON.stringify({ ok: true, result: { username: 'TestBot' } }));
      case 'getUpdates':
        return res.end(JSON.stringify({ ok: true, result: queue.splice(0, queue.length) }));
      case 'sendMessage':
        stats.texts.push({ chat: url.searchParams.get('chat_id'), text: url.searchParams.get('text'), msgId: ++msgSeq, replyTo: url.searchParams.get('reply_to_message_id') });
        return res.end(JSON.stringify({ ok: true, result: { message_id: msgSeq } }));
      case 'editMessageText':
        stats.edits++;
        return res.end(JSON.stringify({ ok: true, result: { message_id: +url.searchParams.get('message_id') } }));
      case 'deleteMessage':
        stats.deletes++;
        stats.deletesAfterVideos = stats.videos;   // 删除时刻已发出的视频数（验证先发后删）
        return res.end(JSON.stringify({ ok: true, result: true }));
      case 'sendChatAction':
        stats.actions.push(url.searchParams.get('action'));
        return res.end(JSON.stringify({ ok: true }));
      case 'answerCallbackQuery':
        stats.answers.push(url.searchParams.get('text'));
        return res.end(JSON.stringify({ ok: true }));
      case 'setMyCommands':
        return res.end(JSON.stringify({ ok: true }));
      case 'sendVideo':
      case 'sendDocument': {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (method === 'sendVideo') {
            stats.videos++;
            const m = text.match(/name="reply_markup"\r\n\r\n([^\r]+)/);
            if (m) {
              try {
                stats.button = JSON.parse(m[1]).inline_keyboard[0][0];
                stats.callbackData = stats.button.callback_data;
              } catch {}
            }
            const rm = text.match(/name="reply_to_message_id"\r\n\r\n([^\r]+)/);
            stats.videoReplyTo = rm ? rm[1] : null;
            const cap = text.match(/name="caption"\r\n\r\n([^\r]+)/);
            stats.videoCaption = cap ? cap[1] : null;
            const ents = text.match(/name="caption_entities"\r\n\r\n([^\r]+)/);
            stats.videoCaptionEntities = ents ? ents[1] : null;
          } else {
            stats.documents++;
            const fm = text.match(/name="document"[\s\S]*?filename="([^"]+)"/);
            stats.documentFilename = fm ? fm[1] : null;
          }
          res.end(JSON.stringify({ ok: true, result: { message_id: ++msgSeq } }));
        });
        return;
      }
      default:
        return res.end(JSON.stringify({ ok: false, description: 'unknown ' + method }));
    }
  });
  return {
    server, stats, queue,
    push: (u) => queue.push(u),
    listen: () => new Promise((r) => server.listen(port, r)),
    close: () => new Promise((r) => server.close(r)),
  };
}

export function spawnBot(port, { extraEnv = {}, config = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wxbot-test-'));
  const dl = path.join(tmp, 'dl');
  const cfg = path.join(tmp, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ token: 'mocktoken', downloadDir: dl, maxTasks: 5, ...config }));
  const env = {
    ...process.env,
    TEST_TG_BASE: 'http://127.0.0.1:' + port,
    BOT_CONFIG: cfg,
    FAKE_NETWORK: '1',
    http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '',
    ...extraEnv,
  };
  const child = spawn('node', ['bot.mjs'], { env, cwd: ROOT });
  child.stdout.on('data', (d) => process.stdout.write('[bot] ' + d));
  child.stderr.on('data', (d) => process.stdout.write('[bot-err] ' + d));
  return {
    child, dl, cfg, tmp,
    kill: () => { try { child.kill(); } catch {} },
    cleanup: () => { try { child.kill(); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

export async function waitFor(cond, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await sleep(300);
  }
  return false;
}
