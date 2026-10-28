import { createServer } from 'node:http';
import { readFile, writeFile, rename, unlink, mkdir, copyFile, constants } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SEED_FILE = resolve(ROOT, 'data/restaurants.json');
const MAX_BODY_BYTES = 256 * 1024;
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function text(value, field, max, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new HttpError(400, `${field}不能为空，且最多 ${max} 个字符。`);
  }
  return value.trim();
}

function validateRestaurant(input, { existing = false, imported = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '美食记录格式不正确。');
  const low = input.low ?? 25;
  const high = input.high ?? 50;
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high < low || high > 10000) {
    throw new HttpError(400, '预算应为大于零的数字，上限不能小于下限或超过 10000 元。');
  }
  const source = existing ? input.source : -1;
  if (!Number.isInteger(source) || source < -1) throw new HttpError(400, '美食来源编号格式不正确。');
  let id = 'c' + randomUUID();
  if (existing || imported) {
    if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id)) {
      throw new HttpError(400, '美食 ID 格式不正确。');
    }
    id = input.id;
  }
  return {
    id,
    name: text(input.name, '店名', 80),
    type: text(input.type, '分类', 40, '私藏好店'),
    low, high,
    zone: text(input.zone, '商圈', 80, '其他周边'),
    source,
    note: text(input.note, '推荐语', 300, '你的午餐私藏，值得再吃一次。'),
    emoji: text(input.emoji, '美食图标', 20, '🍱'),
  };
}

function sameShop(a, b) {
  const normalize = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  return normalize(a.name) === normalize(b.name) && normalize(a.zone) === normalize(b.zone);
}

async function readCatalog(file) {
  let catalog;
  try { catalog = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new HttpError(500, '美食数据文件读取失败，请检查 data/restaurants.json。'); }
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.restaurants)) {
    throw new HttpError(500, '美食数据文件格式不正确，应包含 schemaVersion 和 restaurants。');
  }
  try {
    const restaurants = catalog.restaurants.map(row => validateRestaurant(row, { existing: true }));
    if (new Set(restaurants.map(row => row.id)).size !== restaurants.length) throw new Error('duplicate ID');
    return { ...catalog, restaurants };
  } catch {
    throw new HttpError(500, '美食数据含无效记录或重复 ID，请检查 data/restaurants.json。');
  }
}

async function atomicSave(file, catalog) {
  const temporary = resolve(dirname(file), `.restaurants-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(catalog, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

async function readBody(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new HttpError(415, '请使用 application/json 提交美食数据。');
  }
  if (Number(request.headers['content-length']) > MAX_BODY_BYTES) {
    request.resume();
    throw new HttpError(413, '提交的数据太大了，请分批导入。');
  }
  let size = 0;
  let tooLarge = false;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) { tooLarge = true; continue; }
    chunks.push(chunk);
  }
  if (tooLarge) throw new HttpError(413, '提交的数据太大了，请分批导入。');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, '提交的数据不是有效的 JSON。'); }
}

function checkOrigin(request) {
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '请从当前页面保存美食。');
  if (!request.headers.origin) return;
  try {
    const origin = new URL(request.headers.origin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== request.headers.host) throw new Error();
  } catch { throw new HttpError(403, '请从当前页面保存美食。'); }
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

export async function createApp({ dataFile = SEED_FILE, publicDir = resolve(ROOT, 'public') } = {}) {
  dataFile = resolve(dataFile);
  if (dataFile !== SEED_FILE) {
    await mkdir(dirname(dataFile), { recursive: true });
    await copyFile(SEED_FILE, dataFile, constants.COPYFILE_EXCL).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
  }
  await readCatalog(dataFile);
  let queue = Promise.resolve();
  const mutate = operation => {
    const task = queue.then(async () => {
      const catalog = await readCatalog(dataFile);
      const result = operation(catalog.restaurants);
      catalog.updatedAt = new Date().toISOString();
      await atomicSave(dataFile, catalog);
      return { ...result, restaurants: catalog.restaurants };
    });
    queue = task.catch(() => {});
    return task;
  };

  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      const method = request.method;
      if (path.startsWith('/api/')) {
        if (method !== 'GET') checkOrigin(request);
        if (path === '/api/health' && method === 'GET') {
          const catalog = await readCatalog(dataFile);
          return sendJson(response, 200, { ok: true, restaurantCount: catalog.restaurants.length });
        }
        if (path === '/api/restaurants' && method === 'GET') {
          return sendJson(response, 200, await readCatalog(dataFile));
        }
        if (path === '/api/restaurants' && method === 'POST') {
          const restaurant = validateRestaurant(await readBody(request));
          const result = await mutate(restaurants => {
            if (restaurants.some(row => sameShop(row, restaurant))) throw new HttpError(409, '这家店已经在这个商圈的名单里啦。');
            restaurants.push(restaurant);
            return { restaurant };
          });
          return sendJson(response, 201, result);
        }
        if (path === '/api/restaurants/import' && method === 'POST') {
          const input = await readBody(request);
          if (!Array.isArray(input?.restaurants) || input.restaurants.length > 500) {
            throw new HttpError(400, '请一次导入最多 500 家美食。');
          }
          const incoming = input.restaurants.map(row => validateRestaurant(row, { imported: true }));
          const result = await mutate(restaurants => {
            let imported = 0;
            for (const restaurant of incoming) {
              if (restaurants.some(row => row.id === restaurant.id || sameShop(row, restaurant))) continue;
              restaurants.push(restaurant);
              imported++;
            }
            return { imported };
          });
          return sendJson(response, 200, result);
        }
        if (path.startsWith('/api/restaurants/') && method === 'DELETE') {
          const id = decodeURIComponent(path.slice('/api/restaurants/'.length));
          const result = await mutate(restaurants => {
            const index = restaurants.findIndex(row => row.id === id);
            if (index < 0) throw new HttpError(404, '这家私藏已经不在名单里了。');
            if (restaurants[index].source >= 0) throw new HttpError(403, '内置美食可先跳过，或在数据文件中编辑。');
            restaurants.splice(index, 1);
            return { removedId: id };
          });
          return sendJson(response, 200, result);
        }
        throw new HttpError(404, '没有找到这个接口。');
      }
      if (!['GET', 'HEAD'].includes(method)) throw new HttpError(405, '暂不支持这种操作。');
      const asset = STATIC_FILES.get(path);
      if (!asset) throw new HttpError(404, '页面不存在。');
      const content = await readFile(resolve(publicDir, asset[0]));
      response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
      response.end(method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!response.headersSent) sendJson(response, error.status || 500, { error: error.status ? error.message : '保存没成功，请稍后重试。' });
      else response.end();
      if (!error.status) console.error(error);
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('PORT 必须是 0–65535 之间的端口号。');
    process.exitCode = 1;
  } else {
    try {
      const dataFile = process.env.LETS_EAT_DATA_DIR
        ? resolve(process.env.LETS_EAT_DATA_DIR, 'restaurants.json') : SEED_FILE;
      const server = await createApp({ dataFile });
      server.on('error', error => {
        console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，可用 PORT=3001 npm start 换一个端口。` : error.message);
        process.exitCode = 1;
      });
      server.listen(port, host, () => {
        console.log(`饭点了已启动：http://${host}:${server.address().port}`);
        console.log(`美食数据：${dataFile}`);
        console.log('按 Ctrl+C 停止服务。');
      });
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
