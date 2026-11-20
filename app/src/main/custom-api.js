'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
let electron = {};
try {
  electron = require('electron');
} catch {
  /* unit tests run without the Electron runtime */
}
const app = electron.app || null;
const safeStorage = electron.safeStorage || null;

/**
 * Свои OpenAI-совместимые API.
 *
 * Ключи лежат только на этом компьютере: весь список сериализуется в JSON
 * и шифруется safeStorage (на Windows — DPAPI, привязан к учётной записи).
 * Renderer никогда не получает сохранённый ключ обратно: в интерфейс
 * отдаётся только hasKey, а пустое поле при сохранении означает
 * «оставить прежний ключ».
 */

const MAX_APIS = 25;
const MAX_MODELS = 800;
const TEST_TIMEOUT_MS = 25_000;
const IDLE_TIMEOUT_MS = 180_000;
const MAX_MESSAGES = 300;
const MAX_MESSAGE_CHARS = 200_000;
const MAX_TOTAL_CHARS = 1_500_000;

class CustomApiError extends Error {
  constructor(kind, message, status = 0) {
    super(message);
    this.name = 'CustomApiError';
    this.kind = kind;
    this.status = status;
  }
}

function normalizeBaseUrl(value) {
  let raw = String(value || '').trim();
  if (!raw) throw new CustomApiError('invalid', 'Укажите Base URL');
  if (raw.length > 2000) throw new CustomApiError('invalid', 'Base URL слишком длинный');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new CustomApiError('invalid', 'Некорректный Base URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CustomApiError('invalid', 'Поддерживаются только http и https');
  }
  if (url.username || url.password) {
    throw new CustomApiError('invalid', 'Логин и пароль в адресе не поддерживаются — используйте ключ');
  }
  url.hash = '';
  url.search = '';
  let pathname = url.pathname.replace(/\/+$/, '');
  pathname = pathname.replace(/\/(?:chat\/completions|completions|models)$/i, '');
  url.pathname = pathname || '/';
  return url.toString().replace(/\/+$/, '');
}

function hostName(baseUrl) {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return 'API';
  }
}

function statusKind(status) {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'http';
}

function shortText(value, max = 400) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function errorMessage(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  try {
    const data = JSON.parse(text);
    const message = data?.error?.message || data?.message || data?.error || data?.detail;
    if (typeof message === 'string') return shortText(message);
  } catch {
    /* not json */
  }
  return shortText(text);
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text' || part?.text) return String(part.text || '');
      return '';
    })
    .join('');
}

