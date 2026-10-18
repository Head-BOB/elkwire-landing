// Builds public/data/land.bin from Natural Earth 1:50m land (world-atlas, public domain).
//
// CONVENTION (source): lon -180..180, lat north-positive, planar lon/lat coordinates quantized on a
// lattice (scale 0.0036 deg lon, 0.001736 deg lat, origin -180 / -89.999). The topology is NOT cut at
// the antimeridian: rings that cross it jump by ~360 deg between consecutive vertices (Afro-Eurasia at
// Chukotka, Antarctica, Fiji, Wrangel). Antarctica's "hole" is a degenerate ring along lat -89.999
// that is really the pole closing edge.
//
// Output convention: every ring has CONTINUOUS longitude (unwrapped, may extend slightly past +-180)
// so no segment ever spans more than 180 deg. A ring that winds once around the pole is closed
// explicitly along lat -90. The renderer draws copies at k * 360 deg. Lattice integers are stored
// losslessly as zigzag-varint deltas.
//
// File: "ELKL" | u8 version | f64 originX, originY, scaleX, scaleY | u32 nRings |
//       per ring: varint nPts, then nPts * (varint zz(dx), varint zz(dy)); first delta is from (0,0).
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { feature } from 'topojson-client';

const require = createRequire(import.meta.url);
const topo = require('world-atlas/land-50m.json');
const { scale, translate } = topo.transform;
const [sx, sy] = scale;
const [ox, oy] = translate;

const fc = feature(topo, topo.objects.land);
const geoms = (fc.features ?? [fc]).map((f) => f.geometry ?? f);

/** Make longitudes continuous: shift by +-360 whenever consecutive points jump by more than 180. */
function unwrap(ring) {
  const out = [[ring[0][0], ring[0][1]]];
  let shift = 0;
  for (let i = 1; i < ring.length; i++) {
    const d = ring[i][0] - ring[i - 1][0];
    if (d > 180) shift -= 360;
    else if (d < -180) shift += 360;
    out.push([ring[i][0] + shift, ring[i][1]]);
  }
  return out;
}

const rings = [];
let polarRings = 0;
let droppedPoleLines = 0;
let windingRings = 0;

for (const g of geoms) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const poly of polys) {
    poly.forEach((raw, ri) => {
      // Degenerate pole edge stored as a hole: replaced by explicit closure of the polar ring.
      if (raw.every(([, lat]) => lat < -89.9)) {
        droppedPoleLines++;
        return;
      }
      const r = unwrap(raw);
      const first = r[0];
      const last = r[r.length - 1];
      const net = last[0] - first[0];
      if (Math.abs(net) > 1) {
        // Open in longitude by +-360: the ring winds around a pole. Close it along the pole edge.
        windingRings++;
        const south = r.reduce((a, p) => a + p[1], 0) / r.length < 0;
        const poleLat = south ? -90 : 90;
        if (Math.abs(Math.abs(net) - 360) > 1) throw new Error(`unexpected winding ${net}`);
        // Midpoint keeps every segment <= 180 deg (the pole edge spans one full world width).
        r.push([last[0], poleLat], [(last[0] + first[0]) / 2, poleLat], [first[0], poleLat]);
        polarRings++;
      }
      // Drop the duplicated closing vertex; the renderer closes the path.
      const a = r[0];
      const b = r[r.length - 1];
      if (a[0] === b[0] && a[1] === b[1]) r.pop();
      void ri;
      rings.push(r);
    });
  }
}

function varint(out, n) {
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
}
const zz = (n) => (n >= 0 ? n * 2 : -n * 2 - 1);

const body = [];
let pts = 0;
let maxSeg = 0;
for (const r of rings) {
  varint(body, r.length);
  let px = 0;
  let py = 0;
  let prevLon = null;
  for (const [lon, lat] of r) {
    const ix = Math.round((lon - ox) / sx);
    const iy = Math.round((lat - oy) / sy);
    varint(body, zz(ix - px));
    varint(body, zz(iy - py));
    px = ix;
    py = iy;
    if (prevLon !== null) maxSeg = Math.max(maxSeg, Math.abs(lon - prevLon));
    prevLon = lon;
    pts++;
  }
}

const head = Buffer.alloc(4 + 1 + 32 + 4);
head.write('ELKL', 0, 'ascii');
head.writeUInt8(1, 4);
head.writeDoubleLE(ox, 5);
head.writeDoubleLE(oy, 13);
head.writeDoubleLE(sx, 21);
head.writeDoubleLE(sy, 29);
head.writeUInt32LE(rings.length, 37);

mkdirSync('public/data', { recursive: true });
writeFileSync('public/data/land.bin', Buffer.concat([head, Buffer.from(body)]));
console.log(
  `land.bin: ${rings.length} rings, ${pts} points, ${head.length + body.length} bytes; ` +
    `${windingRings} polar-closed, ${droppedPoleLines} pole line(s) dropped, max segment ${maxSeg.toFixed(3)} deg`,
);
if (maxSeg > 180 + 1e-6) throw new Error('segment spans more than 180 degrees');
