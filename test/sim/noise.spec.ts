import { describe, expect, it } from 'vitest';
import { CurlNoise } from '../../src/app/sim/noise';

// Verbatim copy of the ORIGINAL implementation (src/app/app.ts at c0caed6): hash, noise, fbm and the
// finite-difference curl inputs of getFluidVelocity.
const hash = (x: number, y: number): number => {
  const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453123;
  return h - Math.floor(h);
};
const noise = (x: number, y: number): number => {
  const iX = Math.floor(x);
  const iY = Math.floor(y);
  const fX = x - iX;
  const fY = y - iY;
  const u = fX * fX * (3.0 - 2.0 * fX);
  const v = fY * fY * (3.0 - 2.0 * fY);
  const a = hash(iX, iY);
  const b = hash(iX + 1, iY);
  const c = hash(iX, iY + 1);
  const d = hash(iX + 1, iY + 1);
  return a + u * (b - a) + v * (c - a) + u * v * (a - b - c + d);
};
const fbm = (x: number, y: number): number => {
  let value = 0;
  let amplitude = 0.5;
  for (let i = 0; i < 3; i++) {
    value += amplitude * noise(x, y);
    x *= 2.0;
    y *= 2.0;
    amplitude *= 0.5;
  }
  return value;
};
const originalCurl = (x: number, y: number, t: number) => {
  const scale = 0.0012;
  const sx = x * scale;
  const sy = y * scale;
  const eps = 0.01;
  const n1 = fbm(sx, sy + eps - t);
  const n2 = fbm(sx, sy - eps - t);
  const dPsi_dy = (n1 - n2) / (2 * eps);
  const n3 = fbm(sx + eps - t, sy);
  const n4 = fbm(sx - eps - t, sy);
  const dPsi_dx = (n3 - n4) / (2 * eps);
  return { dPsi_dx, dPsi_dy };
};

/** Small deterministic PRNG so the test is repeatable. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('CurlNoise (hash cache) is bit-identical to the original fbm curl', () => {
  for (const [w, h] of [
    [1920, 1080],
    [1366, 768],
    [390, 844],
    [3440, 1440],
    [5120, 2880],
  ]) {
    it(`${w}x${h}: identical at every sampled position, over a long uptime`, () => {
      const field = new CurlNoise();
      field.resize(w, h);
      const rand = rng(w * 31 + h);
      let compared = 0;
      // t = performance.now() * 0.00005: 0 s, 1 min, 1 h, 1 day, 11 days of uptime
      for (const t of [0, 0.05, 3, 180, 4320, 50000]) {
        field.prepare(t);
        for (let i = 0; i < 4000; i++) {
          // include the exact edges and the off-screen margin particles can reach (-50 .. size + 50)
          const x = i < 8 ? [0, w, -50, w + 50, 0, w, -50, w + 50][i] : -50 + rand() * (w + 100);
          const y = i < 8 ? [0, 0, 0, 0, h, h, h, h][i] : -50 + rand() * (h + 100);
          field.curl(x, y, t);
          const o = originalCurl(x, y, t);
          expect(field.dPsiDx).toBe(o.dPsi_dx);
          expect(field.dPsiDy).toBe(o.dPsi_dy);
          compared++;
        }
      }
      expect(compared).toBe(24000);
    });
  }

  it('stays identical while time advances frame by frame (window re-anchoring)', () => {
    const field = new CurlNoise();
    field.resize(1920, 1080);
    const rand = rng(7);
    let t = 12.34;
    for (let frame = 0; frame < 20000; frame++) {
      t += 0.05 / 60; // ~60 fps
      field.prepare(t);
      if (frame % 97 === 0) {
        const x = rand() * 1920;
        const y = rand() * 1080;
        field.curl(x, y, t);
        const o = originalCurl(x, y, t);
        expect(field.dPsiDx).toBe(o.dPsi_dx);
        expect(field.dPsiDy).toBe(o.dPsi_dy);
      }
    }
  });
});
