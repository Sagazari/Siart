'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateChat, createRateLimiter, safeStaticPath, LIMITS: CHAT_LIMITS } = require('./lib');
const { createWorkspace, purgeIdle, WorkspaceError, LIMITS } = require('./workspace');
const { runAgent, createHealth } = require('./agent');
const { buildProviders, buildTiers, tierAvailable } = require('./providers');
const auth = require('./auth');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
};
const MAX_CHAT_BODY = 12 * 1024 * 1024;
const MAX_FILE_BODY = 700 * 1024;

function loadConfig(env = process.env) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const tiers = buildTiers(env, (tier, bad) => console.warn(JSON.stringify({ level: 'warn', event: 'invalid_tier_entry', tier, entry: bad })));
  const defaultTier = tiers[String(env.DEFAULT_TIER || '').toLowerCase()] ? String(env.DEFAULT_TIER).toLowerCase() : 'moyenne';
  return {
    port: num(env.PORT, 3000),
    providers: buildProviders(env),
    tiers,
    defaultTier,
    allowedOrigin: env.ALLOWED_ORIGIN || '',
    trustProxy: env.TRUST_PROXY === '1',
    rateMax: num(env.RATE_LIMIT_MAX, 20),
    rateWindowMs: num(env.RATE_LIMIT_WINDOW_MS, 60_000),
    apiRateMax: num(env.API_RATE_LIMIT_MAX, 240),
    timeoutMs: num(env.UPSTREAM_TIMEOUT_MS, 180_000),
    toolsEnabled: env.TOOLS_ENABLED !== '0',
    maxToolSteps: num(env.MAX_TOOL_STEPS, 6),
    dataDir: path.resolve(env.DATA_DIR || path.join(process.cwd(), 'data')),
    accessCode: env.ACCESS_CODE || '',
    retentionDays: num(env.RETENTION_DAYS, 30),
    maxConversations: Math.min(num(env.MAX_CONVERSATIONS, 30), 500),
    maxMessages: Math.min(num(env.MAX_MESSAGES_PER_CONVERSATION, 40), 200),
  };
}

const log = (obj) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));

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

async function readJson(req, res, limit) {
  let raw;
  try { raw = await readBody(req, limit); }
  catch (e) { sendJson(res, e.status || 400, { error: 'Corpo da requisição grande demais ou inválido.' }); return null; }
  try { return JSON.parse(raw); }
  catch { sendJson(res, 400, { error: 'JSON inválido.' }); return null; }
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-src 'self'; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

// Cabeçalhos da prévia: código do usuário roda em iframe sem acesso à origem da Siart.
function previewHeaders(res) {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy',
    "sandbox allow-scripts allow-forms; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; " +
    "img-src 'self' data: blob:; connect-src 'self'; form-action 'none'; base-uri 'self'; frame-ancestors 'self'");
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
}

