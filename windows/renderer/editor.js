// Redigeraren. Inspelningen rörs aldrig: allt här är beslut i project.json (källtid) som ritas
// på nytt för varje ruta — i förhandsvisningen och, med samma funktion, i exporten.

import { TimeMap, splitAt, removeSegment } from '../lib/timemap.js';
import { CursorPath } from '../lib/cursorpath.js';
import { ViewTrack, planZooms, clampCenter } from '../lib/viewtrack.js';
import { BACKGROUNDS, ASPECTS, outputSize } from '../lib/project.js';
import { drawFrame } from './render.js';

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const fmt = s => { s = Math.max(0, s || 0); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
const once = (target, ev) => new Promise(res => target.addEventListener(ev, res, { once: true }));

const id = new URLSearchParams(location.search).get('id');
const S = {
  meta: null, events: [], project: null, base: '', duration: 0,
  screen: null, aux: [], gains: [], ac: null,
  cursorPath: null, view: null, tm: null, hasCursor: false, keys: [],
  playing: false, exporting: false, sel: null, tab: 'style', dirty: false,
};
const cv = $('cv'), ctx = cv.getContext('2d');

// ───────────────────────── start ─────────────────────────

function makeMedia(tag, file) {
  const m = document.createElement(tag);
  m.src = S.base + file; m.preload = 'auto'; m.muted = tag === 'video'; m.playsInline = true;
  m.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px';
  document.body.append(m);
  return m;
}

// MediaRecorders WebM saknar ofta längd (Infinity). Att hoppa långt fram får Chromium att mäta filen.
async function trueDuration(m, fallback) {
  if (Number.isFinite(m.duration) && m.duration > 0) return m.duration;
  const done = new Promise(res => m.addEventListener('durationchange', () => Number.isFinite(m.duration) && res(), { once: true }));
  m.currentTime = 1e101;
  await Promise.race([done, new Promise(r => setTimeout(r, 4000))]);
  const d = Number.isFinite(m.duration) ? m.duration : fallback;
  m.currentTime = 0;
  return d || fallback;
}

async function init() {
  let data;
  try { data = await api.load(id); } catch (e) { document.body.textContent = 'Kunde inte öppna inspelningen: ' + e.message; return; }
  Object.assign(S, { meta: data.meta, events: data.events, project: data.project, base: data.base });
  $('title').value = S.meta.name || '';
  $('title').placeholder = new Date(S.meta.createdAt).toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' });

  const screenTrack = S.meta.tracks.find(t => t.kind === 'screen');
  if (!screenTrack) { document.body.textContent = 'Inspelningen saknar skärmspår.'; return; }
  S.screen = makeMedia('video', screenTrack.file);
  await Promise.race([once(S.screen, 'loadedmetadata'), once(S.screen, 'error').then(() => { throw new Error('Skärmspåret går inte att läsa'); })]);
  S.duration = await trueDuration(S.screen, S.meta.duration);

  // Ljud och kamera, med sin startförskjutning mot skärmen.
  S.ac = new AudioContext();
  for (const t of S.meta.tracks) {
    if (t.kind === 'screen') continue;
    const isVideo = t.kind === 'camera';
    const m = makeMedia(isVideo ? 'video' : 'audio', t.file);
    const entry = { kind: t.kind, el: m, offset: t.start || 0, gain: null };
    if (!isVideo) {
      const g = S.ac.createGain();
      S.ac.createMediaElementSource(m).connect(g); g.connect(S.ac.destination);
      entry.gain = g; S.gains.push(g);
    }
    S.aux.push(entry);
  }
  S.cam = S.aux.find(a => a.kind === 'camera')?.el || null;

  // Händelser → markörbana, klick, kortkommandon.
  const rc = S.meta.source?.contentRect;
  const rect = rc ? { x: rc[0], y: rc[1], w: rc[2], h: rc[3] } : null;
  S.cursorPath = new CursorPath(S.events, rect, S.duration);
  S.keys = S.events.filter(e => e.k === 'key');
  S.hasCursor = S.cursorPath.hasData && S.meta.cursorBaked !== true;

  // Delarna: ett nytt projekt täcker hela filmen; en inspelning vars längd mättes om justeras.
  const segs = S.project.segments;
  if (segs.length === 1 && Math.abs(segs[0].end - S.meta.duration) < 0.5) segs[0].end = S.duration;
  for (const s of segs) s.end = Math.min(s.end, S.duration);

  // Automatiska zoomar planeras en gång; de som tas bort kommer inte tillbaka.
  if (!S.project.zoomsPlanned) {
    S.project.zooms = planZooms(S.cursorPath.clicks, S.duration, { scale: S.project.zoomScale });
    S.project.zoomsPlanned = true; S.dirty = true;
  }

  banners();
  rebuildTm(); rebuildView(); applyAspect(); buildTimeline(); buildPane();
  S.ac.resume().catch(() => {});
  seek(S.tm.segments[0]?.start ?? 0);
  requestAnimationFrame(frame);
  if (S.dirty) scheduleSave();
}

function banners() {
  const notes = [];
  if (S.meta.cursorBaked === true) notes.push('Markören ligger redan i filmen (fångsten kunde inte dölja den), så den egna markören är avstängd.');
  else if (S.meta.cursorBaked === null && S.hasCursor) notes.push('Osäkert om fångsten dolde markören. Ser du två markörer: stäng av «Visa markör» under Markör.');
  if (!S.meta.source?.contentRect) notes.push('Fönstrets plats är okänd, så markör och zoom på klick saknas.');
  else if (!S.meta.clicksRecorded) notes.push('Klick spelades inte in (musroken saknades): lägg zoomar för hand med «＋ Zoom här».');
  if (S.meta.recovered) notes.push('Återställd inspelning — den avbröts innan den sparades klart.');
  $('status').textContent = notes[0] || '';
  $('status').title = notes.join('\n');
  if (notes.length) $('status').style.color = 'var(--warn)';
}

// ───────────────────────── beräknade tabeller ─────────────────────────

function rebuildTm() { S.tm = new TimeMap(S.project.segments); }
function effectiveZooms() { return S.project.zooms.filter(z => z.enabled !== false && (S.project.autoZoom || !z.auto)); }
function rebuildView() {
  S.view = new ViewTrack(effectiveZooms(), S.duration, S.hasCursor ? t => S.cursorPath.at(t) : null);
}
function applyAspect() {
  const { w, h } = outputSize(S.project.aspect, 1920);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
}

// ───────────────────────── rutan ─────────────────────────

function sceneAt(t, W, H) {
  const p = S.project;
  const clicks = S.cursorPath.clicks.filter(c => t - c.t > -0.05 && t - c.t < 0.6);
  let shortcut = null;
  if (p.shortcuts.visible) {
    for (let i = S.keys.length - 1; i >= 0; i--) {
      const age = t - S.keys[i].t;
      if (age < 0) continue;
      if (age < 1.6) shortcut = { label: S.keys[i].label, alpha: Math.min(1, age / 0.08) * (age > 1.3 ? 1 - (age - 1.3) / 0.3 : 1) };
      break;
    }
  }
  const cam = S.cam && S.cam.readyState >= 2 && S.cam.videoWidth ? { el: S.cam, w: S.cam.videoWidth, h: S.cam.videoHeight } : null;
  return {
    W, H, project: p, t, video: S.screen, srcW: S.screen.videoWidth, srcH: S.screen.videoHeight,
    view: S.view.at(t), cursor: S.hasCursor ? S.cursorPath.at(t) : null, showCursor: S.hasCursor && p.cursor.visible,
    clicks: p.cursor.visible ? clicks : [], shortcut, camera: cam,
  };
}

function drawPreview() {
  S.lastMap = drawFrame(ctx, sceneAt(S.screen.currentTime, cv.width, cv.height));
}

// ───────────────────────── uppspelning ─────────────────────────

function syncAux(force) {
  const t = S.screen.currentTime;
  for (const a of S.aux) {
    const want = t - a.offset;
    if (want < 0) { if (!a.el.paused) a.el.pause(); continue; }
    if (force || Math.abs(a.el.currentTime - want) > 0.12) a.el.currentTime = want;
    a.el.playbackRate = S.screen.playbackRate;
    if (S.playing && a.el.paused && !a.el.ended) a.el.play().catch(() => {});
    if (!S.playing && !a.el.paused) a.el.pause();
  }
  for (const a of S.aux) if (a.gain) a.gain.gain.value = a.kind === 'microphone' ? S.project.audio.mic : S.project.audio.system;
}

// Håller uppspelningen inom delarna: hoppar över luckor, byter hastighet, stannar efter sista.
// Returnerar 'end' när allt är spelat.
function enforceSegments() {
  const t = S.screen.currentTime, info = S.tm.segmentAt(t);
  if (info.index === -1) return 'end';
  if (!info.inside) { S.screen.currentTime = info.segment.start; return null; }
  if (S.screen.playbackRate !== info.segment.speed) S.screen.playbackRate = info.segment.speed;
  if (S.screen.ended || (info.index === S.tm.segments.length - 1 && t >= info.segment.end - 0.03)) return 'end';
  return null;
}

function play() {
  if (S.exporting) return;
  const last = S.tm.segments[S.tm.segments.length - 1];
  if (!last || S.screen.currentTime >= last.end - 0.05) seek(S.tm.segments[0].start);
  S.playing = true; $('play').textContent = '⏸';
  S.ac.resume().catch(() => {});
  S.screen.play().catch(() => {});
  syncAux(true);
}
function pause() {
  S.playing = false; $('play').textContent = '▶';
  S.screen.pause(); syncAux(false);
}
function seek(t) {
  S.screen.currentTime = clamp(t, 0, S.duration);
  syncAux(true);
}

function frame() {
  requestAnimationFrame(frame);
  if (S.exporting) return;
  if (S.playing && enforceSegments() === 'end') { pause(); const l = S.tm.segments[S.tm.segments.length - 1]; if (l) S.screen.currentTime = l.end; }
  syncAux(false);
  drawPreview();
  const t = S.screen.currentTime;
  $('playhead').style.left = (t / S.duration * 100) + '%';
  $('time').textContent = `${fmt(S.tm.toOutput(t) ?? 0)} / ${fmt(S.tm.outputDuration)}`;
}

// ───────────────────────── spara ─────────────────────────

let saveTimer = null;
function scheduleSave() {
  S.dirty = true; clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await api.save(id, S.project); S.dirty = false; if (!S.meta.cursorBaked) $('status').style.color = ''; flash('Sparat'); }
    catch (e) { flash('Kunde inte spara: ' + e.message); }
  }, 500);
}
function flash(msg) { const s = $('status'); if (!s.title) { s.textContent = msg; setTimeout(() => { if (s.textContent === msg) s.textContent = ''; }, 1500); } }

