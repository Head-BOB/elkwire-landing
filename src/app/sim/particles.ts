import type { FlowField } from '../geo/flow-bake';
import type { CurlNoise } from './noise';

/** Particle colours (unchanged from the original look). */
export const PARTICLE_COLORS = [
  'rgba(10, 45, 75, 0.6)', // Deep oceanic blue
  'rgba(30, 90, 120, 0.7)', // Bathypelagic teal
  'rgba(60, 150, 190, 0.5)', // Hydrodynamic cyan
  'rgba(140, 200, 230, 0.3)', // Wake foam
];

/** Particle widths are 0.5 .. 2.0 px; strokes are batched by width quantised to 1/16 px (<= 0.03 px off). */
const WIDTH_STEPS_PER_PX = 16;
const WIDTH_MIN_STEP = 8;
const WIDTH_BUCKETS = 25; // steps 8 .. 32
const BUCKETS = PARTICLE_COLORS.length * WIDTH_BUCKETS;

export interface StepEnv {
  flow: FlowField | null;
  noise: CurlNoise;
  /** Noise time (performance.now() * 0.00005). */
  t: number;
  /** World x of the viewport's left edge (the baked flow lives in world pixels). */
  originX: number;
  mouseActive: boolean;
  mouseX: number;
  mouseY: number;
  mobile: boolean;
  /** Mobile pan, in screen px per frame (particles stay locked to the panning world). */
  panPx: number;
  /** 1 normally; below 1 only for prefers-reduced-motion. */
  speedScale: number;
}

/**
 * Struct-of-arrays particle state. Behaviour, constants and the ORDER of random draws match the original
 * per-object implementation exactly; only the storage and the drawing are different.
 */
export class ParticleSystem {
  readonly capacity: number;
  /** Particles currently simulated and drawn (adaptive quality can lower it; normally === capacity). */
  active: number;
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly lastX: Float32Array;
  private readonly lastY: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size: Float32Array;
  private readonly color: Uint8Array;
  private readonly drawn: Uint8Array;
  private readonly bucket: Int16Array;
  private readonly counts = new Uint32Array(BUCKETS);
  private readonly starts = new Uint32Array(BUCKETS);
  private readonly cursor = new Uint32Array(BUCKETS);
  private readonly segs: Float32Array;

  constructor(
    capacity: number,
    private width: number,
    private height: number,
    private rand: () => number,
  ) {
    this.capacity = capacity;
    this.active = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.lastX = new Float32Array(capacity);
    this.lastY = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.color = new Uint8Array(capacity);
    this.drawn = new Uint8Array(capacity);
    this.bucket = new Int16Array(capacity);
    this.segs = new Float32Array(capacity * 4);
    for (let i = 0; i < capacity; i++) {
      this.reset(i);
      this.life[i] = this.rand() * this.maxLife[i];
    }
  }

  /** Same draws, same order as the original resetParticle. */
  private reset(i: number): void {
    const r = this.rand;
    this.x[i] = r() * this.width;
    this.y[i] = r() * this.height;
    this.lastX[i] = this.x[i];
    this.lastY[i] = this.y[i];
    this.vx[i] = 0;
    this.vy[i] = 0;
    this.maxLife[i] = r() * 350 + 250;
    this.life[i] = this.maxLife[i];
    this.color[i] = Math.floor(r() * PARTICLE_COLORS.length);
    this.size[i] = r() * 1.5 + 0.5;
  }

  /** Change how many particles run (adaptive quality only). Re-enabled particles start fresh. */
  setActive(n: number): void {
    const next = Math.max(0, Math.min(this.capacity, n));
    for (let i = this.active; i < next; i++) {
      this.reset(i);
      this.life[i] = this.rand() * this.maxLife[i];
    }
    this.active = next;
  }

