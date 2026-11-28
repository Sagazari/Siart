'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createZip } = require('./zip');

const LIMITS = { maxFiles: 200, maxFileBytes: 512 * 1024, maxTotalBytes: 5 * 1024 * 1024, maxDepth: 6, maxBackups: 100 };
const EDITABLE = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.md', '.txt', '.csv', '.svg', '.xml',
  '.yml', '.yaml', '.ts', '.tsx', '.jsx', '.py', '.sql', '.sh', '.toml']);
const BINARY_OK = new Set(['.pdf']);
// Únicos nomes ocultos aceitos: configuração comum de projeto. Nada de .env, .git ou .history.
const ALLOWED_DOT = new Set(['.github', '.gitignore', '.gitattributes', '.editorconfig', '.nvmrc', '.prettierrc', '.dockerignore', '.env.example']);

class WorkspaceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Normaliza e valida um caminho relativo vindo do navegador ou do modelo.
function cleanPath(p) {
  if (typeof p !== 'string' || !p || p.length > 300 || /[\0\\]/.test(p)) throw new WorkspaceError('Caminho inválido.');
  const n = path.posix.normalize(p.replace(/^\/+/, ''));
  if (n === '.' || n === '..' || n.startsWith('../') || path.posix.isAbsolute(n)) throw new WorkspaceError('Caminho inválido.');
  const parts = n.split('/').filter(Boolean);
  if (!parts.length || parts.length > LIMITS.maxDepth) throw new WorkspaceError('Caminho inválido ou profundo demais.');
  for (const s of parts) {
    if (s.length > 100 || (s.startsWith('.') && !ALLOWED_DOT.has(s)) || /[\u0000-\u001f<>:"|?*]/.test(s)) throw new WorkspaceError('Nome de arquivo ou pasta não permitido.');
  }
  return parts.join('/');
}

const extOf = (p) => path.extname(p).toLowerCase();
const isEditable = (p) => EDITABLE.has(extOf(p)) || ALLOWED_DOT.has(path.posix.basename(p));

function createWorkspace(root, limits = LIMITS) {
  const hist = path.join(root, '.history');
  const abs = (rel) => path.join(root, ...rel.split('/'));

  function assertNoSymlink(rel) {
    let cur = root;
    for (const s of rel.split('/')) {
      cur = path.join(cur, s);
      let st;
      try { st = fs.lstatSync(cur); } catch { return; }
      if (st.isSymbolicLink()) throw new WorkspaceError('Links simbólicos não são permitidos.', 403);
    }
  }

  function walk(dir = root, base = '') {
    const out = { files: [], dirs: [] };
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if ((e.name.startsWith('.') && !ALLOWED_DOT.has(e.name)) || e.isSymbolicLink()) continue;
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.dirs.push(rel);
        const sub = walk(path.join(dir, e.name), rel);
        out.files.push(...sub.files);
        out.dirs.push(...sub.dirs);
      } else if (e.isFile()) {
        out.files.push({ path: rel, size: fs.statSync(path.join(dir, e.name)).size, editable: isEditable(rel) });
      }
    }
    return out;
  }

  function list() {
    const { files, dirs } = walk();
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files, dirs: dirs.sort() };
  }
  const usage = () => {
    const { files } = walk();
    return { files: files.length, bytes: files.reduce((s, f) => s + f.size, 0) };
  };

  function touch() {
    try { const now = new Date(); fs.utimesSync(root, now, now); } catch { /* raiz ainda não existe */ }
  }
  function log(op, p, bytes = 0) {
    fs.mkdirSync(hist, { recursive: true });
    const file = path.join(hist, 'changes.jsonl');
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), op, path: p, bytes }) + '\n');
    try {
      if (fs.statSync(file).size > 256 * 1024) {
        const last = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-200);
        fs.writeFileSync(file, last.join('\n') + '\n');
      }
    } catch { /* melhor esforço */ }
    touch();
  }
  function backup(p) {
    const src = abs(p);
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(hist, { recursive: true });
    const stamp = `${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
    fs.copyFileSync(src, path.join(hist, `${stamp}__${p.replace(/\//g, '__')}`));
    const old = fs.readdirSync(hist).filter((n) => /^\d+-/.test(n)).sort();
    for (const n of old.slice(0, Math.max(0, old.length - limits.maxBackups))) fs.rmSync(path.join(hist, n), { force: true });
  }

  function put(p, buf, op) {
    if (buf.length > limits.maxFileBytes) throw new WorkspaceError(`Arquivo grande demais (máximo ${Math.round(limits.maxFileBytes / 1024)} KB).`, 413);
    fs.mkdirSync(root, { recursive: true });
    assertNoSymlink(p);
    const target = abs(p);
    let existing = null;
    try { existing = fs.lstatSync(target); } catch { /* novo arquivo */ }
    if (existing && !existing.isFile()) throw new WorkspaceError('Já existe uma pasta com esse nome.', 409);
    const u = usage();
    if (!existing && u.files >= limits.maxFiles) throw new WorkspaceError(`Limite de ${limits.maxFiles} arquivos atingido.`, 413);
    if (u.bytes - (existing ? existing.size : 0) + buf.length > limits.maxTotalBytes) throw new WorkspaceError('Limite de armazenamento do projeto atingido.', 413);
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); }
    catch { throw new WorkspaceError('Não foi possível criar a pasta (há um arquivo com esse nome no caminho).', 409); }
    if (existing) backup(p);
    fs.mkdirSync(hist, { recursive: true });
    const tmp = path.join(hist, `tmp-${crypto.randomBytes(6).toString('hex')}`);
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, target); // gravação atômica
    log(existing ? 'update' : 'create', p, buf.length);
    return { path: p, bytes: buf.length, created: !existing };
  }

  function write(rel, content) {
    const p = cleanPath(rel);
    if (!isEditable(p)) throw new WorkspaceError(`Extensão não permitida (${extOf(p) || 'sem extensão'}).`);
    if (typeof content !== 'string') throw new WorkspaceError('O conteúdo deve ser texto.');
    return put(p, Buffer.from(content, 'utf8'), 'write');
  }
  function writePdf(rel, buf) {
    const p = cleanPath(rel);
    if (extOf(p) !== '.pdf') throw new WorkspaceError('O arquivo deve terminar em .pdf.');
    return put(p, buf, 'pdf');
  }

  function readRaw(rel) {
    const p = cleanPath(rel);
    assertNoSymlink(p);
    let st;
    try { st = fs.statSync(abs(p)); } catch { throw new WorkspaceError('Arquivo não encontrado.', 404); }
    if (!st.isFile()) throw new WorkspaceError('Arquivo não encontrado.', 404);
    if (st.size > limits.maxTotalBytes) throw new WorkspaceError('Arquivo grande demais.', 413);
    return { path: p, buf: fs.readFileSync(abs(p)) };
  }
  function read(rel) {
    const { path: p, buf } = readRaw(rel);
    if (!isEditable(p)) throw new WorkspaceError('Tipo de arquivo não suportado para leitura como texto (PDFs e binários: use o download).', 415);
    if (buf.includes(0)) throw new WorkspaceError('Arquivo binário: use o download.', 415);
    if (buf.length > limits.maxFileBytes) throw new WorkspaceError('Arquivo grande demais para abrir.', 413);
    return { path: p, content: buf.toString('utf8') };
  }

  function patch(rel, oldText, newText) {
    if (typeof oldText !== 'string' || !oldText) throw new WorkspaceError('old_text não pode ser vazio.');
    if (typeof newText !== 'string') throw new WorkspaceError('new_text deve ser texto.');
    const { path: p, content } = read(rel);
    const count = content.split(oldText).length - 1;
    if (count === 0) throw new WorkspaceError('O trecho old_text não foi encontrado. Leia o arquivo de novo e copie o trecho exato.', 409);
    if (count > 1) throw new WorkspaceError(`O trecho old_text aparece ${count} vezes. Inclua mais contexto para torná-lo único.`, 409);
    return write(p, content.replace(oldText, () => newText));
  }

  function mkdir(rel) {
    const p = cleanPath(rel);
    fs.mkdirSync(root, { recursive: true });
    assertNoSymlink(p);
    try { fs.mkdirSync(abs(p), { recursive: true }); }
    catch { throw new WorkspaceError('Não foi possível criar a pasta.', 409); }
    log('mkdir', p);
    return { path: p };
  }

  function remove(rel) {
    const p = cleanPath(rel);
    assertNoSymlink(p);
    let st;
    try { st = fs.lstatSync(abs(p)); } catch { throw new WorkspaceError('Arquivo não encontrado.', 404); }
    if (st.isDirectory()) {
      for (const f of walk(abs(p), p).files) backup(f.path);
      fs.rmSync(abs(p), { recursive: true, force: true });
    } else {
      backup(p);
      fs.rmSync(abs(p), { force: true });
    }
    log('delete', p);
    return { path: p };
  }

  function rename(fromRel, toRel) {
    const from = cleanPath(fromRel);
    const to = cleanPath(toRel);
    assertNoSymlink(from); assertNoSymlink(to);
    if (!fs.existsSync(abs(from))) throw new WorkspaceError('Arquivo não encontrado.', 404);
    if (fs.existsSync(abs(to))) throw new WorkspaceError('Já existe um arquivo com o novo nome.', 409);
    if (!isEditable(to) && !BINARY_OK.has(extOf(to))) throw new WorkspaceError(`Extensão não permitida (${extOf(to) || 'sem extensão'}).`);
    try { fs.mkdirSync(path.dirname(abs(to)), { recursive: true }); } catch { throw new WorkspaceError('Pasta de destino inválida.', 409); }
    fs.renameSync(abs(from), abs(to));
    log('rename', `${from} -> ${to}`);
    return { from, to };
  }

  function changes(limit = 50) {
    try {
      return fs.readFileSync(path.join(hist, 'changes.jsonl'), 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l)).reverse();
    } catch { return []; }
  }

  // Revisão estática automática do site antes da entrega. Não executa scripts do usuário.
  function reviewWebsite() {
    const issues = [];
    const warnings = [];
    const files = list().files;
    const byPath = new Map(files.map((f) => [f.path, f]));
    const htmlFiles = files.filter((f) => /\.html?$/i.test(f.path));
    if (!byPath.has('index.html')) issues.push({ severity: 'error', code: 'missing-index', message: 'O projeto não contém index.html na raiz.' });
    if (!htmlFiles.length) issues.push({ severity: 'error', code: 'missing-html', message: 'Nenhum arquivo HTML foi encontrado.' });

    for (const file of htmlFiles) {
      const html = read(file.path).content;
      const hasTitle = /<title\b[^>]*>\s*[^<]+/i.test(html);
      const hasViewport = /<meta\s+[^>]*name=["']viewport["']/i.test(html);
      const hasLang = /<html\b[^>]*\blang=["'][^"']+/i.test(html);
      const hasMain = /<main\b/i.test(html);
      const hasHeading = /<h1\b/i.test(html);
      if (!hasTitle) issues.push({ severity: 'error', code: 'missing-title', path: file.path, message: 'Adicione um <title> descritivo.' });
      if (!hasViewport) issues.push({ severity: 'error', code: 'missing-viewport', path: file.path, message: 'Falta a meta viewport para responsividade em celulares.' });
      if (!hasLang) warnings.push({ code: 'missing-lang', path: file.path, message: 'Defina o idioma no elemento <html>.' });
      if (!hasMain) warnings.push({ code: 'missing-main', path: file.path, message: 'Considere organizar o conteúdo principal dentro de <main>.' });
      if (!hasHeading) warnings.push({ code: 'missing-h1', path: file.path, message: 'A página não tem um título principal <h1>.' });
      if (!/<\/body\s*>/i.test(html) || !/<\/html\s*>/i.test(html)) issues.push({ severity: 'error', code: 'unclosed-document', path: file.path, message: 'Documento HTML sem fechamento de body/html.' });
      const ids = [...html.matchAll(/\bid=["']([^"']+)["']/gi)].map((m) => m[1]);
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      if (dupes.length) issues.push({ severity: 'error', code: 'duplicate-ids', path: file.path, message: `IDs duplicados: ${[...new Set(dupes)].join(', ')}.` });
      for (const m of html.matchAll(/\bhref=["']#([^"']+)["']/gi)) {
        if (m[1] && !ids.includes(m[1])) warnings.push({ code: 'broken-anchor', path: file.path, message: `Link interno #${m[1]} não encontra um elemento com esse ID.` });
      }
      for (const m of html.matchAll(/<(?:link|script)\b[^>]*(?:href|src)=["']([^"']+)["'][^>]*>/gi)) {
        const asset = m[1];
        if (/^(?:https?:)?\/\//i.test(asset) || /^(?:data:|#)/i.test(asset)) continue;
        const clean = asset.split(/[?#]/)[0].replace(/^\.\//, '');
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), clean));
        if (resolved.startsWith('../') || !byPath.has(resolved)) warnings.push({ code: 'missing-asset', path: file.path, message: `Recurso referenciado não encontrado: ${asset}.` });
      }
    }

    const cssFiles = files.filter((f) => /\.css$/i.test(f.path));
    const cssText = cssFiles.map((f) => read(f.path).content).join('\n');
    const inlineStyles = htmlFiles.some((f) => /<style\b/i.test(read(f.path).content));
    const hasCss = cssFiles.length > 0 || inlineStyles;
    if (!hasCss) issues.push({ severity: 'error', code: 'missing-styles', message: 'Nenhum CSS foi encontrado; a página pode estar sem identidade visual.' });
    if (hasCss && !/@media\b/i.test(cssText) && !htmlFiles.some((f) => /<style\b[^>]*>[\s\S]*?@media\b/i.test(read(f.path).content))) {
      issues.push({ severity: 'error', code: 'missing-responsive-css', message: 'Não foi encontrada media query CSS para adaptar o layout a telas menores.' });
    }
    if (hasCss && !/(?:display\s*:\s*(?:grid|flex)|\.container|\.wrapper)/i.test(cssText) && !htmlFiles.some((f) => /<style\b[^>]*>[\s\S]*?(?:display\s*:\s*(?:grid|flex)|\.container|\.wrapper)/i.test(read(f.path).content))) {
      warnings.push({ code: 'basic-layout', message: 'Não foi detectada uma estrutura de layout comum (grid/flex/container); confira o acabamento visual.' });
    }
    // Qualidade de acabamento (avisos, não bloqueiam a entrega): o que separa um site comum de um profissional.
    const allHtml = htmlFiles.map((f) => read(f.path).content).join('\n');
    const allCss = cssText + '\n' + [...allHtml.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
    if (/lorem ipsum|seu texto aqui|your text here|empresa x\b|nome do produto/i.test(allHtml)) warnings.push({ code: 'placeholder-copy', message: 'Há texto de exemplo (lorem ipsum ou placeholder). Troque por conteúdo específico e realista.' });
    if ((allHtml.match(/\bhref=["']#["']/gi) || []).length > 2) warnings.push({ code: 'dead-links', message: 'Vários links apontam para "#". Aponte para seções reais ou páginas existentes.' });
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(allHtml.replace(/<script[\s\S]*?<\/script>/gi, ''))) warnings.push({ code: 'emoji-icons', message: 'Emojis aparecem na interface. Use ícones SVG consistentes.' });
    if (/<img\b(?![^>]*\balt=)/i.test(allHtml)) warnings.push({ code: 'img-alt', message: 'Há imagens sem atributo alt.' });
    if (/<img\b[^>]*\bsrc=["']https?:/i.test(allHtml)) warnings.push({ code: 'external-image', message: 'Há imagens de URLs externas, que podem não carregar. Prefira SVG, CSS ou data URI.' });
    if (htmlFiles.length && !/<meta\s+[^>]*name=["']description["']/i.test(allHtml)) warnings.push({ code: 'meta-description', message: 'Adicione <meta name="description"> para SEO e pré-visualização.' });
    if (hasCss && !/:root\s*\{[^}]*--[\w-]+\s*:/i.test(allCss)) warnings.push({ code: 'design-tokens', message: 'Defina tokens de design (variáveis CSS em :root) para cor, espaçamento e tipografia.' });
    if (hasCss && !/:focus-visible/i.test(allCss)) warnings.push({ code: 'focus-visible', message: 'Falta estilo de foco visível (:focus-visible) para navegação por teclado.' });
    if (hasCss && /@keyframes|animation\s*:|transition\s*:/i.test(allCss) && !/prefers-reduced-motion/i.test(allCss)) warnings.push({ code: 'reduced-motion', message: 'Há animações sem tratamento de prefers-reduced-motion.' });
    if (hasCss && allCss.replace(/\s+/g, '').length < 3500) warnings.push({ code: 'thin-styles', message: 'O CSS é muito curto para um acabamento profissional (tipografia, camadas, estados e responsividade).' });
    if (byPath.has('index.html')) {
      const idx = read('index.html').content;
      if ((idx.match(/<section\b/gi) || []).length < 4 && /landing|site|empresa|produto/i.test(idx.slice(0, 4000))) warnings.push({ code: 'few-sections', message: 'A página inicial tem poucas seções. Uma landing completa costuma ter hero, prova social, recursos, como funciona, preços/planos, FAQ e chamada final.' });
      if (!/<nav\b/i.test(idx)) warnings.push({ code: 'missing-nav', path: 'index.html', message: 'Não há <nav> de navegação.' });
      if (!/<footer\b/i.test(idx)) warnings.push({ code: 'missing-footer', path: 'index.html', message: 'Não há <footer>.' });
    }
    const jsFiles = files.filter((f) => /\.m?js$/i.test(f.path));
    for (const f of jsFiles) {
      const source = read(f.path).content;
      try { new (require('node:vm').Script)(source, { filename: f.path }); }
      catch (e) { issues.push({ severity: 'error', code: 'js-syntax', path: f.path, message: `Erro de sintaxe JavaScript: ${e.message.slice(0, 240)}` }); }
    }
    return { ok: issues.length === 0, checked: { html: htmlFiles.length, css: cssFiles.length, javascript: jsFiles.length }, issues, warnings,
      note: 'Revisão estática: não executa JavaScript nem substitui teste visual em navegador real.' };
  }

  function exportZip() {
    const { files } = walk();
    return createZip(files.map((f) => ({ name: f.path, data: fs.readFileSync(abs(f.path)) })));
  }

  function destroy() { fs.rmSync(root, { recursive: true, force: true }); }

  return { list, usage, read, readRaw, write, writePdf, patch, mkdir, remove, rename, changes, reviewWebsite, exportZip, destroy, touch };
}

// Remove espaços de trabalho sem uso há mais de maxAgeMs (política de retenção).
function purgeIdle(clientsDir, maxAgeMs) {
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(clientsDir); } catch { return 0; }
  for (const n of names) {
    const dir = path.join(clientsDir, n);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > maxAgeMs) { fs.rmSync(dir, { recursive: true, force: true }); removed++; }
    } catch { /* ignora */ }
  }
  return removed;
}

module.exports = { createWorkspace, purgeIdle, cleanPath, WorkspaceError, LIMITS, EDITABLE };