/** Модели приходят в разных форматах: {data}, {models}, массив. */
function parseModels(payload) {
  const list = Array.isArray(payload)
    ? payload
    : payload?.data || payload?.models || payload?.result || payload?.items || [];
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const models = [];
  for (const item of list) {
    const id = String(item?.id || item?.name || item?.model || item?.slug || '').trim();
    if (!id || id.length > 200 || seen.has(id)) continue;
    seen.add(id);
    const name = String(item?.display_name || item?.name || item?.title || id).trim().slice(0, 200);
    models.push({ id, name: name || id });
    if (models.length >= MAX_MODELS) break;
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

/** Ручной список моделей: строки или объекты. */
function parseModelInput(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const models = [];
  for (const item of value.slice(0, MAX_MODELS)) {
    const id = String(typeof item === 'string' ? item : item?.id || '').trim();
    if (!id || id.length > 200 || seen.has(id)) continue;
    seen.add(id);
    const name = String((typeof item === 'object' && (item?.name || item?.display_name)) || id).trim().slice(0, 200);
    models.push({ id, name: name || id });
  }
  return models;
}

function normalizeMessages(value) {
  if (!Array.isArray(value)) return [];
  const messages = [];
  let total = 0;
  for (const message of value.slice(0, MAX_MESSAGES)) {
    const role = message?.role === 'assistant' ? 'assistant' : message?.role === 'system' ? 'system' : 'user';
    const content = contentText(message?.content).slice(0, MAX_MESSAGE_CHARS);
    if (!content.trim()) continue;
    if (total + content.length > MAX_TOTAL_CHARS) break;
    total += content.length;
    messages.push({ role, content });
  }
  return messages;
}

class CustomApiManager {
  constructor({ logger = () => {}, dir = '' } = {}) {
    this.log = logger;
    const root = dir || app?.getPath?.('userData') || path.join(process.cwd(), '.clauden');
    this.file = path.join(root, 'custom-apis.json');
    this.apis = this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      let plain = '';
      if (raw?.v === 2 && typeof raw.data === 'string') {
        if (!safeStorage?.isEncryptionAvailable?.()) return [];
        plain = safeStorage.decryptString(Buffer.from(raw.data, 'base64'));
      } else if (typeof raw?.data === 'string') {
        plain = raw.data;
      } else {
        return [];
      }
      const parsed = JSON.parse(plain);
      const list = Array.isArray(parsed?.apis) ? parsed.apis : [];
      return list
        .filter((api) => api && typeof api.id === 'string' && api.baseUrl)
        .slice(0, MAX_APIS)
        .map((api) => ({
          id: api.id,
          name: String(api.name || hostName(api.baseUrl)).slice(0, 80),
          baseUrl: String(api.baseUrl),
          apiKey: String(api.apiKey || ''),
          models: parseModelInput(api.models),
          createdAt: Number(api.createdAt) || Date.now(),
          updatedAt: Number(api.updatedAt) || Date.now(),
        }));
    } catch {
      return [];
    }
  }

  #save() {
    const plain = JSON.stringify({ apis: this.apis });
    let payload;
    if (safeStorage?.isEncryptionAvailable?.()) {
      payload = { v: 2, data: safeStorage.encryptString(plain).toString('base64') };
    } else {
      payload = { v: 1, data: plain };
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file, JSON.stringify(payload), { mode: 0o600 });
    } catch (err) {
      this.log(`[custom-api] save failed: ${err.message}`);
      throw new CustomApiError('storage', 'Не удалось сохранить ключи на диск');
    }
  }

  #find(id) {
    const key = String(id || '').trim();
    const api = this.apis.find((item) => item.id === key);
    if (!api) throw new CustomApiError('not_found', 'API не найден');
    return api;
  }

  #public(api) {
    return {
      id: api.id,
      name: api.name,
      baseUrl: api.baseUrl,
      hasKey: Boolean(api.apiKey),
      models: api.models.map((model) => ({ id: model.id, name: model.name })),
      modelCount: api.models.length,
      createdAt: api.createdAt,
      updatedAt: api.updatedAt,
    };
  }

  list() {
    return this.apis.map((api) => this.#public(api));
  }

  get(id) {
    return this.#public(this.#find(id));
  }

  save({ id, name, baseUrl, apiKey, models } = {}) {
    const base = normalizeBaseUrl(baseUrl);
    let api = null;
    if (id) api = this.#find(id);
    if (!api) {
      if (this.apis.length >= MAX_APIS) {
        throw new CustomApiError('limit', `Можно добавить не больше ${MAX_APIS} API`);
      }
      api = {
        id: `ca_${crypto.randomUUID()}`,
        createdAt: Date.now(),
      };
      this.apis.push(api);
    }
    const cleanName = String(name || '').trim().slice(0, 80);
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    const parsedModels = parseModelInput(models);
    api.name = cleanName || hostName(base);
    api.baseUrl = base;
    if (key) api.apiKey = key;
    if (parsedModels.length) api.models = parsedModels;
    if (!Array.isArray(api.models)) api.models = [];
    api.updatedAt = Date.now();
    this.#save();
    this.log(`[custom-api] saved ${api.id} models=${api.models.length} key=${api.apiKey ? 'yes' : 'no'}`);
    return this.#public(api);
  }

  remove(id) {
    const api = this.#find(id);
    this.apis = this.apis.filter((item) => item.id !== api.id);
    this.#save();
    this.log(`[custom-api] removed ${api.id}`);
    return { ok: true, id: api.id };
  }

  /**
   * Проверка подключения и загрузка моделей с /models. Если ключ не передан,
   * берётся сохранённый (при редактировании пользователь не вводит его заново).
   */
  async test({ baseUrl, apiKey = '', id = '' } = {}) {
    let stored = null;
    if (id) {
      try {
        stored = this.#find(id);
      } catch {
        stored = null;
      }
    }
    const base = normalizeBaseUrl(baseUrl || stored?.baseUrl || '');
    const key = String(apiKey || '').trim() || stored?.apiKey || '';
    const headers = { accept: 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`;
    let res;
    try {
      res = await fetch(`${base}/models`, {
        headers,
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new CustomApiError('timeout', 'API не ответил за 25 секунд');
      }
      throw new CustomApiError('network', `Нет связи с ${hostName(base)}: ${shortText(err?.message || err, 160)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const detail = errorMessage(body);
      throw new CustomApiError(
        statusKind(res.status),
        `HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
        res.status,
      );
    }
    const payload = await res.json().catch(() => null);
    const models = parseModels(payload);
    this.log(`[custom-api] test ${hostName(base)} ok models=${models.length}`);
    return { baseUrl: base, models, count: models.length };
  }

  /**
   * Стриминг ответа. Возвращает полный текст; при остановке пользователем
   * отдаёт уже полученную часть, чтобы интерфейс сохранил ответ.
   */
  async stream({ apiId, model, messages, system, attachments, signal, onDelta } = {}) {
    const api = this.#find(apiId);
    const modelId = String(model || '').trim();
    if (!modelId) throw new CustomApiError('invalid', 'Выберите модель');
    const history = normalizeMessages(messages);
    if (!history.length) throw new CustomApiError('invalid', 'Пустой запрос');
    const images = (Array.isArray(attachments) ? attachments : []).filter(
      (file) => file && /^image\//i.test(String(file.mime || '')) && typeof file.data === 'string' && file.data,
    );
    if (images.length) {
      for (let index = history.length - 1; index >= 0; index -= 1) {
        if (history[index].role !== 'user') continue;
        history[index] = {
          role: 'user',
          content: [
            { type: 'text', text: history[index].content },
            ...images.slice(0, 10).map((file) => ({
              type: 'image_url',
              image_url: { url: `data:${file.mime};base64,${file.data}` },
            })),
          ],
        };
        break;
      }
    }
    const sys = String(system || '').trim().slice(0, 60_000);
    const body = {
      model: modelId,
      stream: true,
      messages: sys ? [{ role: 'system', content: sys }, ...history] : history,
    };
    const headers = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'user-agent': 'Clauden-Desktop',
      'x-title': 'Clauden',
    };
    if (api.apiKey) headers.authorization = `Bearer ${api.apiKey}`;

    const controller = new AbortController();
    let stopped = false;
    let idleTimer = null;
    let idleFired = false;
    const bump = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleFired = true;
        controller.abort();
      }, IDLE_TIMEOUT_MS);
    };
    const onAbort = () => {
      stopped = true;
      controller.abort();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    let text = '';
    let res;
    bump();
    try {
      res = await fetch(`${api.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (idleTimer) clearTimeout(idleTimer);
      if (stopped) return text;
      if (idleFired || err?.name === 'AbortError') throw new CustomApiError('timeout', 'API не ответил вовремя');
      throw new CustomApiError('network', `Нет связи с ${hostName(api.baseUrl)}: ${shortText(err?.message || err, 160)}`);
    }

    try {
      if (!res.ok) {
        const raw = await res.text().catch(() => '');
        const detail = errorMessage(raw);
        throw new CustomApiError(
          statusKind(res.status),
          `HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
          res.status,
        );
      }
      const type = String(res.headers.get('content-type') || '');
      if (!type.includes('text/event-stream')) {
        const payload = await res.json().catch(() => null);
        const choice = payload?.choices?.[0];
        const piece = contentText(choice?.message?.content ?? choice?.text ?? payload?.content);
        if (piece) {
          text = piece;
          onDelta?.(piece);
        }
        return text;
      }
      if (!res.body) throw new CustomApiError('server', 'API вернул пустой поток');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;

      const handleLine = (line) => {
        const trimmed = String(line || '').trim();
        if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return false;
        const raw = trimmed.slice(5).trim();
        if (!raw || raw === '[DONE]') return raw === '[DONE]';
        let event;
        try {
          event = JSON.parse(raw);
        } catch {
          return false;
        }
        const choice = event?.choices?.[0];
        if (event?.error) {
          throw new CustomApiError(
            'server',
            errorMessage(JSON.stringify(event.error)) || 'API вернул ошибку',
          );
        }
        const piece = contentText(choice?.delta?.content ?? choice?.message?.content ?? choice?.text ?? event?.delta?.content);
        if (piece) {
          text += piece;
          onDelta?.(piece);
        }
        return false;
      };

      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        bump();
        buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (handleLine(line)) {
            finished = true;
            break;
          }
        }
      }
      if (!finished && buffer) handleLine(buffer);
      try {
        await reader.cancel();
      } catch {
        /* stream already closed */
      }
      return text;
    } catch (err) {
      if (stopped) return text;
      if (err instanceof CustomApiError) throw err;
      if (idleFired || err?.name === 'AbortError') {
        throw new CustomApiError('timeout', 'API перестал отвечать');
      }
      throw new CustomApiError('network', `Сбой потока: ${shortText(err?.message || err, 200)}`);
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}

module.exports = { CustomApiManager, CustomApiError, normalizeBaseUrl, parseModels };
