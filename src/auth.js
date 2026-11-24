'use strict';
const crypto = require('node:crypto');

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function serializeCookie(name, value, { secure = false, maxAge = 31536000 } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function appendCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, cookie) : cookie);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const newClientId = () => crypto.randomBytes(16).toString('hex');
const isClientId = (v) => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);

// Valor do cookie de sessão derivado do código de acesso (estável entre reinicializações).
const sessionValue = (code) => sha256(`siart-auth-v1:${code}`).toString('hex');

function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(String(a)), sha256(String(b)));
}

module.exports = { parseCookies, serializeCookie, appendCookie, newClientId, isClientId, sessionValue, safeEqual };
