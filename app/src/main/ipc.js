'use strict';

const { app, ipcMain, shell, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { ClaudeError } = require('./claude-client');

const ALLOWED_SENDER = /^(https:\/\/(www\.)?clauden\.best\/|http:\/\/(127\.0\.0\.1|localhost):\d+\/|file:\/\/)/i;

function assertSender(event) {
  const url = event?.senderFrame?.url || '';
  if (!ALLOWED_SENDER.test(url)) {
    throw new Error('IPC: origin not allowed');
  }
}

/** Безопасный путь внутри выбранной пользователем папки проекта. */
function safeLocalPath(root, rel) {
  const base = path.resolve(String(root || ''));
  const target = path.resolve(base, String(rel || '.').replace(/^[/\\]+/, ''));
  const inside = target === base || target.startsWith(base + path.sep);
  if (!inside) throw new Error('Путь вне проекта');
  return { base, target, rel: path.relative(base, target).split(path.sep).join('/') };
}

function clampString(value, max) {  if (value == null) return '';
  return String(value).slice(0, max);
}

function normalizeMessages(value) {
  if (!Array.isArray(value)) return [];
  const messages = [];
  let total = 0;
  for (const message of value.slice(0, 300)) {
    const role = message?.role === 'assistant' ? 'assistant' : message?.role === 'system' ? 'system' : 'user';
    const content = clampString(message?.content, 200_000);
    if (!content.trim()) continue;
    if (total + content.length > 1_500_000) break;
    total += content.length;
    messages.push({ role, content });
  }
  return messages;
}

function normalizeAttachments(value) {
  if (!Array.isArray(value)) return [];
  const files = [];
  let total = 0;
  for (const file of value.slice(0, 10)) {
    const data = String(file?.data || '');
    if (!data || data.length > 32_000_000) continue;
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(data)) continue;
    let bytes = 0;
    try {
      bytes = Buffer.from(data, 'base64').length;
    } catch {
      continue;
    }
    if (!bytes) continue;
    if (total + data.length > 80_000_000) break;
    total += data.length;
    files.push({
      name: clampString(file?.name, 200) || 'file',
      mime: clampString(file?.mime, 120) || 'application/octet-stream',
      data,
    });
  }
  return files;
}

function serializeError(err) {
  if (err instanceof ClaudeError) {
    return { kind: err.kind, message: err.message, retryAt: err.retryAt || 0 };
  }
  if (err && typeof err.kind === 'string' && err.kind) {
    return { kind: err.kind, message: String(err.message || err), retryAt: 0 };
  }
  return { kind: 'other', message: String(err?.message || err || 'Ошибка'), retryAt: 0 };
}

