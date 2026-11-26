'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspace, cleanPath, purgeIdle, WorkspaceError } = require('../src/workspace');
const { createZip, crc32 } = require('../src/zip');
const { generatePdf, validatePdf } = require('../src/pdf');
const { runTool } = require('../src/tools');
const { createServer, loadConfig } = require('../src/server');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'siart-t2-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const newWs = (limits) => createWorkspace(fs.mkdtempSync(path.join(TMP, 'ws-')), limits);
const throwsWs = (fn, re) => assert.throws(fn, (e) => e instanceof WorkspaceError && (!re || re.test(e.message)));

// ---------- workspace ----------
test('cleanPath bloqueia traversal, absolutos, dotfiles e caracteres perigosos', () => {
  for (const bad of ['../x', 'a/../../x', '/../x', '..', '.', '', 'a\\b', 'a\0b', '.env', 'a/.git/x', '.history/changes.jsonl', 'a/b:c', 'x'.repeat(301)]) {
    assert.throws(() => cleanPath(bad), WorkspaceError, `deveria rejeitar: ${JSON.stringify(bad)}`);
  }
  assert.equal(cleanPath('/src//app.js'), 'src/app.js');
  assert.equal(cleanPath('a/./b.txt'), 'a/b.txt');
  assert.throws(() => cleanPath('a/b/c/d/e/f/g.txt'), WorkspaceError); // profundidade
});

test('workspace grava, lê, edita por patch e guarda histórico', () => {
  const ws = newWs();
  assert.deepEqual(ws.write('index.html', '<h1>Oi</h1>'), { path: 'index.html', bytes: 11, created: true });
  assert.equal(ws.read('index.html').content, '<h1>Oi</h1>');
  assert.equal(ws.write('index.html', '<h1>Olá</h1>').created, false);
  ws.write('src/app.js', 'let a = 1;\nlet b = 1;\n');
  ws.patch('src/app.js', 'let a = 1;', 'let a = 2;');
  assert.match(ws.read('src/app.js').content, /let a = 2;\nlet b = 1;/);
  throwsWs(() => ws.patch('src/app.js', 'let', 'const'), /2 vezes/);
  throwsWs(() => ws.patch('src/app.js', 'inexistente', 'x'), /não foi encontrado/);
  const ops = ws.changes().map((c) => c.op);
  assert.ok(ops.includes('create') && ops.includes('update'));
  assert.deepEqual(ws.list().files.map((f) => f.path), ['index.html', 'src/app.js']);
});

test('workspace mantém cópia da versão anterior ao sobrescrever e ao excluir', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'ws-'));
  const ws = createWorkspace(root);
  ws.write('a.txt', 'v1');
  ws.write('a.txt', 'v2');
  ws.remove('a.txt');
  const backups = fs.readdirSync(path.join(root, '.history')).filter((n) => /^\d+-/.test(n));
  assert.equal(backups.length, 2);
  const contents = backups.map((n) => fs.readFileSync(path.join(root, '.history', n), 'utf8')).sort();
  assert.deepEqual(contents, ['v1', 'v2']);
  assert.deepEqual(ws.list().files, []);
});

test('workspace aplica limites, extensões e protege contra links simbólicos', () => {
  const ws = newWs({ maxFiles: 2, maxFileBytes: 50, maxTotalBytes: 80, maxDepth: 6, maxBackups: 5 });
  throwsWs(() => ws.write('x.exe', 'a'), /Extensão não permitida/);
  throwsWs(() => ws.write('semext', 'a'), /Extensão não permitida/);
  throwsWs(() => ws.write('big.txt', 'a'.repeat(51)), /grande demais/);
  ws.write('1.txt', 'a'.repeat(40));
  ws.write('2.txt', 'a'.repeat(30));
  throwsWs(() => ws.write('3.txt', 'a'), /Limite de 2 arquivos/);
  throwsWs(() => ws.write('2.txt', 'a'.repeat(45)), /armazenamento/);

  const root = fs.mkdtempSync(path.join(TMP, 'ws-'));
  const outside = fs.mkdtempSync(path.join(TMP, 'outside-'));
  fs.writeFileSync(path.join(outside, 'segredo.txt'), 'SEGREDO');
  fs.symlinkSync(outside, path.join(root, 'link'));
  const ws2 = createWorkspace(root);
  throwsWs(() => ws2.read('link/segredo.txt'), /simbólicos/);
  throwsWs(() => ws2.write('link/novo.txt', 'x'), /simbólicos/);
  assert.equal(ws2.list().files.length, 0); // o link não é listado nem seguido
});

