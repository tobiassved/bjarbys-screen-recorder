// Ritar en färdig ruta: bakgrund, skärmen med rundade hörn och skugga, zoom, markör med
// klickeffekt, kortkommandon och kamerabubbla. Förhandsvisning och export anropar samma funktion.

import { ASPECTS } from '../lib/project.js';

export function screenRect(outW, outH, padding, srcW, srcH) {
  const pad = padding * Math.min(outW, outH);
  const k = Math.min((outW - 2 * pad) / srcW, (outH - 2 * pad) / srcH);
  const w = srcW * k, h = srcH * k;
  return { x: (outW - w) / 2, y: (outH - h) / 2, w, h };
}

function fillBackground(ctx, W, H, bg) {
  if (bg.kind === 'solid') { ctx.fillStyle = bg.color; ctx.fillRect(0, 0, W, H); return; }
  const a = (bg.angle ?? 135) * Math.PI / 180;
  const r = Math.hypot(W, H) / 2, cx = W / 2, cy = H / 2;
  const g = ctx.createLinearGradient(cx - Math.cos(a) * r, cy - Math.sin(a) * r, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  g.addColorStop(0, bg.from); g.addColorStop(1, bg.to);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}

// Windows-pilen, spetsen i (0,0). Mått i «källpixlar» vid 100 %.
const ARROW = [[0, 0], [0, 16.5], [3.9, 12.9], [6.6, 19], [9.1, 17.9], [6.4, 11.9], [11.6, 11.9]];

function drawCursor(ctx, x, y, u, color, pressed) {
  ctx.save();
  ctx.translate(x, y); ctx.scale(u * (pressed ? 0.88 : 1), u * (pressed ? 0.88 : 1));
  ctx.beginPath(); ARROW.forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)); ctx.closePath();
  ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 5 * u; ctx.shadowOffsetY = 2 * u;
  ctx.fillStyle = color; ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 1.3; ctx.strokeStyle = '#111'; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.restore();
}

function drawClicks(ctx, clicks, t, mapX, mapY, u) {
  for (const c of clicks) {
    const age = t - c.t;
    if (age < 0 || age > 0.55) continue;
    const p = age / 0.55, e = 1 - Math.pow(1 - p, 3);
    ctx.save();
    ctx.beginPath(); ctx.arc(mapX(c.x), mapY(c.y), (8 + 34 * e) * u, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1, (4 - 3 * p) * u);
    ctx.strokeStyle = `rgba(120,160,255,${(1 - p) * 0.95})`;
    ctx.fillStyle = `rgba(120,160,255,${(1 - p) * 0.18})`;
    ctx.fill(); ctx.stroke(); ctx.restore();
  }
}

function drawShortcut(ctx, label, alpha, rect) {
  const size = Math.max(16, rect.h * 0.04);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `600 ${size}px "Segoe UI", system-ui, sans-serif`;
  const w = ctx.measureText(label).width + size * 1.6, h = size * 1.9;
  const x = rect.x + rect.w / 2 - w / 2, y = rect.y + rect.h - h - rect.h * 0.05;
  ctx.fillStyle = 'rgba(18,19,24,.86)'; ctx.beginPath(); ctx.roundRect(x, y, w, h, h / 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.fillText(label, x + w / 2, y + h / 2 + size * 0.04);
  ctx.restore();
}

function drawCamera(ctx, cam, camW, camH, rect, style, W, H) {
  const d = style.size * Math.min(rect.w, rect.h);
  const m = Math.min(W, H) * 0.035;
  const x = style.corner.includes('l') ? rect.x + m : rect.x + rect.w - d - m;
  const y = style.corner.includes('t') ? rect.y + m : rect.y + rect.h - d - m;
  const k = Math.min(camW, camH);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = d * 0.12; ctx.shadowOffsetY = d * 0.04;
  ctx.beginPath(); ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2); ctx.fillStyle = '#000'; ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.clip();
  ctx.drawImage(cam, (camW - k) / 2, (camH - k) / 2, k, k, x, y, d, d);
  ctx.restore();
  ctx.save(); ctx.beginPath(); ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2, d * 0.025); ctx.strokeStyle = 'rgba(255,255,255,.92)'; ctx.stroke(); ctx.restore();
}

// scene: { W, H, project, t, video, srcW, srcH, view:{scale,cx,cy}, cursor:{x,y}|null, clicks:[],
//          shortcut:{label,alpha}|null, camera:{el,w,h}|null, showCursor }
export function drawFrame(ctx, scene) {
  const { W, H, project, video, srcW, srcH, view, t } = scene;
  fillBackground(ctx, W, H, project.background);
  if (!srcW || !srcH) return null;

  const rect = screenRect(W, H, project.padding, srcW, srcH);
  const radius = project.cornerRadius * Math.min(rect.w, rect.h);

  if (project.shadow > 0) {
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${0.55 * project.shadow})`;
    ctx.shadowBlur = 70 * project.shadow * (W / 1920) + 4; ctx.shadowOffsetY = 26 * project.shadow * (W / 1920);
    ctx.fillStyle = '#000'; ctx.beginPath(); ctx.roundRect(rect.x, rect.y, rect.w, rect.h, radius); ctx.fill();
    ctx.restore();
  }

  // Utsnittet av källan som visas (zoom + mitt).
  const vw = srcW / view.scale, vh = srcH / view.scale;
  const sx = Math.min(Math.max(view.cx * srcW - vw / 2, 0), srcW - vw);
  const sy = Math.min(Math.max(view.cy * srcH - vh / 2, 0), srcH - vh);
  const toX = nx => rect.x + (nx * srcW - sx) / vw * rect.w;
  const toY = ny => rect.y + (ny * srcH - sy) / vh * rect.h;
  const zoomPx = rect.w / vw;            // canvas-pixlar per källpixel

  ctx.save();
  ctx.beginPath(); ctx.roundRect(rect.x, rect.y, rect.w, rect.h, radius); ctx.clip();
  ctx.fillStyle = '#000'; ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  try { ctx.drawImage(video, sx, sy, vw, vh, rect.x, rect.y, rect.w, rect.h); } catch { /* ingen bild ännu */ }

  if (scene.showCursor && scene.cursor) {
    const u = zoomPx * project.cursor.size * 1.15;
    if (project.cursor.clickEffect) drawClicks(ctx, scene.clicks, t, toX, toY, zoomPx);
    const pressed = scene.clicks.some(c => t - c.t >= 0 && t - c.t < 0.12);
    drawCursor(ctx, toX(scene.cursor.x), toY(scene.cursor.y), u, project.cursor.color, pressed);
  }
  ctx.restore();

  if (scene.shortcut) drawShortcut(ctx, scene.shortcut.label, scene.shortcut.alpha, rect);
  if (scene.camera && project.camera.visible) drawCamera(ctx, scene.camera.el, scene.camera.w, scene.camera.h, rect, project.camera, W, H);

  // Returnerar mappningen för att kunna peka i bilden (klick i förhandsvisningen → källpunkt).
  return { rect, fromCanvas: (cx, cy) => ({ x: (sx + (cx - rect.x) / rect.w * vw) / srcW, y: (sy + (cy - rect.y) / rect.h * vh) / srcH }) };
}

export { ASPECTS };
