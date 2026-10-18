// Builds public/data/elevation.bin from AWS Terrain Tiles ("terrarium", zoom 6).
// Source: https://registry.opendata.aws/terrain-tiles/  (attribution list in THIRD_PARTY_NOTICES.md)
//
// Why terrarium: no auth, plain PNG (no GDAL/netCDF toolchain), global composite of SRTM/GMTED/ETOPO1/
// others, ~2.4 km pixels at z6 which keeps peak heights close to reality (z5 flattens them).
//
// CONVENTIONS
//  - Source tiles: Web Mercator (EPSG:3857), XYZ scheme, tile row 0 at the north, pixel-centred samples.
//    Elevation (m) = (R*256 + G + B/256) - 32768.
//    Latitude is NOT linear in tile y: lat = atan(sinh(pi * (1 - 2 * y_norm))), inverted per row below.
//  - Output grid: equirectangular lon/lat, CELL-centred, 0.2 deg. Cell (i, j) covers
//    lon [-180 + 0.2 i, -180 + 0.2 (i+1)), lat (90 - 0.2 (j+1), 90 - 0.2 j]; its centre is
//    lon = -179.9 + 0.2 i, lat = 89.9 - 0.2 j. Rows run north -> south. Longitude wraps, latitude clamps.
//  - Mercator tiles stop at +-85.0511 deg; rows beyond are copied from the nearest covered row.
//
// Shipped asset public/data/elevation.bin: ONE plane, mean elevation (ocean pixels counted as 0 so coasts
// are not biased by bathymetry), quantized to QUANT metres, int16 with row-wise horizontal deltas
// (wrapping) to help gzip. Quantizing to 8 m is irrelevant for a 1000..4000 m smoothstep.
//   "ELKE" | u8 version | u16 nx | u16 ny | f32 lon0 lat0 dlon dlat | f32 quant | mean i16[]
//
// Verification-only fixture test/fixtures/elevation-verify.bin.gz (gzipped, never shipped to the browser):
//   max i16[] (true peak per cell, metres, unquantized) | landFrac u8[] (share of source pixels > 0 m, x255)
// both rows north->south, same cell-centred grid, no delta coding.
import { PNG } from 'pngjs';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const Z = 6;
const N = 1 << Z; // tiles per side
const TILE = 256;
const WORLD = N * TILE;
const D = 0.2;
const QUANT = 8; // metres per int16 unit of the shipped mean plane
const NX = Math.round(360 / D);
const NY = Math.round(180 / D);
const CACHE = join('.cache', 'terrarium', String(Z));
const URL_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

// Per-column / per-row source pixel -> output cell lookup (mercator inverted per row).
const colCell = new Int32Array(WORLD);
for (let x = 0; x < WORLD; x++) {
  const lon = ((x + 0.5) / WORLD) * 360 - 180;
  colCell[x] = Math.min(NX - 1, Math.floor((lon + 180) / D));
}
const rowCell = new Int32Array(WORLD);
for (let y = 0; y < WORLD; y++) {
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / WORLD))) * 180) / Math.PI;
  rowCell[y] = Math.min(NY - 1, Math.max(0, Math.floor((90 - lat) / D)));
}

const sum = new Float64Array(NX * NY);
const cnt = new Uint32Array(NX * NY);
const landCnt = new Uint32Array(NX * NY);
const mx = new Float32Array(NX * NY).fill(-Infinity);

