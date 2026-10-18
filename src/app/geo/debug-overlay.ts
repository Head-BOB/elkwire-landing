import { decodeElevation, type ElevationGrid } from './terrain';
import { decodeLand, type LandRings } from './land';
import { Projection, wrapLon } from './projection';
import { WindSampler, decodeWind } from './wind';

/**
 * ?debug=1 overlay: lets you eyeball that coastline, terrain and wind sit in the same real-world place.
 * Everything is drawn through the shared Projection. Loaded lazily, so it is not part of the normal bundle.
 *
 * Layers (toggle with the buttons, or ?layer=land|terrain|wind for a single one):
 *   land    Natural Earth 1:50m coastline
 *   terrain elevation contours at 1000 / 2000 / 4000 m (marching squares on the shipped 0.2 deg grid)
 *   wind    GFS 10 m wind arrows at grid nodes (every 5 deg)
 *   grid    10 deg graticule with labels, and reference markers
 */

interface Layers {
  land: boolean;
  terrain: boolean;
  wind: boolean;
  grid: boolean;
}

const LEVELS: { m: number; color: string }[] = [
  { m: 1000, color: 'rgba(250, 204, 21, 0.9)' },
  { m: 2000, color: 'rgba(251, 146, 60, 0.95)' },
  { m: 4000, color: 'rgba(248, 113, 113, 1)' },
];

const MARKERS: { name: string; lon: number; lat: number }[] = [
  { name: 'Kochi', lon: 76.27, lat: 9.93 },
  { name: 'Strait of Gibraltar', lon: -5.5, lat: 35.96 },
  { name: 'Cape Horn', lon: -67.27, lat: -55.98 },
  { name: 'Everest', lon: 86.925, lat: 27.988 },
  { name: 'Kilimanjaro', lon: 37.356, lat: -3.067 },
  { name: 'Reykjavik', lon: -21.94, lat: 64.15 },
];

/** Marching squares over a cell-centred grid, returning segments [lon1, lat1, lon2, lat2, ...]. */
function contour(g: ElevationGrid, level: number): Float32Array {
  const out: number[] = [];
  const { nx, ny, elevation: e } = g;
  const lon = (i: number) => g.lon0 + g.dlon * i;
  const lat = (j: number) => g.lat0 - g.dlat * j;
  const lerp = (a: number, b: number) => (level - a) / (b - a);
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx; i++) {
      const i1 = (i + 1) % nx;
      const a = e[j * nx + i]; // top-left
      const b = e[j * nx + i1]; // top-right
      const c = e[(j + 1) * nx + i1]; // bottom-right
      const d = e[(j + 1) * nx + i]; // bottom-left
      const idx = (a >= level ? 8 : 0) | (b >= level ? 4 : 0) | (c >= level ? 2 : 0) | (d >= level ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const x0 = lon(i);
      const x1 = x0 + g.dlon;
      const y0 = lat(j);
      const y1 = lat(j + 1);
      const top = [x0 + lerp(a, b) * g.dlon, y0];
      const right = [x1, y0 + lerp(b, c) * (y1 - y0)];
      const bottom = [x0 + lerp(d, c) * g.dlon, y1];
      const left = [x0, y0 + lerp(a, d) * (y1 - y0)];
      const seg = (p: number[], q: number[]) => out.push(p[0], p[1], q[0], q[1]);
      switch (idx) {
        case 1: case 14: seg(left, bottom); break;
        case 2: case 13: seg(bottom, right); break;
        case 3: case 12: seg(left, right); break;
        case 4: case 11: seg(top, right); break;
        case 5: seg(top, left); seg(bottom, right); break;
        case 6: case 9: seg(top, bottom); break;
        case 7: case 8: seg(top, left); break;
        case 10: seg(top, right); seg(left, bottom); break;
      }
    }
  }
  return Float32Array.from(out);
}

export interface DebugOverlay {
  destroy(): void;
}

