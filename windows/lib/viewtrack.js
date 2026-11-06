// Zoomplanen och kamerans bana. Zoomar är beslut (källtid, mål, grad); banan är fjäderrörelsen
// dit, uträknad i förväg i 120 Hz så att förhandsvisning, sökning och export ser likadana ut.

import { Follower, Springs } from './spring.js';

export const VIEW_RATE = 120;

// Automatiska zoomar ur klicken: klick nära varandra i tiden blir en zoom på deras mitt.
export function planZooms(clicks, duration, { scale = 2.0, gap = 2.0, lead = 0.5, tail = 1.5 } = {}) {
  const sorted = [...clicks].sort((a, b) => a.t - b.t);
  const groups = [];
  for (const c of sorted) {
    const g = groups[groups.length - 1];
    if (g && c.t - g[g.length - 1].t <= gap) g.push(c); else groups.push([c]);
  }
  const zooms = [];
  for (const g of groups) {
    const xs = g.map(c => c.x), ys = g.map(c => c.y);
    const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
    // Hela gruppen ska rymmas med marginal; annars mindre zoom, och under 1,3 hoppas den över.
    const fit = 0.8 / Math.max(bw, bh, 1e-6);
    const s = Math.min(scale, fit);
    if (s < 1.3) continue;
    zooms.push({
      id: 'z' + zooms.length + '-' + Math.round(g[0].t * 1000),
      start: Math.max(0, g[0].t - lead), end: Math.min(duration, g[g.length - 1].t + tail),
      scale: s, cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2,
      enabled: true, auto: true,
    });
  }
  return zooms;
}

// Mitten hålls så att bildutsnittet aldrig sticker utanför källan.
export function clampCenter(cx, cy, scale) {
  const h = 0.5 / scale;
  return { cx: Math.min(Math.max(cx, h), 1 - h), cy: Math.min(Math.max(cy, h), 1 - h) };
}

export class ViewTrack {
  // zooms: [{start,end,scale,cx,cy,enabled}]; cursorAt(t) → {x,y}|null (för att följa markören i en zoom)
  constructor(zooms, duration, cursorAt = null) {
    this.duration = Math.max(duration, 0);
    const n = Math.ceil(this.duration * VIEW_RATE) + 1;
    this.s = new Float32Array(n).fill(1); this.cx = new Float32Array(n).fill(0.5); this.cy = new Float32Array(n).fill(0.5);
    const active = zooms.filter(z => z.enabled !== false && z.end > z.start && z.scale > 1.001);
    if (!active.length) return;
    const fs = new Follower(1), fx = new Follower(0.5), fy = new Follower(0.5);
    const dt = 1 / VIEW_RATE;
    let prevZoom = null;
    for (let i = 0; i < n; i++) {
      const t = i * dt;
      const z = active.find(z => t >= z.start && t < z.end) || null;
      let ts = 1, tx = 0.5, ty = 0.5;
      if (z) {
        ts = z.scale; tx = z.cx; ty = z.cy;
        // Följ markören när den lämnar den inre delen av utsnittet.
        const p = cursorAt && cursorAt(t);
        if (p) {
          const lim = 0.5 / z.scale * 0.65;
          if (Math.abs(p.x - tx) > lim) tx += p.x - tx - Math.sign(p.x - tx) * lim;
          if (Math.abs(p.y - ty) > lim) ty += p.y - ty - Math.sign(p.y - ty) * lim;
        }
        ({ cx: tx, cy: ty } = clampCenter(tx, ty, ts));
      }
      fs.retarget(ts); fx.retarget(tx); fy.retarget(ty);
      prevZoom = z;
      this.s[i] = fs.step(dt, z ? Springs.zoomIn : Springs.zoomOut);
      this.cx[i] = fx.step(dt, Springs.viewport);
      this.cy[i] = fy.step(dt, Springs.viewport);
    }
  }
  at(t) {
    const f = Math.min(Math.max(t, 0), this.duration) * VIEW_RATE;
    const i = Math.floor(f), j = Math.min(i + 1, this.s.length - 1), a = f - i;
    const lerp = arr => arr[i] + (arr[j] - arr[i]) * a;
    const s = Math.max(1, lerp(this.s));
    const c = clampCenter(lerp(this.cx), lerp(this.cy), s);
    return { scale: s, cx: c.cx, cy: c.cy };
  }
}
