const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('UI usa cache-busting novo para CSS e JavaScript', () => {
  const html = read('public/index.html');
  assert.match(html, /styles\.css\?v=1\.6\.0/);
  assert.match(html, /app\.js\?v=1\.6\.0/);
});

test('brilho de carregamento: ladrilho de 200% deslocado em exatos 200%, sem emenda', () => {
  const css = read('public/styles.css');
  assert.match(css, /\.shimmer\s*\{[\s\S]*?background-size:\s*200%\s+100%[\s\S]*?background-repeat:\s*repeat-x[\s\S]*?animation:\s*shimmer\s+2\.2s\s+linear\s+infinite/);
  assert.match(css, /@keyframes\s+shimmer\s*\{\s*from\s*\{\s*background-position:\s*200%\s+0;\s*\}\s*to\s*\{\s*background-position:\s*0%\s+0;/);
  // gradiente passa por cinza escuro, cinza claro e branco
  assert.match(css, /--shimmer-peak:\s*#fff/i);
});

test('a folha de estilos não depende de !important para as animações', () => {
  const css = read('public/styles.css');
  assert.equal((css.match(/!important/g) || []).length, 1); // apenas o display:none do #scrim/#menu no desktop
});

test('o brilho nunca some em movimento reduzido (só fica mais lento)', () => {
  const css = read('public/styles.css');
  const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(block, /\.shimmer[\s\S]*?animation:\s*shimmer\s+4\.4s\s+linear\s+infinite/);
});

test('texto sobe de uma base recortada (clip-path + translateY), nunca por opacidade', () => {
  const css = read('public/styles.css');
  assert.match(css, /@keyframes\s+emerge\s*\{\s*from\s*\{\s*transform:\s*translateY\(105%\);\s*\}\s*to\s*\{\s*transform:\s*translateY\(0\);/);
  assert.match(css, /\.rw\s*\{[^}]*clip-path:/);
  assert.match(css, /\.rwi\s*\{[^}]*animation:\s*emerge/);
  const emerge = css.match(/@keyframes\s+emerge\s*\{[^}]*\}[^}]*\}/)[0];
  assert.doesNotMatch(emerge, /opacity/);
});

test('cartões de arquivo são transparentes e usam cor própria por tipo', () => {
  const css = read('public/styles.css');
  const card = css.slice(css.indexOf('.artifact-card {'), css.indexOf('.artifact-icon {'));
  assert.match(card, /--tone/);
  assert.match(card, /color-mix\(in srgb, var\(--tone\) 9%, transparent\)/);
  assert.doesNotMatch(card, /gradient/);
  const kinds = read('public/filekinds.js');
  for (const k of ['html', 'css', 'package', 'zip', 'pdf', 'js', 'json']) assert.match(kinds, new RegExp(k + ': \\{ label'));
  const tones = [...kinds.matchAll(/tone: '(#[0-9a-f]{6})'/g)].map((m) => m[1]);
  assert.ok(new Set(tones).size >= 12, 'tipos principais têm cores distintas');
  const html = read('public/index.html');
  for (const id of ['f-html', 'f-css', 'f-js', 'f-package', 'f-zip', 'f-pdf']) assert.match(html, new RegExp('id="' + id + '"'));
});

test('a interface nunca mostra nome de provedor ou aviso de troca de IA', () => {
  const js = read('public/app.js');
  assert.doesNotMatch(js, /Usando \' \+|via ' \+|fallbacks\)\.forEach/);
  assert.doesNotMatch(js, /Falha de conexão com os provedores/);
  assert.match(js, /event === 'model\.selected' \|\| event === 'model\.fallback'/);
});

test('app.js usa o brilho e a subida de texto, e a voz escolhe voz feminina pt-BR', () => {
  const js = read('public/app.js');
  assert.match(js, /work-current shimmer/);
  assert.match(js, /function applyReveal/);
  assert.match(js, /function pickVoice/);
  assert.match(js, /natural\|neural/);
  assert.match(js, /requestAnimationFrame/);
  new Function(js); // sintaxe válida
});
