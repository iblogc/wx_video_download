/**
 * test_bot8.mjs — 视频尺寸元数据（ffprobe 探测 → sendVideo 带 width/height/duration）
 * 背景：这些 mp4 的 tkhd 宽高为 0，Telegram 服务端抓不到尺寸时会退回方图缩略图当视频尺寸，
 *       客户端按 1:1 布局 → 竖屏视频比例失真。官方客户端上传时会带尺寸，机器人也必须带。
 * 场景1: ffprobe 可用 → 用户与频道两份都带 width/height/duration
 * 场景2: ffprobe 报旋转 -90 → 显示尺寸与编码尺寸互换
 * 场景3: ffprobe 不存在 → 退回旧行为（不带尺寸）但仍发送成功
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockTelegram, spawnBot, waitFor, sleep } from './helpers.mjs';

const CH = '@vh_channel';
const LINK = 'https://weixin.qq.com/sph/A9TdAV4DFB';
const userMsg = (id, text) => ({ update_id: id, message: { message_id: id, chat: { id: 12345, type: 'private' }, from: { id: 12345 }, text } });

// 假 ffprobe：按需输出固定 JSON（不依赖本机 ffmpeg，测试完全离线可重复）
function fakeFfprobe(json) {
  const p = path.join(os.tmpdir(), 'fake-ffprobe-' + Math.random().toString(36).slice(2, 8) + '.sh');
  fs.writeFileSync(p, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(json)}\nEOF\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

async function scenario(port, { ffprobe, expect }) {
  const mock = startMockTelegram(port);
  await mock.listen();
  mock.push(userMsg(1, LINK));
  const bot = spawnBot(port, { config: { channelId: CH }, extraEnv: { FFPROBE: ffprobe } });
  const got = await waitFor(() => mock.stats.videoSends.length >= 2, 20000);
  await sleep(400);
  const sends = mock.stats.videoSends;
  const ok = got && sends.length === 2 && sends.every((s) => s.width === expect.width && s.height === expect.height && s.duration === expect.duration);
  console.log(`RESULT ${expect.label}:`, ok, '|', JSON.stringify(sends.map((s) => ({ chat: s.chat, wh: s.width + 'x' + s.height, dur: s.duration }))));
  bot.cleanup();
  await mock.close();
  return ok;
}

const s1 = await scenario(18778, {
  ffprobe: fakeFfprobe({ streams: [{ width: 720, height: 1252 }], format: { duration: '14.512472' } }),
  expect: { label: '用户+频道两份都带尺寸', width: '720', height: '1252', duration: '15' },
});

const s2 = await scenario(18779, {
  ffprobe: fakeFfprobe({ streams: [{ width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }], format: { duration: '8.2' } }),
  expect: { label: '旋转 -90 时宽高互换', width: '1080', height: '1920', duration: '8' },
});

const s3 = await scenario(18780, {
  ffprobe: '/nonexistent/ffprobe',
  expect: { label: '无 ffprobe 时退回旧行为', width: null, height: null, duration: null },
});

process.exit(s1 && s2 && s3 ? 0 : 1);
