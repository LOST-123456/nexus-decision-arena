import { describe, expect, it } from "vitest";
import { LanguageDetectionService } from "./language-detection-service";

const detect = (text: string) =>
  new LanguageDetectionService().detect(text, {
    now: "2026-10-14T00:00:00.000Z"
  });

describe("LanguageDetectionService", () => {
  it("detects Simplified Chinese", () => {
    const result = detect("这是一段用于测试的中文文本内容。");
    expect(result.languageCode).toBe("zh-Hans");
    expect(result.status).toBe("detected");
  });

  it("separates Traditional from Simplified Chinese", () => {
    const result = detect("這是一段用於測試的繁體中文文本內容，包含國字與臺灣。");
    expect(result.languageCode).toBe("zh-Hant");
  });

  it("detects English", () => {
    const result = detect("The committee reviewed the evidence and the report.");
    expect(result.languageCode).toBe("en");
  });

  it("detects Japanese by kana", () => {
    const result = detect("これはテストのための日本語のテキストです。");
    expect(result.languageCode).toBe("ja");
    expect(result.confidence).toBe("high");
  });

  it("detects French from diacritics and function words", () => {
    const result = detect("Le rapport a été publié pour les participants.");
    expect(result.languageCode).toBe("fr");
  });

  it("refuses to commit on mixed-script text", () => {
    const result = detect("This is English text here 这是一段中文文本内容 これは日本語のテストです");
    expect(result.languageCode).toBe("mixed");
    expect(result.confidence).toBe("low");
  });

  it("refuses high confidence on very short text", () => {
    const result = detect("hi");
    expect(result.status).toBe("undetermined");
    expect(result.confidence).toBe("none");
  });

  it("refuses to force a language on numeric-only text", () => {
    const result = detect("12345 67890 09876 54321");
    expect(result.status).toBe("undetermined");
  });

  it("keeps a user-provided code distinct from the detection", () => {
    const result = new LanguageDetectionService().detect("The report is here.", {
      now: "2026-10-14T00:00:00.000Z",
      userProvidedCode: "fr"
    });
    expect(result.languageCode).toBe("en");
    expect(result.userProvidedCode).toBe("fr");
  });
});
