'use strict';
// Gerador de PDF de texto (A4, Helvetica) sem dependências.
// Suporta títulos (#), listas (- ), parágrafos com quebra de linha e paginação.
// Não suporta imagens, tabelas nem fontes incorporadas; caracteres fora do Latin-1 viram "?".

const W = 595, H = 842, MARGIN = 56;
const WIN1252 = { '“': 0x93, '”': 0x94, '‘': 0x91, '’': 0x92, '–': 0x96, '—': 0x97, '•': 0x95, '…': 0x85, '€': 0x80 };

function toWin(str) {
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c === 9) out.push(32, 32, 32, 32);
    else if (c < 32) continue;
    else if (WIN1252[ch]) out.push(WIN1252[ch]);
    else if (c <= 255) out.push(c);
    else out.push(63);
  }
  return Buffer.from(out);
}

function escapePdf(buf) {
  const out = [];
  for (const b of buf) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out.push(0x5c);
    out.push(b);
  }
  return Buffer.from(out);
}

function wrap(text, size, indent) {
  const maxChars = Math.max(10, Math.floor((W - 2 * MARGIN - indent) / (size * 0.56)));
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (let w of words) {
    while (w.length > maxChars) { // palavra maior que a linha
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(w.slice(0, maxChars));
      w = w.slice(maxChars);
    }
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function layout(text) {
  const pages = [[]];
  let y = H - MARGIN;
  const place = (line, font, size, indent, gapBefore) => {
    const lead = size * 1.4;
    if (y - gapBefore - lead < MARGIN) { pages.push([]); y = H - MARGIN; }
    else if (y !== H - MARGIN) y -= gapBefore;
    y -= lead;
    pages[pages.length - 1].push({ line, font, size, x: MARGIN + indent, y });
  };
  const clean = (s) => s.replace(/\*\*(.*?)\*\*/g, '$1').replace(/`([^`]*)`/g, '$1');
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const t = raw.trimEnd();
    if (!t.trim()) { y -= 6; continue; }
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const size = h[1].length === 1 ? 20 : h[1].length === 2 ? 15 : 12.5;
      wrap(clean(h[2]), size, 0).forEach((l, i) => place(l, 'F2', size, 0, i === 0 ? size * 0.6 : 0));
    } else if (/^\s*[-*]\s+/.test(t)) {
      wrap(clean(t.replace(/^\s*[-*]\s+/, '')), 11, 14).forEach((l, i) => place(i === 0 ? '\u2022 ' + l : '  ' + l, 'F1', 11, 0, 0));
    } else {
      wrap(clean(t), 11, 0).forEach((l) => place(l, 'F1', 11, 0, 0));
    }
  }
  return pages;
}

function generatePdf(text, { title = '' } = {}) {
  const pages = layout(String(text));
  const objs = [];
  const n = pages.length;
  objs[1] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>');
  objs[2] = Buffer.from(`<< /Type /Pages /Kids [${pages.map((_, i) => `${6 + 2 * i} 0 R`).join(' ')}] /Count ${n} >>`);
  objs[3] = Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objs[4] = Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  objs[5] = Buffer.concat([Buffer.from('<< /Title ('), escapePdf(toWin(title)), Buffer.from(') /Producer (Siart) >>')]);
  pages.forEach((items, i) => {
    const parts = items.map((it) => Buffer.concat([
      Buffer.from(`BT /${it.font} ${it.size} Tf ${it.x.toFixed(2)} ${it.y.toFixed(2)} Td (`),
      escapePdf(toWin(it.line)),
      Buffer.from(') Tj ET\n'),
    ]));
    const stream = Buffer.concat(parts);
    objs[6 + 2 * i] = Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${7 + 2 * i} 0 R >>`);
    objs[7 + 2 * i] = Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('endstream')]);
  });

  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let pos = chunks[0].length;
  for (let i = 1; i < objs.length; i++) {
    const body = Buffer.concat([Buffer.from(`${i} 0 obj\n`), objs[i], Buffer.from('\nendobj\n')]);
    offsets[i] = pos;
    pos += body.length;
    chunks.push(body);
  }
  const size = objs.length;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i < size; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${size} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  chunks.push(Buffer.from(xref));
  return Buffer.concat(chunks);
}

function validatePdf(buf) {
  return Buffer.isBuffer(buf) && buf.length > 200 && buf.slice(0, 5).toString() === '%PDF-' && buf.slice(-8).toString().includes('%%EOF');
}

module.exports = { generatePdf, validatePdf };
