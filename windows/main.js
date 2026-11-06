// Bjarbys skärminspelare — Windows-prototyp (Electron).
// Samma idé som macOS-appen: inspelningen sparas som DATA (skärmen utan markör, ljudspår var
// för sig, kamera, mus- och klickhändelser) i ett .bsrec-paket, och all polish läggs på i
// efterhand i redigeraren. Format: docs/FORMAT.md (samma händelsespråk, WebM i stället för MOV).

import {
  app, BrowserWindow, ipcMain, desktopCapturer, session, screen, globalShortcut,
  protocol, net, Tray, Menu, dialog, shell, nativeImage,
} from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { InputTracker } from './input.js';
import { parseEvents, serializeEvents } from './lib/events.js';
import { loadProject, defaults } from './lib/project.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(ROOT, 'preload.cjs');
const APP_NAME = 'Bjarbys skärminspelare';
const ID_RE = /^[^\\/:*?"<>|]+\.bsrec$/;                 // paketnamn, aldrig en sökväg
const TRACK_FILES = new Set(['screen.webm', 'mic.webm', 'system.webm', 'camera.webm']);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let mainWin = null, hudWin = null, tray = null;
const editors = new Map();
let pendingSource = null;     // källan getDisplayMedia ska få
let rec = null;               // pågående inspelning

// ───────────────────────── bibliotek ─────────────────────────

const libraryDir = () => process.env.BJARBYS_BIBLIOTEK || path.join(app.getPath('videos'), APP_NAME);

function packageDir(id) {
  if (typeof id !== 'string' || !ID_RE.test(id) || id.includes('..')) throw new Error('Ogiltigt paketnamn');
  const dir = path.resolve(libraryDir(), id);
  if (path.dirname(dir) !== path.resolve(libraryDir())) throw new Error('Utanför biblioteket');
  return dir;
}

const readJson = async (file, fallback = null) => {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
};
async function writeJson(file, data) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}
const pad = n => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} kl. ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}

// Ett paket utan meta.json är en avbruten inspelning (krasch, strömavbrott): spåren är skrivna
// löpande, så det som hann sparas går att spela. Duration lämnas 0; redigeraren mäter filen.
async function recover(dir) {
  const rdir = path.join(dir, 'recording');
  const files = await fsp.readdir(rdir).catch(() => []);
  const tracks = files.filter(f => TRACK_FILES.has(f)).map(f => ({ kind: f.replace('.webm', ''), file: f, start: 0 }));
  if (!tracks.some(t => t.kind === 'screen')) return null;
  const st = await fsp.stat(path.join(rdir, 'screen.webm'));
  const meta = {
    schemaVersion: 1, platform: 'windows', createdAt: st.birthtime.toISOString(), duration: 0, name: '',
    source: { kind: 'display', contentRect: null }, cursorBaked: null, clicksRecorded: false, tracks,
    finished: false, recovered: true,
  };
  await writeJson(path.join(rdir, 'meta.json'), meta);
  return meta;
}

