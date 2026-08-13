#!/usr/bin/env node
/**
 * wxdl.mjs — 视频号视频下载（命令行版，逻辑见 lib.mjs）
 *
 * 用法:
 *   node wxdl.mjs "https://weixin.qq.com/sph/A9TdAV4DFB"
 *   node wxdl.mjs "https://channels.weixin.qq.com/finder-preview/pages/sph?id=A9TdAV4DFB"
 *   node wxdl.mjs A9TdAV4DFB
 */
import path from 'node:path';
import { parseId, resolveVideo, downloadVideo, cleanTitle } from './lib.mjs';

async function main() {
  const id = parseId(process.argv[2]);
  const info = await resolveVideo(id);
  const outPath = path.join(process.cwd(), cleanTitle(info.title, id) + '.mp4');

  console.log('标题: ' + info.title);
  console.log('大小: ' + (info.fileSize / 1048576).toFixed(2) + ' MB');
  console.log('保存: ' + outPath);

  let lastPct = -1;
  const bytes = await downloadVideo(info, outPath, (pct) => {
    if (process.stdout.isTTY) process.stdout.write('\r下载 ' + pct.toFixed(1) + '%');
    else if (Math.floor(pct / 10) > Math.floor(lastPct / 10)) { lastPct = pct; console.log('下载 ' + Math.floor(pct) + '%'); }
  });
  if (process.stdout.isTTY) process.stdout.write('\r下载 100.0%\n');
  console.log('完成 ✔ ' + outPath + ' (' + (bytes / 1048576).toFixed(2) + ' MB)');
}

main().catch((e) => { console.error('错误: ' + e.message); process.exit(1); });
