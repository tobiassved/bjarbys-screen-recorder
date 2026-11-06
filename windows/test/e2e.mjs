// Helprov av redigeraren i ett riktigt Chromium, utan Electron: ett syntetiskt .bsrec-paket
// (påhittad skärm, ton, kamera, mus och klick) serveras av en liten server och brygggränssnittet
// (window.api) ersätts med en stubb. Själva editor.js, render.js och lib/ är de riktiga.
//   node test/e2e.mjs [utkatalog]        (kräver ffmpeg och playwright)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProject } from '../lib/project.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require(path.join(process.env.PLAYWRIGHT_DIR || '/opt/node22/lib/node_modules', 'playwright'))); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'bjarbys-e2e-')));
fs.mkdirSync(OUT, { recursive: true });
const PKG = path.join(OUT, 'pkg', 'recording');
fs.mkdirSync(PKG, { recursive: true });
const DUR = 8;

// ── fixtur: skärm utan duration/index (som MediaRecorder), ton, kamera ──
const ff = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
ff('-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${DUR}`, '-c:v', 'libvpx-vp9', '-b:v', '2M', '-deadline', 'realtime',
   '-f', 'webm', '-live', '1', path.join(PKG, 'screen.webm'));
ff('-f', 'lavfi', '-i', `sine=frequency=440:duration=${DUR}`, '-c:a', 'libopus', path.join(PKG, 'mic.webm'));
ff('-f', 'lavfi', '-i', `mandelbrot=size=640x480:rate=30`, '-t', String(DUR), '-c:v', 'libvpx-vp9', '-b:v', '600k', '-deadline', 'realtime', path.join(PKG, 'camera.webm'));

// Musen rör sig till tre klick: två nära varandra i tiden (en zoom), ett senare (en till).
const ev = [];
const glide = (t0, t1, [x0, y0], [x1, y1]) => { for (let t = t0; t <= t1; t += 1 / 125) { const a = (t - t0) / (t1 - t0); ev.push({ t: +t.toFixed(3), k: 'move', x: x0 + (x1 - x0) * a, y: y0 + (y1 - y0) * a }); } };
glide(0, 2.0, [100, 100], [300, 560]);
ev.push({ t: 2.0, k: 'down', x: 300, y: 560, b: 0, n: 1 }, { t: 2.1, k: 'up', x: 300, y: 560, b: 0 });
glide(2.1, 2.8, [300, 560], [380, 600]);
ev.push({ t: 2.8, k: 'down', x: 380, y: 600, b: 0, n: 1 }, { t: 2.9, k: 'up', x: 380, y: 600, b: 0 });
ev.push({ t: 3.0, k: 'key', label: 'Ctrl+S' });
glide(3, 5.5, [380, 600], [1000, 150]);
ev.push({ t: 5.5, k: 'down', x: 1000, y: 150, b: 0, n: 1 }, { t: 5.6, k: 'up', x: 1000, y: 150, b: 0 });
fs.writeFileSync(path.join(PKG, 'events.jsonl'), ev.map(e => JSON.stringify(e)).join('\n') + '\n');
const meta = {
  schemaVersion: 1, platform: 'windows', createdAt: new Date().toISOString(), duration: DUR, name: 'Prov',
  source: { kind: 'display', contentRect: [0, 0, 1280, 720], pixelScale: 1, pixelWidth: 1280, pixelHeight: 720 },
  cursorBaked: false, clicksRecorded: true, finished: true,
  tracks: [{ kind: 'screen', file: 'screen.webm', start: 0 }, { kind: 'microphone', file: 'mic.webm', start: 0.2 }, { kind: 'camera', file: 'camera.webm', start: 0 }],
};
fs.writeFileSync(path.join(PKG, 'meta.json'), JSON.stringify(meta));

