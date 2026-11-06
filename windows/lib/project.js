// project.json: allt användaren har ändrat. Inspelningen rörs aldrig; redigeringen är bara
// beslut om hur den ska visas. Alla tider är källtid.
//
// FÄLLA (samma som i macOS-appen): ett nytt fält får aldrig göra gamla projekt oläsbara.
// `normalize` lägger standardvärden över det som saknas och kastar det som har fel typ, så att
// `{}` alltid är ett giltigt projekt.

export const SCHEMA_VERSION = 1;

export const BACKGROUNDS = {
  skymning:  { kind: 'gradient', from: '#1f1c4a', to: '#7a3b8f', angle: 135 },
  hav:       { kind: 'gradient', from: '#0f2027', to: '#2c7a8c', angle: 135 },
  gryning:   { kind: 'gradient', from: '#ff9a5a', to: '#e0457b', angle: 135 },
  skog:      { kind: 'gradient', from: '#0b3d2e', to: '#74a57f', angle: 135 },
  grafit:    { kind: 'solid', color: '#16171b' },
  ljus:      { kind: 'solid', color: '#eef0f4' },
};

export const ASPECTS = {
  wide:     { label: '16:9',  w: 16, h: 9 },
  square:   { label: '1:1',   w: 1,  h: 1 },
  vertical: { label: '9:16',  w: 9,  h: 16 },
  classic:  { label: '4:3',   w: 4,  h: 3 },
};

export function defaults(duration = 0) {
  return {
    schemaVersion: SCHEMA_VERSION,
    segments: [{ start: 0, end: duration, speed: 1 }],
    zooms: [],
    autoZoom: true,
    zoomsPlanned: false,    // de automatiska zoomarna är planerade en gång; raderar man dem kommer de inte tillbaka
    zoomScale: 2.0,
    background: { ...BACKGROUNDS.skymning },
    padding: 0.07,
    cornerRadius: 0.018,
    shadow: 0.55,
    aspect: 'wide',
    cursor: { visible: true, size: 1.0, clickEffect: true, color: '#ffffff' },
    camera: { visible: true, corner: 'br', size: 0.22 },
    audio: { mic: 1.0, system: 0.8 },
    shortcuts: { visible: true },
  };
}

function typeOf(v) { return Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v; }

export function normalize(raw, base) {
  if (typeOf(raw) !== 'object') return structuredClone(base);
  const out = {};
  for (const key of Object.keys(base)) {
    const d = base[key], v = raw[key];
    if (v === undefined || typeOf(v) !== typeOf(d)) out[key] = structuredClone(d);
    else if (typeOf(d) === 'object') out[key] = key === 'background' ? { ...d, ...v } : normalize(v, d);
    else out[key] = v;
  }
  return out;
}

export function loadProject(raw, duration) {
  const p = normalize(raw, defaults(duration));
  p.segments = p.segments
    .filter(s => s && typeof s.start === 'number' && typeof s.end === 'number' && s.end > s.start)
    .map(s => ({ start: Math.max(0, s.start), end: duration ? Math.min(s.end, duration) : s.end, speed: typeof s.speed === 'number' && s.speed > 0 ? s.speed : 1 }));
  if (!p.segments.length) p.segments = [{ start: 0, end: duration, speed: 1 }];
  return p;
}

export function outputSize(aspectKey, longSide = 1920) {
  const a = ASPECTS[aspectKey] || ASPECTS.wide;
  const f = longSide / Math.max(a.w, a.h);
  const even = n => Math.round(n / 2) * 2;
  return { w: even(a.w * f), h: even(a.h * f) };
}
