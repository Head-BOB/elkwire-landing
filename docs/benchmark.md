# Performance record

Environment: headless Chromium (software rendering, no GPU), 1920x1080, DPR 1, 2500 particles, adaptive
quality off (`?aq=0`) so particle count is identical. Same machine, same session for the A/B rows.

## Same-session A/B (original build vs this branch), per frame, 10 s sample

| | CPU x1 script | CPU x1 total task | CPU x4 script | CPU x4 total task | fps x1 |
|---|---|---|---|---|---|
| original (c0caed6) | 6.07 ms | 14.69 ms | 25.95 ms | 67.40 ms | 59.6 |
| this branch | 3.82 ms (-37%) | 11.98 ms (-18%) | 15.18 ms (-41%) | 74.17 ms | 60.1 |

"Total task" includes software canvas rasterisation (full-screen fade, land blit, strokes), which a GPU
browser does not pay on the main thread and which cannot shrink without changing the look. JavaScript is now
about 23% of a 60 fps frame, so a Worker/OffscreenCanvas or WebGL port is not justified.

## rAF frame-time percentiles (scripts/capture.mjs --bench)

| run | p50 | p95 | p99 | fps |
|---|---|---|---|---|
| original, recorded in `baseline/bench.json` (machine was busier) | 33.2 ms | 33.4 ms | 50.1 ms | 38.7 |
| original, 4x CPU throttle | 66.7 ms | 116.7 ms | 133.4 ms | 13.5 |
| this branch | 16.7 ms | 16.8 ms | 16.8 ms | 59.8 |
| this branch, 4x CPU throttle | 66.7 ms | 116.7 ms | 199.9 ms | 12.7 |

The first row was recorded before the same-session A/B above and is not comparable to it: when re-measured
later the original also reached ~60 fps. Under 4x throttling this software-rendered environment is limited by
canvas rasterisation, so the percentiles do not move.

## Exactness checks (tests, not benchmarks)

* `test/sim/noise.spec.ts`: the cached curl noise is bit-identical to a verbatim copy of the original over
  120,000 positions, five viewport sizes and uptimes up to 11 days.
* `test/sim/batching.spec.ts`: bucketed strokes vs per-particle strokes after 120 frames of trail
  accumulation: mean |diff| 0.03/255, 0.02% of pixels differ by more than 8 levels (max 25).
