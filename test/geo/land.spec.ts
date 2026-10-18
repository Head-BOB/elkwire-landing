import { describe, expect, it } from 'vitest';
import { decodeLand } from '../../src/app/geo/land';
import { readArrayBuffer } from './helpers';

const rings = decodeLand(readArrayBuffer('public/data/land.bin.gz'));

describe('land.bin (Natural Earth 1:50m)', () => {
  it('decodes rings with sane coordinates', () => {
    expect(rings.length).toBeGreaterThan(1000);
    for (const r of rings) {
      expect(r.length / 2).toBeGreaterThanOrEqual(3);
      for (let i = 0; i < r.length; i += 2) {
        // Continuous (unwrapped) longitude: rings may spill past +-180 by a few degrees (Chukotka -190.02).
        expect(r[i]).toBeGreaterThanOrEqual(-210);
        expect(r[i]).toBeLessThanOrEqual(210);
        expect(r[i + 1]).toBeGreaterThanOrEqual(-90);
        expect(r[i + 1]).toBeLessThanOrEqual(90);
      }
    }
  });

  it('has no segment spanning more than 180 degrees (the old horizontal seams)', () => {
    let max = 0;
    for (const r of rings) {
      for (let i = 2; i < r.length; i += 2) max = Math.max(max, Math.abs(r[i] - r[i - 2]));
    }
    console.log(`max land segment: ${max.toFixed(3)} deg`);
    expect(max).toBeLessThanOrEqual(180);
  });

  it('closes Antarctica along the pole edge', () => {
    const polar = rings.filter((r) => {
      let minLat = 90;
      for (let i = 1; i < r.length; i += 2) minLat = Math.min(minLat, r[i]);
      return minLat === -90;
    });
    expect(polar).toHaveLength(1);
    const r = polar[0];
    let minLon = Infinity;
    let maxLon = -Infinity;
    for (let i = 0; i < r.length; i += 2) {
      minLon = Math.min(minLon, r[i]);
      maxLon = Math.max(maxLon, r[i]);
    }
    expect(maxLon - minLon).toBeGreaterThanOrEqual(359.9);
    // the last vertices run along lat -90 back to the start longitude
    expect(r[r.length - 1]).toBe(-90);
    expect(r[r.length - 3]).toBe(-90);
  });

  it('keeps the Afro-Eurasia ring continuous across the antimeridian (Chukotka)', () => {
    const big = rings.reduce((a, b) => (b.length > a.length ? b : a));
    let minLon = Infinity;
    let maxLon = -Infinity;
    for (let i = 0; i < big.length; i += 2) {
      minLon = Math.min(minLon, big[i]);
      maxLon = Math.max(maxLon, big[i]);
    }
    // Unwrapped: it continues past an edge instead of jumping 360 deg to the other side.
    expect(minLon < -180 || maxLon > 180).toBe(true);
  });
});