export async function mountDebugOverlay(opts: { getProjection: () => Projection; host: HTMLElement; mainCanvas: HTMLCanvasElement }): Promise<DebugOverlay> {
  const [landBuf, demBuf, windBuf] = await Promise.all(
    ['/data/land.bin', '/data/elevation.bin', '/data/wind.bin'].map((u) => fetch(u).then((r) => r.arrayBuffer())),
  );
  const land: LandRings = decodeLand(landBuf);
  const dem = decodeElevation(demBuf);
  const wind = new WindSampler(decodeWind(windBuf));
  wind.setTime(Date.now() / 1000);
  const contours = LEVELS.map((l) => ({ ...l, seg: contour(dem, l.m) }));

  const params = new URLSearchParams(location.search);
  const only = params.get('layer');
  const layers: Layers = only
    ? { land: only === 'land', terrain: only === 'terrain', wind: only === 'wind', grid: true }
    : { land: true, terrain: true, wind: true, grid: true };

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:20;pointer-events:none';
  const bar = document.createElement('div');
  bar.style.cssText =
    'position:fixed;top:8px;left:8px;z-index:30;display:flex;gap:6px;flex-wrap:wrap;font:11px/1.2 monospace;color:#cbd5e1';
  opts.host.append(canvas, bar);
  const ctx = canvas.getContext('2d')!;
  const solo = !!only;
  if (solo) opts.mainCanvas.style.visibility = 'hidden';

  let lastKey = '';
  const draw = () => {
    const proj = opts.getProjection();
    const dpr = window.devicePixelRatio || 1;
    const key = `${proj.width}x${proj.height}@${proj.originX.toFixed(1)}|${JSON.stringify(layers)}`;
    if (key === lastKey) return;
    lastKey = key;
    canvas.width = proj.width * dpr;
    canvas.height = proj.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, proj.width, proj.height);
    if (solo) {
      ctx.fillStyle = '#000812';
      ctx.fillRect(0, 0, proj.width, proj.height);
    }
    const ww = proj.worldWidth;
    const sx = (lon: number) => (((proj.worldX(lon) - proj.originX) % ww) + ww) % ww;

    if (layers.land) {
      ctx.strokeStyle = 'rgba(94, 234, 212, 0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const ring of land) {
        const n = ring.length / 2;
        for (let k = -1; k <= 1; k++) {
          const off = k * ww - proj.originX;
          ctx.moveTo(proj.worldX(ring[0]) + off, proj.screenY(ring[1]));
          for (let i = 1; i <= n; i++) {
            const p = i % n;
            ctx.lineTo(proj.worldX(ring[p * 2]) + off, proj.screenY(ring[p * 2 + 1]));
          }
        }
      }
      ctx.stroke();
    }

    if (layers.terrain) {
      ctx.lineWidth = 1;
      for (const c of contours) {
        ctx.strokeStyle = c.color;
        ctx.beginPath();
        for (let i = 0; i < c.seg.length; i += 4) {
          const x1 = sx(c.seg[i]);
          const x2 = sx(c.seg[i + 2]);
          if (Math.abs(x2 - x1) > ww / 2) continue;
          const y1 = proj.screenY(c.seg[i + 1]);
          const y2 = proj.screenY(c.seg[i + 3]);
          for (const s of [0, -ww]) {
            if (Math.max(x1, x2) + s < -2 || Math.min(x1, x2) + s > proj.width + 2) continue;
            ctx.moveTo(x1 + s, y1);
            ctx.lineTo(x2 + s, y2);
          }
        }
        ctx.stroke();
      }
    }

    if (layers.wind) {
      const f = wind.field;
      ctx.strokeStyle = 'rgba(147, 197, 253, 0.95)';
      ctx.fillStyle = 'rgba(147, 197, 253, 0.95)';
      ctx.lineWidth = 1;
      const stride = Math.max(1, Math.round(5 / Math.abs(f.dlon)));
      const o = { u: 0, v: 0 };
      for (let j = 0; j < f.ny; j += stride) {
        const lat = f.lat0 + f.dlat * j;
        const y = proj.screenY(lat);
        if (y < -10 || y > proj.height + 10) continue;
        for (let i = 0; i < f.nx; i += stride) {
          const lon = f.lon0 + f.dlon * i;
          const x0 = sx(lon);
          wind.sample(lon, lat, o);
          const len = Math.hypot(o.u, o.v);
          const dx = (o.u / (len || 1)) * Math.min(26, 2 + len * 1.4);
          const dy = (-o.v / (len || 1)) * Math.min(26, 2 + len * 1.4);
          for (const s of [0, -ww]) {
            const x = x0 + s;
            if (x < -10 || x > proj.width + 10) continue;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + dx, y + dy);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(x, y, 1.4, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }

    if (layers.grid) {
      ctx.font = '10px monospace';
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
      ctx.fillStyle = 'rgba(203, 213, 225, 0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let lat = -80; lat <= 80; lat += 10) {
        const y = proj.screenY(lat);
        if (y < 0 || y > proj.height) continue;
        ctx.moveTo(0, y);
        ctx.lineTo(proj.width, y);
      }
      for (let lon = -180; lon < 180; lon += 10) {
        const x0 = sx(lon);
        for (const s of [0, -ww]) {
          const x = x0 + s;
          if (x < 0 || x > proj.width) continue;
          ctx.moveTo(x, 0);
          ctx.lineTo(x, proj.height);
        }
      }
      ctx.stroke();
      for (let lat = -80; lat <= 80; lat += 10) {
        const y = proj.screenY(lat);
        if (y > 12 && y < proj.height - 4) ctx.fillText(`${Math.abs(lat)}°${lat < 0 ? 'S' : lat > 0 ? 'N' : ''}`, 3, y - 2);
      }
      for (let lon = -180; lon < 180; lon += 10) {
        const x0 = sx(lon);
        for (const s of [0, -ww]) {
          const x = x0 + s;
          if (x > 18 && x < proj.width - 24) ctx.fillText(`${Math.abs(wrapLon(lon))}°${lon < 0 ? 'W' : lon > 0 ? 'E' : ''}`, x + 2, proj.height - 4);
        }
      }
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#fff';
      for (const m of MARKERS) {
        const y = proj.screenY(m.lat);
        const x0 = sx(m.lon);
        for (const s of [0, -ww]) {
          const x = x0 + s;
          if (x < -4 || x > proj.width + 4) continue;
          ctx.beginPath();
          ctx.arc(x, y, 4, 0, Math.PI * 2);
          ctx.moveTo(x - 8, y);
          ctx.lineTo(x + 8, y);
          ctx.moveTo(x, y - 8);
          ctx.lineTo(x, y + 8);
          ctx.stroke();
          ctx.fillText(m.name, x + 7, y - 6);
        }
      }
      ctx.fillStyle = 'rgba(203, 213, 225, 0.95)';
      ctx.font = '11px monospace';
      let ly = proj.height - 70;
      for (const c of contours) {
        ctx.fillStyle = c.color;
        ctx.fillRect(proj.width - 150, ly, 18, 3);
        ctx.fillStyle = 'rgba(203, 213, 225, 0.95)';
        ctx.fillText(`${c.m} m`, proj.width - 126, ly + 5);
        ly += 14;
      }
      const f = wind.field;
      ctx.fillText(`wind: GFS ${new Date(f.refTime * 1000).toISOString().slice(0, 13)}Z, ${f.nx}x${f.ny}`, proj.width - 250, proj.height - 84);
    }
  };

  for (const name of ['land', 'terrain', 'wind', 'grid'] as const) {
    const b = document.createElement('button');
    const label = () => `${layers[name] ? '☑' : '☐'} ${name}`;
    b.textContent = label();
    b.style.cssText = 'pointer-events:auto;background:#0f172a;color:#cbd5e1;border:1px solid #334155;padding:3px 7px;font:inherit;cursor:pointer';
    b.addEventListener('click', () => {
      layers[name] = !layers[name];
      b.textContent = label();
      lastKey = '';
    });
    bar.append(b);
  }
  const particles = document.createElement('button');
  particles.textContent = solo ? '☐ particles' : '☑ particles';
  particles.style.cssText = 'pointer-events:auto;background:#0f172a;color:#cbd5e1;border:1px solid #334155;padding:3px 7px;font:inherit;cursor:pointer';
  particles.addEventListener('click', () => {
    const hidden = opts.mainCanvas.style.visibility === 'hidden';
    opts.mainCanvas.style.visibility = hidden ? 'visible' : 'hidden';
    particles.textContent = `${hidden ? '☑' : '☐'} particles`;
  });
  bar.append(particles);

  let raf = 0;
  const loop = () => {
    draw();
    raf = requestAnimationFrame(loop);
  };
  loop();
  return {
    destroy() {
      cancelAnimationFrame(raf);
      canvas.remove();
      bar.remove();
    },
  };
}
