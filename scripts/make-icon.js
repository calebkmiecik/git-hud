// Generates a dependency-free 256x256 ICO (32-bit BGRA, single image).
// A dark rounded square with a green "clean" dot, echoing the HUD's status dot.
const fs = require('node:fs');
const path = require('node:path');

const W = 256, H = 256;
const BG = [0x30, 0x22, 0x1e, 0xff]; // #1e2230 as B,G,R,A
const FG = [0x50, 0xb9, 0x3f, 0xff]; // #3fb950 (clean-green)
const CLEAR = [0, 0, 0, 0];
const CX = 128, CY = 128, R_DOT = 70, R_CORNER = 56;

function outsideRounded(x, y) {
  let cx, cy;
  if (x < R_CORNER && y < R_CORNER) { cx = R_CORNER; cy = R_CORNER; }
  else if (x >= W - R_CORNER && y < R_CORNER) { cx = W - R_CORNER - 1; cy = R_CORNER; }
  else if (x < R_CORNER && y >= H - R_CORNER) { cx = R_CORNER; cy = H - R_CORNER - 1; }
  else if (x >= W - R_CORNER && y >= H - R_CORNER) { cx = W - R_CORNER - 1; cy = H - R_CORNER - 1; }
  else return false;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy > R_CORNER * R_CORNER;
}

function pixel(x, y) {
  if (outsideRounded(x, y)) return CLEAR;
  const dx = x - CX, dy = y - CY;
  if (dx * dx + dy * dy <= R_DOT * R_DOT) return FG;
  return BG;
}

// XOR bitmap, stored bottom-up.
const xor = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const [b, g, r, a] = pixel(x, y);
    const i = ((H - 1 - y) * W + x) * 4;
    xor[i] = b; xor[i + 1] = g; xor[i + 2] = r; xor[i + 3] = a;
  }
}
const andMask = Buffer.alloc((W / 8) * H, 0x00); // all-opaque (alpha drives transparency)

const bih = Buffer.alloc(40);
bih.writeUInt32LE(40, 0);   // biSize
bih.writeInt32LE(W, 4);     // biWidth
bih.writeInt32LE(H * 2, 8); // biHeight = XOR + AND
bih.writeUInt16LE(1, 12);   // biPlanes
bih.writeUInt16LE(32, 14);  // biBitCount
bih.writeUInt32LE(0, 16);   // biCompression = BI_RGB
bih.writeUInt32LE(0, 20);   // biSizeImage (0 allowed for BI_RGB)

const image = Buffer.concat([bih, xor, andMask]);

const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0); // reserved
dir.writeUInt16LE(1, 2); // type = icon
dir.writeUInt16LE(1, 4); // image count

const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0);                 // width 0 => 256
entry.writeUInt8(0, 1);                 // height 0 => 256
entry.writeUInt8(0, 2);                 // palette colors
entry.writeUInt8(0, 3);                 // reserved
entry.writeUInt16LE(1, 4);              // planes
entry.writeUInt16LE(32, 6);             // bit count
entry.writeUInt32LE(image.length, 8);   // bytes in resource
entry.writeUInt32LE(6 + 16, 12);        // offset to image

const ico = Buffer.concat([dir, entry, image]);
fs.writeFileSync(path.join(__dirname, '..', 'icon.ico'), ico);
console.log(`Wrote icon.ico (${ico.length} bytes)`);
