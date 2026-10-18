import type { LandRings } from '../../src/app/geo/land';
import { wrapLon } from '../../src/app/geo/projection';

/** A uniform lon/lat sampling grid. Points sit at lon0 + dlon*i and lat0 + dlat*j (dlat < 0: north first). */
export interface GridSpec {
  nx: number;
  ny: number;
  lon0: number;
  lat0: number;
  dlon: number;
  dlat: number;
}

/**
 * Scanline point-in-polygon of the Natural Earth rings at every grid point (even-odd across all rings, so
 * holes work; ring copies at +-360 handle the antimeridian). 1 = land.
 */
export function rasterizeLand(rings: LandRings, g: GridSpec): Uint8Array {
  const step = Math.abs(g.dlat);
  const rows: number[][] = Array.from({ length: g.ny }, () => []);
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const x1 = ring[i * 2];
      const y1 = ring[i * 2 + 1];
      const x2 = ring[((i + 1) % n) * 2];
      const y2 = ring[((i + 1) % n) * 2 + 1];
      if (y1 === y2) continue;
      const yMin = Math.min(y1, y2);
      const yMax = Math.max(y1, y2);
      // rows with yMin <= lat_j < yMax, lat_j = lat0 - step * j
      const j0 = Math.max(0, Math.floor((g.lat0 - yMax) / step) + 1);
      const j1 = Math.min(g.ny - 1, Math.floor((g.lat0 - yMin) / step));
      for (let j = j0; j <= j1; j++) {
        const lat = g.lat0 - step * j;
        const x = x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1);
        rows[j].push(x - 360, x, x + 360);
      }
    }
  }
  const out = new Uint8Array(g.nx * g.ny);
  const lonEnd = g.lon0 + g.dlon * g.nx;
  for (let j = 0; j < g.ny; j++) {
    const xs = rows[j].sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(xs[k], g.lon0);
      const b = Math.min(xs[k + 1], lonEnd);
      if (b <= a) continue;
      const i0 = Math.ceil((a - g.lon0) / g.dlon - 1e-9);
      const i1 = Math.ceil((b - g.lon0) / g.dlon - 1e-9) - 1;
      for (let i = Math.max(0, i0); i <= Math.min(g.nx - 1, i1); i++) out[j * g.nx + i] = 1;
    }
  }
  return out;
}

/** Point-in-land by even-odd ray casting against every ring (and its +-360 copies). */
export function pointInLand(rings: LandRings, lon: number, lat: number): boolean {
  let inside = false;
  const x0 = wrapLon(lon);
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let k = -1; k <= 1; k++) {
      const x = x0 + 360 * k;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = ring[i * 2];
        const yi = ring[i * 2 + 1];
        const xj = ring[j * 2];
        const yj = ring[j * 2 + 1];
        if (yi > lat !== yj > lat && x < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
  }
  return inside;
}

/** Cells to include in a comparison: 1 = use. Built from a lon/lat predicate over a grid. */
export function domain(g: GridSpec, include: (lon: number, lat: number) => boolean): Uint8Array {
  const out = new Uint8Array(g.nx * g.ny);
  for (let j = 0; j < g.ny; j++) {
    const lat = g.lat0 + g.dlat * j;
    for (let i = 0; i < g.nx; i++) out[j * g.nx + i] = include(g.lon0 + g.dlon * i, lat) ? 1 : 0;
  }
  return out;
}

/** Agreement of two masks when `b` is shifted by (dx, dy) cells (longitude wraps, latitude is cropped). */
export function agreement(a: Uint8Array, b: Uint8Array, nx: number, ny: number, dx: number, dy: number, use?: Uint8Array): number {
  let same = 0;
  let total = 0;
  for (let j = Math.max(0, dy); j <= Math.min(ny - 1, ny - 1 + dy); j++) {
    for (let i = 0; i < nx; i++) {
      if (use && !use[j * nx + i]) continue;
      const si = (((i - dx) % nx) + nx) % nx;
      if (a[j * nx + i] === b[(j - dy) * nx + si]) same++;
      total++;
    }
  }
  return same / total;
}

/** Pearson correlation of two fields when `b` is shifted by (dx, dy) cells (lon wraps, lat cropped). */
export function correlation(a: Float32Array, b: Float32Array, nx: number, ny: number, dx: number, dy: number, use?: Uint8Array): number {
  let n = 0;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let j = Math.max(0, dy); j <= Math.min(ny - 1, ny - 1 + dy); j++) {
    for (let i = 0; i < nx; i++) {
      if (use && !use[j * nx + i]) continue;
      const x = a[j * nx + i];
      const y = b[(j - dy) * nx + ((((i - dx) % nx) + nx) % nx)];
      n++;
      sa += x;
      sb += y;
      saa += x * x;
      sbb += y * y;
      sab += x * y;
    }
  }
  const cov = sab / n - (sa / n) * (sb / n);
  return cov / Math.sqrt((saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2));
}