test('workspace: renomear não sobrescreve, mkdir e arquivo no lugar de pasta', () => {
  const ws = newWs();
  ws.write('a.txt', '1'); ws.write('b.txt', '2');
  throwsWs(() => ws.rename('a.txt', 'b.txt'), /Já existe/);
  ws.rename('a.txt', 'docs/c.md');
  assert.equal(ws.read('docs/c.md').content, '1');
  ws.mkdir('pasta.md');
  throwsWs(() => ws.write('pasta.md', 'x'), /pasta/);
  throwsWs(() => ws.write('b.txt/filho.txt', 'x'));
  ws.mkdir('pasta/vazia');
  assert.ok(ws.list().dirs.includes('pasta/vazia'));
});

test('purgeIdle remove apenas espaços antigos', () => {
  const clients = fs.mkdtempSync(path.join(TMP, 'clients-'));
  const old = path.join(clients, 'velho'); const fresh = path.join(clients, 'novo');
  fs.mkdirSync(old); fs.mkdirSync(fresh);
  const past = new Date(Date.now() - 40 * 86400000);
  fs.utimesSync(old, past, past);
  assert.equal(purgeIdle(clients, 30 * 86400000), 1);
  assert.deepEqual(fs.readdirSync(clients), ['novo']);
});

// ---------- ZIP e PDF ----------
test('crc32 confere com o valor conhecido e o ZIP tem estrutura válida', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const zip = createZip([{ name: 'a.txt', data: Buffer.from('olá') }, { name: 'p/b.txt', data: Buffer.from('x') }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length - 22 + 10), 2);
});

test('PDF gerado é válido, paginado e contém o texto', () => {
  const longo = Array.from({ length: 120 }, (_, i) => `Linha ${i} com acentuação (ç) e parênteses \\ barra`).join('\n');
  const pdf = generatePdf(`# Título\n\n- item um\n- item dois\n\n${longo}`, { title: 'Relatório' });
  assert.ok(validatePdf(pdf));
  const text = pdf.toString('latin1');
  assert.match(text, /\/Count [2-9]/);
  assert.match(text, /Linha 119/);
  assert.equal(validatePdf(Buffer.from('nao e pdf')), false);
  assert.ok(validatePdf(generatePdf('')));
});

// ---------- ferramentas ----------
test('runTool valida argumentos e devolve erros previsíveis', () => {
  const ws = newWs();
  assert.equal(runTool(ws, 'write_project_file', { path: 'a.md' }).ok, false);
  assert.equal(runTool(ws, 'write_project_file', { path: '../a.md', content: 'x' }).ok, false);
  assert.equal(runTool(ws, 'delete_project_file', { path: 'a.md' }).ok, false); // não existe
  assert.equal(runTool(ws, 'write_project_file', { path: 'a.md', content: '# oi' }).ok, true);
  assert.equal(runTool(ws, 'generate_pdf', { path: 'r.pdf', content: '# Oi' }).ok, true);
  assert.equal(runTool(ws, 'generate_pdf', { path: 'r.txt', content: '# Oi' }).ok, false);
  const listed = runTool(ws, 'list_project_files', {});
  assert.deepEqual(listed.files.map((f) => f.path), ['a.md', 'r.pdf']);
  assert.equal(runTool(ws, 'read_project_file', { path: 'r.pdf' }).ok, false); // binário
});

// ---------- servidor ----------
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = (s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); });
const startMock = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
const ENV_MAP = { baseUrl: 'GROQ_BASE_URL', maxToolSteps: 'MAX_TOOL_STEPS', accessCode: 'ACCESS_CODE' };
const cfgFor = (extra = {}) => {
  const env = { GROQ_API_KEY: 'gsk_x', DATA_DIR: fs.mkdtempSync(path.join(TMP, 'data-')) };
  for (const [k, v] of Object.entries(extra)) env[ENV_MAP[k] || k] = String(v);
  return loadConfig(env);
};

function sse(res, deltas) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const d of deltas) res.write(`data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`);
  res.end('data: [DONE]\n\n');
}
const toolCall = (id, name, args) => [
  { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args.slice(0, 10) } }] },
  { tool_calls: [{ index: 0, function: { arguments: args.slice(10) } }] },
];
async function events(res) {
  return (await res.text()).split('\n\n').filter(Boolean).map((b) => ({ event: b.match(/^event: (.+)$/m)[1], data: JSON.parse(b.match(/^data: (.+)$/m)[1]) }));
}
const chat = (port, cookie, text = 'crie um site') => fetch(`http://127.0.0.1:${port}/api/chat`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
});
const cookieOf = (res) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');

