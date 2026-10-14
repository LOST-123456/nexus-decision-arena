"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createSnapshotTranslation,
  getSourceDetail,
  getSourceLanguages,
  listTerminology,
  type SourceDetailRecord,
  type SourceLanguageView,
  TranslationFailedError,
  upsertTerminology,
  type CreateTranslationResult
} from "./api";
import type {
  SupportedLanguageCode,
  TranslationFidelityAssessment,
  TranslationRecord,
  TerminologyEntry
} from "@nexus/shared";

/**
 * The multilingual research surface.
 *
 * The honesty contract this component keeps:
 *   * The original text is always shown and stays the anchor; a translation is
 *     auxiliary and is labelled as such, never as a substitute for the source.
 *   * When no provider is available it says "尚未翻译 / 服务暂不可用" — it never
 *     fabricates a translation or a confidence.
 *   * Fidelity findings are rule-based suggestions to look closer, marked as
 *     such, and are never presented as proven errors.
 *   * A translation never verifies evidence; the wording never implies it did.
 */

const LANGUAGE_LABELS: Record<string, string> = {
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
  en: "英语",
  ja: "日语",
  ko: "韩语",
  fr: "法语",
  de: "德语",
  es: "西班牙语",
  unknown: "未知",
  mixed: "混合",
  undetermined: "无法确定"
};

const TARGETS: SupportedLanguageCode[] = [
  "zh-Hans",
  "zh-Hant",
  "en",
  "ja",
  "ko",
  "fr",
  "de",
  "es"
];

const FIDELITY_DIMENSION_LABELS: Record<string, string> = {
  number: "数值",
  unit: "单位",
  date: "日期",
  negation: "否定",
  comparison: "比较方向",
  qualifier: "限定/确定性",
  entity: "实体名称",
  "reference-scope": "引用范围"
};

const FIDELITY_RISK_LABELS: Record<string, string> = {
  "direction-conflict": "方向性冲突",
  "certainty-shift": "确定性变化",
  "negation-changed": "否定含义变化",
  "entity-changed": "实体变化",
  "unit-changed": "单位变化",
  "date-changed": "日期变化",
  "comparison-changed": "比较关系变化",
  "qualifier-changed": "限定词变化",
  "reference-scope-changed": "引用范围变化",
  none: "数值差异"
};

function languageLabel(code: string): string {
  return LANGUAGE_LABELS[code] ?? code;
}

