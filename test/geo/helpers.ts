import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');

export function readArrayBuffer(rel: string): ArrayBuffer {
  const b = readFileSync(join(root, rel));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export function readGunzipped(rel: string): Buffer {
  return gunzipSync(readFileSync(join(root, rel)));
}
