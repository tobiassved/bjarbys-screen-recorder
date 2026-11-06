// Rökprov i riktiga Electron: starta appen, lista källor, spela in ~4 s via HUD → MediaRecorder →
// huvudprocessen, kontrollera paketet och öppna redigeraren. Linux: xvfb-run -a node test/smoke.mjs
// (Windows-specifikt — datorljud, fönsterrutor, musrok — provas inte här.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let _electron;
try { ({ _electron } = require('playwright')); } catch { ({ _electron } = require(path.join(process.env.PLAYWRIGHT_DIR || '/opt/node22/lib/node_modules', 'playwright'))); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'bjarbys-bibliotek-'));
const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const app = await _electron.launch({
  args: ['--no-sandbox', '--disable-gpu', ROOT],
  env: { ...process.env, BJARBYS_BIBLIOTEK: LIB },
});
const main = await app.firstWindow();
main.on('console', m => { if (m.type() === 'error') log('  [main-fönster fel]', m.text()); });
await main.waitForFunction(() => document.querySelector('#sources .src') || document.querySelector('#sources').textContent.includes('Kunde'), null, { timeout: 20000 });
const caps = await main.evaluate(() => api.capabilities());
log('Förmågor:', JSON.stringify(caps));
assert.ok(caps.ffmpeg, 'ffmpeg-static hittades');
const sources = await main.evaluate(() => api.sources());
log('Källor:', sources.map(s => s.type + ':' + s.name).join(', '));
assert.ok(sources.some(s => s.type === 'screen'), 'minst en skärm');

const screenSrc = sources.find(s => s.type === 'screen');
const id = await main.evaluate(s => api.startRecording({ sourceId: s, mic: false, clean: false, system: false, camera: false, countdown: 0 }), screenSrc.id);
log('Inspelning startad:', id);
let hud;
for (let i = 0; i < 50 && !hud; i++) { hud = app.windows().find(w => w.url().includes('hud.html')); await sleep(200); }
assert.ok(hud, 'HUD-fönstret öppnades');
hud.on('console', m => log('  [hud]', m.text()));
await hud.waitForFunction(() => document.getElementById('timer'), null, { timeout: 20000 });
log('HUD visar timer: inspelningen går');
await sleep(4000);
await hud.evaluate(() => api.hud.requestStop());
let editor;
for (let i = 0; i < 100 && !editor; i++) { editor = app.windows().find(w => w.url().includes('editor.html')); await sleep(200); }
assert.ok(editor, 'redigeraren öppnades efter stopp');
await editor.waitForFunction(() => window.__editor && window.__editor.S.duration > 0, null, { timeout: 30000 });

const pkg = path.join(LIB, id, 'recording');
const files = fs.readdirSync(pkg);
log('Paketet:', files.join(', '));
const meta = JSON.parse(fs.readFileSync(path.join(pkg, 'meta.json')));
log('meta:', JSON.stringify({ duration: meta.duration, source: meta.source, cursorBaked: meta.cursorBaked, clicks: meta.clicksRecorded, tracks: meta.tracks }));
assert.ok(files.includes('screen.webm') && files.includes('events.jsonl') && files.includes('meta.json'));
assert.ok(fs.statSync(path.join(pkg, 'screen.webm')).size > 5000, 'skärmspåret har innehåll');
assert.ok(fs.existsSync(path.join(LIB, id, 'project.json')) && fs.existsSync(path.join(LIB, id, 'thumbnail.jpg')));
assert.ok(meta.duration > 2.5 && meta.duration < 7, 'längd ' + meta.duration);
const dur = await editor.evaluate(() => window.__editor.S.screen.duration);
log('Redigeraren läste filmen:', dur.toFixed(2), 's, ', await editor.evaluate(() => { const v = window.__editor.S.screen; return v.videoWidth + '×' + v.videoHeight; }));
assert.ok(Number.isFinite(dur) && Math.abs(dur - meta.duration) < 1.5, 'duration stämmer (ffmpeg-omkopiering)');
const lib = await main.evaluate(() => api.library());
assert.equal(lib.length, 1);
await editor.screenshot({ path: path.join(LIB, 'redigerare.png') });
log('\nRökprovet gick igenom. Bild:', path.join(LIB, 'redigerare.png'));
await app.close();