export function MultilingualResearchPanel({
  sessionId,
  sourceId,
  canEdit = true
}: {
  sessionId: string;
  sourceId: string;
  /**
   * Whether the current account may write (translate, keep a glossary). A
   * read-only account still reads everything: the original, the detection
   * and any translation already stored — the controls are simply not
   * offered, the same way the source reader withholds its own form.
   */
  canEdit?: boolean;
}) {
  const [detail, setDetail] = useState<SourceDetailRecord | null>(null);
  const [language, setLanguage] = useState<SourceLanguageView | null>(null);
  const [target, setTarget] = useState<SupportedLanguageCode>("zh-Hans");
  const [result, setResult] = useState<CreateTranslationResult | null>(null);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [terminology, setTerminology] = useState<TerminologyEntry[]>([]);
  const [termDraft, setTermDraft] = useState({ sourceTerm: "", confirmedTranslation: "" });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [nextDetail, nextLanguage, nextTerms] = await Promise.all([
        getSourceDetail(sessionId, sourceId),
        getSourceLanguages(sessionId, sourceId),
        listTerminology(sessionId)
      ]);
      setDetail(nextDetail);
      setLanguage(nextLanguage);
      setTerminology(nextTerms.entries);
      // Default the target to something other than the detected source.
      const source = nextLanguage.detection.languageCode;
      if (source === "zh-Hans") {
        setTarget("en");
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "加载失败，请重试。");
    } finally {
      setLoading(false);
    }
  }, [sessionId, sourceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const currentSnapshot =
    detail && detail.currentSnapshotId
      ? detail.snapshots.find((snapshot) => snapshot.id === detail.currentSnapshotId) ??
        null
      : null;

  async function onTranslate() {
    if (!currentSnapshot) {
      return;
    }
    setTranslateError(null);
    setUnavailable(false);
    setResult(null);
    try {
      const next = await createSnapshotTranslation(sessionId, {
        sourceSnapshotId: currentSnapshot.id,
        targetLanguage: target
      });
      setResult(next);
      if (next.translation.status === "unavailable") {
        setUnavailable(true);
      }
    } catch (error) {
      if (error instanceof TranslationFailedError) {
        if (error.code === "provider_unavailable") {
          setUnavailable(true);
        } else {
          setTranslateError(error.message);
        }
      } else {
        setTranslateError(error instanceof Error ? error.message : "翻译失败，请重试。");
      }
    }
  }

  async function onAddTerm() {
    if (!termDraft.sourceTerm.trim()) {
      return;
    }
    try {
      const { entry } = await upsertTerminology(sessionId, {
        sourceTerm: termDraft.sourceTerm.trim(),
        confirmedTranslation: termDraft.confirmedTranslation.trim() || undefined,
        language: language?.detection.languageCode ?? "undetermined"
      });
      setTerminology((prev) => {
        const without = prev.filter((item) => item.id !== entry.id);
        return [...without, entry].sort((a, b) => a.sourceTerm.localeCompare(b.sourceTerm));
      });
      setTermDraft({ sourceTerm: "", confirmedTranslation: "" });
    } catch {
      // A failed glossary write is non-fatal; the list simply stays as it was.
    }
  }

  if (loading) {
    return (
      <section data-testid="multilingual-panel" className="text-sm text-slate-500">
        正在加载多语言信息…
      </section>
    );
  }

  if (loadError) {
    return (
      <section data-testid="multilingual-panel" className="text-sm">
        <p className="text-rose-600">{loadError}</p>
        <button type="button" onClick={() => void load()} className="underline">
          重试
        </button>
      </section>
    );
  }

  const detection = language?.detection;
  const translation: TranslationRecord | undefined = result?.translation;
  const fidelity: TranslationFidelityAssessment | undefined = result?.fidelity;

  return (
    <section data-testid="multilingual-panel" className="space-y-4 text-sm">
      {/* Language identification */}
      <div data-testid="ml-detection" className="rounded border border-slate-200 p-3">
        <h3 className="font-medium text-slate-700">来源语言</h3>
        {detection ? (
          <p className="text-slate-600">
            检测语言：
            <span className="font-medium">{languageLabel(detection.languageCode)}</span>
            （{detection.status === "detected" ? "已识别" : detection.status}，
            置信度 {detection.confidence}，方式 {detection.method}）
            {language?.storedSourceLanguage
              ? `；登记语言 ${languageLabel(language.storedSourceLanguage)}`
              : ""}
          </p>
        ) : (
          <p className="text-slate-500">该来源暂无可用原文，无法检测语言。</p>
        )}
      </div>

      {/* Translation controls */}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="ml-target" className="text-slate-600">
          辅助译文语言
        </label>
        <select
          id="ml-target"
          value={target}
          onChange={(event) => setTarget(event.target.value as SupportedLanguageCode)}
          className="rounded border border-slate-300 px-2 py-1"
        >
          {TARGETS.map((code) => (
            <option key={code} value={code}>
              {languageLabel(code)}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="ml-translate"
          onClick={() => void onTranslate()}
          disabled={!currentSnapshot || !canEdit}
          className="rounded bg-slate-800 px-3 py-1 text-white disabled:opacity-40"
        >
          生成辅助译文
        </button>
      </div>

      {!canEdit ? (
        <p data-testid="ml-readonly" className="text-xs text-slate-500">
          当前账号为只读角色，无法生成译文或维护术语表；已存储的译文仍可阅读。
        </p>
      ) : null}

      {unavailable && (
        <p data-testid="ml-unavailable" className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-800">
          翻译服务暂不可用，尚未生成译文。原文阅读不受影响；请稍后重试或配置翻译服务。
        </p>
      )}
      {translateError && (
        <p data-testid="ml-error" className="rounded border border-rose-300 bg-rose-50 p-2 text-rose-700">
          {translateError}
          <button type="button" onClick={() => void onTranslate()} className="ml-2 underline">
            重试
          </button>
        </p>
      )}

      {/* Original / translation, side by side on desktop, stacked on mobile */}
      {currentSnapshot && (
        <div className="grid gap-3 md:grid-cols-2">
          <div data-testid="ml-original">
            <h4 className="mb-1 font-medium text-slate-700">原文（引用以此为准）</h4>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 p-2 text-xs">
              {currentSnapshot.content}
            </pre>
          </div>
          <div data-testid="ml-translation">
            <h4 className="mb-1 font-medium text-slate-700">辅助译文</h4>
            {translation && translation.status === "completed" ? (
              <>
                <p className="mb-1 text-xs text-slate-500">
                  机器翻译（{translation.provider}
                  {translation.model && translation.model !== "n/a" ? ` / ${translation.model}` : ""}），
                  仅供辅助理解，不可替代原文引用。
                </p>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded border border-slate-200 bg-white p-2 text-xs">
                  {translation.translatedText}
                </pre>
              </>
            ) : (
              <p className="text-xs text-slate-400">尚未翻译。</p>
            )}
          </div>
        </div>
      )}

      {/* Fidelity findings — rule-based suggestions, never proven errors */}
      {fidelity && fidelity.findings.length > 0 && (
        <div data-testid="ml-fidelity" className="rounded border border-slate-200 p-3">
          <h4 className="mb-2 font-medium text-slate-700">
            译文忠实度风险（{fidelity.method === "rule-based" ? "规则检测结果" : "模型辅助"}，共{" "}
            {fidelity.findings.length} 项，待人工确认）
          </h4>
          <ul className="space-y-2">
            {fidelity.findings.map((finding, index) => (
              <li key={index} className="rounded bg-slate-50 p-2 text-xs">
                <span className="font-medium">
                  [{FIDELITY_DIMENSION_LABELS[finding.dimension] ?? finding.dimension}]
                </span>{" "}
                <span className="text-rose-700">
                  {FIDELITY_RISK_LABELS[finding.riskType] ?? finding.riskType}
                </span>
                <p className="text-slate-600">{finding.basis}</p>
                <p className="text-slate-500">
                  原文片段：{finding.originalSnippet || "—"} ｜ 译文片段：
                  {finding.translatedSnippet || "—"}
                </p>
                <p className="text-slate-400">规则检测结果，非已证实的翻译错误。</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Terminology glossary */}
      <div data-testid="ml-terminology" className="rounded border border-slate-200 p-3">
        <h4 className="mb-2 font-medium text-slate-700">术语表（本研究会话）</h4>
        {terminology.length === 0 ? (
          <p className="text-xs text-slate-400">暂无术语。可添加原文术语及其确认译法。</p>
        ) : (
          <ul className="mb-2 space-y-1 text-xs">
            {terminology.map((entry) => (
              <li key={entry.id}>
                <span className="font-medium">{entry.sourceTerm}</span>
                {entry.confirmedTranslation
                  ? ` → ${entry.confirmedTranslation}`
                  : entry.suggestedTranslation
                    ? ` ≈ ${entry.suggestedTranslation}（建议）`
                    : "（待确认译法）"}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <input
            aria-label="原文术语"
            value={termDraft.sourceTerm}
            onChange={(event) =>
              setTermDraft((prev) => ({ ...prev, sourceTerm: event.target.value }))
            }
            placeholder="原文术语"
            disabled={!canEdit}
            className="rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-40"
          />
          <input
            aria-label="确认译法"
            value={termDraft.confirmedTranslation}
            onChange={(event) =>
              setTermDraft((prev) => ({ ...prev, confirmedTranslation: event.target.value }))
            }
            placeholder="确认译法"
            disabled={!canEdit}
            className="rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-40"
          />
          <button
            type="button"
            onClick={() => void onAddTerm()}
            disabled={!canEdit}
            className="rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-40"
          >
            添加术语
          </button>
        </div>
      </div>
    </section>
  );
}
