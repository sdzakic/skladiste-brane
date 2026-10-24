/* Skladište – evidencija ulaza/izlaza dijelova. Sve radi lokalno u pregledniku. */
(() => {
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtQty = n => Number(n || 0).toLocaleString('hr-HR', { maximumFractionDigits: 3 });
const fmtDate = d => { if (!d) return ''; const [y, m, dd] = d.split('-'); return `${dd}.${m}.${y}.`; };
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const nowHM = () => { const d = new Date(); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9ČĆŽŠĐ]/g, '');
const loose = s => norm(s).replace(/O/g, '0').replace(/[IL|]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/Z/g, '2').replace(/G/g, '6');

// ---------------------------------------------------------------- DB
const DB_NAME = 'skladiste', DB_VER = 1;
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('artikli')) d.createObjectStore('artikli', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('dokumenti')) d.createObjectStore('dokumenti', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('postavke')) d.createObjectStore('postavke', { keyPath: 'k' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const wrap = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const idb = {
  all: store => wrap(db.transaction(store).objectStore(store).getAll()),
  get: (store, k) => wrap(db.transaction(store).objectStore(store).get(k)),
  put: (store, v) => wrap(db.transaction(store, 'readwrite').objectStore(store).put(v)),
  del: (store, k) => wrap(db.transaction(store, 'readwrite').objectStore(store).delete(k)),
  clear: store => wrap(db.transaction(store, 'readwrite').objectStore(store).clear()),
};

// ---------------------------------------------------------------- STATE
let articles = [], docs = [], settings = { tvrtka: '', adresa: '', lokacija: '', osoba: '', ocrLang: 'hrv+eng' };
const urlCache = new Map(); // artId -> objectURL
let draft = { tip: 'ulaz', stavke: [] };
let dokFilter = '';

async function loadAll() {
  articles = await idb.all('artikli');
  docs = await idb.all('dokumenti');
  const s = await idb.get('postavke', 'main');
  if (s) settings = Object.assign(settings, s.v);
  articles.sort((a, b) => a.sifra.localeCompare(b.sifra, 'hr', { numeric: true }));
}
function imgURL(a) {
  if (!a || !a.slika) return null;
  if (!urlCache.has(a.id)) urlCache.set(a.id, URL.createObjectURL(a.slika));
  return urlCache.get(a.id);
}
function dropURL(id) { if (urlCache.has(id)) { URL.revokeObjectURL(urlCache.get(id)); urlCache.delete(id); } }

function stockMap() {
  const m = new Map();
  for (const a of articles) m.set(a.id, Number(a.pocetno) || 0);
  for (const d of docs) for (const s of d.stavke) {
    if (!m.has(s.artId)) continue;
    m.set(s.artId, m.get(s.artId) + (d.tip === 'ulaz' ? 1 : -1) * Number(s.kol || 0));
  }
  return m;
}
const byId = id => articles.find(a => a.id === id);
function findBySifra(code) {
  const n = norm(code); if (!n) return null;
  return articles.find(a => norm(a.sifra) === n) || articles.find(a => loose(a.sifra) === loose(code)) || null;
}

// ---------------------------------------------------------------- TOAST
let toastT;
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, err ? 4000 : 2200);
}

// ---------------------------------------------------------------- IMAGES
async function loadBitmap(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { return await new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = URL.createObjectURL(file); }); }
}
async function resizeImage(file, max = 900, quality = 0.82) {
  const bmp = await loadBitmap(file);
  const w = bmp.width, h = bmp.height, k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, 'image/jpeg', quality));
}
const blobToDataURL = b => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
async function dataURLToBlob(u) { return (await fetch(u)).blob(); }

// ---------------------------------------------------------------- OCR (Tesseract.js, lokalno)
let worker = null, workerLang = null;
async function getWorker(onProgress) {
  if (!window.Tesseract) throw new Error('OCR biblioteka nije učitana. Potreban je internet pri prvom pokretanju.');
  if (worker && workerLang !== settings.ocrLang) { await worker.terminate(); worker = null; }
  if (!worker) {
    worker = await Tesseract.createWorker(settings.ocrLang, 1, { logger: m => onProgress && onProgress(m) });
    workerLang = settings.ocrLang;
  }
  return worker;
}
async function ocrImage(blob, onProgress) {
  const w = await getWorker(onProgress);
  const big = await resizeImage(blob, 1600, 0.9);
  const { data } = await w.recognize(big);
  return data.text || '';
}
async function detectBarcodes(blob) {
  if (!('BarcodeDetector' in window)) return [];
  try {
    const det = new BarcodeDetector();
    const bmp = await loadBitmap(blob);
    const codes = await det.detect(bmp);
    return [...new Set(codes.map(c => c.rawValue).filter(Boolean))];
  } catch { return []; }
}

