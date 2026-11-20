'use strict';

/**
 * Прямой клиент claude.ai из главного процесса Electron.
 *
 * Cookie не передаются вручную: запросы идут через Chromium-сессию
 * `persist:claude`, где лежит вход пользователя. На бэкенд Clauden ничего
 * из этого файла не уходит. Внутренний API Anthropic меняется без
 * предупреждения, поэтому весь разбор ответов собран здесь.
 */

const BASE = 'https://claude.ai';
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const FILE_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const FALLBACK_MODELS = [
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
  { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5 (snapshot)' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5 (snapshot)' },
];

const PRO_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
  { id: 'claude-3-opus-20240229', name: 'Claude Opus 3' },
];

class ClaudeError extends Error {
  constructor(kind, message, retryAt = 0) {
    super(message);
    this.name = 'ClaudeError';
    this.kind = kind;
    this.retryAt = retryAt;
  }
}

function text(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  const value = obj[key];
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function intOrNull(obj, key) {
  const value = text(obj, key);
  if (value == null) return null;
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : null;
}

function capabilities(obj) {
  const array = Array.isArray(obj?.capabilities) ? obj.capabilities : [];
  return array.filter((item) => typeof item === 'string');
}

function planFromOrg(org) {
  if (!org || typeof org !== 'object') return '';
  const caps = capabilities(org);
  const rate = String(text(org, 'rate_limit_tier') || '').toLowerCase();
  if (caps.some((cap) => /max/i.test(cap)) || rate.includes('max')) return 'max';
  if (caps.some((cap) => /pro/i.test(cap))) return 'pro';
  // raven_type — командная организация: она платная, Opus доступен.
  if (text(org, 'raven_type')) return 'pro';
  return '';
}

function isModelId(value) {
  const clean = String(value || '').trim();
  if (clean.length < 6 || clean.length > 64) return false;
  if (!/claude/i.test(clean)) return false;
  if (/^[0-9a-fA-F-]{36}$/.test(clean)) return false;
  return /^[a-z0-9][a-z0-9._-]*$/i.test(clean);
}

function modelsForPlan(plan, server = []) {
  const paid = String(plan || '').toLowerCase() === 'pro' || String(plan || '').toLowerCase() === 'max';
  const merged = new Map();
  for (const model of server) {
    if (!model || !isModelId(model.id)) continue;
    if (!paid && /opus/i.test(model.id)) continue;
    merged.set(model.id, model);
  }
  for (const model of paid ? [...FALLBACK_MODELS, ...PRO_MODELS] : FALLBACK_MODELS) {
    if (!merged.has(model.id)) merged.set(model.id, model);
  }
  return [...merged.values()];
}

function preferredModel(models) {
  return (
    models.find((model) => /sonnet/i.test(model.id))?.id ||
    models[0]?.id ||
    ''
  );
}

function escapeAttr(value) {
  return String(value ?? '').replaceAll('"', '&quot;');
}

function artifactTag(id, title, type, content) {
  return (
    `\n\n<artifact identifier="${escapeAttr(id)}" type="${escapeAttr(type)}" ` +
    `title="${escapeAttr(title)}">\n${content}\n</artifact>\n\n`
  );
}

function isArtifactTool(name) {
  return typeof name === 'string' && /artifact/i.test(name);
}

function artifactTagFrom(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const content = text(obj, 'content') ?? text(obj, 'text');
  if (!content || !content.trim()) return null;
  const type = text(obj, 'type') || 'text/plain';
  const title = text(obj, 'title') || text(obj, 'name') || 'Артефакт';
  const id = text(obj, 'id') || text(obj, 'identifier') || cryptoId();
  return artifactTag(id, title, type, content);
}

function fileArtifactTag(display) {
  const raw = text(display, 'json_block');
  if (!raw) return null;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const code = text(obj, 'code') ?? text(obj, 'content');
  if (!code || !code.trim()) return null;
  const path = text(obj, 'filename') || text(obj, 'path') || text(obj, 'name') || 'Файл';
  const title = path.split('/').pop() || 'Файл';
  const language = String(text(obj, 'language') || '');
  let type = 'text/plain';
  if (/python/i.test(language) || title.endsWith('.py')) type = 'text/x-python';
  else if (/html/i.test(language) || title.endsWith('.html')) type = 'text/html';
  else if (/svg/i.test(language) || title.endsWith('.svg')) type = 'image/svg+xml';
  else if (/javascript|jsx|typescript|tsx/i.test(language) || /\.(js|ts|tsx)$/.test(title)) type = 'text/javascript';
  else if (/css/i.test(language) || title.endsWith('.css')) type = 'text/css';
  else if (/json/i.test(language) || title.endsWith('.json')) type = 'application/json';
  else if (/markdown/i.test(language) || title.endsWith('.md')) type = 'text/markdown';
  return artifactTag(`file:${path}`, title, type, code);
}

function cryptoId() {
  try {
    return require('node:crypto').randomUUID();
  } catch {
    return `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function parseMillis(raw) {
  if (raw == null || raw === '') return null;
  const value = String(raw);
  if (/^\d+$/.test(value)) {
    const number = Number(value);
    return number < 10_000_000_000 ? number * 1000 : number;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function lastUserMessage(messages, attachments) {
  const last = [...(messages || [])].reverse().find((message) => message?.role === 'user');
  const textValue = String(last?.content || '').trim();
  const names = (attachments || []).map((file) => file?.name).filter(Boolean);
  if (textValue && names.length) return `${textValue}\n\nВложения: ${names.join(', ')}`;
  if (textValue) return textValue;
  if (names.length) return `Изучи вложения: ${names.join(', ')}`;
  return 'Продолжай.';
}

function buildFirstPrompt({ system = '', project = '', memory = '', messages = [], attachments = [] }) {
  const question = lastUserMessage(messages, attachments);
  const context = [];
  const previous = (messages || [])
    .slice(0, -1)
    .filter((message) => message && String(message.content || '').trim());
  if (previous.length) {
    const transcript = previous
      .slice(-24)
      .map((message) => `${message.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${String(message.content).trim()}`)
      .join('\n');
    if (transcript) context.push(`История диалога:\n${transcript.slice(-24000)}`);
  }
  if (system.trim()) context.push(system.trim());
  if (project.trim()) context.push(`Контекст проекта:\n${project.trim()}`);
  if (memory.trim()) context.push(`Что я помню о пользователе:\n${memory.trim()}`);
  if (!context.length) return question;
  return `${question}\n\n— — —\n${context.join('\n\n')}`;
}

function buildFollowUpPrompt({ messages = [], attachments = [] }) {
  return lastUserMessage(messages, attachments);
}

function errorMessage(body) {
  try {
    const root = JSON.parse(body);
    const error = root?.error;
    if (error && typeof error === 'object') return String(error.message || error.type || '').slice(0, 300);
    if (typeof error === 'string') return error.slice(0, 300);
    return String(root?.message || '').slice(0, 300);
  } catch {
    return String(body || '').slice(0, 300);
  }
}

function isUsageLimitMessage(message) {
  const lower = String(message || '').toLowerCase().replaceAll('_', ' ').replaceAll('-', ' ');
  return (
    lower.includes('usage') ||
    lower.includes('message limit') ||
    lower.includes('limit reached') ||
    lower.includes('exceeded your') ||
    (lower.includes('limit') &&
      !lower.includes('per-minute') &&
      !lower.includes('per minute') &&
      !lower.includes('rate limit') &&
      !lower.includes('too many') &&
      !lower.includes('requests'))
  );
}

function retryAfterMillis(raw) {
  const value = String(raw || '').trim();
  if (!value) return 0;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return seconds > 0 ? Date.now() + seconds * 1000 : 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function httpError(code, body, retryAfter = '') {
  const message = errorMessage(body);
  const retryAt = retryAfterMillis(retryAfter);
  if (code === 401) return new ClaudeError('unauthorized', 'Сессия Claude истекла. Войдите в Claude заново.');
  if (code === 403) {
    return new ClaudeError(
      'blocked',
      'Claude закрыл доступ с этого IP. Смените страну VPN (США, Великобритания, Германия) или сеть и повторите.',
    );
  }
  if (code === 429) {
    if (isUsageLimitMessage(message)) {
      return new ClaudeError('rate_limit', message || 'Лимит аккаунта Claude исчерпан', retryAt);
    }
    return new ClaudeError(
      'throttled',
      message || 'Claude временно ограничил частоту запросов. Подождите минуту и повторите.',
      retryAt,
    );
  }
  if (code >= 500) return new ClaudeError('server', message || 'Claude временно недоступен');
  return new ClaudeError('other', message || `Claude ответил ошибкой ${code}`);
}

/** Список моделей может лежать в любом из этих полей — берём первое найденное. */
function pickModelArray(root) {
  if (!root || typeof root !== 'object') return [];
  const candidates = [
    root,
    root.data,
    root.models,
    root.available_models,
    root.model_settings,
    root.settings?.models,
    root.settings?.available_models,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

class ClaudeClient {
  constructor({ transport, userAgent = DEFAULT_UA, timezone = 'UTC', locale = 'en-US', log = () => {} }) {
    if (typeof transport !== 'function') throw new Error('ClaudeClient: transport is required');
    this.transport = transport;
    this.userAgent = userAgent;
    this.timezone = timezone;
    this.locale = locale;
    this.log = log;
  }

  headers(extra = {}) {
    return {
      'User-Agent': this.userAgent,
      'Accept-Language': this.locale,
      Referer: 'https://claude.ai/new',
      Origin: 'https://claude.ai',
      'anthropic-client-platform': 'web_claude_ai',
      ...extra,
    };
  }

  async requestText(path, { method = 'GET', body, signal, headers = {}, timeout = REQUEST_TIMEOUT_MS } = {}) {
    const init = { method, headers: this.headers({ Accept: 'application/json', ...headers }) };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json; charset=utf-8';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    // Без таймаута зависший запрос к claude.ai блокировал запуск приложения
    // и статус сессии на минуты. Отменяем по своему сигналу, внешний — уважаем.
    const controller = new AbortController();
    let timer = null;
    const forwardAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', forwardAbort, { once: true });
    }
    if (timeout > 0) timer = setTimeout(() => controller.abort(), timeout);
    init.signal = controller.signal;
    let res;
    try {
      res = await this.transport(BASE + path, init);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (controller.signal.aborted) {
        throw new ClaudeError('network', `claude.ai не ответил за ${Math.round(timeout / 1000)} с`);
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      if (signal?.removeEventListener) signal.removeEventListener('abort', forwardAbort);
    }
    const raw = await res.text();
    if (!res.ok) throw httpError(res.status, raw);
    return raw;
  }

  async requestJson(path, options = {}) {
    const raw = await this.requestText(path, options);
    try {
      return JSON.parse(raw);
    } catch {
      throw new ClaudeError('other', 'Claude вернул неожиданный ответ');
    }
  }

  /** IP, с которого claude.ai видит этот компьютер. */
  async exitIp() {
    const raw = await this.requestText('/cdn-cgi/trace', {
      headers: { Accept: 'text/plain' },
    });
    const match = String(raw).match(/^ip=(.+)$/m);
    const ip = match ? match[1].trim() : '';
    if (!ip) throw new ClaudeError('network', 'Не удалось определить IP, который видит claude.ai');
    return { ip };
  }

  /** orgId, email, имя и тариф по действующей cookie. */
  async discover() {
    const account = await this.requestJson('/api/account');
    if (!account || typeof account !== 'object') {
      throw new ClaudeError('other', 'Claude вернул неожиданный ответ');
    }
    const organizations = await this.organizations();
    const chatOrganizations = organizations.filter((org) =>
      capabilities(org).some((cap) => String(cap).toLowerCase() === 'chat'),
    );
    const memberships = Array.isArray(account.memberships) ? account.memberships : [];
    const preferredOrgIds = memberships
      .map((item) => item?.organization)
      .map((org) => text(org, 'uuid') || text(org, 'id'))
      .filter(Boolean);
    const organization =
      preferredOrgIds
        .map((id) => organizations.find((org) => text(org, 'uuid') === id || text(org, 'id') === id))
        .find(Boolean) ||
      chatOrganizations[0] ||
      organizations[0];
    const orgId = text(organization, 'uuid') || text(organization, 'id') || '';
    if (!orgId) throw new ClaudeError('other', 'В аккаунте Claude не нашлась организация');

    const memberOrgs = memberships
      .map((item) => item?.organization)
      .filter((org) => org && typeof org === 'object');
    let plan = planFromOrg(organization);
    if (plan !== 'max') {
      for (const org of memberOrgs) {
        const candidate = planFromOrg(org);
        if (candidate === 'max') {
          plan = 'max';
          break;
        }
        if (candidate === 'pro') plan = 'pro';
      }
    }
    if (!plan) {
      const accountPlan = String(text(account, 'plan') || '').toLowerCase();
      if (accountPlan === 'pro' || accountPlan === 'max') plan = accountPlan;
    }
    if (!plan) plan = await this.bootstrapPlan(orgId);
    plan = plan || 'free';

    return {
      orgId,
      email: text(account, 'email_address') || text(account, 'email') || '',
      name: text(account, 'full_name') || text(account, 'display_name') || text(account, 'name') || '',
      plan,
      lastOkAt: Date.now(),
    };
  }

  async organizations() {
    const root = await this.requestJson('/api/organizations');
    const array = Array.isArray(root) ? root : root?.data || root?.organizations;
    return Array.isArray(array) ? array.filter((item) => item && typeof item === 'object') : [];
  }

  /**
   * app_start отдаёт organization.capabilities, даже когда в /api/account
   * их уже нет. Без этого Pro-аккаунт определяется как Free.
   */
  async bootstrapPlan(orgId) {
    try {
      const root = await this.requestJson(
        `/api/bootstrap/${orgId}/app_start?statsig_hashing_algorithm=djb2`,
      );
      const memberships = root?.account?.memberships;
      if (!Array.isArray(memberships)) return '';
      const orgs = memberships
        .map((item) => item?.organization)
        .filter((org) => org && typeof org === 'object');
      const plans = orgs.map((org) => planFromOrg(org));
      if (plans.includes('max')) return 'max';
      if (plans.includes('pro')) return 'pro';
      const org = orgs.find((item) => text(item, 'uuid') === orgId || text(item, 'id') === orgId)
        || orgs[0];
      return planFromOrg(org);
    } catch {
      return '';
    }
  }

  async listModels(orgId, plan) {
    // Anthropic убрал /models (404), список моделей отдаёт /model_settings.
    // Пробуем оба и разбираем ответ защитно: незнакомая схема = пустой список.
    const server = [];
    const paths = [
      `/api/organizations/${encodeURIComponent(orgId)}/model_settings`,
      `/api/organizations/${encodeURIComponent(orgId)}/models`,
    ];
    for (const path of paths) {
      try {
        const root = await this.requestJson(path);
        const array = pickModelArray(root);
        if (!array.length) continue;
        for (const item of array) {
          const id = [text(item, 'model'), text(item, 'name'), text(item, 'id')].find(isModelId);
          if (!id) continue;
          const label = text(item, 'display_name') || (isModelId(text(item, 'name')) ? id : text(item, 'name')) || id;
          server.push({ id, name: label });
        }
        if (server.length) break;
      } catch (err) {
        this.log(`claude models failed (${path}): ${err.message}`);
      }
    }
    const unique = [];
    const seen = new Set();
    for (const model of server) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      unique.push(model);
    }
    return modelsForPlan(plan, unique);
  }

  async getConversation(orgId, conversationId) {
    return this.requestJson(
      `/api/organizations/${encodeURIComponent(orgId)}/chat_conversations/${encodeURIComponent(conversationId)}` +
        '?tree=True&rendering_mode=messages&render_all_tools=true',
    );
  }

  async latestAssistantAnswer(orgId, conversationId) {
    if (!conversationId) return null;
    const root = await this.getConversation(orgId, conversationId);
    const messages = Array.isArray(root?.chat_messages) ? root.chat_messages : [];
    for (const message of [...messages].reverse()) {
      if (!message || typeof message !== 'object') continue;
      const role = text(message, 'sender') || text(message, 'role');
      if (!role || role.toLowerCase() !== 'assistant') continue;
      const baseText = text(message, 'text') || extractMessageText(message) || '';
      const artifacts = messageArtifacts(message);
      let combined = baseText;
      if (artifacts && !/<(?:ant)?artifact[\s>]/i.test(baseText)) {
        combined = [baseText, artifacts].filter(Boolean).join('\n\n');
      }
      if (combined.trim()) {
        return { text: combined, uuid: text(message, 'uuid') || '' };
      }
    }
    return null;
  }

  /**
   * Anthropic периодически меняет внутренний API: то появляется `_v2`, то
   * меняется набор query-параметров. Перебираем известные варианты и пишем в
   * лог, какой из них ответил — чтобы при следующей поломке сразу было видно.
   */
  async listConversations(orgId, { offset = 0, limit = 50 } = {}) {
    const org = encodeURIComponent(orgId);
    const candidates = [
      `/api/organizations/${org}/chat_conversations_v2?limit=${limit}&offset=${offset}`,
      `/api/organizations/${org}/chat_conversations?offset=${offset}&limit=${limit}`,
      `/api/organizations/${org}/chat_conversations?limit=${limit}&offset=${offset}&starred=false`,
      `/api/organizations/${org}/chat_conversations`,
    ];
    let root = null;
    let lastError = null;
    for (const path of candidates) {
      try {
        root = await this.requestJson(path);
        this.log(`claude list ok ${path.split('/api/')[1]}`);
        break;
      } catch (err) {
        lastError = err;
        this.log(`claude list failed (${path.split('/api/')[1]}): ${err.message}`);
        if (err instanceof ClaudeError && err.kind === 'unauthorized') break;
      }
    }
    if (!root) throw lastError || new ClaudeError('other', 'Claude не отдал список чатов');
    const array = Array.isArray(root) ? root : root?.data || root?.conversations || root?.items;
    if (!Array.isArray(array)) return [];
    return array
      .map((item) => {
        const uuid = text(item, 'uuid') || text(item, 'id');
        if (!uuid) return null;
        return {
          uuid,
          name: text(item, 'name') || text(item, 'title') || text(item, 'summary') || '',
          updatedAt:
            parseMillis(text(item, 'updated_at')) ||
            parseMillis(text(item, 'created_at')) ||
            parseMillis(text(item, 'updatedAt')) ||
            0,
        };
      })
      .filter(Boolean);
  }

  async importConversation(orgId, summary) {
    const root = await this.getConversation(orgId, summary.uuid);
    const messages = Array.isArray(root?.chat_messages) ? root.chat_messages : [];
    const objects = messages.filter((item) => item && typeof item === 'object');
    if (!objects.length) return null;

    const byId = new Map();
    for (const item of objects) {
      const id = text(item, 'uuid');
      if (id) byId.set(id, item);
    }
    const maxIndex = objects.reduce((max, item) => Math.max(max, Number(text(item, 'index')) || 0), 0);
    let current =
      byId.get(text(root, 'current_leaf_message_uuid')) ||
      (maxIndex > 0
        ? objects.find((item) => (Number(text(item, 'index')) || 0) === maxIndex)
        : objects[objects.length - 1]);
    const branch = [];
    let guard = 0;
    while (current && guard <= objects.length) {
      branch.push(current);
      current = byId.get(text(current, 'parent_message_uuid'));
      guard += 1;
    }
    branch.reverse();
    const ordered = branch.length ? branch : objects;
    const converted = ordered.map((item) => this.toChatMessage(item)).filter(Boolean);
    if (!converted.length) return null;
    const title =
      text(root, 'name') ||
      converted.find((message) => message.role === 'user')?.content?.slice(0, 60) ||
      'Чат Claude';
    const updated =
      parseMillis(text(root, 'updated_at')) || parseMillis(text(root, 'created_at')) || summary.updatedAt || Date.now();
    return {
      id: `claude-${summary.uuid}`,
      title: title.slice(0, 80),
      messages: converted,
      updatedAt: updated,
      claudeConversationId: summary.uuid,
      provider: 'claude',
    };
  }

  toChatMessage(obj) {
    const sender = text(obj, 'sender') || text(obj, 'role');
    if (!sender) return null;
    const role = sender.toLowerCase() === 'assistant' ? 'assistant' : 'user';
    const baseText = text(obj, 'text') || extractMessageText(obj) || '';
    const artifacts = messageArtifacts(obj);
    const content =
      !artifacts || /<(?:ant)?artifact[\s>]/i.test(baseText)
        ? baseText
        : [baseText, artifacts].filter(Boolean).join('\n\n');
    const files = this.messageFiles(obj);
    const names = [...new Set(files.map((file) => file.name))];
    const withAttachments = names.length ? `${content}\n\nВложения: ${names.join(', ')}` : content;
    if (!withAttachments.trim() && !files.length) return null;
    return {
      id: `claude-msg-${text(obj, 'uuid') || cryptoId()}`,
      role,
      content: withAttachments,
      ts: parseMillis(text(obj, 'created_at')) || 0,
      files,
      complete: true,
    };
  }

  messageFiles(obj) {
    const result = new Map();
    const textAny = (file, keys) => {
      for (const key of keys) {
        const value = text(file, key);
        if (value) return value;
      }
      return '';
    };
    const fileUrl = (file) => {
      const absolute = (value) =>
        /^https?:/i.test(value) ? value : value.startsWith('/api/') ? BASE + value : '';
      for (const key of ['download_url', 'url', 'content_url', 'file_url', 'preview_url', 'thumbnail_url', 'download_path']) {
        const value = text(file, key);
        if (value && absolute(value)) return absolute(value);
      }
      for (const key of ['document_asset', 'highres_copy', 'standard_copy', 'preview_asset', 'thumbnail_asset']) {
        const asset = file[key];
        if (!asset || typeof asset !== 'object') continue;
        const value = text(asset, 'url');
        if (value && absolute(value)) return absolute(value);
      }
      const source = text(file, 'download_source');
      if (source && absolute(source)) return absolute(source);
      const path = text(file, 'path');
      if (path && absolute(path)) return absolute(path);
      return '';
    };
    const add = (raw) => {
      if (!raw || typeof raw !== 'object') return;
      const file = raw.file && typeof raw.file === 'object' ? { ...raw, ...raw.file } : raw;
      const path = textAny(file, ['path', 'file_path']);
      const name = textAny(file, ['file_name', 'name', 'filename', 'sanitized_name']) ||
        (path ? path.split('/').pop() : '');
      if (!name) return;
      const id = textAny(file, ['file_uuid', 'uuid', 'file_id', 'id', 'document_id']);
      const url = fileUrl(file);
      const extracted = textAny(file, ['extracted_content', 'content', 'text', 'code']);
      if ([...result.values()].some((item) => item.name.toLowerCase() === name.toLowerCase())) return;
      const size = Number(textAny(file, ['file_size', 'size_bytes', 'size']) || 0) || 0;
      const mime = textAny(file, ['file_type', 'mime_type', 'mime', 'content_type']) || mimeFromName(name);
      result.set(id || url || name, {
        id: id || url || name,
        name,
        url,
        size,
        mime,
        text: extracted,
        path: String(path || '').startsWith('/mnt/') ? path : '',
      });
    };
    const addImage = (block, index) => {
      if (!block || typeof block !== 'object') return;
      const source = block.source && typeof block.source === 'object' ? block.source : block;
      const media = text(source, 'media_type') || text(source, 'file_type') || 'image/png';
      const url = ['url', 'download_url', 'content_url']
        .map((key) => text(source, key))
        .find((value) => value && (/^http/i.test(value) || value.startsWith('/api/'))) || '';
      const data = text(source, 'data') || '';
      if (!url && !data) return;
      const ext = /jpeg/i.test(media) ? 'jpg' : /webp/i.test(media) ? 'webp' : /gif/i.test(media) ? 'gif' : 'png';
      const name = textAny(source, ['file_name', 'name']) || `image-${index + 1}.${ext}`;
      const id = textAny(source, ['file_uuid', 'uuid', 'file_id']);
      const finalUrl = url || `data:${media};base64,${data}`;
      if ([...result.values()].some((item) => item.name.toLowerCase() === name.toLowerCase())) return;
      result.set(id || finalUrl.slice(0, 96) || name, {
        id: id || finalUrl.slice(0, 96) || name,
        name,
        url: finalUrl,
        size: 0,
        mime: media,
        text: '',
      });
    };

    if (Array.isArray(obj.files)) obj.files.forEach(add);
    if (Array.isArray(obj.attachments)) obj.attachments.forEach(add);
    if (Array.isArray(obj.content)) {
      obj.content.forEach((block, index) => {
        if (!block || typeof block !== 'object') return;
        const type = text(block, 'type');
        if (type === 'image') {
          addImage(block, index);
          return;
        }
        if (type === 'file' || type === 'document') {
          add(block.file && typeof block.file === 'object' ? block.file : block);
          return;
        }
        if (type !== 'tool_result' || !Array.isArray(block.content)) return;
        block.content.forEach((part, partIndex) => {
          if (!part || typeof part !== 'object') return;
          if (text(part, 'type') === 'image') addImage(part, partIndex);
        });
      });
      for (const block of obj.content) {
        if (!block || text(block, 'type') !== 'tool_result') continue;
        if (!Array.isArray(block.content)) continue;
        for (const part of block.content) {
          if (!part || text(part, 'type') !== 'local_resource') continue;
          const path = text(part, 'file_path') || text(part, 'path');
          if (!path) continue;
          const name = text(part, 'name') || path.split('/').pop() || '';
          if (!name) continue;
          const mime = text(part, 'mime_type') || text(part, 'mime') || mimeFromName(name);
          if (!isBinaryFile(name, mime)) continue;
          if ([...result.values()].some((item) => item.name.toLowerCase() === name.toLowerCase())) continue;
          const id = text(part, 'file_uuid') || text(part, 'uuid') || '';
          const url = ['download_url', 'url', 'content_url']
            .map((key) => text(part, key))
            .find((value) => value && /^http/i.test(value)) || '';
          result.set(id || name, {
            id: id || name,
            name,
            url,
            size: Number(text(part, 'file_size') || 0) || 0,
            mime,
            text: '',
          });
        }
      }
    }
    return [...result.values()];
  }

  async downloadFile(orgId, file, conversationId = '') {
    const rawUrl = String(file?.url || '');
    const direct = /^(https?:|data:|\/api\/)/i.test(rawUrl) && !/\/artifact\//i.test(rawUrl) ? rawUrl : '';
    if (direct) {
      const target = /^https?:/i.test(direct) ? direct : /^data:/i.test(direct) ? direct : BASE + direct;
      const got = await this.fetchFileBytes(target, file.name).catch(() => null);
      if (got) return got;
    }
    // Пользовательские загрузки и файлы песочницы адресуются путём, а не uuid.
    if (conversationId && String(file?.path || '').startsWith('/mnt/')) {
      const got = await this.fetchFileBytes(
        `${BASE}/api/organizations/${encodeURIComponent(orgId)}/conversations/${encodeURIComponent(conversationId)}/wiggle/download-file` +
          `?path=${encodeURIComponent(file.path)}`,
        file.name,
      ).catch(() => null);
      if (got) return got;
    }
    if (!FILE_UUID.test(file?.id || '')) return null;
    const candidates = [
      // claude.ai отдаёт байты именно по /contents, не /content.
      `/api/organizations/${encodeURIComponent(orgId)}/files/${file.id}/contents`,
      `/api/organizations/${encodeURIComponent(orgId)}/files/${file.id}/contents?download=true`,
      `/api/organizations/${encodeURIComponent(orgId)}/files/${file.id}/content`,
      `/api/organizations/${encodeURIComponent(orgId)}/files/${file.id}/content?download=true`,
      `/api/files/${file.id}/content`,
    ];
    for (const path of candidates) {
      const got = await this.fetchFileBytes(BASE + path, file.name).catch(() => null);
      if (got) return got;
    }
    return null;
  }

  async fetchFileBytes(url, name) {
    if (/^data:/i.test(url)) {
      const comma = url.indexOf(',');
      if (comma <= 5) return null;
      const meta = url.slice(5, comma);
      const payload = url.slice(comma + 1);
      const buffer = meta.includes('base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload));
      if (!buffer.length || buffer.length > MAX_FILE_BYTES) return null;
      return { data: buffer.toString('base64'), mime: meta.split(';')[0] || 'application/octet-stream' };
    }
    const res = await this.transport(url, {
      method: 'GET',
      headers: this.headers({ Accept: 'application/octet-stream, */*' }),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const length = Number(res.headers.get('content-length') || 0);
    if (length > MAX_FILE_BYTES) return null;
    const mime = String(res.headers.get('content-type') || '').split(';')[0].trim();
    if (/json/i.test(mime)) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_FILE_BYTES) return null;
    if (/html/i.test(mime) && !String(name || '').toLowerCase().endsWith('.html')) {
      const head = buffer.subarray(0, Math.min(buffer.length, 512)).toString('utf8').toLowerCase();
      if (head.includes('<html') || head.includes('<!doctype html')) return null;
    }
    return { data: buffer.toString('base64'), mime };
  }

  async createConversation(orgId, model) {
    const uuid = cryptoId();
    const create = async (includeModel) => {
      const payload = { uuid, name: '' };
      if (includeModel && model) payload.model = model;
      const res = await this.transport(`${BASE}/api/organizations/${encodeURIComponent(orgId)}/chat_conversations`, {
        method: 'POST',
        headers: this.headers({ Accept: 'application/json', 'content-type': 'application/json; charset=utf-8' }),
        body: JSON.stringify(payload),
      });
      return { code: res.status, body: await res.text() };
    };
    let result = await create(true);
    if (result.code < 200 || result.code > 299) {
      const modelRejected = /model|unsupported/i.test(result.body);
      if (!modelRejected) throw httpError(result.code, result.body);
      result = await create(false);
      if (result.code < 200 || result.code > 299) throw httpError(result.code, result.body);
    }
    try {
      const root = JSON.parse(result.body);
      return text(root, 'uuid') || text(root, 'id') || uuid;
    } catch {
      return uuid;
    }
  }

  async upload(orgId, conversationId, attachment) {
    const name = String(attachment?.name || 'file').slice(0, 200);
    const mime = String(attachment?.mime || 'application/octet-stream').slice(0, 120);
    const data = String(attachment?.data || '');
    if (!data) return null;
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) return null;

    const send = async (url) => {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: mime }), name);
      // Без таймаута загрузка в wiggle могла висеть вечным спиннером.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      try {
        const res = await this.transport(url, {
          method: 'POST',
          headers: this.headers({ Accept: 'application/json' }),
          body: form,
          signal: controller.signal,
        });
        const raw = await res.text();
        if (!res.ok) {
          this.log(`claude upload failed: ${res.status} ${url.split('/api/')[1] || ''}`);
          return null;
        }
        try {
          const root = JSON.parse(raw);
          const uuid = text(root, 'file_uuid') || text(root, 'uuid');
          if (!uuid) return null;
          return {
            uuid,
            name: text(root, 'file_name') || name,
            mime: text(root, 'file_type') || text(root, 'mime_type') || mime,
            size: Number(text(root, 'size_bytes') || text(root, 'file_size') || bytes.length) || bytes.length,
            path: text(root, 'path') || '',
          };
        } catch {
          return null;
        }
      } finally {
        clearTimeout(timer);
      }
    };

    // Файлы чата живут в wiggle-хранилище беседы; общий /upload — библиотека
    // организации, из неё файл не попадает в /mnt/user-data/uploads.
    if (conversationId) {
      const wiggle = await send(
        `${BASE}/api/organizations/${encodeURIComponent(orgId)}/conversations/${encodeURIComponent(conversationId)}/wiggle/upload-file`,
      ).catch(() => null);
      if (wiggle) return wiggle;
    }
    return send(`${BASE}/api/organizations/${encodeURIComponent(orgId)}/upload`).catch(() => null);
  }

  completionRequest({ orgId, conversationId, model, prompt, files, webSearch, thinking, adaptive = true, includeModel = true }) {
    const payload = {
      prompt,
      timezone: this.timezone,
      rendering_mode: 'messages',
      locale: this.locale,
      turn_message_uuids: { human_message_uuid: cryptoId(), assistant_message_uuid: cryptoId() },
      sync_sources: [],
      files: [],
      attachments: [],
      tools: [],
    };
    if (includeModel && model) payload.model = model;
    if (files.length) {
      payload.files = files.map((file) => file.uuid);
      // Бинарные файлы идут только списком files; attachments — для текста.
      payload.attachments = [];
    }
    if (adaptive && webSearch) payload.tools.push({ type: 'web_search_v0', name: 'web_search' });
    if (adaptive && thinking) payload.thinking_mode = 'extended';
    return {
      url: `${BASE}/api/organizations/${encodeURIComponent(orgId)}/chat_conversations/${encodeURIComponent(conversationId)}/completion`,
      init: {
        method: 'POST',
        headers: this.headers({ Accept: 'text/event-stream', 'content-type': 'application/json; charset=utf-8' }),
        body: JSON.stringify(payload),
      },
    };
  }

  /**
   * Запускает ответ Claude. Возвращает полный текст.
   * onDelta получает только видимый текст (без кода артефактов).
   */
  async stream({
    conversationId = '',
    model,
    messages = [],
    system = '',
    project = '',
    memory = '',
    attachments = [],
    webSearch = false,
    thinking = false,
    signal,
    onConversation = () => {},
    onDelta = () => {},
    onProgress = () => {},
    onStep = () => {},
  }) {
    let full = '';
    try {
      const { orgId } = await this.requireSession();
      let resume = conversationId;
      if (!resume) {
        resume = await this.createConversation(orgId, model);
        onConversation(resume);
      }
      // Текстовые файлы (.py, .md, .json, ...) не загружаем в claude.ai:
      // встраиваем их в промпт. Загрузка в wiggle для текста иногда висит
      // бесконечным спиннером, а модели всё равно нужен сам код.
      const inlineAttachments = attachments.filter((item) => isInlineableText(item));
      const binaryAttachments = attachments.filter((item) => !isInlineableText(item));
      const inlineBlock = inlineAttachmentsBlock(inlineAttachments);

      const uploaded = [];
      for (const attachment of binaryAttachments.slice(0, 10)) {
        if (signal?.aborted) break;
        uploaded.push(await this.upload(orgId, resume, attachment).catch(() => null));
      }
      if (signal?.aborted) return full;
      if (binaryAttachments.length && uploaded.some((file) => !file)) {
        const missing = binaryAttachments
          .slice(0, uploaded.length)
          .filter((_, index) => !uploaded[index])
          .map((item) => item?.name)
          .filter(Boolean)
          .join(', ');
        throw new ClaudeError(
          'other',
          `Claude не принял вложение${missing ? `: ${missing}` : ''}`,
        );
      }
      const files = uploaded.filter(Boolean);

      const prompt =
        (conversationId
          ? buildFollowUpPrompt({ messages, attachments })
          : buildFirstPrompt({ system, project, memory, messages, attachments })) + inlineBlock;

      const first = this.completionRequest({
        orgId,
        conversationId: resume,
        model,
        prompt,
        files,
        webSearch,
        thinking,
      });
      let res = await this.transport(first.url, { ...first.init, signal });

      if (!res.ok) {
        // Тело можно прочитать только один раз: Response в undici после
        // text() становится непригодным. Держим прочитанный текст, иначе
        // повторное чтение заменяет реальную ошибку (429, 5xx) на
        // «Body is unusable: Body has already been read».
        let errorText = await res.text().catch(() => '');
        const retryWithoutModel = /model|unsupported|not available/i.test(errorText);
        const retryWithoutOptional =
          res.status >= 400 && res.status < 500 && ![401, 403, 429].includes(res.status) && (webSearch || thinking);
        // 429 не повторяем сразу: это только продлевает ограничение.
        if (retryWithoutModel || retryWithoutOptional) {
          const retry = this.completionRequest({
            orgId,
            conversationId: resume,
            model,
            prompt,
            files,
            webSearch,
            thinking,
            adaptive: !retryWithoutOptional,
            includeModel: !retryWithoutModel,
          });
          res = await this.transport(retry.url, { ...retry.init, signal });
          if (!res.ok) errorText = await res.text().catch(() => '');
        }
        if (!res.ok) {
          throw httpError(res.status, errorText, res.headers.get('retry-after'));
        }
      }

      // claude.ai иногда отвечает 200 не потоком, а HTML-страницей входа
      // или ошибкой. Раньше такой ответ молча превращался в пустой пузырь
      // с вечным «Думаю…», поэтому проверяем тип явно.
      const contentType = String(res.headers.get('content-type') || '').toLowerCase();
      // Пустой content-type считаем потоком: так отвечают тестовые
      // транспорты и часть прокси, которые не пробрасывают заголовок.
      if (contentType && !contentType.includes('text/event-stream')) {
        const body = await res.text().catch(() => '');
        this.log(
          `claude completion not SSE: status=${res.status} type=${contentType} ` +
            `redirected=${Boolean(res.redirected)} body=${body.slice(0, 160)}`,
        );
        if (res.redirected || /<html|<!doctype/i.test(body)) {
          throw new ClaudeError(
            'unauthorized',
            'Claude вернул страницу входа: сессия истекла или сработала проверка Cloudflare. ' +
              'Войдите в Claude заново (Настройки → Claude) и повторите запрос.',
          );
        }
        throw new ClaudeError('other', 'Claude вернул неожиданный ответ. Повторите запрос.');
      }

      const state = {
        artifactBuffers: new Map(),
        fileDisplays: new Map(),
        toolBuffers: new Map(),
        stepMap: new Map(),
        onStep,
      };
      await readSse(
        res,
        async (data) => {
          if (signal?.aborted) return;
          const piece = handleEvent(data, state);
          if (piece == null) return;
          full += piece;
          const artifactPiece = /<(?:ant)?artifact[\s>]/i.test(piece);
          if (!artifactPiece) onDelta(piece);
        },
        // Долгое extended thinking может молчать несколько минут. 90 секунд
        // обрывали нормальный ответ; ждём 10 минут тишины.
        { idleMs: 600_000 },
      );
      if (signal?.aborted) return full;
      // Инструмент мог остаться «выполняется», если ответ оборвался.
      finalizeSteps(state);

      const finalText = await this.reconcileText(full, orgId, resume).catch((err) => {
        this.log(`claude reconcile failed: ${err.message}`);
        return full;
      });
      if (!String(finalText || '').trim()) {
        throw new ClaudeError('other', 'Claude вернул пустой ответ. Повторите запрос.');
      }
      onProgress({ conversationId: resume, text: finalText });
      return finalText;
    } catch (err) {
      if (signal?.aborted) return full;
      throw err;
    }
  }

  async reconcileText(streamed, orgId, conversationId) {
    const remote = await this.latestAssistantAnswer(orgId, conversationId);
    if (!remote?.text?.trim()) return streamed;
    const prefix = streamed.trim().slice(0, 60);
    if (prefix && !remote.text.includes(prefix)) return streamed;
    const remoteHasArtifact = /<(?:ant)?artifact[\s>]/i.test(remote.text);
    const streamedHasArtifact = /<(?:ant)?artifact[\s>]/i.test(streamed);
    if (remoteHasArtifact && !streamedHasArtifact) return remote.text;
    if (remote.text.length > streamed.length + 80) return remote.text;
    return streamed;
  }

  async requireSession() {
    const { orgId } = this.session || {};
    if (!orgId) throw new ClaudeError('other', 'Аккаунт Claude не привязан');
    return this.session;
  }

  setSession(session) {
    this.session = session || null;
  }
}

function extractMessageText(obj) {
  return contentText(obj?.content);
}

function contentText(element) {
  if (element == null) return null;
  if (typeof element === 'string') return element.trim() ? element : null;
  if (Array.isArray(element)) {
    const parts = element.map(contentText).filter(Boolean);
    return parts.length ? parts.join('\n') : null;
  }
  if (typeof element !== 'object') return null;
  const type = text(element, 'type');
  if (type === 'thinking' || type === 'image') return null;
  return text(element, 'text') || contentText(element.content) || contentText(element.tool_result);
}

function messageArtifacts(obj) {
  const parts = [];
  const consume = (item) => {
    if (!item || typeof item !== 'object') return;
    const type = text(item, 'type');
    if (type === 'artifact') {
      const tag = artifactTagFrom(item);
      if (tag) parts.push(tag);
      return;
    }
    if (type !== 'tool_use') return;
    if (isArtifactTool(text(item, 'name'))) {
      const tag = artifactTagFrom(item.input);
      if (tag) parts.push(tag);
    }
    const display = item.display_content;
    if (display && typeof display === 'object') {
      const tag = fileArtifactTag(display);
      if (tag) parts.push(tag);
    }
  };

  let contentArray = Array.isArray(obj?.content) ? obj.content : null;
  if (!contentArray && typeof obj?.content === 'string') {
    try {
      const parsed = JSON.parse(obj.content);
      if (Array.isArray(parsed)) contentArray = parsed;
    } catch {
      /* not json */
    }
  }
  if (contentArray) contentArray.forEach(consume);
  if (Array.isArray(obj?.artifacts)) obj.artifacts.forEach(consume);
  else if (obj?.artifacts && typeof obj.artifacts === 'object') consume(obj.artifacts);
  const seen = new Set();
  const addTextAttachment = (file) => {
    if (!file || typeof file !== 'object') return;
    const content = text(file, 'extracted_content') || text(file, 'content') || text(file, 'text') || text(file, 'code');
    if (!content?.trim() || content.length > 200_000) return;
    const path = text(file, 'filename') || text(file, 'file_name') || text(file, 'name') || text(file, 'sanitized_name');
    if (!path) return;
    const mime = text(file, 'mime_type') || text(file, 'file_type') || text(file, 'mime') || mimeFromName(path);
    if (!isTextLike(path, mime)) return;
    const id = `file:${path}`;
    if (seen.has(id)) return;
    seen.add(id);
    const type = /python|\.py$/i.test(`${mime} ${path}`)
      ? 'text/x-python'
      : /html|\.html$/i.test(`${mime} ${path}`)
        ? 'text/html'
        : /svg|\.svg$/i.test(`${mime} ${path}`)
          ? 'image/svg+xml'
          : /javascript|typescript|\.(js|ts|tsx)$/i.test(`${mime} ${path}`)
            ? 'text/javascript'
            : /css|\.css$/i.test(`${mime} ${path}`)
              ? 'text/css'
              : /json|\.json$/i.test(`${mime} ${path}`)
                ? 'application/json'
                : /markdown|\.md$/i.test(`${mime} ${path}`)
                  ? 'text/markdown'
                  : 'text/plain';
    parts.push(artifactTag(id, path.split('/').pop() || 'Файл', type, content));
  };
  if (Array.isArray(obj?.files)) obj.files.forEach(addTextAttachment);
  if (Array.isArray(obj?.attachments)) obj.attachments.forEach(addTextAttachment);
  return parts.join('');
}

/* ---------- шаги инструментов (как в «Сводке» официального Claude) ---------- */

function firstText(obj, keys) {
  for (const key of keys) {
    const value = text(obj, key);
    if (value) return value;
  }
  return null;
}

/** Человеческий заголовок шага: описание, команда, файл или запрос. */
function toolStepTitle(name, input) {
  const described = (text(input, 'description') || '').trim();
  if (described) return described;
  const command = (text(input, 'command') || '').trim();
  if (command) return command.split('\n')[0].slice(0, 90);
  const path = (firstText(input, ['path', 'file_path', 'filename']) || '').trim();
  if (path) return `Читаю ${path.split('/').pop()}`;
  const query = (firstText(input, ['query', 'q']) || '').trim();
  if (query) return `Ищу: ${query.slice(0, 90)}`;
  switch (String(name || '').toLowerCase()) {
    case 'view':
    case 'read':
      return 'Читаю файл';
    case 'bash':
    case 'shell':
      return 'Запускаю команду';
    case 'web_search_v0':
    case 'web_search':
    case 'websearch':
      return 'Ищу в интернете';
    case 'webfetch':
      return 'Открываю страницу';
    case 'repl':
      return 'Запускаю код';
    default: {
      const clean = String(name || '').replace(/_/g, ' ').trim();
      return clean ? clean[0].toUpperCase() + clean.slice(1) : 'Шаг';
    }
  }
}

function prettyToolInput(input) {
  if (!input || typeof input !== 'object' || !Object.keys(input).length) return '';
  try {
    return JSON.stringify(input, null, 2).slice(0, 12_000);
  } catch {
    return '';
  }
}

function flattenToolContent(element) {
  if (element == null) return null;
  if (typeof element === 'string') return element.trim() ? element : null;
  if (typeof element === 'number' || typeof element === 'boolean') return String(element);
  if (Array.isArray(element)) {
    const parts = element.map(flattenToolContent).filter(Boolean);
    return parts.length ? parts.join('\n') : null;
  }
  if (typeof element === 'object') {
    const direct = text(element, 'text');
    if (direct) return direct;
    return flattenToolContent(element.content);
  }
  return null;
}

function toolResultText(block) {
  const content = block?.content ?? block?.result ?? block?.output;
  if (content == null) return '';
  const flat = flattenToolContent(content);
  return (flat ?? JSON.stringify(content)).slice(0, 20_000);
}

function ensureStepState(state) {
  if (!state.toolBuffers) state.toolBuffers = new Map();
  if (!state.stepMap) state.stepMap = new Map();
  return state;
}

function publishStep(state, step) {
  ensureStepState(state);
  state.stepMap.set(step.id, step);
  if (typeof state.onStep === 'function') state.onStep(step);
}

function startTool(state, index, block) {
  ensureStepState(state);
  const name = text(block, 'name');
  if (!name || isArtifactTool(name)) return;
  const id = text(block, 'id') || text(block, 'tool_use_id') || `tool_${index}_${Date.now()}`;
  let input = block.input;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      input = null;
    }
  }
  if (!input || typeof input !== 'object' || !Object.keys(input).length) {
    const display = block.display_content;
    const raw = display && typeof display === 'object' ? text(display, 'json_block') : null;
    if (raw) {
      try {
        input = JSON.parse(raw);
      } catch {
        /* остаётся прежний */
      }
    }
  }
  const safeInput = input && typeof input === 'object' ? input : null;
  state.toolBuffers.set(index, { id, name, json: '', input: safeInput });
  publishStep(state, {
    id,
    name,
    title: toolStepTitle(name, safeInput),
    status: 'running',
    detail: prettyToolInput(safeInput),
  });
}

/** Инструмент доработал: JSON запроса уже целиком, заголовок можно уточнить. */
function finishTool(state, index, block) {
  ensureStepState(state);
  const buffer = state.toolBuffers.get(index);
  if (!buffer) return;
  state.toolBuffers.delete(index);
  let parsed = null;
  if (buffer.json) {
    try {
      parsed = JSON.parse(buffer.json);
    } catch {
      parsed = null;
    }
  }
  const input = parsed && typeof parsed === 'object' ? parsed : buffer.input;
  const previous = state.stepMap.get(buffer.id);
  if (!previous) return;
  const extra = (text(block, 'description') || '').trim();
  publishStep(state, {
    ...previous,
    title: toolStepTitle(buffer.name, input) || extra || previous.title,
    detail: prettyToolInput(input) || previous.detail,
  });
}

function applyToolResult(state, block) {
  if (!block || typeof block !== 'object') return;
  ensureStepState(state);
  const id = text(block, 'tool_use_id') || text(block, 'toolUseId') || text(block, 'id');
  if (!id) return;
  const previous = state.stepMap.get(id);
  if (!previous) return;
  const failed =
    text(block, 'is_error') === 'true' ||
    text(block, 'isError') === 'true' ||
    block.is_error === true ||
    block.isError === true;
  publishStep(state, {
    ...previous,
    status: failed ? 'failed' : 'done',
    result: toolResultText(block) || previous.result || '',
  });
}

/** Текст пошёл — значит инструменты уже отработали, не держим их «выполняется». */
function finalizeSteps(state) {
  ensureStepState(state);
  for (const step of [...state.stepMap.values()]) {
    if (step.status === 'running') publishStep(state, { ...step, status: 'done' });
  }
}

/** Готовый ход в message_start: шаги без стрима (после перезагрузки диалога). */
function collectStepBlocks(state, obj) {
  ensureStepState(state);
  const content = Array.isArray(obj?.content) ? obj.content : null;
  if (!content) return;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const type = text(block, 'type') || '';
    if (type === 'tool_use' || type === 'server_tool_use') {
      const name = text(block, 'name');
      if (!name || isArtifactTool(name)) continue;
      const id = text(block, 'id') || text(block, 'tool_use_id');
      if (!id) continue;
      const input = block.input && typeof block.input === 'object' ? block.input : null;
      publishStep(state, {
        id,
        name,
        title: toolStepTitle(name, input),
        status: 'running',
        detail: prettyToolInput(input),
      });
    } else if (type === 'tool_result' || type === 'tool_use_result' || type.endsWith('_tool_result')) {
      applyToolResult(state, block);
    }
  }
}

function handleEvent(data, state) {  let root;
  try {
    root = JSON.parse(data);
  } catch {
    return null;
  }
  const type = text(root, 'type');
  if (type === 'completion') return text(root, 'completion');
  if (type === 'content_block_start') {
    const index = intOrNull(root, 'index') ?? 0;
    const block = root.content_block;
    const blockType = text(block, 'type');
    if (blockType === 'tool_use' && isArtifactTool(text(block, 'name'))) {
      let readyObject = block.input && typeof block.input === 'object' ? block.input : null;
      if (!readyObject && typeof block.input === 'string') {
        try {
          readyObject = JSON.parse(block.input);
        } catch {
          readyObject = null;
        }
      }
      const ready = artifactTagFrom(readyObject);
      if (ready) return ready;
      state.artifactBuffers.set(index, '');
      return null;
    }
    if (blockType === 'artifact') return artifactTagFrom(block);
    if (blockType === 'tool_use' || blockType === 'server_tool_use') {
      // create_file присылает код отдельным display_content — это артефакт,
      // а не шаг, поэтому сначала запоминаем его.
      const toolDisplay = block?.display_content;
      if (toolDisplay && typeof toolDisplay === 'object' && toolDisplay.json_block != null) {
        state.fileDisplays.set(index, toolDisplay);
      }
      startTool(state, index, block);
      return null;
    }
    if (
      blockType === 'tool_result' ||
      blockType === 'tool_use_result' ||
      (blockType && blockType.endsWith('_tool_result'))
    ) {
      applyToolResult(state, block);
      return null;
    }
    const display = block?.display_content;
    if (display && typeof display === 'object' && display.json_block != null) {
      state.fileDisplays.set(index, display);
    }
    return null;
  }
  if (type === 'content_block_delta') {
    const delta = root.delta;
    const index = intOrNull(root, 'index') ?? 0;
    const deltaType = text(delta, 'type');
    if (deltaType === 'input_json_delta') {
      const partial = text(delta, 'partial_json') || '';
      if (state.artifactBuffers.has(index)) {
        state.artifactBuffers.set(index, state.artifactBuffers.get(index) + partial);
      }
      const tool = state.toolBuffers.get(index);
      if (tool) tool.json += partial;
      return null;
    }
    if (deltaType === 'tool_use_block_update_delta') {
      const display = delta?.display_content;
      if (display && typeof display === 'object') state.fileDisplays.set(index, display);
      return null;
    }
    const piece = text(delta, 'text');
    // Пошёл текст ответа — инструменты уже отработали.
    if (piece && state.stepMap && [...state.stepMap.values()].some((step) => step.status === 'running')) {
      finalizeSteps(state);
    }
    return piece;
  }
  if (type === 'content_block_stop') {
    const index = intOrNull(root, 'index') ?? 0;
    const display = state.fileDisplays.get(index);
    if (display) {
      state.fileDisplays.delete(index);
      return fileArtifactTag(display);
    }
    const buffer = state.artifactBuffers.get(index);
    if (buffer != null) {
      state.artifactBuffers.delete(index);
      try {
        return artifactTagFrom(JSON.parse(buffer));
      } catch {
        return null;
      }
    }
    finishTool(state, index, root.content_block);
    return null;
  }
  if (type === 'tool_result' || type === 'tool_use_result') {
    applyToolResult(state, root.tool_result || root.tool_use_result || root.block);
    return null;
  }
  if (type === 'message_start' || type === 'message') {
    collectStepBlocks(state, root.message);
    return null;
  }
  if (type === 'artifact') return artifactTagFrom(root.artifact);
  if (type === 'message_limit') {
    const limit = root.message_limit;
    const kind = String(text(limit, 'type') || '').toLowerCase();
    const remaining = Number(text(limit, 'remaining'));
    const exceeded =
      kind === 'exceeded_limit' ||
      (kind === 'approaching_limit' && Number.isFinite(remaining) && remaining <= 0);
    if (!exceeded) return null;
    throw new ClaudeError(
      'rate_limit',
      text(limit, 'message') || 'Лимит аккаунта Claude исчерпан',
      resetMillis(text(limit, 'resetsAt')),
    );
  }
  if (type === 'rate_limit') {
    const limit = root.rate_limit;
    const kind = String(text(limit, 'type') || '').toLowerCase();
    const remaining = Number(text(limit, 'remaining'));
    const exceeded =
      kind === 'exceeded_limit' ||
      (kind === 'approaching_limit' && Number.isFinite(remaining) && remaining <= 0);
    if (!exceeded) return null;
    throw new ClaudeError(
      'rate_limit',
      text(limit, 'message') || 'Лимит аккаунта Claude исчерпан',
      resetMillis(text(limit, 'resetsAt')),
    );
  }
  if (type === 'error') {
    const message = text(root.error, 'message') || text(root.error, 'type') || 'Claude вернул ошибку';
    throw new ClaudeError(/limit/i.test(message) ? 'rate_limit' : 'other', message);
  }
  return null;
}

/** Одно чтение из потока с таймаутом: claude.ai может открыть SSE и замолчать. */
async function readChunk(reader, idleMs) {
  let timer = null;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new ClaudeError('network', 'Claude перестал отвечать. Повторите запрос.')),
          idleMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readSse(response, onData, { idleMs = 0 } = {}) {
  if (!response.body) throw new ClaudeError('other', 'Claude не прислал ответ');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = idleMs > 0
        ? await readChunk(reader, idleMs)
        : await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        await onData(data);
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

function mimeFromName(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return (
    {
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      zip: 'application/zip',
      doc: 'application/msword',
      docx: 'application/msword',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.ms-excel',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.ms-powerpoint',
      mp3: 'audio/mpeg',
      mp4: 'video/mp4',
    }[ext] || ''
  );
}

function isBinaryFile(name, mime) {
  if (
    /^(image|audio|video)\//i.test(mime) ||
    /pdf|zip|msword|officedocument/i.test(mime)
  ) {
    return true;
  }
  return new Set([
    'pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'zip', 'rar', '7z',
    'tar', 'gz', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'mp3', 'mp4', 'mov', 'wav',
  ]).has(String(name || '').split('.').pop().toLowerCase());
}

function isTextLike(name, mime) {
  if (/^text\//i.test(mime)) return true;
  if (/json|xml|javascript|python|yaml|toml|csv|markdown|sql/i.test(mime)) return true;
  return new Set([
    'py', 'js', 'jsx', 'ts', 'tsx', 'java', 'kt', 'kts', 'c', 'cc', 'cpp', 'h', 'hpp',
    'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bash', 'zsh', 'sql', 'html', 'htm', 'css',
    'scss', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'md', 'txt', 'log', 'csv',
    'tsv', 'svg', 'diff', 'patch',
  ]).has(String(name || '').split('.').pop().toLowerCase());
}

/** Текст можно встроить в промпт, а не загружать в claude.ai. */
function isInlineableText(attachment) {
  const name = String(attachment?.name || '');
  const mime = String(attachment?.mime || '');
  const data = String(attachment?.data || '');
  if (!data) return false;
  // base64 длиннее исходника примерно на треть: 400 КБ текста — разумный предел.
  if (data.length > 560_000) return false;
  if (isBinaryFile(name, mime)) return false;
  return isTextLike(name, mime);
}

/** Блок <attached_files> с текстом вложений: общий бюджет 120k символов. */
function inlineAttachmentsBlock(attachments) {
  let budget = 120_000;
  const chunks = [];
  for (const file of attachments || []) {
    let text = '';
    try {
      text = Buffer.from(String(file.data || ''), 'base64').toString('utf8');
    } catch {
      continue;
    }
    if (!text.trim() || text.includes('\u0000')) continue;
    const name = String(file.name || 'файл').replace(/["<>&]/g, '_').slice(0, 120);
    const slice = text.slice(0, Math.max(1200, Math.min(40_000, budget)));
    chunks.push(`<file name="${name}">\n${slice}\n</file>`);
    budget -= slice.length;
    if (budget <= 0) break;
  }
  return chunks.length ? `\n\n<attached_files>\n${chunks.join('\n')}\n</attached_files>` : '';
}

function resetMillis(raw) {
  if (raw == null || raw === '') return 0;
  const value = String(raw);
  if (/^\d+$/.test(value)) {
    const number = Number(value);
    return number < 10_000_000_000 ? number * 1000 : number;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

module.exports = {
  BASE,
  ClaudeClient,
  ClaudeError,
  DEFAULT_UA,
  FALLBACK_MODELS,
  PRO_MODELS,
  buildFirstPrompt,
  buildFollowUpPrompt,
  isModelId,
  modelsForPlan,
  preferredModel,
  handleEvent,
  readSse,
};
