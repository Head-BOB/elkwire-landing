import { beforeAll, describe, expect, it } from 'vitest';
import { Terrain, decodeElevation, deflectWind, K_BLOCK, type Wind2 } from '../../src/app/geo/terrain';
import { noYield, readArrayBuffer } from './helpers';

let terrain: Terrain;
const s = { bw: 0, nE: 0, nN: 0 };

beforeAll(async () => {
  terrain = await Terrain.build(decodeElevation(readArrayBuffer('public/data/elevation.bin.gz')), noYield);
});

/** Strongest barrier weight within `r` degrees of a point. */
function maxBw(lon: number, lat: number, r = 3): number {
  let m = 0;
  for (let dl = -r; dl <= r; dl += 0.2) {
    for (let da = -r; da <= r; da += 0.2) {
      terrain.sample(lon + dl, lat + da, s);
      m = Math.max(m, s.bw);
    }
  }
  return m;
}

describe('terrain barriers land in the right places', () => {
  // [name, lon, lat, minimum barrier weight within 3 deg]
  const ranges: [string, number, number, number][] = [
    ['Himalaya', 86.9, 28, 0.95],
    ['Karakoram', 76.5, 35.8, 0.95],
    ['Andes (Aconcagua)', -70, -32.6, 0.95],
    ['Andes (Peru)', -73, -13, 0.95],
    ['Rocky Mountains', -106, 39, 0.9],
    ['Alps', 9, 46.5, 0.8],
    ['Atlas', -7, 31, 0.8],
    ['Western Ghats (south)', 76.8, 10.5, 0.4],
    ['Great Dividing Range (south)', 148.3, -36.4, 0.4],
    ['Scandinavian Mountains', 8, 62, 0.4],
    ['Ethiopian Highlands', 39, 10, 0.9],
    ['Drakensberg', 29, -29, 0.8],
  ];
  for (const [name, lon, lat, min] of ranges) {
    it(`${name}: barrier weight >= ${min}`, () => {
      const v = maxBw(lon, lat);
      console.log(`${name.padEnd(30)} max barrier weight ${v.toFixed(2)}`);
      expect(v).toBeGreaterThanOrEqual(min);
    });
  }

  it('is ~0 over lowlands and ocean (the page looks unchanged away from mountains)', () => {
    for (const [lon, lat] of [
      [-60, -3], // Amazon
      [22, 0], // Congo
      [-100, 40], // Great Plains
      [75, 62], // West Siberian plain
      [-30, 40], // North Atlantic
      [70, -20], // Indian Ocean
    ]) {
      terrain.sample(lon, lat, s);
      expect(s.bw).toBeLessThan(0.1);
    }
    let strong = 0;
    for (const v of terrain.bw) if (v > 25) strong++;
    const share = strong / terrain.bw.length;
    console.log(`cells with barrier weight > 0.1: ${(share * 100).toFixed(2)}%`);
    expect(share).toBeLessThan(0.1);
  });

  it('points uphill, and flips across the crest', () => {
    const uphill = (lon: number, lat: number) => {
      terrain.sample(lon, lat, s);
      return { ...s };
    };
    expect(uphill(88, 27.2).nN).toBeGreaterThan(0.9); // Himalayan south front rises to the north
    expect(uphill(86, 36.8).nN).toBeLessThan(-0.8); // Kunlun north rim rises to the south
    expect(uphill(-71.4, -33).nE).toBeGreaterThan(0.9); // Andes: Chilean side rises east...
    expect(uphill(-69.2, -33).nE).toBeLessThan(-0.9); // ...Argentine side rises west
    expect(uphill(-105.2, 40).nE).toBeLessThan(-0.9); // Rockies east front rises west
    expect(uphill(8, 47.4).nN).toBeLessThan(-0.8); // Alps north flank rises south
    expect(uphill(8.5, 45.6).nN).toBeGreaterThan(0.7); // Alps south flank rises north
    expect(uphill(76.4, 10.8).nE).toBeGreaterThan(0.6); // Western Ghats west flank rises inland (east)
  });

  it('wraps in longitude and clamps at the poles when sampling', () => {
    terrain.sample(179.95, 40, s);
    const a = s.bw;
    terrain.sample(-180.05, 40, s);
    expect(s.bw).toBeCloseTo(a, 6);
    expect(() => terrain.sample(10, 95, s)).not.toThrow();
    expect(() => terrain.sample(10, -95, s)).not.toThrow();
  });
});

describe('deflectWind', () => {
  const into = (w: Wind2, nE: number, nN: number) => w.u * nE + w.v * nN;

  it('removes the component into rising terrain', () => {
    const w: Wind2 = { u: 6, v: 0 }; // westerly
    deflectWind(1, 1, 0, w); // slope rises to the east: head-on
    expect(w.u).toBeLessThan(6 * 0.15);
    expect(into(w, 1, 0)).toBeGreaterThanOrEqual(0);
  });

  it('leaves leeward (downslope) flow alone and preserves flow along the ridge', () => {
    const lee: Wind2 = { u: -6, v: 0 };
    deflectWind(1, 1, 0, lee);
    expect(lee.u).toBe(-6);
    const along: Wind2 = { u: 0, v: 8 }; // ridge runs north-south
    deflectWind(1, 1, 0, along);
    expect(along.v).toBeGreaterThanOrEqual(8); // channeling can only speed it up
    expect(Math.abs(along.u)).toBeLessThan(1e-9);
  });

  it('slides oblique flow along the ridge', () => {
    const w: Wind2 = { u: 5, v: 5 }; // toward the NE, slope rises east
    deflectWind(1, 1, 0, w);
    expect(w.v).toBeGreaterThan(5 * 0.99);
    expect(w.u).toBeLessThan(5 * (1 - K_BLOCK) + 0.5);
  });

  it('does nothing without a barrier', () => {
    const w: Wind2 = { u: 3, v: -2 };
    deflectWind(0, 1, 0, w);
    expect(w).toEqual({ u: 3, v: -2 });
  });

  it('scales with barrier weight', () => {
    const half: Wind2 = { u: 6, v: 0 };
    const full: Wind2 = { u: 6, v: 0 };
    deflectWind(0.5, 1, 0, half);
    deflectWind(1, 1, 0, full);
    expect(half.u).toBeGreaterThan(full.u);
    expect(half.u).toBeLessThan(6);
  });
});
