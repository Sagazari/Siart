'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const el = {
    panel: $('project'), open: $('open-project'), close: $('p-close'),
    tabs: [...document.querySelectorAll('.p-head [data-view]')],
    views: { files: $('p-files'), editor: $('p-editor'), preview: $('p-preview') },
    list: $('f-list'), empty: $('f-empty'), usage: $('f-usage'), newBtn: $('f-new'), upBtn: $('f-upload'), upInput: $('f-input'), wipe: $('f-wipe'),
    eTabs: $('e-tabs'), eBody: $('e-body'), eEmpty: $('e-empty'), eText: $('e-text'), eStatus: $('e-status'),
    save: $('e-save'), rename: $('e-rename'), download: $('e-download'), del: $('e-delete'),
    reload: $('v-reload'), stale: $('v-stale'), vEmpty: $('v-empty'), frame: $('v-frame'), iframe: $('v-iframe'),
    sizes: [...document.querySelectorAll('[data-size]')].filter((b) => b.tagName === 'BUTTON'),
  };
  const files = [];
  const openFiles = new Map(); // path -> { content, saved }
  let current = null;
  let view = 'files';
  let previewLoaded = false;
  let previewStale = false;
  let preferredPreviewEntry = null;

  async function api(url, opts = {}) {
    const res = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (res.status === 401) { window.dispatchEvent(new Event('siart:auth')); throw new Error('Acesso restrito.'); }
    const isJson = (res.headers.get('content-type') || '').includes('json');
    const data = isJson ? await res.json() : null;
    if (!res.ok) throw new Error((data && data.error) || 'Erro ' + res.status);
    return data;
  }
  const status = (msg) => { el.eStatus.textContent = msg || ''; };
  const dirty = (p) => { const f = openFiles.get(p); return Boolean(f) && f.content !== f.saved; };
  const anyDirty = () => [...openFiles.keys()].some(dirty);
  const kb = (n) => (n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB');

  // ---------- Painel ----------
  function setView(v) {
    view = v;
    el.tabs.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === v)));
    Object.entries(el.views).forEach(([k, node]) => { node.hidden = k !== v; });
    if (v === 'preview') loadPreview(false);
    if (v === 'editor') renderEditor();
  }
  function openPanel() {
    el.panel.hidden = false;
    el.open.setAttribute('aria-expanded', 'true');
    refresh();
  }
  function closePanel() {
    el.panel.hidden = true;
    el.open.setAttribute('aria-expanded', 'false');
    el.open.focus();
  }
  el.open.addEventListener('click', () => (el.panel.hidden ? openPanel() : closePanel()));
  el.close.addEventListener('click', closePanel);
  el.tabs.forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.panel.hidden && window.innerWidth < 860) closePanel(); });

  // ---------- Arquivos ----------
  async function refresh() {
    try {
      const d = await api('/api/files');
      files.length = 0; files.push(...d.files);
      el.usage.textContent = d.usage.files + ' de ' + d.limits.maxFiles + ' arquivos, ' + kb(d.usage.bytes) + ' de ' + kb(d.limits.maxTotalBytes) + '. Salvos no servidor (retenção limitada).';
      renderFiles();
      renderTabs();
    } catch (e) { if (e.message !== 'Acesso restrito.') el.usage.textContent = e.message; }
  }

  function renderFiles() {
    el.list.textContent = '';
    el.empty.hidden = files.length > 0;
    for (const f of files) {
      const li = document.createElement('li');
      const row = document.createElement(f.editable ? 'button' : 'a');
      row.className = 'f-row';
      if (f.editable) { row.type = 'button'; row.addEventListener('click', () => openFile(f.path)); }
      else { row.href = '/api/download?path=' + encodeURIComponent(f.path); row.setAttribute('download', ''); }
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = f.path;
      const sz = document.createElement('span'); sz.className = 'sz'; sz.textContent = f.editable ? kb(f.size) : kb(f.size) + ' (baixar)';
      row.append(nm, sz);
      li.append(row);
      el.list.append(li);
    }
  }

  async function createFile() {
    const name = prompt('Nome do novo arquivo (ex.: index.html ou src/app.js):');
    if (!name) return;
    try {
      await api('/api/file', { method: 'PUT', body: JSON.stringify({ path: name.trim(), content: '' }) });
      await refresh();
      await openFile(name.trim().replace(/^\/+/, ''));
    } catch (e) { alert(e.message); }
  }
  async function uploadFiles(list) {
    const errors = [];
    for (const file of [...list].slice(0, 20)) {
      try {
        const content = await file.text();
        await api('/api/file', { method: 'PUT', body: JSON.stringify({ path: file.name, content }) });
      } catch (e) { errors.push(file.name + ': ' + e.message); }
    }
    await refresh();
    markPreviewStale();
    if (errors.length) alert('Alguns arquivos não foram enviados:\n' + errors.join('\n'));
  }
  el.newBtn.addEventListener('click', createFile);
  el.upBtn.addEventListener('click', () => el.upInput.click());
  el.upInput.addEventListener('change', () => { uploadFiles(el.upInput.files); el.upInput.value = ''; });
  el.wipe.addEventListener('click', async () => {
    if (!confirm('Apagar TODOS os arquivos do projeto? Essa ação não pode ser desfeita.')) return;
    try { await api('/api/project', { method: 'DELETE' }); openFiles.clear(); current = null; previewLoaded = false; await refresh(); renderEditor(); }
    catch (e) { alert(e.message); }
  });

  // ---------- Editor com abas ----------
  async function openFile(path) {
    if (!openFiles.has(path)) {
      try {
        const d = await api('/api/file?path=' + encodeURIComponent(path));
        openFiles.set(path, { content: d.content, saved: d.content });
      } catch (e) { alert(e.message); return; }
    }
    current = path;
    setView('editor');
  }

  function renderTabs() {
    el.eTabs.textContent = '';
    for (const path of openFiles.keys()) {
      const tab = document.createElement('div');
      tab.className = 'e-tab';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(path === current));
      const open = document.createElement('button');
      open.type = 'button'; open.className = 't-open'; open.textContent = path;
      open.addEventListener('click', () => { current = path; renderEditor(); });
      tab.append(open);
      if (dirty(path)) { const d = document.createElement('span'); d.className = 'dirty'; d.textContent = '•'; d.setAttribute('aria-label', 'alterações não salvas'); tab.append(d); }
      const x = document.createElement('button');
      x.type = 'button'; x.className = 't-close'; x.setAttribute('aria-label', 'Fechar ' + path);
      x.innerHTML = '<svg class="ico"><use href="#i-x"/></svg>';
      x.addEventListener('click', () => closeTab(path));
      tab.append(x);
      el.eTabs.append(tab);
    }
  }
  function closeTab(path) {
    if (dirty(path) && !confirm('Há alterações não salvas em ' + path + '. Fechar mesmo assim?')) return;
    openFiles.delete(path);
    if (current === path) current = [...openFiles.keys()].pop() || null;
    renderEditor();
  }
  function renderEditor() {
    renderTabs();
    const f = current && openFiles.get(current);
    el.eBody.hidden = !f;
    el.eEmpty.hidden = Boolean(f);
    if (f) {
      if (el.eText.value !== f.content) el.eText.value = f.content;
      el.download.href = '/api/download?path=' + encodeURIComponent(current);
      el.download.setAttribute('download', current.split('/').pop());
      status(dirty(current) ? 'Alterações não salvas.' : '');
    } else status('');
  }
  el.eText.addEventListener('input', () => {
    if (!current) return;
    openFiles.get(current).content = el.eText.value;
    status('Alterações não salvas.');
    renderTabs();
  });
  async function saveCurrent() {
    if (!current) return;
    const f = openFiles.get(current);
    try {
      await api('/api/file', { method: 'PUT', body: JSON.stringify({ path: current, content: f.content }) });
      f.saved = f.content;
      status('Salvo.');
      renderTabs();
      refresh();
      markPreviewStale();
    } catch (e) { status('Não foi possível salvar: ' + e.message); }
  }
  el.save.addEventListener('click', saveCurrent);
  el.eText.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveCurrent(); } });
  el.rename.addEventListener('click', async () => {
    if (!current) return;
    if (dirty(current)) { status('Salve o arquivo antes de renomear.'); return; }
    const to = prompt('Novo nome ou caminho:', current);
    if (!to || to === current) return;
    try {
      await api('/api/file/rename', { method: 'POST', body: JSON.stringify({ from: current, to: to.trim() }) });
      const f = openFiles.get(current);
      openFiles.delete(current);
      current = to.trim().replace(/^\/+/, '');
      openFiles.set(current, f);
      await refresh(); renderEditor(); markPreviewStale();
    } catch (e) { status(e.message); }
  });
  el.del.addEventListener('click', async () => {
    if (!current || !confirm('Excluir ' + current + '? Uma cópia fica no histórico do servidor, mas não há botão de restauração nesta versão.')) return;
    try {
      await api('/api/file?path=' + encodeURIComponent(current), { method: 'DELETE' });
      openFiles.delete(current);
      current = [...openFiles.keys()].pop() || null;
      await refresh(); renderEditor(); markPreviewStale();
    } catch (e) { status(e.message); }
  });
  window.addEventListener('beforeunload', (e) => { if (anyDirty()) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- Prévia ----------
  const htmlEntry = () => (files.find((f) => f.path === preferredPreviewEntry) || files.find((f) => f.path === 'index.html') || files.find((f) => /\.html?$/i.test(f.path)) || {}).path;
  async function loadPreview(force) {
    const entry = htmlEntry();
    el.vEmpty.hidden = Boolean(entry);
    el.frame.hidden = !entry;
    if (!entry) { previewLoaded = false; return; }
    if (previewLoaded && !previewStale && !force) return;
    try {
      const { url } = await api('/api/preview-url');
      el.iframe.src = url + entry.split('/').map(encodeURIComponent).join('/') + '?t=' + Date.now();
      previewLoaded = true; previewStale = false; el.stale.hidden = true;
    } catch (e) { el.vEmpty.hidden = false; el.vEmpty.textContent = e.message; }
  }
  function markPreviewStale() {
    if (!previewLoaded) return;
    previewStale = true;
    el.stale.hidden = false;
  }
  el.reload.addEventListener('click', async () => { await refresh(); loadPreview(true); });
  el.sizes.forEach((b) => b.addEventListener('click', () => {
    el.frame.dataset.size = b.dataset.size;
    el.sizes.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));

  // ---------- Integração com o chat ----------
  window.SiartProject = {
    refresh,
    async openPreview(path) {
      preferredPreviewEntry = path || null;
      el.panel.hidden = false;
      el.open.setAttribute('aria-expanded', 'true');
      await refresh();
      if (path && !files.some((f) => f.path === path)) {
        el.vEmpty.hidden = false;
        el.vEmpty.textContent = 'O arquivo HTML não está disponível no projeto.';
      }
      setView('preview');
      await loadPreview(true);
    },
    // chamado quando a Siart altera arquivos
    async onMutation(path) {
      await refresh();
      markPreviewStale();
      if (path && openFiles.has(path) && !dirty(path)) {
        try { const d = await api('/api/file?path=' + encodeURIComponent(path)); const f = openFiles.get(path); f.content = f.saved = d.content; if (path === current) renderEditor(); } catch { /* arquivo pode ter sido renomeado */ }
      } else if (path && dirty(path)) status('A Siart alterou ' + path + ' no servidor. Salvar aqui sobrescreve a versão dela.');
    },
    onChatEnd() { if (view === 'preview' && previewStale && !el.panel.hidden) loadPreview(true); },
    isOpen: () => !el.panel.hidden,
  };
})();
