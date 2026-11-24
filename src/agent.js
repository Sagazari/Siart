'use strict';
const { TOOLS, MUTATING, runTool, buildSystemPrompt } = require('./tools');

// Faz uma chamada em streaming e acumula texto e chamadas de ferramenta.
async function streamCompletion({ url, apiKey, body, signal, onText }) {
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw Object.assign(new Error('upstream'), { upstreamStatus: res.status });
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  const calls = [];
  for await (const chunk of res.body) {
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
        const idx = tc.index ?? 0;
        const cur = (calls[idx] ||= { id: '', name: '', args: '' });
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
      }
    }
  }
  const done = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
  return { text, calls: done };
}

// Executa a conversa. Com workspace e ferramentas ligadas, repete (modelo -> ferramentas -> modelo)
// até a resposta final ou o limite de passos.
async function runAgent({ cfg, messages, ws, send, signal, log, taskId }) {
  let toolsOn = Boolean(cfg.toolsEnabled && ws);
  const history = [{ role: 'system', content: buildSystemPrompt({ tools: toolsOn }) }, ...messages];
  let steps = 0;
  let emitted = false;

  for (;;) {
    const useTools = toolsOn && steps < cfg.maxToolSteps;
    if (!useTools && toolsOn) { // limite atingido: pede a resposta final sem ferramentas
      history[0] = { role: 'system', content: buildSystemPrompt({ tools: false }) };
    }
    const body = {
      model: cfg.model, stream: true, temperature: 0.4, max_completion_tokens: cfg.maxTokens, messages: history,
      ...(useTools ? { tools: TOOLS, tool_choice: 'auto' } : {}),
    };
    let result;
    try {
      result = await streamCompletion({
        url: `${cfg.baseUrl}/chat/completions`, apiKey: cfg.apiKey, body, signal,
        onText: (t) => { if (!emitted) emitted = true; send('message.delta', { text: t }); },
      });
    } catch (err) {
      // Fluxo alternativo controlado: se o provedor rejeitar o tool calling, segue só com texto.
      if (err.upstreamStatus === 400 && useTools) {
        log({ level: 'warn', event: 'tools_disabled_after_400', taskId, steps });
        toolsOn = false;
        history[0] = { role: 'system', content: buildSystemPrompt({ tools: false }) };
        continue;
      }
      throw err;
    }
    if (!useTools || result.calls.length === 0) return;

    steps++;
    history.push({
      role: 'assistant',
      content: result.text || null,
      tool_calls: result.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
    });
    for (const [n, c] of result.calls.entries()) {
      if (n >= 8) { // toda chamada precisa de uma resposta, mesmo acima do limite
        history.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ ok: false, error: 'Limite de 8 chamadas por passo.' }) });
        continue;
      }
      let args = {};
      let parseError = null;
      try { args = c.args ? JSON.parse(c.args) : {}; } catch { parseError = 'Os argumentos não são um JSON válido.'; }
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
      if (out.ok) send('tool.completed', { ...info, mutated: MUTATING.has(c.name) });
      else send('tool.failed', { ...info, message: out.error });
      history.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(out) });
    }
    if (emitted) send('message.delta', { text: '\n\n' });
  }
}

module.exports = { runAgent, streamCompletion };
