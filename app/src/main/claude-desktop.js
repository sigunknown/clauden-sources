'use strict';

/**
 * Импорт входа из установленного приложения Claude (claude.ai для Windows).
 *
 * Официальное приложение — Electron: cookie claude.ai лежат в SQLite
 * `...\Claude\Network\Cookies` и зашифрованы Chromium-схемой (v10:
 * AES-256-GCM, ключ в `Local State` под DPAPI). Читаем только cookie
 * домена claude.ai и только по явному действию пользователя; значения
 * не покидают главный процесс и не уходят на бэкенд Clauden.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const { ClaudeError } = require('./claude-client');

const COOKIE_SUBDIRS = ['Network/Cookies', 'Cookies', 'Default/Cookies'];
const CLAUDE_HOST = /(^|\.)claude\.ai$/i;
const DPAPI_PREFIX = Buffer.from('DPAPI', 'latin1');

function appDataRoots(env = process.env) {
  const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roots = [path.join(appData, 'Claude')];
  // MSIX-сборка из Microsoft Store держит данные в песочнице пакета.
  try {
    const packages = path.join(localAppData, 'Packages');
    for (const entry of fs.readdirSync(packages)) {
      if (/^Claude_/i.test(entry)) {
        roots.push(path.join(packages, entry, 'LocalCache', 'Roaming', 'Claude'));
      }
    }
  } catch {
    /* нет каталога Packages */
  }
  return roots;
}

function installCandidates(env = process.env) {
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const list = [
    path.join(localAppData, 'AnthropicClaude', 'claude.exe'),
    path.join(localAppData, 'AnthropicClaude', 'Claude.exe'),
    path.join(localAppData, 'Programs', 'Claude', 'Claude.exe'),
    path.join(localAppData, 'Programs', 'Claude', 'claude.exe'),
    path.join(programFiles, 'Claude', 'Claude.exe'),
    path.join(programFilesX86, 'Claude', 'Claude.exe'),
    path.join(localAppData, 'Microsoft', 'WindowsApps', 'Claude.exe'),
  ];
  // Squirrel-установка раскладывает версии в app-<version>\claude.exe.
  try {
    const base = path.join(localAppData, 'AnthropicClaude');
    for (const entry of fs.readdirSync(base)) {
      if (!/^app-/i.test(entry)) continue;
      list.push(path.join(base, entry, 'claude.exe'));
      list.push(path.join(base, entry, 'Claude.exe'));
    }
  } catch {
    /* нет каталога установки */
  }
  return list;
}

function findInstall(env = process.env) {
  for (const candidate of installCandidates(env)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* следующий путь */
    }
  }
  return '';
}

function findDataDir(env = process.env) {
  let best = null;
  for (const root of appDataRoots(env)) {
    for (const sub of COOKIE_SUBDIRS) {
      const db = path.join(root, ...sub.split('/'));
      try {
        const stat = fs.statSync(db);
        if (!stat.isFile()) continue;
        if (!best || stat.mtimeMs > best.mtimeMs) best = { dataDir: root, cookieDb: db, mtimeMs: stat.mtimeMs };
      } catch {
        /* следующий путь */
      }
    }
  }
  return best;
}

function isClaudeRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Claude.exe', '/NH'], {
      windowsHide: true,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString('latin1');
    return /Claude\.exe/i.test(out);
  } catch {
    return false;
  }
}

function closeClaudeApp(timeoutMs = 12000) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('taskkill', ['/IM', 'Claude.exe', '/T'], { windowsHide: true, timeout: 8000 }, () => {
      const started = Date.now();
      const tick = () => {
        if (!isClaudeRunning()) return resolve(true);
        if (Date.now() - started > timeoutMs) return resolve(false);
        setTimeout(tick, 500);
      };
      setTimeout(tick, 500);
    });
  });
}

function dpapiUnprotect(data) {
  if (process.platform !== 'win32') {
    return Promise.reject(new ClaudeError('desktop_crypto_failed', 'DPAPI доступен только на Windows'));
  }
  const script = [
    '$ErrorActionPreference="Stop"',
    'Add-Type -AssemblyName System.Security',
    '$b=[Convert]::FromBase64String($env:CLAUDEN_DPAPI_B64)',
    '$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,"CurrentUser")',
    '[Convert]::ToBase64String($p)',
  ].join('; ');
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const absolute = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let shell = 'powershell.exe';
  try {
    if (fs.statSync(absolute).isFile()) shell = absolute;
  } catch {
    /* PATH */
  }
  return new Promise((resolve, reject) => {
    execFile(
      shell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        env: { ...process.env, CLAUDEN_DPAPI_B64: Buffer.from(data).toString('base64') },
        windowsHide: true,
        timeout: 20000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout) => {
        if (err) return reject(new ClaudeError('desktop_crypto_failed', `DPAPI: ${err.message}`));
        const text = String(stdout || '').trim();
        try {
          resolve(Buffer.from(text, 'base64'));
        } catch {
          reject(new ClaudeError('desktop_crypto_failed', 'DPAPI вернул неожиданный ответ'));
        }
      },
    );
  });
}

