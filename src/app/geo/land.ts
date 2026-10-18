import type { Projection } from './projection';

/**
 * Natural Earth 1:50m land, decoded from public/data/land.bin (see scripts/build-land.mjs).
 *
 * CONVENTION: each ring is a Float64Array of interleaved [lon, lat, ...] with CONTINUOUS longitude
 * (unwrapped, so it may extend slightly past +-180) and lat in [-90, 90]. A ring that winds around the pole
 * (Antarctica) is already closed along the pole edge. No segment spans more than 180 degrees of longitude.
 * Rings are implicitly closed. Holes are separate rings; fill with the even-odd rule.
 */
export type LandRings = Float64Array[];

export function decodeLand(buf: ArrayBuffer): LandRings {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== 'ELKL' || bytes[4] !== 1) throw new Error('land.bin: bad header');
  const ox = view.getFloat64(5, true);
  const oy = view.getFloat64(13, true);
  const sx = view.getFloat64(21, true);
  const sy = view.getFloat64(29, true);
  const nRings = view.getUint32(37, true);
  let pos = 41;

  const varint = (): number => {
    let result = 0;
    let mul = 1;
    for (;;) {
      const b = bytes[pos++];
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 128;
    }
  };
  const unzig = (n: number): number => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

  const rings: LandRings = [];
  for (let r = 0; r < nRings; r++) {
    const n = varint();
    const ring = new Float64Array(n * 2);
    let ix = 0;
    let iy = 0;
    for (let i = 0; i < n; i++) {
      ix += unzig(varint());
      iy += unzig(varint());
      ring[i * 2] = ix * sx + ox;
      // Pole closure vertices are stored one lattice step beyond the pole; clamp them onto it.
      ring[i * 2 + 1] = Math.max(-90, Math.min(90, iy * sy + oy));
    }
    rings.push(ring);
  }
  return rings;
}

/** Subtle land fill (unchanged from the original look). */
export const LAND_FILL = 'rgba(0, 4, 10, 0.04)';

/**
 * Render land once into a strip that is exactly one world revolution wide (projection.worldWidth) and
 * viewport tall. Strip x is WORLD x, so panning is just a different blit offset. All rings (and the wrap
 * copies they need) go into ONE path filled once, so seams between polygons and overlaps never darken.
 */
export function renderLandLayer(rings: LandRings, proj: Projection, canvas: HTMLCanvasElement): void {
  const ww = Math.ceil(proj.worldWidth);
  canvas.width = ww;
  canvas.height = Math.ceil(proj.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const path = new Path2D();
  const worldW = proj.worldWidth;
  for (const ring of rings) {
    const n = ring.length / 2;
    if (n < 3) continue;
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = proj.worldX(ring[i * 2]);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
    for (let k = -1; k <= 1; k++) {
      const off = k * worldW;
      if (maxX + off < 0 || minX + off > worldW) continue;
      path.moveTo(proj.worldX(ring[0]) + off, proj.screenY(ring[1]));
      for (let i = 1; i < n; i++) path.lineTo(proj.worldX(ring[i * 2]) + off, proj.screenY(ring[i * 2 + 1]));
      path.closePath();
    }
  }
  ctx.fillStyle = LAND_FILL;
  ctx.fill(path, 'evenodd');
}

/** Blit the visible part of the world strip (two blits when the viewport straddles the strip's seam). */
export function drawLandLayer(ctx: CanvasRenderingContext2D, layer: HTMLCanvasElement, proj: Projection): void {
  const ww = layer.width;
  const h = layer.height;
  const w = proj.width;
  const o = Math.floor(proj.originX) % ww;
  let drawn = 0;
  while (drawn < w) {
    const srcX = (o + drawn) % ww;
    const take = Math.min(ww - srcX, w - drawn);
    ctx.drawImage(layer, srcX, 0, take, h, drawn, 0, take, h);
    drawn += take;
  }
}