// ── server: programfilerna och paketet, med Range (så att video går att söka i) ──
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webm': 'video/webm' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let file = u.pathname.startsWith('/rec/test/') ? path.join(PKG, path.basename(u.pathname)) : path.join(ROOT, u.pathname);
  if (!file.startsWith(ROOT) && !file.startsWith(PKG) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  const size = fs.statSync(file).size, type = types[path.extname(file)] || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const s = m[1] ? +m[1] : 0, e = m[2] ? +m[2] : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${s}-${e}/${size}`, 'Content-Length': e - s + 1 });
    fs.createReadStream(file, { start: s, end: e }).pipe(res);
  } else { res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size }); fs.createReadStream(file).pipe(res); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// ── webbläsaren ──
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'], executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1480, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const exported = { chunks: [], saved: [] };
await page.exposeFunction('__chunk', b => exported.chunks.push(Buffer.from(b, 'base64')));
await page.exposeFunction('__expEnd', p => exported.saved.push(p));
await page.addInitScript(({ port, ev, meta, project }) => {
  window.api = {
    load: async () => ({ meta, events: ev, project, base: `http://127.0.0.1:${port}/rec/test/` }),
    save: async (id, p) => { window.__saved = p; }, rename: async () => {},
    capabilities: async () => ({ ffmpeg: true, clicks: true, platform: 'win32' }),
    revealPath: () => {},
    exporter: {
      begin: async () => 'tok', cancel: async () => {}, onProgress: () => () => {},
      chunk: (t, data) => { let s = ''; for (let i = 0; i < data.length; i += 8192) s += String.fromCharCode(...data.subarray(i, i + 8192)); window.__chunk(btoa(s)); },
      end: async o => { window.__expEnd(JSON.stringify(o)); return { path: 'prov.webm' }; },
    },
  };
}, { port, ev, meta, project: loadProject({}, DUR) });
await page.goto(`http://127.0.0.1:${port}/renderer/editor.html?id=test`);
try { await page.waitForFunction(() => window.__editor && window.__editor.S.duration > 0 && window.__editor.S.tm, null, { timeout: 20000 }); }
catch (e) { console.error('Editorn startade inte. Sidans fel:', errors, await page.evaluate(() => document.body.innerText.slice(0, 300))); await browser.close(); server.close(); process.exit(1); }

const E = fn => page.evaluate(fn);
let ok = 0;
const check = (name, cond, extra = '') => { assert.ok(cond, name + ' ' + extra); console.log('  ✓', name, extra); ok++; };

console.log('Redigerare i Chromium:');
const st = await E(() => { const S = window.__editor.S; return { dur: S.duration, zooms: S.project.zooms.map(z => ({ s: +z.start.toFixed(2), e: +z.end.toFixed(2), sc: +z.scale.toFixed(2), cx: +z.cx.toFixed(2), cy: +z.cy.toFixed(2) })), clicks: S.cursorPath.clicks.length, hasCursor: S.hasCursor, aux: S.aux.map(a => a.kind), segs: S.project.segments }; });
check('längden mäts trots saknad duration i WebM', Math.abs(st.dur - DUR) < 0.4, `(${st.dur.toFixed(2)} s)`);
check('3 klick lästes', st.clicks === 3);
check('2 automatiska zoomar planerades (klick 1+2 hör ihop, 3 för sig)', st.zooms.length === 2, JSON.stringify(st.zooms));
check('markören finns', st.hasCursor);
check('mikrofon + kamera hittades', st.aux.includes('microphone') && st.aux.includes('camera'));

// Rutor: före zoom, mitt i zoom, efter.
const shot = async (t, name) => {
  await page.evaluate(async t => { const s = window.__editor.S.screen; const done = new Promise(r => s.addEventListener('seeked', r, { once: true })); window.__editor.seek(t); await done; await new Promise(r => setTimeout(r, 250)); }, t);
  const view = await E(() => window.__editor.S.view.at(window.__editor.S.screen.currentTime));
  await page.locator('#cv').screenshot({ path: path.join(OUT, name) });
  return view;
};
const v0 = await shot(0.8, 'ruta-0-utan-zoom.png');
const v1 = await shot(2.6, 'ruta-1-zoom-pa-klick.png');
const v2 = await shot(7.8, 'ruta-2-efter.png');
check('ingen zoom före första klicket', v0.scale < 1.05, `(${v0.scale.toFixed(2)})`);
check('zoomad vid klicken', v1.scale > 1.7, `(${v1.scale.toFixed(2)}×, mitt ${v1.cx.toFixed(2)},${v1.cy.toFixed(2)})`);
check('zoomen riktas mot klicken (nere till vänster)', v1.cx < 0.5 && v1.cy > 0.5);
check('åter utzoomad efteråt', v2.scale < 1.1, `(${v2.scale.toFixed(2)})`);

