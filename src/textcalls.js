'use strict';

// Alguns modelos (família Qwen, DeepSeek e outros) às vezes escrevem a chamada de ferramenta como TEXTO
// em vez de usar o campo estruturado da API, por exemplo:
//   <tool_call><function=write_project_file><parameter=path>a.md</parameter>...</function></tool_call>
// Este módulo (1) impede que esse markup apareça para o usuário durante o streaming e
// (2) converte o markup em chamadas reais, para que o trabalho aconteça em vez de virar lixo na tela.

const MARKERS = ['<tool_call', '<function=', '<parameter=', '<function_call', '<tool_use'];
const MAX_HOLD = Math.max(...MARKERS.map((m) => m.length)) - 1;
const OPEN_RE = /<tool_call|<function=|<parameter=|<function_call|<tool_use/;

const firstMarker = (s) => {
  let best = -1;
  for (const m of MARKERS) { const i = s.indexOf(m); if (i >= 0 && (best < 0 || i < best)) best = i; }
  return best;
};

// Filtro de streaming: repassa o texto normal e, ao ver o início de um marcador, para de repassar.
// Retém apenas o sufixo que ainda pode virar um marcador (por exemplo, "<tool_").
function createTextGuard(emit) {
  let held = '';
  let blocked = false;
  return {
    push(chunk) {
      if (blocked || !chunk) return;
      held += chunk;
      const idx = firstMarker(held);
      if (idx >= 0) { const before = held.slice(0, idx); held = ''; blocked = true; if (before) emit(before); return; }
      const lt = held.lastIndexOf('<');
      if (lt >= 0 && held.length - lt <= MAX_HOLD && MARKERS.some((m) => m.startsWith(held.slice(lt)))) {
        const out = held.slice(0, lt); held = held.slice(lt); if (out) emit(out);
      } else { const out = held; held = ''; emit(out); }
    },
    flush() { if (!blocked && held) emit(held); held = ''; },
    get blocked() { return blocked; },
  };
}

const hasToolMarkup = (text) => OPEN_RE.test(String(text || ''));

function schemaProps(tools, name) {
  const t = (tools || []).find((x) => x.function && x.function.name === name);
  return (t && t.function.parameters && t.function.parameters.properties) || {};
}

function coerce(value, type) {
  if (type === 'array' || type === 'object') { try { return JSON.parse(value); } catch { return value; } }
  if (type === 'boolean') return /^\s*true\s*$/i.test(value);
  if (type === 'integer' || type === 'number') { const n = Number(value); return Number.isFinite(n) ? n : value; }
  return value; // strings (conteúdo de arquivos, inclusive JSON) ficam intactas
}

function paramsFrom(body, props) {
  const out = {};
  const re = /<parameter=([\w.-]+)>\n?([\s\S]*?)\n?<\/parameter>/g;
  let m;
  while ((m = re.exec(body))) out[m[1]] = coerce(m[2], props[m[1]] && props[m[1]].type);
  return out;
}

function parseBody(body, tools) {
  const text = body.trim();
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text);
      const name = j.name || (j.function && j.function.name);
      let args = j.arguments !== undefined ? j.arguments : (j.parameters !== undefined ? j.parameters : (j.function && j.function.arguments));
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* mantém string */ } }
      if (typeof name === 'string') return { name, args: JSON.stringify(args && typeof args === 'object' ? args : {}) };
    } catch { /* tenta o formato XML */ }
  }
  const fn = /<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/.exec(text);
  if (fn) return { name: fn[1], args: JSON.stringify(paramsFrom(fn[2], schemaProps(tools, fn[1]))) };
  return null;
}

// Converte o markup em chamadas. `truncated` indica um bloco aberto e nunca fechado
// (saída cortada pelo limite de tokens): ele NÃO é executado, para não gravar arquivo pela metade.
function parseTextToolCalls(text, tools) {
  const calls = [];
  let clean = String(text || '');
  clean = clean.replace(/<tool_call>([\s\S]*?)<\/tool_call>/g, (_, body) => { const c = parseBody(body, tools); if (c) calls.push(c); return ''; });
  clean = clean.replace(/<function=([\w.-]+)>([\s\S]*?)<\/function>/g, (_, name, body) => { calls.push({ name, args: JSON.stringify(paramsFrom(body, schemaProps(tools, name))) }); return ''; });
  const open = clean.search(OPEN_RE);
  let truncated = false;
  if (open >= 0) { truncated = true; clean = clean.slice(0, open); }
  return { calls, clean: clean.trim(), truncated };
}

module.exports = { createTextGuard, parseTextToolCalls, hasToolMarkup };
