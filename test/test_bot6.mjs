/**
 * test_bot6.mjs — 频道同步（bot.config.json 的 channelId）
 * 场景1: 未配置 channelId → 只发用户（回归：行为不变）
 * 场景2: 配置 channelId → 用户 + 频道各一份；频道那份不 reply、不 @、按钮可用
 * 场景3: 频道被拒（机器人非频道成员）→ 用户回复不受影响，进程不崩、任务槽位正常释放
 * 场景4: 两人并发请求同一视频 → 频道只出现一次
 * 场景5: 频道失败后标记回滚 → 恢复后再次请求能补同步
 */
import { startMockTelegram, spawnBot, waitFor, sleep } from './helpers.mjs';

const LINK_A = 'https://weixin.qq.com/sph/A9TdAV4DFB';
const LINK_B = 'https://weixin.qq.com/sph/BBBB222222';
const CH = '@vh_channel';
const userMsg = (id, updateId, text, chatId = 12345) => ({ update_id: updateId, message: { message_id: id, chat: { id: chatId, type: 'private' }, from: { id: chatId }, text } });

// ---------- 场景1：未配置 channelId ----------
let mock = startMockTelegram(18772);
await mock.listen();
mock.push(userMsg(1, 1, LINK_A));
let bot = spawnBot(18772);
const got1 = await waitFor(() => mock.stats.videoSends.length >= 1);
await sleep(800);   // 若误发频道，这里会多出记录
const s1 = got1 && mock.stats.videoSends.length === 1 && mock.stats.videoSends[0].chat === '12345';
console.log('RESULT 未配置 channelId 只发用户:', s1, '| sends:', JSON.stringify(mock.stats.videoSends.map((x) => x.chat)));
bot.cleanup();
await mock.close();

// ---------- 场景2：配置 channelId ----------
mock = startMockTelegram(18773);
await mock.listen();
mock.push(userMsg(1, 1, LINK_A));
bot = spawnBot(18773, { config: { channelId: CH } });
const got2 = await waitFor(() => mock.stats.videoSends.length >= 2);
const [u, c] = mock.stats.videoSends;
const userOk = u && u.chat === '12345' && u.hasReplyField && u.replyTo === '1' && !!u.callback;
const chanOk = c && c.chat === CH && !c.hasReplyField && !c.entities && c.caption === '测试视频' && !!c.callback;
console.log('RESULT 用户那份不变:', userOk, '| user:', JSON.stringify(u && { chat: u.chat, replyTo: u.replyTo, hasReplyField: u.hasReplyField }));
console.log('RESULT 频道那份（不reply/不@/带按钮）:', chanOk, '| channel:', JSON.stringify(c && { chat: c.chat, replyTo: c.replyTo, hasReplyField: c.hasReplyField, entities: c.entities, caption: c.caption }));

// 频道里点「获取原文件」→ 原文件应发到频道（复用同一 shortId 的 meta 记录）
mock.push({ update_id: 2, callback_query: { id: 'c1', from: { id: 12345 }, message: { message_id: 9, chat: { id: CH } }, data: c.callback } });
const docOk = await waitFor(() => mock.stats.documents >= 1);
const docToChan = docOk && mock.stats.documentChats[0] === CH && mock.stats.documentFilename === '测试视频.mp4';
console.log('RESULT 频道按钮取原文件:', docToChan, '| documentChats:', JSON.stringify(mock.stats.documentChats));
bot.cleanup();
await mock.close();

// ---------- 场景3：频道发送被拒 ----------
mock = startMockTelegram(18774, { failChats: [CH] });
await mock.listen();
mock.push(userMsg(1, 1, LINK_A));
bot = spawnBot(18774, { config: { channelId: CH } });
await waitFor(() => mock.stats.videos >= 1);
mock.push(userMsg(2, 2, LINK_B));   // 频道失败后仍能处理下一条（槽位已释放）
const got3 = await waitFor(() => mock.stats.videos >= 2, 20000);
const logged = bot.output().includes('同步频道失败');
const allToUser = mock.stats.videoSends.every((x) => x.chat === '12345');
const s3 = got3 && allToUser && bot.child.exitCode === null && logged;
console.log('RESULT 频道失败不影响用户且不崩:', s3, '| 用户收到:', mock.stats.videos, '| 退出码:', bot.child.exitCode, '| 已记失败日志:', logged);
bot.cleanup();
await mock.close();

// ---------- 场景4：两人并发请求同一视频 → 频道只出现一次 ----------
mock = startMockTelegram(18775);
await mock.listen();
mock.push(userMsg(11, 1, LINK_A, 111));
mock.push(userMsg(22, 2, LINK_A, 222));
bot = spawnBot(18775, { config: { channelId: CH } });
const got4 = await waitFor(() => mock.stats.videoSends.length >= 3, 20000);
await sleep(1000);   // 若去重失效，这里会多出第 2 条频道消息
const chanSends = mock.stats.videoSends.filter((x) => x.chat === CH).length;
const userSends = mock.stats.videoSends.filter((x) => x.chat !== CH).length;
const s4 = got4 && mock.stats.videoSends.length === 3 && chanSends === 1 && userSends === 2;
console.log('RESULT 并发同一视频频道只发一次:', s4, '| 总发送:', mock.stats.videoSends.length, '| 频道:', chanSends, '| 用户:', userSends);
bot.cleanup();
await mock.close();

// ---------- 场景5：频道失败回滚标记 → 恢复后再次请求补同步 ----------
mock = startMockTelegram(18776, { failChats: [CH] });
await mock.listen();
mock.push(userMsg(1, 1, LINK_A));
bot = spawnBot(18776, { config: { channelId: CH } });
await waitFor(() => mock.stats.videos >= 1);
const failed5 = await waitFor(() => bot.output().includes('同步频道失败'), 20000);
mock.fail.delete(CH);                       // 频道恢复（机器人被加回/权限修好）
mock.push(userMsg(2, 2, LINK_A));           // 同一视频再次请求 → 应补同步
const mirrored5 = await waitFor(() => mock.stats.videoSends.some((x) => x.chat === CH), 20000);
const chan5 = mock.stats.videoSends.filter((x) => x.chat === CH).length;
const user5 = mock.stats.videoSends.filter((x) => x.chat === '12345').length;
const s5 = failed5 && mirrored5 && chan5 === 1 && user5 === 2;
console.log('RESULT 失败回滚后可补同步:', s5, '| 频道:', chan5, '| 用户:', user5, '| 首次已记失败:', failed5);
bot.cleanup();
await mock.close();

// ---------- 场景6：channelCaption/channelButton=false → 频道那份不带标题、不带按钮（用户那份不受影响）----------
mock = startMockTelegram(18781);
await mock.listen();
mock.push(userMsg(1, 1, LINK_A));
bot = spawnBot(18781, { config: { channelId: CH, channelCaption: false, channelButton: false } });
const got6 = await waitFor(() => mock.stats.videoSends.length >= 2, 20000);
const [u6, c6] = mock.stats.videoSends;
const s6 = got6 && u6.chat === '12345' && u6.hasCaption && u6.hasButton
  && c6.chat === CH && !c6.hasCaption && !c6.hasButton;
console.log('RESULT 频道关标题/关按钮（用户不受影响）:', s6, '| user:', JSON.stringify({ cap: u6 && u6.hasCaption, btn: u6 && u6.hasButton }), '| channel:', JSON.stringify({ cap: c6 && c6.hasCaption, btn: c6 && c6.hasButton }));
bot.cleanup();
await mock.close();

process.exit(s1 && userOk && chanOk && docToChan && s3 && s4 && s5 && s6 ? 0 : 1);