// Efter en ändring: bygg om det som berörs, rita om tidslinjen, spara.
function changed({ view = false, tm = false, aspect = false, timeline = false, pane = false } = {}) {
  if (tm) rebuildTm();
  if (view) rebuildView();
  if (aspect) applyAspect();
  if (timeline || tm || view) buildTimeline();
  if (pane) buildPane();
  scheduleSave();
}

// ───────────────────────── tidslinje ─────────────────────────

function pct(t) { return (t / S.duration * 100) + '%'; }

function buildTimeline() {
  const D = S.duration;
  const ruler = $('ruler'); ruler.replaceChildren();
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find(s => D / s <= 14) || 600;
  for (let t = 0; t < D; t += step) ruler.append(el('i', { textContent: fmt(t), style: `left:${pct(t)}` }));

  const segLane = $('laneSeg'); segLane.replaceChildren(segLane.firstChild);
  S.project.segments.forEach((s, i) => {
    const b = block('seg', s, i, `${fmt(s.end - s.start)}${s.speed !== 1 ? ' · ' + s.speed + '×' : ''}`);
    attachDrag(b, s, {
      move: false, minLen: 0.3,
      bounds: () => [S.project.segments[i - 1]?.end ?? 0, S.project.segments[i + 1]?.start ?? S.duration],
      done: () => changed({ tm: true, pane: true }),
    });
    segLane.append(b);
  });

  const zLane = $('laneZoom'); zLane.replaceChildren(zLane.firstChild);
  for (const z of S.project.zooms) {
    const off = z.enabled === false || (!S.project.autoZoom && z.auto);
    const b = block('zm' + (z.auto ? ' auto' : '') + (off ? ' off' : ''), z, z, `${z.scale.toFixed(1)}×`);
    attachDrag(b, z, { move: true, minLen: 0.4, bounds: () => [0, S.duration], done: () => changed({ view: true, pane: true }) });
    zLane.append(b);
  }

  const cLane = $('laneClick'); cLane.replaceChildren(cLane.firstChild);
  for (const c of S.cursorPath.clicks) cLane.append(el('span', { className: 'ck', style: `left:${pct(c.t)}` }));
}

