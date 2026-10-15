import { inflateSync } from "node:zlib";

/**
 * Minimal PNG reader + luminance metrics, used by the theme audit end-to-end
 * spec to check what the user actually sees.
 *
 * The previous theme audit was a throwaway script that measured screenshots.
 * Making it a permanent regression test needs those measurements inside the
 * test runner, and the runner has no image library available — so the few
 * parts of PNG we need (8-bit truecolour, non-interlaced, no ancillary
 * handling beyond skipping chunks) are implemented here with `node:zlib`.
 *
 * Deliberately strict: anything the decoder does not fully understand throws
 * instead of returning a plausible-looking wrong bitmap, because a silently
 * mis-decoded screenshot would make every luminance assertion meaningless.
 */

export type ChannelCount = 3 | 4;

export interface Bitmap {
  width: number;
  height: number;
  channels: ChannelCount;
  /** Row-major, 8 bits per channel, no padding between rows. */
  pixels: Uint8Array;
}

export interface PixelAudit {
  /** Mean WCAG relative luminance, 0 (black) … 1 (white). */
  meanLuminance: number;
  /** Share of pixels darker than the threshold, 0 … 1. */
  darkRatio: number;
}

/** A pixel at or below this luminance reads as "dark" to the eye. */
export const DEFAULT_DARK_BELOW = 0.35;

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

/** PNG filter type 4: the neighbour closest to the linear prediction `a + b - c`. */
export function paeth(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft;
  const pLeft = Math.abs(p - left);
  const pUp = Math.abs(p - up);
  const pUpLeft = Math.abs(p - upLeft);
  if (pLeft <= pUp && pLeft <= pUpLeft) return left;
  if (pUp <= pUpLeft) return up;
  return upLeft;
}

export function decodePng(file: Uint8Array): Bitmap {
  const buf = Buffer.isBuffer(file) ? file : Buffer.from(file);
  if (buf.length < SIGNATURE.length) throw new Error("not a PNG file");
  for (let i = 0; i < SIGNATURE.length; i += 1) {
    if (buf.readUInt8(i) !== SIGNATURE[i]) throw new Error("not a PNG file");
  }

  let offset = SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let sawHeader = false;
  const idat: Buffer[] = [];

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buf.length) throw new Error(`truncated PNG chunk: ${type}`);
    if (type === "IHDR") {
      if (length !== 13) throw new Error("malformed IHDR chunk");
      width = buf.readUInt32BE(start);
      height = buf.readUInt32BE(start + 4);
      bitDepth = buf.readUInt8(start + 8);
      colorType = buf.readUInt8(start + 9);
      interlace = buf.readUInt8(start + 12);
      sawHeader = true;
    } else if (type === "IDAT") {
      idat.push(buf.subarray(start, end));
    } else if (type === "IEND") {
      break;
    }
    offset = end + 4;
  }

  if (!sawHeader) throw new Error("PNG is missing IHDR");
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth: ${bitDepth}`);
  if (interlace !== 0) throw new Error("interlaced PNG is not supported");
  if (width === 0 || height === 0) throw new Error("PNG has no pixels");
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`unsupported PNG colour type: ${colorType}`);
  }
  if (idat.length === 0) throw new Error("PNG has no image data");

  const channels: ChannelCount = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) {
    throw new Error("PNG data is shorter than IHDR claims");
  }

  const pixels = new Uint8Array(stride * height);
  let previous = new Uint8Array(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw.readUInt8(y * (stride + 1));
    const lineStart = y * (stride + 1) + 1;
    const line = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const byte = raw.readUInt8(lineStart + x);
      const left = x >= channels ? line[x - channels] ?? 0 : 0;
      const up = previous[x] ?? 0;
      const upLeft = x >= channels ? previous[x - channels] ?? 0 : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = byte;
          break;
        case 1:
          value = byte + left;
          break;
        case 2:
          value = byte + up;
          break;
        case 3:
          value = byte + ((left + up) >> 1);
          break;
        case 4:
          value = byte + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`unknown PNG row filter: ${filter}`);
      }
      line[x] = value & 0xff;
    }
    pixels.set(line, y * stride);
    previous = line;
  }

  return { width, height, channels, pixels };
}

/** WCAG 2.1 relative luminance of an 8-bit sRGB triple. */
export function relativeLuminance(r: number, g: number, b: number): number {
  const linear = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** WCAG contrast ratio, 1 (identical) … 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a.r, a.g, a.b);
  const lb = relativeLuminance(b.r, b.g, b.b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export function auditPixels(bitmap: Bitmap, darkBelow: number = DEFAULT_DARK_BELOW): PixelAudit {
  const { width, height, channels, pixels } = bitmap;
  const count = width * height;
  let total = 0;
  let dark = 0;
  for (let i = 0; i < count; i += 1) {
    const base = i * channels;
    const luminance = relativeLuminance(
      pixels[base] ?? 0,
      pixels[base + 1] ?? 0,
      pixels[base + 2] ?? 0
    );
    total += luminance;
    if (luminance < darkBelow) dark += 1;
  }
  return { meanLuminance: total / count, darkRatio: dark / count };
}
