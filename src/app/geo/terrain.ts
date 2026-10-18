import { wrapLon } from './projection';

/**
 * Real terrain from public/data/elevation.bin (AWS Terrain Tiles "terrarium" z6, see
 * scripts/build-terrain.mjs).
 *
 * CONVENTION: equirectangular lon/lat grid, CELL-centred, 0.2 deg. Cell (i, j) is centred on
 * lon = lon0 + dlon * i (lon0 = -179.9) and lat = lat0 - dlat * j (lat0 = 89.9); rows run north to south.
 * Longitude wraps, latitude clamps. Values are mean elevation in metres (ocean counted as 0), stored as
 * int16 * quantum with row-wise horizontal deltas.
 *
 * Deflection model (applied to a wind vector in m/s, geographic east/north components):
 *   - n  = unit uphill direction (gradient of the smoothed elevation, metres per km, cos(lat)-corrected)
 *   - bw = barrier weight in [0, 1] = (heightFactor * slopeFactor) ^ BARRIER_GAMMA
 *     heightFactor = smoothstep(H_START, H_FULL, ridge height); ridge height is the local maximum of the
 *     cell means within RIDGE_RADIUS cells. The ramp starts at 300 m, not ~1000 m: 0.2 deg cell means sit
 *     30-45% below crest heights (measured: W. Ghats 1656 m cell max vs 2695 m peak), and a 1000 m start
 *     would erase the Ghats, Great Dividing Range and Scandinavian mountains.
 *   - windward slowdown:   w *= 1 - K_SLOW * bw * min(1, (w.n) / |w|)           when w.n > 0
 *   - into-slope removal:  w -= K_BLOCK * bw * (w.n) * n                         when w.n > 0
 *   - ridge channeling:    w += K_CHANNEL * bw * (w.t) * t,   t = n rotated +90 deg
 * Land (the coastline) exerts NO force: only real winds and real terrain shape the flow.
 */

export const H_START = 300;
export const H_FULL = 3500;
/** Slope (m/km, after smoothing) below which a cell does not act as a barrier (plateau interiors). */
export const SLOPE_START = 1;
export const SLOPE_FULL = 8;
/** Orographic blocking saturates sub-linearly: low ranges still deflect. Himalaya stays at 1, W. Ghats ~0.5. */
export const BARRIER_GAMMA = 0.6;
export const K_SLOW = 0.3;
export const K_BLOCK = 0.92;
export const K_CHANNEL = 0.35;
const RIDGE_RADIUS = 3; // cells (0.6 deg)
const BLUR_RADIUS = 2; // cells, applied twice (triangular kernel, sigma ~0.4 deg)
const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LON_EQ = 111.32;

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = x <= e0 ? 0 : x >= e1 ? 1 : (x - e0) / (e1 - e0);
  return t * t * (3 - 2 * t);
}

export interface ElevationGrid {
  nx: number;
  ny: number;
  lon0: number;
  lat0: number;
  dlon: number;
  dlat: number;
  /** Mean elevation in metres, cell-centred, rows north to south. */
  elevation: Float32Array;
}

