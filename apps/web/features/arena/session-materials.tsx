"use client";

import type { SessionMaterial } from "@nexus/shared";
import { useCallback, useEffect, useState } from "react";
import { addMaterial, listMaterials } from "./api-client";
import type { WebSourceCandidate } from "./web-sources";

/**
 * 补充材料面板。
 *
 * 产品上的判断：一次评审很少能定论。第一轮质询问出来的通常是"你拿不出证据"，
 * 而补证据是一个独立动作——它不该逼迫用户去改项目简介（那会让此前几轮的结论
 * 失去参照）。所以这里收的是追加材料，带着轮次和时间，进事件流。
 *
 * 文案上刻意说清两件事，避免让人以为贴上来就立刻生效：
 *  1. 材料不会自动重算结论；
 *  2. 它要到下一轮分析才会被读到。
 */
export function SessionMaterials({
  sessionId,
  canWrite,
  roundLabel,
  candidates = []
}: {
  sessionId: string;
  /** 只读账户能看不能交。 */
  canWrite: boolean;
  roundLabel?: string;
  /**
   * 外部检索查到的候选来源。
   *
   * 单独一块、单独一句话：它们是"去哪儿看"，不是"已经证明"。采用之后也只是
   * 多一条待核实材料，结论与覆盖率都不会因此动一分。
   */
  candidates?: readonly WebSourceCandidate[];
}) {
  const [materials, setMaterials] = useState<SessionMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 已经采用过的来源（按 url），避免同一份来源被登记两遍。 */
  const [adopted, setAdopted] = useState<string[]>([]);
  const [adopting, setAdopting] = useState<string | null>(null);
  /**
   * 被忽略的来源。
   *
   * 存在 localStorage 而不是落成事件：忽略是"这个人不想看到它"，不是产品事实，
   * 也不该进审计包——换个人看这份评审时，那条来源仍然应该出现在他眼前。
   */
  const [ignored, setIgnored] = useState<string[]>([]);
  const ignoredKey = `nexus:web-sources:ignored:${sessionId}`;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(ignoredKey);
      if (raw) setIgnored(JSON.parse(raw) as string[]);
    } catch {
      /* 隐私模式/坏数据：当作没忽略过，不影响主流程 */
    }
  }, [ignoredKey]);

  const load = useCallback(async () => {
    try {
      const result = await listMaterials(sessionId);
      setMaterials(result.materials);
      setLoadError(null);
    } catch (caught) {
      setLoadError(
        caught instanceof Error ? caught.message : "材料列表读取失败"
      );
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(): Promise<void> {
    if (submitting) return;
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const result = await addMaterial(
        sessionId,
        { title: title.trim(), content: content.trim() },
        `material-${window.crypto.randomUUID()}`
      );
      setMaterials((current) => [...current, result.material]);
      setTitle("");
      setContent("");
      setNotice(
        "已登记。它会被写进时间线，并在下一轮分析里被质询和作答读到——本轮结论不会自动重算。"
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "材料提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function adopt(candidate: WebSourceCandidate): Promise<void> {
    if (adopting !== null || !canWrite) return;
    setAdopting(candidate.url);
    setError(null);
    setNotice(null);
    try {
      const result = await addMaterial(
        sessionId,
        {
          title: candidate.title,
          // 来源地址写进正文而不是标题：材料是要被读的，URL 读不了，
          // 但少了它这条材料就无从追溯。
          content: `${candidate.url}\n${candidate.snippet}`.trim()
        },
        `material-web-${window.crypto.randomUUID()}`
      );
      setMaterials((current) => [...current, result.material]);
      setAdopted((current) => [...current, candidate.url]);
      setNotice(
        "已作为候选材料登记（未核实）。要让它进入下一轮质询，回到裁决区点「要求补充分析」；本轮结论不会自己重算，也不会因此有任何主张变成已核实。"
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "采用失败");
    } finally {
      setAdopting(null);
    }
  }

  function ignore(url: string): void {
    setIgnored((current) => {
      const next = [...current, url];
      try {
        window.localStorage.setItem(ignoredKey, JSON.stringify(next));
      } catch {
        /* 存不进去就算了，本次会话内仍然生效 */
      }
      return next;
    });
  }

  const visibleCandidates = candidates.filter(
    (candidate) => !ignored.includes(candidate.url)
  );

  const canSubmit = canWrite && !submitting && title.trim().length > 0 && content.trim().length > 0;

  return (
    <section className="session-materials" aria-label="补充材料">
      <div className="session-materials-head">
        <div>
          <p className="eyebrow">MATERIALS</p>
          <h2>
            补充材料
            <span className="session-materials-count">
              {loading ? "读取中" : `已登记 ${materials.length} 份`}
            </span>
          </h2>
        </div>
        {roundLabel ? (
          <span className="session-materials-round">{roundLabel}</span>
        ) : null}
      </div>

      <p className="session-materials-copy">
        访谈记录、供应商报价、试点数据、政策原文——把第一轮质询问到的东西补在这里。
        交完材料后点「要求补充分析」，下一轮会带着它重新质询；结论不会因为贴了材料
        就自动变，改了才算数。
      </p>

      {visibleCandidates.length > 0 ? (
        <div className="session-web-sources" aria-label="检索到的候选来源">
          <p className="session-web-sources-head">
            <strong>检索到的候选来源</strong>
            <span>未核实 · 只是去到哪里找，不是已证明</span>
          </p>
          <ul>
            {visibleCandidates.map((candidate) => {
              const used = adopted.includes(candidate.url);
              return (
                <li key={candidate.url}>
                  <div>
                    <strong>{candidate.title}</strong>
                    <small>{candidate.url}</small>
                    {candidate.snippet ? <p>{candidate.snippet}</p> : null}
                  </div>
                  <button
                    type="button"
                    className="session-material-submit"
                    onClick={() => void adopt(candidate)}
                    disabled={!canWrite || used || adopting === candidate.url}
                    title={
                      !canWrite
                        ? "只读账户不能登记材料"
                        : used
                          ? "已经采用过这份来源"
                          : "作为待核实材料登记"
                    }
                  >
                    {used
                      ? "已采用"
                      : adopting === candidate.url
                        ? "登记中…"
                        : "采用为材料"}
                  </button>
                  {/*
                    忽略只影响"我现在想不想看到它"，所以放在次一级的位置，
                    用文字按钮而不是实心按钮——它不是这条来源的结论。
                  */}
                  <button
                    type="button"
                    className="session-web-source-ignore"
                    onClick={() => ignore(candidate.url)}
                    disabled={used}
                    title={used ? "已采用的来源不能忽略" : "从列表里收起（只影响你的视图）"}
                  >
                    忽略
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {materials.length > 0 ? (
        <ul className="session-materials-list">
          {materials.map((material) => (
            <li key={material.id}>
              <div className="session-material-head">
                <strong>{material.title}</strong>
                <span>第 {material.round} 轮前 · {formatTime(material.createdAt)}</span>
              </div>
              <p>{material.content}</p>
              <small>登记人 {material.addedBy}</small>
            </li>
          ))}
        </ul>
      ) : loading ? null : (
        <p className="session-materials-empty">
          还没有补充材料。第一轮质询问到的缺口，写在这里再跑一轮。
        </p>
      )}

      {loadError ? (
        <p className="session-materials-error" role="alert">
          {loadError}
        </p>
      ) : null}

      {canWrite ? (
        <div className="session-material-form">
          <label>
            <span>材料标题</span>
            <input
              value={title}
              maxLength={120}
              placeholder="例如：三所高校后勤处的合作意向（2026 年 3 月）"
              onChange={(event) => setTitle(event.target.value)}
              disabled={submitting}
            />
          </label>
          <label>
            <span>材料内容</span>
            <textarea
              rows={4}
              maxLength={4000}
              value={content}
              placeholder="写清来源与关键数字。例：2026-03 与 A/B/C 三校后勤处签意向书，约定按学期结算，覆盖在校生约 2.1 万人。"
              onChange={(event) => setContent(event.target.value)}
              disabled={submitting}
            />
          </label>
          <div className="session-material-actions">
            <button
              type="button"
              className="session-material-submit"
              onClick={() => void submit()}
              disabled={!canSubmit}
              /**
               * 缺内容时按钮是灰的，但要把原因写出来——一个灰按钮不解释自己，
               * 用户只会重复点。
               */
              title={
                canSubmit
                  ? undefined
                  : !canWrite
                    ? "只读账户不能提交材料"
                    : "标题和内容都填了才能提交"
              }
            >
              {submitting ? "提交中…" : "登记这份材料"}
            </button>
            {!canSubmit && !submitting ? (
              <span className="session-material-hint">
                {!canWrite
                  ? "只读账户可以查看材料，不能提交。"
                  : "标题和内容都填上才能提交。"}
              </span>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="session-materials-empty">
          只读账户可以查看材料，不能提交。
        </p>
      )}

      {notice ? (
        <p className="session-materials-notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="session-materials-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}
