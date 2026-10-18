# elkwire-landing

Landing page for elkwire.com: one full-screen hero with an animated particle wind map, the wordmark
**ELKWIRE** and the subtitle `elkwire.com`. Angular 21 (SSR) + Tailwind 4, deployed on Vercel. The page
deliberately carries no other copy.

The map is geographically exact: coastline, terrain and wind are real data in the same real-world place.

## Run it

```bash
npm install            # .npmrc sets legacy-peer-deps (npm 10 trips over the Angular peer set otherwise)
npm run dev            # http://localhost:3000
npm run build          # production build (SSR). `prebuild` pulls the newest wind snapshot, see below
npm run lint
npm test               # Angular unit tests + the geo/data/sim tests (vitest, node)
```

Open `?debug=1` for the alignment overlay: elevation contours (1000/2000/4000 m) over the coastline, a
labelled 10 degree graticule, GFS wind arrows, reference markers (Kochi, Gibraltar, Cape Horn, Everest,
Kilimanjaro, Reykjavik) and layer toggles. `&layer=land|terrain|wind` shows one layer alone;
`&lon=180&latN=90&latS=-90` re-frames the view (antimeridian, poles). `?aq=0` disables adaptive quality.

## How the map works

* `src/app/geo/projection.ts` is the **only** place that converts lon/lat <-> pixels. Equirectangular,
  uniform scale, wraps in longitude, 75N..60S fitted to the viewport height. Desktop is centred on 30E;
  mobile pans slowly east to west.
* Land: Natural Earth 1:50m. Rings are unwrapped across the antimeridian and polar rings are closed along
  the pole, so no segment ever crosses the map. Land is visual only and exerts no force.
* Terrain: elevation on a 0.2 degree grid; the model removes the wind component into rising terrain,
  slows windward flow and channels it along ridges (`src/app/geo/terrain.ts`).
* Wind: NOAA GFS 10 m u/v (m/s), 1 degree, five 3-hourly frames (f000..f012), blended against the real clock
  (`src/app/geo/wind.ts`). Velocities get the 1/cos(lat) x-stretch so flow follows real trajectories.
* The baked wind+terrain field (`flow-bake.ts`) and the unchanged curl turbulence (`sim/noise.ts`) drive
  the particles (`sim/particles.ts`).

If the wind file fails to load or is stale, the last good data keeps showing. Nothing is ever synthesised.

## Data pipeline

All files live in `public/data` and are served same-origin, gzipped (`*.bin.gz`, inflated in the browser).

| File | Source | Rebuild |
|---|---|---|
| `land.bin.gz` (124 KB) | Natural Earth 1:50m via `world-atlas` | `npm run data:land` |
| `elevation.bin.gz` (444 KB) | AWS Terrain Tiles "terrarium", zoom 6 | `npm run data:terrain` (downloads ~4096 tiles into `.cache/`) |
| `wind.bin.gz` (594 KB) | NOAA GFS 1 degree | `npm run data:wind` (needs `pip install -r scripts/gfs/requirements.txt`) |

`data:terrain` also writes `test/fixtures/elevation-verify.bin.gz` (peak heights and land share, used only by
tests). `python scripts/gfs/fetch_gfs.py --verify-out test/fixtures/gfs-verify-1p00.bin` refreshes the GFS
orography and land-sea mask used to prove alignment; none of those are shipped to the browser.

Each loader documents the dataset's conventions (node vs cell centred, longitude range, row order) next to
the code; everything is normalised to lon -180..180, lat north-positive, rows north to south.

### Live wind

`.github/workflows/wind.yml` runs at 04:45, 10:45, 16:45 and 22:45 UTC (GFS cycles are published about
4.3 h after 00/06/12/18Z). It downloads GFS through the NOMADS grib filter (falling back to the AWS bucket
`noaa-gfs-bdp-pds`, then to the previous cycle), retries on 404, checks the result, force-pushes
`wind.bin.gz` as a single commit on the `wind-data` branch (so `main` history does not grow) and triggers a
Vercel deploy hook. At build time `scripts/fetch-wind-branch.mjs` copies that file into `public/data`; if the
branch is unreachable the committed snapshot is used. `ci.yml` also runs a daily watchdog that opens an
issue if the published snapshot is older than 36 h.

### One-time setup

1. GitHub: Settings -> Actions -> General -> Workflow permissions: **Read and write**.
2. Vercel: Project -> Settings -> Git -> Deploy Hooks: create one for `main`; add it as the repository
   secret `VERCEL_DEPLOY_HOOK`.
3. Run the `wind-data` workflow once (Actions -> Run workflow). Check the `wind-data` branch exists and a
   production deploy started.
4. Optional: in Vercel, add an Ignored Build Step so pushes to `wind-data` do not create preview deploys.

## Proving it is aligned

`npm test` includes `test/geo/alignment.spec.ts`: the Natural Earth polygons against the DEM land mask,
named summits against the DEM, and the GFS orography and land-sea mask (same grid as the wind) against the
DEM and the polygons, each with a +-3 cell shift search that must peak at zero. The numbers are printed in
the test output.

To compare with another viewer for the same moment, note the GFS reference time shown bottom-right in the
`?debug=1` overlay (e.g. `GFS 2026-10-18T12Z`), then open
`https://earth.nullschool.net/#2026/10/18/1200Z/wind/surface/level/equirectangular=-30,20,380` (edit date and
hour; add the forecast hour to the cycle for later frames), or in windy.com choose model GFS, wind, 10 m and
the same hour. Jets, the trades and the monsoon should match; small differences are expected (the page uses a
1 degree grid).

## Licence and attribution

No open-source licence is granted for the code in this repository. Data and third-party licences are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