/** Decode elevation.bin ("ELKE" v1) into a metres grid. */
export function decodeElevation(buf: ArrayBuffer): ElevationGrid {
  const view = new DataView(buf);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'ELKE' || view.getUint8(4) !== 1) throw new Error('elevation.bin: bad header');
  const nx = view.getUint16(5, true);
  const ny = view.getUint16(7, true);
  const lon0 = view.getFloat32(9, true);
  const lat0 = view.getFloat32(13, true);
  const dlon = view.getFloat32(17, true);
  const dlat = view.getFloat32(21, true);
  const quantum = view.getFloat32(25, true);
  const elevation = new Float32Array(nx * ny);
  let o = 29;
  for (let j = 0; j < ny; j++) {
    let acc = 0;
    for (let i = 0; i < nx; i++, o += 2) {
      acc = (acc + view.getInt16(o, true)) << 16 >> 16;
      elevation[j * nx + i] = acc * quantum;
    }
  }
  return { nx, ny, lon0, lat0, dlon, dlat, elevation };
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export class Terrain {
  readonly nx: number;
  readonly ny: number;
  readonly lon0: number;
  readonly lat0: number;
  readonly dlon: number;
  readonly dlat: number;
  /** Barrier weight 0..1 (x255). */
  readonly bw: Uint8Array;
  /** Unit uphill direction, east component (x127). */
  readonly nE: Int8Array;
  /** Unit uphill direction, north component (x127). */
  readonly nN: Int8Array;

  private constructor(g: ElevationGrid, bw: Uint8Array, nE: Int8Array, nN: Int8Array) {
    this.nx = g.nx;
    this.ny = g.ny;
    this.lon0 = g.lon0;
    this.lat0 = g.lat0;
    this.dlon = g.dlon;
    this.dlat = g.dlat;
    this.bw = bw;
    this.nE = nE;
    this.nN = nN;
  }

  /**
   * Derive the barrier fields from an elevation grid. Work runs in row chunks and awaits `yielder` between
   * them, so the page never blocks the main thread for long (tests pass a no-op yielder).
   */
  static async build(g: ElevationGrid, yielder: () => Promise<void> = yieldToEventLoop): Promise<Terrain> {
    const { nx, ny, elevation: h } = g;
    const CHUNK = 90;
    const rows = async (fn: (r0: number, r1: number) => void) => {
      for (let r0 = 0; r0 < ny; r0 += CHUNK) {
        fn(r0, Math.min(ny, r0 + CHUNK));
        await yielder();
      }
    };
    const boxX = (src: Float32Array, dst: Float32Array, r: number) => (r0: number, r1: number) => {
      for (let j = r0; j < r1; j++) {
        const row = j * nx;
        for (let i = 0; i < nx; i++) {
          let s = 0;
          for (let k = -r; k <= r; k++) s += src[row + ((i + k + nx) % nx)];
          dst[row + i] = s / (2 * r + 1);
        }
      }
    };
    const boxY = (src: Float32Array, dst: Float32Array, r: number) => (r0: number, r1: number) => {
      for (let j = r0; j < r1; j++) {
        for (let i = 0; i < nx; i++) {
          let s = 0;
          for (let k = -r; k <= r; k++) s += src[Math.min(ny - 1, Math.max(0, j + k)) * nx + i];
          dst[j * nx + i] = s / (2 * r + 1);
        }
      }
    };
    const maxX = (src: Float32Array, dst: Float32Array, r: number) => (r0: number, r1: number) => {
      for (let j = r0; j < r1; j++) {
        const row = j * nx;
        for (let i = 0; i < nx; i++) {
          let m = 0;
          for (let k = -r; k <= r; k++) m = Math.max(m, src[row + ((i + k + nx) % nx)]);
          dst[row + i] = m;
        }
      }
    };
    const maxY = (src: Float32Array, dst: Float32Array, r: number) => (r0: number, r1: number) => {
      for (let j = r0; j < r1; j++) {
        for (let i = 0; i < nx; i++) {
          let m = 0;
          for (let k = -r; k <= r; k++) m = Math.max(m, src[Math.min(ny - 1, Math.max(0, j + k)) * nx + i]);
          dst[j * nx + i] = m;
        }
      }
    };

    const a = new Float32Array(nx * ny);
    const b = new Float32Array(nx * ny);

    // Smoothed elevation for the gradient: two box passes in each direction.
    await rows(boxX(h, a, BLUR_RADIUS));
    await rows(boxY(a, b, BLUR_RADIUS));
    await rows(boxX(b, a, BLUR_RADIUS));
    await rows(boxY(a, b, BLUR_RADIUS)); // b = smoothed elevation
    const smooth = b;

    // Ridge height: local maximum of the cell means, lightly blurred to avoid blocky edges.
    const ridge = new Float32Array(nx * ny);
    await rows(maxX(h, a, RIDGE_RADIUS));
    await rows(maxY(a, ridge, RIDGE_RADIUS));
    await rows(boxX(ridge, a, BLUR_RADIUS));
    await rows(boxY(a, ridge, BLUR_RADIUS));

    const bw = new Uint8Array(nx * ny);
    const nE = new Int8Array(nx * ny);
    const nN = new Int8Array(nx * ny);
    await rows((r0, r1) => {
      for (let j = r0; j < r1; j++) {
        const lat = g.lat0 - g.dlat * j;
        const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
        const kmX = 2 * g.dlon * KM_PER_DEG_LON_EQ * cosLat;
        const kmY = 2 * g.dlat * KM_PER_DEG_LAT;
        const jn = Math.max(0, j - 1);
        const js = Math.min(ny - 1, j + 1);
        for (let i = 0; i < nx; i++) {
          const c = j * nx + i;
          const hf = smoothstep(H_START, H_FULL, ridge[c]);
          if (hf === 0) continue;
          const gE = (smooth[j * nx + ((i + 1) % nx)] - smooth[j * nx + ((i - 1 + nx) % nx)]) / kmX;
          const gN = (smooth[jn * nx + i] - smooth[js * nx + i]) / kmY; // north neighbour is the row above
          const slope = Math.hypot(gE, gN);
          const w = Math.pow(hf * smoothstep(SLOPE_START, SLOPE_FULL, slope), BARRIER_GAMMA);
          if (w === 0) continue;
          bw[c] = Math.round(w * 255);
          nE[c] = Math.round((gE / slope) * 127);
          nN[c] = Math.round((gN / slope) * 127);
        }
      }
    });
    return new Terrain(g, bw, nE, nN);
  }

  /** Barrier weight and uphill direction at lon/lat (bilinear, longitude wraps, latitude clamps). */
  sample(lon: number, lat: number, out: { bw: number; nE: number; nN: number }): void {
    const fx = (wrapLon(lon) - this.lon0) / this.dlon;
    const fy = (this.lat0 - lat) / this.dlat;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const i0 = ((x0 % this.nx) + this.nx) % this.nx;
    const i1 = (i0 + 1) % this.nx;
    const j0 = Math.min(this.ny - 1, Math.max(0, y0));
    const j1 = Math.min(this.ny - 1, Math.max(0, y0 + 1));
    const c00 = j0 * this.nx + i0;
    const c10 = j0 * this.nx + i1;
    const c01 = j1 * this.nx + i0;
    const c11 = j1 * this.nx + i1;
    const w00 = (1 - tx) * (1 - ty);
    const w10 = tx * (1 - ty);
    const w01 = (1 - tx) * ty;
    const w11 = tx * ty;
    out.bw = (this.bw[c00] * w00 + this.bw[c10] * w10 + this.bw[c01] * w01 + this.bw[c11] * w11) / 255;
    out.nE = (this.nE[c00] * w00 + this.nE[c10] * w10 + this.nE[c01] * w01 + this.nE[c11] * w11) / 127;
    out.nN = (this.nN[c00] * w00 + this.nN[c10] * w10 + this.nN[c01] * w01 + this.nN[c11] * w11) / 127;
  }
}

export interface Wind2 {
  u: number;
  v: number;
}

/** Apply the terrain model to a wind vector (m/s east/north) in place. */
export function deflectWind(bw: number, nE: number, nN: number, w: Wind2): void {
  if (bw <= 0) return;
  const into = w.u * nE + w.v * nN;
  const tE = -nN;
  const tN = nE;
  if (into > 0) {
    const speed = Math.hypot(w.u, w.v);
    const slow = 1 - K_SLOW * bw * Math.min(1, into / (speed || 1));
    w.u *= slow;
    w.v *= slow;
    const into2 = w.u * nE + w.v * nN;
    w.u -= K_BLOCK * bw * into2 * nE;
    w.v -= K_BLOCK * bw * into2 * nN;
  }
  const along = w.u * tE + w.v * tN;
  w.u += K_CHANNEL * bw * along * tE;
  w.v += K_CHANNEL * bw * along * tN;
}
