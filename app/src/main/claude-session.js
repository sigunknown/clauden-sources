'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, safeStorage, session, app } = require('electron');
const { ClaudeClient, ClaudeError, DEFAULT_UA } = require('./claude-client');
const {
  inspectClaudeDesktop,
  closeClaudeApp,
  readClaudeCookies,
  applyClaudeCookies,
} = require('./claude-desktop');

const PARTITION = 'persist:claude';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Сессия claude.ai: вход в отдельном окне, cookie в Chromium-профиле
 * `persist:claude` (на Windows шифруются DPAPI), метаданные аккаунта —
 * в userData/claude-session.json (safeStorage, если доступен).
 */
class ClaudeSessionManager {
  constructor({ logger = () => {}, userAgent = DEFAULT_UA, getWindow = () => null } = {}) {
    this.log = logger;
    this.userAgent = userAgent;
    this.getWindow = getWindow;
    this.ses = session.fromPartition(PARTITION);
    this.ses.setUserAgent(userAgent, 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7');
    this.file = path.join(app.getPath('userData'), 'claude-session.json');
    this.meta = this.loadMeta();
    this.client = new ClaudeClient({
      transport: (url, init) => this.transport(url, init),
      userAgent,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      locale: 'ru-RU',
      log: (message) => this.log(`[claude] ${message}`),
    });
    this.client.setSession(this.meta);
    this.loginWindow = null;
    this.#setupHeaders();
  }

  #setupHeaders() {
    this.ses.webRequest.onBeforeSendHeaders((details, callback) => {
      try {
        const url = new URL(details.url);
        const isClaude = url.hostname === 'claude.ai' || url.hostname.endsWith('.claude.ai');
        // Не трогаем навигацию окна входа: API-заголовки нужны только
        // запросам клиента (xhr/fetch/other), а не главному документу.
        const isApi = details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame';
        if (isClaude && isApi) {
          details.requestHeaders.Referer = 'https://claude.ai/new';
          details.requestHeaders.Origin = 'https://claude.ai';
          details.requestHeaders['anthropic-client-platform'] = 'web_claude_ai';
          details.requestHeaders['Accept-Language'] = 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7';
        }
      } catch {
        /* ignore malformed urls */
      }
      callback({ requestHeaders: details.requestHeaders });
    });
  }

  transport(url, init = {}) {
    return this.ses.fetch(url, {
      ...init,
      bypassCustomProtocolHandlers: true,
    });
  }