async function listLibrary() {
  const base = libraryDir();
  await fsp.mkdir(base, { recursive: true });
  const out = [];
  for (const name of await fsp.readdir(base)) {
    if (!ID_RE.test(name)) continue;
    const dir = path.join(base, name);
    let meta = await readJson(path.join(dir, 'recording', 'meta.json'));
    if (!meta) meta = await recover(dir).catch(() => null);
    if (!meta) continue;
    out.push({
      id: name, name: meta.name || '', createdAt: meta.createdAt, duration: meta.duration || 0,
      kind: meta.source?.kind || 'display', recovered: !!meta.recovered,
      thumb: fs.existsSync(path.join(dir, 'thumbnail.jpg')),
    });
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// ───────────────────────── ffmpeg (valfritt) ─────────────────────────

let ffmpegCache;
async function ffmpegPath() {
  if (ffmpegCache !== undefined) return ffmpegCache;
  ffmpegCache = null;
  try {
    const m = await import('ffmpeg-static');
    let p = m.default;
    if (p) {
      p = p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
      if (fs.existsSync(p)) ffmpegCache = p;
    }
  } catch { /* inte installerad */ }
  if (!ffmpegCache) {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    if (r.status === 0) ffmpegCache = 'ffmpeg';
  }
  return ffmpegCache;
}

function runFfmpeg(args, { duration = 0, onProgress } = {}) {
  return new Promise(async (resolve, reject) => {
    const bin = await ffmpegPath();
    if (!bin) return reject(new Error('ffmpeg saknas'));
    const p = spawn(bin, ['-hide_banner', '-y', ...args], { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => {
      const s = d.toString(); err = (err + s).slice(-4000);
      const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(s);
      if (m && duration && onProgress) onProgress(Math.min(1, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / duration));
    });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg avslutades med ' + code + '\n' + err)));
  });
}

// MediaRecorders WebM saknar längd och sökindex; en omkopiering (-c copy, sekunder) lagar det.
async function remux(file) {
  if (!(await ffmpegPath())) return false;
  const fixed = file + '.fixed.webm';
  try { await runFfmpeg(['-i', file, '-c', 'copy', fixed]); await fsp.rename(fixed, file); return true; }
  catch (e) { console.error('[remux]', e.message); await fsp.rm(fixed, { force: true }); return false; }
}

// ───────────────────────── källor och geometri ─────────────────────────

function psRect(hwnd) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(hwnd)) return Promise.resolve(null);
  const script =
    `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class BW{[StructLayout(LayoutKind.Sequential)]public struct R{public int L,T,Rt,B;}[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out R r);}';` +
    `$r=New-Object BW+R;[void][BW]::GetWindowRect([IntPtr]${hwnd},[ref]$r);"$($r.L),$($r.T),$($r.Rt),$($r.B)"`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 8000, windowsHide: true },
      (err, out) => {
        if (err) return resolve(null);
        const [l, t, r, b] = out.trim().split(',').map(Number);
        resolve([l, t, r, b].every(Number.isFinite) && r > l && b > t ? { x: l, y: t, width: r - l, height: b - t } : null);
      });
  });
}

// Källans yta i globala DIP-punkter (samma enhet som musen), eller null om den inte går att veta.
async function sourceGeometry(src) {
  try {
    if (src.id.startsWith('screen:')) {
      const d = screen.getAllDisplays().find(d => String(d.id) === String(src.display_id)) ?? screen.getPrimaryDisplay();
      return { kind: 'display', rect: d.bounds, scaleFactor: d.scaleFactor };
    }
    const hwnd = Number(src.id.split(':')[1]);
    const phys = await psRect(hwnd);
    const dip = phys ? screen.screenToDipRect(null, phys) : null;
    return { kind: 'window', rect: dip, scaleFactor: 1 };
  } catch (e) {
    console.error('[geometri]', e.message);
    return { kind: src.id.startsWith('screen:') ? 'display' : 'window', rect: null, scaleFactor: 1 };
  }
}

// ───────────────────────── inspelning ─────────────────────────

