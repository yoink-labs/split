import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const PHOTO_LIMIT = 240 * 1024;
const isJPEG = b => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b.at(-2) === 0xff && b.at(-1) === 0xd9;
// Receipts must be JPEGs under 240 KiB. On macOS, sips converts HEIC/PNG and shrinks large photos.
export async function photoData(path) {
  path = expand(path);
  const original = await readFile(path);
  if (isJPEG(original) && original.length <= PHOTO_LIMIT) return original.toString('base64');
  if (process.platform !== 'darwin') throw new Error(path + ' must be a JPEG up to 240 KiB.');
  const dir = await mkdtemp(join(tmpdir(), 'split-photo-'));
  try {
    const out = join(dir, 'receipt.jpg');
    for (const [size, quality] of [[2000, 75], [1600, 65], [1280, 55], [1024, 45], [800, 40]]) {
      const r = spawnSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), '-Z', String(size), path, '--out', out], { stdio: 'ignore' });
      if (r.status !== 0) throw new Error('Could not read ' + path + ' as an image.');
      const bytes = await readFile(out);
      if (isJPEG(bytes) && bytes.length <= PHOTO_LIMIT) return bytes.toString('base64');
    }
    throw new Error(path + ' is too detailed to fit in 240 KiB. Crop it and try again.');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const expand = path => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
// MCP clients on this computer may name a receipt file instead of sending base64. Base64 JPEG
// starts with "/9j/", so only short strings that name an existing file are read from disk.
export async function resolvePhotos(photos) {
  if (!Array.isArray(photos)) return photos;
  return Promise.all(photos.map(async value => {
    if (typeof value !== 'string' || value.length > 4096) return value;
    try { if ((await stat(expand(value))).isFile()) return await photoData(value); } catch {}
    return value;
  }));
}
