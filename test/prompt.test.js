const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSystemPrompt } = require('../src/prompt');
const tools = require('../src/tools');

test('prompt cobre identidade, honestidade, engenharia, segurança e ofício de interfaces', () => {
  const p = buildSystemPrompt({ tools: true, site: true, editable: ['.html', '.css'] });
  for (const h of ['# Identidade', '# Honestidade e limites', '# Engenharia de software', '# Segurança', '# Ofício de interfaces', '# Trabalho com ferramentas']) assert.ok(p.includes(h), h);
  assert.match(p, /review_website/);
  assert.match(p, /\.html, \.css/);
});

test('sem ferramentas o prompt proíbe fingir execução', () => {
  const p = buildSystemPrompt({ tools: false });
  assert.match(p, /NÃO há ferramentas/);
  assert.doesNotMatch(p, /# Trabalho com ferramentas/);
});

test('modo voz só entra quando solicitado', () => {
  assert.doesNotMatch(buildSystemPrompt({ tools: true }), /Modo voz/);
  assert.match(buildSystemPrompt({ tools: true, voice: true }), /# Modo voz/);
});

test('tools.buildSystemPrompt delega ao módulo e lista extensões editáveis', () => {
  const p = tools.buildSystemPrompt({ tools: true, voice: false });
  assert.match(p, /Extensões permitidas/);
});

test('identidade: nome Siart, criada pela Velroc, fundada por Sagaz e Knx', () => {
  const p = buildSystemPrompt({ tools: false });
  assert.match(p, /Seu nome é Siart/);
  assert.match(p, /Velroc/);
  assert.match(p, /Sagaz e Knx/);
  assert.match(p, /Nunca afirme ser ChatGPT/);
});

test('roteiro de sites profissionais está presente e limita o tamanho por arquivo', () => {
  const p = buildSystemPrompt({ tools: true, site: true });
  assert.match(p, /# Roteiro para sites e landing pages/);
  assert.match(p, /visual de produto/i);
  assert.match(p, /MESMO lote de chamadas/);
  assert.match(p, /Nunca escreva marcações como <tool_call>/);
});

test('fora de pedidos de site o prompt fica enxuto (sem o roteiro longo)', () => {
  const lean = buildSystemPrompt({ tools: true });
  const full = buildSystemPrompt({ tools: true, site: true });
  assert.doesNotMatch(lean, /Roteiro para sites/);
  assert.ok(full.length - lean.length > 1000);
  assert.ok(full.length < lean.length + 7000);
});
