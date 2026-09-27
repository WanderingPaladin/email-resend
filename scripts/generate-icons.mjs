// Generates the placeholder app icons (assets/icon.png, assets/icon.ico) with no dependencies.
// Replace those files with your own artwork; see README "Application icon".
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / 256;
  const radius = 48 * s;
  const inRoundedRect = (x, y, x0, y0, x1, y1, r) => {
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= x0 && x <= x1 && y >= y0 && y <= y1;
  };
  const distToSegment = (x, y, ax, ay, bx, by) => {
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
    return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)));
  };
  // Envelope geometry in 256-space.
  const ex0 = 52 * s, ey0 = 76 * s, ex1 = 204 * s, ey1 = 180 * s, stroke = 10 * s;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const fx = x + 0.5, fy = y + 0.5;
      if (!inRoundedRect(fx, fy, 0, 0, size, size, radius)) continue;
      let [r, g, b] = [15, 23, 42]; // slate-900
      const onBorder =
        inRoundedRect(fx, fy, ex0, ey0, ex1, ey1, 8 * s) && !inRoundedRect(fx, fy, ex0 + stroke, ey0 + stroke, ex1 - stroke, ey1 - stroke, 2 * s);
      const midX = (ex0 + ex1) / 2, midY = ey0 + 62 * s;
      const onFlap =
        distToSegment(fx, fy, ex0 + stroke, ey0 + stroke, midX, midY) < stroke / 2 ||
        distToSegment(fx, fy, ex1 - stroke, ey0 + stroke, midX, midY) < stroke / 2;
      if (onBorder || onFlap) [r, g, b] = [255, 255, 255];
      const dot = Math.hypot(fx - 196 * s, fy - 72 * s) < 22 * s;
      if (dot) [r, g, b] = [16, 185, 129]; // emerald-500
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ICO with embedded PNG images (supported since Windows Vista).
function buildIco(sizes) {
  const images = sizes.map((size) => ({ size, data: drawIcon(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

writeFileSync(new URL('../assets/icon.png', import.meta.url), drawIcon(512));
writeFileSync(new URL('../assets/icon.ico', import.meta.url), buildIco([16, 24, 32, 48, 64, 128, 256]));
console.log('Wrote assets/icon.png and assets/icon.ico');
