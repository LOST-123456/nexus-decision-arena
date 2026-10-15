import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  auditPixels,
  contrastRatio,
  decodePng,
  paeth,
  relativeLuminance,
  type ChannelCount
} from "./png-luminance";

/**
 * The end-to-end theme audit trusts these metrics to decide whether the user
 * is looking at a light page or a dark one, so the decoder is tested against
 * hand-computed PNG bytes rather than against its own encoder.
 *
 * CRC values are left as zero: the decoder deliberately does not verify them
 * (an audit does not need integrity checking, and Playwright always writes
 * well-formed files). Everything else — filters included — must be exact.
 */

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  return Buffer.concat([head, data, crc]);
}

interface Row {
  filter: number;
  bytes: number[];
}

function buildPng(width: number, height: number, channels: ChannelCount, rows: Row[]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(channels === 4 ? 6 : 2, 9);
  const raw = Buffer.concat(
    rows.map((row) => Buffer.from([row.filter, ...row.bytes]))
  );
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/** A flat image of `rgb`, plain filter 0 rows. */
function solidPng(
  width: number,
  height: number,
  rgb: [number, number, number],
  filter = 0
): Buffer {
  const bytes = Array.from({ length: width }, () => [...rgb]).flat();
  // Filter 0 is the only one whose payload equals the pixels, so solid images
  // always use it; the filter matrix below covers the other four.
  if (filter !== 0) throw new Error("solidPng only supports filter 0");
  return buildPng(width, height, 3, Array.from({ length: height }, () => ({ filter, bytes })));
}

describe("decodePng", () => {
  it("recovers the same picture through every PNG row filter", () => {
    // Two pixels repeated on every row: (10,20,30) and (40,50,60).
    const rows: Row[] = [
      { filter: 0, bytes: [10, 20, 30, 40, 50, 60] },
      { filter: 1, bytes: [10, 20, 30, 30, 30, 30] },
      { filter: 2, bytes: [0, 0, 0, 0, 0, 0] },
      { filter: 3, bytes: [5, 10, 15, 15, 15, 15] },
      { filter: 4, bytes: [0, 0, 0, 0, 0, 0] }
    ];

    const bitmap = decodePng(buildPng(2, 5, 3, rows));

    expect(bitmap.width).toBe(2);
    expect(bitmap.height).toBe(5);
    expect(bitmap.channels).toBe(3);
    expect(Array.from(bitmap.pixels)).toEqual(
      Array.from({ length: 5 }, () => [10, 20, 30, 40, 50, 60]).flat()
    );
  });

  it("keeps alpha bytes and row padding in place", () => {
    const rgba = buildPng(1, 2, 4, [
      { filter: 0, bytes: [1, 2, 3, 4] },
      { filter: 0, bytes: [5, 6, 7, 8] }
    ]);

    const bitmap = decodePng(rgba);

    expect(bitmap.channels).toBe(4);
    expect(Array.from(bitmap.pixels)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("refuses input it cannot decode exactly", () => {
    expect(() => decodePng(Buffer.from("not a png at all"))).toThrow(/not a PNG/);

    const solid = solidPng(2, 2, [1, 2, 3]);
    expect(() => decodePng(solid.subarray(0, 20))).toThrow(/truncated PNG chunk/);

    const grey = Buffer.from([
      137, 80, 78, 71, 13, 10, 26, 10,
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
      0, 0, 0, 1, 0, 0, 0, 1,
      8, 0, 0, 0, 0, 0, 0, 0, 0
    ]);
    expect(() => decodePng(grey)).toThrow(/unsupported PNG colour type/);
  });
});

describe("auditPixels", () => {
  it("reports a white page as bright and a black one as dark", () => {
    const white = auditPixels(decodePng(solidPng(4, 4, [255, 255, 255])));
    expect(white.meanLuminance).toBeCloseTo(1, 5);
    expect(white.darkRatio).toBe(0);

    const black = auditPixels(decodePng(solidPng(4, 4, [0, 0, 0])));
    expect(black.meanLuminance).toBeCloseTo(0, 5);
    expect(black.darkRatio).toBe(1);
  });

  it("counts dark pixels by the threshold, not by average", () => {
    const half = buildPng(2, 1, 3, [
      { filter: 0, bytes: [0, 0, 0, 255, 255, 255] }
    ]);

    const audit = auditPixels(decodePng(half));

    expect(audit.darkRatio).toBe(0.5);
    expect(audit.meanLuminance).toBeCloseTo(0.5, 2);
  });
});

describe("luminance helpers", () => {
  it("matches the WCAG end points", () => {
    expect(relativeLuminance(0, 0, 0)).toBe(0);
    expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 6);
    expect(relativeLuminance(255, 0, 0)).toBeCloseTo(0.2126, 4);
  });

  it("computes the contrast ratio used to judge the theme switch", () => {
    const white = { r: 255, g: 255, b: 255 };
    const black = { r: 0, g: 0, b: 0 };
    expect(contrastRatio(white, black)).toBeCloseTo(21, 1);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 6);

    // The bug the light theme shipped with: a white label on a near-white
    // button, which is invisible and must fail any sane threshold.
    const nearWhite = { r: 247, g: 249, b: 252 };
    expect(contrastRatio(white, nearWhite)).toBeLessThan(1.1);
  });

  it("agrees with the PNG spec on the Paeth predictor", () => {
    // Each expectation is the branch that must win: up, left, up-left.
    expect(paeth(0, 10, 0)).toBe(10);
    expect(paeth(10, 40, 10)).toBe(40);
    expect(paeth(20, 50, 20)).toBe(50);
    expect(paeth(3, 4, 5)).toBe(3);
    expect(paeth(10, 30, 20)).toBe(20);
  });
});
