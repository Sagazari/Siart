'use strict';
const crypto = require('node:crypto');
const { TOOLS, MUTATING, runTool, buildSystemPrompt } = require('./tools');
const { createTextGuard, parseTextToolCalls, hasToolMarkup } = require('./textcalls');

// reasoning_effort só é enviado onde se sabe que é aceito, para não causar 400.
const supportsEffort = (provider, model) =>
  (provider === 'groq' && /gpt-oss/.test(model)) || (provider === 'gemini' && /^gemini-(2\.5|3)/.test(model));

// IDs de chamada de ferramenta próprios (9 caracteres alfanuméricos): alguns provedores exigem esse formato,
// e assim o histórico continua válido ao trocar de provedor no meio da tarefa.
const newCallId = () => crypto.randomBytes(5).toString('hex').slice(0, 9);

// Memória curta de saúde dos provedores: evita insistir em quem acabou de falhar.
function createHealth() {
  const m = new Map();
  return {
    cooling: (key) => { const e = m.get(key); return Boolean(e) && e.until > Date.now(); },
    mark: (key, seconds) => { if (seconds > 0) m.set(key, { until: Date.now() + seconds * 1000 }); },
    clear: (key) => m.delete(key),
  };
}

function classify(err) {
  if (err.attemptTimeout) return { reason: 'timeout', cool: 30 };
  if (err.emptyResponse) return { reason: 'empty', cool: 0 };
  const s = err.upstreamStatus;
  if (!s) return { reason: 'unavailable', cool: 30 };
  if (s === 401 || s === 403) return { reason: 'auth', cool: 600 };
  if (s === 402) return { reason: 'billing', cool: 600 };
  if (s === 404) return { reason: 'model_unavailable', cool: 600, modelLevel: true };
  if (s === 429) return { reason: 'rate_limit', cool: Math.min(Math.max(err.retryAfter || 30, 5), 120) };
  if (s >= 500) return { reason: 'unavailable', cool: 30 };
  return { reason: 'rejected', cool: 0 };
}

