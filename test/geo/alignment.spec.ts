import { describe, expect, it } from 'vitest';
import { Projection, type LonLat, type Point } from '../../src/app/geo/projection';
import { demSpec, loadDem, loadDemVerify, loadGfsVerify, loadLand, resampleDemToNodes } from './data';
import { agreement, correlation, domain, pointInLand, rasterizeLand } from './raster';

const rings = loadLand();
const dem = loadDem();
const spec = demSpec(dem);
const verify = loadDemVerify(dem);
const SHIFTS = [-3, -2, -1, 0, 1, 2, 3];

/** Sub-cell offset of a correlation/agreement peak from three samples (parabola vertex), in cells. */
const subCell = (m1: number, z: number, p1: number) => (0.5 * (m1 - p1)) / (m1 - 2 * z + p1);

/**
 * DOMAIN NOTES (measured, see the report):
 *  - The DEM comes from AWS terrain tiles. Over the Greenland and Antarctic ice sheets they carry sub-ice
 *    BEDROCK (Greenland interior ~170 m instead of ~2000 m, much of West Antarctica below 0 m), so polar
 *    cells cannot be compared with polygons/GFS orography. Antarctica is outside the rendered band anyway.
 *  - "elevation > 0" also fails for land below sea level (Caspian depression, Dead Sea shore).
 * So (a) is judged on the rendered band 75N..60S, with the global number reported next to it, and (c)
 * excludes Greenland and Antarctica.
 */
const inBand = (_lon: number, lat: number) => lat <= 75 && lat >= -60;
const noIceSheets = (lon: number, lat: number) => lat >= -60 && lat <= 83 && !(lon > -75 && lon < -10 && lat > 58);

describe('(a) coast vs terrain: Natural Earth polygons vs the DEM land mask', () => {
  const polygons = rasterizeLand(rings, spec);
  const band = domain(spec, inBand);

  it('agree on at least 98% of cells in the rendered band, and the best shift is exactly zero', () => {
    const global = agreement(polygons, verify.landMask, spec.nx, spec.ny, 0, 0);
    const base = agreement(polygons, verify.landMask, spec.nx, spec.ny, 0, 0, band);
    let landPoly = 0;
    let landDem = 0;
    let both = 0;
    for (let k = 0; k < polygons.length; k++) {
      if (!band[k]) continue;
      landPoly += polygons[k];
      landDem += verify.landMask[k];
      both += polygons[k] & verify.landMask[k];
    }
    console.log(
      `(a) DEM ${spec.nx}x${spec.ny} @0.2deg cell-centred. Agreement in the rendered band 75N..60S: ${(base * 100).toFixed(3)}%` +
        ` (land IoU ${((both / (landPoly + landDem - both)) * 100).toFixed(2)}%); global incl. polar ice sheets: ${(global * 100).toFixed(2)}%`,
    );
    expect(base).toBeGreaterThanOrEqual(0.98);
    expect(global).toBeGreaterThanOrEqual(0.95);

    const A = (dx: number, dy: number) => agreement(polygons, verify.landMask, spec.nx, spec.ny, dx, dy, band);
    const lonRow = SHIFTS.map((dx) => A(dx, 0));
    const latRow = SHIFTS.map((dy) => A(0, dy));
    console.log(`(a) agreement vs lon shift ${SHIFTS.join('/')} cells: ${lonRow.map((v) => (v * 100).toFixed(3)).join('  ')}`);
    console.log(`(a) agreement vs lat shift ${SHIFTS.join('/')} cells: ${latRow.map((v) => (v * 100).toFixed(3)).join('  ')}`);
    expect(SHIFTS[lonRow.indexOf(Math.max(...lonRow))]).toBe(0);
    expect(SHIFTS[latRow.indexOf(Math.max(...latRow))]).toBe(0);

    let best = { v: -1, dx: 9, dy: 9 };
    for (const dx of SHIFTS) {
      for (const dy of SHIFTS) {
        const v = A(dx, dy);
        if (v > best.v) best = { v, dx, dy };
      }
    }
    expect(best.dx).toBe(0);
    expect(best.dy).toBe(0);
    const sx = subCell(lonRow[2], lonRow[3], lonRow[4]);
    const sy = subCell(latRow[2], latRow[3], latRow[4]);
    console.log(`(a) sub-cell offset estimate: lon ${(sx * 0.2).toFixed(3)} deg, lat ${(sy * 0.2).toFixed(3)} deg`);
    expect(Math.abs(sx)).toBeLessThan(0.25);
    expect(Math.abs(sy)).toBeLessThan(0.25);
  });
});

