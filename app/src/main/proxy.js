'use strict';

/**
 * Прокси и VPN для десктопа.
 *
 * Android-версия поднимает полноценный VPN (VpnService + tun). На Windows без
 * прав администратора tun недоступен, поэтому здесь тот же принцип, но проще:
 * рядом с приложением запускается ядро xray, которое слушает локальные
 * SOCKS5/HTTP порты, а трафик приложения (включая claude.ai) направляется в них.
 *
 * Наборы узлов, подписки и встроенные бесплатные узлы Clauden — те же, что на
 * Android: список приходит с /v1/proxy/nodes, запасной набор зашит в код.
 */

const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parse, parseList, buildConfig } = require('./node-parser');

const SOCKS_PORT = 20818;
const HTTP_PORT = 20819;
const API_BASE = 'https://clauden.best';

const FALLBACK_NODES = [
  'vless://33e057e5-4f47-4600-9e28-27b411ff24ca@188.40.190.90:8413?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.google.com&fp=chrome&pbk=HGSIXv8eD08UUqR7zUfzPshqXtg2aVbQ_ldtv4xWBH4&sid=d95086518c202936&type=tcp#Clauden%20DE',
  'vless://33e057e5-4f47-4600-9e28-27b411ff24ca@188.40.190.90:8414?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.google.com&fp=chrome&pbk=HGSIXv8eD08UUqR7zUfzPshqXtg2aVbQ_ldtv4xWBH4&sid=d95086518c202936&type=tcp#Clauden%20NL',
  'vless://33e057e5-4f47-4600-9e28-27b411ff24ca@188.40.190.90:8416?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.google.com&fp=chrome&pbk=HGSIXv8eD08UUqR7zUfzPshqXtg2aVbQ_ldtv4xWBH4&sid=d95086518c202936&type=tcp#Clauden%20EE',
  'vless://33e057e5-4f47-4600-9e28-27b411ff24ca@188.40.190.90:8417?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.google.com&fp=chrome&pbk=HGSIXv8eD08UUqR7zUfzPshqXtg2aVbQ_ldtv4xWBH4&sid=d95086518c202936&type=tcp#Clauden%20KZ',
  'vless://33e057e5-4f47-4600-9e28-27b411ff24ca@188.40.190.90:8415?encryption=none&security=tls&sni=teleopen.space&fp=chrome&type=xhttp&path=%2Fclauden&host=teleopen.space#Clauden%20TLS%20(резерв)',
];

function xrayBinary() {
  const name = process.platform === 'win32' ? 'xray.exe' : 'xray';
  const candidates = [
    path.join(process.resourcesPath || '', 'xray', name),
    path.join(__dirname, '..', '..', 'resources', 'xray', name),
    path.join(__dirname, '..', '..', '..', 'resources', 'xray', name),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `loc=` из /cdn-cgi/trace: страна, из которой claude.ai видит подключение. */
function parseTrace(text) {
  const body = String(text || '');
  const ip = body.match(/^ip=([^\r\n]+)$/m)?.[1]?.trim() || '';
  const country = body.match(/^loc=([A-Za-z]+)$/m)?.[1]?.trim().toUpperCase() || '';
  if (!ip) return null;
  return { ip, country };
}

/**
 * Свой выход уже не из России (домашняя сеть, роуминг или VPN пользователя).
 * В этом случае встроенный прокси Clauden подменяет рабочий адрес и только
 * добавляет общий лимит Anthropic — автозапуск нужно пропустить.
 */
function exitOutsideRussia(exit) {
  const country = String(exit?.country || '').trim().toUpperCase();
  return Boolean(country) && country !== 'RU';
}

/** Прямая проверка выхода: без нашего SOCKS/HTTP-прокси и сессий Electron. */
function probeOwnExit(timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let req;
    try {
      req = https.get(
        'https://claude.ai/cdn-cgi/trace',
        { headers: { accept: 'text/plain' }, timeout: timeoutMs },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            done(null);
            return;
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
            if (body.length > 4096) body = body.slice(0, 4096);
          });
          res.on('end', () => done(parseTrace(body)));
          res.on('error', () => done(null));
        },
      );
      req.on('timeout', () => {
        req.destroy();
        done(null);
      });
      req.on('error', () => done(null));
    } catch {
      done(null);
    }
  });
}

function portOpen(port, timeout = 700) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