function openHud() {
  const d = screen.getPrimaryDisplay();
  hudWin = new BrowserWindow({
    width: 400, height: 64, x: Math.round(d.workArea.x + d.workArea.width / 2 - 200), y: d.workArea.y + 12,
    frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true, transparent: true, hasShadow: false, show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  // Håller fönstret ute ur inspelningen (WDA_EXCLUDEFROMCAPTURE, Windows 10 2004+).
  hudWin.setContentProtection(true);
  hudWin.setAlwaysOnTop(true, 'screen-saver');
  hudWin.loadURL('app://local/ui/renderer/hud.html');
  hudWin.once('ready-to-show', () => { hudWin.show(); countdown(); });
  hudWin.on('closed', () => { hudWin = null; });
}

async function countdown() {
  const r = rec;
  for (let n = r.opts.countdown; n > 0; n--) {
    hudWin?.webContents.send('hud:tick', n);
    await new Promise(res => setTimeout(res, 1000));
    if (rec !== r) return;
  }
  hudWin?.webContents.send('hud:tick', 0);
  try {
    // «true» = användargest: getDisplayMedia kräver det, och det här är ju användarens klick.
    await hudWin.webContents.executeJavaScript('window.__start()', true);
  } catch (e) {
    abortRecording(e?.message || String(e));
  }
}

async function abortRecording(message) {
  const r = rec; rec = null;
  if (!r) return;
  clearInterval(r.flushTimer);
  r.tracker.stop();
  for (const s of Object.values(r.streams)) s.destroy();
  hudWin?.close();
  mainWin?.show();
  updateTray();
  dialog.showErrorBox(APP_NAME, 'Inspelningen kunde inte startas:\n' + message);
  if (!r.began) await fsp.rm(r.dir, { recursive: true, force: true }).catch(() => {});
}

ipcMain.handle('rec:start', async (_e, opts) => {
  if (rec) throw new Error('Det pågår redan en inspelning');
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
  const src = sources.find(s => s.id === opts?.sourceId);
  if (!src) throw new Error('Källan finns inte längre — uppdatera listan');
  pendingSource = src;
  const id = `Inspelning ${stamp()}.bsrec`;
  const dir = packageDir(id);
  await fsp.mkdir(path.join(dir, 'recording'), { recursive: true });
  const geometry = await sourceGeometry(src);
  rec = {
    id, dir, src, geometry, began: false,
    opts: {
      mic: !!opts.mic, clean: !!opts.clean, system: !!opts.system, camera: !!opts.camera,
      countdown: Math.min(Math.max(Number(opts.countdown) || 0, 0), 10),
    },
    streams: {}, tracker: new InputTracker(), t0: 0, flushTimer: null,
  };
  mainWin?.hide();
  updateTray();
  openHud();
  return id;
});

ipcMain.handle('hud:init', () => ({ ...rec?.opts, source: rec?.src.name }));

ipcMain.handle('rec:begin', async (_e, info) => {
  if (!rec) return;
  rec.t0 = info.t0; rec.began = true;
  await rec.tracker.start(info.t0);
  // Händelserna skrivs löpande, så att en krasch inte tar dem med sig.
  const evFile = path.join(rec.dir, 'recording', 'events.jsonl');
  rec.flushTimer = setInterval(() => {
    const fresh = rec?.tracker.drain();
    if (fresh?.length) fsp.appendFile(evFile, serializeEvents(fresh)).catch(() => {});
  }, 2000);
  updateTray();
});

ipcMain.on('rec:chunk', (_e, { track, data }) => {
  if (!rec || !TRACK_FILES.has(track)) return;
  rec.streams[track] ??= fs.createWriteStream(path.join(rec.dir, 'recording', track));
  rec.streams[track].write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
});

ipcMain.handle('rec:pause', (_e, paused) => { paused ? rec?.tracker.pause() : rec?.tracker.resume(); });
ipcMain.handle('rec:stop-request', () => stopRecording());
ipcMain.handle('rec:pause-request', () => hudWin?.webContents.send('hud:pause-toggle'));
ipcMain.handle('rec:fail', (_e, message) => abortRecording(message));

function stopRecording() { if (rec?.began) hudWin?.webContents.send('hud:stop'); else if (rec) abortRecording('Avbruten.'); }

ipcMain.handle('rec:finish', async (_e, info) => {
  const r = rec;
  if (!r) return null;
  rec = null;
  clearInterval(r.flushTimer);
  const events = r.tracker.stop();
  const rdir = path.join(r.dir, 'recording');
  await fsp.writeFile(path.join(rdir, 'events.jsonl'), serializeEvents(events));
  await Promise.all(Object.values(r.streams).map(s => new Promise(res => s.end(res))));
  const duration = Math.max(0, (info.endedAt - r.t0 - r.tracker.pausedTotal) / 1000);

  const tracks = [];
  for (const t of info.tracks) {
    if (!TRACK_FILES.has(t.file) || !fs.existsSync(path.join(rdir, t.file))) continue;
    await remux(path.join(rdir, t.file));
    tracks.push({ kind: t.kind, file: t.file, start: +((t.startedAt - r.t0) / 1000).toFixed(3), deviceName: t.deviceName || '' });
  }
  const g = r.geometry;
  const meta = {
    schemaVersion: 1, platform: 'windows', createdAt: new Date(r.t0).toISOString(), duration: +duration.toFixed(3), name: '',
    source: {
      kind: g.kind, title: r.src.name,
      contentRect: g.rect ? [g.rect.x, g.rect.y, g.rect.width, g.rect.height] : null,   // [x, y, b, h], globala DIP
      pixelScale: g.scaleFactor, pixelWidth: info.pixelWidth, pixelHeight: info.pixelHeight,
    },
    cursorBaked: info.cursorBaked,           // true = fångsten har markören i bilden; null = okänt
    clicksRecorded: r.tracker.clickCapable,
    frameRate: info.frameRate || null,
    tracks, finished: true,
  };
  await writeJson(path.join(rdir, 'meta.json'), meta);
  const project = defaults(duration);
  if (meta.cursorBaked === true || !g.rect) project.cursor.visible = false;
  await writeJson(path.join(r.dir, 'project.json'), project);
  if (info.thumbnail?.startsWith('data:image/jpeg;base64,')) {
    await fsp.writeFile(path.join(r.dir, 'thumbnail.jpg'), Buffer.from(info.thumbnail.split(',')[1], 'base64'));
  }
  hudWin?.close();
  mainWin?.show();
  updateTray();
  notifyLibrary();
  openEditor(r.id);
  return { id: r.id };
});

// ───────────────────────── redigerare ─────────────────────────

function openEditor(id) {
  packageDir(id);
  const existing = editors.get(id);
  if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return; }
  const win = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1100, minHeight: 700, title: APP_NAME, backgroundColor: '#15161a',
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  win.setMenuBarVisibility(false);
  win.loadURL('app://local/ui/renderer/editor.html?id=' + encodeURIComponent(id));
  lockdown(win);
  editors.set(id, win);
  win.on('closed', () => editors.delete(id));
}

ipcMain.handle('lib:open', (_e, id) => openEditor(id));
ipcMain.handle('lib:list', () => listLibrary());

ipcMain.handle('proj:load', async (_e, id) => {
  const dir = packageDir(id);
  const meta = await readJson(path.join(dir, 'recording', 'meta.json'));
  if (!meta) throw new Error('Paketet saknar meta.json');
  const events = parseEvents(await fsp.readFile(path.join(dir, 'recording', 'events.jsonl'), 'utf8').catch(() => ''));
  const project = loadProject(await readJson(path.join(dir, 'project.json'), {}), meta.duration);
  return { meta, events, project, base: `app://local/rec/${encodeURIComponent(id)}/` };
});
ipcMain.handle('proj:save', async (_e, id, project) => {
  await writeJson(path.join(packageDir(id), 'project.json'), project);
});
ipcMain.handle('proj:rename', async (_e, id, name) => {
  const f = path.join(packageDir(id), 'recording', 'meta.json');
  const meta = await readJson(f);
  if (meta) { meta.name = String(name).slice(0, 200); await writeJson(f, meta); notifyLibrary(); }
});
ipcMain.handle('proj:delete', async (_e, id) => {
  await shell.trashItem(packageDir(id));
  editors.get(id)?.close();
  notifyLibrary();
});
ipcMain.handle('shell:reveal', (_e, id) => shell.showItemInFolder(packageDir(id)));
ipcMain.handle('shell:revealPath', (_e, p) => { if (typeof p === 'string') shell.showItemInFolder(p); });

// ───────────────────────── export ─────────────────────────
// Redigeraren spelar upp den färdiga bilden och ljudet i realtid och skickar en WebM hit;
// ffmpeg gör om den till MP4/GIF (eller lagar WebM:ens sökindex).

const exportJobs = new Map();
ipcMain.handle('export:begin', async () => {
  const token = String(Date.now()) + Math.random().toString(16).slice(2);
  const file = path.join(os.tmpdir(), `bjarbys-export-${token}.webm`);
  exportJobs.set(token, { file, stream: fs.createWriteStream(file) });
  return token;
});
ipcMain.on('export:chunk', (_e, { token, data }) => {
  exportJobs.get(token)?.stream.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
});
ipcMain.handle('export:cancel', async (_e, token) => {
  const j = exportJobs.get(token); exportJobs.delete(token);
  if (j) { j.stream.destroy(); await fsp.rm(j.file, { force: true }); }
});
ipcMain.handle('export:end', async (e, { token, format, duration, name }) => {
  const job = exportJobs.get(token);
  if (!job) throw new Error('Okänt exportjobb');
  exportJobs.delete(token);
  await new Promise(res => job.stream.end(res));
  const ext = { mp4: 'mp4', webm: 'webm', gif: 'gif' }[format];
  if (!ext) throw new Error('Okänt format');
  const win = BrowserWindow.fromWebContents(e.sender);
  const pick = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('videos'), `${(name || 'Inspelning').replace(/[\\/:*?"<>|]/g, '-')}.${ext}`),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (pick.canceled || !pick.filePath) { await fsp.rm(job.file, { force: true }); return { canceled: true }; }
  const progress = f => e.sender.send('export:progress', f);
  try {
    if (format === 'webm') {
      if (!(await remuxTo(job.file, pick.filePath, duration, progress))) await fsp.copyFile(job.file, pick.filePath);
    } else if (format === 'mp4') {
      await runFfmpeg(['-i', job.file, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', pick.filePath], { duration, onProgress: progress });
    } else {
      await runFfmpeg(['-i', job.file, '-vf',
        'fps=15,scale=800:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
        '-loop', '0', pick.filePath], { duration, onProgress: progress });
    }
  } finally { await fsp.rm(job.file, { force: true }); }
  return { path: pick.filePath };
});
async function remuxTo(input, output, duration, onProgress) {
  if (!(await ffmpegPath())) return false;
  await runFfmpeg(['-i', input, '-c', 'copy', output], { duration, onProgress });
  return true;
}

// ───────────────────────── app ─────────────────────────

ipcMain.handle('app:capabilities', async () => ({
  ffmpeg: !!(await ffmpegPath()),
  clicks: await InputTracker.probe(),
  platform: process.platform,
  library: libraryDir(),
}));

ipcMain.handle('sources:list', async () => {
  const own = new Set([mainWin, ...editors.values()].filter(w => w && !w.isDestroyed()).map(w => w.getMediaSourceId()));
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'], thumbnailSize: { width: 360, height: 220 }, fetchWindowIcons: false,
  });
  return sources.filter(s => !own.has(s.id) && s.name.trim()).map(s => ({
    id: s.id, name: s.name, type: s.id.startsWith('screen:') ? 'screen' : 'window', thumb: s.thumbnail.toDataURL(),
  }));
});