test('agente executa ferramentas, grava no projeto e continua até a resposta final', async () => {
  const requests = [];
  const mock = await startMock((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = JSON.parse(b);
      requests.push(body);
      const last = body.messages[body.messages.length - 1];
      if (last.role === 'tool') return sse(res, [{ content: 'Criei o index.html.' }]);
      sse(res, toolCall('c1', 'write_project_file', JSON.stringify({ path: 'index.html', content: '<h1>Oi</h1>' })));
    });
  });
  const server = createServer(cfgFor({ baseUrl: `http://127.0.0.1:${mock.address().port}/v1` }));
  const port = await listen(server);
  try {
    const res = await chat(port);
    const cookie = cookieOf(res);
    assert.match(cookie, /siart_cid=[a-f0-9]{32}/);
    const ev = await events(res);
    const names = ev.map((e) => e.event);
    assert.equal(names[0], 'task.started');
    assert.ok(names.indexOf('tool.started') < names.indexOf('tool.completed'));
    assert.equal(names.at(-1), 'task.completed');
    const done = ev.find((e) => e.event === 'tool.completed');
    assert.equal(done.data.tool, 'write_project_file');
    assert.equal(done.data.path, 'index.html');
    assert.equal(done.data.mutated, true);
    assert.equal(ev.filter((e) => e.event === 'message.delta').map((e) => e.data.text).join('').trim(), 'Criei o index.html.');
    assert.equal(requests.length, 2);
    assert.ok(requests[0].tools.length >= 6);
    assert.equal(requests[1].messages.at(-1).role, 'tool');
    assert.equal(JSON.parse(requests[1].messages.at(-1).content).ok, true);

    const file = await fetch(`http://127.0.0.1:${port}/api/file?path=index.html`, { headers: { Cookie: cookie } });
    assert.equal((await file.json()).content, '<h1>Oi</h1>');
  } finally { await close(server); await close(mock); }
});

test('agente informa falhas de ferramenta ao modelo e respeita o limite de passos', async () => {
  let calls = 0;
  const mock = await startMock((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = JSON.parse(b);
      calls++;
      if (!body.tools) return sse(res, [{ content: 'Parei por limite.' }]);
      sse(res, toolCall(`c${calls}`, 'read_project_file', JSON.stringify({ path: 'nao-existe.txt' })));
    });
  });
  const server = createServer(cfgFor({ maxToolSteps: 3, baseUrl: `http://127.0.0.1:${mock.address().port}/v1` }));
  const port = await listen(server);
  try {
    const ev = await events(await chat(port));
    assert.equal(ev.filter((e) => e.event === 'tool.failed').length, 3);
    assert.match(ev.find((e) => e.event === 'tool.failed').data.message, /não encontrado/i);
    assert.equal(calls, 4); // 3 passos com ferramentas + resposta final sem ferramentas
    assert.equal(ev.at(-1).event, 'task.completed');
  } finally { await close(server); await close(mock); }
});

test('se o provedor rejeita tool calling (400), segue só com texto', async () => {
  const mock = await startMock((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      if (JSON.parse(b).tools) { res.writeHead(400); return res.end('{"error":"tools"}'); }
      sse(res, [{ content: 'Só texto.' }]);
    });
  });
  const server = createServer(cfgFor({ baseUrl: `http://127.0.0.1:${mock.address().port}/v1` }));
  const port = await listen(server);
  try {
    const ev = await events(await chat(port));
    assert.equal(ev.map((e) => e.event).includes('task.failed'), false);
    assert.equal(ev.filter((e) => e.event === 'message.delta').map((e) => e.data.text).join(''), 'Só texto.');
  } finally { await close(server); await close(mock); }
});

