// En fjäder (massa–fjäder–dämpare) som löses analytiskt: tillståndet efter tiden t räknas ut
// exakt, så rörelsen blir densamma oavsett bildfrekvens. Port av Motion/Spring.swift.
//   m·x'' + c·x' + k·x = 0,  ω₀ = √(k/m),  ζ = c / (2√(k·m))

export class Spring {
  constructor(tension, mass, friction) {
    this.tension = tension; this.mass = mass; this.friction = friction;
  }
  get omega0() { return Math.sqrt(this.tension / this.mass); }
  get zeta() { return this.friction / (2 * Math.sqrt(this.tension * this.mass)); }

  // Avstånd och hastighet efter t, från avstånd x0 och hastighet v0 (båda mot målet).
  solve(x0, v0, t) {
    const w = this.omega0, z = this.zeta;
    if (!(t > 0) || !(w > 0)) return { x: x0, v: v0 };
    if (Math.abs(z - 1) < 1e-6) {                       // kritiskt dämpad
      const e = Math.exp(-w * t), b = v0 + w * x0;
      return { x: e * (x0 + b * t), v: e * (b - w * (x0 + b * t)) };
    }
    if (z < 1) {                                        // underdämpad
      const wd = w * Math.sqrt(1 - z * z), e = Math.exp(-z * w * t);
      const b = (v0 + z * w * x0) / wd, c = Math.cos(wd * t), s = Math.sin(wd * t);
      return { x: e * (x0 * c + b * s), v: e * ((b * wd - z * w * x0) * c - (x0 * wd + z * w * b) * s) };
    }
    const r = Math.sqrt(z * z - 1);                     // överdämpad
    const r1 = -w * (z - r), r2 = -w * (z + r);
    const c2 = (v0 - r1 * x0) / (r2 - r1), c1 = x0 - c2;
    const e1 = Math.exp(r1 * t), e2 = Math.exp(r2 * t);
    return { x: c1 * e1 + c2 * e2, v: c1 * r1 * e1 + c2 * r2 * e2 };
  }
}

// Profiler från utredningen (samma tal som macOS-appen).
export const Springs = {
  cursorDefault: new Spring(170, 1, 20),
  cursorSnappy: new Spring(700, 1, 30),
  cursorDrag: new Spring(136, 1.2, 26),
  viewport: new Spring(240, 3.375, 80),   // överdämpad: bilden studsar aldrig
  zoomIn: new Spring(200, 1, 26),
  zoomOut: new Spring(120, 1, 22),
};

// Ett värde som följer ett mål med en fjäder, steg för steg. Målet får bara bytas vid stegens
// gränser; då hålls positionen oförändrad (avståndet justeras).
export class Follower {
  constructor(value) { this.value = value; this.target = value; this.velocity = 0; }
  retarget(target) { this.target = target; }
  step(dt, spring) {
    const { x, v } = spring.solve(this.value - this.target, this.velocity, dt);
    this.value = this.target + x; this.velocity = v;
    return this.value;
  }
}
