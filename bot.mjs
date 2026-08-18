#!/usr/bin/env node
/**
 * bot.mjs — Telegram 微信视频下载机器人
 *
 * 用法:
 *   TG_BOT_TOKEN=<token> node bot.mjs            # 前台运行
 *   TG_BOT_TOKEN=<token> nohup node bot.mjs > bot.log 2>&1 &   # 后台运行
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
const log = (...a) => console.log(tzFmt.format(new Date()), ...a);

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
function tgRequest(method, { query, body, headers = {} } = {}) {
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

async function sendVideoWithButton(chatId, filePath, shortId, fileSize, replyToMsgId) {
  const data = fs.readFileSync(filePath);
  const { body, contentType } = buildMultipart({
    chat_id: String(chatId),
    reply_to_message_id: String(replyToMsgId || ''),
    video: data,
    supports_streaming: 'true',
    reply_markup: JSON.stringify({ inline_keyboard: [[{ text: `📥 获取原文件 ${(fileSize / 1048576).toFixed(1)} MB`, callback_data: 'orig_' + shortId }]] }),
  });
  return tgRequest('sendVideo', { body, headers: { 'content-type': contentType } });
}

async function sendDocumentFile(chatId, filePath) {
  const data = fs.readFileSync(filePath);
  const { body, contentType } = buildMultipart({
    chat_id: String(chatId),
    document: data,
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

// 索引文件（cache.json / meta.json）读改写串行化，避免并发丢失条目
let ioChain = Promise.resolve();
function withIoLock(fn) {
  const run = ioChain.then(fn, fn);
  ioChain = run.catch(() => {});
  return run;
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

async function processLink(chatId, userId, link, replyToMsgId) {
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
  if (slot.position > 0) log(`[${chatId}:${userId}] 任务进入池: 排队第 ${slot.position} 位（活跃 ${taskPool.active}/${MAX_TASKS}）`);
  else log(`[${chatId}:${userId}] 任务进入池: 立即执行（活跃 ${taskPool.active}/${MAX_TASKS}）`);
  try {
    if (slot.position > 0) await status(`⏳ 当前任务较多，已排队（第 ${slot.position} 位）...`);
    await slot.promise;

    let info, id, shortCode;
    try {
      await status('🔄 正在解析...');
      id = parseId(link);
      shortCode = id.split('##')[0];
      const t0 = Date.now();
      info = await resolveOrFake(id);
      log(`[${chatId}:${userId}] 解析成功: ${info.title} | ${(info.fileSize / 1048576).toFixed(1)} MB | ${Date.now() - t0}ms`);
    } catch (e) {
      await status('❌ 解析失败: ' + e.message.slice(0, 200));
      log(`[${chatId}:${userId}] ❌ 解析失败: ${e.message}`);
      return;   // 失败保留错误消息（不删除）
    }

    const base = cleanTitle(info.title, 'video');
    const cache = loadCache();
    const entry = cache[shortCode];

    let filePath;
    if (cacheFileExists(entry)) {
      // 缓存命中：直接复用，不重复下载
      filePath = cachePathOf(entry);
      log(`[${chatId}:${userId}] 缓存命中: ${entry.file}`);
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
        log(`[${chatId}:${userId}] 下载完成: ${path.basename(filePath)} | ${(fs.statSync(filePath).size / 1048576).toFixed(1)} MB | ${Date.now() - dlT0}ms`);
      } catch (e) {
        await status('❌ 下载失败: ' + e.message.slice(0, 200));
        log(`[${chatId}:${userId}] ❌ 下载失败: ${e.message}`);
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
      await tgWithRetry(() => sendVideoWithButton(chatId, filePath, shortId, info.fileSize, replyToMsgId));
      await statusDone();
      log(`[${chatId}:${userId}] 发送成功: ${path.basename(filePath)} | ${(info.fileSize / 1048576).toFixed(1)} MB | 上传 ${Date.now() - upT0}ms`);
    } catch (e) {
      await status('❌ 上传失败: ' + e.message.slice(0, 200));
      log(`[${chatId}:${userId}] ❌ 上传失败: ${e.message}`);
    }
  } finally {
    slot.release();
  }
}

async function handleCallback(query) {
  const data = query.data || '';
  if (!data.startsWith('orig_')) return;
  const shortId = data.slice(5);
  const chatId = query.message ? query.message.chat.id : null;
  const userId = query.from ? query.from.id : null;
  const meta = loadGlobalMeta();
  const rec = meta[shortId];
  if (!rec) {
    log(`[${chatId}:${userId}] 原文件按钮: 记录缺失 shortId=${shortId}`);
    await answerCallback(query.id, '原文件已过期或已被清理');
    return;
  }
  const filePath = path.join(DOWNLOADS_DIR, rec.file);
  if (!fs.existsSync(filePath)) {
    log(`[${chatId}:${userId}] 原文件按钮: 文件不存在 ${rec.file}`);
    await answerCallback(query.id, '文件已不存在');
    return;
  }
  log(`[${chatId}:${userId}] 原文件按钮: ${rec.file} (${(rec.size / 1048576).toFixed(1)} MB)`);
  await answerCallback(query.id, '正在发送原文件...');
  try {
    await sendChatAction(chatId, 'upload_document');
    await tgWithRetry(() => sendDocumentFile(chatId, filePath));
    log(`[${chatId}:${userId}] 原文件发送成功: ${rec.file}`);
  } catch (e) {
    await sendMessage(chatId, '❌ 原文件发送失败: ' + e.message.slice(0, 200));
    log(`[${chatId}:${userId}] ❌ 原文件发送失败: ${e.message}`);
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const rawText = (msg.text || '').trim();
  if (!rawText || !msg.from) return;

  const cfg = loadConfig();
  const allowed = cfg.allowedUsers;
  if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(userId)) {
    log(`[${chatId}:${userId}] 拒绝: 不在白名单 ${JSON.stringify(allowed)}`);
    await sendMessage(chatId, '❌ 该机器人仅限指定用户使用。');
    return;
  }

  if (rawText === '/start' || rawText === '/help') {
    await sendMessage(chatId, '🎬 视频号下载机器人\n\n直接发送微信视频号分享链接即可下载视频，例如：\nhttps://weixin.qq.com/sph/XXXX\n\n支持格式：\n• weixin.qq.com/sph/ 分享链接\n• channels.weixin.qq.com/finder-preview?id= 链接\n• 直接发视频短码\n\n说明：\n• 群里发链接会自动识别，非微信链接不会处理\n• 同一个视频只会下载一次，重复请求直接复用\n• 单视频不超过 50MB（Telegram 上限），更大的视频会提示并保留在本机');
    return;
  }

  // 私聊: 支持链接与直接短码; 群聊: 只识别含微信视频号链接的消息（不要求 @）
  const isPrivate = msg.chat.type === 'private';
  if (!isPrivate && !/(weixin\.qq\.com\/sph\/|channels\.weixin\.qq\.com\/finder-preview\/pages\/sph)/.test(rawText)) return;
  const link = rawText.trim();
  if (!link) return;

  try { parseId(link); } catch { return; }   // 不是视频号链接，静默忽略
  log(`[${chatId}:${userId}] 收到${isPrivate ? '私聊' : '群聊'}链接: ${parseId(link).split('##')[0]} | 原文: ${rawText.slice(0, 80)}`);
  await processLink(chatId, userId, link, msg.message_id);
}

// ---------- 长轮询主循环 ----------
let botUsername = '';
let offset = 0;

// 全局任务并发池：MAX_TASKS 来自配置文件（bot.config.json 的 maxTasks）
class TaskPool {
  constructor(n) { this.n = n; this.active = 0; this.waiters = []; }
  acquire() {
    if (this.active < this.n) {
      this.active++;
      return { position: 0, promise: Promise.resolve(), release: this._release() };
    }
    const position = this.waiters.length + 1;
    let resolveWait;
    const promise = new Promise((r) => { resolveWait = r; });
    this.waiters.push(resolveWait);
    return { position, promise, release: () => {} };
  }
  _release() {
    return () => {
      this.active--;
      const w = this.waiters.shift();
      if (w) { this.active++; w(); }
    };
  }
}
const taskPool = new TaskPool(MAX_TASKS);

async function poll() {
  while (true) {
    try {
      const r = await tgRequest('getUpdates', { query: { offset, timeout: 50, allowed_updates: '["message","callback_query"]' } });
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
