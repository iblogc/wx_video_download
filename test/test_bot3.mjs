/**
 * test_bot3.mjs — 视频缓存与并发去重测试（mock Telegram + 假网络）
 * 两用户同时请求同一视频：只下载一次（cache 1 条）、都收到视频、平铺单文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { startMockTelegram, spawnBot, waitFor } from './helpers.mjs';

const PORT = 18767;
const mock = startMockTelegram(PORT);
await mock.listen();

mock.push({ update_id: 1, message: { message_id: 1, chat: { id: 12345, type: 'private' }, from: { id: 12345 }, text: 'https://weixin.qq.com/sph/A9TdAV4DFB' } });
mock.push({ update_id: 2, message: { message_id: 2, chat: { id: 67890, type: 'private' }, from: { id: 67890 }, text: 'https://weixin.qq.com/sph/A9TdAV4DFB' } });
const bot = spawnBot(PORT);

const bothGot = await waitFor(() => mock.stats.videos >= 2);

const mp4s = fs.readdirSync(bot.dl).filter((f) => f.endsWith('.mp4'));
const cache = JSON.parse(fs.readFileSync(path.join(bot.dl, 'cache.json'), 'utf8'));

const once = Object.keys(cache).length === 1;
const oneFile = mp4s.length === 1 && mp4s[0] === '测试视频.mp4';
const cacheOk = cache['A9TdAV4DFB'] && cache['A9TdAV4DFB'].file === '测试视频.mp4';

console.log('RESULT 仅下载一次:', once, '| cache条目:', Object.keys(cache).length);
console.log('RESULT 两人都收到视频:', bothGot, '| sendVideo:', mock.stats.videos);
console.log('RESULT 平铺单文件:', oneFile, '| 文件:', JSON.stringify(mp4s));

bot.cleanup();
await mock.close();
process.exit(once && bothGot && oneFile && cacheOk ? 0 : 1);
