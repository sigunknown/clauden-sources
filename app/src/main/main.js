'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Menu, Notification, Tray, session, shell } = require('electron');
const { createLogger } = require('./logger');
const { ClaudeSessionManager } = require('./claude-session');
const { MockClaudeSession } = require('./claude-mock');
const { CustomApiManager } = require('./custom-api');
const { ProxyManager } = require('./proxy');
const { UpdateManager } = require('./updater');
const { registerIpc } = require('./ipc');
const { openRuntimeWindow } = require('./runtime-window');

const APP_URL = process.env.CLAUDEN_WEB_URL || 'https://clauden.best';
const APP_HOSTS = new Set(['clauden.best', 'www.clauden.best']);
const AUTH_HOSTS = new Set([
  'clauden.best',
  'www.clauden.best',
  'gwarden.su',
  'www.gwarden.su',
  'accounts.google.com',
  'appleid.apple.com',
  'challenges.cloudflare.com',
]);

app.setName('Clauden');
if (process.platform === 'win32') app.setAppUserModelId('space.teleopen.clauden');

const logger = createLogger(path.join(app.getPath('userData'), 'clauden-desktop.log'));
let mainWindow = null;
let browserWindow = null;
let claudeSession = null;
let proxyManager = null;
let tray = null;
let isQuitting = false;
let trayNoticeShown = false;

function chromeUserAgent() {
  const chrome = process.versions.chrome || '140.0.0.0';
  const platform =
    process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

function parseUrl(value) {
  try {
    return new URL(String(value || ''));
  } catch {
    return null;
  }
}

function isAppUrl(url) {
  return Boolean(url && url.protocol === 'https:' && APP_HOSTS.has(url.hostname));
}

function findDeepLink(argv) {
  return (Array.isArray(argv) ? argv : []).find((arg) => /^clauden:\/\//i.test(String(arg || '')));
}

/**
 * Google-вход в системном браузере возвращается по clauden://auth с
 * подписанным профилем. Открываем страницу моста в основном окне: она
 * обменивает payload на обычную сессию Clauden и остаётся в localStorage.
 */
function handleDeepLink(raw) {
  const target = parseUrl(raw);
  if (!target || target.protocol !== 'clauden:') return false;
  if (target.hostname !== 'auth') {
    logger.warn(`[auth] unknown deep link ${target.hostname}`);
    return false;
  }
  const payload = target.searchParams.get('payload') || '';
  const sig = target.searchParams.get('sig') || '';
  if (!payload || !sig) return false;
  const bridge = new URL('/auth/bridge', APP_URL);
  bridge.searchParams.set('payload', payload);
  bridge.searchParams.set('sig', sig);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.loadURL(bridge.toString()).catch((err) => {
      logger.warn(`[auth] bridge load failed: ${err.message}`);
    });
  }
  return true;
}

function windowStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    const raw = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
    if (!raw || typeof raw !== 'object') return {};
    return {
      width: Math.max(940, Number(raw.width) || 1280),
      height: Math.max(620, Number(raw.height) || 860),
      x: Number.isFinite(Number(raw.x)) ? Number(raw.x) : undefined,
      y: Number.isFinite(Number(raw.y)) ? Number(raw.y) : undefined,
      maximized: Boolean(raw.maximized),
    };
  } catch {
    return {};
  }
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const bounds = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(
      windowStateFile(),
      JSON.stringify({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        maximized: win.isMaximized(),
      }),
      { mode: 0o600 },
    );
  } catch {
    /* ignore */
  }
}

