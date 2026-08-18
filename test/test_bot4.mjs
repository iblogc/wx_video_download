/**
 * test_bot4.mjs — 并发任务池与排队测试（mock Telegram + 假网络）
 * 场景A: MAX_TASKS=1 + FAKE_DELAY=1500，两个用户发不同视频 → 第 2 个收到"已排队"回复，
 *        随后两个都完成（sendVideo × 2）。
 * 场景B: 同用户连发 3 条同一链接 → 全部处理（不丢消息），只下载一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { startMockTelegram, spawnBot, waitFor } from './helpers.mjs';

// ---------- 场景A: 排队 ----------
{
  const PORT = 18768;
  const mock = startMockTelegram(PORT);
  await mock.listen();
  mock.push({ update_id: 1, message: { message_id: 1, chat: { id: 111, type: 'private' }, from: { id: 111 }, text: 'https://weixin.qq.com/sph/AAAA111111' } });
  mock.push({ update_id: 2, message: { message_id: 2, chat: { id: 222, type: 'private' }, from: { id: 222 }, text: 'https://weixin.qq.com/sph/BBBB222222' } });
  const bot = spawnBot(PORT, { config: { maxTasks: 1 }, extraEnv: { FAKE_DELAY: '1500' } });

  const queued = await waitFor(() => mock.stats.texts.some((t) => t.text.includes('已排队')));
  const bothDone = await waitFor(() => mock.stats.videos >= 2);
  const files = fs.readdirSync(bot.dl).filter((f) => f.endsWith('.mp4')).length;
  console.log('RESULT 场景A 排队回复:', queued, '| 排队消息:', JSON.stringify(mock.stats.texts.find((t) => t.text.includes('已排队'))?.text));
  console.log('RESULT 场景A 都完成:', bothDone, '| sendVideo:', mock.stats.videos, '| 文件数:', files);

  bot.cleanup();
  await mock.close();
  if (!(queued && bothDone && files === 2)) process.exit(1);
}

// ---------- 场景B: 同用户连发 3 条（不丢消息） ----------
{
  const PORT = 18769;
  const mock = startMockTelegram(PORT);
  await mock.listen();
  for (let i = 1; i <= 3; i++) {
    mock.push({ update_id: i, message: { message_id: i, chat: { id: 999, type: 'private' }, from: { id: 999 }, text: 'https://weixin.qq.com/sph/A9TdAV4DFB' } });
  }
  const bot = spawnBot(PORT);

  const allThree = await waitFor(() => mock.stats.videos >= 3);
  const cache = JSON.parse(fs.readFileSync(path.join(bot.dl, 'cache.json'), 'utf8'));
  const chatMsgs = mock.stats.texts.filter((m) => m.chat === '999');
  const oneDownload = Object.keys(cache).length === 1;
  console.log('RESULT 场景B 3条全部处理:', allThree, '| sendVideo:', mock.stats.videos, '| 仅下载一次:', oneDownload);
  console.log('RESULT 场景B 消息序列:', JSON.stringify(chatMsgs.map((m) => m.text)));

  bot.cleanup();
  await mock.close();
  if (!(allThree && oneDownload)) process.exit(1);
}

console.log('RESULT 全部通过');
process.exit(0);
