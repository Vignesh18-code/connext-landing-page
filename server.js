'use strict';
/*
  Connext landing page server.

  - Serves the static site in ./site (security headers, caching, gzip, video byte-ranges).
  - POST /api/notify   takes the sign-up form and stores it in Postgres (DATABASE_URL).
  - GET  /admin/leads.csv   downloads every sign-up; needs ADMIN_TOKEN as the password.
  - GET  /healthz   always answers 200 while the process is up.

  Settings come from environment variables (set them in Railway, see README.md):
    PORT                  set by Railway
    DATABASE_URL          Postgres connection string. Without it sign-ups are refused (503).
    ADMIN_TOKEN           password for /admin/leads.csv, at least 16 characters. Without it the export is off.
    TRUST_PROXY_HOPS      proxies in front of this server, to find the visitor's IP (default 1, Railway)
    RATE_LIMIT_PER_10MIN  sign-ups allowed per visitor IP in 10 minutes (default 10)
    LEADS_DEV_MODE=1      local testing only: keep sign-ups in memory instead of Postgres (npm run dev)
*/
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream');

const SITE_ROOT = path.join(__dirname, 'site');
const ROLES = ['Business', 'Driver', 'Other'];
const MAX_BODY = 16 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.txt', '.svg']);

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

/* ------------------------------------------------------------------ small helpers */
const defaultLog = (level, msg, extra) => {
  // one JSON line per event; never put names, emails or phone numbers in here
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));
};

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(text);
}

/* ------------------------------------------------------------------ validation */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+()\d][\d\s().-]{6,18}$/;
const clean = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/** Returns { lead } when the form is fine, or { field, error } for the first problem. */
function validateLead(body) {
  const name = clean(body.name);
  const email = clean(body.email).toLowerCase();
  const phone = clean(body.phone);
  const role = clean(body.role);

  if (name.length < 2 || name.length > 80) return { field: 'name', error: 'Please enter your name.' };
  if (!email) return { field: 'email', error: 'Please enter your email.' };
  if (email.length > 120 || !EMAIL_RE.test(email)) return { field: 'email', error: 'That email doesn’t look right.' };
  if (phone && !PHONE_RE.test(phone)) return { field: 'phone', error: 'Please enter a valid phone number, or leave it empty.' };
  if (role && !ROLES.includes(role)) return { field: 'role', error: 'Please choose one of the options.' };
  return { lead: { name, email, phone, role } };
}

