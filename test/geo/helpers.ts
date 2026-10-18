import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');

/** Read a file; `.gz` files are inflated (the shipped data files are stored gzipped). */
export function readArrayBuffer(rel: string): ArrayBuffer {
  let b = readFileSync(join(root, rel));
  if (rel.endsWith('.gz')) b = gunzipSync(b);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export function readGunzipped(rel: string): Buffer {
  return gunzipSync(readFileSync(join(root, rel)));
}

/** Yielder for tests: never defer to the event loop. */
export const noYield = (): Promise<void> => Promise.resolve();
