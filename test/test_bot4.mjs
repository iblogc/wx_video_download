/**
 * test_bot4.mjs — 并发任务池与排队测试（mock Telegram + 假网络）
 * 场景A: MAX_TASKS=1 + FAKE_DELAY=1500，两个用户发不同视频 → 第 2 个收到"已排队"回复，
 *        随后两个都完成（sendVideo × 2）。
 * 场景B: 同用户连发 3 条同一链接 → 全部处理（不丢消息），只下载一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { startMockTelegram, spawnBot, waitFor } from './helpers.mjs';

// ---------- 场景A: 排队（3 个任务全部执行，MAX_TASKS=1） ----------
{
  const PORT = 18768;
  const mock = startMockTelegram(PORT);
  await mock.listen();
  mock.push({ update_id: 1, message: { message_id: 1, chat: { id: 111, type: 'private' }, from: { id: 111 }, text: 'https://weixin.qq.com/sph/AAAA111111' } });
  mock.push({ update_id: 2, message: { message_id: 2, chat: { id: 222, type: 'private' }, from: { id: 222 }, text: 'https://weixin.qq.com/sph/BBBB222222' } });
  mock.push({ update_id: 3, message: { message_id: 3, chat: { id: 333, type: 'private' }, from: { id: 333 }, text: 'https://weixin.qq.com/sph/CCCC333333' } });
  const bot = spawnBot(PORT, { config: { maxTasks: 1 }, extraEnv: { FAKE_DELAY: '1500' } });

  const queued = await waitFor(() => mock.stats.texts.some((t) => t.text.includes('已排队')));
  const queueCount = mock.stats.texts.filter((t) => t.text.includes('已排队')).length;
  const allDone = await waitFor(() => mock.stats.videos >= 3, 60000);
  const files = fs.readdirSync(bot.dl).filter((f) => f.endsWith('.mp4')).length;
  console.log('RESULT 场景A 排队消息:', queueCount, '条 | 全部完成:', allDone, '| sendVideo:', mock.stats.videos, '| 文件数:', files);

  bot.cleanup();
  await mock.close();
  if (!(queued && queueCount === 2 && allDone && files === 3)) process.exit(1);
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

// ---------- 场景C: 同名文件 size 一致 → 直接复用（需求3） ----------
{
  const PORT = 18770;
  const mock = startMockTelegram(PORT);
  await mock.listen();
  const bot = spawnBot(PORT);
  fs.mkdirSync(bot.dl, { recursive: true });
  // 预置一个与 fake fileSize(3MB) 大小一致的同名文件
  fs.writeFileSync(path.join(bot.dl, '测试视频.mp4'), Buffer.alloc(3 * 1024 * 1024, 9));
  mock.push({ update_id: 1, message: { message_id: 1, chat: { id: 444, type: 'private' }, from: { id: 444 }, text: 'https://weixin.qq.com/sph/A9TdAV4DFB' } });
  const done = await waitFor(() => mock.stats.videos >= 1);
  const files = fs.readdirSync(bot.dl).filter((f) => f.endsWith('.mp4'));
  const reuse = files.length === 1 && files[0] === '测试视频.mp4';   // 未产生 (2) 文件 = 复用
  const cache = JSON.parse(fs.readFileSync(path.join(bot.dl, 'cache.json'), 'utf8'));
  const cacheOk = cache['A9TdAV4DFB'] && cache['A9TdAV4DFB'].file === '测试视频.mp4';
  console.log('RESULT 场景C 同名size一致复用:', reuse && cacheOk, '| 文件:', JSON.stringify(files));

  bot.cleanup();
  await mock.close();
  if (!(done && reuse && cacheOk)) process.exit(1);
}

console.log('RESULT 全部通过');
process.exit(0);
