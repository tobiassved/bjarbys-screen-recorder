// Delarna av inspelningen som är med (källtid), med hastighet. Klipp = luckor mellan dem.
// Port av Motion/TimeMap.swift.

export class TimeMap {
  constructor(segments) {
    this.segments = segments.filter(s => s.end > s.start).map(s => ({ speed: 1, ...s }));
    this.starts = [];  // utdatatid där varje del börjar
    let acc = 0;
    for (const s of this.segments) { this.starts.push(acc); acc += (s.end - s.start) / s.speed; }
    this.outputDuration = acc;
  }
  // Källtid för en utdatatid.
  toSource(tOut) {
    const segs = this.segments;
    if (!segs.length) return 0;
    for (let i = segs.length - 1; i >= 0; i--) {
      if (tOut >= this.starts[i]) {
        const s = segs[i];
        return Math.min(s.end, s.start + (tOut - this.starts[i]) * s.speed);
      }
    }
    return segs[0].start;
  }
  // Utdatatid för en källtid, eller null om den är bortklippt.
  toOutput(tSrc) {
    for (let i = 0; i < this.segments.length; i++) {
      const s = this.segments[i];
      if (tSrc >= s.start && tSrc <= s.end) return this.starts[i] + (tSrc - s.start) / s.speed;
    }
    return null;
  }
  // Delen som innehåller källtiden, eller index till nästa del (för att hoppa över en lucka).
  segmentAt(tSrc) {
    for (let i = 0; i < this.segments.length; i++) {
      const s = this.segments[i];
      if (tSrc >= s.start && tSrc < s.end) return { index: i, inside: true, segment: s };
      if (tSrc < s.start) return { index: i, inside: false, segment: s };
    }
    return { index: -1, inside: false, segment: null }; // efter sista delen
  }
}

// Delar den del som innehåller källtiden t i två. Ingen effekt nära kanterna (< 0,1 s).
export function splitAt(segments, t) {
  const out = [];
  for (const s of segments) {
    if (t > s.start + 0.1 && t < s.end - 0.1) {
      out.push({ ...s, end: t }, { ...s, start: t });
    } else out.push(s);
  }
  return out;
}

// Tar bort del nummer i. Den sista delen går inte att ta bort.
export function removeSegment(segments, i) {
  if (segments.length <= 1) return segments;
  return segments.filter((_, k) => k !== i);
}
