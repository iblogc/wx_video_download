#!/usr/bin/env node
/**
 * bot.mjs — Telegram 微信视频下载机器人
 *
 * 用法:
 *   TG_BOT_TOKEN=<token> node bot.mjs            # 前台运行
 *   TG_BOT_TOKEN=<token> nohup node bot.mjs > bot.log 2>&1 &   # 后台运行
 *   node bot.mjs --backfill [--limit N] [--interval S] [--no-caption] [--no-button] [--dry-run]   # 把历史下载的视频补发到频道
 *
 * 功能:
 *   - 私聊直接发链接；群聊需 @机器人 才响应
 *   - 下载的视频按用户 ID 分组存到 downloads/<userId>/
 *   - 发视频（Telegram 转码压缩）+ "获取原文件"按钮（发原文件文档）
 *   - 超过 50MB 的提示并在本地保留
 *   - 白名单: bot.config.json 里配 "allowedUsers": [123, 456]（留空=所有人），
 *     运行时动态读取，改完即时生效
 *
 * 网络:
 *   - Telegram API 走本机代理（自动读 http_proxy/https_proxy 环境变量）
 *   - 媒体下载直连（腾讯 CDN 国内可达）
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { parseId, resolveVideo, downloadVideo, cleanTitle } from './lib.mjs';

const TG_BASE = process.env.TEST_TG_BASE || 'https://api.telegram.org';
const MAX_UPLOAD = 50 * 1024 * 1024;                                  // Telegram 上传上限 50MB
const MAX_CONCURRENT_DOWNLOADS = 3;
const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.BOT_CONFIG || path.join(DIR, 'bot.config.json');
// FAKE_NETWORK=1：测试模式，解析/下载全部走假数据（离线、毫秒级、零真实文件）
const FAKE = process.env.FAKE_NETWORK === '1';

// 统一配置文件（bot.config.json），字段见 bot.config.example.json
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
const config = loadConfig();
const TOKEN = config.token || '';
const DOWNLOADS_DIR = config.downloadDir
  ? config.downloadDir.replace(/^~(?=\/|$)/, os.homedir())
  : path.join(os.homedir(), 'Downloads', 'wx-videos');
const MAX_TASKS = parseInt(config.maxTasks || '5', 10);
const GLOBAL_META = path.join(DOWNLOADS_DIR, 'meta.json');

if (!TOKEN) {
  console.error('❌ bot.config.json 里未配置 token（用 @BotFather 创建机器人获取，见 bot.config.example.json）。');
  process.exit(1);
}

// ---------- 工具 ----------
const tzFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });  // en-CA → YYYY-MM-DD
const LOG_DIR = path.join(DIR, 'logs');
function dayKey() { return dayFmt.format(new Date()); }
function writeLog(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `bot-${dayKey()}.log`), line + '\n');
  } catch {}
}
const log = (...a) => {
  const line = tzFmt.format(new Date()) + ' ' + a.join(' ');
  console.log(line);
  writeLog(line);
};

// 发送人/群描述（日志用）：[群名或私聊(chatId)][昵称(@username, userId)]
function describeSender(chat, from) {
  const chatName = chat && chat.title ? String(chat.title) : (chat ? chat.type : '?');
  const name = from && (from.username ? '@' + from.username : (from.first_name || from.last_name || '')) || (from ? String(from.id) : '?');
  return `[${chatName}(${chat ? chat.id : '?'})][${name}(${from ? from.id : '?'})]`;
}

function loadGlobalMeta() {
  try { return JSON.parse(fs.readFileSync(GLOBAL_META, 'utf8')); } catch { return {}; }
}
function saveGlobalMeta(m) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  fs.writeFileSync(GLOBAL_META, JSON.stringify(m, null, 2));
}

// ---------- 代理（仅 Telegram API 使用）：配置优先，缺省读环境变量 ----------
function parseProxy() {
  if (config.proxy && config.proxy.host) {
    return { host: config.proxy.host, port: config.proxy.port ? +config.proxy.port : 80 };
  }
  const v = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
  if (!v) return null;
  try { const u = new URL(v); return { host: u.hostname, port: u.port ? +u.port : 80 }; } catch { return null; }
}
const PROXY = parseProxy();
function makeTunnelAgent(proxy) {
  const agent = new https.Agent();
  agent.createConnection = (opts, cb) => {
    const connect = http.request({
      host: proxy.host, port: proxy.port, method: 'CONNECT',
      path: `${opts.host}:${opts.port}`,
      headers: { Host: `${opts.host}:${opts.port}` },
    });
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); cb(new Error('proxy CONNECT ' + res.statusCode)); return; }
      const s = tls.connect({ socket, servername: opts.host });
      s.on('error', cb);
      s.on('secureConnect', () => cb(null, s));
    });
    connect.on('error', cb);
    connect.end();
  };
  return agent;
}
const proxyAgent = PROXY ? makeTunnelAgent(PROXY) : null;

// ---------- Telegram API ----------
function tgRequest(method, { query, body, headers = {}, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${TG_BASE}/bot${TOKEN}/${method}`);
    if (query) u.search = new URLSearchParams(query).toString();
    const httpMod = u.protocol === 'https:' ? https : http;
    const req = httpMod.request(u, { method: body ? 'POST' : 'GET', headers, agent: u.protocol === 'https:' ? proxyAgent : undefined }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Telegram 响应异常: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    // 网络挂起兜底：默认 90s 超时（getUpdates 长轮询由调用方传 timeoutMs=0）
    if (timeoutMs !== 0) req.setTimeout(timeoutMs || 90000, () => req.destroy(new Error(method + ' 请求超时')));
    if (body) req.write(body);
    req.end();
  });
}

function buildMultipart(fields) {
  const boundary = '----wxbot' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const chunks = [];
  for (const [name, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"`));
    if (v instanceof Buffer) {
      chunks.push(Buffer.from(`; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
      chunks.push(v, Buffer.from('\r\n'));
    } else if (v && typeof v === 'object' && v.data instanceof Buffer) {
      // 文件字段支持指定文件名: { data: Buffer, filename: 'xxx.mp4', contentType?: 'video/mp4' }
      chunks.push(Buffer.from(`; filename="${v.filename || name}"\r\nContent-Type: ${v.contentType || 'application/octet-stream'}\r\n\r\n`));
      chunks.push(v.data, Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(`\r\n\r\n${v}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

const sendMessage = (chatId, text) => tgRequest('sendMessage', { query: { chat_id: chatId, text } });
const sendChatAction = (chatId, action) => tgRequest('sendChatAction', { query: { chat_id: chatId, action } });
const answerCallback = (id, text) => tgRequest('answerCallbackQuery', { query: { callback_query_id: id, text } });

// ---------- 视频尺寸探测 ----------
// Telegram 服务端解析不了这些 mp4（tkhd 的 width/height 为 0），抓不到真实尺寸时会退回方图缩略图
// 当视频尺寸 —— 客户端按 1:1 布局，竖屏视频就被拉伸。官方客户端上传时会附带 width/height/duration，
// 所以这里同样用 ffprobe 取真实尺寸一并上传；取不到则退回旧行为（仅缺尺寸，不影响发送成功与否）。
const FFPROBE = process.env.FFPROBE || 'ffprobe';
let probeWarned = false;
const probeCache = new Map();
function probeVideoMeta(file) {
  let key;
  try { const st = fs.statSync(file); key = `${file}:${st.size}:${st.mtimeMs}`; } catch { return null; }
  if (probeCache.has(key)) return probeCache.get(key);
  let meta = null;
  try {
    const out = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_side_data=rotation:format=duration', '-of', 'json', file], { timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
    const j = JSON.parse(out.toString());
    const s = j.streams && j.streams[0];
    if (s && s.width && s.height) {
      let w = +s.width, h = +s.height;
      const rot = Math.abs((((s.side_data_list || [])[0] || {}).rotation || 0) % 180);
      if (rot === 90) [w, h] = [h, w];   // 带旋转的视频：显示尺寸与编码尺寸互换
      const dur = j.format && parseFloat(j.format.duration);
      meta = { width: w, height: h, duration: dur > 0 ? Math.round(dur) : null };
    }
  } catch (e) {
    if (!probeWarned) {
      probeWarned = true;
      log('⚠️ ffprobe 不可用，视频尺寸交由 Telegram 推断（部分竖屏视频比例可能显示不对）:', String(e.message).slice(0, 80));
    }
  }
  probeCache.set(key, meta);
  return meta;
}

async function sendVideoWithButton(chatId, filePath, shortId, fileSize, replyToMsgId, mention, title, backlog, opts = {}) {
  const { caption = true, button = true } = opts;
  const data = fs.readFileSync(filePath);
  const fields = {
    chat_id: String(chatId),
    video: { data, filename: path.basename(filePath), contentType: 'video/mp4' },
    supports_streaming: 'true',
  };
  if (button) {
    fields.reply_markup = JSON.stringify({ inline_keyboard: [[{ text: `📥 获取原文件 ${(fileSize / 1048576).toFixed(1)} MB`, callback_data: 'orig_' + shortId }]] });
  }
  // 频道同步等无「被回复消息」的场景不传该字段（空串会被 Telegram 判为非法）
  if (replyToMsgId) fields.reply_to_message_id = String(replyToMsgId);
  // 附带真实尺寸（缺了会被 Telegram 用方图缩略图当尺寸，导致比例失真）
  const vmeta = probeVideoMeta(filePath);
  if (vmeta) {
    fields.width = String(vmeta.width);
    fields.height = String(vmeta.height);
    if (vmeta.duration) fields.duration = String(vmeta.duration);
  }
  // 视频标题（单行化）+ 补发标注 + 群聊时 @ 原消息发送人（caption=false 时整段不发）
  let cap = caption && title ? String(title).replace(/\s*\n+\s*/g, ' ').trim().slice(0, 1024) : '';
  if (backlog && cap) cap = `${cap}（补发）`;
  if (cap) {
    if (mention && mention.type === 'username') {
      fields.caption = `${cap}\n${mention.value}`;
    } else if (mention && mention.type === 'text_mention') {
      fields.caption = `${cap}\n${mention.value}`;
      fields.caption_entities = JSON.stringify([{ type: 'text_mention', offset: cap.length + 1, length: mention.value.length, user: { id: mention.userId } }]);
    } else {
      fields.caption = cap;
    }
  } else if (caption && mention) {   // 无标题时的兜底（保留纯 @）
    if (mention.type === 'username') {
      fields.caption = mention.value;
    } else {
      fields.caption = mention.value;
      fields.caption_entities = JSON.stringify([{ type: 'text_mention', offset: 0, length: mention.value.length, user: { id: mention.userId } }]);
    }
  }
  const { body, contentType } = buildMultipart(fields);
  const r = await tgRequest('sendVideo', { body, headers: { 'content-type': contentType } });
  // 自检：Telegram 回报的尺寸若与真实尺寸长宽比不符，说明它仍按缩略图猜尺寸（比例会失真）
  if (vmeta && r.ok && r.result && r.result.video && r.result.video.width && r.result.video.height) {
    const local = vmeta.width / vmeta.height;
    const got = r.result.video.width / r.result.video.height;
    if (Math.abs(local - got) / local > 0.01) {
      log(`⚠️ 尺寸被 Telegram 误判（比例会失真）: 本地 ${vmeta.width}x${vmeta.height} → Telegram ${r.result.video.width}x${r.result.video.height} | ${path.basename(filePath)}`);
    }
  }
  return r;
}

