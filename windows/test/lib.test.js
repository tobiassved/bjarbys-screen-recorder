import test from 'node:test';
import assert from 'node:assert/strict';
import { Spring, Springs, Follower } from '../lib/spring.js';
import { TimeMap, splitAt, removeSegment } from '../lib/timemap.js';
import { CursorPath } from '../lib/cursorpath.js';
import { planZooms, ViewTrack, clampCenter } from '../lib/viewtrack.js';
import { parseEvents, serializeEvents, shortcutLabel } from '../lib/events.js';
import { loadProject, defaults, outputSize } from '../lib/project.js';

test('fjäder: kommer fram till målet och är oberoende av stegstorlek', () => {
  for (const sp of [Springs.cursorDefault, Springs.viewport, new Spring(100, 1, 20)]) {
    const r = sp.solve(1, 0, 10);
    assert.ok(Math.abs(r.x) < 1e-3, 'kvar ' + r.x);
  }
  // En steg på 0,5 s == fem steg på 0,1 s (analytisk lösning).
  const sp = Springs.zoomIn;
  const one = sp.solve(1, 0, 0.5);
  let x = 1, v = 0;
  for (let i = 0; i < 5; i++) ({ x, v } = sp.solve(x, v, 0.1));
  assert.ok(Math.abs(one.x - x) < 1e-9 && Math.abs(one.v - v) < 1e-9);
});

test('fjäder: viewport är överdämpad (studsar inte)', () => {
  assert.ok(Springs.viewport.zeta > 1);
  for (let t = 0; t < 3; t += 0.05) assert.ok(Springs.viewport.solve(1, 0, t).x >= -1e-9);
});

test('follower: målbyte bryter inte positionen', () => {
  const f = new Follower(0); f.retarget(1);
  for (let i = 0; i < 10; i++) f.step(1 / 120, Springs.cursorDefault);
  const before = f.value; f.retarget(0.2);
  assert.equal(f.value, before);
});

test('tidskarta: klipp och hastighet', () => {
  const m = new TimeMap([{ start: 0, end: 2 }, { start: 5, end: 9, speed: 2 }]);
  assert.equal(m.outputDuration, 2 + 2);
  assert.equal(m.toSource(1), 1);
  assert.equal(m.toSource(3), 5 + 1 * 2);
  assert.equal(m.toOutput(3), null);
  assert.equal(m.toOutput(7), 2 + 1);
  assert.deepEqual(m.segmentAt(3), { index: 1, inside: false, segment: m.segments[1] });
  assert.equal(m.segmentAt(10).index, -1);
});

test('klipp: dela och ta bort, sista delen kan inte tas bort', () => {
  let s = splitAt([{ start: 0, end: 10, speed: 1 }], 4);
  assert.equal(s.length, 2);
  assert.equal(splitAt(s, 4.05).length, 2, 'för nära kanten');
  s = removeSegment(s, 0);
  assert.equal(s.length, 1);
  assert.equal(removeSegment(s, 0).length, 1);
});

test('händelser: avbruten sista rad hoppas över; rundtur', () => {
  const ev = parseEvents('{"t":0.1,"k":"move","x":1,"y":2}\n{"t":0.2,"k":"down"\n');
  assert.equal(ev.length, 1);
  assert.deepEqual(parseEvents(serializeEvents(ev)), ev);
  assert.equal(shortcutLabel({ ctrl: true, shift: true }, 'S'), 'Ctrl+Skift+S');
  assert.equal(shortcutLabel({ shift: true }, 'A'), null, 'vanlig text sparas aldrig');
});

const rect = { x: 0, y: 0, w: 1000, h: 500 };
function movesTo(x, y, t0, t1) { // rak rörelse
  const out = [];
  for (let t = t0; t <= t1; t += 0.01) out.push({ t, k: 'move', x: x * (t - t0) / (t1 - t0), y: y * (t - t0) / (t1 - t0) });
  return out;
}