// ---------------------------------------------------------------- VIEWS
const TITLES = { artikli: 'Artikli', dokument: 'Ulaz / Izlaz', dokumenti: 'Dokumenti', postavke: 'Postavke' };
function showView(name) {
  $$('.view').forEach(v => v.hidden = v.id !== 'view-' + name);
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $('#view-title').textContent = TITLES[name];
  if (name === 'artikli') renderArticles();
  if (name === 'dokumenti') renderDocs();
  if (name === 'dokument') renderDraft();
  if (name === 'postavke') renderSettings();
  window.scrollTo(0, 0);
}
$$('.tabbar button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

// ---------------------------------------------------------------- ARTIKLI
function renderArticles() {
  const q = norm($('#art-search').value);
  const stock = stockMap();
  const list = articles.filter(a => !q || norm(a.sifra).includes(q) || norm(a.naziv).includes(q));
  $('#art-list').innerHTML = list.map(a => {
    const st = stock.get(a.id) || 0;
    const url = imgURL(a);
    return `<li data-id="${a.id}">
      ${url ? `<img class="thumb" src="${url}" alt="">` : `<div class="thumb">📦</div>`}
      <div class="info"><div class="sifra">${esc(a.sifra)}</div><div class="naziv">${esc(a.naziv)}</div>${a.napomena ? `<div class="sub">${esc(a.napomena)}</div>` : ''}</div>
      <div class="stanje ${st < 0 ? 'neg' : st === 0 ? 'low' : ''}"><b>${fmtQty(st)}</b><span class="sub">${esc(a.jm || 'kom')}</span></div>
    </li>`;
  }).join('');
  $('#art-empty').hidden = articles.length > 0;
  const total = [...stock.values()].reduce((s, v) => s + v, 0);
  $('#art-stats').textContent = articles.length ? `${list.length} / ${articles.length} artikala · ukupno na stanju: ${fmtQty(total)}` : '';
}
$('#art-search').addEventListener('input', renderArticles);
$('#art-list').addEventListener('click', e => { const li = e.target.closest('li'); if (li) openKartica(li.dataset.id); });
$('#art-add').addEventListener('click', () => openArticleDialog(null));
$('#art-scan').addEventListener('click', () => openScan('sifra-artikli'));

// --- dialog artikl
const dlgA = $('#dlg-artikl');
let editingId = null, dlgPhoto = null, afterSaveCb = null;
function openArticleDialog(a, prefill = {}, cb = null) {
  editingId = a ? a.id : null; afterSaveCb = cb;
  dlgPhoto = a ? a.slika || null : null;
  $('#dlg-artikl-title').textContent = a ? 'Uredi artikl' : 'Novi artikl';
  $('#art-sifra').value = a ? a.sifra : (prefill.sifra || '');
  $('#art-naziv').value = a ? a.naziv : (prefill.naziv || '');
  $('#art-jm').value = a ? (a.jm || '') : 'kom';
  $('#art-pocetno').value = a ? (a.pocetno ?? '') : '';
  $('#art-napomena').value = a ? (a.napomena || '') : '';
  $('#art-delete').hidden = !a;
  $('#art-ocr-result').hidden = true; $('#art-ocr-lines').innerHTML = '';
  showDlgPhoto();
  dlgA.showModal();
}
function showDlgPhoto() {
  const img = $('#art-photo-preview'), ph = $('#art-photo-placeholder');
  if (dlgPhoto) { img.src = URL.createObjectURL(dlgPhoto); img.hidden = false; ph.hidden = true; }
  else { img.hidden = true; ph.hidden = false; img.removeAttribute('src'); }
  $('#art-ocr').disabled = !dlgPhoto;
}
async function onPhotoPicked(e) {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { dlgPhoto = await resizeImage(f); showDlgPhoto(); } catch (err) { toast('Greška pri učitavanju slike', true); }
}
$('#art-photo-cam').addEventListener('change', onPhotoPicked);
$('#art-photo-file').addEventListener('change', onPhotoPicked);
$('#art-cancel').addEventListener('click', () => dlgA.close());
$('#art-ocr').addEventListener('click', async () => {
  if (!dlgPhoto) return;
  const btn = $('#art-ocr'); btn.disabled = true; btn.textContent = '⏳ Čitam…';
  try {
    const text = await ocrImage(dlgPhoto, m => { if (m.status === 'recognizing text') btn.textContent = `⏳ ${Math.round(m.progress * 100)}%`; else if (m.status && m.status.includes('load')) btn.textContent = '⏳ Učitavam jezik…'; });
    const lines = text.split('\n').map(s => s.trim()).filter(s => s.length > 1);
    if (!lines.length) { toast('Nije prepoznat tekst. Probaj oštriju sliku.', true); return; }
    $('#art-ocr-lines').innerHTML = lines.map((l, i) => `<li><span>${esc(l)}</span><span class="mini"><button type="button" class="btn" data-f="sifra" data-i="${i}">Šifra</button><button type="button" class="btn" data-f="naziv" data-i="${i}">Naziv</button></span></li>`).join('');
    $('#art-ocr-result').hidden = false;
    $('#art-ocr-lines').onclick = ev => { const b = ev.target.closest('button'); if (!b) return; $('#art-' + b.dataset.f).value = lines[+b.dataset.i]; toast('Upisano u polje ' + (b.dataset.f === 'sifra' ? 'Šifra' : 'Naziv')); };
  } catch (err) { toast(err.message || 'OCR greška', true); }
  finally { btn.disabled = false; btn.textContent = '🔎 Očitaj tekst sa slike'; }
});
dlgA.querySelector('form').addEventListener('submit', async e => {
  e.preventDefault();
  const sifra = $('#art-sifra').value.trim(), naziv = $('#art-naziv').value.trim();
  if (!sifra || !naziv) return;
  const dup = articles.find(a => a.id !== editingId && norm(a.sifra) === norm(sifra));
  if (dup && !confirm(`Šifra "${dup.sifra}" već postoji (${dup.naziv}). Svejedno spremi?`)) return;
  const a = editingId ? { ...byId(editingId) } : { id: uuid(), createdAt: Date.now() };
  Object.assign(a, { sifra, naziv, jm: $('#art-jm').value.trim() || 'kom', pocetno: parseFloat($('#art-pocetno').value) || 0, napomena: $('#art-napomena').value.trim(), slika: dlgPhoto, updatedAt: Date.now() });
  await idb.put('artikli', a); dropURL(a.id);
  await loadAll(); dlgA.close(); renderArticles(); toast(editingId ? 'Artikl spremljen' : 'Artikl dodan');
  if (afterSaveCb) { const cb = afterSaveCb; afterSaveCb = null; cb(byId(a.id)); }
});
$('#art-delete').addEventListener('click', async () => {
  const a = byId(editingId); if (!a) return;
  const used = docs.some(d => d.stavke.some(s => s.artId === a.id));
  if (!confirm(`Obrisati artikl "${a.sifra} – ${a.naziv}"?${used ? '\n\nArtikl se koristi u dokumentima; stavke u dokumentima ostaju, ali artikl više neće biti na stanju.' : ''}`)) return;
  await idb.del('artikli', a.id); dropURL(a.id); await loadAll(); dlgA.close(); $('#dlg-kartica').close(); renderArticles(); toast('Artikl obrisan');
});

// --- kartica
let karticaId = null;
function openKartica(id) {
  const a = byId(id); if (!a) return; karticaId = id;
  const stock = stockMap(); const url = imgURL(a);
  $('#kartica-head').innerHTML = `${url ? `<img src="${url}" alt="">` : '<div class="thumb">📦</div>'}
    <div><div class="sifra">${esc(a.sifra)}</div><div>${esc(a.naziv)}</div><div class="big">${fmtQty(stock.get(id))} <small>${esc(a.jm || 'kom')}</small></div>${a.napomena ? `<div class="sub">${esc(a.napomena)}</div>` : ''}</div>`;
  const rows = [];
  for (const d of docs) for (const s of d.stavke) if (s.artId === id) rows.push({ datum: d.datum, vrijeme: d.vrijeme, broj: d.broj, lok: d.lokacija, q: (d.tip === 'ulaz' ? 1 : -1) * Number(s.kol || 0), createdAt: d.createdAt });
  rows.sort((x, y) => (x.datum + x.vrijeme).localeCompare(y.datum + y.vrijeme) || x.createdAt - y.createdAt);
  let bal = Number(a.pocetno) || 0;
  let html = `<tr><td>—</td><td>Početno</td><td></td><td class="num"></td><td class="num">${fmtQty(bal)}</td></tr>`;
  for (const r of rows) { bal += r.q; html += `<tr><td>${fmtDate(r.datum)}</td><td>${esc(r.broj)}</td><td>${esc(r.lok)}</td><td class="num ${r.q >= 0 ? 'plus' : 'minus'}">${r.q >= 0 ? '+' : '−'}${fmtQty(Math.abs(r.q))}</td><td class="num">${fmtQty(bal)}</td></tr>`; }
  $('#kartica-table tbody').innerHTML = html;
  $('#dlg-kartica').showModal();
}
$('#kartica-close').addEventListener('click', () => $('#dlg-kartica').close());
$('#kartica-edit').addEventListener('click', () => { $('#dlg-kartica').close(); openArticleDialog(byId(karticaId)); });

// ---------------------------------------------------------------- ULAZ / IZLAZ (draft)
function renderDraft() {
  $$('#doc-tip button').forEach(b => b.classList.toggle('active', b.dataset.tip === draft.tip));
  if (!$('#doc-datum').value) $('#doc-datum').value = todayISO();
  if (!$('#doc-vrijeme').value) $('#doc-vrijeme').value = nowHM();
  if (!$('#doc-lokacija').value && settings.lokacija) $('#doc-lokacija').value = settings.lokacija;
  $('#doc-osoba-label').firstChild.textContent = draft.tip === 'ulaz' ? 'Predao (dobavljač / osoba) ' : 'Preuzeo (osoba) ';
  $('#doc-save').textContent = draft.tip === 'ulaz' ? '💾 Spremi ULAZ i ispiši' : '💾 Spremi IZLAZ i ispiši';
  $('#doc-save').style.background = draft.tip === 'ulaz' ? '' : 'var(--warn)';
  $('#doc-save').style.borderColor = draft.tip === 'ulaz' ? '' : 'var(--warn)';
  const loks = [...new Set([settings.lokacija, ...docs.map(d => d.lokacija)].filter(Boolean))];
  $('#lokacije-list').innerHTML = loks.map(l => `<option value="${esc(l)}">`).join('');
  renderItems();
}
function renderItems() {
  const stock = stockMap(); const sign = draft.tip === 'ulaz' ? '+' : '−';
  $('#doc-items tbody').innerHTML = draft.stavke.map((s, i) => {
    const st = stock.get(s.artId) ?? 0; const warn = draft.tip === 'izlaz' && s.kol > st;
    return `<tr><td>${i + 1}</td><td class="sifra">${esc(s.sifra)}</td><td>${esc(s.naziv)}${warn ? `<br><small style="color:var(--danger)">na stanju: ${fmtQty(st)}</small>` : ''}</td>
      <td class="num"><span class="${sign === '+' ? 'plus' : 'minus'}">${sign}</span><input type="number" step="any" inputmode="decimal" min="0" value="${s.kol}" data-i="${i}"></td>
      <td><button class="del" data-del="${i}" title="Ukloni">✕</button></td></tr>`;
  }).join('');
  $('#doc-items').hidden = !draft.stavke.length;
  $('#doc-items-empty').hidden = draft.stavke.length > 0;
}
$('#doc-items').addEventListener('input', e => { if (e.target.matches('input[data-i]')) draft.stavke[+e.target.dataset.i].kol = parseFloat(e.target.value) || 0; });
$('#doc-items').addEventListener('click', e => { const b = e.target.closest('[data-del]'); if (b) { draft.stavke.splice(+b.dataset.del, 1); renderItems(); } });
$$('#doc-tip button').forEach(b => b.addEventListener('click', () => { draft.tip = b.dataset.tip; renderDraft(); }));

function addLine(a, kol) {
  kol = Number(kol) || 0; if (!a || kol <= 0) return false;
  const ex = draft.stavke.find(s => s.artId === a.id);
  if (ex) ex.kol = Number(ex.kol) + kol; else draft.stavke.push({ artId: a.id, sifra: a.sifra, naziv: a.naziv, jm: a.jm || 'kom', kol });
  renderItems(); return true;
}

// autocomplete
let selectedArt = null;
const sugg = $('#stavka-suggest'), inp = $('#stavka-trazi');
function renderSuggest() {
  const q = norm(inp.value); selectedArt = null;
  if (!q) { sugg.hidden = true; return; }
  const hits = articles.filter(a => norm(a.sifra).includes(q) || norm(a.naziv).includes(q)).slice(0, 8);
  const exact = findBySifra(inp.value); if (exact) selectedArt = exact;
  sugg.innerHTML = hits.map(a => `<li data-id="${a.id}">${imgURL(a) ? `<img src="${imgURL(a)}" alt="">` : ''}<div><div class="sifra">${esc(a.sifra)}</div><div class="naziv">${esc(a.naziv)}</div></div></li>`).join('')
    + `<li class="new" data-new="1">➕ Novi artikl „${esc(inp.value.trim())}”</li>`;
  sugg.hidden = false;
}
inp.addEventListener('input', renderSuggest);
inp.addEventListener('focus', renderSuggest);
inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); if (selectedArt) $('#stavka-kol').focus(); } });
sugg.addEventListener('mousedown', e => e.preventDefault());
sugg.addEventListener('click', e => {
  const li = e.target.closest('li'); if (!li) return;
  if (li.dataset.new) { sugg.hidden = true; openArticleDialog(null, { sifra: inp.value.trim() }, a => { selectedArt = a; inp.value = a.sifra; $('#stavka-kol').focus(); }); return; }
  selectedArt = byId(li.dataset.id); inp.value = selectedArt.sifra; sugg.hidden = true; $('#stavka-kol').focus();
});
document.addEventListener('click', e => { if (!e.target.closest('.autocomplete')) sugg.hidden = true; });
$('#stavka-kol').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#stavka-dodaj').click(); } });
$('#stavka-dodaj').addEventListener('click', () => {
  const a = selectedArt || findBySifra(inp.value);
  const kol = parseFloat($('#stavka-kol').value);
  if (!a) { toast('Odaberi artikl s popisa', true); inp.focus(); return; }
  if (!(kol > 0)) { toast('Upiši količinu', true); $('#stavka-kol').focus(); return; }
  addLine(a, kol); inp.value = ''; $('#stavka-kol').value = ''; selectedArt = null; inp.focus();
});
$('#stavka-scan').addEventListener('click', () => openScan('sifra-stavka'));
$('#stavka-ocr').addEventListener('click', () => openScan('ocr-popis'));

