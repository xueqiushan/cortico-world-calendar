/**
 * 桌面日历的本地小服务。只用 Node 内置模块，零依赖。
 *
 * 为什么需要它：`file://` 下浏览器 fetch 读本地文件会被 Chromium 直接拒绝，
 * 那不是加响应头能解决的（调研已确认）。所以网页必须有个 http 源。
 *
 * 它是独立进程，不依赖 Coopanion —— Coopanion 关了，日历照样看、照样改、照样弹提醒。
 * 这是当初设计"兜底"的意义，别把它塞进插件进程里。
 *
 * 安全边界：只监听 127.0.0.1，不接受跨 origin，不暴露文件路径，不做通配 CORS。
 */
import { createServer } from 'node:http';
import { mkdir, readFile, rename, unlink, watch, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.CALENDAR_FILE || join(HERE, 'calendar.json');
const HTML_FILE = join(HERE, 'calendar.html');

const PORT_START = Number(process.env.CALENDAR_PORT || 8787);
const PORT_TRIES = 5;
/** 单次提交大小上限，防止误传把文件撑爆。 */
const MAX_BODY = 2 * 1024 * 1024;

const EMPTY = { version: 0, events: [] };

function log(...args) {
  console.log('[calendar]', ...args);
}

async function readCalendar() {
  try {
    const raw = await readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY };
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 0,
      events: Array.isArray(parsed.events) ? parsed.events : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

/** 原子写：写 tmp → rename。和插件那头同一套约定，避免写出半截文件。 */
async function writeCalendar(data) {
  const next = { version: (data.version ?? 0) + 1, events: Array.isArray(data.events) ? data.events : [] };
  await mkdir(dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp.${process.pid}.${randomUUID().slice(0, 6)}`;
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await rename(tmp, DATA_FILE);
  return next;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** 只允许本机来源，别让别的本地网页来调。 */
function localOnly(req, res) {
  const host = (req.headers.host || '').split(':')[0];
  const origin = req.headers.origin;
  const okHost = host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  const okOrigin = !origin || /^https?:\/\/(127\.0\.0\.1|localhost)(\:\d+)?$/.test(origin);
  if (!okHost || !okOrigin) {
    sendJson(res, 403, { error: '只允许本机访问。' });
    return false;
  }
  return true;
}

// —— SSE：文件一变就推 ——

const clients = new Set();
let watcher = null;
let debounceTimer = null;

function startWatch() {
  if (watcher || !existsSync(DATA_FILE)) return;
  try {
    watcher = watch(DATA_FILE, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      // 编辑器可能连写多次，合并一下再推。
      debounceTimer = setTimeout(() => broadcast(), 120);
    });
    watcher.on('error', () => {
      try {
        watcher?.close();
      } catch {}
      watcher = null;
    });
  } catch {
    // 监听失败不算致命：客户端还有轮询兜底。
  }
}

async function broadcast() {
  if (clients.size === 0) return;
  const data = await readCalendar();
  const payload = `event: change\ndata: ${JSON.stringify({ version: data.version })}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

const server = createServer(async (req, res) => {
  if (!localOnly(req, res)) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    if (req.method === 'GET' && (path === '/' || path === '/calendar.html')) {
      const html = await readFile(HTML_FILE, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && path === '/api/calendar') {
      const data = await readCalendar();
      sendJson(res, 200, data);
      return;
    }

    if (req.method === 'PUT' && path === '/api/calendar') {
      let raw = '';
      let tooBig = false;
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_BODY) {
          tooBig = true;
          break;
        }
      }
      if (tooBig) return sendJson(res, 413, { error: '太大了。' });
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return sendJson(res, 400, { error: '不是合法 JSON。' });
      }
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.events)) {
        return sendJson(res, 400, { error: '要形如 { version, events: [...] }。' });
      }
      const saved = await writeCalendar(parsed);
      startWatch();
      await broadcast();
      sendJson(res, 200, saved);
      return;
    }

    if (req.method === 'GET' && path === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      res.write(`retry: 3000\n\n`);
      clients.add(res);
      // 心跳，免得中间层把连接掐了
      const hb = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(hb);
          clients.delete(res);
        }
      }, 25_000);
      req.on('close', () => {
        clearInterval(hb);
        clients.delete(res);
      });
      return;
    }

    if (req.method === 'GET' && path === '/api/health') {
      sendJson(res, 200, { ok: true, file: 'ok' });
      return;
    }

    sendJson(res, 404, { error: '没有这个地址。' });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

// 端口占用就往后再试几个。注意：端口一变 origin 就变，
// 通知权限和 localStorage 会失效，所以尽量让它稳定在第一个可用端口上。
let port = PORT_START;
for (let i = 0; i < PORT_TRIES; i++) {
  const tryPort = PORT_START + i;
  const ok = await new Promise((resolve) => {
    const onError = (e) => {
      if (e?.code === 'EADDRINUSE') resolve(false);
      else {
        log(`端口 ${tryPort} 起不来：${e?.message}`);
        resolve(false);
      }
    };
    server.once('error', onError);
    server.listen(tryPort, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve(true);
    });
  });
  if (ok) {
    port = tryPort;
    break;
  }
}

if (!server.listening) {
  log(`端口 ${PORT_START}–${PORT_START + PORT_TRIES - 1} 都被占了。先关掉占用它们的程序再试。`);
  process.exit(1);
}

if (!existsSync(DATA_FILE)) {
  await writeCalendar(EMPTY);
  log('已创建空的 calendar.json');
}
startWatch();

log(`桌面日历服务已启动`);
log(`数据文件：${DATA_FILE}`);
log(`在 Edge 打开：http://127.0.0.1:${port}/`);
log(`（想要独立窗口：Edge 菜单 → 应用 → 将此站点安装为应用）`);
log(`关掉这个窗口就停了；想开机自启，把这个目录的 start.bat 快捷方式放进 shell:startup`);
