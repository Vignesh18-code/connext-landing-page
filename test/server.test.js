'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer, createMemoryStore, validateLead, csvCell } = require('../server.js');

const silent = () => {};
const TOKEN = 'a-long-test-token-1234';

// every test gets its own server; t.after() closes it even when an assertion fails
async function start(t, options = {}) {
  const store = options.store === undefined ? createMemoryStore() : options.store;
  const server = createServer({ log: silent, trustProxyHops: 0, ...options, store });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, store };
}

const post = (base, body, headers = {}) => fetch(`${base}/api/notify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const good = { name: 'Asha Kumar', email: 'Asha@Example.com', phone: '+91 98765 43210', role: 'Business' };
const basic = (password) => `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;

/* ---------------------------------------------------------------- pure functions */
test('validateLead accepts a good form and tidies it', () => {
  const { lead } = validateLead({ ...good, name: '  Asha   Kumar ' });
  assert.deepEqual(lead, { name: 'Asha Kumar', email: 'asha@example.com', phone: '+91 98765 43210', role: 'Business' });
});

test('validateLead rejects bad input with the field name', () => {
  assert.equal(validateLead({ ...good, name: 'A' }).field, 'name');
  assert.equal(validateLead({ ...good, email: '' }).field, 'email');
  assert.equal(validateLead({ ...good, email: 'nope' }).field, 'email');
  assert.equal(validateLead({ ...good, phone: 'abc' }).field, 'phone');
  assert.equal(validateLead({ ...good, role: 'Hacker' }).field, 'role');
  assert.ok(validateLead({ name: 'Asha', email: 'a@b.co' }).lead, 'phone and role are optional');
});

test('csvCell quotes commas and defuses spreadsheet formulas', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("http://x")'), '"\'=HYPERLINK(""http://x"")"');
  assert.equal(csvCell('+91 98765', { guard: false }), '+91 98765');
});

