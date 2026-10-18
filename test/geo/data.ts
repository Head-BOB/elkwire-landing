import { decodeLand, type LandRings } from '../../src/app/geo/land';
import { decodeElevation, type ElevationGrid } from '../../src/app/geo/terrain';
import { readArrayBuffer, readGunzipped } from './helpers';
import type { GridSpec } from './raster';

export function loadLand(): LandRings {
  return decodeLand(readArrayBuffer('public/data/land.bin'));
}

/** Shipped mean-elevation grid (0.2 deg, CELL-centred). */
export function loadDem(): ElevationGrid {
  return decodeElevation(readArrayBuffer('public/data/elevation.bin'));
}

export function demSpec(g: ElevationGrid): GridSpec {
  return { nx: g.nx, ny: g.ny, lon0: g.lon0, lat0: g.lat0, dlon: g.dlon, dlat: -g.dlat };
}

/** Verification-only planes written by scripts/build-terrain.mjs: true peak (m) and land share. */
export function loadDemVerify(g: ElevationGrid): { max: Int16Array; landMask: Uint8Array } {
  const b = readGunzipped('test/fixtures/elevation-verify.bin.gz');
  const n = g.nx * g.ny;
  const max = new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + 2 * n));
  const frac = new Uint8Array(b.buffer.slice(b.byteOffset + 2 * n, b.byteOffset + 3 * n));
  // DEM land mask: at least half of the source pixels above 0 m.
  return { max, landMask: frac.map((v) => (v >= 128 ? 1 : 0)) as Uint8Array };
}

/**
 * GFS surface orography (HGT, m) and land-sea mask (LAND) on the SAME grid as the wind file, from
 * scripts/gfs/fetch_gfs.py --verify-out. NODE-centred, lon -180.., lat 90..-90.
 */
export function loadGfsVerify(res: '1p00' | '0p50'): { grid: GridSpec; hgt: Float32Array; land: Uint8Array } {
  const b = readArrayBuffer(`test/fixtures/gfs-verify-${res}.bin`);
  const v = new DataView(b);
  const nx = v.getUint16(5, true);
  const ny = v.getUint16(7, true);
  const grid: GridSpec = {
    nx,
    ny,
    lon0: v.getFloat32(9, true),
    lat0: v.getFloat32(13, true),
    dlon: v.getFloat32(17, true),
    dlat: v.getFloat32(21, true),
  };
  const hgt = new Float32Array(b.slice(25, 25 + 4 * nx * ny));
  const land = new Uint8Array(b.slice(25 + 4 * nx * ny, 25 + 5 * nx * ny));
  return { grid, hgt, land };
}

/** Bilinear sample of a CELL-centred grid (lon wraps, lat clamps). */
export function sampleCellGrid(g: ElevationGrid, lon: number, lat: number): number {
  const fx = (((lon - g.lon0) / g.dlon) % g.nx + g.nx) % g.nx;
  const fy = Math.min(g.ny - 1, Math.max(0, (g.lat0 - lat) / g.dlat));
  const x0 = Math.floor(fx);
  const y0 = Math.min(g.ny - 2, Math.floor(fy));
  const tx = fx - x0;
  const ty = fy - y0;
  const x1 = (x0 + 1) % g.nx;
  const e = g.elevation;
  return (
    e[y0 * g.nx + x0] * (1 - tx) * (1 - ty) + e[y0 * g.nx + x1] * tx * (1 - ty) + e[(y0 + 1) * g.nx + x0] * (1 - tx) * ty + e[(y0 + 1) * g.nx + x1] * tx * ty
  );
}

/** Area-average the DEM over each node's footprint (+-half a cell) so it is comparable to GFS fields. */
export function resampleDemToNodes(dem: ElevationGrid, grid: GridSpec): Float32Array {
  const out = new Float32Array(grid.nx * grid.ny);
  const sub = 8;
  for (let j = 0; j < grid.ny; j++) {
    const lat = grid.lat0 + grid.dlat * j;
    for (let i = 0; i < grid.nx; i++) {
      const lon = grid.lon0 + grid.dlon * i;
      let s = 0;
      for (let a = 0; a < sub; a++) {
        for (let b = 0; b < sub; b++) {
          s += sampleCellGrid(dem, lon + (-0.5 + (a + 0.5) / sub) * grid.dlon, lat + (-0.5 + (b + 0.5) / sub) * grid.dlat);
        }
      }
      out[j * grid.nx + i] = s / (sub * sub);
    }
  }
  return out;
}
