import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  DocumentParseError,
  detectSourceFileKind,
  inspectCsv,
  parseDocument,
  type ParsedDocument
} from "./file-parsers";

/**
 * Parser tests.
 *
 * The point of these is the honesty rules, not coverage for its own sake:
 *  - the *bytes* decide the kind, never the extension;
 *  - a document with no text layer says so instead of succeeding with nothing in
 *    it;
 *  - structure survives — pages stay separable, headings stay recognisable, and
 *    a table stays a table rather than being flattened into sentences;
 *  - anything unreadable is refused with a reason, never quietly accepted.
 */

const encode = (value: string) => new TextEncoder().encode(value);

/**
 * A minimal but structurally honest PDF: object numbers and xref entries line
 * up exactly, so pdf.js does not have to recover anything.
 *
 * That detail matters. A sloppy fixture would silently exercise the library's
 * recovery path instead of the normal one, which is both a misleading test and
 * a source of late, unhandled rejections.
 */
function buildPdf(textPerPage: string[]): Uint8Array {
  const objects: string[] = [];
  // 1 = catalog, 2 = pages, 3 = font, then pages, then their content streams.
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  const pageNumbers: number[] = [];
  let next = 4;
  for (let index = 0; index < textPerPage.length; index += 1) {
    pageNumbers.push(next);
    next += 1;
  }
  objects.push(
    `<< /Type /Pages /Kids [${pageNumbers.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageNumbers.length} >>`
  );
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  textPerPage.forEach((text, index) => {
    const contentNumber = pageNumbers[textPerPage.length - 1]! + 1 + index;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >>${text.length > 0 ? ` /Contents ${contentNumber} 0 R` : ""} >>`
    );
  });
  for (const text of textPerPage) {
    const stream = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return encode(pdf);
}

/**
 * Pages with no content stream at all — what a scanned document is: real pages,
 * no text layer, nothing to extract.
 */
function buildScannedPdf(): Uint8Array {
  return buildPdf(["", ""]);
}

async function buildDocx(documentXml: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
  );
  zip.file("word/document.xml", documentXml);
  return await zip.generateAsync({ type: "uint8array" });
}

const SIMPLE_DOCX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Findings</w:t></w:r></w:p>
<w:p><w:r><w:t>Revenue reached 4.2 million yuan this quarter.</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Amount</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>East</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1200</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Method notes</w:t></w:r></w:p>
</w:body></w:document>`;

function expectParsed(document: ParsedDocument): Extract<
  ParsedDocument,
  { outcome: "parsed" }
> {
  if (document.outcome !== "parsed") {
    throw new Error(`expected a parsed document, got ${document.outcome}`);
  }
  return document;
}

describe("detectSourceFileKind", () => {
  it("reads pdf from its signature", () => {
    expect(detectSourceFileKind({ bytes: buildPdf(["hi"]), fileName: "x.pdf" })).toBe("pdf");
  });

  it("reads docx from its zip signature", async () => {
    expect(
      detectSourceFileKind({ bytes: await buildDocx(SIMPLE_DOCX), fileName: "x.docx" })
    ).toBe("docx");
  });

  it("separates csv, markdown and plain text", () => {
    const bytes = encode("a,b\n1,2\n");
    expect(detectSourceFileKind({ bytes, fileName: "data.csv" })).toBe("csv");
    expect(detectSourceFileKind({ bytes, fileName: "notes.md" })).toBe("markdown");
    expect(detectSourceFileKind({ bytes, fileName: "notes.txt" })).toBe("txt");
  });

  it("does not trust the extension: a text file called .pdf is text", () => {
    expect(detectSourceFileKind({ bytes: encode("not a pdf"), fileName: "invoice.pdf" })).toBe(
      "txt"
    );
  });

  it("refuses binary content nobody can read", () => {
    expect(
      detectSourceFileKind({
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
        fileName: "image.png"
      })
    ).toBeNull();
  });
});

describe("parseDocument — pdf", () => {
  it("keeps pages separable so a citation can name a page", async () => {
    const parsed = expectParsed(
      await parseDocument({
        bytes: buildPdf(["Page one conclusion.", "Page two methodology."]),
        kind: "pdf"
      })
    );
    expect(parsed.stats).toMatchObject({ kind: "pdf", pageCount: 2 });
    const pages = parsed.content.split("\f");
    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain("Page one conclusion.");
    expect(pages[1]).toContain("Page two methodology.");
  });

  it("reports a scanned pdf as needing OCR instead of parsing it empty", async () => {
    const result = await parseDocument({ bytes: buildScannedPdf(), kind: "pdf" });
    expect(result.outcome).toBe("needs_ocr");
    if (result.outcome === "needs_ocr") {
      expect(result.pageCount).toBe(2);
      expect(result.stats).toEqual({ kind: "ocr", pageCount: 2 });
    }
  });

  it("fails with a reason when the bytes are not really a pdf", async () => {
    await expect(
      parseDocument({ bytes: encode("%%PDF-1.4 fake header only"), kind: "pdf" })
    ).rejects.toBeInstanceOf(DocumentParseError);
  });
});

describe("parseDocument — docx", () => {
  it("keeps headings, paragraphs and the table's cell structure", async () => {
    const parsed = expectParsed(
      await parseDocument({ bytes: await buildDocx(SIMPLE_DOCX), kind: "docx" })
    );
    expect(parsed.stats).toMatchObject({
      kind: "docx",
      headingCount: 2,
      tableCount: 1
    });
    // A heading stays a heading rather than becoming an unmarked sentence.
    expect(parsed.content).toContain("# Quarterly Findings");
    expect(parsed.content).toContain("## Method notes");
    // The table is still rows of cells, not prose that reads like a finding.
    expect(parsed.content).toContain("Region | Amount");
    expect(parsed.content).toContain("East | 1200");
  });

  it("refuses a zip that is not a Word document", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "not a document");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(parseDocument({ bytes, kind: "docx" })).rejects.toBeInstanceOf(
      DocumentParseError
    );
  });
});

describe("parseDocument — text and markdown", () => {
  it("preserves paragraph structure for plain text", async () => {
    const parsed = expectParsed(
      await parseDocument({
        bytes: encode("Costs rose.\n\nHeadcount stayed flat.\n"),
        kind: "txt"
      })
    );
    expect(parsed.stats).toMatchObject({ kind: "txt", paragraphCount: 2 });
    expect(parsed.content).toBe("Costs rose.\n\nHeadcount stayed flat.");
  });

  it("counts markdown headings without rewriting the text", async () => {
    const text = "# Summary\n\nBody line.\n\n## Details\n\nAnother line.\n";
    const parsed = expectParsed(
      await parseDocument({ bytes: encode(text), kind: "markdown" })
    );
    expect(parsed.stats).toMatchObject({ kind: "markdown", headingCount: 2 });
    expect(parsed.content).toBe(text.trimEnd());
  });

  it("refuses a file with nothing readable in it", async () => {
    await expect(
      parseDocument({ bytes: encode("   \n\n  \t "), kind: "txt" })
    ).rejects.toMatchObject({ code: "empty_file" });
  });
});

describe("parseDocument — csv", () => {
  it("keeps columns, row count and inferred types instead of prose", async () => {
    const parsed = expectParsed(
      await parseDocument({
        bytes: encode("region,amount,year\nEast,1200,2025\nWest,980,2025\n"),
        kind: "csv"
      })
    );
    expect(parsed.stats).toMatchObject({
      kind: "csv",
      columnCount: 3,
      rowCount: 2,
      columns: ["region", "amount", "year"],
      columnTypes: ["text", "integer", "integer"]
    });
    expect(parsed.table?.rows).toEqual([
      ["East", "1200", "2025"],
      ["West", "980", "2025"]
    ]);
  });

  it("reports mixed columns as text rather than guessing a type", () => {
    const structure = inspectCsv("value\nmixed\n12\ntrue\n2025-01-01\n");
    expect(structure.columnTypes).toEqual(["text"]);
  });

  it("marks a column with nothing in it as empty", () => {
    const structure = inspectCsv("a,b\n1,\n2,\n");
    expect(structure.columnTypes).toEqual(["integer", "empty"]);
  });

  it("refuses a csv without a header row", () => {
    expect(() => inspectCsv("")).toThrow(DocumentParseError);
  });
});