$('#doc-reset').addEventListener('click', () => { if (!draft.stavke.length || confirm('Očistiti sve stavke i polja?')) resetDraft(); });
function resetDraft() {
  draft = { tip: draft.tip, stavke: [] };
  $('#doc-datum').value = ''; $('#doc-vrijeme').value = ''; $('#doc-lokacija').value = ''; $('#doc-osoba').value = ''; $('#doc-napomena').value = '';
  inp.value = ''; $('#stavka-kol').value = '';
  renderDraft();
}
function nextBroj(tip, datum) {
  const y = (datum || todayISO()).slice(0, 4); const pre = (tip === 'ulaz' ? 'U' : 'I') + '-' + y + '-';
  let max = 0; for (const d of docs) if (d.broj && d.broj.startsWith(pre)) max = Math.max(max, parseInt(d.broj.slice(pre.length), 10) || 0);
  return pre + String(max + 1).padStart(4, '0');
}
$('#doc-save').addEventListener('click', async () => {
  if (!draft.stavke.length) { toast('Dodaj barem jednu stavku', true); return; }
  if (draft.stavke.some(s => !(s.kol > 0))) { toast('Sve količine moraju biti veće od 0', true); return; }
  const datum = $('#doc-datum').value || todayISO();
  if (draft.tip === 'izlaz') {
    const stock = stockMap(); const neg = draft.stavke.filter(s => s.kol > (stock.get(s.artId) ?? 0));
    if (neg.length && !confirm(`Za ${neg.length} stavku/e izlaz je veći od stanja:\n${neg.map(s => `• ${s.sifra} (${s.naziv})`).join('\n')}\n\nSvejedno spremi?`)) return;
  }
  const d = { id: uuid(), broj: nextBroj(draft.tip, datum), tip: draft.tip, datum, vrijeme: $('#doc-vrijeme').value || nowHM(), lokacija: $('#doc-lokacija').value.trim(), osoba: $('#doc-osoba').value.trim(), napomena: $('#doc-napomena').value.trim(), stavke: draft.stavke.map(s => ({ ...s, kol: Number(s.kol) })), createdAt: Date.now() };
  await idb.put('dokumenti', d); await loadAll(); resetDraft(); toast(`Dokument ${d.broj} spremljen`);
  openPrint(d);
});