async function readChromiumKey(dataDir) {
  const file = path.join(dataDir, 'Local State');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ClaudeError('desktop_crypto_failed', `Не прочитан Local State: ${err.message}`);
  }
  const encoded = state?.os_crypt?.encrypted_key;
  if (typeof encoded !== 'string' || !encoded) {
    throw new ClaudeError('desktop_crypto_failed', 'В Local State нет ключа шифрования');
  }
  let raw;
  try {
    raw = Buffer.from(encoded, 'base64');
  } catch {
    throw new ClaudeError('desktop_crypto_failed', 'Ключ шифрования повреждён');
  }
  const wrapped = raw.subarray(0, DPAPI_PREFIX.length).equals(DPAPI_PREFIX);
  if (wrapped) raw = raw.subarray(DPAPI_PREFIX.length);
  // Некоторые сборки кладут уже развёрнутый 32-байтный ключ без DPAPI.
  if (!wrapped && raw.length === 32) return raw;
  const plain = await dpapiUnprotect(raw);
  if (plain.length !== 32) {
    throw new ClaudeError('desktop_crypto_failed', 'Ключ шифрования неожиданной длины');
  }
  return plain;
}

function stripDomainHash(plain, hostKey) {
  if (plain.length <= 32) return plain;
  const hosts = [hostKey, String(hostKey || '').replace(/^\./, '')].filter(Boolean);
  for (const host of hosts) {
    const hash = crypto.createHash('sha256').update(host).digest();
    if (plain.subarray(0, 32).equals(hash)) return plain.subarray(32);
    if (plain.subarray(plain.length - 32).equals(hash)) return plain.subarray(0, plain.length - 32);
  }
  const tail = plain.subarray(32);
  const printable = (buf) => buf.length > 0 && buf.every((byte) => byte >= 0x20 && byte !== 0x7f);
  if (!printable(plain.subarray(0, 32)) && printable(tail)) return tail;
  if (!printable(plain.subarray(plain.length - 32)) && printable(plain.subarray(0, plain.length - 32))) {
    return plain.subarray(0, plain.length - 32);
  }
  return plain;
}

function decryptAesGcm(payload, key) {
  if (payload.length < 12 + 16) return null;
  const nonce = payload.subarray(0, 12);
  const tag = payload.subarray(payload.length - 16);
  const body = payload.subarray(12, payload.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

async function decryptCookie(encryptedValue, key, hostKey) {
  const blob = Buffer.from(encryptedValue);
  const prefix = blob.subarray(0, 3).toString('latin1');
  if (prefix === 'v20') {
    throw new ClaudeError(
      'desktop_unsupported',
      'Claude использует новый формат шифрования cookie — войдите через claude.ai',
    );
  }
  if (prefix === 'v10' || prefix === 'v11') {
    if (key) {
      try {
        return stripDomainHash(decryptAesGcm(blob.subarray(3), key), hostKey).toString('utf8');
      } catch {
        /* возможно, старая DPAPI-схема */
      }
    }
    try {
      return stripDomainHash(await dpapiUnprotect(blob.subarray(3)), hostKey).toString('utf8');
    } catch {
      /* ниже общая ошибка */
    }
    throw new ClaudeError('desktop_crypto_failed', 'Не удалось расшифровать cookie Claude');
  }
  // Совсем старый формат: DPAPI без префикса.
  return stripDomainHash(await dpapiUnprotect(blob), hostKey).toString('utf8');
}

function sqliteModule() {
  try {
    return require('node:sqlite');
  } catch (err) {
    throw new ClaudeError('desktop_unsupported', `SQLite недоступен: ${err.message}`);
  }
}

function cookieColumns(db) {
  const columns = new Set(
    db.prepare('PRAGMA table_info(cookies)').all().map((row) => String(row.name)),
  );
  return {
    secure: columns.has('is_secure') ? 'is_secure' : columns.has('secure') ? 'secure' : '0',
    httpOnly: columns.has('is_httponly') ? 'is_httponly' : '0',
    sameSite: columns.has('samesite') ? 'samesite' : '-1',
    expires: columns.has('expires_utc') ? 'expires_utc' : '0',
  };
}

function listCookieNames(dbPath) {
  const { DatabaseSync } = sqliteModule();
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const cols = cookieColumns(db);
    const rows = db
      .prepare(`SELECT name FROM cookies WHERE host_key LIKE ?`)
      .all('%claude.ai%');
    return rows.map((row) => String(row.name));
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

function copyDatabase(dbPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clauden-claude-'));
  const target = path.join(dir, 'Cookies');
  try {
    fs.copyFileSync(dbPath, target);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, target + suffix);
    }
    return { dir, file: target };
  } catch (err) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (['EBUSY', 'EPERM', 'EACCES', 'ETXTBSY'].includes(err.code)) {
      throw new ClaudeError('desktop_locked', 'Claude запущен и держит файл cookie — закройте приложение');
    }
    throw new ClaudeError('desktop_locked', `Не удалось прочитать cookie Claude: ${err.message}`);
  }
}

