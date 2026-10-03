// 生成 build/icon.png —— 深色圆角底 + 紫色四角星（灵感火花），无第三方依赖
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const SS = 3; // 超采样抗锯齿

// ---------- 几何覆盖函数（返回 0~1 覆盖率） ----------
const smooth = (edge0, edge1, x) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

// 圆角矩形
function roundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(x1 - r, x));
  const cy = Math.max(y0 + r, Math.min(y1 - r, y));
  const dist = Math.hypot(x - cx, y - cy);
  return dist <= r - 0.5 ? 1 : dist >= r + 0.5 ? 0 : smooth(r + 0.5, r - 0.5, dist);
}

// 四角星（p=0.5 的 p-范数菱形，内凹出星形）
function sparkle(x, y, cx, cy, R) {
  const u = Math.abs(x - cx);
  const v = Math.abs(y - cy);
  const d = Math.sqrt(u) + Math.sqrt(v); // |x|^0.5 + |y|^0.5
  const edge = Math.sqrt(R);
  return d <= edge - 0.12 ? 1 : d >= edge + 0.12 ? 0 : smooth(edge + 0.12, edge - 0.12, d);
}

// ---------- 逐像素渲染 ----------
const pixels = Buffer.alloc(SIZE * SIZE * 4);

for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let bgCov = 0, starCov = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = px + (sx + 0.5) / SS;
        const y = py + (sy + 0.5) / SS;
        if (roundRect(x, y, 6, 6, 250, 250, 56) > 0.5) {
          bgCov++;
          const s =
            sparkle(x, y, 112, 116, 68) +
            sparkle(x, y, 178, 172, 32);
          if (s > 0.5) starCov++;
        }
      }
    }
    const total = SS * SS;
    const bg = bgCov / total;
    const star = starCov / total;
    const i = (py * SIZE + px) * 4;

    // 底 #2b2b2b，描边 #3f3f3f（靠内侧 3px 渐隐）
    let r = 43, g = 43, b = 43;
    const edgeDist = Math.min(px, py, SIZE - 1 - px, SIZE - 1 - py);
    if (edgeDist < 4) { r = 63; g = 63; b = 63; }

    // 星形 #a882ff 盖在底色上
    if (star > 0) {
      r = Math.round(r * (1 - star) + 168 * star);
      g = Math.round(g * (1 - star) + 130 * star);
      b = Math.round(b * (1 - star) + 255 * star);
    }
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = Math.round(bg * 255);
  }
}

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
// 10..12: compression, filter, interlace = 0

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('icon written:', out, `${png.length} bytes`);
