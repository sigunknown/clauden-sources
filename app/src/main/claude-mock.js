'use strict';

/**
 * Тестовый Claude-мост для разработки (`electron . --mock-claude`).
 * В собранное приложение не попадает: main.js включает его только когда
 * приложение не упаковано и передан флаг.
 */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class MockClaudeSession {
  constructor() {
    this.meta = {
      linked: true,
      email: 'mock@claude.ai',
      name: 'Mock Claude',
      plan: 'pro',
      orgId: 'mock-org',
      linkedAt: Date.now(),
      lastOkAt: Date.now(),
    };
    this.ses = null;
    this.clientInstance = {
      stream: (request) => this.stream(request),
    };
  }

  status() {
    return { ...this.meta };
  }

  desktopStatus() {
    return {
      supported: true,
      installed: true,
      exePath: 'C:\\Users\\Mock\\AppData\\Local\\AnthropicClaude\\claude.exe',
      dataDir: 'C:\\Users\\Mock\\AppData\\Roaming\\Claude',
      cookieDb: 'C:\\Users\\Mock\\AppData\\Roaming\\Claude\\Network\\Cookies',
      running: false,
      cookieCount: 3,
      hasSessionKey: true,
    };
  }

  async importFromDesktop() {
    this.meta = { ...this.meta, source: 'desktop', desktopImportedAt: Date.now() };
    return { ...this.meta };
  }

  login() {
    return { ...this.meta };
  }

  logout() {
    return { linked: false };
  }

  refresh() {
    return { ...this.meta };
  }

  models() {
    return {
      data: [
        { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
        { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
        { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
      ],
    };
  }

  download() {
    return null;
  }

  listConversations() {
    return [];
  }

  importConversation() {
    return null;
  }

  async stream({ signal, onConversation, onDelta }) {
    const conversationId = `mock-${Date.now().toString(36)}`;
    onConversation(conversationId);
    let text = '';
    for (const part of ['Привет', '! Это ', 'тестовый ответ ', 'Claude-режима.']) {
      if (signal?.aborted) return text;
      await delay(280);
      text += part;
      onDelta(part);
    }
    if (signal?.aborted) return text;
    await delay(400);
    const artifact = '<artifact identifier="mock-card" type="text/html" title="Тестовая карточка">\n<h1>Claude</h1>\n<p>Артефакт из mock-режима.</p>\n</artifact>';
    return `${text}\n\n${artifact}`;
  }
}

module.exports = { MockClaudeSession };
