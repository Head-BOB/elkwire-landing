#!/usr/bin/env python3
"""Fetch NOAA GFS 10 m wind and write the compact browser file public/data/wind.bin.gz.

SOURCE CONVENTION (GFS 0.5 deg shown, 1 deg is identical in layout; verified on live files): Ni=720 columns, lon 0..359.5 (the 360
column is NOT repeated), Nj=361 rows, lat 90..-90 (north to south, jScansPositively=0), values at grid
NODES (not cell centres). u/v are m/s, positive east / north.

OUTPUT CONVENTION: node-centred, columns rotated so longitude starts at -180 (-180..179.5), rows north to
south (lat 90..-90). Readers wrap between the last and the first column and clamp at the poles.

wind.bin layout (little endian; the shipped file is this, gzipped with mtime=0 so it is reproducible):
  "ELKW" | u8 version=1 | u8 nFrames | u16 nx | u16 ny
  f32 lon0 | f32 lat0 | f32 dlon | f32 dlat          (dlat is negative: rows run north to south)
  u32 refTime (unix s, model cycle) | f32 step (m/s per int16 unit)
  nFrames * u32 validTime (unix s)
  then per frame: u plane, v plane, each nx*ny int16, row-wise horizontal deltas (wrapping)

Primary source: NOMADS grib filter. Fallback: AWS open data bucket noaa-gfs-bdp-pds (HTTP range reads
guided by the .idx). With --verify-out, GFS surface orography (HGT) and land-sea mask (LAND) on the same
grid are written for the alignment tests; they are never shipped to the browser.
"""
import argparse
import datetime as dt
import gzip
import os
import struct
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

import eccodes
import numpy as np

NOMADS = "https://nomads.ncep.noaa.gov/cgi-bin"
AWS = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
MIN_AGE_H = 4.5