describe('(b) peaks: DEM maximum near named summits, and where they project', () => {
  // [name, lon, lat, real elevation m, coastal/island note when the 1:50m polygon may legitimately miss it]
  const peaks: [string, number, number, number, string?][] = [
    ['Everest', 86.925, 27.988, 8849],
    ['K2', 76.514, 35.881, 8611],
    ['Kangchenjunga', 88.148, 27.703, 8586],
    ['Annapurna I', 83.82, 28.596, 8091],
    ['Aconcagua', -70.011, -32.653, 6961],
    ['Ojos del Salado', -68.541, -27.109, 6893],
    ['Chimborazo', -78.8175, -1.4692, 6263],
    ['Denali', -151.004, 63.069, 6190],
    ['Mount Logan', -140.405, 60.567, 5959],
    ['Kilimanjaro', 37.356, -3.067, 5895],
    ['Pico de Orizaba', -97.268, 19.03, 5636],
    ['Elbrus', 42.439, 43.353, 5642],
    ['Damavand', 52.11, 35.956, 5610],
    ['Mount Ararat', 44.298, 39.702, 5137],
    ['Mount Kenya', 37.308, -0.152, 5199],
    ['Margherita (Rwenzori)', 29.8725, 0.3813, 5109],
    ['Puncak Jaya', 137.158, -4.079, 4884],
    ['Mont Blanc', 6.865, 45.833, 4806],
    ['Ras Dashen', 38.367, 13.237, 4550],
    ['Matterhorn', 7.658, 45.976, 4478],
    ['Mount Whitney', -118.292, 36.579, 4421],
    ['Mount Elbert', -106.445, 39.118, 4401],
    ['Mauna Kea', -155.469, 19.821, 4207, 'island summit'],
    ['Toubkal', -7.916, 31.06, 4167],
    ['Mount Kinabalu', 116.558, 6.075, 4095],
    ['Mount Fuji', 138.727, 35.361, 3776],
    ['Mount Cook (Aoraki)', 170.142, -43.595, 3724],
    ['Teide', -16.642, 28.272, 3715, 'island summit'],
    ['Mulhacén', -3.311, 37.053, 3479],
    ['Thabana Ntlenyana', 29.2745, -29.4647, 3482],
    ['Etna', 14.995, 37.751, 3357, 'island summit'],
    ['Olympus', 22.358, 40.086, 2918],
    ['Anamudi (Western Ghats)', 77.06, 10.167, 2695],
    ['Galdhøpiggen', 8.312, 61.636, 2469],
    ['Mount Kosciuszko', 148.263, -36.456, 2228],
    ['Kebnekaise', 18.517, 67.903, 2097],
  ];
  const proj = new Projection({ width: 1920, height: 1080, centerLon: 30 });

  it('has at least 30 peaks', () => expect(peaks.length).toBeGreaterThanOrEqual(30));

  it('finds each summit within 0.35 deg, within a stated height tolerance, and inside land', () => {
    // terrarium z6 averages ~2.4 km pixels: sharp summits read low, never high.
    const MIN_RATIO = 0.7;
    const MAX_RATIO = 1.05;
    const rows: string[] = [];
    const px: Point = { x: 0, y: 0 };
    const back: LonLat = { lon: 0, lat: 0 };
    let worstLow = 1;
    for (const [name, lon, lat, real, note] of peaks) {
      let best = { h: -1, dLon: 0, dLat: 0 };
      for (let j = 0; j < dem.ny; j++) {
        const la = dem.lat0 - dem.dlat * j;
        if (Math.abs(la - lat) > 0.3) continue;
        for (let i = 0; i < dem.nx; i++) {
          const lo = dem.lon0 + dem.dlon * i;
          if (Math.abs(lo - lon) > 0.3) continue;
          const h = verify.max[j * dem.nx + i];
          if (h > best.h) best = { h, dLon: lo - lon, dLat: la - lat };
        }
      }
      const ratio = best.h / real;
      worstLow = Math.min(worstLow, ratio);
      // projected pixel -> back to lon/lat -> inside the land polygon?
      proj.project(lon, lat, px);
      px.x = Math.round(px.x - 0.5) + 0.5;
      px.y = Math.round(px.y - 0.5) + 0.5;
      proj.unproject(px.x, px.y, back);
      const inLand = pointInLand(rings, back.lon, back.lat);
      rows.push(
        `${name.padEnd(24)} real ${String(real).padStart(5)} m  DEM max ${String(best.h).padStart(5)} m  (${((ratio - 1) * 100).toFixed(1).padStart(6)}%)  ` +
          `at ${best.dLon >= 0 ? '+' : ''}${best.dLon.toFixed(2)},${best.dLat >= 0 ? '+' : ''}${best.dLat.toFixed(2)} deg  pixel ${px.x.toFixed(1)},${px.y.toFixed(1)}  ${inLand ? 'inside land' : 'OUTSIDE land'}${note ? ` [${note}]` : ''}`,
      );
      expect(ratio, `${name} height ratio`).toBeGreaterThanOrEqual(MIN_RATIO);
      expect(ratio, `${name} height ratio`).toBeLessThanOrEqual(MAX_RATIO);
      expect(Math.hypot(best.dLon, best.dLat), `${name} summit offset`).toBeLessThanOrEqual(0.35);
      if (!note) expect(inLand, `${name} pixel inside land`).toBe(true);
    }
    console.log(`(b) ${peaks.length} peaks; tolerance ${MIN_RATIO}..${MAX_RATIO} of real height; worst under-read ${((1 - worstLow) * 100).toFixed(1)}%\n${rows.join('\n')}`);
  });
});

