'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SYSTEM_PROMPT } = require('./systemPrompt');
const { validateChat, createRateLimiter, safeStaticPath } = require('./lib');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};
const MAX_BODY = 256 * 1024;

function loadConfig(env = process.env) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    port: num(env.PORT, 3000),
    apiKey: env.GROQ_API_KEY || '',
    model: env.GROQ_MODEL || 'openai/gpt-oss-120b',
    baseUrl: (env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
    allowedOrigin: env.ALLOWED_ORIGIN || '',
    trustProxy: env.TRUST_PROXY === '1',
    rateMax: num(env.RATE_LIMIT_MAX, 20),
    rateWindowMs: num(env.RATE_LIMIT_WINDOW_MS, 60_000),
    timeoutMs: num(env.UPSTREAM_TIMEOUT_MS, 90_000),
    maxTokens: num(env.MAX_COMPLETION_TOKENS, 4096),
  };
}

const log = (obj) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));

function friendlyUpstreamError(status) {
  if (status === 401 || status === 403) return 'O provedor não aceitou a chave de API. Verifique GROQ_API_KEY no servidor.';
  if (status === 400 || status === 404) return 'O modelo configurado não está disponível ou a requisição foi rejeitada. Verifique GROQ_MODEL.';
  if (status === 429) return 'O limite do provedor de IA foi atingido. Tente novamente em instantes.';
  return 'O provedor de IA retornou um erro. Tente novamente.';
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

function createServer(cfg = loadConfig()) {
  const limiter = createRateLimiter({ max: cfg.rateMax, windowMs: cfg.rateWindowMs });

  const clientIp = (req) => {
    if (cfg.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      if (xff) return String(xff).split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  };

  // Bloqueia requisições de outras origens, salvo a origem explicitamente permitida.
  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (cfg.allowedOrigin && origin === cfg.allowedOrigin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  async function handleChat(req, res) {
    let raw;
    try { raw = await readBody(req, MAX_BODY); }
    catch (e) { return sendJson(res, e.status || 400, { error: 'Corpo da requisição grande demais ou inválido.' }); }
    let body;
    try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { error: 'JSON inválido.' }); }
    const v = validateChat(body);
    if (!v.ok) return sendJson(res, 400, { error: v.error });
    if (!cfg.apiKey) return sendJson(res, 503, { error: 'Servidor sem configuração: defina GROQ_API_KEY.' });

    const taskId = crypto.randomUUID();
    let clientClosed = false;
    const ac = new AbortController();
    res.on('close', () => { clientClosed = true; ac.abort(); });
    const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event, data = {}) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify({ taskId, ts: new Date().toISOString(), ...data })}\n\n`);
    };

    send('task.started');
    try {
      const upstream = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: ac.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          stream: true,
          temperature: 0.4,
          max_completion_tokens: cfg.maxTokens,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...v.messages],
        }),
      });
      if (!upstream.ok) {
        log({ level: 'error', event: 'upstream_status', status: upstream.status, taskId });
        send('task.failed', { code: `upstream_${upstream.status}`, message: friendlyUpstreamError(upstream.status) });
        return;
      }
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of upstream.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const text = JSON.parse(data).choices?.[0]?.delta?.content;
            if (text) send('message.delta', { text });
          } catch { /* linha parcial ou evento sem conteúdo */ }
        }
      }
      send('message.completed');
      send('task.completed');
    } catch (err) {
      if (!clientClosed) {
        const timedOut = ac.signal.aborted;
        log({ level: 'error', event: 'upstream_failure', taskId, reason: timedOut ? 'timeout' : err.name });
        send('task.failed', {
          code: timedOut ? 'timeout' : 'upstream_error',
          message: timedOut ? 'A resposta demorou demais e foi interrompida.' : 'Não foi possível falar com o provedor de IA. Tente novamente.',
        });
      }
    } finally {
      clearTimeout(timer);
      if (!res.writableEnded) res.end();
    }
  }

  async function handleStatic(req, res, pathname) {
    const full = safeStaticPath(PUBLIC_DIR, pathname);
    if (!full) return sendJson(res, 400, { error: 'Caminho inválido.' });
    try {
      const real = await fs.promises.realpath(full);
      if (!real.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'Não encontrado.' });
      const data = await fs.promises.readFile(real);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(real)] || 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      sendJson(res, 404, { error: 'Não encontrado.' });
    }
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const requestId = crypto.randomUUID().slice(0, 8);
    securityHeaders(res);
    res.setHeader('X-Request-Id', requestId);
    res.on('finish', () => log({ event: 'request', requestId, method: req.method, path: req.url.split('?')[0], status: res.statusCode, ms: Date.now() - started }));

    try {
      const { pathname } = new URL(req.url, 'http://localhost');

      if (cfg.allowedOrigin && req.headers.origin === cfg.allowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', cfg.allowedOrigin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

      if (pathname === '/health') return sendJson(res, 200, { status: 'ok' });
      if (pathname === '/api/status' && req.method === 'GET') return sendJson(res, 200, { ready: Boolean(cfg.apiKey) });

      if (pathname === '/api/chat') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Método não permitido.' }, { Allow: 'POST' });
        if (!originAllowed(req)) return sendJson(res, 403, { error: 'Origem não permitida.' });
        const rl = limiter.check(clientIp(req));
        if (!rl.allowed) return sendJson(res, 429, { error: 'Muitas requisições. Aguarde um pouco.' }, { 'Retry-After': String(rl.retryAfter) });
        return await handleChat(req, res);
      }

      if (req.method === 'GET' || req.method === 'HEAD') return await handleStatic(req, res, pathname);
      return sendJson(res, 405, { error: 'Método não permitido.' });
    } catch (err) {
      log({ level: 'error', event: 'unhandled', requestId, message: err.message });
      if (!res.headersSent) sendJson(res, 500, { error: 'Erro interno.' });
      else res.end();
    }
  });
  server.keepAliveTimeout = 65_000;
  server.on('close', () => limiter.stop());
  return server;
}

// Aviso (não bloqueante) se o modelo configurado não aparece na lista ativa do provedor.
async function checkModel(cfg) {
  if (!cfg.apiKey) return log({ level: 'warn', event: 'missing_api_key', message: 'GROQ_API_KEY não definida; o chat responderá 503.' });
  try {
    const r = await fetch(`${cfg.baseUrl}/models`, { headers: { Authorization: `Bearer ${cfg.apiKey}` }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return log({ level: 'warn', event: 'model_check_failed', status: r.status });
    const ids = ((await r.json()).data || []).map((m) => m.id);
    if (!ids.includes(cfg.model)) log({ level: 'warn', event: 'model_not_listed', model: cfg.model });
    else log({ event: 'model_ok', model: cfg.model });
  } catch {
    log({ level: 'warn', event: 'model_check_failed' });
  }
}

if (require.main === module) {
  const cfg = loadConfig();
  const server = createServer(cfg);
  server.listen(cfg.port, '0.0.0.0', () => {
    log({ event: 'listening', port: cfg.port, model: cfg.model });
    checkModel(cfg);
  });
  const shutdown = () => {
    log({ event: 'shutdown' });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer, loadConfig };
