// Markörens utjämnade bana, beräknad i förväg i 240 Hz på källans tidslinje. Förhandsvisning
// och export slår upp i samma tabell, så de blir exakt lika. Port av Motion/CursorPath.swift.
//
// Rå rörelse → skakfilter → fjäder mot senaste råa punkten, med profil efter sammanhang:
// snabb nära ett klick (markören landar på det som klickas), stadig under drag, annars standard.
// Ett glapp > 0,1 s mellan händelser betyder att musen stod still: ingenting interpoleras över det.

import { Follower, Springs } from './spring.js';

export const RATE = 240;
export const STILL_GAP = 0.1;

export class CursorPath {
  // events: [{t,k,x,y,b}] i globala punkter; rect: {x,y,w,h} (skärmens/fönstrets yta, samma enhet)
  constructor(events, rect, duration) {
    this.duration = Math.max(duration, 0);
    this.clicks = [];
    const n = Math.ceil(this.duration * RATE) + 1;
    this.xs = new Float32Array(n); this.ys = new Float32Array(n);
    this.hasData = false;
    if (!rect || !rect.w || !rect.h) return;

    const raw = [];   // {t,x,y}
    const drags = []; // [start,end]
    let dragStart = null;
    const thr = 2 / rect.w;   // < 2 punkter räknas som skak
    let last = null;
    for (const e of events) {
      if (!['move', 'drag', 'down', 'up'].includes(e.k) || typeof e.x !== 'number') continue;
      const p = { x: (e.x - rect.x) / rect.w, y: (e.y - rect.y) / rect.h };
      const isClick = e.k === 'down' || e.k === 'up';
      if (last && !isClick && Math.abs(p.x - last.x) < thr && Math.abs(p.y - last.y) < thr * rect.w / rect.h) continue;
      raw.push({ t: e.t, ...p }); last = p;
      if (e.k === 'down') { this.clicks.push({ t: e.t, x: p.x, y: p.y, button: e.b ?? 0 }); dragStart = e.t; }
      else if (e.k === 'up' && dragStart !== null) { if (e.t - dragStart > 0.15) drags.push([dragStart, e.t]); dragStart = null; }
    }
    if (!raw.length) return;
    this.hasData = true;

    const fx = new Follower(raw[0].x), fy = new Follower(raw[0].y);
    const dt = 1 / RATE;
    let ri = 0, ci = 0;
    for (let i = 0; i < n; i++) {
      const t = i * dt;
      while (ri + 1 < raw.length && raw[ri + 1].t <= t) ri++;
      // Före första händelsen står markören på första punkten.
      const r = raw[ri];
      fx.retarget(r.x); fy.retarget(r.y);
      while (ci < this.clicks.length && this.clicks[ci].t < t - 0.1) ci++;
      const nearClick = ci < this.clicks.length && this.clicks[ci].t - t < 0.3 && this.clicks[ci].t - t > -0.1;
      const dragging = drags.some(([a, b]) => t >= a && t <= b);
      const spring = nearClick ? Springs.cursorSnappy : dragging ? Springs.cursorDrag : Springs.cursorDefault;
      this.xs[i] = fx.step(dt, spring); this.ys[i] = fy.step(dt, spring);
    }
  }

  at(t) {
    if (!this.hasData) return null;
    const f = Math.min(Math.max(t, 0), this.duration) * RATE;
    const i = Math.floor(f), j = Math.min(i + 1, this.xs.length - 1), a = f - i;
    return { x: this.xs[i] + (this.xs[j] - this.xs[i]) * a, y: this.ys[i] + (this.ys[j] - this.ys[i]) * a };
  }
}
