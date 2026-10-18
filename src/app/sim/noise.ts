/**
 * The turbulence field of the original look, computed identically but without per-particle `Math.sin`.
 *
 * Original: a 3-octave value-noise fbm sampled four times per particle for a finite-difference curl
 * (about 48 sin-hash calls per particle per frame). Lattice hashes are a pure function of INTEGER
 * coordinates and only a tiny window of the lattice is ever touched (the whole screen covers about
 * 3x2 cells at the base octave), so the hashes are cached per octave in small tables. Every value is the
 * same double the original produced, and the interpolation uses the same expression, so the output is
 * bit-identical (test/geo/noise.spec.ts proves it against a copy of the original code).
 */

/** Noise coordinates per screen pixel (original `scale`). */
export const NOISE_SCALE = 0.0012;
const EPS = 0.01;
const OCTAVES = 3;

/** The original hash. */
export function hash(x: number, y: number): number {
  const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453123;
  return h - Math.floor(h);
}

class Lattice {
  x0 = Number.NaN;
  y0 = Number.NaN;
  readonly data: Float64Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = new Float64Array(w * h);
  }

  /** Re-anchor the window if needed (cheap: the window moves one cell every few seconds). */
  ensure(x0: number, y0: number): void {
    if (x0 === this.x0 && y0 === this.y0) return;
    this.x0 = x0;
    this.y0 = y0;
    for (let j = 0; j < this.h; j++) for (let i = 0; i < this.w; i++) this.data[j * this.w + i] = hash(x0 + i, y0 + j);
  }

  /** Cached hash; falls back to computing it for coordinates outside the window (never expected). */
  at(ix: number, iy: number): number {
    const i = ix - this.x0;
    const j = iy - this.y0;
    if (i >= 0 && i < this.w && j >= 0 && j < this.h) return this.data[j * this.w + i];
    return hash(ix, iy);
  }
}

export class CurlNoise {
  /** Derivatives of the last `curl` call (no per-call allocation). */
  dPsiDx = 0;
  dPsiDy = 0;
  // Window A serves the two evaluations that shift in y (x untouched), B the two that shift in x.
  private a: Lattice[] = [];
  private b: Lattice[] = [];
  private w = 0;
  private h = 0;

  /** Size the windows for a viewport (call on resize). */
  resize(width: number, height: number): void {
    this.w = width;
    this.h = height;
    this.a = [];
    this.b = [];
    for (let o = 0; o < OCTAVES; o++) {
      const k = 2 ** o;
      const cols = Math.ceil(width * NOISE_SCALE * k + 2 * EPS * k) + 4;
      const rows = Math.ceil(height * NOISE_SCALE * k + 2 * EPS * k) + 4;
      this.a.push(new Lattice(cols, rows));
      this.b.push(new Lattice(cols, rows));
    }
  }

  /** Position the windows for time `t` (once per frame). */
  prepare(t: number): void {
    for (let o = 0; o < OCTAVES; o++) {
      const k = 2 ** o;
      const shifted = Math.floor((-t - EPS) * k) - 1;
      this.a[o].ensure(-1, shifted);
      this.b[o].ensure(shifted, -1);
    }
  }

  private fbm(tabs: Lattice[], x: number, y: number): number {
    let value = 0;
    let amplitude = 0.5;
    for (let o = 0; o < OCTAVES; o++) {
      const iX = Math.floor(x);
      const iY = Math.floor(y);
      const fX = x - iX;
      const fY = y - iY;
      const u = fX * fX * (3.0 - 2.0 * fX);
      const v = fY * fY * (3.0 - 2.0 * fY);
      const t = tabs[o];
      const a = t.at(iX, iY);
      const b = t.at(iX + 1, iY);
      const c = t.at(iX, iY + 1);
      const d = t.at(iX + 1, iY + 1);
      value += amplitude * (a + u * (b - a) + v * (c - a) + u * v * (a - b - c + d));
      x *= 2.0;
      y *= 2.0;
      amplitude *= 0.5;
    }
    return value;
  }

  /** Finite-difference derivatives of the fbm at screen position (x, y) and time t. */
  curl(x: number, y: number, t: number): void {
    const sx = x * NOISE_SCALE;
    const sy = y * NOISE_SCALE;
    const n1 = this.fbm(this.a, sx, sy + EPS - t);
    const n2 = this.fbm(this.a, sx, sy - EPS - t);
    this.dPsiDy = (n1 - n2) / (2 * EPS);
    const n3 = this.fbm(this.b, sx + EPS - t, sy);
    const n4 = this.fbm(this.b, sx - EPS - t, sy);
    this.dPsiDx = (n3 - n4) / (2 * EPS);
  }
}