function setupPermissions(ses) {
  const allowed = new Set([
    'notifications',
    'media',
    'clipboard-read',
    'clipboard-sanitized-write',
    'fullscreen',
    'speaker-selection',
  ]);
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = parseUrl(details?.requestingUrl || webContents?.getURL() || '');
    callback(Boolean(url && isAppUrl(url) && allowed.has(permission)));
  });
  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const url = parseUrl(requestingOrigin || webContents?.getURL() || '');
    return Boolean(url && isAppUrl(url) && allowed.has(permission));
  });
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Файл',
      submenu: [{ role: 'quit', label: 'Выход' }],
    },
    {
      label: 'Вид',
      submenu: [
        { role: 'reload', label: 'Обновить' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Обычный масштаб' },
        { role: 'zoomIn', label: 'Крупнее' },
        { role: 'zoomOut', label: 'Мельче' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Полный экран' },
      ],
    },
    {
      label: 'Помощь',
      submenu: [
        {
          label: 'Clauden Runtime: компьютер и Computer Use',
          click: () => openRuntimeWindow({ parent: mainWindow, workspace: app.getPath('home') }).catch((err) => {
            Notification.isSupported() && new Notification({ title: 'Clauden Runtime', body: err.message }).show();
          }),
        },
        { type: 'separator' },
        { label: 'Открыть clauden.best', click: () => shell.openExternal('https://clauden.best') },
        { label: 'Папка с логами', click: () => shell.showItemInFolder(logger.file) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Встроенный браузер: отдельное окно внутри Clauden, а не системный Chrome.
 * Сайты из чата открываются здесь, cookie сохраняются в отдельной сессии.
 */
function openBrowser(rawUrl) {
  const target = parseUrl(rawUrl);
  if (!target || !['http:', 'https:'].includes(target.protocol)) return false;
  const url = target.toString();
  if (browserWindow && !browserWindow.isDestroyed()) {
    browserWindow.loadFile(path.join(__dirname, '..', 'browser.html'), { query: { url } });
    browserWindow.show();
    browserWindow.focus();
    return true;
  }
  browserWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 680,
    minHeight: 480,
    parent: mainWindow || undefined,
    title: 'Браузер — Clauden',
    backgroundColor: '#191919',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      spellcheck: true,
    },
  });
  browserWindow.webContents.on('did-attach-webview', (_event, contents) => {
    contents.setWindowOpenHandler(({ url: next }) => {
      const parsed = parseUrl(next);
      if (parsed && ['http:', 'https:'].includes(parsed.protocol)) {
        contents.loadURL(parsed.toString()).catch(() => {});
      }
      return { action: 'deny' };
    });
  });
  browserWindow.on('closed', () => {
    browserWindow = null;
  });
  browserWindow.loadFile(path.join(__dirname, '..', 'browser.html'), { query: { url } }).catch((err) => {
    logger.warn(`[browser] load failed: ${err.message}`);
  });
  return true;
}

function attachWindowHandlers(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    const target = parseUrl(url);
    if (!target) return { action: 'deny' };
    if (AUTH_HOSTS.has(target.hostname)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 720,
          minWidth: 380,
          minHeight: 520,
          autoHideMenuBar: true,
          backgroundColor: '#191919',
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            spellcheck: false,
          },
        },
      };
    }
    if (target.protocol === 'https:' || target.protocol === 'http:') {
      openBrowser(target.toString());
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const target = parseUrl(url);
    if (!target) {
      event.preventDefault();
      return;
    }
    if (isAppUrl(target)) return;
    event.preventDefault();
    if (target.protocol === 'https:' || target.protocol === 'http:') {
      openBrowser(target.toString());
    }
  });

  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  win.webContents.on('did-fail-load', (event, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    logger.warn(`[window] load failed ${code} ${description} ${failedUrl}`);
    win.loadFile(path.join(__dirname, 'offline.html')).catch(() => {});
  });

  win.webContents.on('render-process-gone', (event, details) => {
    logger.error(`[window] renderer gone: ${details?.reason || 'unknown'}`);
  });

  win.on('close', () => saveWindowState(win));
}

