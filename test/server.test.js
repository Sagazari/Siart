'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { validateChat, createRateLimiter, safeStaticPath } = require('../src/lib');
const os = require('node:os');
const fsx = require('node:fs');
const pathx = require('node:path');
const { createServer, loadConfig: baseConfig } = require('../src/server');
const TMP = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'siart-t1-'));
const loadConfig = (env) => ({ ...baseConfig(env), dataDir: TMP });
test.after(() => fsx.rmSync(TMP, { recursive: true, force: true }));

// ---------- lib ----------


test('mensagem multimodal com imagem é validada', () => {
  const { validateChat } = require('../src/lib');
  const result = validateChat({ messages: [
    { role: 'user', content: [
      { type: 'text', text: 'O que aparece nesta foto?' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,Zm9v' } },
    ] },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.messages[0].content[1].type, 'image_url');
});

test('imagem com esquema ou formato inválido é recusada', () => {
  const { validateChat } = require('../src/lib');
  const result = validateChat({ messages: [
    { role: 'user', content: [
      { type: 'image_url', image_url: { url: 'javascript:alert(1)' } },
    ] },
  ] });
  assert.equal(result.ok, false);
});

test('histórico com resposta longa do assistente não bloqueia novas mensagens', () => {
  const { validateChat } = require('../src/lib');
  const result = validateChat({ messages: [
    { role: 'user', content: 'Oi' },
    { role: 'assistant', content: 'x'.repeat(12000) },
    { role: 'user', content: 'Tudo bem?' },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.messages[1].content.length, 8000);
  assert.equal(result.messages[2].content, 'Tudo bem?');
});

test('mensagem nova do usuário acima de 8.000 caracteres continua sendo recusada', () => {
  const { validateChat } = require('../src/lib');
  const result = validateChat({ messages: [{ role: 'user', content: 'x'.repeat(8001) }] });
  assert.equal(result.ok, false);
  assert.match(result.error, /8000/);
});

test('validateChat aceita conversa válida e remove espaços', () => {
  const r = validateChat({ messages: [{ role: 'user', content: '  oi  ' }] });
  assert.equal(r.ok, true);
  assert.equal(r.messages[0].content, 'oi');
});

test('validateChat rejeita formatos inválidos', () => {
  assert.equal(validateChat(null).ok, false);
  assert.equal(validateChat({ messages: [] }).ok, false);
  assert.equal(validateChat({ messages: [{ role: 'system', content: 'x' }] }).ok, false);
  assert.equal(validateChat({ messages: [{ role: 'user', content: '   ' }] }).ok, false);
  assert.equal(validateChat({ messages: [{ role: 'user', content: 42 }] }).ok, false);
  assert.equal(validateChat({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }).ok, false);
});

test('validateChat aplica limites de tamanho', () => {
  assert.equal(validateChat({ messages: [{ role: 'user', content: 'a'.repeat(8001) }] }).ok, false);
  const many = Array.from({ length: 41 }, () => ({ role: 'user', content: 'a' }));
  assert.equal(validateChat({ messages: many }).ok, false);
});

test('safeStaticPath bloqueia path traversal', () => {
  const root = '/srv/public';
  assert.equal(safeStaticPath(root, '/../secret'), null);
  assert.equal(safeStaticPath(root, '/%2e%2e/secret'), null);
  assert.equal(safeStaticPath(root, '/a/..%2f..%2fsecret'), null);
  assert.equal(safeStaticPath(root, '/a\\..\\b'), null);
  assert.equal(safeStaticPath(root, '/a%00.html'), null);
  assert.equal(safeStaticPath(root, '/'), '/srv/public/index.html');
  assert.equal(safeStaticPath(root, '/app.js'), '/srv/public/app.js');
});

test('rate limiter bloqueia acima do limite', () => {
  const rl = createRateLimiter({ max: 2, windowMs: 60_000 });
  assert.equal(rl.check('ip').allowed, true);
  assert.equal(rl.check('ip').allowed, true);
  const third = rl.check('ip');
  assert.equal(third.allowed, false);
  assert.ok(third.retryAfter >= 1);
  assert.equal(rl.check('outro').allowed, true);
  rl.stop();
});

// ---------- servidor com provedor simulado ----------
function startMock(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });

function sseChunks(res, parts) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const p of parts) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

async function parseEvents(res) {
  const text = await res.text();
  return text.split('\n\n').filter(Boolean).map((b) => {
    const event = b.match(/^event: (.+)$/m)[1];
    const data = JSON.parse(b.match(/^data: (.+)$/m)[1]);
    return { event, data };
  });
}

const post = (port, body, headers = {}) => fetch(`http://127.0.0.1:${port}/api/chat`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const userMsg = { messages: [{ role: 'user', content: 'Olá' }] };

test('chat transmite eventos estruturados e envia a chave só ao provedor', async () => {
  let seen;
  const mock = await startMock((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      seen = { auth: req.headers.authorization, body: JSON.parse(b) };
      sseChunks(res, ['Olá', ', mundo']);
    });
  });
  const mockPort = mock.address().port;
  const server = createServer(loadConfig({ GROQ_API_KEY: 'gsk_teste', GROQ_BASE_URL: `http://127.0.0.1:${mockPort}/v1` }));
  const port = await listen(server);

  const res = await post(port, userMsg);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const events = await parseEvents(res);
  const names = events.map((e) => e.event);
  assert.deepEqual(names, ['task.started', 'model.selected', 'message.delta', 'message.delta', 'message.completed', 'task.completed']);
  assert.equal(events.filter((e) => e.event === 'message.delta').map((e) => e.data.text).join(''), 'Olá, mundo');
  assert.ok(events.every((e) => e.data.taskId && e.data.ts));
  assert.equal(seen.auth, 'Bearer gsk_teste');
  assert.equal(seen.body.stream, true);
  assert.equal(seen.body.messages[0].role, 'system');
  assert.equal(seen.body.messages[1].content, 'Olá');
  assert.ok(!JSON.stringify(events).includes('gsk_teste'));

  await close(server); await close(mock);
});

test('chat devolve task.failed amigável sem vazar detalhes do provedor', async () => {
  const mock = await startMock((req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"segredo-interno"}'); });
  const server = createServer(loadConfig({ GROQ_API_KEY: 'k', GROQ_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1` }));
  const port = await listen(server);

  const events = await parseEvents(await post(port, userMsg));
  const failed = events.find((e) => e.event === 'task.failed');
  assert.ok(failed);
  assert.equal(failed.data.code, 'all_providers_failed');
  assert.deepEqual(failed.data.tried, [{ provider: 'groq', reason: 'auth' }]);
  assert.ok(!JSON.stringify(failed).includes('segredo-interno'));

  await close(server); await close(mock);
});

test('chat responde 503 sem GROQ_API_KEY e 400 para entrada inválida', async () => {
  const server = createServer(loadConfig({}));
  const port = await listen(server);
  assert.equal((await post(port, userMsg)).status, 503);
  assert.equal((await post(port, { messages: 'x' })).status, 400);
  const bad = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', body: '{nao-json' });
  assert.equal(bad.status, 400);
  await close(server);
});

test('chat aplica rate limit e bloqueia origem externa', async () => {
  const server = createServer(loadConfig({ RATE_LIMIT_MAX: '2' }));
  const port = await listen(server);
  assert.equal((await post(port, userMsg, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(port, userMsg)).status, 503);
  assert.equal((await post(port, userMsg)).status, 503);
  const limited = await post(port, userMsg);
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('retry-after'));
  await close(server);
});

test('health, status, estáticos e cabeçalhos de segurança', async () => {
  const server = createServer(loadConfig({ GROQ_API_KEY: 'k' }));
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const st = await (await fetch(`${base}/api/status`)).json();
  assert.equal(st.ready, true);
  assert.equal(st.locked, false);

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(index.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff');

  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/nao-existe.js`)).status, 404);
  const trav = await fetch(`${base}/..%2fpackage.json`);
  assert.ok([400, 404].includes(trav.status));
  assert.ok(!(await trav.text()).includes('"scripts"'));
  await close(server);
});
