import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { CurlNoise } from '../../src/app/sim/noise';
import { PARTICLE_COLORS, ParticleSystem } from '../../src/app/sim/particles';

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The ORIGINAL drawing: one path and one stroke() per particle, with its exact width. */
function drawPerParticle(sys: ParticleSystem, ctx: SKRSContext2D) {
  sys.forEachLive((lx, ly, x, y, size, color) => {
    ctx.strokeStyle = PARTICLE_COLORS[color];
    ctx.lineWidth = size;
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.lineTo(x, y);
    ctx.stroke();
  });
}

describe('batched stroke drawing vs the original per-particle strokes', () => {
  for (const [W, H] of [
    [1920, 1080],
    [390, 844],
  ]) {
    it(`${W}x${H}: trails after 120 frames are visually identical (same particle state, same fade)`, () => {
      const n = Math.min(Math.floor((W * H) / 800), 2500);
      const sys = new ParticleSystem(n, W, H, rng(42));
      const noise = new CurlNoise();
      noise.resize(W, H);
      const a = createCanvas(W, H);
      const b = createCanvas(W, H);
      const A = a.getContext('2d') as unknown as CanvasRenderingContext2D;
      const B = b.getContext('2d');
      for (const c of [A as unknown as SKRSContext2D, B]) {
        c.fillStyle = '#020408';
        c.fillRect(0, 0, W, H);
      }
      for (let frame = 0; frame < 120; frame++) {
        for (const c of [A as unknown as SKRSContext2D, B]) {
          c.fillStyle = 'rgba(0, 12, 24, 0.08)';
          c.fillRect(0, 0, W, H);
        }
        const t = frame * 0.05 * (1000 / 60) * 0.001;
        noise.prepare(t);
        sys.step({ flow: null, noise, t, originX: 0, mouseActive: false, mouseX: 0, mouseY: 0, mobile: false, panPx: 0, speedScale: 1 });
        sys.draw(A);
        drawPerParticle(sys, B);
      }
      const da = (A as unknown as SKRSContext2D).getImageData(0, 0, W, H).data;
      const db = B.getImageData(0, 0, W, H).data;
      let sum = 0;
      let max = 0;
      let over2 = 0;
      let over8 = 0;
      const px = W * H;
      for (let i = 0; i < da.length; i += 4) {
        let m = 0;
        for (let k = 0; k < 3; k++) {
          const d = Math.abs(da[i + k] - db[i + k]);
          sum += d;
          m = Math.max(m, d);
        }
        max = Math.max(max, m);
        if (m > 2) over2++;
        if (m > 8) over8++;
      }
      const mean = sum / (px * 3);
      console.log(
        `${W}x${H}: mean |diff| ${mean.toFixed(4)} /255, max ${max}, pixels differing by >2: ${((over2 / px) * 100).toFixed(4)}%, by >8: ${((over8 / px) * 100).toFixed(4)}%`,
      );
      expect(mean).toBeLessThan(0.05);
      expect(over8 / px).toBeLessThan(0.0005);
    });
  }
});