  loadMeta() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      let plain = '';
      if (raw?.v === 2 && typeof raw.data === 'string') {
        if (!safeStorage.isEncryptionAvailable()) return null;
        plain = safeStorage.decryptString(Buffer.from(raw.data, 'base64'));
      } else if (typeof raw?.data === 'string') {
        plain = raw.data;
      } else {
        return null;
      }
      const parsed = JSON.parse(plain);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  saveMeta() {
    if (!this.meta) {
      try {
        fs.rmSync(this.file, { force: true });
      } catch {
        /* ignore */
      }
      return;
    }
    const plain = JSON.stringify(this.meta);
    let payload;
    if (safeStorage.isEncryptionAvailable()) {
      payload = { v: 2, data: safeStorage.encryptString(plain).toString('base64') };
    } else {
      payload = { v: 1, data: plain };
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file, JSON.stringify(payload), { mode: 0o600 });
    } catch (err) {
      this.log(`[claude] save session failed: ${err.message}`);
    }
  }

  async hasSessionCookie() {
    try {
      const cookies = await this.ses.cookies.get({ name: 'sessionKey' });
      return cookies.some((cookie) => cookie?.value && cookie.value.length > 20 && /claude\.ai$/i.test(cookie.domain || ''));
    } catch {
      return false;
    }
  }

  async cookieSummary() {
    try {
      const cookies = await this.ses.cookies.get({});
      return cookies.filter((cookie) => /claude\.ai$/i.test(cookie.domain || '')).map((cookie) => cookie.name);
    } catch {
      return [];
    }
  }

  publicStatus() {
    if (!this.meta?.orgId) return { linked: false };
    return {
      linked: true,
      email: this.meta.email || '',
      name: this.meta.name || '',
      plan: this.meta.plan || 'free',
      orgId: this.meta.orgId,
      source: this.meta.source === 'desktop' ? 'desktop' : 'login',
      desktopImportedAt: this.meta.desktopImportedAt || 0,
      linkedAt: this.meta.linkedAt || 0,
      lastOkAt: this.meta.lastOkAt || 0,
    };
  }

  /** Что видно про установленное приложение Claude (без чтения cookie). */
  desktopStatus() {
    const info = inspectClaudeDesktop();
    return {
      supported: process.platform === 'win32',
      ...info,
    };
  }

  /**
   * Перенос входа из официального приложения Claude: cookie читаются
   * локально, кладутся в наш раздел `persist:claude` и проверяются
   * запросом /api/account. На бэкенд Clauden ничего не уходит.
   */
  async importFromDesktop({ closeApp = false } = {}) {
    const info = inspectClaudeDesktop();
    this.log(
      `[claude] desktop detected installed=${info.installed} db=${Boolean(info.cookieDb)} running=${info.running} session=${info.hasSessionKey}`,
    );
    if (!info.cookieDb) {
      throw new ClaudeError('desktop_not_found', 'Приложение Claude не найдено на этом ПК');
    }
    if (info.running) {
      if (!closeApp) {
        throw new ClaudeError('desktop_locked', 'Claude запущен — закройте приложение и повторите');
      }
      const closed = await closeClaudeApp();
      if (!closed) {
        throw new ClaudeError('desktop_locked', 'Не удалось закрыть Claude — выйдите из него через трей и повторите');
      }
    }
    const { cookies } = await readClaudeCookies();
    const applied = await applyClaudeCookies(this.ses, cookies);
    this.log(`[claude] imported ${applied} cookies from desktop app`);
    this.meta = null;
    this.client.setSession(null);
    this.saveMeta();
    await this.refresh();
    this.meta = { ...this.meta, source: 'desktop', desktopImportedAt: Date.now() };
    this.saveMeta();
    return this.publicStatus();
  }

  async status({ validate = false } = {}) {
    const hasCookie = await this.hasSessionCookie();
    if (!hasCookie) {
      if (this.meta) {
        this.meta = null;
        this.client.setSession(null);
        this.saveMeta();
      }
      return { linked: false };
    }
    if (!this.meta?.orgId) {
      try {
        await this.refresh();
      } catch (err) {
        this.log(`[claude] status discover failed: ${err.message}`);
        return { linked: false, error: err.message, kind: err.kind || 'other' };
      }
    } else if (validate) {
      try {
        await this.refresh();
      } catch (err) {
        if (err instanceof ClaudeError && err.kind === 'unauthorized') {
          this.invalidate();
          return { linked: false, error: err.message, kind: err.kind };
        }
        return { ...this.publicStatus(), warning: err.message };
      }
    }
    return this.publicStatus();
  }

  invalidate() {
    this.meta = null;
    this.client.setSession(null);
    this.saveMeta();
  }

  async refresh() {
    const discovered = await this.client.discover();
    this.meta = {
      ...discovered,
      source: this.meta?.source === 'desktop' ? 'desktop' : 'login',
      desktopImportedAt: this.meta?.desktopImportedAt || 0,
      linkedAt: this.meta?.linkedAt || Date.now(),
      lastOkAt: Date.now(),
    };
    this.client.setSession(this.meta);
    this.saveMeta();
    return this.publicStatus();
  }

  async login() {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.focus();
      return { linked: false, pending: true };
    }
    if (await this.hasSessionCookie()) {
      try {
        await this.refresh();
        return this.publicStatus();
      } catch (err) {
        this.log(`[claude] existing cookie rejected: ${err.message}`);
      }
    }

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearInterval(timer);
        this.loginWindow = null;
        resolve(value);
      };

      const parent = this.getWindow();
      const win = new BrowserWindow({
        parent: parent && !parent.isDestroyed() ? parent : undefined,
        modal: false,
        width: 560,
        height: 780,
        minWidth: 420,
        minHeight: 560,
        title: 'Вход в Claude',
        backgroundColor: '#191919',
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
          partition: PARTITION,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          spellcheck: false,
        },
      });
      this.loginWindow = win;
      win.setMenuBarVisibility(false);
      win.once('ready-to-show', () => win.show());
      win.on('closed', () => {
        this.loginWindow = null;
        finish({ linked: false, cancelled: true });
      });
      win.webContents.setWindowOpenHandler(({ url }) => {
        try {
          const target = new URL(url);
          if (['https:', 'http:'].includes(target.protocol)) {
            win.loadURL(target.toString()).catch(() => {});
          }
        } catch {
          /* ignore */
        }
        return { action: 'deny' };
      });

      win.loadURL('https://claude.ai/login').catch((err) => {
        this.log(`[claude] login load failed: ${err.message}`);
      });

      const started = Date.now();
      timer = setInterval(async () => {
        if (win.isDestroyed()) {
          finish({ linked: false, cancelled: true });
          return;
        }
        if (Date.now() - started > LOGIN_TIMEOUT_MS) {
          if (!win.isDestroyed()) win.close();
          finish({ linked: false, cancelled: true, error: 'Время входа истекло' });
          return;
        }
        if (!(await this.hasSessionCookie())) return;
        clearInterval(timer);
        timer = null;
        await delay(1200);
        let lastError = null;
        let linked = false;
        // Cloudflare может ещё досматривать challenge: даём странице время
        // и пробуем прочитать аккаунт несколько раз, не закрывая окно.
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            await this.refresh();
            linked = true;
            break;
          } catch (err) {
            lastError = err;
            this.log(`[claude] login discover attempt ${attempt + 1}: ${err.message}`);
            if (err?.kind === 'unauthorized') break;
            await delay(2000);
          }
        }
        if (!win.isDestroyed()) win.close();
        if (linked) {
          finish(this.publicStatus());
        } else {
          finish({
            linked: false,
            error: lastError?.message || 'Claude не принял сессию',
            kind: lastError?.kind || 'other',
          });
        }
      }, 1500);
    });
  }

  async logout() {
    this.meta = null;
    this.client.setSession(null);
    this.saveMeta();
    try {
      await this.ses.clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers', 'websql'],
      });
    } catch (err) {
      this.log(`[claude] clear storage failed: ${err.message}`);
    }
    try {
      await this.ses.clearCache();
    } catch {
      /* ignore */
    }
    return { linked: false };
  }

  async models() {
    if (!this.meta?.orgId) {
      const status = await this.status();
      if (!status.linked) throw new ClaudeError('unauthorized', 'Claude не подключён');
    }
    try {
      const models = await this.client.listModels(this.meta.orgId, this.meta.plan);
      return { data: models };
    } catch (err) {
      if (err instanceof ClaudeError && err.kind === 'unauthorized') {
        this.invalidate();
      }
      throw err;
    }
  }

  /** IP, который claude.ai видит у этого компьютера (без входа тоже работает). */
  async exitIp() {
    return this.client.exitIp();
  }

  async download(file, conversationId = '') {
    if (!this.meta?.orgId) throw new ClaudeError('unauthorized', 'Claude не подключён');
    return this.client.downloadFile(this.meta.orgId, file, conversationId);
  }

  async listConversations(options) {
    if (!this.meta?.orgId) throw new ClaudeError('unauthorized', 'Claude не подключён');
    return this.client.listConversations(this.meta.orgId, options);
  }

  async importConversation(summary) {
    if (!this.meta?.orgId) throw new ClaudeError('unauthorized', 'Claude не подключён');
    return this.client.importConversation(this.meta.orgId, summary);
  }

  get clientInstance() {
    return this.client;
  }
}

module.exports = { ClaudeSessionManager, PARTITION };