test('markörbana: landar på klicket och står still över glapp', () => {
  const ev = [...movesTo(800, 200, 0, 1), { t: 1.0, k: 'down', x: 800, y: 200, b: 0 }, { t: 1.1, k: 'up', x: 800, y: 200, b: 0 }];
  const p = new CursorPath(ev, rect, 6);
  assert.ok(p.hasData);
  assert.equal(p.clicks.length, 1);
  const at = p.at(1.0);
  assert.ok(Math.abs(at.x - 0.8) < 0.05 && Math.abs(at.y - 0.4) < 0.05, JSON.stringify(at));
  const late = p.at(5);                      // långt efter sista händelsen: kvar på sista punkten
  assert.ok(Math.abs(late.x - 0.8) < 1e-3);
});

test('markörbana utan data ger null', () => {
  const p = new CursorPath([], rect, 3);
  assert.equal(p.hasData, false);
  assert.equal(p.at(1), null);
});

test('zoomplan: klick nära varandra blir en zoom, långt isär två; spridda hoppas över', () => {
  const clicks = [
    { t: 2, x: 0.3, y: 0.3 }, { t: 2.8, x: 0.32, y: 0.34 },
    { t: 10, x: 0.8, y: 0.7 },
  ];
  const z = planZooms(clicks, 20, { scale: 2 });
  assert.equal(z.length, 2);
  assert.ok(z[0].start < 2 && z[0].end > 2.8);
  assert.ok(Math.abs(z[0].cx - 0.31) < 1e-6);
  const wide = planZooms([{ t: 1, x: 0.05, y: 0.5 }, { t: 1.5, x: 0.95, y: 0.5 }], 10, { scale: 2 });
  assert.equal(wide.length, 0, 'bredare än vad en zoom rymmer');
});

test('vybana: zoomar in mot klicket och tillbaka, utsnittet stannar i källan', () => {
  const zoom = { start: 2, end: 4, scale: 2, cx: 0.9, cy: 0.1, enabled: true };
  const v = new ViewTrack([zoom], 8);
  assert.equal(v.at(0).scale, 1);
  const mid = v.at(3.9);
  assert.ok(mid.scale > 1.9, 'zoomad: ' + mid.scale);
  assert.ok(mid.cx <= 0.75 + 1e-6 && mid.cy >= 0.25 - 1e-6, 'utsnittet stannar i bild');
  const after = v.at(7.9);
  assert.ok(after.scale < 1.02 && Math.abs(after.cx - 0.5) < 0.02);
  // Avstängd zoom gör ingenting.
  assert.equal(new ViewTrack([{ ...zoom, enabled: false }], 8).at(3).scale, 1);
  assert.deepEqual(clampCenter(0, 1, 2), { cx: 0.25, cy: 0.75 });
});

test('vybana: följer markören som lämnar utsnittet', () => {
  const zoom = { start: 0, end: 6, scale: 2, cx: 0.3, cy: 0.5, enabled: true };
  const fixed = new ViewTrack([zoom], 6).at(5);
  const follow = new ViewTrack([zoom], 6, t => ({ x: 0.7, y: 0.5 })).at(5);
  assert.ok(follow.cx > fixed.cx + 0.1);
});

test('projekt: {} och skräp är giltiga; nya fält gör inte gamla projekt oläsbara', () => {
  const p = loadProject({}, 12);
  assert.equal(p.segments[0].end, 12);
  assert.equal(p.cursor.size, 1);
  const q = loadProject({ padding: 'mycket', cursor: { size: 2 }, segments: [{ start: -3, end: 99, speed: 0 }], okänt: 1 }, 12);
  assert.equal(q.padding, defaults().padding, 'fel typ → standard');
  assert.equal(q.cursor.size, 2);
  assert.equal(q.cursor.clickEffect, true, 'saknat fält i objekt → standard');
  assert.deepEqual(q.segments, [{ start: 0, end: 12, speed: 1 }]);
  assert.equal(q.okänt, undefined);
  assert.equal(loadProject(null, 5).aspect, 'wide');
});

test('utdatastorlek: jämna mått', () => {
  assert.deepEqual(outputSize('wide'), { w: 1920, h: 1080 });
  assert.deepEqual(outputSize('vertical'), { w: 1080, h: 1920 });
  assert.deepEqual(outputSize('square', 1080), { w: 1080, h: 1080 });
});
