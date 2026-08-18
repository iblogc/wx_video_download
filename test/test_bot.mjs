/**
 * test_bot.mjs — 主流程测试（mock Telegram + 假网络）
 * 私聊发链接 → 假下载生成文件 → sendVideo（按钮带文件大小）→ 原文件按钮 → sendDocument
 * 断言：进度消息被编辑/清理（deletes ≥ 1），只留最终视频消息。
 */
import fs from 'node:fs';
import path from 'node:path';
import { startMockTelegram, spawnBot, waitFor, sleep } from './helpers.mjs';

const PORT = 18765;
const mock = startMockTelegram(PORT);
await mock.listen();

mock.push({ update_id: 1, message: { message_id: 1, chat: { id: 12345, type: 'private' }, from: { id: 12345 }, text: 'https://weixin.qq.com/sph/A9TdAV4DFB' } });
const bot = spawnBot(PORT);

let callbackInjected = false;
const t0 = Date.now();
while (Date.now() - t0 < 30000) {
  if (mock.stats.videos >= 1 && !callbackInjected && mock.stats.callbackData) {
    callbackInjected = true;
    mock.push({ update_id: 2, callback_query: { id: 'c1', from: { id: 12345 }, message: { message_id: 1, chat: { id: 12345 } }, data: mock.stats.callbackData } });
  }
  if (mock.stats.documents >= 1 && callbackInjected) break;
  await sleep(300);
}

const file = path.join(bot.dl, '测试视频.mp4');
const okFile = fs.existsSync(file) && fs.statSync(file).size > 0;
const progressCleaned = mock.stats.deletes >= 1;
const deleteAfterSend = mock.stats.deletesAfterVideos >= 1;   // 先发出视频，后删进度消息
const buttonOk = mock.stats.button && mock.stats.button.text.includes('MB') && !mock.stats.button.text.includes('不压缩');
const edits = mock.stats.edits;
// 视频应回复（reply）到用户消息 message_id=1，一一对应
const replyOk = mock.stats.videoReplyTo === '1' && mock.stats.texts.length > 0 && mock.stats.texts[0].replyTo === '1';
// 原文件 document 的文件名应为真实视频文件名（不是 "document"）
const docNameOk = mock.stats.documentFilename === '测试视频.mp4';

console.log('RESULT 假网络下载文件:', okFile, okFile ? '(' + fs.statSync(file).size + ' bytes)' : '');
console.log('RESULT sendVideo:', mock.stats.videos, '| sendDocument:', mock.stats.documents);
console.log('RESULT 进度消息清理:', progressCleaned, '| 删除时已发视频数(>0=先发后删):', mock.stats.deletesAfterVideos, '| 编辑次数:', edits);
console.log('RESULT 按钮带大小:', buttonOk, '| 按钮文字:', mock.stats.button && mock.stats.button.text);
console.log('RESULT 回复到用户消息(reply_to=1):', replyOk, '| 视频replyTo:', mock.stats.videoReplyTo);
console.log('RESULT 原文件文件名:', docNameOk, '| document filename:', mock.stats.documentFilename);
console.log('RESULT 进度消息序列:', JSON.stringify(mock.stats.texts.map((t) => t.text)));

bot.cleanup();
await mock.close();
process.exit(okFile && mock.stats.videos >= 1 && mock.stats.documents >= 1 && progressCleaned && deleteAfterSend && buttonOk && replyOk && docNameOk ? 0 : 1);