function createTray(updater) {
  if (process.platform !== 'win32') return;
  try {
    const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.ico');
    tray = new Tray(iconPath);
    tray.setToolTip('Clauden');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Открыть Clauden', click: () => showMainWindow() },
      {
        label: 'Clauden Runtime',
        click: () => openRuntimeWindow({ parent: mainWindow, workspace: app.getPath('home') }).catch((err) => {
          if (Notification.isSupported()) new Notification({ title: 'Clauden Runtime', body: err.message }).show();
        }),
      },
      { label: 'Проверить обновления', click: () => updater.check().catch(() => {}) },
      { type: 'separator' },
      { label: 'Выход', click: () => { isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', () => showMainWindow());
    tray.on('double-click', () => showMainWindow());
    logger.info('[tray] created');
  } catch (err) {
    tray = null;
    logger.warn(`[tray] unavailable: ${err.message}`);
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  if (trayNoticeShown) return;
  trayNoticeShown = true;
  try {
    if (!Notification.isSupported()) return;
    new Notification({
      title: 'Clauden',
      body: 'Приложение свёрнуто в трей и продолжает выполнять отложенные запросы и напоминания.',
    }).show();
  } catch {
    /* notification is optional */
  }
}

function createWindow() {
  const state = loadWindowState();
  // Windows: своя шапка + нативные кнопки окна поверх неё (как в Claude).
  const frameless = process.platform === 'win32';
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 940,
    minHeight: 620,
    show: false,
    title: 'Clauden',
    backgroundColor: '#191919',
    autoHideMenuBar: process.platform !== 'darwin',
    titleBarStyle: frameless ? 'hidden' : 'default',
    titleBarOverlay: frameless
      ? { color: '#191919', symbolColor: '#9c9c9c', height: 46 }
      : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      webviewTag: false,
      backgroundThrottling: false,
    },
  });
  if (state.maximized) mainWindow.maximize();
  attachWindowHandlers(mainWindow);
  const showTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
  }, 4000);
  mainWindow.once('ready-to-show', () => {
    clearTimeout(showTimer);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });
  mainWindow.on('close', (event) => {
    if (isQuitting || !tray) return;
    event.preventDefault();
    hideToTray();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadURL(APP_URL).catch((err) => {
    logger.warn(`[window] loadURL failed: ${err.message}`);
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('clauden', process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient('clauden');
  }

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    const link = findDeepLink(argv);
    if (link) handleDeepLink(link);
  });

  app.whenReady().then(async () => {
    const userAgent = chromeUserAgent();
    app.userAgentFallback = userAgent;
    logger.info(`[app] start version=${app.getVersion()} electron=${process.versions.electron} chrome=${process.versions.chrome} platform=${process.platform}`);
    setupPermissions(session.defaultSession);
    const mockClaude = !app.isPackaged && process.argv.includes('--mock-claude');
    claudeSession = mockClaude
      ? new MockClaudeSession()
      : new ClaudeSessionManager({
          logger: (message) => logger.info(message),
          userAgent,
          getWindow: () => mainWindow,
        });
    if (claudeSession.ses) setupPermissions(claudeSession.ses);
    if (mockClaude) logger.warn('[claude] MOCK MODE enabled');
    const customApi = new CustomApiManager({ logger: (message) => logger.info(message) });
    const proxy = (proxyManager = new ProxyManager({
      app,
      logger: (message) => logger.info(message),
      getSessions: () => [session.defaultSession, claudeSession?.ses],
      onEvent: (payload) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send('proxy:event', payload);
      },
    }));
    const updater = new UpdateManager({
      logger: (message) => logger.info(message),
      getWindow: () => mainWindow,
      onDownloaded: (state) => {
        try {
          if (!Notification.isSupported()) return;
          const note = new Notification({
            title: 'Clauden',
            body: `Обновление ${state.version || ''} скачано. Установите его в Настройках → Обновления.`,
          });
          note.on('click', () => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            mainWindow.show();
            mainWindow.focus();
          });
          note.show();
        } catch (err) {
          logger.warn(`[update] notification failed: ${err.message}`);
        }
      },
    });
    registerIpc({ claudeSession, customApi, updater, proxy, logger, getWindow: () => mainWindow, openBrowser });
    buildMenu();
    createWindow();
    createTray(updater);

    if (process.argv.includes('--runtime')) {
      openRuntimeWindow({ parent: mainWindow, workspace: app.getPath('home') }).catch((err) => logger.warn(`[runtime] ${err.message}`));
    }

    const initialLink = findDeepLink(process.argv);
    if (initialLink) setTimeout(() => handleDeepLink(initialLink), 1200);

    // Прокси, включённый в прошлый раз, поднимаем автоматически. Но если
    // человек уже выходит не из России, оставляем его настоящий выход:
    // общий встроенный узел только подменяет адрес и ловит 429 Anthropic.
    if (proxy.data.autoStart && proxy.data.selectedId) {
      setTimeout(() => {
        proxy.autoStart().catch((err) => logger.warn(`[proxy] autostart failed: ${err.message}`));
      }, 2500);
    }

    // На Linux автообновление умеет только AppImage (electron-updater
    // требует переменную APPIMAGE); .deb обновляется пакетным менеджером.
    const canAutoUpdate = process.platform !== 'linux' || Boolean(process.env.APPIMAGE);
    if (canAutoUpdate) {
      setTimeout(() => { updater.check().catch(() => {}); }, 20_000);
      setInterval(() => { updater.check().catch(() => {}); }, 6 * 60 * 60 * 1000);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !tray) app.quit();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (mainWindow) saveWindowState(mainWindow);
    if (proxyManager) proxyManager.dispose().catch(() => {});
  });
}

process.on('uncaughtException', (err) => {
  logger.error(`[app] uncaught: ${err?.stack || err}`);
});
process.on('unhandledRejection', (err) => {
  logger.error(`[app] unhandled rejection: ${err?.stack || err}`);
});

module.exports = { chromeUserAgent };
