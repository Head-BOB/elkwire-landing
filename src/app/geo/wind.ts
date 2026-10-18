import { wrapLon } from './projection';

/**
 * NOAA GFS 10 m wind from public/data/wind.bin (see scripts/gfs/fetch_gfs.py).
 *
 * CONVENTION: NODE-centred grid. Node (i, j) sits exactly at lon = lon0 + dlon * i (lon0 = -180) and
 * lat = lat0 + dlat * j (lat0 = 90, dlat < 0), so rows run north to south. GFS natively uses lon 0..360;
 * the encoder rotated the columns to start at -180. The 360 column is NOT repeated, so interpolation wraps
 * from the last column to the first; rows clamp at the poles. u/v are m/s, positive east/north, used
 * directly (no speed/direction conversion).
 *
 * File: "ELKW" | u8 version | u8 nFrames | u16 nx | u16 ny | f32 lon0 lat0 dlon dlat |
 *       u32 refTime | f32 quantum | nFrames * u32 validTime | per frame: u plane, v plane (int16,
 *       row-wise deltas).
 */
export interface WindField {
  nx: number;
  ny: number;
  lon0: number;
  lat0: number;
  dlon: number;
  dlat: number;
  /** Model cycle time, unix seconds. */
  refTime: number;
  /** Valid time of each frame, unix seconds. */
  validTimes: number[];
  /** Per frame, m/s east. */
  u: Float32Array[];
  /** Per frame, m/s north. */
  v: Float32Array[];
}

export function decodeWind(buf: ArrayBuffer): WindField {
  const view = new DataView(buf);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'ELKW' || view.getUint8(4) !== 1) throw new Error('wind.bin: bad header');
  const nFrames = view.getUint8(5);
  const nx = view.getUint16(6, true);
  const ny = view.getUint16(8, true);
  const lon0 = view.getFloat32(10, true);
  const lat0 = view.getFloat32(14, true);
  const dlon = view.getFloat32(18, true);
  const dlat = view.getFloat32(22, true);
  const refTime = view.getUint32(26, true);
  const quantum = view.getFloat32(30, true);
  let o = 34;
  const validTimes: number[] = [];
  for (let f = 0; f < nFrames; f++, o += 4) validTimes.push(view.getUint32(o, true));

  const plane = (): Float32Array => {
    const out = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      let acc = 0;
      for (let i = 0; i < nx; i++, o += 2) {
        acc = (acc + view.getInt16(o, true)) << 16 >> 16;
        out[j * nx + i] = acc * quantum;
      }
    }
    return out;
  };
  const u: Float32Array[] = [];
  const v: Float32Array[] = [];
  for (let f = 0; f < nFrames; f++) {
    u.push(plane());
    v.push(plane());
  }
  return { nx, ny, lon0, lat0, dlon, dlat, refTime, validTimes, u, v };
}

export class WindSampler {
  readonly field: WindField;
  private u: Float32Array;
  private v: Float32Array;

  constructor(field: WindField) {
    this.field = field;
    this.u = field.u[0];
    this.v = field.v[0];
    this.setTime(field.validTimes[0]);
  }

  /**
   * Blend the two frames around `epochSec` (unix seconds) so the wind matches the real clock. Outside the
   * forecast span the nearest frame is held: there is no extrapolation and nothing is invented.
   */
  setTime(epochSec: number): void {
    const f = this.field;
    const t = f.validTimes;
    const last = t.length - 1;
    if (epochSec <= t[0] || last === 0) {
      this.u = f.u[0];
      this.v = f.v[0];
      return;
    }
    if (epochSec >= t[last]) {
      this.u = f.u[last];
      this.v = f.v[last];
      return;
    }
    let k = 0;
    while (t[k + 1] < epochSec) k++;
    const a = (epochSec - t[k]) / (t[k + 1] - t[k]);
    const n = f.nx * f.ny;
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      u[i] = f.u[k][i] * (1 - a) + f.u[k + 1][i] * a;
      v[i] = f.v[k][i] * (1 - a) + f.v[k + 1][i] * a;
    }
    this.u = u;
    this.v = v;
  }

  /** Bilinear sample in lon/lat (longitude wraps between the last and first column, latitude clamps). */
  sample(lon: number, lat: number, out: { u: number; v: number }): void {
    const f = this.field;
    const fx = (wrapLon(lon) - f.lon0) / f.dlon;
    let fy = (lat - f.lat0) / f.dlat;
    fy = fy < 0 ? 0 : fy > f.ny - 1 ? f.ny - 1 : fy;
    const x0 = Math.floor(fx);
    const y0 = Math.min(Math.floor(fy), f.ny - 2);
    const tx = fx - x0;
    const ty = fy - y0;
    const i0 = ((x0 % f.nx) + f.nx) % f.nx;
    const i1 = (i0 + 1) % f.nx;
    const r0 = y0 * f.nx;
    const r1 = (y0 + 1) * f.nx;
    const w00 = (1 - tx) * (1 - ty);
    const w10 = tx * (1 - ty);
    const w01 = (1 - tx) * ty;
    const w11 = tx * ty;
    out.u = this.u[r0 + i0] * w00 + this.u[r0 + i1] * w10 + this.u[r1 + i0] * w01 + this.u[r1 + i1] * w11;
    out.v = this.v[r0 + i0] * w00 + this.v[r0 + i1] * w10 + this.v[r1 + i0] * w01 + this.v[r1 + i1] * w11;
  }
}
