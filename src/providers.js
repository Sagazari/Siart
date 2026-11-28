'use strict';
// Provedores (todos com API compatível com OpenAI Chat Completions) e níveis de modelo.
// IDs de modelo conferidos na documentação de cada provedor em 24/11/2026. Catálogos mudam com frequência:
// por isso tudo é configurável por variáveis TIER_* e o servidor avisa no log quando um modelo não aparece na lista.

const PROVIDER_DEFS = {
  sambanova: { name: 'SambaNova', envKeys: ['SAMBANOVA_API_KEY'], envBase: 'SAMBANOVA_BASE_URL', base: 'https://api.sambanova.ai/v1', tokenParam: 'max_tokens' },
  groq: { name: 'Groq', envKeys: ['GROQ_API_KEY'], envBase: 'GROQ_BASE_URL', base: 'https://api.groq.com/openai/v1', tokenParam: 'max_completion_tokens' },
  gemini: { name: 'Gemini', envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], envBase: 'GEMINI_BASE_URL', base: 'https://generativelanguage.googleapis.com/v1beta/openai', tokenParam: 'max_tokens' },
  openrouter: { name: 'OpenRouter', envKeys: ['OPENROUTER_API_KEY'], envBase: 'OPENROUTER_BASE_URL', base: 'https://openrouter.ai/api/v1', tokenParam: 'max_tokens', headers: { 'HTTP-Referer': 'https://siartai.onrender.com', 'X-Title': 'Siart' } },
};

// Ordem de tentativa: o primeiro provedor configurado que responder é usado; se falhar, passa ao próximo.
const TIER_DEFS = {
  absoluty: {
    name: 'Absoluty GTI', version: '1.2',
    description: 'Absoluty Grand Technical Intelligence: nível de maior capacidade, com raciocínio alto e ferramentas para tarefas técnicas e complexas.',
    chain: 'gemini:gemini-2.5-pro,groq:openai/gpt-oss-120b,openrouter:nvidia/nemotron-3-ultra-550b-a55b:free,sambanova:gpt-oss-120b',
    temperature: 0.3, maxTokens: 16384, effort: 'high', tools: true, firstByteMs: 25_000,
  },
  moyenne: {
    name: 'Moyenne', version: '1',
    description: 'Equilíbrio entre qualidade e velocidade para o dia a dia.',
    chain: 'groq:openai/gpt-oss-120b,gemini:gemini-2.5-flash,openrouter:openai/gpt-oss-120b:free,sambanova:gpt-oss-120b',
    temperature: 0.4, maxTokens: 8192, effort: 'medium', tools: true, firstByteMs: 18_000,
  },
  basse: {
    name: 'Basse', version: '0.1',
    description: 'Rápida e simples: boa para conversa e dúvidas curtas, fraca em tarefas complexas. Não mexe nos arquivos do projeto.',
    chain: 'groq:openai/gpt-oss-20b,gemini:gemini-2.5-flash-lite,openrouter:openai/gpt-oss-20b:free,sambanova:gpt-oss-120b',
    temperature: 0.6, maxTokens: 2048, effort: 'low', tools: false, firstByteMs: 12_000,
  },
};

// "provedor:modelo,provedor:modelo". O modelo pode conter ":" (ex.: qwen/qwen3-coder:free).
function parseChain(text, warn = () => {}) {
  const chain = [];
  for (const raw of String(text || '').split(',')) {
    const item = raw.trim();
    if (!item) continue;
    const i = item.indexOf(':');
    const provider = i > 0 ? item.slice(0, i).trim().toLowerCase() : '';
    const model = i > 0 ? item.slice(i + 1).trim() : '';
    if (!PROVIDER_DEFS[provider] || !model) { warn(item); continue; }
    chain.push({ provider, model });
  }
  return chain;
}

function buildProviders(env = process.env) {
  const out = {};
  for (const [id, def] of Object.entries(PROVIDER_DEFS)) {
    const key = def.envKeys.map((k) => env[k]).find(Boolean) || '';
    out[id] = {
      id, name: def.name, apiKey: key, tokenParam: def.tokenParam, headers: def.headers || {},
      baseUrl: (env[def.envBase] || def.base).replace(/\/+$/, ''),
    };
  }
  return out;
}

function buildTiers(env = process.env, warn = () => {}) {
  const out = {};
  for (const [id, def] of Object.entries(TIER_DEFS)) {
    const up = id.toUpperCase();
    let chain = parseChain(env[`TIER_${up}`] || def.chain, (bad) => warn(id, bad));
    if (!chain.length) chain = parseChain(def.chain);
    const toolsEnv = env[`TIER_${up}_TOOLS`];
    const fb = Number(env[`TIER_${up}_FIRST_BYTE_MS`]);
    out[id] = {
      id, ...def, label: `${def.name} ${def.version}`, chain, firstByteMs: fb > 0 ? fb : def.firstByteMs,
      tools: toolsEnv === '1' ? true : toolsEnv === '0' ? false : def.tools,
    };
  }
  return out;
}

const tierAvailable = (tier, providers) => tier.chain.some((c) => providers[c.provider] && providers[c.provider].apiKey);

module.exports = { PROVIDER_DEFS, TIER_DEFS, parseChain, buildProviders, buildTiers, tierAvailable };
