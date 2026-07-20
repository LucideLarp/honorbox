// Intrinsic pixel size of an image, read from its own header.
//
// Why this exists: an <img> with no width/height (or with the WRONG ones)
// gives the browser nothing to reserve, so everything below it jumps when the
// image finally loads. That is measurable — the product gallery on
// honorbox-pro.html scored CLS 0.14-0.28 on a throttled phone, over Google's
// 0.1 "good" threshold — and it is worst for exactly the reader we care about
// most: someone on a phone on a slow connection.
//
// The dimensions are read from the FILE rather than declared in config,
// because a declared number is a number that can drift. The showcase band had
// width="1360" height="900" on images that are actually 1200x630: an aspect
// ratio 26% wrong, reserving the wrong box.
//
// Zero dependencies, so the headers are parsed by hand. Only the formats this
// store actually ships are supported; anything else returns null and the
// caller simply omits the attributes, exactly as before.
'use strict';

// PNG: 8-byte signature, then the IHDR chunk (4 length + 4 type), so the
// big-endian width/height sit at fixed offsets 16 and 20.
function pngSize(b) {
  if (b.length < 24) return null;
  if (b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

// WebP: a RIFF container whose first chunk names the bitstream flavour, and
// each flavour stores the size differently. cwebp -lossless writes VP8L; the
// other two are here so a re-encode with different flags cannot silently
// start returning null.
function webpSize(b) {
  if (b.length < 30) return null;
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('ascii', 12, 16);

  if (chunk === 'VP8 ') {
    // Lossy. 8-byte chunk header, 3-byte frame tag, 3-byte sync code, then
    // two 16-bit little-endian fields whose low 14 bits are the dimensions.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    // Lossless. One signature byte, then 14 bits of (width-1) and 14 bits of
    // (height-1) packed little-endian.
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    // Extended (alpha/animation/metadata). Canvas size as two 24-bit
    // little-endian (value-1) fields.
    const u24 = (o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
    return { width: u24(24) + 1, height: u24(27) + 1 };
  }
  return null;
}

// Returns {width, height} or null. Null is not an error — it means "no
// intrinsic size to declare", which is the honest answer for an SVG, a remote
// URL, or a format we do not parse.
function imageSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  const size = pngSize(buf) || webpSize(buf);
  if (!size) return null;
  // A zero or absurd dimension is a corrupt header, not a size worth emitting.
  if (!(size.width > 0 && size.height > 0)) return null;
  return size;
}

module.exports = { imageSize, pngSize, webpSize };
