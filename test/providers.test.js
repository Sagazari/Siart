'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseChain, buildTiers, buildProviders, tierAvailable } = require('../src/providers');
const { createServer, loadConfig } = require('../src/server');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'siart-t3-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ---------- helpers ----------
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = (s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); });
// Provedor simulado: handler(body, req, res) responde; guarda as requisições recebidas.
async function provider(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = b ? JSON.parse(b) : {};
      hits.push(body);
      handler(body, req, res, hits.length);
    });
  });
  const port = await listen(server);
  return { server, hits, url: `http://127.0.0.1:${port}/v1` };
}
const ok = (res, parts) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const p of parts) res.write(`data: ${JSON.stringify({ choices: [{ delta: typeof p === 'string' ? { content: p } : p }] })}\n\n`);
  res.end('data: [DONE]\n\n');
};
const fail = (status, extra = {}) => (body, req, res) => { res.writeHead(status, { 'Content-Type': 'application/json', ...extra }); res.end('{"error":"interno-secreto"}'); };
const startApp = async (env) => {
  const server = createServer(loadConfig({ DATA_DIR: fs.mkdtempSync(path.join(TMP, 'd-')), ...env }));
  return { server, port: await listen(server) };
};
const chat = (port, body = {}) => fetch(`http://127.0.0.1:${port}/api/chat`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'oi' }], ...body }),
});
async function events(res) {
  return (await res.text()).split('\n\n').filter(Boolean).map((b) => ({ event: b.match(/^event: (.+)$/m)[1], data: JSON.parse(b.match(/^data: (.+)$/m)[1]) }));
}
const names = (ev) => ev.map((e) => e.event);
const text = (ev) => ev.filter((e) => e.event === 'message.delta').map((e) => e.data.text).join('');
const toolCall = (id, name, args) => [{ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] }];

// ---------- configuração ----------
test('parseChain aceita modelos com ":" e ignora entradas inválidas', () => {
  const bad = [];
  const chain = parseChain(' groq:openai/gpt-oss-120b , openrouter:qwen/qwen3-coder:free,xxx:modelo,gemini:,semdoispontos', (b) => bad.push(b));
  assert.deepEqual(chain, [{ provider: 'groq', model: 'openai/gpt-oss-120b' }, { provider: 'openrouter', model: 'qwen/qwen3-coder:free' }]);
  assert.equal(bad.length, 3);
});

