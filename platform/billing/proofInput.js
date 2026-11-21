import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { need } from './rules.js';
export const MAX_BYTES = 2 * 1024 * 1024,
  source = Symbol('field origin');
function jpegSize(b) {
  let pos = 2;
  while (pos + 9 < b.length && b[pos] === 255) {
    const tag = b[pos + 1],
      len = b.readUInt16BE(pos + 2);
    if ([0xc0, 0xc1, 0xc2].includes(tag)) return [b.readUInt16BE(pos + 5), b.readUInt16BE(pos + 7)];
    if (len < 2) break;
    pos += 2 + len;
  }
  return [];
}
export function attachment(file) {
  need(
    typeof file === 'string' && file.length <= 4 * Math.ceil(MAX_BYTES / 3) && /^[\da-z+/]+=*$/i.test(file),
    'invalid_file'
  );
  const bytes = Buffer.from(file, 'base64');
  need(bytes.length <= MAX_BYTES, 'file_too_large', 413);
  if (bytes.subarray(0, 5).toString() === '%PDF-' && bytes.subarray(-1024).includes(Buffer.from('%%EOF')))
    return { bytes, kind: 'pdf' };
  let kind, w, h;
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  ) {
    kind = 'png';
    w = bytes.readUInt32BE(16);
    h = bytes.readUInt32BE(20);
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    kind = 'jpeg';
    [w, h] = jpegSize(bytes);
  } else need(false, 'expected_png_jpeg_pdf');
  need(w && h && w <= 4096 && h <= 4096 && w * h <= 6000000, 'image_dimensions');
  return { bytes, kind };
}
let busy = 0;
// Read actual first-page text where available. Raster OCR is optional, local only;
// a failed reader never upgrades the evidence source to 'document text'.
export async function prepareUpload(input) {
  if (!input.file) return input;
  const { kind, bytes } = attachment(input.file);
  need(busy < 2, 'proof_reader_busy', 429);
  busy++;
  try {
    const pdf = kind === 'pdf';
    const text = await new Promise((resolve) => {
      const p = spawn(
        pdf ? process.execPath : 'tesseract',
        pdf
          ? ['--max-old-space-size=96', fileURLToPath(new URL('pdfText.js', import.meta.url))]
          : ['stdin', 'stdout', '--psm', '6'],
        { env: { PATH: process.env.PATH, OMP_THREAD_LIMIT: '1' }, stdio: ['pipe', 'pipe', 'ignore'] }
      );
      const chunks = [];
      let size = 0;
      const timer = setTimeout(() => p.kill('SIGKILL'), 4000);
      p.on('error', () => {
        clearTimeout(timer);
        resolve('');
      });
      p.stdin.on('error', () => {});
      p.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 16384) chunks.push(chunk);
        else p.kill('SIGKILL');
      });
      p.on('close', (code) => {
        clearTimeout(timer);
        resolve(
          code === 0 && size <= 16384 ? Buffer.concat(chunks).toString('utf8').trim().slice(0, 4096) : ''
        );
      });
      p.stdin.end(bytes);
    });
    if (text.length >= 4)
      return { ...input, text, [source]: pdf ? 'first-page PDF text' : 'local image OCR' };
    need(typeof input.text === 'string' && input.text.trim().length >= 4, 'unreadable_add_redacted_text');
    return input;
  } finally {
    busy--;
  }
}