async function getTile(x, y) {
  const file = join(CACHE, String(x), `${y}.png`);
  if (existsSync(file)) return readFileSync(file);
  const url = `${URL_BASE}/${Z}/${x}/${y}.png`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      mkdirSync(join(CACHE, String(x)), { recursive: true });
      writeFileSync(file, buf);
      return buf;
    } catch (e) {
      if (attempt === 4) throw new Error(`tile ${Z}/${x}/${y}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

function accumulate(tx, ty, png) {
  const { data } = png; // RGBA
  const x0 = tx * TILE;
  const y0 = ty * TILE;
  for (let py = 0; py < TILE; py++) {
    const rowBase = rowCell[y0 + py] * NX;
    for (let px = 0; px < TILE; px++) {
      const o = (py * TILE + px) * 4;
      const e = data[o] * 256 + data[o + 1] + data[o + 2] / 256 - 32768;
      const c = rowBase + colCell[x0 + px];
      const land = e > 0;
      sum[c] += land ? e : 0;
      cnt[c]++;
      if (land) {
        landCnt[c]++;
        if (e > mx[c]) mx[c] = e;
      }
    }
  }
}

const jobs = [];
for (let ty = 0; ty < N; ty++) for (let tx = 0; tx < N; tx++) jobs.push([tx, ty]);
let done = 0;
const t0 = Date.now();
async function worker() {
  while (jobs.length) {
    const [tx, ty] = jobs.pop();
    const buf = await getTile(tx, ty);
    accumulate(tx, ty, PNG.sync.read(buf));
    if (++done % 256 === 0) console.log(`${done}/${N * N} tiles (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
}
await Promise.all(Array.from({ length: 24 }, worker));

// Resolve cells; fill rows with no source pixels (beyond the mercator limit) from the nearest covered row.
const mean = new Int16Array(NX * NY);
const max = new Int16Array(NX * NY);
const land = new Uint8Array(NX * NY);
const covered = new Uint8Array(NY);
for (let j = 0; j < NY; j++) {
  for (let i = 0; i < NX; i++) {
    const c = j * NX + i;
    if (cnt[c] > 0) covered[j] = 1;
    if (cnt[c] === 0) continue;
    mean[c] = Math.round(sum[c] / cnt[c]);
    max[c] = mx[c] === -Infinity ? 0 : Math.round(mx[c]);
    land[c] = Math.round((landCnt[c] / cnt[c]) * 255);
  }
}
let filled = 0;
for (let j = 0; j < NY; j++) {
  if (covered[j]) continue;
  const src = j < NY / 2 ? covered.indexOf(1) : covered.lastIndexOf(1);
  mean.copyWithin(j * NX, src * NX, (src + 1) * NX);
  max.copyWithin(j * NX, src * NX, (src + 1) * NX);
  land.copyWithin(j * NX, src * NX, (src + 1) * NX);
  filled++;
}
console.log(`rows copied from nearest covered row (beyond +-85.05): ${filled}`);

function deltaRows16(a) {
  const out = new Int16Array(a.length);
  for (let j = 0; j < NY; j++) {
    let prev = 0;
    for (let i = 0; i < NX; i++) {
      const v = a[j * NX + i];
      out[j * NX + i] = ((v - prev) << 16) >> 16;
      prev = v;
    }
  }
  return out;
}

const head = Buffer.alloc(4 + 1 + 2 + 2 + 16 + 4);
head.write('ELKE', 0, 'ascii');
head.writeUInt8(1, 4);
head.writeUInt16LE(NX, 5);
head.writeUInt16LE(NY, 7);
head.writeFloatLE(-180 + D / 2, 9);
head.writeFloatLE(90 - D / 2, 13);
head.writeFloatLE(D, 17);
head.writeFloatLE(D, 21);
head.writeFloatLE(QUANT, 25);
const q = Int16Array.from(mean, (v) => Math.round(v / QUANT));
const dm = deltaRows16(q);
const out = Buffer.concat([head, Buffer.from(dm.buffer, dm.byteOffset, dm.byteLength)]);
mkdirSync('public/data', { recursive: true });
writeFileSync('public/data/elevation.bin', out);

mkdirSync('test/fixtures', { recursive: true });
const verify = Buffer.concat([Buffer.from(max.buffer, max.byteOffset, max.byteLength), Buffer.from(land)]);
writeFileSync('test/fixtures/elevation-verify.bin.gz', gzipSync(verify, { level: 9 }));
console.log(`elevation.bin: ${NX}x${NY}, ${out.length} bytes (${gzipSync(out, { level: 9 }).length} gzipped)`);
console.log(`elevation-verify.bin.gz: ${gzipSync(verify, { level: 9 }).length} bytes`);