test('API de arquivos, isolamento entre clientes, ZIP, download e exclusão', async () => {
  const server = createServer(cfgFor());
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const json = (m, p, body, cookie) => fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  try {
    const a = await json('PUT', '/api/file', { path: 'nota.md', content: '# A' });
    assert.equal(a.status, 200);
    const ca = cookieOf(a);
    const b = await json('PUT', '/api/file', { path: 'outra.md', content: '# B' });
    const cb = cookieOf(b);
    assert.notEqual(ca, cb);

    const la = await (await json('GET', '/api/files', null, ca)).json();
    const lb = await (await json('GET', '/api/files', null, cb)).json();
    assert.deepEqual(la.files.map((f) => f.path), ['nota.md']);
    assert.deepEqual(lb.files.map((f) => f.path), ['outra.md']);
    assert.equal((await json('GET', '/api/file?path=outra.md', null, ca)).status, 404);

    assert.equal((await json('GET', '/api/file?path=../../etc/passwd', null, ca)).status, 400);
    assert.equal((await json('GET', '/api/file?path=.history/changes.jsonl', null, ca)).status, 400);
    assert.equal((await json('PUT', '/api/file', { path: 'x.exe', content: 'a' }, ca)).status, 400);
    assert.equal((await json('PUT', '/api/file', { path: 'a.txt', content: 1 }, ca)).status, 400);

    const zip = await json('GET', '/api/export.zip', null, ca);
    assert.equal(zip.headers.get('content-type'), 'application/zip');
    const zbuf = Buffer.from(await zip.arrayBuffer());
    assert.equal(zbuf.readUInt32LE(0), 0x04034b50);

    const dl = await json('GET', '/api/download?path=nota.md', null, ca);
    assert.match(dl.headers.get('content-disposition'), /attachment/);
    assert.equal(await dl.text(), '# A');

    assert.equal((await json('POST', '/api/file/rename', { from: 'nota.md', to: 'nota2.md' }, ca)).status, 200);
    assert.equal((await json('DELETE', '/api/file?path=nota2.md', null, ca)).status, 200);
    assert.equal((await (await json('GET', '/api/changes', null, ca)).json()).changes[0].op, 'delete');
    assert.equal((await json('DELETE', '/api/project', null, ca)).status, 200);
    assert.equal((await (await json('GET', '/api/files', null, ca)).json()).files.length, 0);
    assert.equal((await json('PUT', '/api/file', { path: 'a.md', content: 'x' }, ca)).status, 200);
    // origem externa não pode alterar arquivos
    const evil = await fetch(base + '/api/file', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: ca }, body: '{"path":"z.md","content":"x"}' });
    assert.equal(evil.status, 403);
  } finally { await close(server); }
});

test('prévia: token, sandbox, tipos, traversal e isolamento', async () => {
  const server = createServer(cfgFor());
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    const put = (p, c, cookie) => fetch(base + '/api/file', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify({ path: p, content: c }) });
    const r = await put('index.html', '<script src="app.js"></script>');
    const cookie = cookieOf(r);
    await put('app.js', 'document.title="ok"', cookie);
    const { url } = await (await fetch(base + '/api/preview-url', { headers: { Cookie: cookie } })).json();
    assert.match(url, /^\/preview\/[a-f0-9]{32}\/$/);

    const page = await fetch(base + url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /^sandbox allow-scripts/);
    assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal((await fetch(base + url + 'app.js')).headers.get('content-type').startsWith('text/javascript'), true);
    assert.equal((await fetch(base + url + 'nao.js')).status, 404);
    assert.equal((await fetch(base + url + '..%2f..%2fpackage.json')).status, 400);
    assert.equal((await fetch(base + url + '.history/changes.jsonl')).status, 400);
    assert.equal((await fetch(base + '/preview/' + 'a'.repeat(32) + '/index.html')).status, 404);
    // a página principal não pode ser enquadrada por terceiros
    const main = await fetch(base + '/');
    assert.equal(main.headers.get('x-frame-options'), 'DENY');
  } finally { await close(server); }
});

test('ACCESS_CODE: bloqueia API sem login, aceita código correto e limita tentativas', async () => {
  const server = createServer(cfgFor({ accessCode: 'segredo123' }));
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const post = (p, body, cookie) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await (await fetch(base + '/api/status')).json()).locked, true);
    const blocked = await fetch(base + '/api/files');
    assert.equal(blocked.status, 401);
    assert.equal((await blocked.json()).code, 'auth_required');
    assert.equal((await post('/api/chat', { messages: [{ role: 'user', content: 'oi' }] })).status, 401);
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.equal((await fetch(base + '/')).status, 200); // a tela de login precisa carregar

    assert.equal((await post('/api/login', { code: 'errado' })).status, 401);
    const ok = await post('/api/login', { code: 'segredo123' });
    assert.equal(ok.status, 200);
    const cookie = cookieOf(ok);
    assert.match(cookie, /siart_auth=/);
    assert.equal((await fetch(base + '/api/files', { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await (await fetch(base + '/api/status', { headers: { Cookie: cookie } })).json()).locked, false);
    assert.ok(!ok.headers.getSetCookie().join('').includes('segredo123'));

    for (let i = 0; i < 12; i++) await post('/api/login', { code: 'x' });
    assert.equal((await post('/api/login', { code: 'segredo123' })).status, 429);
  } finally { await close(server); }
});