test('níveis têm nomes, versões e cadeias padrão; TIER_* sobrescreve; disponibilidade segue as chaves', () => {
  const tiers = buildTiers({});
  assert.deepEqual(Object.values(tiers).map((t) => t.label), ['Absoluty GTI 1.2', 'Moyenne 1', 'Basse 0.1']);
  assert.equal(tiers.basse.tools, false);
  assert.equal(tiers.absoluty.tools, true);
  assert.ok(Object.values(tiers).every((t) => new Set(t.chain.map((c) => c.provider)).size === 5));
  const custom = buildTiers({ TIER_BASSE: 'mistral:mistral-small-latest', TIER_BASSE_TOOLS: '1', TIER_MOYENNE_FIRST_BYTE_MS: '500' });
  assert.deepEqual(custom.basse.chain, [{ provider: 'mistral', model: 'mistral-small-latest' }]);
  assert.equal(custom.basse.tools, true);
  assert.equal(custom.moyenne.firstByteMs, 500);
  assert.deepEqual(buildTiers({ TIER_BASSE: 'lixo' }).basse.chain, buildTiers({}).basse.chain); // cadeia inválida volta ao padrão

  const only = buildProviders({ GEMINI_API_KEY: 'g' });
  assert.equal(tierAvailable(tiers.moyenne, only), true);
  assert.equal(tierAvailable(custom.basse, only), false);
  assert.equal(buildProviders({ GOOGLE_API_KEY: 'g' }).gemini.apiKey, 'g');
  assert.equal(buildProviders({}).gemini.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
});

test('/api/status lista níveis, provedores configurados (sem chaves) e limites', async () => {
  const { server, port } = await startApp({ GROQ_API_KEY: 'gsk_secreta', MISTRAL_API_KEY: 'mk_secreta', MAX_CONVERSATIONS: '12', MAX_MESSAGES_PER_CONVERSATION: '10' });
  try {
    const raw = await (await fetch(`http://127.0.0.1:${port}/api/status`)).text();
    assert.ok(!raw.includes('secreta'));
    const st = JSON.parse(raw);
    assert.equal(st.ready, true);
    assert.equal(st.defaultTier, 'moyenne');
    assert.deepEqual(st.limits, { maxConversations: 12, maxMessages: 10 });
    assert.deepEqual(st.tiers.map((t) => t.label), ['Absoluty GTI 1.2', 'Moyenne 1', 'Basse 0.1']);
    assert.deepEqual(st.tiers.find((t) => t.id === 'moyenne').providers.sort(), ['Groq', 'Mistral']);
    assert.equal(st.tiers.find((t) => t.id === 'basse').tools, false);
  } finally { await close(server); }
  const none = await startApp({});
  try {
    assert.equal((await (await fetch(`http://127.0.0.1:${none.port}/api/status`)).json()).ready, false);
    assert.equal((await chat(none.port)).status, 503);
  } finally { await close(none.server); }
});

// ---------- níveis na requisição ----------
test('cada nível usa seu modelo, esforço, limite de tokens e ferramentas', async () => {
  const g = await provider((b, q, res) => ok(res, ['ok']));
  const { server, port } = await startApp({ GROQ_API_KEY: 'k', GROQ_BASE_URL: g.url });
  try {
    for (const t of ['absoluty', 'moyenne', 'basse']) await (await chat(port, { tier: t })).text();
    const [abs, moy, bas] = g.hits;
    assert.equal(abs.model, 'openai/gpt-oss-120b'); assert.equal(abs.reasoning_effort, 'high'); assert.equal(abs.max_completion_tokens, 8192); assert.ok(abs.tools);
    assert.equal(moy.reasoning_effort, 'medium'); assert.equal(moy.max_completion_tokens, 4096); assert.ok(moy.tools);
    assert.equal(bas.model, 'openai/gpt-oss-20b'); assert.equal(bas.reasoning_effort, 'low'); assert.equal(bas.max_completion_tokens, 2048);
    assert.equal(bas.tools, undefined);
    assert.ok(!bas.messages[0].content.includes('ferramentas para trabalhar no projeto'));
    assert.equal((await chat(port, { tier: 'nao-existe' })).status, 400);
    assert.equal((await chat(port, { tier: 42 })).status, 400);
  } finally { await close(server); await close(g.server); }
});

test('cada provedor recebe os parâmetros certos (max_tokens, effort, X-Title)', async () => {
  const gem = await provider((b, q, res) => ok(res, ['ok']));
  const or = await provider((b, q, res) => ok(res, ['ok']));
  let orHeaders;
  or.server.removeAllListeners('request');
  or.server.on('request', (req, res) => { orHeaders = req.headers; let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { or.hits.push(JSON.parse(b)); ok(res, ['ok']); }); });
  const { server, port } = await startApp({
    GEMINI_API_KEY: 'g', GEMINI_BASE_URL: gem.url, OPENROUTER_API_KEY: 'o', OPENROUTER_BASE_URL: or.url,
    TIER_BASSE: 'gemini:gemini-2.5-flash-lite', TIER_MOYENNE: 'openrouter:openai/gpt-oss-120b:free',
  });
  try {
    await (await chat(port, { tier: 'basse' })).text();
    await (await chat(port, { tier: 'moyenne' })).text();
    assert.equal(gem.hits[0].model, 'gemini-2.5-flash-lite');
    assert.equal(gem.hits[0].max_tokens, 2048); assert.equal(gem.hits[0].max_completion_tokens, undefined);
    assert.equal(gem.hits[0].reasoning_effort, 'low');
    assert.equal(or.hits[0].model, 'openai/gpt-oss-120b:free');
    assert.equal(or.hits[0].reasoning_effort, undefined); // não enviado onde não é garantido
    assert.equal(orHeaders['x-title'], 'Siart');
    assert.equal(orHeaders.authorization, 'Bearer o');
  } finally { await close(server); await close(gem.server); await close(or.server); }
});

