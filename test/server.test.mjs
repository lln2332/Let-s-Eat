import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

async function stop(server) {
  const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'lets-eat-test-'));
  const dataFile = join(directory, 'restaurants.json');
  let server;
  let base;
  async function start() {
    server = await createApp({ dataFile });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  await start();
  t.after(async () => { await stop(server); await rm(directory, { recursive: true, force: true }); });
  return {
    dataFile,
    async request(path, { method = 'GET', body, headers = {} } = {}) {
      const response = await fetch(base + path, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    fetch: path => fetch(base + path),
    async restart() { await stop(server); await start(); },
  };
}

const food = (name = '测试烧腊饭') => ({ name, type: '米饭简餐', zone: '其他周边', low: 20, high: 35, emoji: '🍚' });

test('serves all 46 seed restaurants and only public application files', async t => {
  const app = await fixture(t);
  const { status, body } = await app.request('/api/restaurants');
  assert.equal(status, 200);
  assert.equal(body.restaurants.length, 46);
  assert.equal(new Set(body.restaurants.map(row => row.id)).size, 46);
  const html = await app.fetch('/');
  assert.equal(html.status, 200);
  const source = await html.text();
  assert.match(source, /\/styles\.css/);
  assert.match(source, /\/app\.js/);
  assert.doesNotMatch(source, /<select\b/);
  for (const path of ['/.git/config', '/server.mjs', '/data/restaurants.json', '/package.json']) {
    assert.equal((await app.fetch(path)).status, 404);
  }
});

test('a name-only addition is saved to JSON, survives restart, and deletion survives another restart', async t => {
  const app = await fixture(t);
  const added = await app.request('/api/restaurants', { method: 'POST', body: { name: '楼下的午餐私藏' } });
  assert.equal(added.status, 201);
  const row = added.body.restaurant;
  assert.equal(row.source, -1);
  assert.equal(row.type, '私藏好店');
  assert.equal(row.high, 50);
  assert.equal(JSON.parse(await readFile(app.dataFile, 'utf8')).restaurants.at(-1).name, row.name);
  await app.restart();
  assert.ok((await app.request('/api/restaurants')).body.restaurants.some(r => r.id === row.id));
  assert.equal((await app.request('/api/restaurants/' + row.id, { method: 'DELETE' })).status, 200);
  await app.restart();
  assert.ok(!(await app.request('/api/restaurants')).body.restaurants.some(r => r.id === row.id));
});

test('duplicate shops, invalid prices, and built-in deletion leave the data file unchanged', async t => {
  const app = await fixture(t);
  const original = await readFile(app.dataFile, 'utf8');
  const seed = JSON.parse(original).restaurants[0];
  assert.equal((await app.request('/api/restaurants', { method: 'POST', body: { ...seed, name: '  ' + seed.name + '  ' } })).status, 409);
  assert.equal((await app.request('/api/restaurants', { method: 'POST', body: { ...food(), low: 80, high: 20 } })).status, 400);
  assert.equal((await app.request('/api/restaurants', { method: 'POST', body: { ...food(), high: '便宜' } })).status, 400);
  assert.equal((await app.request('/api/restaurants/' + seed.id, { method: 'DELETE' })).status, 403);
  assert.equal(await readFile(app.dataFile, 'utf8'), original);
});

test('concurrent additions do not overwrite each other or leave partial JSON', async t => {
  const app = await fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => app.request('/api/restaurants', { method: 'POST', body: food('并发保存店铺 ' + i) })));
  assert.ok(results.every(result => result.status === 201));
  const catalog = JSON.parse(await readFile(app.dataFile, 'utf8'));
  assert.equal(catalog.restaurants.length, 58);
  assert.equal(new Set(catalog.restaurants.map(row => row.id)).size, 58);
});

test('legacy browser import preserves IDs, deduplicates, and rejects an invalid batch without a partial save', async t => {
  const app = await fixture(t);
  const rows = [{ ...food('旧浏览器私藏一'), id: 'c-legacy-1' }, { ...food('旧浏览器私藏二'), id: 'c-legacy-2' }];
  const first = await app.request('/api/restaurants/import', { method: 'POST', body: { restaurants: rows } });
  assert.equal(first.status, 200);
  assert.equal(first.body.imported, 2);
  assert.ok(first.body.restaurants.some(row => row.id === 'c-legacy-1'));
  const second = await app.request('/api/restaurants/import', { method: 'POST', body: { restaurants: rows } });
  assert.equal(second.body.imported, 0);
  const before = await readFile(app.dataFile, 'utf8');
  const invalid = await app.request('/api/restaurants/import', { method: 'POST', body: { restaurants: [{ ...food('不该部分写入'), id: 'c-legacy-3' }, { ...food('错误价格'), id: 'c-legacy-4', low: -1 }] } });
  assert.equal(invalid.status, 400);
  assert.equal(await readFile(app.dataFile, 'utf8'), before);
});

test('cross-origin writes and non-JSON form submissions are rejected', async t => {
  const app = await fixture(t);
  const before = await readFile(app.dataFile, 'utf8');
  assert.equal((await app.request('/api/restaurants', { method: 'POST', body: food(), headers: { Origin: 'https://unrelated.example' } })).status, 403);
  assert.equal((await app.request('/api/restaurants', { method: 'POST', body: food(), headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal(await readFile(app.dataFile, 'utf8'), before);
});

test('manual JSON edits appear on the next load; invalid JSON is reported without resetting data', async t => {
  const app = await fixture(t);
  const catalog = JSON.parse(await readFile(app.dataFile, 'utf8'));
  catalog.restaurants[0].note = '这是直接在美食文档里修改的推荐语。';
  await writeFile(app.dataFile, JSON.stringify(catalog));
  assert.equal((await app.request('/api/restaurants')).body.restaurants[0].note, catalog.restaurants[0].note);
  await writeFile(app.dataFile, '{ invalid json');
  const result = await app.request('/api/restaurants');
  assert.equal(result.status, 500);
  assert.match(result.body.error, /数据文件/);
  assert.equal(await readFile(app.dataFile, 'utf8'), '{ invalid json');
});
