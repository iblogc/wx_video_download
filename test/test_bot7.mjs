/**
 * test_bot7.mjs — 补发模式（--backfill）：把历史下载的视频陆续同步到频道
 * 场景1: --dry-run 只列不发、不写索引
 * 场景2: --limit 2 分批补发（按下载时间升序，写 mirroredChannel + meta，带按钮）
 * 场景3: 再跑一次 → 只剩第 3 条；同内容（不同文件名）只发一次且两条都标记
 * 场景4: 再跑一次 → 发第 4 条（验证「 (2)」后缀从标题剥掉）
 * 场景5: 再跑一次 → 全部已同步，0 发送（幂等）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockTelegram, spawnBot, sleep } from './helpers.mjs';

const PORT = 18777;
const CH = '@vh_channel';
const H = 3600 * 1000;

const mock = startMockTelegram(PORT);
await mock.listen();

const cfg = { channelId: CH };
const setup = (dl) => {
  fs.mkdirSync(dl, { recursive: true });
  const mk = (name, bytes, ageMs, fill) => {
    const p = path.join(dl, name);
    fs.writeFileSync(p, Buffer.alloc(bytes, fill || 9));
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(p, t, t);
  };
  mk('老视频A.mp4', 1024, 4 * H, 1);
  mk('视频B.mp4', 2048, 3 * H, 2);
  mk('视频C.mp4', 3072, 2 * H, 3);
  mk('视频C2.mp4', 3072, 1.5 * H, 3);      // 与 C 同内容（不同文件名）→ 应去重
  mk('视频E (2).mp4', 4096, 1 * H, 5);     // 标题应剥掉「 (2)」
  fs.writeFileSync(path.join(dl, 'cache.json'), JSON.stringify({
    AAA: { file: '老视频A.mp4', size: 1024 },
    BBB: { file: '视频B.mp4', size: 2048 },
    CCC: { file: '视频C.mp4', size: 3072 },
    DDD: { file: '视频C2.mp4', size: 3072 },
    EEE: { file: '视频E (2).mp4', size: 4096 },
  }, null, 2));
};

function waitExit(child, ms = 30000) {
  return new Promise((res) => {
    const t = setTimeout(() => res('timeout'), ms);
    child.on('exit', (c) => { clearTimeout(t); res(c); });
  });
}

const cacheOf = (dl) => JSON.parse(fs.readFileSync(path.join(dl, 'cache.json'), 'utf8'));
const metaOf = (dl) => { try { return JSON.parse(fs.readFileSync(path.join(dl, 'meta.json'), 'utf8')); } catch { return {}; } };

let dir, dl;
async function run(args, overrideDir) {
  const useDir = overrideDir || dir;
  const bot = spawnBot(PORT, { config: cfg, args, dir: useDir, setup: useDir ? undefined : setup });
  if (!dir) dir = bot.tmp;
  dl = bot.dl;
  const code = await waitExit(bot.child);
  await sleep(200);
  bot.kill();   // 保留目录供下一轮续跑
  return { code, out: bot.output() };
}

const sends = () => mock.stats.videoSends;
const chSends = () => sends().filter((x) => x.chat === CH);

// ---------- 场景1：--dry-run ----------
let r = await run(['--backfill', '--dry-run', '--interval', '0']);
const dryListed = r.out.includes('本次 4 条') && r.out.includes('老视频A.mp4');
const dryClean = sends().length === 0 && !cacheOf(dl).AAA.mirroredChannel && Object.keys(metaOf(dl)).length === 0;
const s1 = r.code === 0 && dryListed && dryClean;
console.log('RESULT dry-run 只列不发、不写索引:', s1, '| 退出码:', r.code, '| 发送:', sends().length, '| 已列清单:', dryListed);

// ---------- 场景2：--limit 2 ----------
r = await run(['--backfill', '--limit', '2', '--interval', '0']);
const c2 = cacheOf(dl);
const s2 = r.code === 0 && chSends().length === 2
  && chSends()[0].caption === '老视频A' && chSends()[1].caption === '视频B'
  && !chSends()[0].hasReplyField && !!chSends()[0].callback
  && c2.AAA.mirroredChannel === CH && c2.BBB.mirroredChannel === CH && !c2.CCC.mirroredChannel;
console.log('RESULT 分批补发最早的 2 条（含按钮/mirroredChannel）:', s2, '| 频道已发:', chSends().map((x) => x.caption).join(','), '| 标记:', ['AAA', 'BBB', 'CCC'].map((k) => k + '=' + !!c2[k].mirroredChannel).join(' '));

// ---------- 场景3：再补一批 → 第 3 条 + 同内容标记 ----------
r = await run(['--backfill', '--limit', '1', '--interval', '0']);
const c3 = cacheOf(dl);
const s3 = r.code === 0 && chSends().length === 3 && chSends()[2].caption === '视频C'
  && c3.CCC.mirroredChannel === CH && c3.DDD.mirroredChannel === CH       // 同内容条目一并标记
  && r.out.includes('剩余待补发 1 条');
console.log('RESULT 同内容只发一次且两条都标记:', s3, '| 频道已发:', chSends().map((x) => x.caption).join(','), '| C2 标记:', c3.DDD.mirroredChannel === CH);

// ---------- 场景4：第 4 条（标题剥「 (2)」）----------
r = await run(['--backfill', '--limit', '5', '--interval', '0']);
const s4 = r.code === 0 && chSends().length === 4 && chSends()[3].caption === '视频E';
console.log('RESULT 标题剥掉「 (2)」后缀:', s4, '| 第 4 条:', chSends()[3] && chSends()[3].caption);

// ---------- 场景5：幂等 ----------
r = await run(['--backfill', '--limit', '5', '--interval', '0']);
const meta = metaOf(dl);
const s5 = r.code === 0 && chSends().length === 4 && r.out.includes('剩余待补发 0 条') && Object.keys(meta).length === 4;
console.log('RESULT 全部已同步后 0 发送:', s5, '| 频道总计:', chSends().length, '| meta 条目:', Object.keys(meta).length);

// ---------- 场景6：两个补发进程并发（跨进程索引锁：不重复发、不丢标记）----------
const base6 = chSends().length;
const dir6 = fs.mkdtempSync(path.join(os.tmpdir(), 'wxbot-test6-'));
setup(path.join(dir6, 'dl'));
const b1 = spawnBot(PORT, { config: cfg, args: ['--backfill', '--interval', '0'], dir: dir6 });
const b2 = spawnBot(PORT, { config: cfg, args: ['--backfill', '--interval', '0'], dir: dir6 });
const [exit1, exit2] = await Promise.all([waitExit(b1.child), waitExit(b2.child)]);
await sleep(300);
b1.kill(); b2.kill();
const dl6 = path.join(dir6, 'dl');
const c6 = cacheOf(dl6);
const cap6 = chSends().slice(base6).map((x) => x.caption);
const s6 = exit1 === 0 && exit2 === 0 && cap6.length === 4 && new Set(cap6).size === 4
  && ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].every((k) => c6[k].mirroredChannel === CH)
  && Object.keys(metaOf(dl6)).length === 4;
console.log('RESULT 两进程并发补发（跨进程锁）:', s6, '| 新增发送:', cap6.length, JSON.stringify(cap6), '| 标记齐全:', ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].every((k) => c6[k].mirroredChannel === CH));
fs.rmSync(dir6, { recursive: true, force: true });

// ---------- 场景7：--no-caption/--no-button → 补发的那条不带标题、不带按钮 ----------
const base7 = chSends().length;
const dir7 = fs.mkdtempSync(path.join(os.tmpdir(), 'wxbot-test7-'));
setup(path.join(dir7, 'dl'));
r = await run(['--backfill', '--limit', '1', '--interval', '0', '--no-caption', '--no-button'], dir7);
const last7 = chSends().at(-1);
const s7 = r.code === 0 && chSends().length === base7 + 1 && !last7.hasCaption && !last7.hasButton && r.out.includes('标题关，按钮关');
console.log('RESULT --no-caption/--no-button 生效:', s7, '| 该条:', JSON.stringify({ cap: last7 && last7.hasCaption, btn: last7 && last7.hasButton }), '| 计划行含开关:', r.out.includes('标题关，按钮关'));
fs.rmSync(dir7, { recursive: true, force: true });

fs.rmSync(dir, { recursive: true, force: true });
await mock.close();
process.exit(s1 && s2 && s3 && s4 && s5 && s6 && s7 ? 0 : 1);
