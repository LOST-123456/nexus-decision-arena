import { describe, expect, it } from "vitest";
import {
  decodeEntities,
  describeAnchor,
  extractPage,
  findAnchor,
  htmlToPlainText,
  normalizeText
} from "./html-extract";

/**
 * Text extraction and anchoring.
 *
 * Anchoring is what makes an excerpt re-checkable: if a quote cannot be put
 * back into the stored text, the workspace must say so rather than pretend the
 * citation still holds. These tests pin both the strict case and the
 * whitespace-reflow case, plus the limit — a quote that is genuinely gone.
 */

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities", () => {
    expect(decodeEntities("a &amp; b")).toBe("a & b");
    expect(decodeEntities("&lt;script&gt;")).toBe("<script>");
    expect(decodeEntities("&#65;&#66;")).toBe("AB");
    expect(decodeEntities("&#x4e2d;&#x6587;")).toBe("中文");
    expect(decodeEntities("&nbsp;")).toBe(" ");
  });

  it("leaves unknown or invalid entities alone instead of guessing", () => {
    expect(decodeEntities("&notanentity;")).toBe("&notanentity;");
    expect(decodeEntities("&#xZZ;")).toBe("&#xZZ;");
    expect(decodeEntities("&#0;")).toBe("&#0;");
    expect(decodeEntities("100 & 200")).toBe("100 & 200");
  });
});

describe("htmlToPlainText", () => {
  it("drops script, style and other non-content elements", () => {
    const text = htmlToPlainText(
      "<html><head><style>.a{}</style></head><body><p>keep</p><script>alert(1)</script><noscript>no</noscript></body></html>"
    );
    expect(text).toContain("keep");
    expect(text).not.toContain("alert");
    expect(text).not.toContain(".a{}");
    expect(text).not.toContain("no");
  });

  it("keeps paragraph breaks and collapses inline whitespace", () => {
    const text = htmlToPlainText(
      "<body><p>one</p><p>two</p><div>three<br>four</div></body>"
    );
    // Every block boundary becomes a break; normalizeText then decides how many
    // newlines survive as a real paragraph separator.
    expect(text).toBe("one\n\ntwo\n\nthree\nfour");
  });

  it("removes comments and never leaves tags behind", () => {
    const text = htmlToPlainText(
      "<body><!-- <p>hidden</p> --><p>visible</p></body>"
    );
    expect(text).toBe("visible");
    expect(text).not.toContain("<");
  });

  it("drops an element that was never closed rather than leaking its body", () => {
    const text = htmlToPlainText("<body><p>before</p><script>var x = 1;");
    expect(text).toBe("before");
    expect(text).not.toContain("var x");
  });

  it("does not execute or interpret anything", () => {
    // The output is text; a markup-looking payload stays as characters.
    const text = htmlToPlainText(
      "<body><p>&lt;img src=x onerror=alert(1)&gt;</p></body>"
    );
    expect(text).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("extractPage", () => {
  const html = `<!doctype html><html><head>
    <title>  Quarterly output  </title>
    <meta name="author" content="A. Researcher">
    <meta property="og:site_name" content="Statistics Office">
    <meta property="article:published_time" content="2025-01-02T03:04:05Z">
  </head><body><p>Body text.</p></body></html>`;

  it("reads title, author, publisher and publication date", () => {
    const page = extractPage({ body: html, contentType: "text/html", maxChars: 10_000 });
    expect(page.title).toBe("Quarterly output");
    expect(page.author).toBe("A. Researcher");
    expect(page.publisher).toBe("Statistics Office");
    expect(page.publishedAt).toBe("2025-01-02T03:04:05.000Z");
    expect(page.text).toContain("Body text.");
    expect(page.truncated).toBe(false);
  });

  it("refuses a nonsense publication date instead of storing it", () => {
    const page = extractPage({
      body: '<html><head><meta property="article:published_time" content="not a date"></head><body><p>x</p></body></html>',
      contentType: "text/html",
      maxChars: 10_000
    });
    expect(page.publishedAt).toBeNull();

    const wrongEra = extractPage({
      body: '<html><head><meta property="article:published_time" content="0012-01-01"></head><body><p>x</p></body></html>',
      contentType: "text/html",
      maxChars: 10_000
    });
    expect(wrongEra.publishedAt).toBeNull();
  });

  it("treats a non-html body as the text itself", () => {
    const page = extractPage({
      body: "  first line\n\n\nsecond line  ",
      contentType: "text/plain",
      maxChars: 10_000
    });
    expect(page.text).toBe("first line\n\nsecond line");
    expect(page.title).toBeNull();
  });

  it("marks truncation when the text exceeds the character budget", () => {
    const page = extractPage({
      body: `<html><body><p>${"x".repeat(50)}</p></body></html>`,
      contentType: "text/html",
      maxChars: 10
    });
    expect(page.truncated).toBe(true);
    expect(page.text).toHaveLength(10);
  });
});

describe("findAnchor", () => {
  const content = normalizeText(
    "Opening paragraph.\n\nSecond paragraph mentions the 2025 figure.\n\nClosing."
  );

  it("locates an exact quote and reports its position", () => {
    const result = findAnchor(content, "mentions the 2025 figure");
    expect(result.status).toBe("anchored");
    if (result.status === "anchored") {
      expect(content.slice(result.index).startsWith("mentions the 2025 figure")).toBe(
        true
      );
      expect(describeAnchor(content, result.index)).toBe("第 2 段");
    }
  });

  it("still locates a quote after the page reflows its whitespace", () => {
    const reflowed = content.replace(
      "Second paragraph mentions the 2025 figure.",
      "Second paragraph\n    mentions the 2025 figure."
    );
    const result = findAnchor(reflowed, "Second paragraph mentions the 2025 figure.");
    expect(result.status).toBe("anchored");
  });

  it("reports a quote that is genuinely gone as missing", () => {
    expect(findAnchor(content, "the 2024 figure was revised").status).toBe(
      "missing"
    );
    expect(findAnchor(content, "").status).toBe("missing");
    expect(findAnchor(content, "   ").status).toBe("missing");
  });

  it("refuses to anchor a short fragment through the reflow-tolerant path", () => {
    // An exact match is always trustworthy, however short. The length floor
    // only applies to the whitespace-insensitive pass, where a short needle
    // would match almost anywhere.
    const reflowed = "alpha\nbeta gamma";
    expect(findAnchor(reflowed, "alpha beta").status).toBe("missing");
  });

  it("anchors at the first occurrence when a phrase repeats", () => {
    const repeated = "alpha beta\ngamma beta";
    const result = findAnchor(repeated, "beta");
    expect(result.status).toBe("anchored");
    if (result.status === "anchored") expect(result.index).toBe(6);
  });
});

describe("normalizeText", () => {
  it("normalizes line endings and collapses runs of spaces", () => {
    expect(normalizeText("a\r\nb")).toBe("a\nb");
    expect(normalizeText("a   b")).toBe("a b");
    expect(normalizeText("a\n\n\n\nb")).toBe("a\n\nb");
    expect(normalizeText("\u00a0x\u200b")).toBe("x");
  });
});