// ---------------------------------------------------------------- SKENER / OCR dialog
const dlgS = $('#dlg-scan');
let scanMode = 'sifra-stavka', scanMatches = [], liveStream = null, liveTimer = null;
function openScan(mode) {
  scanMode = mode;
  $('#scan-title').textContent = mode === 'ocr-popis' ? 'OCR popisa stavki' : 'Skeniraj šifru';
  $('#scan-status').textContent = mode === 'ocr-popis'
    ? 'Slikaj popis / etikete. Tekst se čita lokalno (bez interneta nakon prvog puta) i uspoređuje sa šiframa u bazi.'
    : 'Slikaj barkod, QR ili natpis sa šifrom. Šifra se traži u bazi artikala.';
  $('#scan-results').innerHTML = ''; $('#scan-apply').hidden = true; $('#scan-progress').hidden = true;
  $('#scan-preview').hidden = true; $('#scan-video').hidden = true;
  $('#scan-live').hidden = !('BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia) || mode === 'ocr-popis';
  dlgS.showModal();
}
function stopLive() { clearInterval(liveTimer); liveTimer = null; if (liveStream) { liveStream.getTracks().forEach(t => t.stop()); liveStream = null; } $('#scan-video').hidden = true; }
$('#scan-close').addEventListener('click', () => { stopLive(); dlgS.close(); });
dlgS.addEventListener('close', stopLive);
const onScanFile = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) await processScan(f); };
$('#scan-cam').addEventListener('change', onScanFile);
$('#scan-file').addEventListener('change', onScanFile);