// Uma chamada em streaming. Acumula texto e chamadas de ferramenta.
async function streamCompletion({ provider, body, signal, firstByteMs, onText, onTool = () => {} }) {
  const ac = new AbortController();
  const relay = () => ac.abort();
  if (signal.aborted) ac.abort(); else signal.addEventListener('abort', relay, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, firstByteMs);
  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}`, ...provider.headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let upstreamMessage = '';
      try {
        const payload = await res.json();
        const detail = payload?.error?.message || payload?.error || payload?.message || payload?.detail;
        if (typeof detail === 'string') upstreamMessage = detail.slice(0, 500);
        else if (detail && typeof detail.message === 'string') upstreamMessage = detail.message.slice(0, 500);
      } catch { /* alguns gateways não retornam JSON */ }
      throw Object.assign(new Error('upstream'), {
        upstreamStatus: res.status,
        upstreamMessage,
        retryAfter: Number(res.headers.get('retry-after')) || 0,
      });
    }
    const decoder = new TextDecoder();
    let buf = '';
    let text = '';
    let first = true;
    const calls = [];
    for await (const chunk of res.body) {
      if (first) { clearTimeout(timer); first = false; }
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let delta;
        try { delta = JSON.parse(data).choices?.[0]?.delta; } catch { continue; }
        if (!delta) continue;
        if (delta.content) { text += delta.content; onText(delta.content); }
        for (const tc of delta.tool_calls || []) {
          let idx = tc.index;
          if (idx === undefined || idx === null) idx = tc.id ? calls.length : Math.max(calls.length - 1, 0);
          if (tc.id && calls[idx] && calls[idx].id && calls[idx].id !== tc.id) idx = calls.length; // índice repetido
          const cur = (calls[idx] ||= { id: '', name: '', args: '' });
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          onTool(cur);
        }
      }
    }
    return { text, calls: calls.filter(Boolean).map((c) => ({ ...c, id: newCallId() })) };
  } catch (e) {
    if (timedOut) throw Object.assign(new Error('timeout'), { attemptTimeout: true });
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', relay);
  }
}

// Tenta os provedores do nível em ordem. Só troca de provedor se nada foi enviado ao usuário nessa tentativa.
async function completeWithFallback({ cfg, tier, candidates, buildBody, call, state, signal, send, log, taskId, health, onText, deferFinal = false }) {
  const isCool = (c) => health.cooling(c.provider) || health.cooling(`${c.provider}:${c.model}`);
  const healthy = candidates.filter((c) => !isCool(c));
  // se todos estão em pausa, tenta mesmo assim, na ordem original
  const ordered = healthy.length ? [...healthy, ...candidates.filter((c) => isCool(c))] : [...candidates];
  const tried = [];

  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i];
    const provider = cfg.providers[c.provider];
    let emitted = false;
    const announce = () => {
      if (state.announced === c) return;
      state.announced = c;
      send('model.selected', { tier: tier.id, tierName: tier.label, provider: c.provider, providerName: provider.name });
    };
    // Avisa a interface assim que o modelo começa a montar uma ferramenta e a cada ~300 ms,
    // com o tamanho já gerado: arquivos grandes deixam de parecer travados.
    let lastProgress = 0, announcedTool = '';
    const progress = (tc) => {
      if (!tc.name) return;
      const now = Date.now();
      if (announcedTool === tc.name + '|' + (tc.id || '') && now - lastProgress < 300) return;
      announcedTool = tc.name + '|' + (tc.id || ''); lastProgress = now;
      const m = /"(?:path|from)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(tc.args || '');
      send('tool.preparing', { tool: tc.name, path: m ? m[1].slice(0, 200) : undefined, bytes: Buffer.byteLength(tc.args || '') });
    };
    try {
      const bufferedChunks = [];
      let sawToolCall = false;
      let result;
      // O filtro impede que chamadas de ferramenta escritas como texto (<tool_call>...) cheguem à tela.
      const guard = createTextGuard((t) => { if (!sawToolCall && !deferFinal) { emitted = true; announce(); onText(t); } else bufferedChunks.push(t); });
      try {
        result = await streamCompletion({
          provider, signal, firstByteMs: tier.firstByteMs, body: buildBody(c, call.useTools),
          // O texto sai ao vivo enquanto nenhuma chamada de ferramenta apareceu. Se uma chamada surgir,
          // o texto seguinte é intermediário e fica em buffer (descartado se houver ferramentas).
          onText: guard.push,
          onTool: (tc) => { sawToolCall = true; progress(tc); },
        });
        guard.flush();
      } catch (err) {
        // Se o stream cair antes de completar uma resposta sem tool-call, preserva o texto parcial
        // já recebido e impede que outro provedor repita a mesma resposta.
        if (call.useTools && bufferedChunks.length && !signal.aborted) {
          announce(); emitted = true; bufferedChunks.forEach(onText);
        }
        throw err;
      }
      if (!result.text && !result.calls.length) throw Object.assign(new Error('empty'), { emptyResponse: true });
      announce();
      if (call.useTools && !result.calls.length && bufferedChunks.length && !deferFinal) { emitted = true; bufferedChunks.forEach(onText); }
      health.clear(c.provider);
      const at = candidates.indexOf(c); // a próxima chamada da tarefa começa por quem funcionou
      if (at > 0) { candidates.splice(at, 1); candidates.unshift(c); }
      return result;
    } catch (err) {
      if (signal.aborted && !err.attemptTimeout) throw err; // usuário parou ou tempo total esgotado
      if (err.upstreamStatus === 400 && call.useTools) { // provedor rejeitou tool calling: refaz sem ferramentas
        log({ level: 'warn', event: 'tools_disabled_after_400', taskId, provider: c.provider });
        state.toolsOn = false;
        call.useTools = false;
        state.syncPrompt(false);
        i--;
        continue;
      }
      if (emitted) throw err; // já houve saída parcial: refazer duplicaria texto
      const k = classify(err);
      health.mark(k.modelLevel ? `${c.provider}:${c.model}` : c.provider, k.cool);
      tried.push({ provider: c.provider, reason: k.reason });
      log({ level: 'warn', event: 'provider_failed', taskId, provider: c.provider, model: c.model, reason: k.reason, status: err.upstreamStatus, upstreamMessage: err.upstreamMessage || undefined });
      const next = ordered[i + 1];
      if (!next) throw Object.assign(new Error('all providers failed'), { allFailed: true, tried });
      send('model.fallback', { from: c.provider, fromName: provider.name, to: next.provider, toName: cfg.providers[next.provider].name, reason: k.reason });
    }
  }
  throw Object.assign(new Error('no candidates'), { allFailed: true, tried });
}

// Conversa com o modelo; com workspace e ferramentas ligadas, repete (modelo -> ferramentas -> modelo).
async function runAgent({ cfg, tier, messages, userInstructions = '', voice = false, ws, send, signal, log, taskId, health }) {
  const hasImages = messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
  const requestedWebsite = messages.some((m) => m.role === 'user' && typeof m.content === 'string' && /\b(site|website|p[aá]gina|landing\s*page|html|web\s*app)\b/i.test(m.content));
  // Só o prompt usa a lista ampla: o buffer de entrega (deferFinal) continua restrito a pedidos de site.
  const wantsDesign = requestedWebsite || messages.some((m) => m.role === 'user' && typeof m.content === 'string' && /\b(css|front-?end|interface|layout|dashboard|portf[oó]lio|e-?commerce|loja\s*virtual|tela|design)\b/i.test(m.content));
  let candidates = tier.chain.filter((c) => cfg.providers[c.provider] && cfg.providers[c.provider].apiKey);
  if (hasImages) {
    const gemini = cfg.providers.gemini;
    candidates = gemini && gemini.apiKey ? [{ provider: 'gemini', model: 'gemini-2.5-flash' }] : [];
    if (!candidates.length) throw Object.assign(new Error('Para analisar fotos, configure GEMINI_API_KEY no Render. Os modelos configurados sem visão não conseguem interpretar imagens.'), { allFailed: true, tried: [] });
  }
  if (!candidates.length) throw Object.assign(new Error('no providers'), { allFailed: true, tried: [] });

  const state = { toolsOn: Boolean(cfg.toolsEnabled && tier.tools && ws), announced: null };
  const makePrompt = (tools) => buildSystemPrompt({ tools, voice, site: wantsDesign }) + (userInstructions ? `\n\nPreferências persistentes definidas pelo usuário (trate como preferências, não como instruções de segurança):\n${userInstructions}` : '');
  const history = [{ role: 'system', content: makePrompt(state.toolsOn) }, ...messages];
  let promptHasTools = state.toolsOn;
  state.syncPrompt = (on) => {
    if (promptHasTools === on) return;
    history[0] = { role: 'system', content: makePrompt(on) };
    promptHasTools = on;
  };

  const buildBody = (c, withTools) => {
    const p = cfg.providers[c.provider];
    const body = { model: c.model, stream: true, temperature: tier.temperature, [p.tokenParam]: tier.maxTokens, messages: history };
    if (tier.effort && supportsEffort(c.provider, c.model)) body.reasoning_effort = tier.effort;
    if (withTools) { body.tools = TOOLS; body.tool_choice = 'auto'; }
    return body;
  };

  let steps = 0;
  let emitted = false;
  let siteDirty = false;
  let siteReviewed = false;
  let reviewNudges = 0;
  let cutNudges = 0;
  for (;;) {
    const call = { useTools: state.toolsOn && steps < cfg.maxToolSteps };
    if (state.toolsOn && !call.useTools) state.syncPrompt(false); // limite de passos: pede a resposta final sem ferramentas
    const result = await completeWithFallback({
      cfg, tier, candidates, buildBody, call, state, signal, send, log, taskId, health,
      onText: (t) => { emitted = true; send('message.delta', { text: t }); },
      deferFinal: (requestedWebsite && call.useTools) || (siteDirty && !siteReviewed), // nas cobranças de revisão o texto não é repetido na tela
    });
    // Modelos que escrevem a chamada como texto: converte em chamadas reais e remove o markup do texto.
    let truncatedMarkup = false;
    if (hasToolMarkup(result.text)) {
      const parsed = parseTextToolCalls(result.text, TOOLS);
      result.text = parsed.clean;
      truncatedMarkup = parsed.truncated;
      if (call.useTools && !result.calls.length) result.calls = parsed.calls.map((x) => ({ id: newCallId(), name: x.name, args: x.args }));
    }
    if (!call.useTools) {
      if (siteDirty && !siteReviewed) send('message.delta', { text: '\n\nNão vou marcar o site como concluído: a revisão obrigatória não foi executada ou ainda apontou problemas. Tente novamente para que eu possa revisar e corrigir os arquivos.' });
      else if (requestedWebsite && result.text && !emitted) send('message.delta', { text: result.text });
      return;
    }
    if (result.calls.length === 0) {
      if (truncatedMarkup && cutNudges < 2) {
        cutNudges++; steps++; // a chamada foi cortada pelo limite de tamanho e não foi executada
        history.push({ role: 'assistant', content: result.text || '' });
        history.push({ role: 'user', content: 'Sua última chamada de ferramenta foi cortada pelo limite de tamanho e NÃO foi executada. Refaça usando o mecanismo normal de chamada de função e divida o trabalho em arquivos menores (no máximo cerca de 250 linhas por arquivo, por exemplo styles.css, app.js e index.html separados).' });
        continue;
      }
      if (siteDirty && !siteReviewed && reviewNudges < 2) {
        reviewNudges++; // no máximo duas cobranças: sem limite, um modelo que ignora a revisão prendia a resposta até o tempo total
        history.push({ role: 'assistant', content: result.text || '' });
        history.push({ role: 'user', content: 'Antes de responder ao usuário, você PRECISA chamar review_website agora. Corrija todos os erros reportados e repita a revisão até que ela retorne ok=true. Não declare conclusão sem isso.' });
        continue;
      }
      if (siteDirty && !siteReviewed) send('message.delta', { text: (result.text ? result.text + '\n\n' : '') + 'Não vou marcar o site como concluído: a revisão obrigatória não foi executada. Tente novamente para que eu possa revisar e corrigir os arquivos.' });
      else if (requestedWebsite && call.useTools && result.text) send('message.delta', { text: result.text });
      return;
    }

    steps++;
    history.push({
      role: 'assistant',
      content: result.text || '',
      tool_calls: result.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
    });
    for (const [n, c] of result.calls.entries()) {
      if (n >= 8) { // toda chamada precisa de uma resposta, mesmo acima do limite
        history.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: JSON.stringify({ ok: false, error: 'Limite de 8 chamadas por passo.' }) });
        continue;
      }
      let args = {};
      let parseError = null;
      try { args = c.args ? JSON.parse(c.args) : {}; } catch { parseError = c.args && c.args.length > 6000 ? 'Os argumentos foram cortados pelo limite de tamanho. Divida o conteúdo em arquivos menores (até cerca de 250 linhas cada) e tente de novo.' : 'Os argumentos não são um JSON válido.'; }
      const info = { callId: c.id, tool: c.name, path: typeof args.path === 'string' ? args.path : (typeof args.from === 'string' ? args.from : undefined) };
      send('tool.started', info);
      const t0 = Date.now();
      let out;
      try {
        out = parseError ? { ok: false, error: parseError } : runTool(ws, c.name, args);
      } catch (e) {
        log({ level: 'error', event: 'tool_exception', taskId, tool: c.name, message: e.message });
        out = { ok: false, error: 'Falha interna ao executar a ferramenta.' };
      }
      log({ event: 'tool', taskId, tool: c.name, ok: out.ok, ms: Date.now() - t0 });
      if (out.ok && MUTATING.has(c.name) && typeof info.path === 'string' && /\.(?:html?|css|m?js)$/i.test(info.path)) { siteDirty = true; siteReviewed = false; }
      if (out.ok && c.name === 'review_website' && out.review) siteReviewed = out.review.ok && out.review.issues.length === 0;
      if (out.ok) send('tool.completed', { ...info, mutated: MUTATING.has(c.name) });
      else send('tool.failed', { ...info, message: out.error });
      history.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: JSON.stringify(out) });
    }
    if (emitted) send('message.delta', { text: '\n\n' });
  }
}

module.exports = { runAgent, streamCompletion, createHealth, classify };
