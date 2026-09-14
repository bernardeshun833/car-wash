#!/usr/bin/env node
// Generates the PWA icons. Run with `node scripts/make-icons.mjs`.
// PNG encoding is hand-rolled so the repo needs no image dependency for two
// files that change roughly never.

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const BG = [17, 24, 39]; // gray-900, matches theme_color
const FG = [56, 189, 248]; // sky-400 — water

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * A water droplet. Chosen because it survives being 48px on a tablet home
 * screen, which is the only size that matters in practice.
 */
function pixel(x, y, size) {
  const u = (x + 0.5) / size;
  const v = (y + 0.5) / size;

  // Circle forming the body of the drop.
  const cx = 0.5;
  const cy = 0.62;
  const r = 0.26;
  const inCircle = (u - cx) ** 2 + (v - cy) ** 2 <= r * r;

  // Triangle forming the point, tapering up to the top.
  const tipY = 0.16;
  const inTip =
    v >= tipY && v <= cy && Math.abs(u - cx) <= (r * (v - tipY)) / (cy - tipY);

  return inCircle || inTip ? FG : BG;
}

function png(size) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y, size);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

for (const size of [192, 512]) {
  writeFileSync(new URL(`../public/pwa-${size}.png`, import.meta.url), png(size));
  console.log(`wrote public/pwa-${size}.png`);
}