/* ---------------------------------------------------------------- static files */
test('serves the page with security headers', async (t) => {
  const s = await start(t);
  const res = await fetch(`${s.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(await res.text(), /<title>Connext/);
  assert.equal(res.headers.get('strict-transport-security'), null, 'no HSTS over plain http');
});

test('adds HSTS and upgrade-insecure-requests behind an https proxy', async (t) => {
  const s = await start(t);
  const res = await fetch(`${s.base}/`, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(res.headers.get('strict-transport-security'), /max-age=31536000/);
  assert.match(res.headers.get('content-security-policy'), /upgrade-insecure-requests/);
});

test('gzips text files and answers 304 for unchanged ones', async (t) => {
  const s = await start(t);
  const res = await fetch(`${s.base}/assets/css/style.css`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(res.headers.get('content-encoding'), 'gzip');
  assert.match(res.headers.get('cache-control'), /max-age=3600/);
  const etag = res.headers.get('etag');
  await res.arrayBuffer();
  const again = await fetch(`${s.base}/assets/css/style.css`, { headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
});

test('supports byte ranges so the video can be scrubbed', async (t) => {
  const s = await start(t);
  const url = `${s.base}/assets/video/connext-pitch-720.mp4`;
  const part = await fetch(url, { headers: { Range: 'bytes=100-199' } });
  assert.equal(part.status, 206);
  assert.match(part.headers.get('content-range'), /^bytes 100-199\/\d+$/);
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  const tail = await fetch(url, { headers: { Range: 'bytes=-50' } });
  assert.equal(tail.status, 206);
  assert.equal((await tail.arrayBuffer()).byteLength, 50);
  const bad = await fetch(url, { headers: { Range: 'bytes=999999999-' } });
  assert.equal(bad.status, 416);
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
});

test('never serves anything outside site/ or hidden files', async (t) => {
  const s = await start(t);
  // fetch() tidies "../" away, so use raw requests for the dangerous paths
  const raw = (p) => new Promise((resolve, reject) => {
    const url = new URL(s.base);
    http.get({ host: url.hostname, port: url.port, path: p }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
  assert.equal(await raw('/../server.js'), 404);
  assert.equal(await raw('/..%2fserver.js'), 404);
  assert.equal(await raw('/%2e%2e/package.json'), 404);
  assert.equal(await raw('/assets/../../package.json'), 404);
  assert.equal(await raw('/_headers'), 404);
  assert.equal(await raw('/.git/config'), 404);
  assert.equal(await raw('/%00'), 400);
  assert.equal(await raw('/%E0%A4%A'), 400);
  assert.equal(await raw('/missing.html'), 404);
  const post404 = await fetch(`${s.base}/`, { method: 'POST' });
  assert.equal(post404.status, 405);
});

test('/healthz answers while everything else is broken', async (t) => {
  const s = await start(t, { store: null });
  const res = await fetch(`${s.base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

/* ---------------------------------------------------------------- sign-up endpoint */
test('stores a valid sign-up, lowercased, and answers ok', async (t) => {
  const s = await start(t);
  const res = await post(s.base, good);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const rows = await s.store.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'asha@example.com');
  assert.equal(rows[0].role, 'Business');
});

test('the same email updates the row instead of duplicating it', async (t) => {
  const s = await start(t);
  await post(s.base, { name: 'Asha', email: 'asha@example.com' });
  await post(s.base, { name: 'Asha Kumar', email: 'ASHA@example.com', phone: '98765 43210', role: 'Driver' });
  const rows = await s.store.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Asha Kumar');
  assert.equal(rows[0].role, 'Driver');
});

test('rejects bad requests with the right status', async (t) => {
  const s = await start(t);
  assert.equal((await post(s.base, { ...good, name: '' })).status, 422);
  const bad = await post(s.base, { ...good, email: 'nope' });
  assert.equal(bad.status, 422);
  assert.deepEqual(await bad.json(), { error: 'That email doesn’t look right.', field: 'email' });
  assert.equal((await post(s.base, '{not json')).status, 400);
  assert.equal((await post(s.base, 'null')).status, 400);
  assert.equal((await post(s.base, '[1,2]')).status, 400);
  assert.equal((await post(s.base, 'x'.repeat(20000))).status, 413);
  const wrongType = await fetch(`${s.base}/api/notify`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hi' });
  assert.equal(wrongType.status, 415);
  const get = await fetch(`${s.base}/api/notify`);
  assert.equal(get.status, 405);
  assert.equal((await fetch(`${s.base}/api/nothing`)).status, 404);
  assert.equal((await s.store.list()).length, 0, 'nothing bad was stored');
});

test('the hidden spam-trap field looks successful but stores nothing', async (t) => {
  const s = await start(t);
  const res = await post(s.base, { ...good, website: 'http://spam.example' });
  assert.equal(res.status, 200);
  assert.equal((await s.store.list()).length, 0);
});

test('refuses sign-ups (503) when there is no database, and when saving fails', async (t) => {
  const none = await start(t, { store: null });
  assert.equal((await post(none.base, good)).status, 503);

  const broken = await start(t, { store: { kind: 'broken', async save() { throw new Error('db down'); }, async list() { return []; } } });
  const res = await post(broken.base, good);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /temporarily unavailable/);
});

test('rate-limits one visitor, not everyone (X-Real-IP, as Railway sends it)', async (t) => {
  const s = await start(t, { signupsPer10Min: 3, trustProxyHops: 1 });
  const as = (ip, n) => post(s.base, { ...good, email: `person${n}@example.com` }, { 'X-Real-IP': ip });
  for (let i = 0; i < 3; i += 1) assert.equal((await as('9.9.9.9', i)).status, 200);
  const blocked = await as('9.9.9.9', 99);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '600');
  assert.equal((await as('8.8.8.8', 100)).status, 200, 'another visitor is unaffected');
});

test('without X-Real-IP the last X-Forwarded-For entry is the visitor, a faked first one changes nothing', async (t) => {
  const s = await start(t, { signupsPer10Min: 2, trustProxyHops: 1 });
  const as = (xff, n) => post(s.base, { ...good, email: `person${n}@example.com` }, { 'X-Forwarded-For': xff });
  assert.equal((await as('9.9.9.9', 1)).status, 200);
  assert.equal((await as('1.1.1.1, 9.9.9.9', 2)).status, 200);
  assert.equal((await as('2.2.2.2, 9.9.9.9', 3)).status, 429, 'same visitor behind faked first entries is still limited');
  assert.equal((await as('7.7.7.7', 4)).status, 200, 'a different visitor is unaffected');
});

test('when no proxy is trusted the IP headers are ignored (they could be faked)', async (t) => {
  const s = await start(t, { signupsPer10Min: 2, trustProxyHops: 0 });
  const as = (ip, n) => post(s.base, { ...good, email: `person${n}@example.com` }, { 'X-Real-IP': ip, 'X-Forwarded-For': ip });
  assert.equal((await as('1.1.1.1', 1)).status, 200);
  assert.equal((await as('2.2.2.2', 2)).status, 200);
  assert.equal((await as('3.3.3.3', 3)).status, 429, 'faking a new address each time does not escape the limit');
});

/* ---------------------------------------------------------------- admin export */
test('the CSV export is off without a token and locked with one', async (t) => {
  const off = await start(t);
  assert.equal((await fetch(`${off.base}/admin/leads.csv`)).status, 404);

  const short = await start(t, { adminToken: 'tooshort' });
  assert.equal((await fetch(`${short.base}/admin/leads.csv`, { headers: { Authorization: basic('tooshort') } })).status, 404, 'a short token never enables it');

  const s = await start(t, { adminToken: TOKEN });
  const denied = await fetch(`${s.base}/admin/leads.csv`);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate'), /Basic realm/);
  assert.equal((await fetch(`${s.base}/admin/leads.csv`, { headers: { Authorization: basic('wrong-token-wrong-token') } })).status, 401);
});

test('the CSV export lists sign-ups for the right password (Basic or Bearer)', async (t) => {
  const s = await start(t, { adminToken: TOKEN });
  await post(s.base, good);
  await post(s.base, { name: '=SUM(1+1)', email: 'evil@example.com' });

  const res = await fetch(`${s.base}/admin/leads.csv`, { headers: { Authorization: basic(TOKEN) } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /connext-leads-\d{4}-\d{2}-\d{2}\.csv/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const csv = (await res.text()).replace(/^﻿/, '');
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'id,created_at,name,email,phone,role');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /,Asha Kumar,asha@example\.com,\+91 98765 43210,Business$/);
  assert.match(lines[2], /,'=SUM\(1\+1\),evil@example\.com,,$/, 'a formula in a name is made harmless');

  const bearer = await fetch(`${s.base}/admin/leads.csv`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(bearer.status, 200);
});

test('repeated wrong passwords get locked out', async (t) => {
  const s = await start(t, { adminToken: TOKEN });
  for (let i = 0; i < 10; i += 1) assert.equal((await fetch(`${s.base}/admin/leads.csv`, { headers: { Authorization: basic(`guess-number-${i}-xxxxxx`) } })).status, 401);
  assert.equal((await fetch(`${s.base}/admin/leads.csv`, { headers: { Authorization: basic(TOKEN) } })).status, 429, 'even the right password waits');
});
