/**
 * Single source of truth for lon/lat <-> screen pixels. No other code may do its own lon/lat-to-pixel math.
 *
 * Equirectangular, UNIFORM scale (px per degree is the same in x and y; the map is never stretched to the
 * viewport). Longitude wraps horizontally. The visible latitude band (default 75N..60S) is fitted to the
 * viewport height; if the viewport is so wide that one world width would not fill it, the scale grows
 * (cover-fit) so no edge is ever empty.
 *
 * Conventions: lon in degrees, wrapped to [-180, 180); lat north-positive; screen y grows downwards.
 * `originX` is the WORLD x (px, 0 at lon -180) of the screen's left edge. Desktop keeps it fixed; the
 * mobile pan just advances it, so nothing is re-projected per frame.
 */

export interface LonLat {
  lon: number;
  lat: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ProjectionOptions {
  width: number;
  height: number;
  /** Longitude (deg) at the horizontal centre of the viewport. */
  centerLon: number;
  /** Top of the visible band (deg). Default 75. */
  latN?: number;
  /** Bottom of the visible band (deg). Default -60. */
  latS?: number;
}

export const DEFAULT_LAT_N = 75;
export const DEFAULT_LAT_S = -60;
/** Latitude beyond which the equirectangular x-stretch 1/cos(lat) stops growing. */
export const LON_STRETCH_MAX_LAT = 75;
const MIN_COS = Math.cos((LON_STRETCH_MAX_LAT * Math.PI) / 180);
const DEG = Math.PI / 180;

/** Wrap a longitude into [-180, 180). */
export function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Geographic x-stretch for velocities: one degree of longitude is cos(lat) as long as one degree of
 * latitude on an equirectangular map, so an eastward m/s must be drawn 1/cos(lat) times faster in x to
 * follow the real trajectory. Clamped near the poles.
 */
export function lonStretch(lat: number): number {
  return 1 / Math.max(Math.cos(lat * DEG), MIN_COS);
}

export class Projection {
  readonly width: number;
  readonly height: number;
  readonly latN: number;
  readonly latS: number;
  /** Pixels per degree, identical in x and y. */
  readonly scale: number;
  /** Width in px of one full revolution of the world (360 deg). */
  readonly worldWidth: number;
  /** Latitude shown at the vertical centre of the viewport. */
  readonly latCenter: number;
  private _centerLon: number;
  private _originX = 0;

  constructor(opts: ProjectionOptions) {
    this.width = opts.width;
    this.height = opts.height;
    this.latN = opts.latN ?? DEFAULT_LAT_N;
    this.latS = opts.latS ?? DEFAULT_LAT_S;
    this.scale = Math.max(this.height / (this.latN - this.latS), this.width / 360);
    this.worldWidth = 360 * this.scale;
    // Keep the band centred; the half-span of what is actually visible can never pass a pole.
    const half = this.height / this.scale / 2;
    const mid = (this.latN + this.latS) / 2;
    this.latCenter = Math.min(90 - half, Math.max(-90 + half, mid));
    this._centerLon = wrapLon(opts.centerLon);
    this.updateOrigin();
  }

  get centerLon(): number {
    return this._centerLon;
  }

  /** World x (px) of the viewport's left edge, in [0, worldWidth). */
  get originX(): number {
    return this._originX;
  }

  setCenterLon(lon: number): void {
    this._centerLon = wrapLon(lon);
    this.updateOrigin();
  }

  /** Advance the viewport east by `px` screen pixels (world appears to move west). */
  panBy(px: number): void {
    this._originX = (((this._originX + px) % this.worldWidth) + this.worldWidth) % this.worldWidth;
    this._centerLon = wrapLon((this._originX + this.width / 2) / this.scale - 180);
  }

  private updateOrigin(): void {
    const ox = (this._centerLon + 180) * this.scale - this.width / 2;
    this._originX = ((ox % this.worldWidth) + this.worldWidth) % this.worldWidth;
  }

  /** World x (px, 0 at lon -180) for a longitude; continuous, NOT wrapped. */
  worldX(lon: number): number {
    return (lon + 180) * this.scale;
  }

  /** Screen y (px) for a latitude. */
  screenY(lat: number): number {
    return this.height / 2 - (lat - this.latCenter) * this.scale;
  }

  /**
   * Project to screen px. x is the copy of the world nearest the viewport centre (it can still fall off
   * either edge); use `worldWidth` to find other copies. Writes into `out` (no allocation).
   */
  project(lon: number, lat: number, out: Point): Point {
    const rel = wrapLon(lon - this._centerLon);
    out.x = this.width / 2 + rel * this.scale;
    out.y = this.screenY(lat);
    return out;
  }

  /** Inverse of `project`. lon is wrapped to [-180, 180); lat is clamped to [-90, 90]. */
  unproject(x: number, y: number, out: LonLat): LonLat {
    out.lon = wrapLon(this._centerLon + (x - this.width / 2) / this.scale);
    const lat = this.latCenter - (y - this.height / 2) / this.scale;
    out.lat = lat > 90 ? 90 : lat < -90 ? -90 : lat;
    return out;
  }

  /** Screen x for a world x, wrapped into [0, worldWidth) measured from the viewport's left edge. */
  worldToScreenX(worldX: number): number {
    let x = worldX - this._originX;
    x = ((x % this.worldWidth) + this.worldWidth) % this.worldWidth;
    return x;
  }
}
