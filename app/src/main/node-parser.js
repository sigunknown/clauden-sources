'use strict';

/**
 * Разбор share-ссылок (vless / vmess / trojan / ss / socks) и сборка конфига
 * для ядра xray. Порт логики Android-версии (proxy/NodeParser.kt) на JS:
 * те же протоколы и те же транспорты, чтобы подписки работали одинаково.
 */

const SUPPORTED = new Set(['vless', 'vmess', 'trojan', 'ss', 'socks']);

const PROTOCOL_LABELS = {
  vless: 'VLESS',
  vmess: 'VMess',
  trojan: 'Trojan',
  ss: 'Shadowsocks',
  socks: 'SOCKS5',
  hysteria2: 'Hysteria2',
};

function pctDecode(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

function tryBase64(value) {
  const text = String(value || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!text) return null;
  // В base64 нет двоеточия и собаки — значит, это уже готовые логин/пароль.
  if (/[:@\s]/.test(text)) return null;
  const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return decoded && !decoded.includes('\u0000') ? decoded : null;
  } catch {
    return null;
  }
}

/** Логин/пароль в ссылке: сначала как есть, потом как base64. */
function decodeCreds(value) {
  const plain = pctDecode(value);
  if (plain.includes(':')) return plain;
  const decoded = tryBase64(value);
  return decoded && decoded.includes(':') ? decoded : plain;
}

function parseQuery(raw) {
  const out = {};
  const text = String(raw || '').replace(/^\?/, '');
  if (!text) return out;
  for (const pair of text.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? '' : pair.slice(eq + 1);
    out[pctDecode(key)] = pctDecode(value);
  }
  return out;
}

/** Разбивает ссылку на тело / query / имя. */
function splitUri(uri) {
  const hashAt = uri.indexOf('#');
  const name = hashAt >= 0 ? pctDecode(uri.slice(hashAt + 1)) : '';
  let rest = hashAt >= 0 ? uri.slice(0, hashAt) : uri;
  const queryAt = rest.indexOf('?');
  const query = queryAt >= 0 ? parseQuery(rest.slice(queryAt + 1)) : {};
  if (queryAt >= 0) rest = rest.slice(0, queryAt);
  const schemeAt = rest.indexOf('://');
  const body = schemeAt >= 0 ? rest.slice(schemeAt + 3) : rest;
  return { body, query, name: name.trim() };
}

function hostPort(value, defaultPort) {
  const text = String(value || '').trim();
  if (!text) return null;
  // IPv6: [::1]:443
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end < 0) return null;
    const host = text.slice(1, end);
    const rest = text.slice(end + 1).replace(/^:/, '');
    const port = Number(rest) || defaultPort;
    return host ? { host, port } : null;
  }
  const colon = text.lastIndexOf(':');
  if (colon < 0) return { host: text, port: defaultPort };
  const host = text.slice(0, colon);
  const port = Number(text.slice(colon + 1)) || defaultPort;
  return host ? { host, port } : null;
}

function nodeId(raw) {
  let hash = 5381;
  for (let i = 0; i < raw.length; i += 1) hash = ((hash << 5) + hash + raw.charCodeAt(i)) >>> 0;
  return `n${hash.toString(16)}`;
}

function makeNode(protocol, address, port, name, params, raw) {
  if (!address || !port) return null;
  const label = name || `${PROTOCOL_LABELS[protocol] || protocol} ${address}`;
  return {
    id: nodeId(raw),
    name: label.slice(0, 120),
    address,
    port,
    protocol,
    raw,
    params: params || {},
    endpoint: `${address}:${port}`,
    protocolLabel: PROTOCOL_LABELS[protocol] || protocol,
  };
}

function parseVless(uri) {
  const { body, query, name } = splitUri(uri);
  const at = body.lastIndexOf('@');
  if (at < 0) return null;
  const id = pctDecode(body.slice(0, at));
  const hp = hostPort(body.slice(at + 1), 443);
  if (!id || !hp) return null;
  return makeNode('vless', hp.host, hp.port, name, { ...query, id }, uri);
}