function block(cls, obj, ref, label) {
  const b = el('div', { className: 'blk ' + cls + (S.sel?.obj === obj ? ' sel' : ''), title: label },
    el('span', { className: 'hl' }), label, el('span', { className: 'hr' }));
  b.style.left = pct(obj.start); b.style.width = ((obj.end - obj.start) / S.duration * 100) + '%';
  b.dataset.ref = '1';
  return b;
}

function attachDrag(b, obj, { move, minLen, bounds, done }) {
  b.addEventListener('pointerdown', e => {
    e.stopPropagation();
    const mode = e.target.classList.contains('hl') ? 'l' : e.target.classList.contains('hr') ? 'r' : move ? 'm' : null;
    S.sel = { type: cls(b), obj }; for (const x of document.querySelectorAll('.blk.sel')) x.classList.remove('sel'); b.classList.add('sel');
    buildPane();
    if (!mode) return;
    b.setPointerCapture(e.pointerId);
    const width = $('tlbody').getBoundingClientRect().width, x0 = e.clientX, s0 = obj.start, e0 = obj.end;
    const [lo, hi] = bounds();
    let moved = false;
    const onMove = ev => {
      const dt = (ev.clientX - x0) / width * S.duration;
      if (Math.abs(ev.clientX - x0) > 2) moved = true;
      if (mode === 'l') obj.start = clamp(s0 + dt, lo, e0 - minLen);
      else if (mode === 'r') obj.end = clamp(e0 + dt, s0 + minLen, hi);
      else { const len = e0 - s0, ns = clamp(s0 + dt, lo, hi - len); obj.start = ns; obj.end = ns + len; }
      b.style.left = pct(obj.start); b.style.width = ((obj.end - obj.start) / S.duration * 100) + '%';
    };
    const onUp = () => {
      b.removeEventListener('pointermove', onMove); b.removeEventListener('pointerup', onUp);
      if (moved) done(); else seek(obj.start);
    };
    b.addEventListener('pointermove', onMove); b.addEventListener('pointerup', onUp);
  });
}
const cls = b => (b.classList.contains('seg') ? 'seg' : 'zoom');

