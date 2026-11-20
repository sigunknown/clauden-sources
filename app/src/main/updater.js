'use strict';

let electron = {};
try {
  electron = require('electron');
} catch {
  /* unit tests run without the Electron runtime */
}
const app = electron.app || null;

let cachedUpdater = null;
function defaultUpdater() {
  if (cachedUpdater) return cachedUpdater;
  const { autoUpdater } = require('electron-updater');
  cachedUpdater = autoUpdater;
  return cachedUpdater;
}

const DEFAULT_FEED = 'https://clauden.best/downloads/updates';

function normalizeNotes(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 6000);
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        const version = entry?.version ? `${entry.version}: ` : '';
        return `${version}${entry?.note || ''}`;
      })
      .join('\n')
      .slice(0, 6000);
  }
  return '';
}

/**
 * Автообновление через electron-updater (generic-провайдер).
 *
 * latest.yml и файлы установщика лежат на clauden.best/downloads/updates.
 * Обновление скачивается в фоне и ставится по кнопке или при выходе.
 * Подпись кода не настроена: SHA-512 из latest.yml проверяется, но SmartScreen
 * может предупредить о неизвестном издателе.
 */
class UpdateManager {
  constructor({
    logger = () => {},
    getWindow = () => null,
    updater = null,
    appVersion = '',
    packaged = null,
    feedUrl = '',
    onDownloaded = null,
    platform = process.platform,
  } = {}) {
    this.log = logger;
    this.getWindow = getWindow;
    this.updater = updater || defaultUpdater();
    this.onDownloaded = onDownloaded;
    this.notifiedVersion = '';
    this.platform = platform;
    this.appImage = Boolean(process.env.APPIMAGE);
    this.packaged = packaged == null ? Boolean(app?.isPackaged) : Boolean(packaged);
    this.feedUrl = feedUrl || process.env.CLAUDEN_UPDATE_URL || DEFAULT_FEED;
    this.state = {
      status: 'idle',
      currentVersion: appVersion || app?.getVersion?.() || '',
      version: '',
      percent: 0,
      bytesPerSecond: 0,
      transferred: 0,
      total: 0,
      releaseNotes: '',
      releaseDate: '',
      checkedAt: 0,
      error: '',
    };

    try {
      if (typeof this.updater.setFeedURL === 'function') {
        this.updater.setFeedURL({ provider: 'generic', url: this.feedUrl });
      }
      this.updater.autoDownload = true;
      this.updater.autoInstallOnAppQuit = true;
    } catch (err) {
      this.log(`[update] setup failed: ${err.message}`);
    }

    this.#bind();
  }

  #bind() {
    const on = (event, handler) => {
      try {
        this.updater.on(event, handler);
      } catch (err) {
        this.log(`[update] cannot subscribe ${event}: ${err.message}`);
      }
    };

    on('checking-for-update', () => {
      this.#set({ status: 'checking', error: '' });
    });
    on('update-available', (info) => {
      this.#set({
        status: 'available',
        version: String(info?.version || ''),
        releaseDate: String(info?.releaseDate || ''),
        releaseNotes: normalizeNotes(info?.releaseNotes),
        percent: 0,
      });
    });
    on('update-not-available', () => {
      this.#set({ status: 'latest', checkedAt: Date.now(), percent: 0 });
    });
    on('download-progress', (progress) => {
      this.#set({
        status: 'downloading',
        percent: Math.max(0, Math.min(100, Math.round(Number(progress?.percent) || 0))),
        bytesPerSecond: Math.max(0, Math.round(Number(progress?.bytesPerSecond) || 0)),
        transferred: Math.max(0, Number(progress?.transferred) || 0),
        total: Math.max(0, Number(progress?.total) || 0),
      });
    });
    on('update-downloaded', (info) => {
      this.#set({
        status: 'downloaded',
        version: String(info?.version || this.state.version),
        releaseDate: String(info?.releaseDate || this.state.releaseDate),
        releaseNotes: normalizeNotes(info?.releaseNotes) || this.state.releaseNotes,
        percent: 100,
        checkedAt: Date.now(),
      });
      const version = this.state.version;
      if (version && version !== this.notifiedVersion) {
        this.notifiedVersion = version;
        try {
          this.onDownloaded?.(this.status());
        } catch (err) {
          this.log(`[update] downloaded callback failed: ${err.message}`);
        }
      }
    });
    on('error', (err) => this.#fail(err));
  }

  #sanitize(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
  }

  #fail(err) {
    const message = this.#sanitize(err?.message || err || 'Не удалось проверить обновления');
    this.log(`[update] error: ${message}`);
    this.#set({ status: 'error', error: message, checkedAt: Date.now() });
  }

  #set(patch) {
    this.state = { ...this.state, ...patch };
    this.#send();
  }

  #send() {
    const win = this.getWindow();
    if (!win || win.isDestroyed?.()) return;
    try {
      win.webContents.send('update:event', this.status());
    } catch (err) {
      this.log(`[update] send failed: ${err.message}`);
    }
  }

  status() {
    return { ...this.state };
  }

  async check() {
    if (!this.packaged) {
      this.#set({ status: 'dev' });
      return this.status();
    }
    if (this.platform === 'linux' && !this.appImage) {
      this.#set({
        status: 'error',
        error: 'Автообновление доступно только в AppImage-сборке. .deb обновляется пакетным менеджером.',
        checkedAt: Date.now(),
      });
      return this.status();
    }
    // macOS-сборка пока без подписи Apple, поэтому Squirrel не сможет
    // проверить и установить обновление. Новую версию ставим вручную.
    if (this.platform === 'darwin') {
      this.#set({
        status: 'unsupported',
        error: 'macOS-сборка обновляется вручную: скачайте новый архив на clauden.best',
        checkedAt: Date.now(),
      });
      return this.status();
    }
    if (this.state.status === 'checking' || this.state.status === 'downloading') {
      return this.status();
    }
    this.#set({ status: 'checking', error: '', checkedAt: Date.now() });
    try {
      await this.updater.checkForUpdates();
    } catch (err) {
      this.#fail(err);
    }
    return this.status();
  }

  install() {
    if (this.state.status !== 'downloaded') {
      return { ok: false, error: 'Обновление ещё не скачано' };
    }
    this.log(`[update] install ${this.state.version}`);
    setTimeout(() => {
      try {
        this.updater.quitAndInstall(false, true);
      } catch (err) {
        this.#fail(err);
      }
    }, 50);
    return { ok: true };
  }
}

module.exports = { UpdateManager, DEFAULT_FEED, normalizeNotes };
