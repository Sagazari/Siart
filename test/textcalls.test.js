const test = require('node:test');
const assert = require('node:assert/strict');
const { createTextGuard, parseTextToolCalls, hasToolMarkup } = require('../src/textcalls');
const { TOOLS } = require('../src/tools');

const SAMPLE = '<tool_call>\n<function=write_project_file>\n<parameter=path>\npackage.json\n</parameter>\n<parameter=content>\n{\n  "name": "x"\n}\n</parameter>\n</function>\n</tool_call>';

test('filtro de streaming não deixa o markup de chamada vazar, mesmo quebrado em pedaços', () => {
  const out = [];
  const g = createTextGuard((t) => out.push(t));
  for (const piece of ['Vou criar. <too', 'l_call>\n<func', 'tion=write_project_file>', 'resto']) g.push(piece);
  g.flush();
  assert.equal(out.join(''), 'Vou criar. ');
  assert.equal(g.blocked, true);
});

test('filtro mantém texto normal com "<" que não é marcador', () => {
  const out = [];
  const g = createTextGuard((t) => out.push(t));
  for (const piece of ['se a ', '< b e ', 'c <div>ok</div>']) g.push(piece);
  g.flush();
  assert.equal(out.join(''), 'se a < b e c <div>ok</div>');
});

test('converte o formato XML em chamada real, preservando JSON dentro de strings', () => {
  const r = parseTextToolCalls('Criando.\n' + SAMPLE, TOOLS);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, 'write_project_file');
  const args = JSON.parse(r.calls[0].args);
  assert.equal(args.path, 'package.json');
  assert.equal(typeof args.content, 'string');
  assert.deepEqual(JSON.parse(args.content), { name: 'x' });
  assert.equal(r.clean, 'Criando.');
  assert.equal(r.truncated, false);
});

test('converte o formato JSON dentro de <tool_call>', () => {
  const r = parseTextToolCalls('<tool_call>{"name":"list_project_files","arguments":{}}</tool_call>', TOOLS);
  assert.deepEqual(r.calls, [{ name: 'list_project_files', args: '{}' }]);
});

test('bloco sem fechamento é marcado como truncado e não é executado', () => {
  const r = parseTextToolCalls('ok <tool_call>\n<function=write_project_file>\n<parameter=path>a.html</parameter>\n<parameter=content>\n<html', TOOLS);
  assert.equal(r.calls.length, 0);
  assert.equal(r.truncated, true);
  assert.equal(r.clean, 'ok');
  assert.equal(hasToolMarkup(r.clean), false);
});
