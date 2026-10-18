import { LonLat, Projection, lonStretch } from './projection';
import { Terrain, deflectWind, type Wind2 } from './terrain';
import { WindSampler } from './wind';

/**
 * Screen-space velocity grid baked from real wind + real terrain.
 *
 * The raster lives in WORLD pixels (x spans one full revolution, 0 at lon -180; y is screen y), so it does
 * not move when the mobile view pans. A particle at screen x reads it at world x = x + projection.originX.
 *
 * Per cell: unproject -> sample GFS wind (m/s) -> terrain deflection (m/s) -> convert to px/frame:
 *   vx =  u * FLOW_PX_PER_MS * lonStretch(lat)    (1/cos(lat): equirectangular x stretch, clamped)
 *   vy = -v * FLOW_PX_PER_MS                      (screen y points down, GFS v points north)
 * Units match the old normalised wind (m/s / 20), so the particle loop's x1.5 and the curl turbulence keep
 * their original relative weight.
 */

/**
 * px/frame per m/s, BEFORE the particle loop's x1.5.
 *
 * Calibration (1080p desktop, measured A/B against the original build): the original mapped Open-Meteo
 * wind_speed_10m, which is in km/h, with /20 (so ~0.27 px/frame per m/s on a stretched map) and also
 * added coastline/mountain repulsion. Sampling the real particles of both builds after 15 s gave
 *   original: mean 0.856, p50 0.638, p90 1.951 px/frame
 *   this K:   mean ~0.87,  p50 ~0.60,  p90 ~1.96   (K = 0.08 -> 0.887/0.607/2.00, K = 0.10 -> 0.859/0.584/1.92)
 * so overall particle speed matches, while real jets (p99 ~4 px/frame) stay clearly faster than calm air.
 * Re-run that comparison before changing this value; test/geo/flow-calibration.spec.ts guards the scale.
 */
export const FLOW_PX_PER_MS = 0.085;

export class FlowField {
  readonly proj: Projection;
  /** Cell size in px (about 0.5 degrees). */
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  private vx: Float32Array;
  private vy: Float32Array;
  private nextVx: Float32Array;
  private nextVy: Float32Array;
  private nextRow = 0;
  private baking = false;
  private wind: WindSampler | null = null;
  private terrain: Terrain | null = null;
  private readonly ll: LonLat = { lon: 0, lat: 0 };
  private readonly w: Wind2 = { u: 0, v: 0 };
  private readonly t = { bw: 0, nE: 0, nN: 0 };
  /** Result of the last `sample` call (no per-call allocation). */
  sx = 0;
  sy = 0;

  constructor(proj: Projection) {
    this.proj = proj;
    this.cell = Math.max(2, Math.round(0.5 * proj.scale));
    this.cols = Math.ceil(proj.worldWidth / this.cell);
    this.rows = Math.ceil(proj.height / this.cell) + 1;
    const n = this.cols * this.rows;
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.nextVx = new Float32Array(n);
    this.nextVy = new Float32Array(n);
  }

  /** Bake everything now (initial load and resize). */
  bakeAll(wind: WindSampler | null, terrain: Terrain | null): void {
    this.begin(wind, terrain);
    this.bakeRows(this.rows);
  }

  /** Start an incremental re-bake (periodic refresh); finish it with `step`. */
  begin(wind: WindSampler | null, terrain: Terrain | null): void {
    this.wind = wind;
    this.terrain = terrain;
    this.nextRow = 0;
    this.baking = true;
  }

  get isBaking(): boolean {
    return this.baking;
  }

  /** Continue an incremental bake for about `budgetMs`; swaps buffers when finished. */
  step(budgetMs: number): void {
    if (!this.baking) return;
    const end = performance.now() + budgetMs;
    while (this.baking && performance.now() < end) this.bakeRows(8);
  }

  private bakeRows(count: number): void {
    const { proj, cell, cols, rows } = this;
    const last = Math.min(rows, this.nextRow + count);
    for (let cy = this.nextRow; cy < last; cy++) {
      const y = (cy + 0.5) * cell;
      for (let cx = 0; cx < cols; cx++) {
        const idx = cy * cols + cx;
        if (!this.wind) {
          this.nextVx[idx] = 0;
          this.nextVy[idx] = 0;
          continue;
        }
        const lon = ((cx + 0.5) * cell) / proj.scale - 180;
        const lat = proj.latCenter - (y - proj.height / 2) / proj.scale;
        this.ll.lon = lon;
        this.ll.lat = lat > 90 ? 90 : lat < -90 ? -90 : lat;
        this.wind.sample(this.ll.lon, this.ll.lat, this.w);
        if (this.terrain) {
          this.terrain.sample(this.ll.lon, this.ll.lat, this.t);
          deflectWind(this.t.bw, this.t.nE, this.t.nN, this.w);
        }
        this.nextVx[idx] = this.w.u * FLOW_PX_PER_MS * lonStretch(this.ll.lat);
        this.nextVy[idx] = -this.w.v * FLOW_PX_PER_MS;
      }
    }
    this.nextRow = last;
    if (last >= rows) {
      [this.vx, this.nextVx] = [this.nextVx, this.vx];
      [this.vy, this.nextVy] = [this.nextVy, this.vy];
      this.baking = false;
    }
  }

  /** Bilinear lookup at WORLD x (wraps) and screen y (clamps). Writes `sx`, `sy`. */
  sample(worldX: number, y: number): void {
    const { cell, cols, rows } = this;
    let gx = worldX / cell - 0.5;
    gx -= Math.floor(gx / cols) * cols;
    let gy = y / cell - 0.5;
    gy = gy < 0 ? 0 : gy > rows - 1.001 ? rows - 1.001 : gy;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const x1 = x0 + 1 >= cols ? 0 : x0 + 1;
    const a = y0 * cols;
    const b = (y0 + 1) * cols;
    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;
    this.sx = this.vx[a + x0] * w00 + this.vx[a + x1] * w10 + this.vx[b + x0] * w01 + this.vx[b + x1] * w11;
    this.sy = this.vy[a + x0] * w00 + this.vy[a + x1] * w10 + this.vy[b + x0] * w01 + this.vy[b + x1] * w11;
  }
}