// Klicka eller dra på linjalen / tomma ytor = spola.
function scrub(e) {
  const r = $('tlbody').getBoundingClientRect();
  seek(clamp((e.clientX - r.left) / r.width, 0, 1) * S.duration);
}
$('tlbody').addEventListener('pointerdown', e => {
  if (e.target.closest('.blk')) return;
  $('tlbody').setPointerCapture(e.pointerId);
  scrub(e);
  const mv = ev => scrub(ev), up = () => { $('tlbody').removeEventListener('pointermove', mv); $('tlbody').removeEventListener('pointerup', up); };
  $('tlbody').addEventListener('pointermove', mv); $('tlbody').addEventListener('pointerup', up);
});

// ───────────────────────── inspektören ─────────────────────────

const ctl = {
  slider(label, value, min, max, step, onInput, show = v => (+v).toFixed(2)) {
    const out = el('output', { textContent: show(value) });
    const input = el('input', { type: 'range', min, max, step, value });
    input.addEventListener('input', () => { out.textContent = show(input.value); onInput(+input.value); });
    return el('div', { className: 'ctl' }, el('span', { textContent: label }), out, input);
  },
  check(label, value, onChange, disabled = false) {
    const input = el('input', { type: 'checkbox', checked: !!value, disabled });
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { className: 'chk' }, input, label);
  },
  select(label, value, options, onChange) {
    const s = el('select', {}, ...options.map(([v, text]) => el('option', { value: v, textContent: text, selected: String(v) === String(value) })));
    s.style.cssText = 'background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:4px';
    s.addEventListener('change', () => onChange(s.value));
    return el('label', { className: 'ctl' }, el('span', { textContent: label }), s);
  },
};

$('tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]'); if (!b) return;
  S.tab = b.dataset.tab;
  for (const x of $('tabs').children) x.classList.toggle('on', x === b);
  buildPane();
});

