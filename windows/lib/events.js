// events.jsonl: en JSON-rad per händelse, t i sekunder på inspelningens tidslinje (samma format
// som macOS-appen, se docs/FORMAT.md). En avbruten sista rad hoppas över.

export function parseEvents(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (typeof e.t === 'number') out.push(e); } catch { /* avbruten rad */ }
  }
  return out;
}

export function serializeEvents(events) {
  return events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
}

// Globala punkter (DIP) → normaliserade 0–1 i källan. `rect` = {x,y,w,h} i samma enhet.
export function normalizer(rect) {
  return (x, y) => ({ x: (x - rect.x) / rect.w, y: (y - rect.y) / rect.h });
}

// Kortkommando som text, t.ex. "Ctrl+Shift+S". Bara kombinationer med Ctrl/Alt/Win räknas.
export function shortcutLabel({ ctrl, alt, shift, meta }, keyName) {
  if (!(ctrl || alt || meta)) return null;
  const mods = [ctrl && 'Ctrl', alt && 'Alt', shift && 'Skift', meta && 'Win'].filter(Boolean);
  return [...mods, keyName].join('+');
}
