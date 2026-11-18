const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const Busboy = require('busboy');

const OWNER = 'SriramFit123';
const REPOSITORY = 'finbud-download';
const RELEASE_TAG = 'v1.0.0';
const ASSET_NAME = 'FinBud-original-debug.apk';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'FinBud Admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const PORT = Number(process.env.PORT || 10000);
const MAX_UPLOAD_BYTES = 220 * 1024 * 1024;
const SESSION_MS = 4 * 60 * 60 * 1000;
const GITHUB_API_VERSION = '2026-03-10';

const sessions = new Map();
const loginAttempts = new Map();
let uploadInProgress = false;

function json(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) {
    crypto.timingSafeEqual(Buffer.alloc(Math.max(a.length, b.length)), Buffer.alloc(Math.max(a.length, b.length)));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function cookies(req) {
  const result = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function currentSession(req) {
  const token = cookies(req).finbud_admin;
  if (!token) return null;
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return token;
}

function setSessionCookie(res, token, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `finbud_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
}

function requestBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data) > limit) {
        reject(Object.assign(new Error('Request is too large.'), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { reject(Object.assign(new Error('Invalid request.'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function receiveApk(req) {
  return new Promise((resolve, reject) => {
    let fileCount = 0;
    let savedFile = null;
    let writeTask = Promise.resolve();
    let failure = null;

    let parser;
    try {
      parser = Busboy({
        headers: req.headers,
        limits: { fileSize: MAX_UPLOAD_BYTES, files: 2, fields: 1, parts: 2 },
      });
    } catch {
      reject(Object.assign(new Error('Choose one APK file to upload.'), { statusCode: 400 }));
      return;
    }

    parser.on('file', (field, input, metadata) => {
      fileCount += 1;
      if (field !== 'apk' || fileCount !== 1) {
        failure = Object.assign(new Error('Choose one APK file to upload.'), { statusCode: 400 });
        input.resume();
        return;
      }

      const tempPath = path.join(os.tmpdir(), `finbud-${crypto.randomUUID()}.apk`);
      let size = 0;
      const counter = new Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          callback(null, chunk);
        },
      });
      input.on('limit', () => {
        failure = Object.assign(new Error('APK must be smaller than 220 MB.'), { statusCode: 413 });
      });
      writeTask = pipeline(input, counter, fs.createWriteStream(tempPath, { flags: 'wx' }))
        .then(() => {
          if (input.truncated) failure = Object.assign(new Error('APK must be smaller than 220 MB.'), { statusCode: 413 });
          savedFile = { path: tempPath, size, originalName: metadata.filename || 'app.apk' };
        })
        .catch((error) => { failure = error; });
    });

    parser.on('fieldsLimit', () => { failure = Object.assign(new Error('Unexpected upload fields.'), { statusCode: 400 }); });
    parser.on('filesLimit', () => { failure = Object.assign(new Error('Upload one APK file at a time.'), { statusCode: 400 }); });
    parser.on('partsLimit', () => { failure = Object.assign(new Error('Upload one APK file at a time.'), { statusCode: 400 }); });
    parser.on('error', reject);
    parser.on('finish', async () => {
      try {
        await writeTask;
        if (failure) throw failure;
        if (!savedFile || fileCount !== 1) throw Object.assign(new Error('Choose one APK file to upload.'), { statusCode: 400 });
        if (!savedFile.originalName.toLowerCase().endsWith('.apk')) throw Object.assign(new Error('Choose an .apk file.'), { statusCode: 400 });
        if (savedFile.size < 8) throw Object.assign(new Error('The selected file is empty or incomplete.'), { statusCode: 400 });
        const handle = await fsp.open(savedFile.path, 'r');
        const header = Buffer.alloc(4);
        await handle.read(header, 0, 4, 0);
        await handle.close();
        if (header[0] !== 0x50 || header[1] !== 0x4b) throw Object.assign(new Error('The selected file does not look like an Android APK.'), { statusCode: 400 });
        resolve(savedFile);
      } catch (error) {
        if (savedFile?.path) await fsp.unlink(savedFile.path).catch(() => {});
        reject(error);
      }
    });
    req.pipe(parser);
  });
}

function githubErrorDetail(text) {
  try {
    const message = JSON.parse(text).message;
    return typeof message === 'string' ? `: ${message.slice(0, 180)}` : '';
  } catch {
    return '';
  }
}

async function githubApi(pathname, method = 'GET', payload) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'User-Agent': 'FinBud-APK-Admin',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`GitHub could not complete the release update (HTTP ${response.status}${githubErrorDetail(text)}).`);
    error.statusCode = 502;
    throw error;
  }
  return text ? JSON.parse(text) : null;
}

async function uploadReleaseAsset(release, assetName, file) {
  const base = release.upload_url.replace(/\{[^}]+\}$/, '');
  const url = new URL(base);
  url.searchParams.set('name', assetName);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'User-Agent': 'FinBud-APK-Admin',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(file.size),
    },
    body: fs.createReadStream(file.path),
    duplex: 'half',
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`GitHub could not receive the APK (HTTP ${response.status}${githubErrorDetail(text)}).`);
    error.statusCode = 502;
    throw error;
  }
  return JSON.parse(text);
}

async function replaceReleaseApk(file) {
  const releasePath = `/repos/${OWNER}/${REPOSITORY}/releases/tags/${RELEASE_TAG}`;
  let release;
  try {
    release = await githubApi(releasePath);
  } catch (error) {
    if (!error.message.includes("HTTP 404")) throw error;
    release = await githubApi(`/repos/${OWNER}/${REPOSITORY}/releases`, "POST", {
      tag_name: RELEASE_TAG,
      name: `FinBud ${RELEASE_TAG}`,
      body: "Android installer for FinBud version 1.0.0.",
      draft: false,
      prerelease: false,
    });
  }
  const oldAsset = (release.assets || []).find((asset) => asset.name === ASSET_NAME);
  const stagingName = `FinBud-original-debug-upload-${crypto.randomBytes(6).toString('hex')}.apk`;
  const uploaded = await uploadReleaseAsset(release, stagingName, file);
  let oldRenamed = false;
  let newRenamed = false;
  const backupName = `FinBud-original-debug-backup-${crypto.randomBytes(6).toString('hex')}.apk`;

  try {
    if (oldAsset) {
      await githubApi(`/repos/${OWNER}/${REPOSITORY}/releases/assets/${oldAsset.id}`, 'PATCH', { name: backupName });
      oldRenamed = true;
    }
    await githubApi(`/repos/${OWNER}/${REPOSITORY}/releases/assets/${uploaded.id}`, 'PATCH', { name: ASSET_NAME });
    newRenamed = true;
  } catch (error) {
    if (oldRenamed) await githubApi(`/repos/${OWNER}/${REPOSITORY}/releases/assets/${oldAsset.id}`, 'PATCH', { name: ASSET_NAME }).catch(() => {});
    if (!newRenamed) await githubApi(`/repos/${OWNER}/${REPOSITORY}/releases/assets/${uploaded.id}`, 'DELETE').catch(() => {});
    throw error;
  }

  let cleanupWarning = null;
  if (oldRenamed) {
    try { await githubApi(`/repos/${OWNER}/${REPOSITORY}/releases/assets/${oldAsset.id}`, 'DELETE'); }
    catch { cleanupWarning = 'The new APK is live, but GitHub kept a backup asset in the release.'; }
  }
  return {
    name: ASSET_NAME,
    size: file.size,
    downloadUrl: `https://github.com/${OWNER}/${REPOSITORY}/releases/download/${RELEASE_TAG}/${ASSET_NAME}`,
    cleanupWarning,
  };
}

async function serveFile(res, filePath, contentType) {
  const data = await fsp.readFile(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/') return await serveFile(res, path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/session') return json(res, 200, { authenticated: Boolean(currentSession(req)) });

    if (req.method === 'POST' && url.pathname === '/api/login') {
      if (!isSameOrigin(req)) return json(res, 403, { error: 'Sign-in request rejected.' });
      if (!ADMIN_PASSWORD || !GITHUB_TOKEN) return json(res, 503, { error: 'Admin upload is not configured yet.' });
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
      const attempt = loginAttempts.get(ip) || { count: 0, since: Date.now() };
      if (Date.now() - attempt.since > 15 * 60 * 1000) { attempt.count = 0; attempt.since = Date.now(); }
      if (attempt.count >= 6) return json(res, 429, { error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' });
      let body;
      try { body = await requestBody(req); }
      catch (error) { return json(res, error.statusCode || 400, { error: error.message }); }
      if (!constantTimeEqual(body.username || '', ADMIN_USERNAME) || !constantTimeEqual(body.password || '', ADMIN_PASSWORD)) {
        attempt.count += 1;
        loginAttempts.set(ip, attempt);
        return json(res, 401, { error: 'Username or password is incorrect.' });
      }
      loginAttempts.delete(ip);
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, Date.now() + SESSION_MS);
      setSessionCookie(res, token, Math.floor(SESSION_MS / 1000));
      return json(res, 200, { authenticated: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      if (!isSameOrigin(req)) return json(res, 403, { error: 'Sign-out request rejected.' });
      const token = currentSession(req);
      if (token) sessions.delete(token);
      setSessionCookie(res, '', 0);
      return json(res, 200, { authenticated: false });
    }

    if (req.method === 'POST' && url.pathname === '/api/upload') {
      if (!isSameOrigin(req)) return json(res, 403, { error: 'Upload request rejected.' });
      if (!currentSession(req)) return json(res, 401, { error: 'Sign in again before uploading.' });
      if (!GITHUB_TOKEN) return json(res, 503, { error: 'GitHub upload is not configured yet.' });
      if (uploadInProgress) return json(res, 409, { error: 'An APK upload is already in progress.' });
      uploadInProgress = true;
      let file = null;
      try {
        file = await receiveApk(req);
        const result = await replaceReleaseApk(file);
        return json(res, 200, { ok: true, ...result });
      } catch (error) {
        return json(res, error.statusCode || 500, { error: error.message || 'Upload failed. Please try again.' });
      } finally {
        if (file?.path) await fsp.unlink(file.path).catch(() => {});
        uploadInProgress = false;
      }
    }

    return json(res, 404, { error: 'Page not found.' });
  } catch {
    if (!res.headersSent) return json(res, 500, { error: 'Something went wrong. Please try again.' });
    res.destroy();
  }
});

server.requestTimeout = 20 * 60 * 1000;
server.headersTimeout = 60 * 1000;
server.keepAliveTimeout = 5 * 1000;
server.listen(PORT, '0.0.0.0', () => console.log(`FinBud APK admin listening on ${PORT}`));