function buildPane() {
  const p = S.project, pane = $('pane');
  pane.replaceChildren();
  const sel = S.sel;
  if (sel?.type === 'zoom' && S.tab !== 'cut') pane.append(zoomEditor(sel.obj));
  if (sel?.type === 'seg' && S.tab === 'cut') pane.append(segEditor(sel.obj));

  if (S.tab === 'style') {
    pane.append(el('h3', { textContent: 'Bakgrund' }));
    const sw = el('div', { className: 'swatches' });
    for (const [name, bg] of Object.entries(BACKGROUNDS)) {
      const b = el('button', { title: name, className: p.background.kind === bg.kind && (bg.color ?? bg.from) === (p.background.color ?? p.background.from) ? 'on' : '' });
      b.style.background = bg.kind === 'solid' ? bg.color : `linear-gradient(135deg, ${bg.from}, ${bg.to})`;
      b.onclick = () => { p.background = { ...bg }; changed({ pane: true }); };
      sw.append(b);
    }
    pane.append(sw);
    if (p.background.kind === 'gradient') {
      const c1 = el('input', { type: 'color', value: p.background.from }), c2 = el('input', { type: 'color', value: p.background.to });
      c1.oninput = () => { p.background.from = c1.value; scheduleSave(); }; c2.oninput = () => { p.background.to = c2.value; scheduleSave(); };
      pane.append(el('div', { className: 'colors' }, c1, c2, el('span', { className: 'dim', textContent: 'egna färger' })));
    } else {
      const c = el('input', { type: 'color', value: p.background.color });
      c.oninput = () => { p.background.color = c.value; scheduleSave(); };
      pane.append(el('div', { className: 'colors' }, c, el('span', { className: 'dim', textContent: 'egen färg' })));
    }
    pane.append(
      el('h3', { textContent: 'Ram' }),
      ctl.slider('Marginal', p.padding, 0, 0.2, 0.005, v => { p.padding = v; scheduleSave(); }),
      ctl.slider('Rundade hörn', p.cornerRadius, 0, 0.06, 0.002, v => { p.cornerRadius = v; scheduleSave(); }),
      ctl.slider('Skugga', p.shadow, 0, 1, 0.01, v => { p.shadow = v; scheduleSave(); }),
      el('h3', { textContent: 'Format' }),
      ctl.select('Proportioner', p.aspect, Object.entries(ASPECTS).map(([k, a]) => [k, a.label]), v => { p.aspect = v; changed({ aspect: true }); }),
    );
  }

  if (S.tab === 'cursor') {
    pane.append(
      el('h3', { textContent: 'Markör' }),
      ctl.check('Visa markör', p.cursor.visible && S.hasCursor, v => { p.cursor.visible = v; scheduleSave(); }, !S.hasCursor),
      ctl.slider('Storlek', p.cursor.size, 0.5, 3, 0.05, v => { p.cursor.size = v; scheduleSave(); }),
      ctl.check('Klickeffekt', p.cursor.clickEffect, v => { p.cursor.clickEffect = v; scheduleSave(); }),
      ctl.check('Visa kortkommandon', p.shortcuts.visible, v => { p.shortcuts.visible = v; scheduleSave(); }),
    );
    if (!S.hasCursor) pane.append(el('div', { className: 'banner', textContent: S.meta.cursorBaked === true ? 'Markören ligger i filmen och kan inte styras.' : 'Inga musdata i den här inspelningen.' }));
    pane.append(el('h3', { textContent: 'Kamera' }));
    if (!S.cam) pane.append(el('p', { className: 'dim', textContent: 'Ingen kamera spelades in.' }));
    else pane.append(
      ctl.check('Visa kamerabubbla', p.camera.visible, v => { p.camera.visible = v; scheduleSave(); }),
      ctl.select('Hörn', p.camera.corner, [['br', 'Nere till höger'], ['bl', 'Nere till vänster'], ['tr', 'Uppe till höger'], ['tl', 'Uppe till vänster']], v => { p.camera.corner = v; scheduleSave(); }),
      ctl.slider('Storlek', p.camera.size, 0.1, 0.45, 0.01, v => { p.camera.size = v; scheduleSave(); }),
    );
  }

  if (S.tab === 'zoom') {
    pane.append(
      el('h3', { textContent: 'Automatisk zoom' }),
      ctl.check('Zooma in på klick', p.autoZoom, v => { p.autoZoom = v; changed({ view: true }); }),
      ctl.slider('Zoomgrad', p.zoomScale, 1.2, 4, 0.1, v => {
        p.zoomScale = v;
        for (const z of p.zooms) if (z.auto) z.scale = Math.max(1.1, v);
        rebuildView(); buildTimeline(); scheduleSave();
      }, v => (+v).toFixed(1) + '×'),
    );
    const again = el('button', { textContent: 'Planera om automatiska zoomar', disabled: !S.cursorPath.clicks.length });
    again.onclick = () => {
      p.zooms = [...p.zooms.filter(z => !z.auto), ...planZooms(S.cursorPath.clicks, S.duration, { scale: p.zoomScale })];
      p.zooms.sort((a, b) => a.start - b.start); S.sel = null; changed({ view: true, pane: true });
    };
    pane.append(again, el('h3', { textContent: 'Zoomar' }));
    const list = el('div', { className: 'list' });
    if (!p.zooms.length) list.append(el('span', { className: 'dim', textContent: 'Inga zoomar. Lägg en med «＋ Zoom här».' }));
    for (const z of [...p.zooms].sort((a, b) => a.start - b.start)) {
      const it = el('div', { className: 'it' + (S.sel?.obj === z ? ' sel' : '') },
        el('span', { textContent: fmt(z.start) }), el('span', { className: 'sp', textContent: `${z.scale.toFixed(1)}×${z.auto ? ' · auto' : ''}${z.enabled === false ? ' · av' : ''}` }));
      it.onclick = () => { S.sel = { type: 'zoom', obj: z }; seek(z.start + 0.6); buildPane(); buildTimeline(); };
      list.append(it);
    }
    pane.append(list);
  }

  if (S.tab === 'cut') {
    pane.append(el('h3', { textContent: 'Delar' }));
    const list = el('div', { className: 'list' });
    p.segments.forEach((s, i) => {
      const it = el('div', { className: 'it' + (S.sel?.obj === s ? ' sel' : '') },
        el('span', { textContent: `${fmt(s.start)}–${fmt(s.end)}` }), el('span', { className: 'sp', textContent: s.speed !== 1 ? s.speed + '×' : '' }));
      it.onclick = () => { S.sel = { type: 'seg', obj: s }; buildPane(); buildTimeline(); seek(s.start); };
      list.append(it);
    });
    pane.append(list, el('p', { className: 'dim', textContent: 'S delar vid spelhuvudet. Dra i kanterna på en del i tidslinjen för att trimma den.' }));
    pane.append(el('h3', { textContent: 'Ljud' }));
    const hasMic = S.aux.some(a => a.kind === 'microphone'), hasSys = S.aux.some(a => a.kind === 'system');
    pane.append(
      hasMic ? ctl.slider('Mikrofon', p.audio.mic, 0, 2, 0.05, v => { p.audio.mic = v; scheduleSave(); }, v => Math.round(v * 100) + ' %') : el('p', { className: 'dim', textContent: 'Ingen mikrofon spelades in.' }),
      hasSys ? ctl.slider('Datorljud', p.audio.system, 0, 2, 0.05, v => { p.audio.system = v; scheduleSave(); }, v => Math.round(v * 100) + ' %') : el('p', { className: 'dim', textContent: 'Inget datorljud spelades in.' }),
    );
  }
}