async function sendDocumentFile(chatId, filePath) {
  const data = fs.readFileSync(filePath);
  const { body, contentType } = buildMultipart({
    chat_id: String(chatId),
    document: { data, filename: path.basename(filePath), contentType: 'video/mp4' },
  });
  return tgRequest('sendDocument', { body, headers: { 'content-type': contentType } });
}

// 429 限流退避重试
async function tgWithRetry(fn, attempts = 3) {
  for (let i = 1; ; i++) {
    const r = await fn();
    if (r.ok) return r;
    const retryAfter = r.parameters && r.parameters.retry_after || 3;
    if (i >= attempts) throw new Error('Telegram 拒绝: ' + (r.description || ''));
    log('Telegram 429/error, retry in ' + retryAfter + 's:', r.description);
    await new Promise((r2) => setTimeout(r2, retryAfter * 1000));
  }
}

// ---------- 并发下载限制 ----------
class Semaphore {
  constructor(n) { this.n = n; this.queue = []; this.active = 0; }
  async acquire() {
    if (this.active < this.n) { this.active++; return; }
    await new Promise((r) => this.queue.push(r));
    this.active++;
  }
  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}
const dlSem = new Semaphore(MAX_CONCURRENT_DOWNLOADS);

// ---------- 全局缓存索引（短码 → 文件，平铺于 downloads/ 根） ----------
const CACHE_FILE = path.join(DOWNLOADS_DIR, 'cache.json');
function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function saveCache(c) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2));
}
function cachePathOf(entry) {
  return entry && path.join(DOWNLOADS_DIR, entry.file);
}
function cacheFileExists(entry) {
  const p = cachePathOf(entry);
  return !!(p && fs.existsSync(p) && fs.statSync(p).size > 0);
}

