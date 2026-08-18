/**
 * test_bot2.mjs — 群聊识别与白名单场景测试（mock Telegram + 假网络）
 * 阶段A: 群聊微信链接(不@)→下载; 群聊普通链接→忽略
 * 阶段B: 写入白名单 → 白名单外私聊拒绝（验证配置动态生效）
 */
import fs from 'node:fs';
import { startMockTelegram, spawnBot, waitFor } from './helpers.mjs';

const PORT = 18766;
const mock = startMockTelegram(PORT);
await mock.listen();

// 阶段A: 群聊微信链接（不@，带上下文） + 群聊普通链接
mock.push({ update_id: 1, message: { message_id: 1, chat: { id: 111, type: 'group' }, from: { id: 111 }, text: '看这个 https://weixin.qq.com/sph/A9TdAV4DFB 好好笑' } });
mock.push({ update_id: 2, message: { message_id: 2, chat: { id: 222, type: 'group' }, from: { id: 222 }, text: '今天天气不错 https://example.com/abc' } });
const bot = spawnBot(PORT);

const scene1 = await waitFor(() => mock.stats.videos >= 1);

// 阶段B: 写入白名单（不重启，验证动态读取）
fs.writeFileSync(bot.cfg, JSON.stringify({ allowedUsers: [999] }));
mock.push({ update_id: 3, message: { message_id: 3, chat: { id: 333, type: 'private' }, from: { id: 333 }, text: 'https://weixin.qq.com/sph/A9TdAV4DFB' } });
const scene3 = await waitFor(() => mock.stats.texts.some((m) => m.chat === '333'));

const scene2 = !mock.stats.texts.some((m) => m.chat === '222');
console.log('RESULT 场景1 群聊微信链接下载:', scene1, '| sendVideo:', mock.stats.videos);
console.log('RESULT 场景2 非微信链接忽略:', scene2);
console.log('RESULT 场景3 白名单动态拒绝:', scene3);
console.log('RESULT 消息:', JSON.stringify(mock.stats.texts.map((m) => m.chat + ':' + m.text)));

bot.cleanup();
await mock.close();
process.exit(scene1 && scene2 && scene3 ? 0 : 1);