function readCookieRows(dbPath) {
  const copy = copyDatabase(dbPath);
  const { DatabaseSync } = sqliteModule();
  let db;
  try {
    db = new DatabaseSync(copy.file);
    const cols = cookieColumns(db);
    return db
      .prepare(
        `SELECT host_key, name, value, encrypted_value, path,
                ${cols.secure} AS is_secure, ${cols.httpOnly} AS is_httponly,
                ${cols.sameSite} AS samesite, ${cols.expires} AS expires_utc
           FROM cookies WHERE host_key LIKE ?`,
      )
      .all('%claude.ai%');
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(copy.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function expiresToSeconds(value) {
  const micros = Number(value) || 0;
  if (!micros) return 0;
  const seconds = micros / 1e6 - 11644473600;
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
}

function sameSiteValue(value) {
  switch (Number(value)) {
    case 0:
      return 'no_restriction';
    case 1:
      return 'lax';
    case 2:
      return 'strict';
    default:
      return undefined;
  }
}

function toCookie(row, value) {
  const host = String(row.host_key || '');
  const cookie = {
    name: String(row.name || ''),
    value,
    domain: host,
    path: String(row.path || '/') || '/',
    secure: Boolean(Number(row.is_secure)),
    httpOnly: Boolean(Number(row.is_httponly)),
  };
  const expires = expiresToSeconds(row.expires_utc);
  if (expires) cookie.expirationDate = expires;
  const sameSite = sameSiteValue(row.samesite);
  if (sameSite) cookie.sameSite = sameSite;
  return cookie;
}

async function readClaudeCookies() {
  const data = findDataDir();
  if (!data) {
    throw new ClaudeError('desktop_not_found', 'Приложение Claude не найдено на этом ПК');
  }
  if (isClaudeRunning()) {
    throw new ClaudeError('desktop_locked', 'Claude запущен — закройте приложение и повторите');
  }
  let keyError = null;
  const key = await readChromiumKey(data.dataDir).catch((err) => {
    if (err instanceof ClaudeError) {
      // Старый профиль мог вообще не иметь Local State — попробуем DPAPI на самих cookie.
      keyError = err;
      return null;
    }
    throw new ClaudeError('desktop_crypto_failed', err.message);
  });
  const rows = readCookieRows(data.cookieDb);
  const cookies = [];
  let cryptoFailure = null;
  for (const row of rows) {
    const host = String(row.host_key || '');
    if (!CLAUDE_HOST.test(host)) continue;
    let value = row.value == null ? '' : String(row.value);
    if (!value && row.encrypted_value) {
      value = await decryptCookie(row.encrypted_value, key, host).catch((err) => {
        if (err instanceof ClaudeError && err.kind === 'desktop_unsupported') throw err;
        cryptoFailure = err;
        return '';
      });
    }
    if (!value) continue;
    cookies.push(toCookie(row, value));
  }
  if (!cookies.some((cookie) => cookie.name === 'sessionKey' && cookie.value.length > 20)) {
    if (cryptoFailure) throw cryptoFailure;
    if (keyError) throw keyError;
    throw new ClaudeError(
      'desktop_not_logged_in',
      'В приложении Claude нет активного входа — откройте его и войдите в аккаунт',
    );
  }
  return { cookies, dataDir: data.dataDir, cookieDb: data.cookieDb };
}

function inspectClaudeDesktop() {
  const exePath = findInstall();
  const data = findDataDir();
  const running = isClaudeRunning();
  let cookieNames = null;
  if (data && !running) {
    try {
      cookieNames = listCookieNames(data.cookieDb);
    } catch {
      cookieNames = null;
    }
  }
  return {
    installed: Boolean(exePath),
    exePath,
    dataDir: data?.dataDir || '',
    cookieDb: data?.cookieDb || '',
    running,
    cookieCount: cookieNames ? cookieNames.length : null,
    hasSessionKey: cookieNames ? cookieNames.includes('sessionKey') : null,
  };
}

async function applyClaudeCookies(ses, cookies) {
  try {
    const existing = await ses.cookies.get({});
    for (const cookie of existing) {
      if (!CLAUDE_HOST.test(String(cookie.domain || ''))) continue;
      await ses.cookies.remove('https://claude.ai/', cookie.name).catch(() => {});
    }
  } catch {
    /* чистим best-effort */
  }
  let applied = 0;
  for (const cookie of cookies) {
    try {
      await ses.cookies.set({ url: 'https://claude.ai/', ...cookie });
      applied += 1;
    } catch {
      /* отдельная cookie может не подойти — остальные важнее */
    }
  }
  if (!applied) {
    throw new ClaudeError('desktop_crypto_failed', 'Не удалось перенести cookie Claude');
  }
  return applied;
}

module.exports = {
  appDataRoots,
  findInstall,
  findDataDir,
  inspectClaudeDesktop,
  isClaudeRunning,
  closeClaudeApp,
  readClaudeCookies,
  applyClaudeCookies,
  decryptCookie,
  decryptAesGcm,
  stripDomainHash,
  readChromiumKey,
  expiresToSeconds,
  sameSiteValue,
  COOKIE_SUBDIRS,
};