$('#scan-live').addEventListener('click', async () => {
  try {
    liveStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const v = $('#scan-video'); v.srcObject = liveStream; v.hidden = false; $('#scan-preview').hidden = true; await v.play();
    const det = new BarcodeDetector(); $('#scan-status').textContent = 'Usmjeri kameru na barkod…';
    liveTimer = setInterval(async () => {
      try { const codes = await det.detect(v); if (codes.length) { stopLive(); handleCodes(codes.map(c => c.rawValue), ''); } } catch {}
    }, 350);
  } catch (err) { toast('Kamera nije dostupna: ' + err.message, true); }
});

async function processScan(file) {
  stopLive();
  const prog = $('#scan-progress'), status = $('#scan-status');
  $('#scan-results').innerHTML = ''; $('#scan-apply').hidden = true;
  const small = await resizeImage(file, 1200, 0.85);
  const pv = $('#scan-preview'); pv.src = URL.createObjectURL(small); pv.hidden = false;
  status.textContent = 'Tražim barkod…'; prog.hidden = false; prog.value = 0;
  const codes = await detectBarcodes(small);
  if (codes.length && scanMode !== 'ocr-popis') { prog.hidden = true; handleCodes(codes, ''); return; }
  status.textContent = 'Čitam tekst (OCR)…';
  let text = '';
  try {
    text = await ocrImage(small, m => { if (m.status === 'recognizing text') { prog.value = m.progress; status.textContent = `Čitam tekst… ${Math.round(m.progress * 100)}%`; } else if (/load|init/.test(m.status || '')) status.textContent = 'Učitavam OCR jezik (prvi put traje duže)…'; });
  } catch (err) { status.textContent = 'OCR nije uspio: ' + err.message; prog.hidden = true; return; }
  prog.hidden = true;
  if (scanMode === 'ocr-popis') handlePopis(text); else handleCodes(codes, text);
}