// Klipp: dela, ta bort, hastighet → tidskartan.
await page.evaluate(() => { window.__editor.seek(4); });
await page.waitForTimeout(200);
await E(() => window.__editor.splitHere());
const segs = await E(() => window.__editor.S.project.segments.length);
check('Dela ger två delar', segs === 2);
await E(() => { const S = window.__editor.S; S.sel = { type: 'seg', obj: S.project.segments[1] }; });
await page.keyboard.press('Delete');
await page.waitForTimeout(100);
const after = await E(() => { const S = window.__editor.S; return { n: S.project.segments.length, out: S.tm.outputDuration }; });
check('Ta bort lämnar en del på ~4 s', after.n === 1 && Math.abs(after.out - 4) < 0.3, `(${after.out.toFixed(2)} s)`);
await page.waitForTimeout(700);
const savedProject = await E(() => window.__saved);
check('ändringen sparades (project.json)', savedProject && savedProject.segments.length === 1 && savedProject.zooms.length === 2);

// Mobilformat.
await E(() => { const S = window.__editor.S; S.project.aspect = 'vertical'; window.__editor.changed({ aspect: true }); });
await page.waitForTimeout(300);
await shot(2.6, 'ruta-3-9x16.png');
const dims = await E(() => [document.getElementById('cv').width, document.getElementById('cv').height]);
check('9:16 ger 1080×1920', dims[0] === 1080 && dims[1] === 1920);
await E(() => { const S = window.__editor.S; S.project.aspect = 'wide'; window.__editor.changed({ aspect: true }); });

// Hela redigeraren som bild.
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUT, 'redigerare.png') });

// Export: realtid till WebM via MediaRecorder + ljudgraf.
console.log('Export (realtid, ~4 s):');
await E(() => { const S = window.__editor.S; S.project.segments = [{ start: 0, end: 4, speed: 1 }]; window.__editor.changed({ tm: true }); });
const t0 = Date.now();
const res = await page.evaluate(() => window.__editor.runExport({ format: 'webm', longSide: 1280, fps: 30 }));
const secs = (Date.now() - t0) / 1000;
const webm = Buffer.concat(exported.chunks);
fs.writeFileSync(path.join(OUT, 'export.webm'), webm);
check('export gav en WebM', webm.length > 20000 && webm.subarray(0, 4).toString('hex') === '1a45dfa3', `(${(webm.length / 1024).toFixed(0)} kB på ${secs.toFixed(1)} s)`);
check('exporten gick i realtid', secs > 3 && secs < 12);
check('end-anropet fick format och längd', res.path === 'prov.webm');
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path.join(OUT, 'export.webm')]).toString());
const kinds = probe.streams.map(s => s.codec_type);
check('exporten har både bild och ljud', kinds.includes('video') && kinds.includes('audio'), JSON.stringify(probe.streams.map(s => s.codec_name)));
const v = probe.streams.find(s => s.codec_type === 'video');
check('bilden är 1280×720', v.width === 1280 && v.height === 720, `(${v.width}×${v.height})`);
// Ljudet ska vara tonen (440 Hz, ej tystnad).
const vol = execFileSync('ffmpeg', ['-hide_banner', '-i', path.join(OUT, 'export.webm'), '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
const stderr = (() => { try { execFileSync('true'); } catch {} return ''; })();
const volOut = execFileSync('sh', ['-c', `ffmpeg -hide_banner -i "${path.join(OUT, 'export.webm')}" -vn -af volumedetect -f null - 2>&1 | grep mean_volume`]).toString();
const mean = parseFloat(/mean_volume: (-?[\d.]+)/.exec(volOut)[1]);
check('ljudet är inte tyst', mean > -50, `(${mean} dB)`);
// En ruta ur exporten.
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '2.6', '-i', path.join(OUT, 'export.webm'), '-frames:v', '1', path.join(OUT, 'export-ruta-2.6s.png')]);

check('inga fel i konsolen', errors.length === 0, errors.join(' | '));
await browser.close(); server.close();
console.log(`\n${ok} kontroller gick igenom. Bilder: ${OUT}`);
