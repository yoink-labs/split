import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';

const PHOTO_LIMIT = 240 * 1024;
const run = promisify(execFile);
const isJPEG = b => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b.at(-2) === 0xff && b.at(-1) === 0xd9;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const heicBrands = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const sizes = [[2200, 82], [1800, 75], [1500, 67], [1200, 58], [950, 48], [700, 40], [480, 35]];

function imageFormat(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.subarray(0, 8).equals(pngSignature)) return 'png';
  if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    if (heicBrands.has(bytes.toString('ascii', 8, 12))) return 'heic';
    const end = Math.min(bytes.readUInt32BE(0), bytes.length, 256);
    for (let offset = 16; offset + 4 <= end; offset += 4) {
      if (heicBrands.has(bytes.toString('ascii', offset, offset + 4))) return 'heic';
    }
  }
}

export async function photoData(path) {
  path = expand(path);
  const original = await readFile(path);
  if (extname(path).toLowerCase() === '.pdf' || original.subarray(0, 5).toString() === '%PDF-') {
    throw new Error('PDF receipts are unsupported. Convert the PDF to a JPEG and try again.');
  }
  const format = imageFormat(original);
  if (!format) throw new Error('Could not read ' + path + ' as a JPEG, PNG or HEIC image.');
  if (format === 'jpeg' && original.length <= PHOTO_LIMIT && isJPEG(original)) return original.toString('base64');

  const dir = await mkdtemp(join(tmpdir(), 'split-photo-'));
  try {
    // Use a fixed local name and explicit format so an input path cannot be parsed
    // as an ImageMagick option, URL, or instruction to select another coder.
    const input = 'original.' + format;
    const output = 'receipt.jpg';
    await writeFile(join(dir, input), original);
    const magickArgs = (size, quality) => [
      '-limit', 'thread', '2', '-limit', 'disk', '512MiB',
      format + ':' + input + '[0]', '-auto-orient', '-resize', size + 'x' + size + '>',
      '-background', 'white', '-alpha', 'remove', '-alpha', 'off', '-strip',
      '-quality', String(quality), 'jpeg:' + output,
    ];
    const converters = [['magick', magickArgs]];
    if (process.platform !== 'win32') converters.push(['convert', magickArgs]);
    if (process.platform === 'darwin') {
      converters.push(['/usr/bin/sips', (size, quality) => [
        '-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality),
        '-Z', String(size), input, '--out', output,
      ]]);
    }
    let available = false;
    for (const [command, args] of converters) {
      for (const [size, quality] of sizes) {
        await rm(join(dir, output), { force: true });
        try {
          await run(command, args(size, quality), { cwd: dir, windowsHide: true, timeout: 60_000 });
        } catch (error) {
          if (error.code !== 'ENOENT') available = true;
          break;
        }
        available = true;
        const bytes = await readFile(join(dir, output)).catch(error => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        if (bytes && isJPEG(bytes) && bytes.length <= PHOTO_LIMIT) return bytes.toString('base64');
      }
    }
    if (!available) {
      throw new Error('Photo conversion requires ImageMagick on PATH. Install ImageMagick with HEIC support, then retry --photo.');
    }
    throw new Error('Could not convert ' + path + ' to a JPEG up to 240 KiB. Check that the file opens and that ImageMagick supports ' + format.toUpperCase() + '.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const expand = path => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
// MCP clients on this computer may name a receipt file instead of sending base64. Base64 JPEG
// starts with "/9j/", so only short strings that name an existing file are read from disk.
export async function resolvePhotos(photos) {
  if (!Array.isArray(photos)) return photos;
  return Promise.all(photos.map(async value => {
    if (typeof value !== 'string' || value.length > 4096) return value;
    const info = await stat(expand(value)).catch(() => null);
    return info?.isFile() ? photoData(value) : value;
  }));
}
