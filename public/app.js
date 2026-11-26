'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const el = { sidebar: $('sidebar'), scrim: $('scrim'), list: $('chat-list'), title: $('title'), banner: $('banner'),
    messages: $('messages'), form: $('composer'), input: $('input'), send: $('send'), menu: $('menu'), newChat: $('new-chat') };
  const ui = { tiers: $('tiers'), tierHint: $('tier-hint'), notice: $('notice'), count: $('conv-count'), limitNote: $('limit-note'), limitText: $('limit-text'), limitNew: $('limit-new') };
  const STORE = 'siart.v1';
  const SUGGESTIONS = [
    'Explique este erro e como corrigi-lo',
    'Revise um trecho de código meu',
    'Ajude a planejar a arquitetura de um app',
  ];

  const REASON = { rate_limit: 'atingiu o limite de uso', unavailable: 'está indisponível', auth: 'não aceitou a chave', timeout: 'demorou demais', model_unavailable: 'não tem esse modelo', billing: 'está sem créditos', rejected: 'rejeitou a requisição', empty: 'não respondeu' };
  let tiers = [];
  let tierId = null;
  try { tierId = localStorage.getItem('siart.tier'); } catch { /* sem armazenamento */ }
  let limits = { maxConversations: 30, maxMessages: 40 };
  const seenChats = new Set();
  let noticeTimer = null;

  let state = load();
  let streaming = false;
  let controller = null;

  // ---------- Persistência (localStorage deste navegador) ----------
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE));
      if (s && Array.isArray(s.chats)) return s;
    } catch { /* armazenamento indisponível ou corrompido */ }
    return { chats: [], activeId: null };
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* cota cheia ou bloqueado */ }
  }
  const active = () => state.chats.find((c) => c.id === state.activeId) || null;

  // ---------- Markdown mínimo e seguro (tudo é escapado antes de virar HTML) ----------
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = (s) => esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  function tableBlock(lines) {
    const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((x) => x.trim());
    const head = cells(lines[0]);
    const body = lines.slice(2).filter((l) => l.includes('|')).map(cells);
    return '<div class="table-wrap"><table><thead><tr>' + head.map((x) => '<th>' + inline(x) + '</th>').join('') +
      '</tr></thead><tbody>' + body.map((r) => '<tr>' + head.map((_, i) => '<td>' + inline(r[i] || '') + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
  }
  function blocks(text) {
    const lines = text.split('\n');
    const out = [];
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      // Tabelas Markdown: cabeçalho + linha separadora + conteúdo.
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1]) && lines[i + 1].includes('|')) {
        const group = [line, lines[i + 1]]; i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) group.push(lines[i++]);
        out.push(tableBlock(group)); continue;
      }
      if (/^\s*[-*_]{3,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (/^\s*>\s?/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(inline(lines[i++].replace(/^\s*>\s?/, '')));
        out.push('<blockquote>' + quote.join('<br>') + '</blockquote>'); continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) { const level = heading[1].length; out.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>'); i++; continue; }
      if (/^\s*[-*+]\s+/.test(line)) {
        const items = []; while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push('<li>' + inline(lines[i++].replace(/^\s*[-*+]\s+/, '')) + '</li>');
        out.push('<ul>' + items.join('') + '</ul>'); continue;
      }
      if (/^\s*\d+[.)]\s+/.test(line)) {
        const items = []; while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push('<li>' + inline(lines[i++].replace(/^\s*\d+[.)]\s+/, '')) + '</li>');
        out.push('<ol>' + items.join('') + '</ol>'); continue;
      }
      const para = [line]; i++;
      while (i < lines.length && lines[i].trim() && !/^(#{1,3})\s+/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i]) && !/^\s*>/.test(lines[i])) para.push(lines[i++]);
      out.push('<p>' + para.map(inline).join('<br>') + '</p>');
    }
    return out.join('');
  }
  function codeBlock(lang, code) {
    return '<div class="code"><div class="code-head"><span>' + esc(lang || 'texto') +
      '</span><button class="copy" type="button">Copiar</button></div><pre><code>' + esc(code) + '</code></pre></div>';
  }
  function md(src) {
    return src.split('```').map((part, i) => {
      if (i % 2 === 0) return blocks(part);
      const nl = part.indexOf('\n');
      const lang = nl >= 0 ? part.slice(0, nl).trim() : '';
      const code = nl >= 0 ? part.slice(nl + 1) : part;
      return codeBlock(lang, code.replace(/\n$/, ''));
    }).join('');
  }

  const TOOL_LABEL = {
    list_project_files: 'Mapeando a estrutura do projeto', read_project_file: 'Analisando arquivo',
    write_project_file: 'Construindo arquivo', apply_file_patch: 'Refinando implementação',
    create_project_directory: 'Organizando diretórios', rename_project_file: 'Reorganizando arquivos',
    generate_pdf: 'Preparando documento',
  };
  const WORKFLOWS = [
    { test: /site|website|landing|página|interface|frontend|html|css/i, stages: ['Interpretando a experiência desejada...', 'Definindo a direção visual...', 'Estruturando a interface...', 'Construindo componentes e estilos...', 'Preparando interações e responsividade...', 'Refinando os detalhes finais...'] },
    { test: /backend|api|servidor|banco|database|autenticação|sistema/i, stages: ['Mapeando os requisitos do sistema...', 'Desenhando a arquitetura técnica...', 'Definindo contratos e integrações...', 'Implementando a lógica principal...', 'Validando fluxos e tratamento de erros...', 'Consolidando a estrutura...'] },
    { test: /bug|erro|corrigir|depurar|debug|problema/i, stages: ['Analisando o cenário...', 'Rastreando a origem do problema...', 'Isolando a causa provável...', 'Preparando a correção...', 'Revisando possíveis efeitos colaterais...'] },
    { test: /pdf|documento|relatório/i, stages: ['Organizando o conteúdo...', 'Definindo a estrutura do documento...', 'Preparando a composição...', 'Gerando o material...', 'Conferindo a entrega...'] },
    { test: /código|program|script|função|componente|projeto|app|aplicativo/i, stages: ['Interpretando os requisitos...', 'Planejando a implementação...', 'Estruturando os módulos...', 'Desenvolvendo as funções...', 'Integrando os componentes...', 'Revisando a solução...'] },
    { test: /.*/, stages: ['Analisando sua solicitação...', 'Organizando os pontos principais...', 'Preparando uma resposta consistente...'] }
  ];
  function workflowFor(prompt) { return (WORKFLOWS.find((w) => w.test.test(prompt || '')) || WORKFLOWS[WORKFLOWS.length - 1]).stages; }
  const STATUS_TEXT = { running: 'em andamento', done: 'concluído', failed: 'falhou', cancelled: 'cancelado' };

  // ---------- Renderização ----------
  function renderList() {
    el.list.textContent = '';
    [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt).forEach((c) => {
      const row = document.createElement('div');
      row.className = 'chat-item' + (c.id === state.activeId ? ' active' : '') + (seenChats.has(c.id) ? '' : ' enter');
      seenChats.add(c.id);
      const open = document.createElement('button');
      open.type = 'button'; open.className = 'chat-open'; open.textContent = c.title;
      open.addEventListener('click', () => { if (!streaming) { state.activeId = c.id; save(); renderAll(); closeSidebar(); } });
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'chat-del'; del.setAttribute('aria-label', 'Excluir conversa: ' + c.title);
      del.innerHTML = '<svg class="ico"><use href="#i-trash"/></svg>';
      del.addEventListener('click', () => {
        if (streaming || !confirm('Excluir esta conversa? Essa ação não pode ser desfeita.')) return;
        state.chats = state.chats.filter((x) => x.id !== c.id);
        if (state.activeId === c.id) state.activeId = null;
        save(); renderAll();
      });
      row.append(open, del);
      el.list.append(row);
    });
  }

  function markNew(node, obj) { if (!obj.shown) { node.classList.add('new'); obj.shown = true; } }

  function messageNode(m, live, enter) {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + m.role + (live ? ' streaming' : '') + (enter ? ' enter' : '');
    (m.fallbacks || []).forEach((f) => {
      const d = document.createElement('div');
      d.className = 'fb';
      d.textContent = f.text;
      markNew(d, f);
      wrap.append(d);
    });
    if (m.activity && m.activity.length) {
      const ul = document.createElement('ul');
      ul.className = 'activity';
      ul.setAttribute('aria-label', 'Ações da Siart no projeto');
      m.activity.forEach((a) => {
        const li = document.createElement('li');
        markNew(li, a);
        const label = document.createElement('span');
        label.textContent = a.label + (a.path ? ' ' : '');
        li.append(label);
        if (a.path) { const c = document.createElement('code'); c.textContent = a.path; li.append(c); }
        const st = document.createElement('span');
        st.className = 'st ' + a.status;
        st.textContent = STATUS_TEXT[a.status] || a.status;
        li.append(st);
        if (a.note) { const n = document.createElement('span'); n.className = 'act-note'; n.textContent = a.note; li.append(n); }
        ul.append(li);
      });
      wrap.append(ul);
    }
    if (live && m.working) {
      const status = document.createElement('div'); status.className = 'work-status';
      const head = document.createElement('div'); head.className = 'work-head';
      head.innerHTML = '<svg class="logo moon-spin" viewBox="0 0 32 32"><use href="#moon"/></svg>';
      const label = document.createElement('span'); label.className = 'work-current'; label.textContent = m.stage || 'Analisando sua solicitação...';
      head.append(label); status.append(head);
      if (m.substage) { const sub = document.createElement('div'); sub.className = 'work-substage'; sub.textContent = m.substage; status.append(sub); }
      wrap.append(status);
    }
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (m.role === 'user') bubble.textContent = m.content;
    else if (live && !m.content && !(m.activity && m.activity.length) && !(m.fallbacks && m.fallbacks.length)) {
      bubble.innerHTML = '<span class="dots" role="img" aria-label="A Siart está respondendo"><i></i><i></i><i></i></span>';
    } else bubble.innerHTML = md(m.content);
    wrap.append(bubble);
    if (m.via && m.role === 'assistant') { const v = document.createElement('div'); v.className = 'meta'; v.textContent = m.via.tier + ' · via ' + m.via.provider; wrap.append(v); }
    if (m.stopped) { const s = document.createElement('div'); s.className = 'stopped'; s.textContent = 'Resposta interrompida.'; wrap.append(s); }
    if (m.error) { const e = document.createElement('div'); e.className = 'err'; e.textContent = m.error; wrap.append(e); }
    return wrap;
  }

  function renderMessages(animateFrom = Infinity) {
    const chat = active();
    el.messages.textContent = '';
    const col = document.createElement('div');
    col.className = 'col';
    if (!chat || chat.messages.length === 0) {
      col.innerHTML = '<div class="empty"><div class="logo-wrap"><svg class="logo"><use href="#moon"/></svg></div><h2>O que vamos construir?</h2>' +
        '<p>Pergunte sobre código, depuração, arquitetura ou design de interface.</p><div class="chips"></div></div>';
      const chips = col.querySelector('.chips');
      SUGGESTIONS.forEach((t) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'chip'; b.textContent = t;
        b.addEventListener('click', () => { el.input.value = t; autosize(); el.input.focus(); });
        chips.append(b);
      });
    } else {
      chat.messages.forEach((m, i) => col.append(messageNode(m, streaming && i === chat.messages.length - 1, i >= animateFrom)));
    }
    el.messages.append(col);
    if (Number.isFinite(animateFrom)) el.messages.scrollTo({ top: el.messages.scrollHeight, behavior: 'smooth' });
    else el.messages.scrollTop = el.messages.scrollHeight;
  }

  // ---------- Limites e contadores ----------
  const usable = (c) => c.messages.filter((m) => m.content).length;
  function showNotice(text) {
    ui.notice.textContent = text;
    ui.notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { ui.notice.hidden = true; }, 7000);
  }
  function updateLimits() {
    const n = state.chats.length;
    ui.count.classList.toggle('full', n >= limits.maxConversations);
    ui.count.textContent = '';
    const a = document.createElement('span'); a.textContent = 'Conversas';
    const b = document.createElement('span'); b.textContent = n + ' de ' + limits.maxConversations;
    ui.count.append(a, b);

    const chat = active();
    const used = chat ? usable(chat) : 0;
    const full = used >= limits.maxMessages;
    const left = Math.ceil((limits.maxMessages - used) / 2);
    el.input.disabled = full;
    el.send.disabled = !streaming && full;
    ui.limitNote.hidden = !(chat && (full || left <= 3));
    ui.limitNew.hidden = !full;
    ui.limitText.textContent = full
      ? 'Esta conversa chegou ao limite de ' + limits.maxMessages + ' mensagens. Comece uma nova para continuar.'
      : 'Restam cerca de ' + left + ' trocas de mensagens nesta conversa.';
  }
  // Abre espaço para uma nova conversa quando o limite foi atingido (com confirmação).
  function makeRoom() {
    const oldest = [...state.chats].sort((x, y) => x.updatedAt - y.updatedAt)[0];
    if (!oldest) return true;
    if (!confirm('Você atingiu o limite de ' + limits.maxConversations + ' conversas. Excluir a mais antiga (“' + oldest.title + '”) para abrir uma nova?')) {
      showNotice('Limite de ' + limits.maxConversations + ' conversas atingido. Exclua uma conversa para abrir outra.');
      return false;
    }
    state.chats = state.chats.filter((c) => c.id !== oldest.id);
    save();
    return true;
  }

  // ---------- Níveis de IA ----------
  function showTierHint() {
    const t = tiers.find((x) => x.id === tierId);
    ui.tierHint.textContent = t ? t.description + (t.providers.length ? ' Provedores: ' + t.providers.join(', ') + '.' : '') : '';
  }
  function selectTier(id) {
    tierId = id;
    try { localStorage.setItem('siart.tier', id); } catch { /* ok */ }
    showTierHint();
  }
  function renderTiers(defaultId) {
    const avail = tiers.filter((t) => t.available);
    if (!tiers.some((t) => t.id === tierId && t.available)) tierId = (avail.find((t) => t.id === defaultId) || avail[0] || {}).id || null;
    ui.tiers.textContent = '';
    tiers.forEach((t) => {
      const label = document.createElement('label');
      label.className = 'tier';
      if (!t.available) label.title = 'Nenhum provedor configurado para este nível';
      const input = document.createElement('input');
      input.type = 'radio'; input.name = 'tier'; input.value = t.id; input.checked = t.id === tierId; input.disabled = !t.available;
      input.addEventListener('change', () => selectTier(t.id));
      const n = document.createElement('span'); n.className = 't-name'; n.textContent = t.name;
      const v = document.createElement('span'); v.className = 't-ver'; v.textContent = t.version;
      label.append(input, n, v);
      ui.tiers.append(label);
    });
    showTierHint();
  }

  function renderAll(animateFrom) {
    const chat = active();
    el.title.textContent = chat ? chat.title : 'Nova conversa';
    renderList();
    renderMessages(animateFrom);
    updateLimits();
  }

  function setStreaming(on) {
    streaming = on;
    el.send.classList.toggle('stop', on);
    el.send.setAttribute('aria-label', on ? 'Parar resposta' : 'Enviar mensagem');
    el.send.innerHTML = '<svg class="ico"><use href="' + (on ? '#i-stop' : '#i-send') + '"/></svg>';
  }

  function refreshLast(reply) {
    const last = el.messages.querySelector('.msg:last-child');
    if (last) last.replaceWith(messageNode(reply, true));
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  // ---------- Envio e streaming (SSE via fetch) ----------
  async function readSSE(body, onEvent) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message', data = '';
        block.split('\n').forEach((l) => {
          if (l.startsWith('event:')) event = l.slice(6).trim();
          else if (l.startsWith('data:')) data += l.slice(5).trim();
        });
        if (data) { try { onEvent(event, JSON.parse(data)); } catch (e) { if (e.isTaskError) throw e; } }
      }
    }
  }

  async function sendMessage(text) {
    if (streaming) return;
    let chat = active();
    if (!chat) {
      chat = { id: crypto.randomUUID(), title: 'Nova conversa', messages: [], updatedAt: Date.now() };
      state.chats.push(chat);
      state.activeId = chat.id;
    }
    chat.messages.push({ role: 'user', content: text });
    if (chat.messages.length === 1) chat.title = text.replace(/\s+/g, ' ').slice(0, 48);
    const stages = workflowFor(text); let stageIndex = 0;
    const reply = { role: 'assistant', content: '', working: true, stage: stages[0] };
    chat.messages.push(reply);
    chat.updatedAt = Date.now();
    save();
    setStreaming(true);
    renderAll(chat.messages.length - 2);

    // Só mensagens com conteúdo vão ao servidor; o último item (resposta em branco) fica de fora.
    const payload = chat.messages.slice(0, -1).filter((m) => m.content).map(({ role, content }) => ({ role, content }));
    controller = new AbortController();
    const stageTimer = setInterval(() => {
      if (!streaming || !reply.working) return;
      stageIndex = (stageIndex + 1) % stages.length; reply.stage = stages[stageIndex];
      const status = el.messages.querySelector('.msg:last-child .work-current');
      if (status) { status.classList.remove('rise-in'); void status.offsetWidth; status.textContent = reply.stage; status.classList.add('rise-in'); }
    }, 2300);
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tierId ? { messages: payload, tier: tierId } : { messages: payload }), signal: controller.signal });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        if (j.code === 'auth_required') window.dispatchEvent(new Event('siart:auth'));
        throw new Error(j.error || 'Erro ' + res.status + ' ao enviar a mensagem.');
      }
      await readSSE(res.body, (event, data) => {
        if (event === 'task.started') { reply.working = true; refreshLast(reply);
        } else if (event === 'task.completed') { reply.working = false;
        } else if (event === 'message.delta') {
          reply.content += data.text;
          const bubble = el.messages.querySelector('.msg:last-child .bubble');
          if (bubble) {
            const nearBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 80;
            bubble.innerHTML = md(reply.content);
            if (nearBottom) el.messages.scrollTop = el.messages.scrollHeight;
          }
        } else if (event === 'model.selected') {
          reply.via = { tier: data.tierName, provider: data.providerName };
        } else if (event === 'model.fallback') {
          (reply.fallbacks ||= []).push({ text: data.fromName + ' ' + (REASON[data.reason] || 'falhou') + '. Usando ' + data.toName + '.' });
          refreshLast(reply);
        } else if (event === 'tool.started') {
          reply.substage = TOOL_LABEL[data.tool] || 'Executando etapa técnica';
          (reply.activity ||= []).push({ id: data.callId, label: TOOL_LABEL[data.tool] || data.tool, path: data.path, status: 'running' });
          refreshLast(reply);
        } else if (event === 'tool.completed' || event === 'tool.failed') {
          const a = (reply.activity || []).find((x) => x.id === data.callId);
          if (a) { a.status = event === 'tool.completed' ? 'done' : 'failed'; if (data.message) a.note = data.message; }
          refreshLast(reply);
          if (event === 'tool.completed' && data.mutated && window.SiartProject) window.SiartProject.onMutation(data.path);
        } else if (event === 'task.failed') {
          throw Object.assign(new Error(data.message || 'A resposta falhou.'), { isTaskError: true });
        }
      });
    } catch (e) {
      if (e.name === 'AbortError') reply.stopped = true;
      else reply.error = e.message || 'Falha de conexão.';
    } finally {
      clearInterval(stageTimer); reply.working = false;
      controller = null;
      setStreaming(false);
      (reply.activity || []).forEach((a) => { if (a.status === 'running') a.status = 'cancelled'; });
      if (window.SiartProject) window.SiartProject.onChatEnd();
      if (!reply.content && !reply.error && !reply.stopped) reply.error = 'A Siart não retornou conteúdo. Tente novamente.';
      chat.updatedAt = Date.now();
      save();
      renderAll();
      el.input.focus();
    }
  }

  // ---------- Interações ----------
  function autosize() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 200) + 'px';
  }
  el.input.addEventListener('input', autosize);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); el.form.requestSubmit(); }
  });
  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (streaming) { controller && controller.abort(); return; }
    const text = el.input.value.trim();
    if (!text) return;
    const cur = active();
    if (cur && usable(cur) >= limits.maxMessages) { updateLimits(); ui.limitNote.classList.remove('shake'); void ui.limitNote.offsetWidth; ui.limitNote.classList.add('shake'); return; }
    if (!cur && state.chats.length >= limits.maxConversations && !makeRoom()) return;
    el.input.value = '';
    autosize();
    sendMessage(text);
  });
  el.newChat.addEventListener('click', () => {
    if (streaming) return;
    state.activeId = null;
    save(); renderAll(); closeSidebar(); el.input.focus();
  });
  ui.limitNew.addEventListener('click', () => el.newChat.click());
  el.messages.addEventListener('click', async (e) => {
    const btn = e.target.closest('.copy');
    if (!btn) return;
    const code = btn.closest('.code').querySelector('code').textContent;
    try { await navigator.clipboard.writeText(code); btn.textContent = 'Copiado'; }
    catch { btn.textContent = 'Não foi possível copiar'; }
    setTimeout(() => { btn.textContent = 'Copiar'; }, 1500);
  });

  function openSidebar() { el.sidebar.classList.add('open'); el.scrim.classList.add('show'); }
  function closeSidebar() { el.sidebar.classList.remove('open'); el.scrim.classList.remove('show'); }
  el.menu.addEventListener('click', openSidebar);
  el.scrim.addEventListener('click', closeSidebar);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });

  // ---------- Acesso restrito (opcional) ----------
  const login = { box: document.getElementById('login'), form: document.getElementById('login-form'), code: document.getElementById('code'), err: document.getElementById('login-err') };
  function showLogin() { login.box.hidden = false; login.code.focus(); }
  window.addEventListener('siart:auth', showLogin);
  login.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    login.err.hidden = true;
    try {
      const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: login.code.value }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'Não foi possível entrar.');
      login.code.value = '';
      login.box.hidden = true;
      checkStatus();
      if (window.SiartProject && window.SiartProject.isOpen()) window.SiartProject.refresh();
    } catch (err) { login.err.textContent = err.message; login.err.hidden = false; }
  });

  // ---------- Inicialização ----------
  function checkStatus() {
    fetch('/api/status').then((r) => r.json()).then((s) => {
      if (s.locked) { showLogin(); return; }
      tiers = s.tiers || [];
      if (s.limits) limits = s.limits;
      renderTiers(s.defaultTier);
      updateLimits();
      el.banner.hidden = !!s.ready;
      if (!s.ready) el.banner.textContent = 'Nenhuma chave de IA configurada no servidor (GROQ_API_KEY, GEMINI_API_KEY, MISTRAL_API_KEY ou OPENROUTER_API_KEY). O chat não vai responder até haver ao menos uma.';
    }).catch(() => {
      el.banner.textContent = 'Não foi possível contatar o servidor da Siart.'; el.banner.hidden = false;
    });
  }
  checkStatus();
  setStreaming(false);
  renderAll();
})();
