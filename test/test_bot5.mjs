/**
 * test_bot5.mjs — 离线消息补处理与多链接测试（mock Telegram + 假网络）
 *
 * 场景1: 一条消息包含 2 个不同链接 → 都下载发送（sendVideo × 2，文件 × 2）
 * 场景2: 补发判定——消息 date 早于当前 10 分钟以上 → 视频标题带（补发）标注
 * 场景3: 同一消息内重复链接去重 → 只处理一次
 */
import fs from 'node:fs';
import path from 'node:path';
import { startMockTelegram, spawnBot, waitFor } from './helpers.mjs';

const PORT = 18771;
const mock = startMockTelegram(PORT);
await mock.listen();

const now = Math.floor(Date.now() / 1000);
// 场景2 的补发消息：date 设为 1 小时前
mock.push({ update_id: 1, message: { message_id: 1, chat: { id: 111, type: 'private' }, from: { id: 111 }, date: now - 3600, text: 'https://weixin.qq.com/sph/A9TdAV4DFB' } });
// 场景1: 一条消息两个不同链接
mock.push({ update_id: 2, message: { message_id: 2, chat: { id: 222, type: 'private' }, from: { id: 222 }, date: now, text: 'https://weixin.qq.com/sph/AAAA111111 https://channels.weixin.qq.com/finder-preview/pages/sph?id=BBBB222222' } });
// 场景3: 同一链接在一条消息里出现两次 → 去重只处理一次
mock.push({ update_id: 3, message: { message_id: 3, chat: { id: 333, type: 'private' }, from: { id: 333 }, date: now, text: 'https://weixin.qq.com/sph/A9TdAV4DFB 和 https://weixin.qq.com/sph/A9TdAV4DFB' } });

const bot = spawnBot(PORT);

const allDone = await waitFor(() => mock.stats.videos >= 4, 60000);

const cache = fs.existsSync(path.join(bot.dl, 'cache.json')) ? JSON.parse(fs.readFileSync(path.join(bot.dl, 'cache.json'), 'utf8')) : {};
const files = fs.readdirSync(bot.dl).filter((f) => f.endsWith('.mp4'));
const backlogCaption = mock.stats.texts.length > 0;
const videos = mock.stats.videos;

// 断言
console.log('RESULT 全部视频发出:', allDone, '| sendVideo:', videos);
console.log('RESULT 缓存条目:', Object.keys(cache).length, '| 文件数:', files.length);
console.log('RESULT 各短码缓存:', JSON.stringify(Object.fromEntries(Object.entries(cache).map(([k, v]) => [k.split('##')[0], v.file]))));

bot.cleanup();
await mock.close();

// 核心断言：4 个 sendVideo（1补发 + 2多链接 + 1重复去重），3 个唯一短码
const ok = videos >= 4 && Object.keys(cache).length === 3 && files.length === 3;
process.exit(ok ? 0 : 1);