// 频道同步去重：同一视频每个频道只同步一次（标记存在 cache.json 的条目里：mirroredChannel 记录已同步到的频道）
// 先占位后发送：并发请求同时到达时只有一个能占到；发送失败回滚，便于下次重试
function claimMirror(shortCode, target) {
  return withIoLock(() => {
    const c = loadCache();
    const e = c[shortCode];
    if (!e) return true;                     // 条目缺失（缓存被清）时放行，不做去重
    if (e.mirroredChannel === target) return false;
    e.mirroredChannel = target;
    saveCache(c);
    return true;
  });
}
function unclaimMirror(shortCode, target) {
  return withIoLock(() => {
    const c = loadCache();
    const e = c[shortCode];
    if (e && e.mirroredChannel === target) { delete e.mirroredChannel; saveCache(c); }
  });
}

// 索引文件（cache.json / meta.json）读改写串行化，避免并发丢失条目
// 进程内：ioChain 串行；跨进程（补发模式与常驻机器人同时改索引）：索引锁文件互斥
let ioChain = Promise.resolve();
function withIoLock(fn) {
  const run = ioChain.then(() => withFileLock(fn), () => withFileLock(fn));
  ioChain = run.catch(() => {});
  return run;
}

const LOCK_FILE = path.join(DOWNLOADS_DIR, '.io.lock');
const LOCK_STALE_MS = 30000;      // 单次临界区仅做本地 JSON 读写（毫秒级），超时视为残留锁
async function withFileLock(fn) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const t0 = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(LOCK_FILE); continue; } } catch {}
      if (Date.now() - t0 > LOCK_STALE_MS) {   // 持有者异常：抢锁继续，避免机器人卡死
        try { fs.unlinkSync(LOCK_FILE); } catch {}
        continue;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(LOCK_FILE); } catch {} }
}

