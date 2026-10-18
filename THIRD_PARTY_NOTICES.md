# Third-party notices

## Data

**NOAA / NCEP Global Forecast System (GFS)** - 10 m wind, surface orography and land-sea mask. Produced by
the U.S. National Weather Service, NOAA. Works of the U.S. Government are in the public domain; NOAA asks
that the source be credited. Retrieved via NOMADS (https://nomads.ncep.noaa.gov) and the NOAA Open Data
Dissemination bucket `noaa-gfs-bdp-pds`.

**Natural Earth** - 1:50m land polygons (https://www.naturalearthdata.com), public domain. Distributed through
the `world-atlas` npm package (ISC).

**Elevation: AWS Terrain Tiles ("terrarium")** (https://registry.opendata.aws/terrain-tiles/), accessed from
`s3.amazonaws.com/elevation-tiles-prod`. The tiles are a composite of public datasets; at the zoom level
used here (6) they come from the global sources:

* ETOPO1 Global Relief Model - NOAA National Centers for Environmental Information
* GMTED2010 - U.S. Geological Survey and the National Geospatial-Intelligence Agency
* SRTM - NASA / USGS

Regional high-resolution sources are only used at much higher zoom levels. The complete and current
attribution list is maintained at https://github.com/tilezen/joerd/blob/master/docs/attribution.md and
applies to the derived `public/data/elevation.bin.gz`. Note: over the Greenland and Antarctic ice sheets
these tiles carry sub-ice bedrock rather than the ice-surface height.

## Font

**Montserrat** (weights 500 and 700, latin subset) - Copyright The Montserrat Project Authors
(https://github.com/JulietaUla/Montserrat), SIL Open Font License 1.1
(https://openfontlicense.org). Files obtained from the `@fontsource/montserrat` package.

## Software

Runtime: Angular (MIT), RxJS (Apache-2.0), Express (MIT), Motion (MIT), Tailwind CSS (MIT), tslib (0BSD).
Build and test only (not shipped): topojson-client and world-atlas (ISC), pngjs (MIT), Playwright
(Apache-2.0), @napi-rs/canvas (MIT), vitest (MIT), ESLint and typescript-eslint (MIT / Apache-2.0).