describe('(c) the wind grid, the terrain and the coastline line up end to end', () => {
  for (const res of ['1p00', '0p50'] as const) {
    const gfs = loadGfsVerify(res);
    const g = gfs.grid;
    const use = domain(g, noIceSheets);

    it(`GFS ${res}: orography correlates best with the resampled DEM at zero shift`, () => {
      const demOnGfs = resampleDemToNodes(dem, g);
      const grid = (dx: number, dy: number) => correlation(demOnGfs, gfs.hgt, g.nx, g.ny, dx, dy, use);
      const rAll = correlation(demOnGfs, gfs.hgt, g.nx, g.ny, 0, 0);
      const r00 = grid(0, 0);
      const lonRow = SHIFTS.map((dx) => grid(dx, 0));
      const latRow = SHIFTS.map((dy) => grid(0, dy));
      let best = { v: -2, dx: 9, dy: 9 };
      for (const dx of SHIFTS) for (const dy of SHIFTS) {
        const v = grid(dx, dy);
        if (v > best.v) best = { v, dx, dy };
      }
      const sx = subCell(lonRow[2], lonRow[3], lonRow[4]) * Math.abs(g.dlon);
      const sy = subCell(latRow[2], latRow[3], latRow[4]) * Math.abs(g.dlat);
      console.log(
        `(c) GFS ${res} HGT vs DEM (no ice sheets): r(0,0) = ${r00.toFixed(4)} [all nodes incl. ice sheets: ${rAll.toFixed(3)}]; best shift (${best.dx},${best.dy}) cells; ` +
          `r vs lon shift ${lonRow.map((v) => v.toFixed(3)).join(' ')}; vs lat shift ${latRow.map((v) => v.toFixed(3)).join(' ')}; ` +
          `sub-cell offset lon ${sx.toFixed(3)} deg, lat ${sy.toFixed(3)} deg`,
      );
      expect(best.dx).toBe(0);
      expect(best.dy).toBe(0);
      expect(r00).toBeGreaterThan(0.9);
      expect(Math.abs(sx)).toBeLessThan(0.25 * Math.abs(g.dlon));
      expect(Math.abs(sy)).toBeLessThan(0.25 * Math.abs(g.dlat));
    });

    it(`GFS ${res}: land-sea mask vs Natural Earth polygons, best shift is zero`, () => {
      const polys = rasterizeLand(rings, g);
      const base = agreement(polys, gfs.land, g.nx, g.ny, 0, 0);
      const lonRow = SHIFTS.map((dx) => agreement(polys, gfs.land, g.nx, g.ny, dx, 0));
      const latRow = SHIFTS.map((dy) => agreement(polys, gfs.land, g.nx, g.ny, 0, dy));
      console.log(
        `(c) GFS ${res} LAND vs polygons: agreement ${(base * 100).toFixed(2)}%; vs lon shift ${lonRow.map((v) => (v * 100).toFixed(2)).join(' ')}; vs lat shift ${latRow.map((v) => (v * 100).toFixed(2)).join(' ')}`,
      );
      expect(SHIFTS[lonRow.indexOf(Math.max(...lonRow))]).toBe(0);
      expect(SHIFTS[latRow.indexOf(Math.max(...latRow))]).toBe(0);
      expect(base).toBeGreaterThan(0.93);
    });
  }
});