function zoomEditor(z) {
  const box = el('div', { className: 'selbox' }, el('b', { textContent: `Zoom ${fmt(z.start)}–${fmt(z.end)}` }));
  box.append(
    ctl.check('På', z.enabled !== false, v => { z.enabled = v; changed({ view: true }); }),
    ctl.slider('Grad', z.scale, 1.1, 5, 0.1, v => { z.scale = v; ({ cx: z.cx, cy: z.cy } = clampCenter(z.cx, z.cy, v)); rebuildView(); scheduleSave(); }, v => (+v).toFixed(1) + '×'),
    ctl.slider('Mitt, sidled', z.cx, 0, 1, 0.01, v => { z.cx = v; rebuildView(); scheduleSave(); }),
    ctl.slider('Mitt, höjd', z.cy, 0, 1, 0.01, v => { z.cy = v; rebuildView(); scheduleSave(); }),
  );
  const row = el('div', { style: 'display:flex;gap:8px' });
  const fromCursor = el('button', { textContent: 'Mitt från markören', disabled: !S.hasCursor });
  fromCursor.onclick = () => { const p = S.cursorPath.at(clamp(S.screen.currentTime, z.start, z.end)); if (p) { ({ cx: z.cx, cy: z.cy } = clampCenter(p.x, p.y, z.scale)); changed({ view: true, pane: true }); } };
  const del = el('button', { textContent: 'Ta bort' });
  del.onclick = () => { S.project.zooms = S.project.zooms.filter(x => x !== z); S.sel = null; changed({ view: true, pane: true }); };
  row.append(fromCursor, del); box.append(row);
  return box;
}