// 同一短码的在途下载去重：并发请求共享同一次下载
const inFlight = new Map();
function dedupe(key, fn) {
  if (inFlight.has(key)) return inFlight.get(key);
  const p = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

// ---------- 核心流程 ----------
// FAKE_NETWORK 模式：假解析 + 假下载（测试用，不触网、不写真实视频）
async function resolveOrFake(id) {
  if (FAKE) return { url: '', key: Buffer.alloc(0), title: '测试视频', fileSize: 3 * 1024 * 1024 };
  return resolveVideo(id);
}
async function downloadOrFake(info, filePath) {
  if (FAKE) {
    const delay = parseInt(process.env.FAKE_DELAY || '0', 10);   // 测试排队场景时模拟慢下载
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    fs.writeFileSync(filePath, Buffer.alloc(1024 * 512, 7));
    return 1024 * 512;
  }
  return downloadVideo(info, filePath);
}

// 群聊回复视频时 @ 原消息发送人（有 username 用 @mention；没有则用 text_mention 按 user id 提及）
function buildMention(chatType, from) {
  if (chatType === 'private' || !from) return null;
  if (from.username) return { type: 'username', value: '@' + from.username };
  const name = String(from.first_name || '用户').slice(0, 64);
  return { type: 'text_mention', value: name, userId: from.id };
}

// 同步频道（每个视频回复成功后额外发一份到该频道）：动态读配置，改完即时生效；空=关闭
function mirrorChannelId() {
  const v = loadConfig().channelId;
  return v == null || v === '' ? null : String(v);
}
// 频道那份是否带标题文本 / 「获取原文件」按钮（bot.config.json: channelCaption / channelButton，默认都开）
function mirrorOpts() {
  const c = loadConfig();
  return { caption: c.channelCaption !== false, button: c.channelButton !== false };
}

async function processLink(chatId, userId, link, replyToMsgId, chatType, from, who, backlog) {
  // 进度消息：reply 到用户消息，首条 sendMessage 创建，后续 editMessageText 原地更新，结束 deleteMessage 清理
  let statusMsgId = null;
  const status = async (text) => {
    if (statusMsgId == null) {
      const r = await tgRequest('sendMessage', { query: { chat_id: chatId, text, reply_to_message_id: replyToMsgId } });
      statusMsgId = r.ok ? r.result.message_id : null;
    } else {
      await tgRequest('editMessageText', { query: { chat_id: chatId, message_id: statusMsgId, text } }).catch(() => {});
    }
  };
  const statusDone = async () => {
    if (statusMsgId != null) {
      await tgRequest('deleteMessage', { query: { chat_id: chatId, message_id: statusMsgId } }).catch(() => {});
      statusMsgId = null;
    }
  };

  // 进入全局任务池（并发上限 MAX_TASKS，超限回复排队位置）
  const slot = await taskPool.acquire();
  if (slot.position > 0) {
    log(`${who} 任务进入池: 排队第 ${slot.position} 位（活跃 ${taskPool.active}/${MAX_TASKS}）`);
    await status(`⏳ 当前任务较多，已排队（第 ${slot.position} 位）...`);
  } else {
    log(`${who} 任务进入池: 立即执行（活跃 ${taskPool.active}/${MAX_TASKS}）`);
  }
  const release = await slot.release;   // 立即获取者即刻返回；排队者等待空位
  try {

    let info, id, shortCode;
    try {
      await status('🔄 正在解析...');
      id = link;   // 调用方已通过 parseId 校验并归一化为 <短码>##N
      shortCode = id.split('##')[0];
      const t0 = Date.now();
      info = await resolveOrFake(id);
      log(`${who} 解析成功: ${info.title} | ${(info.fileSize / 1048576).toFixed(1)} MB | ${Date.now() - t0}ms`);
    } catch (e) {
      await status('❌ 解析失败: ' + e.message.slice(0, 200));
      log(`${who} ❌ 解析失败: ${e.message}`);
      return;   // 失败保留错误消息（不删除）
    }

    const base = cleanTitle(info.title, 'video');
    const cache = loadCache();
    const entry = cache[shortCode];

    let filePath;
    if (cacheFileExists(entry)) {
      // 缓存命中：直接复用，不重复下载
      filePath = cachePathOf(entry);
      log(`${who} 缓存命中: ${entry.file}`);
    } else {
      // 未命中：下载（文件名用 wx 独占创建原子分配，并发不冲突）
      await status(`⬇️ 正在下载（${(info.fileSize / 1048576).toFixed(1)} MB）...`);
      const dlT0 = Date.now();
      try {
        await dedupe(shortCode, async () => {
          // 等待者进入时第一个可能已完成，再查一次
          if (cacheFileExists(loadCache()[shortCode])) return;
          fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          const base2 = base;
          // 同名文件已存在：先校验是否同一视频（文件字节数一致视为同一，直接复用不重复下载）
          const existPath = path.join(DOWNLOADS_DIR, base2 + '.mp4');
          if (fs.existsSync(existPath) && fs.statSync(existPath).size === info.fileSize) {
            log(`${who} 同名文件且大小一致（同一视频），直接复用: ${base2}.mp4`);
            await withIoLock(() => {
              const c = loadCache();
              c[shortCode] = { file: base2 + '.mp4', size: info.fileSize };
              saveCache(c);
            });
            return;
          }
          let file = base2 + '.mp4', n = 2, fd = null;
          for (;;) {   // 独占创建，已存在则换序号
            try { fd = fs.openSync(path.join(DOWNLOADS_DIR, file), 'wx'); break; }
            catch (e) { if (e.code === 'EEXIST') { file = `${base2} (${n++}).mp4`; continue; } throw e; }
          }
          fs.closeSync(fd);
          await dlSem.acquire();
          try { await downloadOrFake(info, path.join(DOWNLOADS_DIR, file)); } finally { dlSem.release(); }
          await withIoLock(() => {
            const c = loadCache();
            c[shortCode] = { file, size: info.fileSize };
            saveCache(c);
          });
        });
        // 权威路径以缓存为准（并发等待者可能由他人完成下载）
        const fin = loadCache()[shortCode];
        if (fin) filePath = cachePathOf(fin);
        log(`${who} 下载完成: ${path.basename(filePath)} | ${(fs.statSync(filePath).size / 1048576).toFixed(1)} MB | ${Date.now() - dlT0}ms`);
      } catch (e) {
        await status('❌ 下载失败: ' + e.message.slice(0, 200));
        log(`${who} ❌ 下载失败: ${e.message}`);
        return;
      }
    }

    if (info.fileSize > MAX_UPLOAD) {
      await status(`⚠️ 视频 ${(info.fileSize / 1048576).toFixed(1)} MB 超过 Telegram 50MB 上限，无法发送。已保存到本机 downloads/${path.basename(filePath)}。`);
      return;
    }

    const shortId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await withIoLock(() => {
      const meta = loadGlobalMeta();
      meta[shortId] = { file: path.basename(filePath), size: info.fileSize };
      saveGlobalMeta(meta);
    });

    // 视频上传完成后再清理进度消息，避免用户看到"空白期"
    await status('⬆️ 正在上传...');
    await sendChatAction(chatId, 'upload_video');
    const upT0 = Date.now();
    try {
      await tgWithRetry(() => sendVideoWithButton(chatId, filePath, shortId, info.fileSize, replyToMsgId, buildMention(chatType, from), info.title, backlog));
      await statusDone();
      log(`${who} 发送成功: ${path.basename(filePath)} | ${(info.fileSize / 1048576).toFixed(1)} MB | 上传 ${Date.now() - upT0}ms`);
    } catch (e) {
      await status('❌ 上传失败: ' + e.message.slice(0, 200));
      log(`${who} ❌ 上传失败: ${e.message}`);
    }

    // 同步一份到指定频道（bot.config.json 的 channelId；同一视频每个频道只同步一次，失败只记日志）
    const mirror = mirrorChannelId();
    if (mirror && mirror !== String(chatId) && await claimMirror(shortCode, mirror)) {
      const mOpts = mirrorOpts();
      const mT0 = Date.now();
      try {
        await sendChatAction(mirror, 'upload_video');
        await tgWithRetry(() => sendVideoWithButton(mirror, filePath, shortId, info.fileSize, null, null, info.title, false, mOpts));
        log(`${who} 已同步频道 ${mirror}: ${path.basename(filePath)} | 上传 ${Date.now() - mT0}ms`);
      } catch (e) {
        await unclaimMirror(shortCode, mirror);
        log(`${who} ⚠️ 同步频道失败 ${mirror}: ${e.message}`);
      }
    }
  } finally {
    release();
  }
}

async function handleCallback(query) {
  const data = query.data || '';
  if (!data.startsWith('orig_')) return;
  const shortId = data.slice(5);
  const chatId = query.message ? query.message.chat.id : null;
  const userId = query.from ? query.from.id : null;
  const who = describeSender(query.message ? query.message.chat : null, query.from);
  const meta = loadGlobalMeta();
  const rec = meta[shortId];
  if (!rec) {
    log(`${who} 原文件按钮: 记录缺失 shortId=${shortId}`);
    await answerCallback(query.id, '原文件已过期或已被清理');
    return;
  }
  const filePath = path.join(DOWNLOADS_DIR, rec.file);
  if (!fs.existsSync(filePath)) {
    log(`${who} 原文件按钮: 文件不存在 ${rec.file}`);
    await answerCallback(query.id, '文件已不存在');
    return;
  }
  log(`${who} 原文件按钮: ${rec.file} (${(rec.size / 1048576).toFixed(1)} MB)`);
  await answerCallback(query.id, '正在发送原文件...');
  try {
    await sendChatAction(chatId, 'upload_document');
    await tgWithRetry(() => sendDocumentFile(chatId, filePath));
    log(`${who} 原文件发送成功: ${rec.file}`);
  } catch (e) {
    await sendMessage(chatId, '❌ 原文件发送失败: ' + e.message.slice(0, 200));
    log(`${who} ❌ 原文件发送失败: ${e.message}`);
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const who = describeSender(msg.chat, msg.from);
  const rawText = (msg.text || '').trim();
  if (!rawText || !msg.from) return;

  const cfg = loadConfig();
  const allowed = cfg.allowedUsers;
  if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(userId)) {
    log(`${who} 拒绝: 不在白名单 ${JSON.stringify(allowed)}`);
    await sendMessage(chatId, '❌ 该机器人仅限指定用户使用。');
    return;
  }

  if (rawText === '/start' || rawText === '/help') {
    await sendMessage(chatId, '🎬 视频号下载机器人\n\n直接发送微信视频号分享链接即可下载视频，例如：\nhttps://weixin.qq.com/sph/XXXX\n\n支持格式：\n• weixin.qq.com/sph/ 分享链接\n• channels.weixin.qq.com/finder-preview?id= 链接\n• 直接发视频短码\n\n说明：\n• 群里发链接会自动识别，非微信链接不会处理\n• 同一个视频只会下载一次，重复请求直接复用\n• 单视频不超过 50MB（Telegram 上限），更大的视频会提示并保留在本机');
    return;
  }

  // 提取本条消息里的所有微信视频号链接（私聊额外支持整条纯短码）
  const isPrivate = msg.chat.type === 'private';
  if (!isPrivate && !/(weixin\.qq\.com\/sph\/|channels\.weixin\.qq\.com\/finder-preview\/pages\/sph)/.test(rawText)) return;
  const ids = [];
  for (const m of rawText.matchAll(/https?:\/\/\S+/g)) {
    try { ids.push(parseId(m[0])); } catch {}
  }
  if (ids.length === 0 && isPrivate && /^[A-Za-z0-9_-]+$/.test(rawText.trim())) {
    try { ids.push(parseId(rawText.trim())); } catch {}
  }
  if (ids.length === 0) return;   // 不是视频号链接，静默忽略
  const uniqueIds = [...new Set(ids)];

  // 停机期间发的消息（消息时间早于当前 10 分钟以上）标记为补发
  const backlog = !!msg.date && Date.now() / 1000 - msg.date > 600;
  log(`${who} ${backlog ? '[补发] ' : ''}收到${isPrivate ? '私聊' : '群聊'}链接 ${uniqueIds.length} 条: ${uniqueIds.map((i) => i.split('##')[0]).join(', ')} | 原文: ${rawText.slice(0, 80)}`);
  for (const id of uniqueIds) {
    await processLink(chatId, userId, id, msg.message_id, msg.chat.type, msg.from, who, backlog);
  }
}

// ---------- 补发模式（--backfill）：把历史下载的视频陆续同步到频道 ----------
// node bot.mjs --backfill [--limit N] [--interval S] [--dry-run]
// 可与常驻机器人同时运行（索引读写走跨进程锁）；按下载时间先后发，成功后记 mirroredChannel，可中断续跑
function argValue(name, def) {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : null;
  return v != null && !v.startsWith('--') ? v : def;
}
const sha1File = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
// 文件名 → 标题：去掉扩展名与同名去重后缀「 (2)」
const captionOf = (file) => file.replace(/\.mp4$/i, '').replace(/ \(\d+\)$/, '');

async function backfill() {
  const dryRun = process.argv.includes('--dry-run');
  const limit = Math.max(0, parseInt(argValue('--limit', '0'), 10) || 0);
  const intervalMs = Math.max(0, parseFloat(argValue('--interval', '3')) || 0) * 1000;
  const channel = mirrorChannelId();
  if (!channel) { log('[补发] ❌ bot.config.json 未配置 channelId'); return 1; }
  // 频道那份是否带标题文本 / 「获取原文件」按钮：跟随配置，命令行可强制关掉
  const cfgOpts = mirrorOpts();
  const sendOpts = { caption: cfgOpts.caption && !process.argv.includes('--no-caption'), button: cfgOpts.button && !process.argv.includes('--no-button') };

  // 1) 收集：同一文件只算一次，按下载时间升序
  const cache = loadCache();
  const seenFile = new Set();
  const all = [], missing = [];
  for (const [shortCode, e] of Object.entries(cache)) {
    if (!e || !e.file || seenFile.has(e.file)) continue;
    seenFile.add(e.file);
    const p = cachePathOf(e);
    let st;
    try { st = fs.statSync(p); } catch { missing.push(e.file); continue; }
    all.push({ shortCode, file: e.file, path: p, size: st.size, mtime: st.mtimeMs });
  }
  all.sort((a, b) => a.mtime - b.mtime);

  // 2) 内容去重：同字节数才比对 sha1（同内容只发一次，其余记为同内容条目）
  const sizeCount = new Map();
  for (const it of all) sizeCount.set(it.size, (sizeCount.get(it.size) || 0) + 1);
  const seenKey = new Map();
  const items = [], dupes = [], tooBig = [];
  for (const it of all) {
    if (it.size > MAX_UPLOAD) { tooBig.push(it); continue; }
    const key = sizeCount.get(it.size) > 1 ? 'sha1:' + sha1File(it.path) : 'size:' + it.size;
    const first = seenKey.get(key);
    if (first) { dupes.push({ it, first }); continue; }
    seenKey.set(key, it);
    items.push(it);
  }

  const mirrored = (shortCode) => (loadCache()[shortCode] || {}).mirroredChannel === channel;
  const pending = items.filter((it) => !mirrored(it.shortCode));
  const batch = limit > 0 ? pending.slice(0, limit) : pending;
  const bytes = batch.reduce((a, it) => a + it.size, 0);

  log(`[补发] 频道 ${channel} | 唯一内容 ${items.length} | 已同步 ${items.length - pending.length} | 待补发 ${pending.length} | 同内容 ${dupes.length} | 超限 ${tooBig.length} | 缺失 ${missing.length}`);
  if (tooBig.length) log(`[补发] 超 50MB 无法发送: ${tooBig.map((x) => x.file).join(', ')}`);
  if (missing.length) log(`[补发] 文件不存在: ${missing.join(', ')}`);
  log(`[补发] 本次 ${batch.length} 条，合计 ${(bytes / 1048576).toFixed(1)} MB，间隔 ${intervalMs / 1000}s，标题${sendOpts.caption ? '开' : '关'}，按钮${sendOpts.button ? '开' : '关'}${dryRun ? '（--dry-run，不发送）' : ''}`);

  if (dryRun) {
    for (const [i, it] of batch.entries()) {
      log(`[补发] #${i + 1} ${it.file} | ${(it.size / 1048576).toFixed(1)} MB | ${new Date(it.mtime).toISOString().slice(0, 16).replace('T', ' ')}`);
    }
    log(`[补发] 预计 ≥ ${Math.ceil(batch.length * intervalMs / 1000)}s（上传时间另计）`);
    return 0;
  }

  // 3) 逐条补发：先占位（跨进程去重）→ 发视频（带「获取原文件」按钮）→ 失败回滚标记，下次重跑自动重试
  let sent = 0, failed = 0;
  for (const [i, it] of batch.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, intervalMs));
    if (!(await claimMirror(it.shortCode, channel))) { log(`[补发] 跳过（已被其他进程同步）: ${it.file}`); continue; }
    const shortId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const t0 = Date.now();
    try {
      await withIoLock(() => {
        const meta = loadGlobalMeta();
        meta[shortId] = { file: it.file, size: it.size };
        saveGlobalMeta(meta);
      });
      await sendChatAction(channel, 'upload_video');
      await tgWithRetry(() => sendVideoWithButton(channel, it.path, shortId, it.size, null, null, captionOf(it.file), false, sendOpts));
      sent++;
      log(`[补发] ${i + 1}/${batch.length} 已发送: ${it.file} | ${(it.size / 1048576).toFixed(1)} MB | ${Date.now() - t0}ms | 剩余 ${batch.length - i - 1}`);
    } catch (e) {
      failed++;
      await unclaimMirror(it.shortCode, channel);
      log(`[补发] ${i + 1}/${batch.length} ❌ 失败: ${it.file} | ${e.message}`);
    }
  }

  // 4) 同内容条目：内容已在频道里，标记为已同步，避免以后被请求时重复发
  let dupMarked = 0;
  for (const { it, first } of dupes) {
    if (mirrored(first.shortCode) && await claimMirror(it.shortCode, channel)) dupMarked++;
  }

  const left = items.filter((it) => !mirrored(it.shortCode)).length;
  log(`[补发] 完成：成功 ${sent}，失败 ${failed}，同内容标记 ${dupMarked}；剩余待补发 ${left} 条（再跑一次继续）`);
  return failed ? 1 : 0;
}

