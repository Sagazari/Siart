'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const el = { sidebar: $('sidebar'), scrim: $('scrim'), list: $('chat-list'), title: $('title'), banner: $('banner'),
    messages: $('messages'), form: $('composer'), input: $('input'), send: $('send'), voice: $('voice'), menu: $('menu'), newChat: $('new-chat'),
    attach: $('attach'), attachmentInput: $('attachment-input'), attachmentList: $('attachment-list') };
  const ui = { tiers: $('tiers'), tierHint: $('tier-hint'), modelToggle: $('model-toggle'), modelPanel: $('model-panel'), notice: $('notice'), count: $('conv-count'), limitNote: $('limit-note'), limitText: $('limit-text'), limitNew: $('limit-new') };
  const STORE = 'siart.v1';
  const SUGGESTIONS = [
    'Ajude-me a entender um assunto novo',
    'Pesquise e organize estas informações',
    'Ajude a planejar uma ideia do zero',
  ];

  const REASON = { rate_limit: 'atingiu o limite de uso', unavailable: 'está indisponível', auth: 'não aceitou a chave', timeout: 'demorou demais', model_unavailable: 'não tem esse modelo', billing: 'está sem créditos ou faturamento ativo', rejected: 'rejeitou a requisição (verifique modelo e parâmetros)', empty: 'não respondeu' };
  let tiers = [];
  let tierId = null;
  try { tierId = localStorage.getItem('siart.tier'); } catch { /* sem armazenamento */ }
  let limits = { maxConversations: 30, maxMessages: 40 };
  const seenChats = new Set();
  let noticeTimer = null;

  let state = load();
  let streaming = false;
  let controller = null;
  let voiceActive = false;
  let recognition = null;
  let voiceSpeaking = false;
  let voiceRestartTimer = null;
  let voicePermissionStream = null;
  let pendingAttachments = [];

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
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img class="answer-image" src="$2" alt="$1" loading="lazy" referrerpolicy="no-referrer">')
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
  function initialWorkStage() { return 'Analisando sua solicitação...'; }
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
    if (live && m.working) {
      const status = document.createElement('div'); status.className = 'work-status';
      const head = document.createElement('div'); head.className = 'work-head';
      head.innerHTML = '<svg class="logo moon-spin" viewBox="0 0 32 32"><use href="#moon"/></svg>';
      const label = document.createElement('span'); label.className = 'work-current rise-in'; label.textContent = m.stage || 'Analisando sua solicitação...';
      head.append(label); status.append(head);
      wrap.append(status);
    }
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (m.role === 'user') {
      bubble.textContent = m.content || '';
      (m.attachments || []).forEach((a) => {
        if (a.dataUrl && a.type && a.type.startsWith('image/')) {
          const img = document.createElement('img'); img.className = 'user-image'; img.src = a.dataUrl; img.alt = a.name || 'Imagem enviada'; img.loading = 'lazy'; bubble.append(img);
        } else {
          const tag = document.createElement('div'); tag.className = 'user-file'; tag.textContent = '▤ ' + (a.name || 'Arquivo'); bubble.append(tag);
        }
      });
    }
    else if (live && !m.content && !(m.fallbacks && m.fallbacks.length)) {
      bubble.textContent = ''; // sem animação duplicada de três pontos; o status da Lua já indica atividade
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
      col.innerHTML = '<div class="empty"><div class="logo-wrap"><svg class="logo"><use href="#moon"/></svg></div><h2>Como posso ajudar?</h2>' +
        '<p>Converse, aprenda, pesquise, planeje ou crie. Vamos começar pela sua ideia.</p><div class="chips"></div></div>';
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
    if (ui.modelToggle) { const selected = tiers.find((t) => t.id === tierId); ui.modelToggle.textContent = selected ? selected.name + '  ·  ▾' : 'Modelo  ·  ▾'; }
    if (ui.modelPanel) { ui.modelPanel.hidden = true; ui.modelToggle?.setAttribute('aria-expanded', 'false'); }
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
    if (ui.modelToggle) { const selected = tiers.find((t) => t.id === tierId); ui.modelToggle.textContent = selected ? selected.name + '  ·  ▾' : 'Modelo  ·  ▾'; }
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


  function renderPendingAttachments() {
    if (!el.attachmentList) return;
    el.attachmentList.textContent = '';
    el.attachmentList.hidden = pendingAttachments.length === 0;
    pendingAttachments.forEach((a, index) => {
      const item = document.createElement('div'); item.className = 'attachment-chip';
      if (a.dataUrl) { const img = document.createElement('img'); img.src = a.dataUrl; img.alt = ''; item.append(img); }
      const name = document.createElement('span'); name.textContent = a.name; item.append(name);
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Remover ' + a.name);
      remove.addEventListener('click', () => { pendingAttachments.splice(index, 1); renderPendingAttachments(); });
      item.append(remove); el.attachmentList.append(item);
    });
  }
  function imageToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Não foi possível ler ' + file.name));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Imagem inválida: ' + file.name));
        img.onload = () => {
          const max = 1600, scale = Math.min(1, max / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale)); canvas.height = Math.max(1, Math.round(img.height * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.78));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }
  const TEXT_EXT = new Set(['txt','md','csv','json','html','htm','css','js','mjs','ts','tsx','jsx','py','sql','xml','yml','yaml','toml','log']);
  async function addAttachments(fileList) {
    const files = [...fileList];
    if (pendingAttachments.length + files.length > 5) { showNotice('Envie até 5 arquivos por mensagem.'); return; }
    for (const file of files) {
      try {
        if (file.type.startsWith('image/')) {
          if (file.size > 12 * 1024 * 1024) throw new Error('A imagem deve ter até 12 MB.');
          const dataUrl = await imageToDataUrl(file);
          pendingAttachments.push({ name: file.name, type: 'image/jpeg', dataUrl });
        } else {
          const ext = (file.name.split('.').pop() || '').toLowerCase();
          if (!TEXT_EXT.has(ext)) throw new Error('Formato não suportado nesta versão. Use imagem ou arquivo de texto/código.');
          if (file.size > 300 * 1024) throw new Error('Arquivos de texto devem ter até 300 KB.');
          const content = await file.text();
          pendingAttachments.push({ name: file.name, type: file.type || 'text/plain', text: content.slice(0, 50000) });
        }
      } catch (err) { showNotice(err.message); }
    }
    renderPendingAttachments();
  }
  if (el.attach && el.attachmentInput) {
    el.attach.addEventListener('click', () => el.attachmentInput.click());
    el.attachmentInput.addEventListener('change', () => { addAttachments(el.attachmentInput.files); el.attachmentInput.value = ''; });
  }
  async function sendMessage(text, attachments = []) {
    if (streaming) return;
    let chat = active();
    if (!chat) {
      chat = { id: crypto.randomUUID(), title: 'Nova conversa', messages: [], updatedAt: Date.now() };
      state.chats.push(chat);
      state.activeId = chat.id;
    }
    const attachmentCopy = attachments.map((a) => ({ ...a }));
    const extraText = attachmentCopy.filter((a) => typeof a.text === 'string')
      .map((a) => '\n\n[Conteúdo do arquivo ' + a.name + ']\n' + a.text).join('');
    chat.messages.push({ role: 'user', content: text + extraText, attachments: attachmentCopy.map((a) => ({ name: a.name, type: a.type, dataUrl: a.dataUrl || null })) });
    if (chat.messages.length === 1) chat.title = (text || attachmentCopy[0]?.name || 'Arquivo enviado').replace(/\s+/g, ' ').slice(0, 48);
    const reply = { role: 'assistant', content: '', working: true, stage: initialWorkStage() };
    chat.messages.push(reply);
    chat.updatedAt = Date.now();
    save();
    setStreaming(true);
    renderAll(chat.messages.length - 2);

    // Só mensagens com conteúdo vão ao servidor; o último item (resposta em branco) fica de fora.
    const payload = chat.messages.slice(0, -1).filter((m) => m.content || (m.attachments && m.attachments.length)).map((m) => {
      const images = (m.attachments || []).filter((a) => a.dataUrl).map((a) => ({ type: 'image_url', image_url: { url: a.dataUrl } }));
      return { role: m.role, content: images.length ? [{ type: 'text', text: m.content || 'Analise a imagem enviada.' }, ...images] : m.content };
    });
    controller = new AbortController();
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
          reply.stage = TOOL_LABEL[data.tool] || 'Executando uma etapa da tarefa...';
          refreshLast(reply);
        } else if (event === 'tool.completed' || event === 'tool.failed') {
          if (event === 'tool.failed') reply.stage = 'Reavaliando a etapa e preparando uma alternativa...';
          else reply.stage = 'Integrando os resultados...';
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
      reply.working = false;
      controller = null;
      setStreaming(false);
      if (window.SiartProject) window.SiartProject.onChatEnd();
      if (!reply.content && !reply.error && !reply.stopped) reply.error = 'A Siart não retornou conteúdo. Tente novamente.';
      chat.updatedAt = Date.now();
      save();
      renderAll();
      if (voiceActive && reply.content) speakVoice(reply.content);
      else if (voiceActive) restartListening();
      el.input.focus();
    }
  }

  // ---------- Siart Voice: reconhecimento e síntese nativos do navegador ----------
  function speechRecognitionConstructor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }
  function setVoiceState(state) {
    if (!el.voice) return;
    el.voice.dataset.state = state;
    const labels = { off: 'Iniciar conversa por voz', listening: 'Ouvindo você', speaking: 'A Siart está falando', unsupported: 'Voz não disponível neste navegador' };
    el.voice.setAttribute('aria-label', labels[state] || labels.off);
    el.voice.title = labels[state] || labels.off;
    el.voice.innerHTML = '<svg class="ico"><use href="#' + (state === 'listening' ? 'i-mic' : state === 'speaking' ? 'i-volume' : 'i-mic') + '"/></svg>';
  }
  function stopListening() {
    if (recognition) { try { recognition.onend = null; recognition.stop(); } catch {} recognition = null; }
    clearTimeout(voiceRestartTimer);
  }
  function restartListening() {
    if (!voiceActive || streaming || voiceSpeaking) return;
    clearTimeout(voiceRestartTimer);
    voiceRestartTimer = setTimeout(startListening, 450);
  }
  function startListening() {
    if (!voiceActive || streaming || voiceSpeaking || recognition) return;
    const SpeechRecognition = speechRecognitionConstructor();
    if (!SpeechRecognition) { setVoiceState('unsupported'); voiceActive = false; return; }
    const rec = new SpeechRecognition();
    recognition = rec;
    rec.lang = 'pt-BR';
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let finalText = '';
    rec.onstart = () => setVoiceState('listening');
    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const phrase = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += phrase;
        else interim += phrase;
      }
      if (interim) { el.input.value = interim; autosize(); }
      if (finalText.trim()) {
        const spoken = finalText.trim();
        el.input.value = spoken;
        autosize();
        recognition = null;
        try { rec.stop(); } catch {}
        const current = active();
        if ((!current || usable(current) < limits.maxMessages) && !streaming) {
          el.input.value = '';
          autosize();
          sendMessage(spoken);
        } else restartListening();
      }
    };
    rec.onerror = (event) => {
      recognition = null;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        voiceActive = false; setVoiceState('off'); showNotice('Permita o acesso ao microfone para conversar por voz.');
      } else if (event.error !== 'aborted' && voiceActive) restartListening();
    };
    rec.onend = () => { if (recognition === rec) recognition = null; restartListening(); };
    try { rec.start(); } catch { recognition = null; restartListening(); }
  }
  function cleanSpeechText(text) {
    return String(text || '').replace(/```[\s\S]*?```/g, ' Código omitido. ')
      .replace(/`([^`]+)`/g, '$1').replace(/https?:\/\/\S+/g, 'link')
      .replace(/[#*_>|]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function speakVoice(text) {
    if (!('speechSynthesis' in window)) { restartListening(); return; }
    stopListening();
    window.speechSynthesis.cancel();
    const spoken = cleanSpeechText(text);
    if (!spoken) { restartListening(); return; }
    const utterance = new SpeechSynthesisUtterance(spoken);
    utterance.lang = 'pt-BR';
    utterance.rate = 0.96;
    utterance.pitch = 1.0;
    const voices = window.speechSynthesis.getVoices();
    const pt = voices.filter(v => /^pt-BR/i.test(v.lang));
    const femaleHint = /female|feminina|mulher|luciana|fernanda|camila|maria|francisca|bruna|helena/i;
    // Prefere uma voz pt-BR com nome feminino quando o aparelho oferece essa opção.
    utterance.voice = pt.find(v => femaleHint.test(v.name)) || pt[0] || voices.find(v => /^pt/i.test(v.lang)) || null;
    utterance.onstart = () => { voiceSpeaking = true; setVoiceState('speaking'); };
    utterance.onend = utterance.onerror = () => { voiceSpeaking = false; if (voiceActive) restartListening(); else setVoiceState('off'); };
    window.speechSynthesis.speak(utterance);
  }
  if (el.voice) el.voice.addEventListener('click', () => {
    if (voiceActive) {
      voiceActive = false; voiceSpeaking = false; stopListening();
      if (voicePermissionStream) { voicePermissionStream.getTracks().forEach((track) => track.stop()); voicePermissionStream = null; }
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      setVoiceState('off');
      return;
    }
    if (!speechRecognitionConstructor()) { setVoiceState('unsupported'); showNotice('Seu navegador não oferece reconhecimento de voz. Tente abrir a Siart no Chrome atualizado.'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showNotice('O Chrome não disponibilizou o microfone para esta página. Verifique se o site está aberto em HTTPS.');
      return;
    }
    // O clique do usuário dispara o pedido real de permissão. SpeechRecognition,
    // sozinho, pode retornar "not-allowed" sem abrir a caixa de autorização.
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      voicePermissionStream = stream;
      stream.getTracks().forEach((track) => track.stop());
      voicePermissionStream = null;
      voiceActive = true;
      if ('speechSynthesis' in window) window.speechSynthesis.getVoices();
      startListening();
    }).catch((error) => {
      const denied = error && (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError');
      showNotice(denied
        ? 'O Chrome negou o acesso ao microfone deste site.'
        : 'Não foi possível acessar o microfone (' + ((error && error.name) || 'erro desconhecido') + ').');
    });
  });

  // Seletor discreto de modelo: abre apenas quando solicitado.
  if (ui.modelToggle && ui.modelPanel) {
    ui.modelToggle.addEventListener('click', () => {
      const open = ui.modelPanel.hidden;
      ui.modelPanel.hidden = !open;
      ui.modelToggle.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (event) => {
      if (!ui.modelPanel.hidden && !ui.modelPanel.contains(event.target) && !ui.modelToggle.contains(event.target)) {
        ui.modelPanel.hidden = true;
        ui.modelToggle.setAttribute('aria-expanded', 'false');
      }
    });
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
    if (!text && pendingAttachments.length === 0) return;
    const cur = active();
    if (cur && usable(cur) >= limits.maxMessages) { updateLimits(); ui.limitNote.classList.remove('shake'); void ui.limitNote.offsetWidth; ui.limitNote.classList.add('shake'); return; }
    if (!cur && state.chats.length >= limits.maxConversations && !makeRoom()) return;
    el.input.value = '';
    autosize();
    const files = pendingAttachments;
    pendingAttachments = [];
    renderPendingAttachments();
    sendMessage(text, files);
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