function handleCodes(codes, text) {
  const tokens = [...codes];
  for (const t of text.split(/[\s,;:]+/)) if (t.length >= 3) tokens.push(t.replace(/^[^\wČĆŽŠĐ]+|[^\wČĆŽŠĐ]+$/g, ''));
  const seen = new Set(); const hits = [];
  for (const t of tokens) { const a = findBySifra(t); if (a && !seen.has(a.id)) { seen.add(a.id); hits.push(a); } }
  const res = $('#scan-results');
  if (hits.length) {
    $('#scan-status').textContent = hits.length === 1 ? 'Pronađen artikl:' : 'Pronađeno više artikala, odaberi:';
    res.innerHTML = hits.map(a => `<div class="match">${imgURL(a) ? `<img src="${imgURL(a)}" style="width:44px;height:44px;object-fit:cover;border-radius:6px" alt="">` : ''}<div class="info"><div class="sifra">${esc(a.sifra)}</div><div class="naziv">${esc(a.naziv)}</div></div>
      ${scanMode === 'sifra-stavka' ? `<input type="number" step="any" inputmode="decimal" min="0" value="1" data-kol="${a.id}">` : ''}<button class="btn primary" data-pick="${a.id}">Odaberi</button></div>`).join('');
    if (hits.length === 1 && scanMode === 'sifra-artikli') { pickArticle(hits[0]); return; }
  } else {
    const cand = [...new Set(tokens.filter(t => /\d/.test(t) && t.length >= 3))].slice(0, 8);
    $('#scan-status').textContent = 'Šifra nije pronađena u bazi.' + (cand.length ? ' Odaberi očitani tekst za novi artikl ili pretragu:' : '');
    res.innerHTML = cand.map(c => `<div class="match"><div class="info"><div class="sifra">${esc(c)}</div></div><button class="btn" data-search="${esc(c)}">Traži</button><button class="btn primary" data-create="${esc(c)}">Novi artikl</button></div>`).join('')
      + (text.trim() ? `<details><summary>Sav očitani tekst</summary><div class="rawtext">${esc(text.trim())}</div></details>` : '');
  }
  res.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.pick) { const a = byId(b.dataset.pick); const k = res.querySelector(`[data-kol="${a.id}"]`); pickArticle(a, k ? parseFloat(k.value) : 1); }
    if (b.dataset.search) { dlgS.close(); showView('artikli'); $('#art-search').value = b.dataset.search; renderArticles(); }
    if (b.dataset.create) { dlgS.close(); openArticleDialog(null, { sifra: b.dataset.create }, scanMode === 'sifra-stavka' ? a => { addLine(a, 1); toast('Dodano u stavke (kol. 1)'); } : null); }
  };
}
function pickArticle(a, kol = 1) {
  dlgS.close();
  if (scanMode === 'sifra-artikli') openKartica(a.id);
  else { if (addLine(a, kol)) toast(`Dodano: ${a.sifra} × ${fmtQty(kol)}`); else toast('Neispravna količina', true); }
}

