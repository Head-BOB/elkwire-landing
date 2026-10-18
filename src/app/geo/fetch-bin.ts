/**
 * Fetch a pre-gzipped data file (public/data/*.bin.gz) and inflate it in the browser, so the transfer size
 * is the same whatever the CDN decides to compress. If some layer already decoded it (no gzip magic),
 * the bytes are returned untouched.
 */
export async function fetchBinary(url: string, init?: RequestInit): Promise<ArrayBuffer> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buf = await response.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] === 0x1f && head[1] === 0x8b) {
    return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  return buf;
}
