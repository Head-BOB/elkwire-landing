// Visual + performance capture. Usage:
//   node scripts/capture.mjs <label> [baseUrl] [--video] [--bench] [--query=?debug=1]
// Writes docs/<label>/*.png and docs/<label>/bench.json; video goes to $CAPTURE_VIDEO_DIR.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const [label = 'baseline', baseUrl = 'http://localhost:4000'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const query = (flags.find((f) => f.startsWith('--query=')) ?? '--query=').slice(8);
const wantVideo = flags.includes('--video');
const wantBench = flags.includes("--bench");
const outDir = join('docs', label);
mkdirSync(outDir, { recursive: true });

const SIZES = [
  { name: '1920x1080', width: 1920, height: 1080, touch: false },
  { name: '1366x768', width: 1366, height: 768, touch: false },
  { name: '390x844', width: 390, height: 844, touch: true },
];
const TIMES = [500, 3000, 6000];
const origins = new Set();

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });

for (const s of SIZES) {
  const ctx = await browser.newContext({
    viewport: { width: s.width, height: s.height },
    hasTouch: s.touch,
    isMobile: s.touch,
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  page.on('request', (r) => origins.add(new URL(r.url()).origin));
  await page.goto(baseUrl + query, { waitUntil: 'load' });
  let last = 0;
  for (const t of TIMES) {
    await page.waitForTimeout(t - last);
    last = t;
    await page.screenshot({ path: join(outDir, `${s.name}-t${t}.png`) });
  }
  await ctx.close();
}

// Mouse-interaction screenshot (desktop): reticle + push/swirl.
{
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  await page.goto(baseUrl + query, { waitUntil: 'load' });
  await page.waitForTimeout(4000);
  await page.mouse.move(600, 400);
  await page.mouse.move(900, 600, { steps: 20 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(outDir, '1920x1080-mouse.png') });
  await ctx.close();
}

if (wantBench) {
  const bench = {};
  for (const throttle of [1, 4]) {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    await page.goto(baseUrl + query, { waitUntil: 'load' });
    await page.waitForTimeout(3000);
    const times = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const ts = [];
          const end = performance.now() + 10000;
          const tick = (now) => {
            ts.push(now);
            if (now < end) requestAnimationFrame(tick);
            else resolve(ts);
          };
          requestAnimationFrame(tick);
        }),
    );
    const d = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
    const q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))];
    bench[`cpu${throttle}x`] = {
      frames: d.length,
      p50_ms: +q(0.5).toFixed(2),
      p95_ms: +q(0.95).toFixed(2),
      p99_ms: +q(0.99).toFixed(2),
      fps: +(1000 / (d.reduce((a, b) => a + b, 0) / d.length)).toFixed(1),
    };
    await ctx.close();
  }
  writeFileSync(join(outDir, 'bench.json'), JSON.stringify(bench, null, 2));
  console.log(bench);
}

if (wantVideo) {
  const dir = process.env.CAPTURE_VIDEO_DIR ?? '/tmp';
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir, size: { width: 1920, height: 1080 } },
  });
  const page = await ctx.newPage();
  await page.goto(baseUrl + query, { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  // Scripted mouse path: sweep across the wordmark, then a circle.
  await page.mouse.move(200, 300);
  await page.mouse.move(1700, 300, { steps: 90 });
  await page.mouse.move(1700, 800, { steps: 40 });
  for (let a = 0; a < 360; a += 6) {
    await page.mouse.move(960 + 400 * Math.cos((a * Math.PI) / 180), 540 + 250 * Math.sin((a * Math.PI) / 180));
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(2000);
  const video = page.video();
  await ctx.close();
  const path = await video.path();
  renameSync(path, join(dir, `${label}.webm`));
  console.log('video:', join(dir, `${label}.webm`));
}

await browser.close();
console.log('network origins:', [...origins]);
