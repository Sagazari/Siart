'use strict';
const path = require('node:path');

const LIMITS = { maxMessages: 40, maxMessageChars: 8000, maxTotalChars: 60000 };

function validateChat(body, limits = LIMITS) {
  const fail = (error) => ({ ok: false, error });
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    return fail('Formato inválido: envie { "messages": [...] }.');
  }
  const { messages } = body;
  if (messages.length === 0 || messages.length > limits.maxMessages) {
    return fail(`A conversa deve ter entre 1 e ${limits.maxMessages} mensagens.`);
  }
  let total = 0;
  const clean = [];
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || !(typeof m.content === 'string' || Array.isArray(m.content))) {
      return fail('Cada mensagem precisa de role (user ou assistant) e conteúdo válido.');
    }
    let content = m.content;
    if (typeof content === 'string') {
      content = content.trim();
      if (!content) return fail('Mensagens vazias não são permitidas.');
      if (content.length > limits.maxMessageChars) return fail(`Cada mensagem pode ter até ${limits.maxMessageChars} caracteres.`);
      total += content.length;
    } else {
      if (m.role !== 'user' || content.length > 6) return fail('Anexos inválidos.');
      const cleanParts = [];
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.length <= limits.maxMessageChars) { total += part.text.length; cleanParts.push({ type: 'text', text: part.text }); }
        else if (part?.type === 'image_url' && typeof part.image_url?.url === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(part.image_url.url) && part.image_url.url.length <= 5_500_000) cleanParts.push({ type: 'image_url', image_url: { url: part.image_url.url } });
        else return fail('Tipo de anexo não suportado ou arquivo grande demais.');
      }
      content = cleanParts;
    }
    if (total > limits.maxTotalChars) return fail('A conversa ficou longa demais. Inicie uma nova conversa.');
    clean.push({ role: m.role, content });
  }
  if (total > limits.maxTotalChars) return fail('A conversa ficou longa demais. Inicie uma nova conversa.');
  if (clean[clean.length - 1].role !== 'user') return fail('A última mensagem deve ser do usuário.');
  return { ok: true, messages: clean };
}

function createRateLimiter({ max, windowMs }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, v] of hits) if (v.reset <= now) hits.delete(key);
  }, windowMs);
  timer.unref();
  return {
    check(key) {
      const now = Date.now();
      let v = hits.get(key);
      if (!v || v.reset <= now) {
        v = { count: 0, reset: now + windowMs };
        hits.set(key, v);
      }
      v.count += 1;
      return { allowed: v.count <= max, retryAfter: Math.max(1, Math.ceil((v.reset - now) / 1000)) };
    },
    stop() { clearInterval(timer); },
  };
}

// Resolve um caminho de URL dentro de root. Retorna null se houver tentativa de escapar.
function safeStaticPath(root, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

module.exports = { LIMITS, validateChat, createRateLimiter, safeStaticPath };