function parseVmess(uri) {
  const { body, name } = splitUri(uri);
  const json = tryBase64(body);
  if (!json) return null;
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const address = String(data.add || data.address || '').trim();
  const port = Number(data.port);
  const id = String(data.id || '').trim();
  if (!address || !port || !id) return null;
  const params = {
    id,
    alterId: String(data.aid ?? data.alterId ?? 0),
    cipher: String(data.scy || data.security || 'auto'),
    type: String(data.net || data.network || 'tcp'),
    security: String(data.tls || 'none'),
    sni: String(data.sni || data.host || ''),
    host: String(data.host || ''),
    path: String(data.path || ''),
    serviceName: String(data.path || ''),
    alpn: String(data.alpn || ''),
    headerType: String(data.type || 'none'),
    fp: String(data.fp || ''),
  };
  return makeNode('vmess', address, port, String(data.ps || data.remarks || name || ''), params, uri);
}

function parseTrojan(uri) {
  const { body, query, name } = splitUri(uri);
  const at = body.lastIndexOf('@');
  if (at < 0) return null;
  const password = pctDecode(body.slice(0, at));
  const hp = hostPort(body.slice(at + 1), 443);
  if (!password || !hp) return null;
  return makeNode('trojan', hp.host, hp.port, name, { ...query, password }, uri);
}

function parseShadowsocks(uri) {
  const { body, query, name } = splitUri(uri);
  const at = body.lastIndexOf('@');
  let method = '';
  let password = '';
  let hp = null;
  if (at >= 0) {
    const creds = decodeCreds(body.slice(0, at));
    const colon = creds.indexOf(':');
    if (colon > 0) {
      method = creds.slice(0, colon);
      password = creds.slice(colon + 1);
    }
    hp = hostPort(body.slice(at + 1), 8388);
  } else {
    const decoded = tryBase64(body);
    if (!decoded) return null;
    const inner = splitUri(`ss://${decoded}`);
    const innerAt = inner.body.lastIndexOf('@');
    if (innerAt < 0) return null;
    const creds = inner.body.slice(0, innerAt);
    const colon = creds.indexOf(':');
    if (colon > 0) {
      method = creds.slice(0, colon);
      password = creds.slice(colon + 1);
    }
    hp = hostPort(inner.body.slice(innerAt + 1), 8388);
  }
  if (!method || !password || !hp) return null;
  return makeNode('ss', hp.host, hp.port, name, { ...query, method, password }, uri);
}

function parseSocks(uri) {
  const { body, query, name } = splitUri(uri);
  const at = body.lastIndexOf('@');
  let hp;
  let username = '';
  let password = '';
  if (at >= 0) {
    const creds = decodeCreds(body.slice(0, at));
    const colon = creds.indexOf(':');
    if (colon > 0) {
      username = creds.slice(0, colon);
      password = creds.slice(colon + 1);
    }
    hp = hostPort(body.slice(at + 1), 1080);
  } else {
    hp = hostPort(body, 1080);
  }
  if (!hp) return null;
  return makeNode('socks', hp.host, hp.port, name, { ...query, username, password }, uri);
}

function parse(raw) {
  const value = String(raw || '').trim();
  const schemeAt = value.indexOf('://');
  if (schemeAt < 0) return null;
  const scheme = value.slice(0, schemeAt).toLowerCase();
  if (scheme === 'vless') return parseVless(value);
  if (scheme === 'vmess') return parseVmess(value);
  if (scheme === 'trojan') return parseTrojan(value);
  if (scheme === 'ss') return parseShadowsocks(value);
  if (scheme === 'socks' || scheme === 'socks5') return parseSocks(value);
  if (scheme === 'hysteria2' || scheme === 'hy2') {
    const { body, query, name } = splitUri(value);
    const at = body.lastIndexOf('@');
    const hp = at >= 0 ? hostPort(body.slice(at + 1), 443) : null;
    if (!hp) return null;
    const node = makeNode('hysteria2', hp.host, hp.port, name, query, value);
    if (node) node.unsupported = true;
    return node;
  }
  return null;
}

/** Список share-ссылок из текста подписки (base64 или построчно). */
function parseList(text) {
  const value = String(text || '').trim();
  if (!value) return [];
  const decoded = value.includes('://') ? value : tryBase64(value) || value;
  const out = [];
  const seen = new Set();
  for (const line of decoded.split(/[\r\n]+/)) {
    const item = line.trim();
    if (!item || item.startsWith('#') || item.startsWith('//')) continue;
    const node = parse(item);
    if (!node || seen.has(node.raw)) continue;
    seen.add(node.raw);
    out.push(node);
  }
  return out;
}