class ProxyManager {
  constructor({ app, logger, getSessions, onEvent }) {
    this.app = app;
    this.logger = logger || (() => {});
    this.getSessions = getSessions || (() => []);
    this.onEvent = onEvent || (() => {});
    this.child = null;
    this.status = 'off';
    this.error = '';
    this.activeName = '';
    /** Реальный выход пользователя без нашего туннеля. */
    this.ownExit = { ip: '', country: '' };
    this.autoSkipped = false;
    this.autoSkipReason = '';
    this.configPath = path.join(app.getPath('userData'), 'proxy-xray.json');
    this.statePath = path.join(app.getPath('userData'), 'proxy.json');
    this.data = {
      subscription: '',
      nodes: [],
      selectedId: '',
      builtin: [],
      autoStart: true,
    };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.data = {
          subscription: typeof raw.subscription === 'string' ? raw.subscription : '',
          nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
          selectedId: typeof raw.selectedId === 'string' ? raw.selectedId : '',
          builtin: Array.isArray(raw.builtin) ? raw.builtin : [],
          autoStart: raw.autoStart !== false,
        };
      }
    } catch {
      /* первый запуск */
    }
    if (!this.data.builtin.length) {
      this.data.builtin = FALLBACK_NODES.map((raw) => parse(raw)).filter(Boolean);
    }
  }

  save() {
    try {
      fs.writeFileSync(this.statePath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    } catch (err) {
      this.logger(`[proxy] save failed: ${err.message}`);
    }
  }

  selected() {
    const id = this.data.selectedId;
    return (
      this.data.nodes.find((node) => node.id === id) ||
      this.data.builtin.find((node) => node.id === id) ||
      null
    );
  }

  snapshot() {
    return {
      status: this.status,
      error: this.error,
      activeName: this.activeName,
      selectedId: this.data.selectedId,
      selected: this.selected(),
      nodes: this.data.nodes,
      builtin: this.data.builtin,
      subscription: this.data.subscription,
      autoStart: this.data.autoStart,
      exitIp: this.ownExit.ip,
      exitCountry: this.ownExit.country,
      exitOutsideRussia: exitOutsideRussia(this.ownExit),
      autoSkipped: this.autoSkipped,
      autoSkipReason: this.autoSkipReason,
      socksPort: SOCKS_PORT,
      httpPort: HTTP_PORT,
      binary: Boolean(xrayBinary()),
      connected: this.status === 'on',
    };
  }

  emit() {
    try {
      this.onEvent(this.snapshot());
    } catch {
      /* ignore */
    }
  }

  setStatus(status, error = '') {
    this.status = status;
    this.error = error;
    if (status !== 'on') this.activeName = '';
    this.emit();
  }

  async fetchText(url, headers, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Список встроенных бесплатных узлов Clauden (с бэкенда, иначе запасной). */
  async refreshBuiltin() {
    try {
      const text = await this.fetchText(`${API_BASE}/v1/proxy/nodes`, { Accept: 'application/json' }, 10000);
      const payload = JSON.parse(text);
      const list = Array.isArray(payload?.nodes) ? payload.nodes : [];
      const nodes = list.map((raw) => parse(raw)).filter(Boolean);
      if (nodes.length) {
        this.data.builtin = nodes;
        this.save();
      }
    } catch (err) {
      this.logger(`[proxy] builtin nodes: ${err.message}`);
    }
    return this.data.builtin;
  }

  /** Подписка: ссылка на список или вставленный текст. */
  async subscribe(input) {
    const value = String(input || '').trim();
    if (!value) throw new Error('Вставьте ссылку на подписку или список серверов');
    let nodes;
    if (!/^https?:\/\//i.test(value)) {
      nodes = parseList(value);
    } else {
      const agents = [
        'Happ/3.20.4/Windows/17782185961531805698',
        'v2rayN/6.42',
        'V2RayTun/1.0',
        'hiddify/2.0.5',
        'clash-meta/1.18.0',
      ];
      let lastError = '';
      nodes = [];
      for (const agent of agents) {
        try {
          const text = await this.fetchText(value, {
            'User-Agent': agent,
            Accept: '*/*',
            'X-Device-Os': process.platform === 'win32' ? 'Windows' : process.platform,
          }, 20000);
          nodes = parseList(text);
          if (nodes.length) break;
        } catch (err) {
          lastError = err.message;
        }
      }
      if (!nodes.length) throw new Error(lastError || 'В подписке не нашлось поддерживаемых серверов');
    }
    if (!nodes.length) throw new Error('Не удалось разобрать серверы');
    this.data.nodes = nodes;
    this.data.subscription = value;
    if (!nodes.some((node) => node.id === this.data.selectedId)) {
      this.data.selectedId = nodes[0].id;
    }
    this.save();
    this.emit();
    return nodes;
  }

  select(id) {
    const exists =
      this.data.nodes.some((node) => node.id === id) || this.data.builtin.some((node) => node.id === id);
    if (!exists) throw new Error('Сервер не найден');
    this.data.selectedId = id;
    this.save();
    this.emit();
    return this.snapshot();
  }

  setAutoStart(value) {
    this.data.autoStart = Boolean(value);
    this.save();
    this.emit();
    return this.snapshot();
  }

  /** Запоминает реальный выход пользователя (нужен для автозапуска и UI). */
  async checkOwnExit() {
    const exit = await probeOwnExit();
    if (exit) {
      this.ownExit = exit;
      this.emit();
    }
    return exit;
  }

  /**
   * Автозапуск для «Прокси включать при запуске».
   *
   * Если человек уже выходит в интернет не из России (свой VPN, роуминг,
   * другая страна), встроенный узел не поднимаем: claude.ai пойдёт с его
   * настоящего адреса, а не с общего выхода Clauden, на который Anthropic
   * чаще всего и отвечает 429.
   */
  async autoStart() {
    if (!this.data.autoStart || !this.data.selectedId) return this.snapshot();
    const exit = await this.checkOwnExit();
    const selected = this.selected();
    const builtinSelected = Boolean(
      selected && this.data.builtin.some((node) => node.id === selected.id),
    );
    if (builtinSelected && exitOutsideRussia(exit)) {
      this.logger(`[proxy] autostart skipped: own exit ${exit.country} ${exit.ip}`);
      if (this.child || this.status === 'on' || this.status === 'connecting') {
        await this.stop({ silent: true });
      } else {
        await this.applySessions(false);
        this.status = 'off';
      }
      this.activeName = '';
      this.autoSkipped = true;
      this.autoSkipReason =
        `Ваш выход — ${exit.country} (${exit.ip}). Прокси Clauden не включён: ` +
        'claude.ai пойдёт напрямую с этого адреса.';
      this.emit();
      return this.snapshot();
    }
    this.autoSkipped = false;
    this.autoSkipReason = '';
    return this.start();
  }

  /** TCP-пинг узла: сколько миллисекунд до установления соединения. */
  async ping(id) {
    const node =
      this.data.nodes.find((item) => item.id === id) || this.data.builtin.find((item) => item.id === id);
    if (!node) return { id, ok: false, ms: 0 };
    const started = Date.now();
    const ok = await new Promise((resolve) => {
      const socket = net.connect({ host: node.address, port: node.port });
      const done = (value) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(3500);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
    return { id, ok, ms: ok ? Date.now() - started : 0 };
  }

  async applySessions(enabled) {
    const sessions = this.getSessions().filter(Boolean);
    for (const ses of sessions) {
      try {
        if (enabled) {
          await ses.setProxy({
            proxyRules: `socks5://127.0.0.1:${SOCKS_PORT}`,
            proxyBypassRules: '<local>,clauden.best,*.clauden.best',
          });
        } else {
          await ses.setProxy({ mode: 'direct' });
        }
        if (typeof ses.closeAllConnections === 'function') ses.closeAllConnections();
      } catch (err) {
        this.logger(`[proxy] setProxy failed: ${err.message}`);
      }
    }
  }

  async start(id) {
    if (id) this.select(id);
    this.autoSkipped = false;
    this.autoSkipReason = '';
    const node = this.selected();
    if (!node) throw new Error('Сначала выберите сервер');
    if (node.unsupported) throw new Error('Этот протокол пока не поддерживается на ПК');
    const binary = xrayBinary();
    if (!binary) throw new Error('Ядро прокси не найдено в приложении');

    await this.stop({ silent: true });
    this.setStatus('connecting');

    const config = buildConfig(node, { socksPort: SOCKS_PORT, httpPort: HTTP_PORT });
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    } catch (err) {
      this.setStatus('error', `Не удалось записать конфиг: ${err.message}`);
      throw err;
    }

    const child = spawn(binary, ['-c', this.configPath], {
      windowsHide: true,
      cwd: path.dirname(binary),
      // geoip.dat/geosite.dat лежат рядом с ядром — xray ищет их по этой переменной.
      env: { ...process.env, XRAY_LOCATION_ASSET: path.dirname(binary) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    let stderr = '';
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2000);
    });
    child.once('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.applySessions(false).catch(() => {});
      const message = code === 0 ? '' : stderr.trim().split('\n').slice(-2).join(' ') || `xray exited ${code}`;
      this.setStatus(message ? 'error' : 'off', message);
    });

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (!this.child) break;
      if (await portOpen(SOCKS_PORT, 400)) {
        await this.applySessions(true);
        this.activeName = node.name;
        this.setStatus('on');
        this.logger(`[proxy] connected ${node.protocol} ${node.endpoint}`);
        return this.snapshot();
      }
      await delay(150);
    }

    await this.stop({ silent: true });
    const message = stderr.trim() ? stderr.trim().split('\n').slice(-1)[0] : 'Ядро прокси не поднялось';
    this.setStatus('error', message);
    throw new Error(message);
  }

  async stop({ silent = false } = {}) {
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    await this.applySessions(false);
    if (!silent) {
      this.autoSkipped = false;
      this.autoSkipReason = '';
      this.setStatus('off');
      this.logger('[proxy] disconnected');
    } else if (this.status === 'on') {
      this.status = 'off';
    }
    return this.snapshot();
  }

  async toggle(id) {
    if (this.status === 'on' || this.status === 'connecting') return this.stop();
    return this.start(id);
  }

  async dispose() {
    await this.stop({ silent: true });
  }
}

module.exports = {
  ProxyManager,
  SOCKS_PORT,
  HTTP_PORT,
  FALLBACK_NODES,
  xrayBinary,
  parseTrace,
  exitOutsideRussia,
  probeOwnExit,
};