// ---------- 长轮询主循环 ----------
let botUsername = '';
let offset = 0;

// 全局任务并发池：MAX_TASKS 来自配置文件（bot.config.json 的 maxTasks）
// 统一 release 语义：立即获取者和排队被唤醒者都拿到各自的 release，任务完成后必须释放槽位
class TaskPool {
  constructor(n) { this.n = n; this.active = 0; this.waiters = []; }
  acquire() {
    if (this.active < this.n) {
      this.active++;
      return { position: 0, release: Promise.resolve(this._release()) };
    }
    const position = this.waiters.length + 1;
    let resolveRelease;
    const releasePromise = new Promise((r) => { resolveRelease = r; });
    this.waiters.push(() => resolveRelease(this._release()));
    return { position, release: releasePromise };
  }
  _release() {
    return () => {
      this.active--;
      const w = this.waiters.shift();
      if (w) { this.active++; w(); }   // 槽位转移给下一个等待者
    };
  }
}
const taskPool = new TaskPool(MAX_TASKS);

async function poll() {
  while (true) {
    try {
      const r = await tgRequest('getUpdates', { query: { offset, timeout: 50, allowed_updates: '["message","callback_query"]' }, timeoutMs: 0 });
      if (!r.ok) {
        if (r.description && r.description.includes('Conflict')) {
          log('❌ 409 冲突：同一个 bot token 有多个实例在轮询，请停掉其他实例。');
          process.exit(1);
        }
        log('getUpdates 错误:', r.description);
        await new Promise((r2) => setTimeout(r2, 3000));
        continue;
      }
      for (const u of r.result) {
        offset = Math.max(offset, u.update_id + 1);
        if (u.message) {
          handleMessage(u.message).catch((e) => log('处理消息出错:', e.message));
        } else if (u.callback_query) {
          handleCallback(u.callback_query).catch((e) => log('处理回调出错:', e.message));
        }
      }
    } catch (e) {
      // 长轮询连接被服务端/代理周期性断开是正常现象，静默并快速重连
      const msg = e.message + ' ' + (e.cause && e.cause.code || '');
      if (!/socket hang up|ECONNRESET|ETIMEDOUT/.test(msg)) log('轮询异常:', e.message);
      await new Promise((r2) => setTimeout(r2, 1000));
    }
  }
}