function streamSettings(node) {
  const p = node.params || {};
  const network = String(p.type || p.net || 'tcp').toLowerCase();
  const security = String(p.security || 'none').toLowerCase();
  const settings = { network: network === 'httpupgrade' ? 'httpupgrade' : network };

  if (security === 'tls') {
    settings.security = 'tls';
    settings.tlsSettings = {
      serverName: p.sni || p.host || node.address,
      allowInsecure: p.allowInsecure === '1' || p.insecure === '1',
      fingerprint: p.fp || 'chrome',
    };
    if (p.alpn) settings.tlsSettings.alpn = String(p.alpn).split(',').map((v) => v.trim()).filter(Boolean);
  } else if (security === 'reality') {
    settings.security = 'reality';
    settings.realitySettings = {
      serverName: p.sni || p.host || node.address,
      fingerprint: p.fp || 'chrome',
      publicKey: p.pbk || '',
      shortId: p.sid || '',
      spiderX: p.spx || '',
    };
    if (p.alpn) settings.realitySettings.alpn = String(p.alpn).split(',').map((v) => v.trim()).filter(Boolean);
  } else {
    settings.security = 'none';
  }

  if (network === 'ws') {
    settings.wsSettings = {
      path: p.path || '/',
      headers: p.host ? { Host: p.host } : {},
    };
  } else if (network === 'grpc') {
    settings.grpcSettings = { serviceName: p.serviceName || p.path || '' };
  } else if (network === 'xhttp') {
    settings.xhttpSettings = {
      path: p.path || '/',
      host: p.host || '',
      mode: p.mode || 'auto',
    };
  } else if (network === 'httpupgrade') {
    settings.httpupgradeSettings = { path: p.path || '/', host: p.host || '' };
  } else if (network === 'tcp' && (p.headerType === 'http' || p.type === 'http')) {
    settings.tcpSettings = {
      header: {
        type: 'http',
        request: { path: [p.path || '/'], headers: p.host ? { Host: [p.host] } : {} },
      },
    };
  }
  return settings;
}

function outboundFor(node) {
  const p = node.params || {};
  if (node.protocol === 'vless') {
    return {
      protocol: 'vless',
      settings: {
        vnext: [{
          address: node.address,
          port: node.port,
          users: [{ id: p.id, encryption: p.encryption || 'none', flow: p.flow || '' }],
        }],
      },
      streamSettings: streamSettings(node),
    };
  }
  if (node.protocol === 'vmess') {
    return {
      protocol: 'vmess',
      settings: {
        vnext: [{
          address: node.address,
          port: node.port,
          users: [{ id: p.id, alterId: Number(p.alterId) || 0, security: p.cipher || 'auto' }],
        }],
      },
      streamSettings: streamSettings(node),
    };
  }
  if (node.protocol === 'trojan') {
    return {
      protocol: 'trojan',
      settings: {
        servers: [{ address: node.address, port: node.port, password: p.password || '' }],
      },
      streamSettings: streamSettings(node),
    };
  }
  if (node.protocol === 'ss') {
    return {
      protocol: 'shadowsocks',
      settings: {
        servers: [{
          address: node.address,
          port: node.port,
          method: p.method || 'aes-256-gcm',
          password: p.password || '',
        }],
      },
    };
  }
  return {
    protocol: 'socks',
    settings: {
      servers: [{
        address: node.address,
        port: node.port,
        ...(p.username ? { users: [{ user: p.username, pass: p.password || '' }] } : {}),
      }],
    },
  };
}

/** Конфиг xray: локальные socks/http инбаунды → выбранный узел. */
function buildConfig(node, { socksPort, httpPort }) {
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: 'socks-in',
        listen: '127.0.0.1',
        port: socksPort,
        protocol: 'socks',
        settings: { auth: 'noauth', udp: true },
      },
      {
        tag: 'http-in',
        listen: '127.0.0.1',
        port: httpPort,
        protocol: 'http',
        settings: { allowTransparent: false },
      },
    ],
    outbounds: [
      outboundFor(node),
      { protocol: 'direct', tag: 'direct' },
    ],
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        { type: 'field', ip: ['geoip:private'], outboundTag: 'direct' },
        { type: 'field', domain: ['localhost'], outboundTag: 'direct' },
      ],
    },
  };
}

module.exports = {
  SUPPORTED,
  PROTOCOL_LABELS,
  parse,
  parseList,
  buildConfig,
  tryBase64,
};