function segEditor(s) {
  const box = el('div', { className: 'selbox' }, el('b', { textContent: `Del ${fmt(s.start)}–${fmt(s.end)}` }));
  box.append(ctl.select('Hastighet', s.speed, [[0.5, '0,5×'], [1, '1×'], [1.5, '1,5×'], [2, '2×'], [4, '4×']], v => { s.speed = +v; changed({ tm: true, pane: true }); }));
  const del = el('button', { textContent: 'Ta bort delen', disabled: S.project.segments.length <= 1 });
  del.onclick = deleteSelectedSegment;
  box.append(del);
  return box;
}

// ───────────────────────── redigeringar ─────────────────────────

function splitHere() {
  const t = S.screen.currentTime, before = S.project.segments.length;
  S.project.segments = splitAt(S.project.segments, t);
  if (S.project.segments.length !== before) { S.sel = null; changed({ tm: true, pane: true }); }
}
function deleteSelectedSegment() {
  const segs = S.project.segments;
  const i = S.sel?.type === 'seg' ? segs.indexOf(S.sel.obj) : segs.findIndex(s => S.screen.currentTime >= s.start && S.screen.currentTime < s.end);
  if (i < 0 || segs.length <= 1) return;
  S.project.segments = removeSegment(segs, i); S.sel = null;
  changed({ tm: true, pane: true });
  const nxt = S.tm.segmentAt(S.screen.currentTime);
  if (!nxt.inside && nxt.segment) seek(nxt.segment.start);
}
function addZoom() {
  const t = S.screen.currentTime;
  const c = S.cursorPath.at(t) || { x: 0.5, y: 0.5 };
  const scale = Math.max(1.5, S.project.zoomScale);
  const z = { id: 'm' + Date.now(), start: t, end: Math.min(S.duration, t + 2.5), scale, ...(({ cx, cy }) => ({ cx, cy }))(clampCenter(c.x, c.y, scale)), enabled: true, auto: false };
  S.project.zooms.push(z); S.project.zooms.sort((a, b) => a.start - b.start);
  S.sel = { type: 'zoom', obj: z }; S.tab = 'zoom';
  for (const x of $('tabs').children) x.classList.toggle('on', x.dataset.tab === 'zoom');
  changed({ view: true, pane: true });
}

$('play').onclick = () => (S.playing ? pause() : play());
$('split').onclick = splitHere;
$('del').onclick = deleteSelectedSegment;
$('zoomAdd').onclick = addZoom;
$('title').addEventListener('change', () => api.rename(id, $('title').value.trim()));

window.addEventListener('keydown', e => {
  if (e.target.matches('input[type=text], input:not([type]), select') || e.target.id === 'title') return;
  if (e.target.closest('dialog')) return;
  const k = e.key.toLowerCase();
  if (e.key === ' ') { e.preventDefault(); S.playing ? pause() : play(); }
  else if (k === 's' && !e.ctrlKey) splitHere();
  else if (k === 'z' && !e.ctrlKey) addZoom();
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (S.sel?.type === 'zoom') { S.project.zooms = S.project.zooms.filter(z => z !== S.sel.obj); S.sel = null; changed({ view: true, pane: true }); }
    else deleteSelectedSegment();
  }
  else if (e.key === 'ArrowLeft') seek(S.screen.currentTime - (e.shiftKey ? 5 : 1));
  else if (e.key === 'ArrowRight') seek(S.screen.currentTime + (e.shiftKey ? 5 : 1));
});

// ───────────────────────── export ─────────────────────────
// Spelar upp den färdiga bilden i realtid mot en egen canvas, tar ljudet från samma
// ljudgraf som förhandsvisningen, och skickar en WebM till huvudprocessen (ffmpeg gör resten).

