import { beforeAll, describe, expect, it } from 'vitest';
import { FlowField } from '../../src/app/geo/flow-bake';
import { Projection } from '../../src/app/geo/projection';
import { Terrain, decodeElevation } from '../../src/app/geo/terrain';
import { WindSampler, decodeWind } from '../../src/app/geo/wind';
import { noYield, readArrayBuffer } from './helpers';

const W = 1920;
const H = 1080;
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)];

let sampler: WindSampler;
let terrain: Terrain;

beforeAll(async () => {
  sampler = new WindSampler(decodeWind(readArrayBuffer('test/fixtures/wind-calibration.bin')));
  terrain = await Terrain.build(decodeElevation(readArrayBuffer('public/data/elevation.bin')), noYield);
});

function newSpeeds(): number[] {
  const proj = new Projection({ width: W, height: H, centerLon: 30 });
  const flow = new FlowField(proj);
  flow.bakeAll(sampler, terrain);
  const out: number[] = [];
  for (let y = 4; y < H; y += 8) {
    for (let x = 4; x < W; x += 8) {
      flow.sample(x + proj.originX, y);
      out.push(Math.hypot(flow.sx, flow.sy) * 1.5);
    }
  }
  return out;
}

describe('flow scale (see the calibration note on FLOW_PX_PER_MS)', () => {
  // Wind-only (no turbulence) speed of the baked field at 1080p over the pinned 2026-10-18T12Z snapshot,
  // x1.5 as in the particle loop. Recorded when K was calibrated to 0.085; guards against unit mistakes.
  const RECORDED_MEDIAN = 0.31 * (0.085 / 0.0347);

  it('keeps the median wind-only speed at the recorded value (+-10%)', () => {
    const n = newSpeeds();
    const m = median(n);
    console.log(`median wind-only px/frame x1.5: ${m.toFixed(3)} (recorded ${RECORDED_MEDIAN.toFixed(3)})`);
    expect(Math.abs(m / RECORDED_MEDIAN - 1)).toBeLessThan(0.1);
  });

  it('keeps jet streams visibly faster than the doldrums', () => {
    const n = newSpeeds();
    console.log(`p10 ${pct(n, 0.1).toFixed(3)}  p50 ${median(n).toFixed(3)}  p90 ${pct(n, 0.9).toFixed(3)}  p99 ${pct(n, 0.99).toFixed(3)}  max ${Math.max(...n).toFixed(2)}`);
    expect(pct(n, 0.95) / pct(n, 0.1)).toBeGreaterThan(3);
  });
});
