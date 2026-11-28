'use strict';
const { WorkspaceError, EDITABLE } = require('./workspace');
const { generatePdf, validatePdf } = require('./pdf');
const { buildSystemPrompt: promptBuilder } = require('./prompt');

const str = (description) => ({ type: 'string', description });
const fn = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

const TOOLS = [
  fn('list_project_files', 'Lista os arquivos e pastas do projeto do usuário.', {}),
  fn('review_website', 'Revisa estaticamente o site antes da entrega: HTML, metadados, responsividade, links e sintaxe JavaScript. Use obrigatoriamente depois de criar ou alterar um site; corrija todos os erros e execute a revisão novamente.', {}),
  fn('read_project_file', 'Lê o conteúdo de um arquivo de texto do projeto.', { path: str('Caminho relativo, ex.: src/app.js') }, ['path']),
  fn('write_project_file', 'Cria um arquivo ou substitui o conteúdo inteiro de um arquivo existente. Para mudanças pequenas prefira apply_file_patch.',
    { path: str('Caminho relativo'), content: str('Conteúdo completo do arquivo') }, ['path', 'content']),
  fn('apply_file_patch', 'Troca um trecho exato e único de um arquivo existente por outro texto.',
    { path: str('Caminho relativo'), old_text: str('Trecho exato a substituir (deve aparecer uma única vez)'), new_text: str('Texto novo') }, ['path', 'old_text', 'new_text']),
  fn('create_project_directory', 'Cria uma pasta no projeto.', { path: str('Caminho relativo da pasta') }, ['path']),
  fn('rename_project_file', 'Renomeia ou move um arquivo dentro do projeto (não sobrescreve).', { from: str('Caminho atual'), to: str('Novo caminho') }, ['from', 'to']),
  fn('generate_pdf', 'Gera um PDF de texto (títulos com #, listas com -, parágrafos) e o salva no projeto.',
    { path: str('Caminho do PDF, terminando em .pdf'), title: str('Título do documento'), content: str('Texto do documento em Markdown simples') }, ['path', 'content']),
];

const MUTATING = new Set(['write_project_file', 'apply_file_patch', 'create_project_directory', 'rename_project_file', 'generate_pdf']);
const MAX_RESULT_CHARS = 20000;

function needStrings(args, keys) {
  if (!args || typeof args !== 'object') throw new WorkspaceError('Argumentos inválidos.');
  for (const k of keys) if (typeof args[k] !== 'string') throw new WorkspaceError(`O argumento "${k}" é obrigatório e deve ser texto.`);
}

// Executa uma ferramenta. Nunca lança por erro previsível: devolve { ok:false, error }.
function runTool(ws, name, args) {
  try {
    switch (name) {
      case 'list_project_files': {
        const { files, dirs } = ws.list();
        return { ok: true, files: files.map((f) => ({ path: f.path, bytes: f.size })), dirs };
      }
      case 'review_website': {
        const report = ws.reviewWebsite();
        return { ok: true, review: report };
      }
      case 'read_project_file': {
        needStrings(args, ['path']);
        const r = ws.read(args.path);
        const truncated = r.content.length > MAX_RESULT_CHARS;
        return { ok: true, path: r.path, content: truncated ? r.content.slice(0, MAX_RESULT_CHARS) : r.content, truncated };
      }
      case 'write_project_file': {
        needStrings(args, ['path', 'content']);
        return { ok: true, ...ws.write(args.path, args.content) };
      }
      case 'apply_file_patch': {
        needStrings(args, ['path', 'old_text', 'new_text']);
        return { ok: true, ...ws.patch(args.path, args.old_text, args.new_text) };
      }
      case 'create_project_directory': {
        needStrings(args, ['path']);
        return { ok: true, ...ws.mkdir(args.path) };
      }
      case 'rename_project_file': {
        needStrings(args, ['from', 'to']);
        return { ok: true, ...ws.rename(args.from, args.to) };
      }
      case 'generate_pdf': {
        needStrings(args, ['path', 'content']);
        if (args.content.length > 200000) throw new WorkspaceError('Conteúdo grande demais para o PDF.');
        const buf = generatePdf(args.content, { title: typeof args.title === 'string' ? args.title : '' });
        if (!validatePdf(buf)) throw new WorkspaceError('O PDF gerado é inválido.');
        return { ok: true, ...ws.writePdf(args.path, buf) };
      }
      default:
        return { ok: false, error: `Ferramenta desconhecida: ${name}.` };
    }
  } catch (e) {
    if (e instanceof WorkspaceError) return { ok: false, error: e.message };
    throw e;
  }
}

function buildSystemPrompt({ tools, voice = false } = {}) {
  return promptBuilder({ tools, voice, editable: [...EDITABLE] });
}

module.exports = { TOOLS, MUTATING, runTool, buildSystemPrompt };
