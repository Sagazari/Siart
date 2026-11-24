'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createZip } = require('./zip');

const LIMITS = { maxFiles: 200, maxFileBytes: 512 * 1024, maxTotalBytes: 5 * 1024 * 1024, maxDepth: 6, maxBackups: 100 };
const EDITABLE = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.md', '.txt', '.csv', '.svg', '.xml',
  '.yml', '.yaml', '.ts', '.tsx', '.jsx', '.py', '.sql', '.sh', '.toml']);
const BINARY_OK = new Set(['.pdf']);

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
    if (s.length > 100 || s.startsWith('.') || /[\u0000-\u001f<>:"|?*]/.test(s)) throw new WorkspaceError('Nome de arquivo ou pasta não permitido.');
  }
  return parts.join('/');
}

const extOf = (p) => path.extname(p).toLowerCase();
const isEditable = (p) => EDITABLE.has(extOf(p));

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
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
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

  function exportZip() {
    const { files } = walk();
    return createZip(files.map((f) => ({ name: f.path, data: fs.readFileSync(abs(f.path)) })));
  }

  function destroy() { fs.rmSync(root, { recursive: true, force: true }); }

  return { list, usage, read, readRaw, write, writePdf, patch, mkdir, remove, rename, changes, exportZip, destroy, touch };
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
