const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

test('UI usa cache-busting novo para CSS e JavaScript', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.match(html, /styles\.css\?v=1\.4\.2-livefix/);
  assert.match(html, /app\.js\?v=1\.4\.2-livefix/);
  assert.doesNotMatch(html, /(?:styles\.css|app\.js)\?v=1\.4\.0-emerald/);
});

test('gradiente de carregamento tem animação contínua e estado ativo', () => {
  const css = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
  assert.match(css, /\.work-current:not\(\.is-done\).*?animation:\s*siart-live-shimmer\s+2\.1s[^;]*infinite\s*!important/s);
  assert.match(css, /\.activity-label\.is-running/);
  assert.match(css, /@keyframes\s+siart-live-shimmer/);
});