// ---------- fallback ----------
test('429 no primeiro provedor passa ao próximo e o provedor fica em pausa nas próximas mensagens', async () => {
  const groq = await provider(fail(429));
  const gem = await provider((b, q, res) => ok(res, ['Resposta ', 'do Gemini']));
  const { server, port } = await startApp({ GROQ_API_KEY: 'k', GROQ_BASE_URL: groq.url, GEMINI_API_KEY: 'g', GEMINI_BASE_URL: gem.url });
  try {
    const ev = await events(await chat(port));
    assert.deepEqual(names(ev), ['task.started', 'model.fallback', 'model.selected', 'message.delta', 'message.delta', 'message.completed', 'task.completed']);
    const fb = ev[1].data;
    assert.deepEqual([fb.from, fb.to, fb.reason, fb.fromName, fb.toName], ['groq', 'gemini', 'rate_limit', 'Groq', 'Gemini']);
    assert.equal(ev[2].data.providerName, 'Gemini');
    assert.equal(ev[2].data.tierName, 'Moyenne 1');
    assert.equal(text(ev), 'Resposta do Gemini');
    assert.ok(!JSON.stringify(ev).includes('interno-secreto'));

    const ev2 = await events(await chat(port));
    assert.equal(text(ev2), 'Resposta do Gemini');
    assert.equal(groq.hits.length, 1); // Groq em pausa: não foi consultado de novo
    assert.equal(names(ev2).includes('model.fallback'), false);
  } finally { await close(server); await close(groq.server); await close(gem.server); }
});

test('provedor que não responde a tempo é trocado; resposta vazia também', async () => {
  const slow = await provider(() => { /* nunca responde */ });
  const empty = await provider((b, q, res) => ok(res, []));
  const good = await provider((b, q, res) => ok(res, ['certo']));
  const { server, port } = await startApp({
    GROQ_API_KEY: 'k', GROQ_BASE_URL: slow.url, GEMINI_API_KEY: 'g', GEMINI_BASE_URL: empty.url, MISTRAL_API_KEY: 'm', MISTRAL_BASE_URL: good.url,
    TIER_MOYENNE_FIRST_BYTE_MS: '300',
  });
  try {
    const ev = await events(await chat(port));
    const reasons = ev.filter((e) => e.event === 'model.fallback').map((e) => `${e.data.from}:${e.data.reason}`);
    assert.deepEqual(reasons, ['groq:timeout', 'gemini:empty']);
    assert.equal(text(ev), 'certo');
    assert.equal(ev.at(-1).event, 'task.completed');
  } finally { await close(server); await close(slow.server); await close(empty.server); await close(good.server); }
});

test('falha depois de saída parcial não troca de provedor (evita texto duplicado)', async () => {
  const groq = await provider((b, q, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Começo' } }] })}\n\n`);
    setTimeout(() => res.destroy(), 30);
  });
  const gem = await provider((b, q, res) => ok(res, ['não deveria aparecer']));
  const { server, port } = await startApp({ GROQ_API_KEY: 'k', GROQ_BASE_URL: groq.url, GEMINI_API_KEY: 'g', GEMINI_BASE_URL: gem.url });
  try {
    const ev = await events(await chat(port));
    assert.equal(text(ev), 'Começo');
    assert.equal(ev.at(-1).event, 'task.failed');
    assert.equal(gem.hits.length, 0);
  } finally { await close(server); await close(groq.server); await close(gem.server); }
});

test('quando todos falham, devolve all_providers_failed com os motivos e sem vazar detalhes', async () => {
  const a = await provider(fail(500));
  const b = await provider(fail(401));
  const { server, port } = await startApp({ GROQ_API_KEY: 'k', GROQ_BASE_URL: a.url, GEMINI_API_KEY: 'g', GEMINI_BASE_URL: b.url });
  try {
    const ev = await events(await chat(port));
    const failed = ev.find((e) => e.event === 'task.failed');
    assert.equal(failed.data.code, 'all_providers_failed');
    assert.deepEqual(failed.data.tried, [{ provider: 'groq', reason: 'unavailable' }, { provider: 'gemini', reason: 'auth' }]);
    assert.ok(!JSON.stringify(ev).includes('interno-secreto'));
    // com todos em pausa, ainda tenta (não fica bloqueado)
    const again = await events(await chat(port));
    assert.equal(again.find((e) => e.event === 'task.failed').data.code, 'all_providers_failed');
    assert.equal(a.hits.length, 2);
  } finally { await close(server); await close(a.server); await close(b.server); }
});