function handlePopis(text) {
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  scanMatches = [];
  for (const line of lines) {
    const L = loose(line);
    let best = null;
    for (const a of articles) { const s = loose(a.sifra); if (s.length >= 3 && L.includes(s) && (!best || s.length > loose(best.sifra).length)) best = a; }
    if (!best) { const N = norm(line); best = articles.find(a => norm(a.naziv).length >= 4 && N.includes(norm(a.naziv))) || null; }
    if (!best) continue;
    // količina: broj na kraju retka (nakon šifre), npr. "ABC-123 ... 5" ili "x5" ili "5 kom"
    let rest = line.replace(new RegExp(best.sifra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
    const m = rest.match(/(?:x|×|kom\.?|:)?\s*(\d+(?:[.,]\d+)?)\s*(?:kom|x|pcs|kos|m|kg)?\.?\s*$/i);
    const kol = m ? parseFloat(m[1].replace(',', '.')) : 1;
    if (!scanMatches.some(x => x.a.id === best.id)) scanMatches.push({ a: best, kol: kol > 0 ? kol : 1, line });
  }
  const res = $('#scan-results');
  if (!scanMatches.length) {
    $('#scan-status').textContent = 'Nijedna šifra s popisa nije pronađena u bazi.';
    res.innerHTML = text.trim() ? `<details open><summary>Očitani tekst</summary><div class="rawtext">${esc(text.trim())}</div></details>` : '';
    return;
  }
  $('#scan-status').textContent = `Prepoznato ${scanMatches.length} artikala. Provjeri količine i označi što dodati:`;
  res.innerHTML = scanMatches.map((m, i) => `<div class="match"><input type="checkbox" checked data-ck="${i}"><div class="info"><div class="sifra">${esc(m.a.sifra)}</div><div class="naziv">${esc(m.a.naziv)}</div><div class="naziv" style="opacity:.7">„${esc(m.line)}”</div></div><input type="number" step="any" inputmode="decimal" min="0" value="${m.kol}" data-k="${i}"></div>`).join('')
    + `<details><summary>Sav očitani tekst</summary><div class="rawtext">${esc(text.trim())}</div></details>`;
  $('#scan-apply').hidden = false;
}
$('#scan-apply').addEventListener('click', () => {
  let n = 0;
  scanMatches.forEach((m, i) => {
    if (!$(`[data-ck="${i}"]`).checked) return;
    const kol = parseFloat($(`[data-k="${i}"]`).value); if (addLine(m.a, kol)) n++;
  });
  dlgS.close(); toast(`Dodano ${n} stavki`);
});

// ---------------------------------------------------------------- DOKUMENTI
function renderDocs() {
  const list = docs.filter(d => !dokFilter || d.tip === dokFilter).sort((a, b) => (b.datum + b.vrijeme).localeCompare(a.datum + a.vrijeme) || b.createdAt - a.createdAt);
  $('#dok-list').innerHTML = list.map(d => {
    const tot = d.stavke.reduce((s, x) => s + Number(x.kol || 0), 0);
    return `<li data-id="${d.id}"><div class="thumb">${d.tip === 'ulaz' ? '⬇' : '⬆'}</div>
      <div class="info"><div class="sifra">${esc(d.broj)} <span class="badge ${d.tip}">${d.tip.toUpperCase()}</span></div><div class="naziv">${fmtDate(d.datum)} ${esc(d.vrijeme)} · ${esc(d.lokacija || '—')}</div><div class="sub">${d.stavke.length} stavki${d.osoba ? ' · ' + esc(d.osoba) : ''}</div></div>
      <div class="stanje"><b>${d.tip === 'ulaz' ? '+' : '−'}${fmtQty(tot)}</b></div></li>`;
  }).join('');
  $('#dok-empty').hidden = list.length > 0;
}
$$('#dok-filter button').forEach(b => b.addEventListener('click', () => { dokFilter = b.dataset.f; $$('#dok-filter button').forEach(x => x.classList.toggle('active', x === b)); renderDocs(); }));
$('#dok-list').addEventListener('click', e => { const li = e.target.closest('li'); if (li) openPrint(docs.find(d => d.id === li.dataset.id)); });

// ---------------------------------------------------------------- ISPIS
let printDocId = null;
function openPrint(d) {
  if (!d) return; printDocId = d.id;
  const ulaz = d.tip === 'ulaz'; const sign = ulaz ? '+' : '−';
  const tot = d.stavke.reduce((s, x) => s + Number(x.kol || 0), 0);
  const rows = d.stavke.map((s, i) => `<tr><td class="c">${i + 1}.</td><td>${esc(s.sifra)}</td><td>${esc(s.naziv)}</td><td class="c">${esc(s.jm || 'kom')}</td><td class="num">${sign} ${fmtQty(s.kol)}</td></tr>`).join('');
  const lijevi = ulaz ? ['Predao', d.osoba] : ['Izdao', settings.osoba];
  const desni = ulaz ? ['Zaprimio', settings.osoba] : ['Preuzeo', d.osoba];
  $('#paper').innerHTML = `
    <div class="ph">
      <div class="firma">${esc(settings.tvrtka || 'Skladište')}<small>${esc(settings.adresa || '')}</small></div>
      <div class="docno"><div class="tip">${ulaz ? 'PRIMKA – ULAZ' : 'IZDATNICA – IZLAZ'}</div><div>Broj: <b>${esc(d.broj)}</b></div></div>
    </div>
    <div class="meta">
      <div><b>Datum:</b> ${fmtDate(d.datum)}</div><div><b>Vrijeme:</b> ${esc(d.vrijeme)}</div>
      <div><b>Lokacija:</b> ${esc(d.lokacija || '—')}</div><div><b>${ulaz ? 'Predao:' : 'Preuzeo:'}</b> ${esc(d.osoba || '—')}</div>
    </div>
    <table>
      <thead><tr><th class="c" style="width:7%">R.br.</th><th style="width:22%">Šifra</th><th>Naziv artikla</th><th class="c" style="width:9%">JM</th><th class="num" style="width:16%">Količina ${sign}</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="4">Ukupno stavki: ${d.stavke.length}</td><td class="num">${sign} ${fmtQty(tot)}</td></tr></tfoot>
    </table>
    <div class="napomena"><b>Napomena:</b>${esc(d.napomena || '')}</div>
    <div class="potpisi">
      <div class="potpis"><div class="ime">${esc(lijevi[1] || '')}</div><div class="linija">${lijevi[0]} (potpis)</div></div>
      <div class="potpis"><div class="ime">${esc(desni[1] || '')}</div><div class="linija">${desni[0]} (potpis)</div></div>
    </div>
    <div class="foot">Ispisano ${new Date().toLocaleString('hr-HR')} · Skladište</div>`;
  let del = $('#print-delete');
  if (!del) { del = document.createElement('button'); del.id = 'print-delete'; del.className = 'btn danger'; del.textContent = 'Obriši'; $('.print-toolbar').insertBefore(del, $('#print-now')); del.addEventListener('click', deletePrintDoc); }
  $('#print-view').hidden = false; document.body.style.overflow = 'hidden'; window.scrollTo(0, 0);
}
async function deletePrintDoc() {
  const d = docs.find(x => x.id === printDocId); if (!d) return;
  if (!confirm(`Obrisati dokument ${d.broj}? Stanje artikala će se vratiti.`)) return;
  await idb.del('dokumenti', d.id); await loadAll(); closePrint(); renderDocs(); toast('Dokument obrisan');
}
function closePrint() { $('#print-view').hidden = true; document.body.style.overflow = ''; }
$('#print-back').addEventListener('click', closePrint);
$('#print-now').addEventListener('click', () => window.print());

// ---------------------------------------------------------------- POSTAVKE / IZVOZ
function renderSettings() {
  $('#set-tvrtka').value = settings.tvrtka || ''; $('#set-adresa').value = settings.adresa || '';
  $('#set-lokacija').value = settings.lokacija || ''; $('#set-osoba').value = settings.osoba || '';
  $('#set-ocr-lang').value = settings.ocrLang || 'hrv+eng';
}
async function saveSettings() { await idb.put('postavke', { k: 'main', v: settings }); }
$('#set-save').addEventListener('click', async () => {
  Object.assign(settings, { tvrtka: $('#set-tvrtka').value.trim(), adresa: $('#set-adresa').value.trim(), lokacija: $('#set-lokacija').value.trim(), osoba: $('#set-osoba').value.trim() });
  await saveSettings(); toast('Postavke spremljene');
});
$('#set-ocr-lang').addEventListener('change', async e => { settings.ocrLang = e.target.value; await saveSettings(); toast('OCR jezik: ' + e.target.selectedOptions[0].text); });

function download(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
const csvCell = v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csv = rows => '﻿' + rows.map(r => r.map(csvCell).join(';')).join('\r\n');
const stamp = () => todayISO().replace(/-/g, '');

$('#exp-json').addEventListener('click', async () => {
  const arts = [];
  for (const a of articles) arts.push({ ...a, slika: a.slika ? await blobToDataURL(a.slika) : null });
  const out = { app: 'skladiste', version: 1, exportedAt: new Date().toISOString(), settings, articles: arts, docs };
  download(`skladiste-kopija-${stamp()}.json`, new Blob([JSON.stringify(out)], { type: 'application/json' }));
  toast('Sigurnosna kopija spremljena');
});
$('#imp-json').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'skladiste' || !Array.isArray(data.articles)) throw new Error('Datoteka nije sigurnosna kopija ove aplikacije');
    if (!confirm(`Učitati kopiju od ${new Date(data.exportedAt).toLocaleString('hr-HR')}?\n${data.articles.length} artikala, ${(data.docs || []).length} dokumenata.\n\nPOSTOJEĆI PODACI NA OVOM UREĐAJU BIT ĆE ZAMIJENJENI.`)) return;
    await idb.clear('artikli'); await idb.clear('dokumenti');
    for (const a of data.articles) await idb.put('artikli', { ...a, slika: a.slika ? await dataURLToBlob(a.slika) : null });
    for (const d of data.docs || []) await idb.put('dokumenti', d);
    if (data.settings) { settings = Object.assign(settings, data.settings); await saveSettings(); }
    urlCache.forEach((u) => URL.revokeObjectURL(u)); urlCache.clear();
    await loadAll(); renderSettings(); toast('Kopija učitana');
  } catch (err) { toast('Greška: ' + err.message, true); }
});
$('#exp-csv').addEventListener('click', () => {
  const stock = stockMap();
  const rows = [['Šifra', 'Naziv', 'JM', 'Stanje', 'Napomena'], ...articles.map(a => [a.sifra, a.naziv, a.jm || 'kom', String(stock.get(a.id) ?? 0).replace('.', ','), a.napomena || ''])];
  download(`stanje-${stamp()}.csv`, new Blob([csv(rows)], { type: 'text/csv;charset=utf-8' }));
});
$('#exp-promet').addEventListener('click', () => {
  const rows = [['Datum', 'Vrijeme', 'Broj', 'Tip', 'Lokacija', 'Osoba', 'Šifra', 'Naziv', 'JM', 'Količina', 'Napomena']];
  for (const d of [...docs].sort((a, b) => (a.datum + a.vrijeme).localeCompare(b.datum + b.vrijeme))) for (const s of d.stavke)
    rows.push([fmtDate(d.datum), d.vrijeme, d.broj, d.tip, d.lokacija, d.osoba, s.sifra, s.naziv, s.jm, String((d.tip === 'ulaz' ? 1 : -1) * s.kol).replace('.', ','), d.napomena]);
  download(`promet-${stamp()}.csv`, new Blob([csv(rows)], { type: 'text/csv;charset=utf-8' }));
});
$('#clear-all').addEventListener('click', async () => {
  if (!confirm('Obrisati SVE artikle i dokumente s ovog uređaja?')) return;
  if (prompt('Za potvrdu upiši: OBRIŠI') !== 'OBRIŠI') return;
  await idb.clear('artikli'); await idb.clear('dokumenti'); urlCache.clear(); await loadAll(); resetDraft(); toast('Svi podaci obrisani');
});

// ---------------------------------------------------------------- INIT
(async () => {
  db = await openDB(); await loadAll();
  renderDraft(); showView('artikli');
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
})();
