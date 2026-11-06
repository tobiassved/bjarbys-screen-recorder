// Musen och kortkommandona under inspelningen, på inspelningens tidslinje (pauser borträknade).
// Musen läses av Electron (getCursorScreenPoint, ~125 Hz). Klick och tangenter kräver en global
// krok: uiohook-napi (valfri). Saknas den spelas rörelsen in men inga klick — då blir zoomarna
// manuella. Vanlig text sparas aldrig: bara kombinationer med Ctrl/Alt/Win (som macOS-appen).

import { screen } from 'electron';
import { shortcutLabel } from './lib/events.js';

const MODIFIERS = new Set(['Ctrl', 'CtrlRight', 'Alt', 'AltRight', 'Shift', 'ShiftRight', 'Meta', 'MetaRight']);

export class InputTracker {
  constructor() {
    this.events = [];
    this.flushed = 0;
    this.t0 = 0;
    this.paused = false;
    this.pausedAt = 0;
    this.pausedTotal = 0;
    this.timer = null;
    this.hook = null;
    this.clickCapable = false;
    this.last = null;
    this.down = false;
    this.heldKeys = new Set();
  }

  get available() { return InputTracker.probe(); }
  static async probe() {
    try { await loadHook(); return true; } catch { return false; }
  }

  now() { return (Date.now() - this.t0 - this.pausedTotal) / 1000; }

  push(e) { if (!this.paused) this.events.push({ t: Math.max(0, +this.now().toFixed(4)), ...e }); }

  async start(t0) {
    this.t0 = t0;
    this.timer = setInterval(() => this.poll(), 8);
    try {
      const { uIOhook, UiohookKey } = await loadHook();
      const names = new Map(Object.entries(UiohookKey).map(([name, code]) => [code, name]));
      uIOhook.on('mousedown', e => {
        this.down = true;
        const p = screen.getCursorScreenPoint();
        this.push({ k: 'down', x: p.x, y: p.y, b: e.button === 1 ? 0 : e.button === 2 ? 1 : 2, n: e.clicks ?? 1 });
      });
      uIOhook.on('mouseup', e => {
        this.down = false;
        const p = screen.getCursorScreenPoint();
        this.push({ k: 'up', x: p.x, y: p.y, b: e.button === 1 ? 0 : e.button === 2 ? 1 : 2 });
      });
      uIOhook.on('keydown', e => {
        if (this.heldKeys.has(e.keycode)) return;            // tangentrepetition
        this.heldKeys.add(e.keycode);
        const name = names.get(e.keycode);
        if (!name || MODIFIERS.has(name)) return;
        const label = shortcutLabel({ ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey }, name);
        if (label) this.push({ k: 'key', label });
      });
      uIOhook.on('keyup', e => this.heldKeys.delete(e.keycode));
      uIOhook.start();
      this.hook = uIOhook;
      this.clickCapable = true;
    } catch (err) {
      console.error('[input] global krok saknas, klick spelas inte in:', err?.message);
    }
  }

  poll() {
    if (this.paused) return;
    const p = screen.getCursorScreenPoint();
    if (this.last && this.last.x === p.x && this.last.y === p.y) return;
    this.last = p;
    this.push(this.down ? { k: 'drag', x: p.x, y: p.y, b: 0 } : { k: 'move', x: p.x, y: p.y });
  }

  pause() { if (this.paused) return; this.push({ k: 'pause' }); this.paused = true; this.pausedAt = Date.now(); }
  resume() {
    if (!this.paused) return;
    this.pausedTotal += Date.now() - this.pausedAt; this.paused = false;
    this.push({ k: 'resume' });
  }

  // Nya händelser sedan förra anropet (för att skriva till disk löpande).
  drain() { const out = this.events.slice(this.flushed); this.flushed = this.events.length; return out; }

  stop() {
    clearInterval(this.timer);
    if (this.paused) this.resume();
    try { this.hook?.removeAllListeners(); this.hook?.stop(); } catch { /* redan stoppad */ }
    return this.events;
  }
}

let hookPromise;
function loadHook() {
  hookPromise ??= import('uiohook-napi').then(m => {
    const mod = m.uIOhook ? m : m.default;
    if (!mod?.uIOhook) throw new Error('uiohook-napi saknas');
    return mod;
  });
  return hookPromise;
}
