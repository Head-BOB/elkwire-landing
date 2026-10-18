import { describe, expect, it } from 'vitest';
import { WindSampler, decodeWind } from '../../src/app/geo/wind';
import { readArrayBuffer } from './helpers';

const WIND_FILE = process.env['WIND_FILE'] ?? 'public/data/wind.bin';
const field = decodeWind(readArrayBuffer(WIND_FILE));
const sampler = new WindSampler(field);
const o = { u: 0, v: 0 };

describe(`wind.bin (${WIND_FILE})`, () => {
  it('has the documented GFS node grid, normalised to lon -180.., lat 90..-90', () => {
    expect(field.lon0).toBe(-180);
    expect(field.lat0).toBe(90);
    expect(field.dlat).toBeLessThan(0);
    expect(field.nx * Math.abs(field.dlon)).toBeCloseTo(360, 6); // the 360 column is NOT repeated
    expect((field.ny - 1) * Math.abs(field.dlat)).toBeCloseTo(180, 6); // poles are nodes
    expect(field.validTimes.length).toBeGreaterThanOrEqual(4);
    expect(field.validTimes[0]).toBe(field.refTime);
    for (let k = 1; k < field.validTimes.length; k++) expect(field.validTimes[k] - field.validTimes[k - 1]).toBe(3 * 3600);
    console.log(
      `reference ${new Date(field.refTime * 1000).toISOString()}, ${field.validTimes.length} frames, ${field.nx}x${field.ny} nodes`,
    );
  });

  it('returns the exact node value at a node (node-centred, no half-cell offset)', () => {
    for (const [i, j] of [[0, 0], [10, 20], [180, 90], [359, 180], [270, 45]]) {
      sampler.setTime(field.validTimes[0]);
      sampler.sample(field.lon0 + field.dlon * i, field.lat0 + field.dlat * j, o);
      expect(o.u).toBeCloseTo(field.u[0][j * field.nx + i], 5);
      expect(o.v).toBeCloseTo(field.v[0][j * field.nx + i], 5);
    }
  });

  it('wraps between the last and the first column', () => {
    sampler.setTime(field.validTimes[0]);
    const j = 60;
    sampler.sample(179.5, field.lat0 + field.dlat * j, o);
    const last = field.u[0][j * field.nx + field.nx - 1];
    const first = field.u[0][j * field.nx];
    expect(o.u).toBeCloseTo((last + first) / 2, 5);
    const a = { u: 0, v: 0 };
    sampler.sample(-180.3, 10, a);
    sampler.sample(179.7, 10, o);
    expect(a.u).toBeCloseTo(o.u, 6);
  });

  it('clamps at the poles', () => {
    sampler.sample(30, 90, o);
    const at90 = { ...o };
    sampler.sample(30, 95, o);
    expect(o).toEqual(at90);
    sampler.sample(30, -100, o);
    expect(Number.isFinite(o.u) && Number.isFinite(o.v)).toBe(true);
  });

  it('interpolates linearly in time and holds the end frames (never extrapolates)', () => {
    const [t0, t1] = field.validTimes;
    sampler.setTime((t0 + t1) / 2);
    sampler.sample(10, 20, o);
    const mid = { ...o };
    sampler.setTime(t0);
    sampler.sample(10, 20, o);
    const a = { ...o };
    sampler.setTime(t1);
    sampler.sample(10, 20, o);
    expect(mid.u).toBeCloseTo((a.u + o.u) / 2, 4);
    sampler.setTime(t0 - 86400);
    sampler.sample(10, 20, o);
    expect(o.u).toBeCloseTo(a.u, 6);
    sampler.setTime(field.validTimes[field.validTimes.length - 1] + 86400);
    const held = { ...(sampler.sample(10, 20, o), o) };
    sampler.setTime(field.validTimes[field.validTimes.length - 1]);
    sampler.sample(10, 20, o);
    expect(held.u).toBeCloseTo(o.u, 6);
  });

  it('(d) real flow: trade winds are easterly at 15N, westerlies blow at 45N', () => {
    for (let k = 0; k < field.validTimes.length; k++) {
      const zonal = (lat: number) => {
        const j = Math.round((lat - field.lat0) / field.dlat);
        let s = 0;
        for (let i = 0; i < field.nx; i++) s += field.u[k][j * field.nx + i];
        return s / field.nx;
      };
      const z15 = zonal(15);
      const z45 = zonal(45);
      console.log(`frame ${k}: zonal-mean u at 15N = ${z15.toFixed(2)} m/s, at 45N = ${z45.toFixed(2)} m/s`);
      expect(z15).toBeLessThan(0);
      expect(z45).toBeGreaterThan(0);
    }
  });

  it('has plausible 10 m wind speeds', () => {
    let max = 0;
    let sum = 0;
    const n = field.nx * field.ny;
    for (let i = 0; i < n; i++) {
      const s = Math.hypot(field.u[0][i], field.v[0][i]);
      max = Math.max(max, s);
      sum += s;
    }
    console.log(`mean speed ${(sum / n).toFixed(2)} m/s, max ${max.toFixed(1)} m/s`);
    expect(sum / n).toBeGreaterThan(2);
    expect(sum / n).toBeLessThan(10);
    expect(max).toBeLessThan(80);
  });
});