def http_get(url, headers=None, timeout=120):
    req = urllib.request.Request(url, headers=headers or {"User-Agent": "elkwire-landing-wind/1"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def retry(fn, tries, delay, what):
    last = None
    for i in range(tries):
        try:
            return fn()
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:  # 404 is a URLError (HTTPError)
            last = e
            print(f"  {what}: attempt {i + 1}/{tries} failed ({e})", file=sys.stderr)
            if i + 1 < tries:
                time.sleep(delay)
    raise last


def nomads_url(res, cycle, step, params):
    ymd, hh = cycle.strftime("%Y%m%d"), cycle.strftime("%H")
    if res == "0p50":
        script, name = "filter_gfs_0p50.pl", f"gfs.t{hh}z.pgrb2full.0p50.f{step:03d}"
    else:
        script, name = "filter_gfs_1p00.pl", f"gfs.t{hh}z.pgrb2.1p00.f{step:03d}"
    q = {"dir": f"/gfs.{ymd}/{hh}/atmos", "file": name, **params}
    return f"{NOMADS}/{script}?{urllib.parse.urlencode(q)}"


def aws_fetch(res, cycle, step, wanted, tries, delay):
    """Range-read only the wanted records (e.g. 'UGRD:10 m above ground') from the AWS bucket."""
    ymd, hh = cycle.strftime("%Y%m%d"), cycle.strftime("%H")
    base = f"{AWS}/gfs.{ymd}/{hh}/atmos/gfs.t{hh}z.pgrb2.{res}.f{step:03d}"
    idx = retry(lambda: http_get(base + ".idx").decode(), tries, delay, "aws idx").splitlines()
    rows = [l.split(":") for l in idx]
    starts = [int(r[1]) for r in rows]
    out = b""
    for want in wanted:
        for n, r in enumerate(rows):
            if f"{r[3]}:{r[4]}" == want:
                end = starts[n + 1] - 1 if n + 1 < len(rows) else ""
                out += retry(
                    lambda: http_get(base, headers={"Range": f"bytes={starts[n]}-{end}"}),
                    tries, delay, f"aws {want}",
                )
                break
        else:
            raise RuntimeError(f"{want} not in {base}.idx")
    return out


def fetch_grib(res, cycle, step, kind, tries, delay):
    """kind='wind' -> UGRD/VGRD 10 m; kind='static' -> HGT/LAND surface."""
    if kind == "wind":
        params = {"var_UGRD": "on", "var_VGRD": "on", "lev_10_m_above_ground": "on"}
        wanted = ["UGRD:10 m above ground", "VGRD:10 m above ground"]
    else:
        params = {"var_HGT": "on", "var_LAND": "on", "lev_surface": "on"}
        wanted = ["HGT:surface", "LAND:surface"]
    try:
        data = retry(lambda: http_get(nomads_url(res, cycle, step, params)), tries, delay, "nomads")
        if data[:4] != b"GRIB":
            raise urllib.error.URLError(f"not a GRIB response: {data[:80]!r}")
        return data
    except urllib.error.URLError as e:
        print(f"  NOMADS failed ({e}); falling back to AWS", file=sys.stderr)
        return aws_fetch(res, cycle, step, wanted, tries, delay)


def decode(data):
    """Return {name: (2D float32 array [ny, nx] in output convention)}, plus grid dict and ref time."""
    with tempfile.NamedTemporaryFile(suffix=".grb") as f:
        f.write(data)
        f.flush()
        fields, grid, ref = {}, None, None
        with open(f.name, "rb") as fh:
            while True:
                h = eccodes.codes_grib_new_from_file(fh)
                if h is None:
                    break
                g = lambda k: eccodes.codes_get(h, k)
                ni, nj = g("Ni"), g("Nj")
                assert g("jScansPositively") == 0 and g("iScansNegatively") == 0, "unexpected scan order"
                assert g("latitudeOfFirstGridPointInDegrees") == 90.0 and g("longitudeOfFirstGridPointInDegrees") == 0.0
                dlon = g("iDirectionIncrementInDegrees")
                assert abs(ni * dlon - 360) < 1e-6, "360 column unexpectedly repeated"
                vals = eccodes.codes_get_values(h).astype(np.float32).reshape(nj, ni)
                # 0..360 -> -180..180: rotate so column 0 is lon -180.
                vals = np.roll(vals, ni // 2, axis=1)
                name = g("shortName")
                if name not in ("10u", "10v"):
                    name = "hgt" if "eight" in g("name") or "rograph" in g("name") else "land"
                fields[name] = vals
                grid = dict(nx=ni, ny=nj, lon0=-180.0, lat0=90.0, dlon=float(dlon), dlat=-float(g("jDirectionIncrementInDegrees")))
                d, t = g("dataDate"), g("dataTime")
                ref = dt.datetime.strptime(f"{d:08d}{t:04d}", "%Y%m%d%H%M").replace(tzinfo=dt.timezone.utc)
                eccodes.codes_release(h)
    return fields, grid, ref


def sanity(u, v, grid):
    assert np.isfinite(u).all() and np.isfinite(v).all(), "non-finite wind"
    assert max(np.abs(u).max(), np.abs(v).max()) < 120, "implausible wind speed"
    lats = grid["lat0"] + grid["dlat"] * np.arange(grid["ny"])
    zonal = lambda lat: float(u[int(np.argmin(np.abs(lats - lat)))].mean())
    z15, z45 = zonal(15), zonal(45)
    assert z15 < 0 < z45, f"flow check failed: zonal-mean u at 15N={z15:.2f}, 45N={z45:.2f}"
    print(f"  sanity ok: zonal-mean u 15N={z15:.2f} m/s, 45N={z45:.2f} m/s")


def delta16(a, step):
    q = np.clip(np.round(a / step), -32768, 32767).astype(np.int32)
    d = np.diff(q, axis=1, prepend=0).astype(np.int32)
    return ((d + 32768) % 65536 - 32768).astype("<i2")


def write_wind(path, grid, ref, steps, frames, quant):
    header = b"ELKW" + struct.pack("<BBHH", 1, len(frames), grid["nx"], grid["ny"])
    header += struct.pack("<ffff", grid["lon0"], grid["lat0"], grid["dlon"], grid["dlat"])
    header += struct.pack("<If", int(ref.timestamp()), quant)
    header += b"".join(struct.pack("<I", int(ref.timestamp()) + s * 3600) for s in steps)
    body = b"".join(delta16(f[k], quant).tobytes() for f in frames for k in ("10u", "10v"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    raw = header + body
    with open(path, "wb") as fh:
        fh.write(gzip.compress(raw, 9, mtime=0))
    return len(raw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="public/data/wind.bin.gz")
    ap.add_argument("--res", default="1p00", choices=["0p50", "1p00"])
    ap.add_argument("--frames", type=int, default=5, help="3-hourly frames starting at f000 (5 -> f000..f012)")
    ap.add_argument("--quant", type=float, default=0.1, help="m/s per int16 unit")
    ap.add_argument("--tries", type=int, default=3)
    ap.add_argument("--delay", type=float, default=60.0, help="seconds between retries (404 = cycle not ready)")
    ap.add_argument("--older-cycles", type=int, default=3, help="how many older cycles to fall back to")
    ap.add_argument("--verify-out", help="also write GFS surface HGT + LAND (verification only)")
    a = ap.parse_args()

    now = dt.datetime.now(dt.timezone.utc)
    latest = (now - dt.timedelta(hours=MIN_AGE_H)).replace(minute=0, second=0, microsecond=0)
    latest = latest.replace(hour=latest.hour - latest.hour % 6)
    steps = [3 * i for i in range(a.frames)]

    for back in range(a.older_cycles + 1):
        cycle = latest - dt.timedelta(hours=6 * back)
        print(f"cycle {cycle:%Y-%m-%d %HZ}")
        try:
            frames, grid, ref = [], None, None
            for s in steps:
                print(f" f{s:03d}")
                fields, grid, ref = decode(fetch_grib(a.res, cycle, s, "wind", a.tries, a.delay))
                frames.append(fields)
            break
        except (urllib.error.URLError, RuntimeError, TimeoutError) as e:
            print(f"cycle {cycle:%HZ} unavailable: {e}", file=sys.stderr)
    else:
        sys.exit("no GFS cycle available")

    assert ref == cycle
    sanity(frames[0]["10u"], frames[0]["10v"], grid)
    size = write_wind(a.out, grid, ref, steps, frames, a.quant)
    gz = os.path.getsize(a.out)
    print(f"wrote {a.out}: {size} bytes raw, {gz} gzipped, {grid['nx']}x{grid['ny']}, {len(frames)} frames, ref {ref:%Y-%m-%dT%H:%MZ}")

    if a.verify_out:
        fields, g2, _ = decode(fetch_grib(a.res, cycle, 0, "static", a.tries, a.delay))
        assert g2 == grid
        hdr = b"ELKV" + struct.pack("<BHH", 1, grid["nx"], grid["ny"]) + struct.pack("<ffff", grid["lon0"], grid["lat0"], grid["dlon"], grid["dlat"])
        with open(a.verify_out, "wb") as fh:
            fh.write(hdr + fields["hgt"].astype("<f4").tobytes() + (fields["land"] > 0.5).astype("u1").tobytes())
        print(f"wrote {a.verify_out}")


if __name__ == "__main__":
    main()