const dlg = $('exp');
$('export').onclick = async () => {
  pause();
  const caps = await api.capabilities();
  const fmtSel = $('expFormat');
  for (const o of fmtSel.options) o.disabled = !caps.ffmpeg && o.value !== 'webm';
  if (!caps.ffmpeg) fmtSel.value = 'webm';
  $('expNote').textContent = caps.ffmpeg
    ? 'Exporten spelas upp i realtid. Lämna fönstret synligt tills den är klar.'
    : 'ffmpeg saknas: bara WebM går att exportera. Installera ffmpeg-static (npm install) för MP4 och GIF.';
  $('expForm').hidden = false; $('expProgress').hidden = true; $('expGo').disabled = false;
  dlg.showModal();
};
$('expCancel').onclick = () => { if (S.exporting) S.cancelExport = true; else dlg.close(); };
$('expGo').onclick = async () => {
  $('expGo').disabled = true; $('expForm').hidden = true; $('expProgress').hidden = false;
  try {
    const res = await runExport({ format: $('expFormat').value, longSide: +$('expSize').value, fps: +$('expFps').value });
    if (res?.canceled) dlg.close();
    else if (res) {
      $('expText').textContent = 'Klart: ' + res.path; $('expBar').style.width = '100%';
      $('expCancel').textContent = 'Stäng';
      const show = el('button', { textContent: 'Visa i mappen', className: 'primary' });
      show.onclick = () => api.revealPath(res.path);
      $('expGo').replaceWith(show); show.id = 'expGo';
    }
  } catch (e) { $('expText').textContent = 'Exporten misslyckades: ' + e.message; }
  $('expCancel').textContent = 'Stäng';
};
dlg.addEventListener('close', () => { $('expCancel').textContent = 'Avbryt'; });

async function runExport({ format, longSide, fps }) {
  const size = outputSize(S.project.aspect, format === 'gif' ? 800 : longSide);
  const out = document.createElement('canvas'); out.width = size.w; out.height = size.h;
  const octx = out.getContext('2d', { alpha: false });
  const dest = S.ac.createMediaStreamDestination();
  for (const g of S.gains) { g.disconnect(); g.connect(dest); }          // ljudet till filen, inte till högtalarna
  const stream = new MediaStream([...out.captureStream(fps).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.round(size.w * size.h * fps * 0.12) });
  const token = await api.exporter.begin();
  let chain = Promise.resolve();
  rec.ondataavailable = ev => { if (ev.data.size) chain = chain.then(async () => api.exporter.chunk(token, new Uint8Array(await ev.data.arrayBuffer()))); };
  const stopped = new Promise(r => { rec.onstop = r; });
  const off = api.exporter.onProgress(f => { $('expBar').style.width = (50 + f * 50) + '%'; $('expText').textContent = 'Kodar… ' + Math.round(f * 100) + ' %'; });

  S.exporting = true; S.cancelExport = false;
  const first = S.tm.segments[0];
  S.screen.pause(); S.screen.playbackRate = first.speed; S.screen.currentTime = first.start; syncAux(true);
  await once(S.screen, 'seeked');
  await new Promise(r => setTimeout(r, 150));
  S.playing = true;
  await S.ac.resume();
  S.screen.play(); syncAux(true);
  rec.start(1000);
  const t0 = performance.now();
  let frames = 0;

  await new Promise(done => {
    const loop = () => {
      if (S.cancelExport || enforceSegments() === 'end') return done();
      syncAux(false);
      drawFrame(octx, sceneAt(S.screen.currentTime, out.width, out.height)); frames++;
      const f = S.tm.outputDuration ? clamp((S.tm.toOutput(S.screen.currentTime) ?? 0) / S.tm.outputDuration, 0, 1) : 1;
      $('expBar').style.width = (f * 50) + '%'; $('expText').textContent = `Spelar in bilden… ${Math.round(f * 100)} %`;
      requestAnimationFrame(loop);
    };
    loop();
  });

  S.playing = false; S.screen.pause(); syncAux(false);
  rec.stop(); await stopped; await chain;
  for (const g of S.gains) { g.disconnect(); g.connect(S.ac.destination); }
  S.exporting = false; S.lastExportFps = frames / ((performance.now() - t0) / 1000);
  if (S.cancelExport) { await api.exporter.cancel(token); off(); return { canceled: true }; }
  $('expText').textContent = 'Kodar…';
  try {
    return await api.exporter.end({ token, format, duration: S.tm.outputDuration, name: $('title').value.trim() || 'Inspelning' });
  } finally { off(); }
}

// Provlägets krok: gör det möjligt att styra redigeraren utifrån (test/e2e.mjs). Ofarlig i appen.
window.__editor = { S, seek, play, pause, addZoom, splitHere, runExport, sceneAt, drawPreview, rebuildView, changed };

init();
