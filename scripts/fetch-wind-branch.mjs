// Runs before `npm run build` (prebuild). Pulls the newest wind.bin.gz that the "wind-data" workflow
// published to the single-commit `wind-data` branch and drops it into public/data, so Vercel serves it
// same-origin. If the branch is unreachable, invalid or older than the committed snapshot, the committed
// snapshot is kept: the build never fails and never ships fake data.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const REPO = process.env.WIND_REPO ?? 'Head-BOB/elkwire-landing';
const URL = `https://raw.githubusercontent.com/${REPO}/wind-data/wind.bin.gz`;
const TARGET = 'public/data/wind.bin.gz';
const REF_OFFSET = 26; // "ELKW"(4) ver(1) nFrames(1) nx(2) ny(2) lon0 lat0 dlon dlat (16) -> u32 refTime

const refTime = (gz) => {
  try {
    const buf = gunzipSync(gz);
    return buf.length > REF_OFFSET + 4 && buf.toString('ascii', 0, 4) === 'ELKW' ? buf.readUInt32LE(REF_OFFSET) : -1;
  } catch {
    return -1;
  }
};

if (process.env.SKIP_WIND_FETCH) {
  console.log('[wind] SKIP_WIND_FETCH set, keeping committed snapshot');
} else {
  try {
    const res = await fetch(URL, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const incoming = refTime(buf);
    const current = existsSync(TARGET) ? refTime(readFileSync(TARGET)) : -1;
    if (incoming < 0) throw new Error('not a valid wind.bin.gz');
    if (incoming > current) {
      writeFileSync(TARGET, buf);
      console.log(`[wind] updated from wind-data branch (ref ${new Date(incoming * 1000).toISOString()})`);
    } else {
      console.log('[wind] committed snapshot is already the newest');
    }
  } catch (e) {
    console.warn(`[wind] could not fetch wind-data branch (${e.message}); keeping committed snapshot`);
  }
}