function notifyLibrary() { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('lib:changed'); }

function lockdown(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://local/')) e.preventDefault(); });
}

function trayIcon() {
  const size = 16, buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5), i = (y * size + x) * 4;
    if (d < 6.5) { buf[i] = 0x3b; buf[i + 1] = 0x3b; buf[i + 2] = 0xe8; buf[i + 3] = 255; }   // BGRA: röd cirkel
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Visa ' + APP_NAME, click: () => { mainWin?.show(); mainWin?.focus(); } },
    { label: rec?.began ? 'Stoppa inspelningen (Ctrl+Skift+R)' : 'Spela in (Ctrl+Skift+R)', click: toggleRecording },
    { type: 'separator' },
    { label: 'Avsluta', click: () => app.quit() },
  ]));
  tray.setToolTip(rec?.began ? APP_NAME + ' — spelar in' : APP_NAME);
}

function toggleRecording() {
  if (rec) stopRecording(); else mainWin?.webContents.send('hotkey:toggle');
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1100, height: 780, minWidth: 820, minHeight: 600, title: APP_NAME, backgroundColor: '#15161a',
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  mainWin.setMenuBarVisibility(false);
  mainWin.loadURL('app://local/ui/renderer/index.html');
  lockdown(mainWin);
  mainWin.on('closed', () => { mainWin = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => { mainWin?.show(); mainWin?.focus(); });

app.whenReady().then(() => {
  // app://local/ui/… = programmets egna filer (bara renderer/ och lib/);
  // app://local/rec/<paket>/<fil> = en inspelnings spår (bara de kända filnamnen).
  protocol.handle('app', request => {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    let file = null;
    if (parts[0] === 'ui' && ['renderer', 'lib'].includes(parts[1]) && !parts.includes('..')) {
      file = path.join(ROOT, ...parts.slice(1));
    } else if (parts[0] === 'rec' && parts.length === 3 && ID_RE.test(parts[1])) {
      if (TRACK_FILES.has(parts[2])) file = path.join(packageDir(parts[1]), 'recording', parts[2]);
      else if (parts[2] === 'thumbnail.jpg') file = path.join(packageDir(parts[1]), 'thumbnail.jpg');
    }
    if (!file) return new Response('Nekad', { status: 404 });
    return net.fetch(pathToFileURL(file).toString(), { headers: request.headers });
  });

  // Skärmen som ska fångas väljs i programmets egen lista; getDisplayMedia får bara den.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (!pendingSource) return callback({});
    const wantSystem = request.audioRequested && rec?.opts.system;
    callback(wantSystem ? { video: pendingSource, audio: 'loopback' } : { video: pendingSource });
  }, { useSystemPicker: false });
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) =>
    cb(['media', 'display-capture'].includes(permission) && wc.getURL().startsWith('app://local/')));

  createMainWindow();
  tray = new Tray(trayIcon());
  tray.on('click', () => { mainWin?.show(); mainWin?.focus(); });
  updateTray();
  globalShortcut.register('Control+Shift+R', toggleRecording);
  globalShortcut.register('Control+Shift+P', () => rec?.began && hudWin?.webContents.send('hud:pause-toggle'));
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (!rec) app.quit(); });
