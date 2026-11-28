'use strict';
// Tipo de arquivo -> cor e ícone próprios. Compartilhado pelos cartões do chat e pela lista do projeto.
(() => {
  const K = {
    html: { label: 'HTML', tone: '#ee7a4b', icon: 'f-html' },
    css: { label: 'CSS', tone: '#5b9dff', icon: 'f-css' },
    js: { label: 'JS', tone: '#ecc94b', icon: 'f-js' },
    ts: { label: 'TS', tone: '#4f8ef7', icon: 'f-js' },
    json: { label: 'JSON', tone: '#4ade80', icon: 'f-json' },
    package: { label: 'NPM', tone: '#f0605d', icon: 'f-package' },
    md: { label: 'MD', tone: '#93a4c3', icon: 'f-md' },
    yml: { label: 'YAML', tone: '#b98af5', icon: 'f-yml' },
    py: { label: 'PY', tone: '#56b6e0', icon: 'f-term' },
    sh: { label: 'SH', tone: '#6fe3a6', icon: 'f-term' },
    sql: { label: 'SQL', tone: '#f0a04b', icon: 'f-db' },
    pdf: { label: 'PDF', tone: '#f26b6b', icon: 'f-pdf' },
    zip: { label: 'ZIP', tone: '#f5b441', icon: 'f-zip' },
    svg: { label: 'SVG', tone: '#f472b6', icon: 'f-svg' },
    image: { label: 'IMG', tone: '#2dd4bf', icon: 'f-image' },
    text: { label: 'TXT', tone: '#a3acb9', icon: 'f-text' },
    file: { label: 'ARQ', tone: '#a3acb9', icon: 'f-file' },
  };
  const BY_EXT = {
    html: 'html', htm: 'html', css: 'css', js: 'js', mjs: 'js', jsx: 'js', ts: 'ts', tsx: 'ts', json: 'json', md: 'md',
    yml: 'yml', yaml: 'yml', py: 'py', sh: 'sh', sql: 'sql', pdf: 'pdf', zip: 'zip', svg: 'svg',
    png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', txt: 'text', csv: 'text', xml: 'text', toml: 'yml',
  };
  function fileKind(path) {
    const name = String(path || '').split('/').pop().toLowerCase();
    if (/^package(-lock)?\.json$/.test(name)) return { id: 'package', ...K.package };
    const ext = name.includes('.') ? name.split('.').pop() : '';
    const id = BY_EXT[ext] || 'file';
    return { id, ...K[id], label: K[id].label === 'ARQ' && ext ? ext.slice(0, 5).toUpperCase() : K[id].label };
  }
  window.SiartFileKind = fileKind;
})();