function registerIpc({ claudeSession, customApi, updater, proxy, logger, getWindow, openBrowser }) {
  const streams = new Map();
  const customStreams = new Map();

  const guard = async (fn) => {
    try {
      return { ok: true, data: await fn() };
    } catch (err) {
      logger.warn(`[ipc] ${err?.message || err}`);
      return { ok: false, error: serializeError(err) };
    }
  };

  ipcMain.handle('app:info', (event) => {
    assertSender(event);
    return {
      ok: true,
      data: {
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        platform: process.platform,
        arch: process.arch,
        isDesktop: true,
      },
    };
  });

  ipcMain.handle('app:openExternal', async (event, url) => {
    assertSender(event);
    try {
      const target = new URL(String(url || ''));
      if (target.protocol !== 'https:' && target.protocol !== 'http:') return { ok: false };
      await shell.openExternal(target.toString());
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('app:openBrowser', (event, url) => {
    assertSender(event);
    try {
      const target = new URL(String(url || ''));
      if (!['https:', 'http:'].includes(target.protocol)) return { ok: false };
      const opened = openBrowser ? openBrowser(target.toString()) : false;
      return { ok: Boolean(opened) };
    } catch {
      return { ok: false };
    }
  });

  // Доступ к папке проекта для веб-режима Code внутри десктопа. Путь всегда
  // проверяется относительно корня, который выбрал пользователь.
  ipcMain.handle('local:pickFolder', async (event) => {
    assertSender(event);
    const result = await dialog.showOpenDialog(getWindow() || undefined, {
      title: 'Выберите папку проекта',
      properties: ['openDirectory', 'createDirectory'],
    });
    return { ok: true, data: result.canceled ? '' : result.filePaths[0] || '' };
  });

  ipcMain.handle('local:blankRoot', async (event) => {
    assertSender(event);
    const dir = path.join(app.getPath('userData'), 'workspaces', `blank-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    return { ok: true, data: dir };
  });

  ipcMain.handle('local:list', (event, payload) => {
    assertSender(event);
    return guard(async () => {
      const { target, rel } = safeLocalPath(payload?.root, payload?.dir || '');
      const stat = fs.statSync(target);
      if (!stat.isDirectory()) throw new Error('Это не папка');
      const entries = [];
      for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const full = path.join(target, entry.name);
        let info;
        try {
          info = fs.lstatSync(full);
        } catch {
          continue;
        }
        entries.push({
          name: entry.name,
          path: rel ? `${rel}/${entry.name}` : entry.name,
          type: entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : 'file',
          size: info.size,
          mtime: info.mtimeMs,
        });
      }
      entries.sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1;
        if (a.type !== 'dir' && b.type === 'dir') return 1;
        return a.name.localeCompare(b.name);
      });
      return { path: rel || '.', parent: rel ? path.posix.dirname(rel) : '', entries };
    });
  });

  ipcMain.handle('local:read', (event, payload) => {
    assertSender(event);
    return guard(async () => {
      const { target, rel } = safeLocalPath(payload?.root, payload?.file || '');
      const stat = fs.statSync(target);
      if (!stat.isFile()) throw new Error('Это не файл');
      if (stat.size > 400 * 1024) throw new Error('Файл больше 400 КБ');
      const buffer = fs.readFileSync(target);
      const binary = buffer.includes(0);
      return { path: rel, size: stat.size, binary, content: binary ? '' : buffer.toString('utf8') };
    });
  });

  ipcMain.handle('local:write', (event, payload) => {
    assertSender(event);
    return guard(async () => {
      const { target, rel } = safeLocalPath(payload?.root, payload?.file || '');
      const text = String(payload?.content ?? '');
      if (text.length > 500 * 1024) throw new Error('Файл слишком большой');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text, 'utf8');
      return { ok: true, path: rel, size: Buffer.byteLength(text) };
    });
  });

  /**
   * OAuth-коннекторы OpenCode ждут callback на 127.0.0.1:<port>. Этот адрес
   * находится на компьютере пользователя, поэтому слушаем его в Electron и
   * отдаём пойманный URL обратно в веб-интерфейс для завершения входа.
   */
  ipcMain.handle('oauth:capture', async (event, payload) => {
    assertSender(event);
    const port = Number(payload?.port);
    const pathname = String(payload?.path || '/callback').slice(0, 200);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return { ok: false, error: { kind: 'bad_port', message: 'Некорректный порт OAuth' } };
    }
    return guard(
      () =>
        new Promise((resolve, reject) => {
          let done = false;
          const server = http.createServer((req, res) => {
            const current = new URL(req.url || '/', `http://127.0.0.1:${port}`);
            if (current.pathname !== pathname) {
              res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('Not found');
              return;
            }
            if (done) return;
            done = true;
            const callbackUrl = current.toString();
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(
              '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Готово</title>' +
                '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#171412;' +
                'color:#f2ede6;font:16px/1.5 sans-serif;text-align:center}</style></head><body><div>' +
                '<h1>Вход завершён</h1><p>Вернитесь в Clauden — можно закрыть эту вкладку.</p></div></body></html>',
            );
            clearTimeout(timer);
            server.close();
            resolve({ callbackUrl });
          });
          const timer = setTimeout(() => {
            if (done) return;
            done = true;
            server.close();
            reject(new Error('Браузер не вернулся на localhost за 3 минуты'));
          }, 180_000);
          server.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
          });
          server.listen(port, '127.0.0.1');
        }),
    );
  });

  ipcMain.handle('app:openLogs', (event) => {
    assertSender(event);
    try {
      shell.showItemInFolder(logger.file);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('app:retry', async (event) => {
    assertSender(event);
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      await win.loadURL(process.env.CLAUDEN_WEB_URL || 'https://clauden.best').catch(() => {});
    }
    return { ok: true };
  });

  ipcMain.handle('claude:status', (event, options) => {
    assertSender(event);
    return guard(() => claudeSession.status({ validate: Boolean(options?.validate) }));
  });

  ipcMain.handle('claude:login', (event) => {
    assertSender(event);
    return guard(() => claudeSession.login());
  });

  ipcMain.handle('claude:logout', (event) => {
    assertSender(event);
    return guard(() => claudeSession.logout());
  });

  ipcMain.handle('claude:refresh', (event) => {
    assertSender(event);
    return guard(() => claudeSession.refresh());
  });

  ipcMain.handle('claude:desktop/status', (event) => {
    assertSender(event);
    return guard(() => claudeSession.desktopStatus());
  });

  ipcMain.handle('claude:desktop/import', (event, options) => {
    assertSender(event);
    return guard(() => claudeSession.importFromDesktop({ closeApp: Boolean(options?.closeApp) }));
  });

  ipcMain.handle('claude:models', (event) => {
    assertSender(event);
    return guard(() => claudeSession.models());
  });

  ipcMain.handle('claude:exit-ip', (event) => {
    assertSender(event);
    return guard(() => claudeSession.exitIp());
  });

  ipcMain.handle('claude:download', (event, file) => {
    assertSender(event);
    return guard(() =>
      claudeSession.download(
        {
          id: clampString(file?.id, 200),
          name: clampString(file?.name, 200),
          url: clampString(file?.url, 2000),
          mime: clampString(file?.mime, 120),
          path: clampString(file?.path, 1000),
        },
        clampString(file?.conversationId, 100),
      ),
    );
  });

  ipcMain.handle('claude:import/list', async (event, options) => {
    assertSender(event);
    const offset = Math.max(0, Number(options?.offset) || 0);
    const limit = Math.min(100, Math.max(1, Number(options?.limit) || 50));
    const result = await guard(() => claudeSession.listConversations({ offset, limit }));
    const count = Array.isArray(result?.data) ? result.data.length : 0;
    logger.info(`[claude] import/list offset=${offset} limit=${limit} -> ${result?.ok ? count : 'error: ' + (result?.error?.message || '')}`);
    return result;
  });

  ipcMain.handle('claude:import/one', (event, summary) => {
    assertSender(event);
    return guard(() =>
      claudeSession.importConversation({
        uuid: clampString(summary?.uuid, 100),
        name: clampString(summary?.name, 200),
        updatedAt: Number(summary?.updatedAt) || 0,
      }),
    );
  });

  ipcMain.handle('claude:start', (event, payload) => {
    assertSender(event);
    const streamId = clampString(payload?.streamId, 80);
    if (!/^[A-Za-z0-9_-]{6,80}$/.test(streamId)) {
      throw new Error('claude:start: bad stream id');
    }
    if (streams.has(streamId)) {
      throw new Error('claude:start: stream already running');
    }
    const controller = new AbortController();
    streams.set(streamId, controller);
    const sender = event.sender;
    const send = (data) => {
      if (!sender.isDestroyed()) sender.send('claude:event', { streamId, ...data });
    };
    const request = {
      conversationId: clampString(payload?.conversationId, 100),
      model: clampString(payload?.model, 100),
      messages: normalizeMessages(payload?.messages),
      system: clampString(payload?.system, 200_000),
      project: clampString(payload?.project, 200_000),
      memory: clampString(payload?.memory, 100_000),
      attachments: normalizeAttachments(payload?.attachments),
      webSearch: Boolean(payload?.webSearch),
      thinking: Boolean(payload?.thinking),
      signal: controller.signal,
      onConversation: (conversationId) => send({ type: 'conversation', conversationId }),
      onDelta: (text) => send({ type: 'delta', text }),
      onStep: (step) => send({ type: 'step', step }),
    };
    logger.info(`[claude] stream start chat=${clampString(payload?.chatId, 80)} model=${request.model}`);
    claudeSession.clientInstance
      .stream(request)
      .then((text) => {
        logger.info(`[claude] stream done chars=${text.length}`);
        send({ type: 'done', text });
      })
      .catch((err) => {
        logger.warn(`[claude] stream error ${err?.message || err}`);
        if (err instanceof ClaudeError && err.kind === 'unauthorized') {
          claudeSession.invalidate?.();
        }
        send({ type: 'error', error: serializeError(err) });
      })
      .finally(() => streams.delete(streamId));
    return { ok: true, data: { streamId } };
  });

  ipcMain.handle('claude:stop', (event, streamId) => {
    assertSender(event);
    const controller = streams.get(String(streamId || ''));
    if (controller) {
      controller.abort();
      streams.delete(String(streamId));
      return { ok: true, data: { stopped: true } };
    }
    return { ok: true, data: { stopped: false } };
  });

  /* ---------------- свои OpenAI-совместимые API ---------------- */

  ipcMain.handle('customApi:list', (event) => {
    assertSender(event);
    return guard(() => customApi.list());
  });

  ipcMain.handle('customApi:get', (event, id) => {
    assertSender(event);
    return guard(() => customApi.get(clampString(id, 100)));
  });

  ipcMain.handle('customApi:save', (event, payload) => {
    assertSender(event);
    return guard(() =>
      customApi.save({
        id: clampString(payload?.id, 100),
        name: clampString(payload?.name, 80),
        baseUrl: clampString(payload?.baseUrl, 2000),
        apiKey: clampString(payload?.apiKey, 4000),
        models: Array.isArray(payload?.models) ? payload.models.slice(0, 800) : [],
      }),
    );
  });

  ipcMain.handle('customApi:remove', (event, id) => {
    assertSender(event);
    return guard(() => customApi.remove(clampString(id, 100)));
  });

  ipcMain.handle('customApi:test', (event, payload) => {
    assertSender(event);
    return guard(() =>
      customApi.test({
        id: clampString(payload?.id, 100),
        baseUrl: clampString(payload?.baseUrl, 2000),
        apiKey: clampString(payload?.apiKey, 4000),
      }),
    );
  });

  ipcMain.handle('customApi:start', (event, payload) => {
    assertSender(event);
    const streamId = clampString(payload?.streamId, 80);
    if (!/^[A-Za-z0-9_-]{6,80}$/.test(streamId)) {
      throw new Error('customApi:start: bad stream id');
    }
    if (customStreams.has(streamId)) {
      throw new Error('customApi:start: stream already running');
    }
    const controller = new AbortController();
    customStreams.set(streamId, controller);
    const sender = event.sender;
    const send = (data) => {
      if (!sender.isDestroyed()) sender.send('customApi:event', { streamId, ...data });
    };
    const request = {
      apiId: clampString(payload?.apiId, 100),
      model: clampString(payload?.model, 200),
      messages: normalizeMessages(payload?.messages),
      system: clampString(payload?.system, 120_000),
      attachments: normalizeAttachments(payload?.attachments),
      signal: controller.signal,
      onDelta: (text) => send({ type: 'delta', text }),
    };
    logger.info(`[custom-api] stream start api=${request.apiId} model=${request.model}`);
    customApi
      .stream(request)
      .then((text) => {
        logger.info(`[custom-api] stream done chars=${text.length}`);
        send({ type: 'done', text });
      })
      .catch((err) => {
        logger.warn(`[custom-api] stream error ${err?.message || err}`);
        send({ type: 'error', error: serializeError(err) });
      })
      .finally(() => customStreams.delete(streamId));
    return { ok: true, data: { streamId } };
  });

  ipcMain.handle('customApi:stop', (event, streamId) => {
    assertSender(event);
    const controller = customStreams.get(String(streamId || ''));
    if (controller) {
      controller.abort();
      customStreams.delete(String(streamId));
      return { ok: true, data: { stopped: true } };
    }
    return { ok: true, data: { stopped: false } };
  });

  /* ---------------- прокси и VPN ---------------- */

  ipcMain.handle('proxy:state', (event) => {
    assertSender(event);
    if (!proxy) return { ok: false, error: { kind: 'unsupported', message: 'Прокси недоступен' } };
    return { ok: true, data: proxy.snapshot() };
  });

  ipcMain.handle('proxy:own-exit', (event) => {
    assertSender(event);
    if (!proxy) return { ok: false, error: { kind: 'unsupported', message: 'Прокси недоступен' } };
    return guard(async () => {
      await proxy.checkOwnExit();
      return proxy.snapshot();
    });
  });

  ipcMain.handle('proxy:refresh', (event) => {
    assertSender(event);
    if (!proxy) return { ok: false, error: { kind: 'unsupported', message: 'Прокси недоступен' } };
    return guard(async () => {
      await proxy.refreshBuiltin();
      return proxy.snapshot();
    });
  });

  ipcMain.handle('proxy:subscribe', (event, payload) => {
    assertSender(event);
    if (!proxy) return { ok: false, error: { kind: 'unsupported', message: 'Прокси недоступен' } };
    return guard(async () => {
      await proxy.subscribe(clampString(payload?.input, 20000));
      return proxy.snapshot();
    });
  });

  ipcMain.handle('proxy:select', (event, id) => {
    assertSender(event);
    if (!proxy) return { ok: false, error: { kind: 'unsupported', message: 'Прокси недоступен' } };
    return guard(() => proxy.select(clampString(id, 120)));
  });

  ipcMain.handle('proxy:connect', (event, id) => {
    assertSender(event);
    if (!proxy) return { ok: false, error: { kind: 'unsupported', message: 'Прокси недоступен' } };
    return guard(() => proxy.start(id ? clampString(id, 120) : undefined));
  });

  ipcMain.handle('proxy:disconnect', (event) => {
    assertSender(event);
    if (!proxy) return { ok: false, error: { kind: 'unsupported', message: 'Прокси недоступен' } };
    return guard(() => proxy.stop());
  });

  ipcMain.handle('proxy:ping', (event, id) => {
    assertSender(event);
    if (!proxy) return { ok: false, error: { kind: 'unsupported', message: 'Прокси недоступен' } };
    return guard(() => proxy.ping(clampString(id, 120)));
  });

  ipcMain.handle('proxy:autostart', (event, value) => {
    assertSender(event);
    if (!proxy) return { ok: false, error: { kind: 'unsupported', message: 'Прокси недоступен' } };
    return guard(() => proxy.setAutoStart(Boolean(value)));
  });

  /* ---------------- автообновление ---------------- */

  ipcMain.handle('update:status', (event) => {
    assertSender(event);
    if (!updater) return { ok: true, data: { status: 'unsupported' } };
    return { ok: true, data: updater.status() };
  });

  ipcMain.handle('update:check', (event) => {
    assertSender(event);
    if (!updater) return { ok: true, data: { status: 'unsupported' } };
    return guard(() => updater.check());
  });

  ipcMain.handle('update:install', (event) => {
    assertSender(event);
    if (!updater) return { ok: false, error: { kind: 'unsupported', message: 'Автообновление недоступно' } };
    return { ok: true, data: updater.install() };
  });
}

module.exports = { registerIpc };