// ---------- 启动 ----------
async function waitForMe() {
  for (let i = 1; ; i++) {
    try {
      const me = await tgRequest('getMe');
      if (me.ok) return me.result;
      console.error('getMe 失败:', me.description || JSON.stringify(me));
    } catch (e) {
      console.error(`getMe 连接失败 (第${i}次重试):`, e.message);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// 兜底：任何未捕获异常只记录日志，不让进程退出
process.on('unhandledRejection', (e) => log('未处理的 Promise 异常:', e && e.message));
process.on('uncaughtException', (e) => log('未捕获异常:', e && e.message));

const me = await waitForMe();
if (!me.username) {
  console.error('❌ getMe 返回异常:', JSON.stringify(me));
  console.error('   请检查：1) TG_BOT_TOKEN 是否正确  2) 代理是否可用（http_proxy/https_proxy）');
  process.exit(1);
}
botUsername = me.username;

// 补发模式：把历史下载的视频陆续同步到频道后退出（不启动轮询，避免与常驻实例 409 冲突）
if (process.argv.includes('--backfill')) {
  process.exit(await backfill());
}

// 设置命令菜单（用户在 Telegram 输入 / 时可见）
try {
  const r = await tgRequest('setMyCommands', {
    query: {
      commands: JSON.stringify([
        { command: 'start', description: '使用说明：发送微信视频号分享链接即可下载' },
        { command: 'help', description: '查看使用方法与支持格式' },
      ]),
    },
  });
  log('命令菜单: ' + (r.ok ? '已设置 ✓' : '设置失败 ' + (r.description || '')));
} catch (e) {
  log('命令菜单设置失败:', e.message);
}
const cfg = loadConfig();
const whitelist = Array.isArray(cfg.allowedUsers) && cfg.allowedUsers.length > 0
  ? '白名单: ' + cfg.allowedUsers.join(', ')
  : '白名单: 未配置（所有人可用，可在 bot.config.json 加 "allowedUsers": [用户ID] 限制）';
log(`🤖 @${botUsername} 运行中 | 代理: ${PROXY ? PROXY.host + ':' + PROXY.port : '直连(可能失败)'} | ${whitelist}`);
log(`下载目录: ${DOWNLOADS_DIR}`);
poll();
