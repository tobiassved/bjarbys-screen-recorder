// Huvudfönstret: välj källa, starta inspelning, bläddra i biblioteket.
const $ = id => document.getElementById(id);
const state = { source: null, caps: null };

const fmt = s => { s = Math.round(s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

async function loadSources() {
  const box = $('sources');
  box.replaceChildren(el('span', { className: 'dim', textContent: 'Hämtar…' }));
  let list = [];
  try { list = await api.sources(); } catch (e) { box.textContent = 'Kunde inte lista skärmarna: ' + e.message; return; }
  box.replaceChildren();
  list.sort((a, b) => (a.type === b.type ? 0 : a.type === 'screen' ? -1 : 1));
  for (const s of list) {
    const b = el('button', { className: 'src' + (state.source === s.id ? ' sel' : ''), title: s.name },
      el('img', { src: s.thumb, alt: '' }), el('span', { textContent: (s.type === 'screen' ? '🖥 ' : '🗔 ') + s.name }));
    b.onclick = () => { state.source = s.id; for (const x of box.children) x.classList.remove('sel'); b.classList.add('sel'); $('record').disabled = false; };
    box.append(b);
  }
  if (!list.some(s => s.id === state.source)) { state.source = null; $('record').disabled = true; }
  const first = list.find(s => s.type === 'screen');
  if (!state.source && first) box.firstElementChild.click();
}

async function startRecording() {
  if (!state.source) return;
  $('record').disabled = true;
  try {
    await api.startRecording({
      sourceId: state.source, mic: $('mic').checked, clean: $('clean').checked,
      system: $('system').checked, camera: $('camera').checked, countdown: +$('countdown').value,
    });
  } catch (e) { alert(e.message); }
  $('record').disabled = false;
}

async function loadLibrary() {
  const items = await api.library();
  const box = $('lib');
  if (!items.length) { box.replaceChildren(el('span', { className: 'dim', textContent: 'Inga inspelningar än.' })); return; }
  box.replaceChildren(...items.map(it => {
    const when = new Date(it.createdAt);
    const title = it.name || when.toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' });
    const th = el('div', { className: 'th' });
    if (it.thumb) th.style.backgroundImage = `url("app://local/rec/${encodeURIComponent(it.id)}/thumbnail.jpg")`; else th.textContent = 'ingen förhandsbild';
    if (it.duration) th.append(el('span', { className: 'dur', textContent: fmt(it.duration) }));
    const del = el('button', { className: 'x ghost', textContent: '🗑', title: 'Släng i papperskorgen' });
    del.onclick = async e => { e.stopPropagation(); if (confirm(`Slänga «${title}» i papperskorgen?`)) await api.remove(it.id); };
    const folder = el('button', { className: 'x ghost', textContent: '📂', title: 'Visa i Utforskaren' });
    folder.onclick = e => { e.stopPropagation(); api.reveal(it.id); };
    const card = el('div', { className: 'rcard' }, th,
      el('div', { className: 'meta' },
        el('div', { className: 't' }, el('b', { textContent: title }),
          el('small', { textContent: (it.kind === 'window' ? 'Fönster' : 'Skärm') + (it.recovered ? ' · återställd' : '') })),
        folder, del));
    card.onclick = () => api.openEditor(it.id);
    return card;
  }));
}

async function init() {
  state.caps = await api.capabilities();
  const w = $('warnings');
  if (!state.caps.ffmpeg) w.append(el('div', { className: 'banner', textContent: 'ffmpeg hittades inte: export till MP4 och GIF går inte (WebM går). Kör «npm install» så följer ffmpeg-static med, eller lägg ffmpeg i PATH.' }));
  if (!state.caps.clicks) w.append(el('div', { className: 'banner', textContent: 'Den globala musroken (uiohook-napi) saknas: klick och kortkommandon spelas inte in, så automatisk zoom på klick fungerar inte. Musens rörelse spelas in ändå.' }));
  if (state.caps.platform !== 'win32') w.append(el('div', { className: 'banner info', textContent: 'Du kör inte på Windows (' + state.caps.platform + '): fångst av datorljud och fönster är anpassad för Windows.' }));
  $('libpath').textContent = state.caps.library;
  $('refresh').onclick = loadSources;
  $('record').onclick = startRecording;
  api.onHotkeyToggle(startRecording);
  api.onLibraryChanged(loadLibrary);
  await Promise.all([loadSources(), loadLibrary()]);
}
init();