/* ------------------------------------------------------------------ CSV (opens safely in Excel) */
function csvCell(value, { guard = true } = {}) {
  let s = value == null ? '' : value instanceof Date ? value.toISOString() : String(value);
  // a cell that starts with = + - @ can run as a formula in Excel; make it plain text.
  // (phone numbers are already limited to digits and + ( ) . - by validation, so they skip this)
  if (guard && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function leadsToCsv(rows) {
  const lines = ['id,created_at,name,email,phone,role'];
  for (const r of rows) {
    lines.push([
      csvCell(r.id, { guard: false }),
      csvCell(r.created_at, { guard: false }),
      csvCell(r.name),
      csvCell(r.email),
      csvCell(r.phone, { guard: false }),
      csvCell(r.role),
    ].join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;   // BOM so Excel reads UTF-8 names correctly
}

/* ------------------------------------------------------------------ storage */
function createMemoryStore() {
  const byEmail = new Map();
  let nextId = 1;
  return {
    kind: 'memory (local testing only)',
    async init() {},
    async save(lead) {
      const now = new Date();
      const old = byEmail.get(lead.email);
      byEmail.set(lead.email, {
        id: old ? old.id : nextId++,
        created_at: old ? old.created_at : now,
        name: lead.name,
        email: lead.email,
        phone: lead.phone || (old ? old.phone : ''),
        role: lead.role || (old ? old.role : ''),
      });
    },
    async list() { return [...byEmail.values()]; },
    async close() {},
  };
}

function createPgStore(connectionString) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 8000, idleTimeoutMillis: 30000 });
  pool.on('error', (e) => defaultLog('error', 'database pool error', { detail: e.message }));

  let ready = null;
  const init = () => {
    if (!ready) {
      ready = pool.query(`
        CREATE TABLE IF NOT EXISTS leads (
          id         BIGSERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          name       TEXT NOT NULL,
          email      TEXT NOT NULL UNIQUE,
          phone      TEXT NOT NULL DEFAULT '',
          role       TEXT NOT NULL DEFAULT ''
        )`).catch((e) => { ready = null; throw e; });
    }
    return ready;
  };

  return {
    kind: 'postgres',
    init,
    async save(lead) {
      await init();
      // the same email again updates the row instead of adding a duplicate
      await pool.query(
        `INSERT INTO leads (name, email, phone, role) VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO UPDATE SET
           name = EXCLUDED.name,
           phone = COALESCE(NULLIF(EXCLUDED.phone, ''), leads.phone),
           role = COALESCE(NULLIF(EXCLUDED.role, ''), leads.role),
           updated_at = now()`,
        [lead.name, lead.email, lead.phone, lead.role],
      );
    },
    async list() {
      await init();
      const { rows } = await pool.query('SELECT id, created_at, name, email, phone, role FROM leads ORDER BY id');
      return rows;
    },
    async close() { await pool.end(); },
  };
}

function storeFromEnv(env = process.env) {
  if (env.DATABASE_URL) return createPgStore(env.DATABASE_URL);
  if (env.LEADS_DEV_MODE === '1') return createMemoryStore();
  return null;
}

/* ------------------------------------------------------------------ rate limiting (in memory) */
function createLimiter({ max, windowMs }) {
  const hits = new Map();
  const prune = (now) => {
    for (const [key, times] of hits) {
      const fresh = times.filter((t) => now - t < windowMs);
      if (fresh.length) hits.set(key, fresh); else hits.delete(key);
    }
  };
  const timer = setInterval(() => prune(Date.now()), 5 * 60 * 1000);
  timer.unref();
  return {
    /** records one attempt; returns false when the key is over the limit */
    take(key) {
      const now = Date.now();
      if (hits.size > 20000) prune(now);
      const times = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (times.length >= max) { hits.set(key, times); return false; }
      times.push(now);
      hits.set(key, times);
      return true;
    },
    /** counts without recording (used to block repeated failed logins) */
    over(key) {
      const now = Date.now();
      return (hits.get(key) || []).filter((t) => now - t < windowMs).length >= max;
    },
    record(key) {
      const now = Date.now();
      const times = (hits.get(key) || []).filter((t) => now - t < windowMs);
      times.push(now);
      hits.set(key, times);
    },
    stop() { clearInterval(timer); },
  };
}

/* ------------------------------------------------------------------ the server */
function createServer(options = {}) {
  const {
    store = null,
    adminToken = '',
    siteRoot = SITE_ROOT,
    trustProxyHops = 1,
    signupsPer10Min = 10,
    log = defaultLog,
  } = options;

  const adminOn = adminToken.length >= 16;
  const signupLimiter = createLimiter({ max: signupsPer10Min, windowMs: 10 * 60 * 1000 });
  const loginLimiter = createLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
  const gzipCache = new Map();

  function clientIp(req) {
    if (trustProxyHops > 0) {
      const chain = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      // the address the closest trusted proxy saw; anything further left can be faked by the visitor
      if (chain.length) return chain[Math.max(0, chain.length - trustProxyHops)];
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function setCommonHeaders(req, res) {
    const secure = req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', secure ? `${CSP}; upgrade-insecure-requests` : CSP);
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  /* ---------- sign-up ---------- */
  function readJson(req) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length']);
      if (declared > MAX_BODY) { req.resume(); reject(Object.assign(new Error('too large'), { status: 413 })); return; }
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) { chunks.length = 0; return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); }
        catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }

  async function handleNotify(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' }, { Allow: 'POST' });
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      return sendJson(res, 415, { error: 'Send the form as JSON.' });
    }
    if (!signupLimiter.take(clientIp(req))) {
      log('warn', 'signup rate limited');
      return sendJson(res, 429, { error: 'Too many attempts. Please wait a few minutes and try again.' }, { 'Retry-After': '600' });
    }

    let body;
    try { body = await readJson(req); }
    catch (e) {
      const headers = e.status === 413 ? { Connection: 'close' } : {};
      return sendJson(res, e.status || 400, { error: e.status === 413 ? 'That request is too large.' : 'That request could not be read.' }, headers);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'That request could not be read.' });

    // the hidden "website" field is a spam trap: people never fill it. Look successful, store nothing.
    if (clean(body.website)) { log('info', 'signup ignored', { reason: 'spam trap' }); return sendJson(res, 200, { ok: true }); }

    const result = validateLead(body);
    if (result.error) return sendJson(res, 422, { error: result.error, field: result.field });

    if (!store) {
      log('error', 'signup refused: no DATABASE_URL is set');
      return sendJson(res, 503, { error: 'Sign-ups are temporarily unavailable. Please try again later.' });
    }
    try {
      await store.save(result.lead);
    } catch (e) {
      log('error', 'signup failed to save', { detail: e.message });
      return sendJson(res, 503, { error: 'Sign-ups are temporarily unavailable. Please try again later.' });
    }
    log('info', 'signup stored');
    return sendJson(res, 200, { ok: true });
  }

  /* ---------- admin export ---------- */
  function presentedToken(req) {
    const header = String(req.headers.authorization || '');
    if (/^Bearer /i.test(header)) return header.slice(7).trim();
    if (/^Basic /i.test(header)) {
      const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
      return decoded.slice(decoded.indexOf(':') + 1);   // the user name is ignored, the password is the token
    }
    return '';
  }

  async function handleAdmin(req, res) {
    if (!adminOn) return sendText(res, 404, 'Not found');
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    const ip = clientIp(req);
    if (loginLimiter.over(ip)) return sendText(res, 429, 'Too many failed attempts. Try again later.', { 'Retry-After': '900' });

    const token = presentedToken(req);
    if (!token || !safeEqual(token, adminToken)) {
      loginLimiter.record(ip);
      return sendText(res, 401, 'Password required', { 'WWW-Authenticate': 'Basic realm="Connext leads", charset="UTF-8"' });
    }
    if (!store) return sendText(res, 503, 'No database is connected.');
    let rows;
    try { rows = await store.list(); }
    catch (e) { log('error', 'export failed', { detail: e.message }); return sendText(res, 503, 'The database could not be read.'); }

    const csv = leadsToCsv(rows);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="connext-leads-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Content-Length': Buffer.byteLength(csv),
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    });
    res.end(req.method === 'HEAD' ? undefined : csv);
  }

  /* ---------- static files ---------- */
  const statOrNull = (file) => fs.promises.stat(file).catch(() => null);

  function cacheControl(pathname, ext) {
    if (ext === '.html') return 'public, max-age=0, must-revalidate';
    if (pathname.startsWith('/assets/css/') || pathname.startsWith('/assets/js/')) return 'public, max-age=3600, must-revalidate';
    if (pathname.startsWith('/assets/img/') || pathname.startsWith('/assets/video/')) return 'public, max-age=2592000';
    return 'public, max-age=3600';
  }

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });

    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return sendText(res, 400, 'Bad request'); }
    if (rel.includes('\0')) return sendText(res, 400, 'Bad request');

    // no dot-files and no underscore files (like _headers), and never a way out of the site folder
    const parts = rel.split('/').filter(Boolean);
    if (parts.some((p) => p.startsWith('.') || p.startsWith('_'))) return sendText(res, 404, 'Not found');
    let file = path.join(siteRoot, ...parts);
    if (file !== siteRoot && !file.startsWith(siteRoot + path.sep)) return sendText(res, 404, 'Not found');

    let stat = await statOrNull(file);
    if (stat && stat.isDirectory()) { file = path.join(file, 'index.html'); stat = await statOrNull(file); }
    if (!stat || !stat.isFile()) return sendText(res, 404, 'Not found');

    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const lastModified = stat.mtime.toUTCString();
    const baseHeaders = {
      'Content-Type': type,
      'Cache-Control': cacheControl(pathname, ext),
      ETag: etag,
      'Last-Modified': lastModified,
      'Accept-Ranges': 'bytes',
    };

    // browsers ask "has it changed?" with these; answer 304 and send nothing
    const inm = req.headers['if-none-match'];
    const ims = req.headers['if-modified-since'];
    if ((inm && inm.split(/\s*,\s*/).includes(etag)) || (!inm && ims && Date.parse(ims) >= Math.floor(stat.mtimeMs / 1000) * 1000)) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': baseHeaders['Cache-Control'], 'Last-Modified': lastModified });
      return res.end();
    }

    // byte ranges: needed so a video can be scrubbed
    const rangeHeader = req.headers.range;
    const ifRange = req.headers['if-range'];
    if (rangeHeader && (!ifRange || ifRange === etag || ifRange === lastModified)) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      let start;
      let end;
      if (m && (m[1] || m[2])) {
        if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1; }
        else { const n = Number(m[2]); start = Math.max(0, stat.size - n); end = stat.size - 1; }
      }
      if (start === undefined || start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      res.writeHead(206, { ...baseHeaders, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return pipeline(fs.createReadStream(file, { start, end }), res, () => {});
    }

    // small text files are sent gzipped
    if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      const key = `${file}:${stat.mtimeMs}:${stat.size}`;
      let zipped = gzipCache.get(key);
      if (!zipped) {
        zipped = zlib.gzipSync(await fs.promises.readFile(file), { level: 9 });
        if (gzipCache.size > 50) gzipCache.clear();
        gzipCache.set(key, zipped);
      }
      res.writeHead(200, { ...baseHeaders, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': zipped.length });
      return res.end(req.method === 'HEAD' ? undefined : zipped);
    }

    res.writeHead(200, { ...baseHeaders, ...(COMPRESSIBLE.has(ext) ? { Vary: 'Accept-Encoding' } : {}), 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    return pipeline(fs.createReadStream(file), res, () => {});
  }

  /* ---------- routing ---------- */
  const server = http.createServer(async (req, res) => {
    try {
      setCommonHeaders(req, res);
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname === '/healthz') return sendText(res, 200, 'ok');
      if (pathname === '/api/notify') return await handleNotify(req, res);
      if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
      if (pathname === '/admin/leads.csv') return await handleAdmin(req, res);
      return await serveStatic(req, res, pathname);
    } catch (e) {
      log('error', 'request failed', { detail: e.message });
      if (!res.headersSent) sendText(res, 500, 'Something went wrong.');
      else res.destroy();
    }
  });
  // sit behind a proxy that keeps connections for 60 seconds
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 30000;
  server.on('close', () => { signupLimiter.stop(); loginLimiter.stop(); });
  return server;
}

/* ------------------------------------------------------------------ start */
async function main() {
  const store = storeFromEnv();
  const adminToken = process.env.ADMIN_TOKEN || '';
  const port = Number(process.env.PORT) || 3000;
  const server = createServer({
    store,
    adminToken,
    trustProxyHops: process.env.TRUST_PROXY_HOPS === undefined ? 1 : Number(process.env.TRUST_PROXY_HOPS),
    signupsPer10Min: Number(process.env.RATE_LIMIT_PER_10MIN) || 10,
  });

  server.listen(port, '0.0.0.0', () => {
    defaultLog('info', 'listening', {
      port,
      storage: store ? store.kind : 'NONE: set DATABASE_URL, sign-ups are refused',
      admin_export: adminToken.length >= 16 ? 'on' : adminToken ? 'OFF: ADMIN_TOKEN must be at least 16 characters' : 'off',
    });
  });

  // create the table in the background, and keep trying if the database is not up yet
  if (store) {
    const attempt = () => store.init().then(
      () => defaultLog('info', 'database ready'),
      (e) => { defaultLog('error', 'database not reachable, retrying in 15 s', { detail: e.message }); setTimeout(attempt, 15000).unref(); },
    );
    attempt();
  }

  const stop = (signal) => {
    defaultLog('info', 'shutting down', { signal });
    const force = setTimeout(() => process.exit(1), 10000);
    force.unref();
    server.close(async () => {
      try { if (store) await store.close(); } catch { /* already closing */ }
      process.exit(0);
    });
    server.closeIdleConnections?.();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

if (require.main === module) main();

module.exports = { createServer, createMemoryStore, createPgStore, validateLead, csvCell, leadsToCsv };
