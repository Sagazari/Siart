const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSystemPrompt } = require('../src/prompt');
const tools = require('../src/tools');

test('prompt cobre identidade, honestidade, engenharia, segurança e ofício de interfaces', () => {
  const p = buildSystemPrompt({ tools: true, editable: ['.html', '.css'] });
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