  step(env: StepEnv): void {
    const { flow, noise, t, originX, mouseActive, mouseX, mouseY, mobile, panPx, speedScale } = env;
    const width = this.width;
    const height = this.height;
    const { x, y, lastX, lastY, vx, vy, life, drawn } = this;
    const influence = 300;
    for (let i = 0; i < this.active; i++) {
      let px = x[i];
      let py = y[i];

      // Fluid velocity: baked real wind + terrain, plus the unchanged curl turbulence.
      noise.curl(px, py, t);
      let u = 0;
      let v = 0;
      if (flow) {
        flow.sample(px + originX, py);
        u = flow.sx;
        v = flow.sy;
      }
      const windMag = Math.sqrt(u * u + v * v);
      const turbulenceScale = Math.max(0.6, windMag * 0.35);
      let targetVx = (u + noise.dPsiDy * turbulenceScale) * 1.5 * speedScale;
      let targetVy = (v + -noise.dPsiDx * turbulenceScale) * 1.5 * speedScale;

      // Mouse interaction (desktop only): push + swirl, radius 300.
      if (mouseActive) {
        const dx = px - mouseX;
        const dy = py - mouseY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < influence) {
          const force = Math.pow((influence - dist) / influence, 2);
          targetVx += (dx / dist) * force * 5;
          targetVy += (dy / dist) * force * 5;
          targetVx += -(dy / dist) * force * 3;
          targetVy += (dx / dist) * force * 3;
        }
      }

      const pvx = vx[i] + (targetVx - vx[i]) * 0.08;
      const pvy = vy[i] + (targetVy - vy[i]) * 0.08;
      vx[i] = pvx;
      vy[i] = pvy;
      let lx = px;
      const ly = py;
      px += pvx;
      py += pvy;
      life[i]--;

      // Mobile: shift particle screen coordinates to stay locked to the panning world.
      if (mobile) {
        px -= panPx;
        lx -= panPx;
        // wrap particles at horizontal edges for infinite scroll
        if (px < -20) {
          px += width + 40;
          lx = px;
        } else if (px > width + 20) {
          px -= width + 40;
          lx = px;
        }
      }

      if (life[i] <= 0 || px < -50 || px > width + 50 || py < -50 || py > height + 50 || isNaN(px) || isNaN(py)) {
        this.reset(i);
        drawn[i] = 0;
      } else {
        x[i] = px;
        y[i] = py;
        lastX[i] = lx;
        lastY[i] = ly;
        drawn[i] = 1;
      }
    }
  }

  /** Stroke every live segment: one path and one stroke() per colour x width bucket. */
  draw(ctx: CanvasRenderingContext2D): void {
    const { counts, starts, cursor, segs, bucket, drawn, color, size } = this;
    counts.fill(0);
    for (let i = 0; i < this.active; i++) {
      if (!drawn[i]) {
        bucket[i] = -1;
        continue;
      }
      const step = Math.round(size[i] * WIDTH_STEPS_PER_PX) - WIDTH_MIN_STEP;
      const b = color[i] * WIDTH_BUCKETS + (step < 0 ? 0 : step >= WIDTH_BUCKETS ? WIDTH_BUCKETS - 1 : step);
      bucket[i] = b;
      counts[b]++;
    }
    let offset = 0;
    for (let b = 0; b < BUCKETS; b++) {
      starts[b] = offset;
      cursor[b] = offset;
      offset += counts[b];
    }
    for (let i = 0; i < this.active; i++) {
      const b = bucket[i];
      if (b < 0) continue;
      const k = cursor[b]++ * 4;
      segs[k] = this.lastX[i];
      segs[k + 1] = this.lastY[i];
      segs[k + 2] = this.x[i];
      segs[k + 3] = this.y[i];
    }
    for (let b = 0; b < BUCKETS; b++) {
      const n = counts[b];
      if (n === 0) continue;
      ctx.strokeStyle = PARTICLE_COLORS[(b / WIDTH_BUCKETS) | 0];
      ctx.lineWidth = (WIDTH_MIN_STEP + (b % WIDTH_BUCKETS)) / WIDTH_STEPS_PER_PX;
      ctx.beginPath();
      for (let k = starts[b] * 4, end = k + n * 4; k < end; k += 4) {
        ctx.moveTo(segs[k], segs[k + 1]);
        ctx.lineTo(segs[k + 2], segs[k + 3]);
      }
      ctx.stroke();
    }
  }

  /** Live segments of the last step with their original (unquantised) width; used by the draw-equivalence test. */
  forEachLive(cb: (lastX: number, lastY: number, x: number, y: number, size: number, color: number) => void): void {
    for (let i = 0; i < this.active; i++) {
      if (this.drawn[i]) cb(this.lastX[i], this.lastY[i], this.x[i], this.y[i], this.size[i], this.color[i]);
    }
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }
}
