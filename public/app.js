'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const el = { sidebar: $('sidebar'), scrim: $('scrim'), list: $('chat-list'), title: $('title'), banner: $('banner'),
    messages: $('messages'), form: $('composer'), input: $('input'), send: $('send'), menu: $('menu'), newChat: $('new-chat') };
  const STORE = 'siart.v1';
  const SUGGESTIONS = [
    'Explique este erro e como corrigi-lo',
    'Revise um trecho de código meu',
    'Ajude a planejar a arquitetura de um app',
  ];

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
  const inline = (s) => esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  function blocks(text) {
    return text.split(/\n{2,}/).map((p) => {
      p = p.trim();
      if (!p) return '';
      const lines = p.split('\n');
      if (lines.every((l) => /^\s*[-*] /.test(l))) return '<ul>' + lines.map((l) => '<li>' + inline(l.replace(/^\s*[-*] /, '')) + '</li>').join('') + '</ul>';
      if (lines.every((l) => /^\s*\d+[.)] /.test(l))) return '<ol>' + lines.map((l) => '<li>' + inline(l.replace(/^\s*\d+[.)] /, '')) + '</li>').join('') + '</ol>';
      const h = p.match(/^#{1,4} (.+)$/);
      if (h && lines.length === 1) return '<h4>' + inline(h[1]) + '</h4>';
      return '<p>' + lines.map(inline).join('<br>') + '</p>';
    }).join('');
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
    list_project_files: 'Listando arquivos', read_project_file: 'Lendo', write_project_file: 'Gravando',
    apply_file_patch: 'Editando', create_project_directory: 'Criando pasta', rename_project_file: 'Renomeando', generate_pdf: 'Gerando PDF',
  };
  const STATUS_TEXT = { running: 'em andamento', done: 'concluído', failed: 'falhou', cancelled: 'cancelado' };

  // ---------- Renderização ----------
  function renderList() {
    el.list.textContent = '';
    [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt).forEach((c) => {
      const row = document.createElement('div');
      row.className = 'chat-item' + (c.id === state.activeId ? ' active' : '');
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

  function messageNode(m, live) {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + m.role + (live ? ' streaming' : '');
    if (m.activity && m.activity.length) {
      const ul = document.createElement('ul');
      ul.className = 'activity';
      ul.setAttribute('aria-label', 'Ações da Siart no projeto');
      m.activity.forEach((a) => {
        const li = document.createElement('li');
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
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (m.role === 'user') bubble.textContent = m.content;
    else bubble.innerHTML = md(m.content);
    wrap.append(bubble);
    if (m.stopped) { const s = document.createElement('div'); s.className = 'stopped'; s.textContent = 'Resposta interrompida.'; wrap.append(s); }
    if (m.error) { const e = document.createElement('div'); e.className = 'err'; e.textContent = m.error; wrap.append(e); }
    return wrap;
  }

  function renderMessages() {
    const chat = active();
    el.messages.textContent = '';
    const col = document.createElement('div');
    col.className = 'col';
    if (!chat || chat.messages.length === 0) {
      col.innerHTML = '<div class="empty"><svg class="logo"><use href="#moon"/></svg><h2>O que vamos construir?</h2>' +
        '<p>Pergunte sobre código, depuração, arquitetura ou design de interface.</p><div class="chips"></div></div>';
      const chips = col.querySelector('.chips');
      SUGGESTIONS.forEach((t) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'chip'; b.textContent = t;
        b.addEventListener('click', () => { el.input.value = t; autosize(); el.input.focus(); });
        chips.append(b);
      });
    } else {
      chat.messages.forEach((m, i) => col.append(messageNode(m, streaming && i === chat.messages.length - 1)));
    }
    el.messages.append(col);
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function renderAll() {
    const chat = active();
    el.title.textContent = chat ? chat.title : 'Nova conversa';
    renderList();
    renderMessages();
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
    const reply = { role: 'assistant', content: '' };
    chat.messages.push(reply);
    chat.updatedAt = Date.now();
    save();
    setStreaming(true);
    renderAll();

    // Só mensagens com conteúdo vão ao servidor; o último item (resposta em branco) fica de fora.
    const payload = chat.messages.slice(0, -1).filter((m) => m.content).map(({ role, content }) => ({ role, content }));
    controller = new AbortController();
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: payload }), signal: controller.signal });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        if (j.code === 'auth_required') window.dispatchEvent(new Event('siart:auth'));
        throw new Error(j.error || 'Erro ' + res.status + ' ao enviar a mensagem.');
      }
      await readSSE(res.body, (event, data) => {
        if (event === 'message.delta') {
          reply.content += data.text;
          const bubble = el.messages.querySelector('.msg:last-child .bubble');
          if (bubble) {
            const nearBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 80;
            bubble.innerHTML = md(reply.content);
            if (nearBottom) el.messages.scrollTop = el.messages.scrollHeight;
          }
        } else if (event === 'tool.started') {
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
    el.input.value = '';
    autosize();
    sendMessage(text);
  });
  el.newChat.addEventListener('click', () => {
    if (streaming) return;
    state.activeId = null;
    save(); renderAll(); closeSidebar(); el.input.focus();
  });
  el.messages.addEventListener('click', async (e) => {
    const btn = e.target.closest('.copy');
    if (!btn) return;
    const code = btn.closest('.code').querySelector('code').textContent;
    try { await navigator.clipboard.writeText(code); btn.textContent = 'Copiado'; }
    catch { btn.textContent = 'Não foi possível copiar'; }
    setTimeout(() => { btn.textContent = 'Copiar'; }, 1500);
  });

  function openSidebar() { el.sidebar.classList.add('open'); el.scrim.hidden = false; }
  function closeSidebar() { el.sidebar.classList.remove('open'); el.scrim.hidden = true; }
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
      el.banner.hidden = !!s.ready;
      if (!s.ready) el.banner.textContent = 'O servidor está sem GROQ_API_KEY. O chat não vai responder até a chave ser configurada.';
    }).catch(() => {
      el.banner.textContent = 'Não foi possível contatar o servidor da Siart.'; el.banner.hidden = false;
    });
  }
  checkStatus();
  setStreaming(false);
  renderAll();
})();
