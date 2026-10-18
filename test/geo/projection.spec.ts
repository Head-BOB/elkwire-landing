import { describe, expect, it } from 'vitest';
import { Projection, lonStretch, wrapLon, type LonLat, type Point } from '../../src/app/geo/projection';

const SIZES = [
  [1920, 1080],
  [1366, 768],
  [390, 844],
  [3440, 1440],
  [5000, 1000],
] as const;

describe('projection', () => {
  it('uses one uniform scale in x and y (never stretched to the viewport)', () => {
    for (const [w, h] of SIZES) {
      const p = new Projection({ width: w, height: h, centerLon: 30 });
      const a: Point = { x: 0, y: 0 };
      const b: Point = { x: 0, y: 0 };
      p.project(10, 10, a);
      p.project(11, 9, b);
      expect(b.x - a.x).toBeCloseTo(p.scale, 9); // +1 deg lon
      expect(b.y - a.y).toBeCloseTo(p.scale, 9); // -1 deg lat is +scale px downwards
    }
  });

  it('round-trips project/unproject, including across the antimeridian', () => {
    const out: Point = { x: 0, y: 0 };
    const back: LonLat = { lon: 0, lat: 0 };
    for (const [w, h] of SIZES) {
      const p = new Projection({ width: w, height: h, centerLon: 30 });
      for (let lon = -180; lon < 180; lon += 7.3) {
        for (let lat = -58; lat <= 74; lat += 6.1) {
          p.project(lon, lat, out);
          p.unproject(out.x, out.y, back);
          expect(back.lat).toBeCloseTo(lat, 9);
          expect(wrapLon(back.lon - lon)).toBeCloseTo(0, 9);
        }
      }
    }
  });

  it('wraps in longitude', () => {
    const p = new Projection({ width: 1920, height: 1080, centerLon: 30 });
    const a: Point = { x: 0, y: 0 };
    const b: Point = { x: 0, y: 0 };
    p.project(-170, 20, a);
    p.project(190, 20, b);
    expect(a.x).toBeCloseTo(b.x, 9);
    expect(wrapLon(540)).toBe(-180);
    expect(wrapLon(-181)).toBe(179);
  });

  it('places the centre longitude at the horizontal centre and fits the band to the height', () => {
    const p = new Projection({ width: 1920, height: 1080, centerLon: 30 });
    const out: Point = { x: 0, y: 0 };
    p.project(30, 0, out);
    expect(out.x).toBeCloseTo(960, 9);
    expect(p.scale).toBeCloseTo(1080 / 135, 9);
    expect(p.screenY(75)).toBeCloseTo(0, 9);
    expect(p.screenY(-60)).toBeCloseTo(1080, 9);
    const ll: LonLat = { lon: 0, lat: 0 };
    p.unproject(0, 0, ll);
    expect(ll.lon).toBeCloseTo(30 - 960 / p.scale, 9); // ~ -90: Andes..Atlas..Himalaya framing
  });

  it('cover-fits: one world revolution always fills the width, no empty edge', () => {
    for (const [w, h] of SIZES) {
      const p = new Projection({ width: w, height: h, centerLon: 0 });
      expect(p.worldWidth).toBeGreaterThanOrEqual(w - 1e-9);
      const top: LonLat = { lon: 0, lat: 0 };
      const bottom: LonLat = { lon: 0, lat: 0 };
      p.unproject(0, 0, top);
      p.unproject(0, h, bottom);
      expect(top.lat).toBeLessThanOrEqual(90);
      expect(bottom.lat).toBeGreaterThanOrEqual(-90);
      // Never shows less than the world fits: when width governs the band is cropped, never padded.
      expect(top.lat - bottom.lat).toBeLessThanOrEqual(135 + 1e-9);
    }
  });

  it('pan advances the view east by exactly the requested pixels and wraps', () => {
    const p = new Projection({ width: 390, height: 844, centerLon: 0 });
    const x0 = p.originX;
    p.panBy(10);
    expect(p.originX).toBeCloseTo(x0 + 10, 9);
    p.panBy(p.worldWidth);
    expect(p.originX).toBeCloseTo(x0 + 10, 6);
    const out: Point = { x: 0, y: 0 };
    p.project(p.centerLon, 0, out);
    expect(out.x).toBeCloseTo(195, 6);
  });

  it('stretches eastward velocity by 1/cos(lat), clamped near the poles', () => {
    expect(lonStretch(0)).toBeCloseTo(1, 12);
    expect(lonStretch(60)).toBeCloseTo(2, 9);
    expect(lonStretch(-60)).toBeCloseTo(2, 9);
    expect(lonStretch(89)).toBeCloseTo(lonStretch(75), 12);
  });
});