test('404 de modelo pausa só aquele modelo; 400 sem ferramentas segue para o próximo', async () => {
  const groq = await provider(fail(404));
  const gem = await provider(fail(400));
  const mis = await provider((b, q, res) => ok(res, ['via mistral']));
  const { server, port } = await startApp({
    GROQ_API_KEY: 'k', GROQ_BASE_URL: groq.url, GEMINI_API_KEY: 'g', GEMINI_BASE_URL: gem.url, MISTRAL_API_KEY: 'm', MISTRAL_BASE_URL: mis.url,
  });
  try {
    const ev = await events(await chat(port, { tier: 'basse' })); // basse não usa ferramentas
    assert.deepEqual(ev.filter((e) => e.event === 'model.fallback').map((e) => e.data.reason), ['model_unavailable', 'rejected']);
    assert.equal(text(ev), 'via mistral');
  } finally { await close(server); await close(groq.server); await close(gem.server); await close(mis.server); }
});

// ---------- ferramentas e troca de provedor ----------
test('IDs de ferramenta são normalizados e o histórico segue válido ao trocar de provedor no meio da tarefa', async () => {
  const groq = await provider((b, q, res, n) => {
    if (n === 1) return ok(res, toolCall('call_abc_123-xyz', 'write_project_file', JSON.stringify({ path: 'a.md', content: '# oi' })));
    res.writeHead(500); res.end('x'); // o segundo passo falha
  });
  const gem = await provider((b, q, res) => ok(res, ['Arquivo criado.']));
  const { server, port } = await startApp({ GROQ_API_KEY: 'k', GROQ_BASE_URL: groq.url, GEMINI_API_KEY: 'g', GEMINI_BASE_URL: gem.url });
  try {
    const ev = await events(await chat(port));
    assert.deepEqual(names(ev).filter((n) => !n.startsWith('message.d')), ['task.started', 'model.selected', 'tool.started', 'tool.completed', 'model.fallback', 'model.selected', 'message.completed', 'task.completed']);
    assert.equal(text(ev).trim(), 'Arquivo criado.');
    const msgs = gem.hits[0].messages;
    const asst = msgs.find((m) => m.tool_calls);
    assert.match(asst.tool_calls[0].id, /^[a-z0-9]{9}$/);
    const tool = msgs.at(-1);
    assert.equal(tool.role, 'tool');
    assert.equal(tool.tool_call_id, asst.tool_calls[0].id);
    assert.equal(tool.name, 'write_project_file');
    assert.equal(JSON.parse(tool.content).ok, true);
  } finally { await close(server); await close(groq.server); await close(gem.server); }
});

test('Basse não recebe nem executa ferramentas de projeto', async () => {
  const groq = await provider((b, q, res) => ok(res, toolCall('x1', 'write_project_file', JSON.stringify({ path: 'a.md', content: 'x' }))));
  const { server, port } = await startApp({ GROQ_API_KEY: 'k', GROQ_BASE_URL: groq.url });
  try {
    const ev = await events(await chat(port, { tier: 'basse' }));
    assert.equal(groq.hits[0].tools, undefined);
    assert.equal(names(ev).includes('tool.started'), false); // mesmo que o modelo tente, não há ferramenta ligada
  } finally { await close(server); await close(groq.server); }
});

// ---------- limites ----------
test('servidor aplica o limite de mensagens por conversa', async () => {
  const groq = await provider((b, q, res) => ok(res, ['ok']));
  const { server, port } = await startApp({ GROQ_API_KEY: 'k', GROQ_BASE_URL: groq.url, MAX_MESSAGES_PER_CONVERSATION: '4' });
  try {
    const msg = (r, i) => ({ role: r, content: `m${i}` });
    const four = [msg('user', 1), msg('assistant', 2), msg('user', 3), msg('assistant', 4)];
    assert.equal((await chat(port, { messages: [...four.slice(0, 3)] })).status, 200);
    const over = await chat(port, { messages: [...four, msg('user', 5)] });
    assert.equal(over.status, 400);
    assert.match((await over.json()).error, /entre 1 e 4 mensagens/);
  } finally { await close(server); await close(groq.server); }
});