function createServer(cfg = loadConfig()) {
  const chatLimiter = createRateLimiter({ max: cfg.rateMax, windowMs: cfg.rateWindowMs });
  const apiLimiter = createRateLimiter({ max: cfg.apiRateMax, windowMs: cfg.rateWindowMs });
  const loginLimiter = createRateLimiter({ max: 10, windowMs: 5 * 60_000 });
  const health = createHealth();
  const workspaces = new Map();
  const tokenToClient = new Map();
  const clientToToken = new Map();

  const getWs = (cid) => {
    if (workspaces.size > 2000) workspaces.clear(); // são apenas invólucros; o estado está em disco
    let w = workspaces.get(cid);
    if (!w) { w = createWorkspace(path.join(cfg.dataDir, 'clients', cid)); workspaces.set(cid, w); }
    return w;
  };
  const previewToken = (cid) => {
    let t = clientToToken.get(cid);
    if (!t) {
      if (tokenToClient.size > 5000) { tokenToClient.clear(); clientToToken.clear(); }
      t = crypto.randomBytes(16).toString('hex');
      clientToToken.set(cid, t); tokenToClient.set(t, cid);
    }
    return t;
  };

  const isHttps = (req) => Boolean(req.socket.encrypted) || (cfg.trustProxy && req.headers['x-forwarded-proto'] === 'https');
  const clientIp = (req) => {
    if (cfg.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      if (xff) return String(xff).split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  };
  const isAuthed = (req) => !cfg.accessCode || auth.safeEqual(auth.parseCookies(req.headers.cookie).siart_auth || '', auth.sessionValue(cfg.accessCode));

  function identify(req, res) {
    let cid = auth.parseCookies(req.headers.cookie).siart_cid;
    if (!auth.isClientId(cid)) {
      cid = auth.newClientId();
      auth.appendCookie(res, auth.serializeCookie('siart_cid', cid, { secure: isHttps(req) }));
    }
    return cid;
  }

  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (cfg.allowedOrigin && origin === cfg.allowedOrigin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  // ---------- Chat (SSE) ----------
  async function handleChat(req, res, cid) {
    const body = await readJson(req, res, MAX_CHAT_BODY);
    if (!body) return;
    const v = validateChat(body, { ...CHAT_LIMITS, maxMessages: cfg.maxMessages, maxTotalChars: 120000 });
    if (!v.ok) return sendJson(res, 400, { error: v.error });
    let tier = cfg.tiers[cfg.defaultTier];
    if (body.tier !== undefined) {
      tier = typeof body.tier === 'string' ? cfg.tiers[body.tier] : null;
      if (!tier) return sendJson(res, 400, { error: 'Nível de IA desconhecido.' });
    }
    if (!tierAvailable(tier, cfg.providers)) {
      return sendJson(res, 503, { error: `Nenhum provedor está configurado para ${tier.label}. Defina ao menos uma chave de API no servidor.` });
    }

    const taskId = crypto.randomUUID();
    let clientClosed = false;
    const ac = new AbortController();
    res.on('close', () => { clientClosed = true; ac.abort(); });
    const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    const send = (event, data = {}) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify({ taskId, ts: new Date().toISOString(), ...data })}\n\n`);
    };

    send('task.started', { tier: tier.id });
    try {
      await runAgent({ cfg, tier, messages: v.messages, userInstructions: typeof body.instructions === 'string' ? body.instructions.slice(0, 3000) : '', voice: body.voice === true, ws: cfg.toolsEnabled && tier.tools ? getWs(cid) : null, send, signal: ac.signal, log, taskId, health });
      send('message.completed');
      send('task.completed');
    } catch (err) {
      if (!clientClosed) {
        const timedOut = ac.signal.aborted;
        log({ level: 'error', event: 'chat_failure', taskId, tier: tier.id, reason: timedOut ? 'timeout' : (err.allFailed ? 'all_providers_failed' : err.upstreamStatus || err.name) });
        if (timedOut) send('task.failed', { code: 'timeout', message: 'A resposta demorou demais e foi interrompida.' });
        else if (err.allFailed) send('task.failed', {
          code: 'all_providers_failed', tried: err.tried || [],
          message: 'Nenhum provedor de IA conseguiu responder agora. Consulte os motivos de cada tentativa no histórico de execução do servidor.',
        });
        else send('task.failed', { code: 'upstream_error', message: 'A conexão com o provedor de IA foi interrompida. Tente novamente.' });
      }
    } finally {
      clearTimeout(timer);
      if (!res.writableEnded) res.end();
    }
  }

  // ---------- API de arquivos ----------
  async function handleFiles(req, res, pathname, url, cid) {
    const ws = getWs(cid);
    const qpath = url.searchParams.get('path') || '';
    const method = req.method;

    if (pathname === '/api/files' && method === 'GET') {
      const { files, dirs } = ws.list();
      return sendJson(res, 200, { files, dirs, usage: ws.usage(), limits: { maxFiles: LIMITS.maxFiles, maxFileBytes: LIMITS.maxFileBytes, maxTotalBytes: LIMITS.maxTotalBytes } });
    }
    if (pathname === '/api/file' && method === 'GET') return sendJson(res, 200, ws.read(qpath));
    if (pathname === '/api/file' && method === 'PUT') {
      const b = await readJson(req, res, MAX_FILE_BODY);
      if (!b) return;
      return sendJson(res, 200, ws.write(b.path, b.content));
    }
    if (pathname === '/api/file' && method === 'DELETE') return sendJson(res, 200, ws.remove(qpath));
    if (pathname === '/api/file/rename' && method === 'POST') {
      const b = await readJson(req, res, 4096);
      if (!b) return;
      return sendJson(res, 200, ws.rename(b.from, b.to));
    }
    if (pathname === '/api/dir' && method === 'POST') {
      const b = await readJson(req, res, 4096);
      if (!b) return;
      return sendJson(res, 200, ws.mkdir(b.path));
    }
    if (pathname === '/api/changes' && method === 'GET') return sendJson(res, 200, { changes: ws.changes() });
    if (pathname === '/api/project' && method === 'DELETE') { ws.destroy(); workspaces.delete(cid); return sendJson(res, 200, { ok: true }); }
    if (pathname === '/api/preview-url' && method === 'GET') return sendJson(res, 200, { url: `/preview/${previewToken(cid)}/` });

    if (pathname === '/api/export.zip' && method === 'GET') {
      const zip = ws.exportZip();
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zip.length, 'Content-Disposition': 'attachment; filename="siart-projeto.zip"' });
      return res.end(zip);
    }
    if (pathname === '/api/download' && method === 'GET') {
      const { path: p, buf } = ws.readRaw(qpath);
      const name = encodeURIComponent(path.basename(p));
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', 'Content-Length': buf.length,
        'Content-Disposition': `attachment; filename*=UTF-8''${name}`, 'Content-Security-Policy': 'sandbox',
      });
      return res.end(buf);
    }
    return sendJson(res, 404, { error: 'Não encontrado.' });
  }

  // ---------- Prévia isolada ----------
  function handlePreview(req, res, pathname) {
    const m = pathname.match(/^\/preview\/([a-f0-9]{32})\/(.*)$/);
    const cid = m && tokenToClient.get(m[1]);
    if (!cid) return sendJson(res, 404, { error: 'Prévia não encontrada. Atualize a prévia no painel.' });
    previewHeaders(res);
    let rel = m[2];
    try { rel = decodeURIComponent(rel); } catch { return sendJson(res, 400, { error: 'Caminho inválido.' }); }
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    try {
      const { path: p, buf } = getWs(cid).readRaw(rel);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', 'Content-Length': buf.length });
      res.end(req.method === 'HEAD' ? undefined : buf);
    } catch (e) {
      if (e instanceof WorkspaceError) return sendJson(res, e.status === 404 ? 404 : 400, { error: e.status === 404 ? 'Arquivo não encontrado no projeto.' : e.message });
      throw e;
    }
  }

  async function handleStatic(req, res, pathname) {
    const full = safeStaticPath(PUBLIC_DIR, pathname);
    if (!full) return sendJson(res, 400, { error: 'Caminho inválido.' });
    try {
      const real = await fs.promises.realpath(full);
      if (!real.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'Não encontrado.' });
      const data = await fs.promises.readFile(real);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(real)] || 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
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
      const url = new URL(req.url, 'http://localhost');
      const { pathname } = url;

      if (cfg.allowedOrigin && req.headers.origin === cfg.allowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', cfg.allowedOrigin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

      if (pathname === '/health') return sendJson(res, 200, { status: 'ok' });
      if (pathname.startsWith('/preview/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Método não permitido.' });
        return handlePreview(req, res, pathname);
      }

      if (pathname.startsWith('/api/')) {
        const authed = isAuthed(req);
        if (pathname === '/api/status' && req.method === 'GET') {
          const tiers = Object.values(cfg.tiers).map((t) => ({
            id: t.id, name: t.name, version: t.version, label: t.label, description: t.description,
            available: tierAvailable(t, cfg.providers), tools: cfg.toolsEnabled && t.tools,
            providers: [...new Set(t.chain.filter((c) => cfg.providers[c.provider].apiKey).map((c) => cfg.providers[c.provider].name))],
          }));
          return sendJson(res, 200, {
            ready: tiers.some((t) => t.available), locked: !authed, tools: cfg.toolsEnabled, tiers, defaultTier: cfg.defaultTier,
            limits: { maxConversations: cfg.maxConversations, maxMessages: cfg.maxMessages },
          });
        }
        if (req.method !== 'GET' && !originAllowed(req)) return sendJson(res, 403, { error: 'Origem não permitida.' });

        if (pathname === '/api/login' && req.method === 'POST') {
          const rl = loginLimiter.check(clientIp(req));
          if (!rl.allowed) return sendJson(res, 429, { error: 'Muitas tentativas. Aguarde alguns minutos.' }, { 'Retry-After': String(rl.retryAfter) });
          const b = await readJson(req, res, 2048);
          if (!b) return;
          if (!cfg.accessCode || typeof b.code !== 'string' || !auth.safeEqual(b.code, cfg.accessCode)) return sendJson(res, 401, { error: 'Código de acesso incorreto.' });
          auth.appendCookie(res, auth.serializeCookie('siart_auth', auth.sessionValue(cfg.accessCode), { secure: isHttps(req) }));
          return sendJson(res, 200, { ok: true });
        }

        if (!authed) return sendJson(res, 401, { error: 'Acesso restrito. Informe o código de acesso.', code: 'auth_required' });
        const cid = identify(req, res);
        const ip = clientIp(req);

        if (pathname === '/api/chat') {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'Método não permitido.' }, { Allow: 'POST' });
          const rl = chatLimiter.check(ip);
          if (!rl.allowed) return sendJson(res, 429, { error: 'Muitas requisições. Aguarde um pouco.' }, { 'Retry-After': String(rl.retryAfter) });
          return await handleChat(req, res, cid);
        }
        const rl = apiLimiter.check(ip);
        if (!rl.allowed) return sendJson(res, 429, { error: 'Muitas requisições. Aguarde um pouco.' }, { 'Retry-After': String(rl.retryAfter) });
        try { return await handleFiles(req, res, pathname, url, cid); }
        catch (e) {
          if (e instanceof WorkspaceError) return sendJson(res, e.status, { error: e.message });
          throw e;
        }
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
  server.on('close', () => { chatLimiter.stop(); apiLimiter.stop(); loginLimiter.stop(); });
  return server;
}

// Aviso (não bloqueante) se algum modelo configurado não aparece na lista do provedor.
async function checkModels(cfg) {
  for (const p of Object.values(cfg.providers)) {
    if (!p.apiKey) continue;
    try {
      const r = await fetch(`${p.baseUrl}/models`, { headers: { Authorization: `Bearer ${p.apiKey}` }, signal: AbortSignal.timeout(6000) });
      if (!r.ok) { log({ level: 'warn', event: 'model_check_failed', provider: p.id, status: r.status }); continue; }
      const data = await r.json();
      const known = new Set();
      for (const m of data.data || data.models || []) {
        for (const id of [m.id, m.name, ...(m.aliases || [])]) if (id) known.add(String(id).replace(/^models\//, ''));
      }
      for (const t of Object.values(cfg.tiers)) {
        for (const c of t.chain) if (c.provider === p.id && !known.has(c.model)) log({ level: 'warn', event: 'model_not_listed', provider: p.id, model: c.model, tier: t.id });
      }
    } catch {
      log({ level: 'warn', event: 'model_check_failed', provider: p.id });
    }
  }
}

if (require.main === module) {
  const cfg = loadConfig();
  const server = createServer(cfg);
  const purge = () => {
    const n = purgeIdle(path.join(cfg.dataDir, 'clients'), cfg.retentionDays * 86_400_000);
    if (n) log({ event: 'retention_purge', removed: n });
  };
  server.listen(cfg.port, '0.0.0.0', () => {
    const configured = Object.values(cfg.providers).filter((p) => p.apiKey).map((p) => p.id);
    log({ event: 'listening', port: cfg.port, providers: configured, tools: cfg.toolsEnabled, locked: Boolean(cfg.accessCode), dataDir: cfg.dataDir });
    if (!configured.length) log({ level: 'warn', event: 'no_providers', message: 'Nenhuma chave de API definida (GROQ_API_KEY, GEMINI_API_KEY, MISTRAL_API_KEY ou OPENROUTER_API_KEY); o chat responderá 503.' });
    if (!cfg.accessCode) log({ level: 'warn', event: 'no_access_code', message: 'ACCESS_CODE não definido: qualquer pessoa com o link pode usar o chat e gastar sua cota da Groq.' });
    checkModels(cfg);
    purge();
    setInterval(purge, 86_400_000).unref();
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
