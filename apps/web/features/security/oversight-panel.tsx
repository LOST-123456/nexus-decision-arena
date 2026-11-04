"use client";

import { useCallback, useEffect, useState } from "react";
import {
  challengeAcceptedRate,
  completedRunRate,
  formatRate,
  type OversightCounts
} from "@nexus/shared";
import { toLoadFailure, type LoadFailure } from "../../lib/load-failure";
import { ActionLink, Button } from "../../components/ui/button";
import { Notice } from "../../components/ui/notice";
import { getOversightCounts } from "./oversight-api";

/**
 * 「这些主张的实际数据」——把安全治理页从自述变成可核对。
 *
 * The page above this panel is six assertions in prose. Prose cannot be
 * checked, and a governance page that only asserts is decoration. This panel
 * counts the two things the prose actually promises: that a person decides the
 * risky conflicts, and that runs either finish or are recorded as not having.
 *
 * What it deliberately does not do:
 *
 *  - **It does not score anything.** Material quality already has a six-
 *    dimension assessment of its own; a second number called "quality" would
 *    compete with it and win on being simpler.
 *  - **It does not turn counts into a verdict.** "40% of challenges were
 *    accepted" says how often people disagreed with a claim. It does not say
 *    the claims were wrong, and the footnote says so.
 *  - **It does not print 0% when there is nothing to divide.** A workspace with
 *    no decisions has no acceptance rate; showing 0% would state the opposite
 *    conclusion.
 */
export function OversightPanel() {
  const [counts, setCounts] = useState<OversightCounts | null>(null);
  const [failure, setFailure] = useState<LoadFailure | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setFailure(null);
    try {
      setCounts(await getOversightCounts());
    } catch (cause) {
      setCounts(null);
      setFailure(
        toLoadFailure(cause, "统计范围不存在", "无法读取治理数据")
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (failure) {
    return (
      <Notice
        testId="oversight-error"
        role="alert"
        eyebrow={failure.kind === "sign-in" ? "SIGN-IN REQUIRED" : "OVERSIGHT UNAVAILABLE"}
        title={failure.kind === "sign-in" ? "需要登录" : "无法读取治理数据"}
        reason={
          failure.kind === "sign-in"
            ? "这些数字按账户统计，登录后只算你有权查看的那些研究。"
            : failure.message
        }
        hint={
          failure.kind === "sign-in"
            ? "登录后回到这里，数字会自己出现。"
            : "如果是刚启动，等几秒再试一次。"
        }
        actions={
          /*
           * Sign-in is not a retryable failure: the number is account-scoped,
           * so pressing 重新加载 while signed out asks the same 401 again. The
           * only useful control there is the door to the login page.
           */
          failure.kind === "sign-in" ? (
            <ActionLink href="/login">去登录</ActionLink>
          ) : (
            <Button onClick={() => void load()}>重新加载</Button>
          )
        }
      />
    );
  }

  if (counts === null) {
    return (
      <div className="research-empty" role="status" data-testid="oversight-loading">
        正在统计…
      </div>
    );
  }

  if (counts.sessionCount === 0) {
    return (
      <div className="research-empty" data-testid="oversight-empty">
        <p className="research-empty-title">还没有可统计的研究</p>
        <p className="research-muted">
          这里统计的是你有权查看的研究。开始一次评审后，数字会出现在这里。
        </p>
      </div>
    );
  }

  const { conflicts, decisions, runs } = counts;
  const acceptedRate = challengeAcceptedRate(counts);
  const runRate = completedRunRate(counts);

  return (
    <div className="oversight" data-testid="oversight-panel">
      <p className="oversight-scope">
        统计范围：你有权查看的 <strong>{counts.sessionCount}</strong> 项研究。
        数字按行计数，跨账户的不可见。
      </p>

      <div className="oversight-grid">
        <section
          className="oversight-block"
          aria-labelledby="oversight-decisions"
        >
          <h2 id="oversight-decisions">人工裁决</h2>
          <dl className="oversight-figures">
            <div>
              <dt>已检出分歧</dt>
              <dd>{conflicts.total}</dd>
            </div>
            <div>
              <dt>需要人拍板</dt>
              <dd>{conflicts.requiringHuman}</dd>
            </div>
            <div>
              <dt>仍挂着</dt>
              <dd data-testid="oversight-awaiting">{conflicts.awaitingHuman}</dd>
            </div>
            <div>
              <dt>已落定</dt>
              <dd>{conflicts.resolved}</dd>
            </div>
          </dl>
          {/*
            Three-way split, not a "correctness" score. The bar is decoration —
            every number is also written out, so nothing depends on colour.
          */}
          <p className="oversight-note">
            {decisions.total === 0
              ? "还没有任何人工裁决。高风险分歧不会由 AI 自动关闭，所以这个数字为 0 说明还没人拍过板。"
              : `人工裁决 ${decisions.total} 次：采纳质询 ${decisions.acceptChallenge} 次、维持主张 ${decisions.upholdClaim} 次、要求补充分析 ${decisions.requestMoreAnalysis} 次。`}
          </p>
          {decisions.total > 0 ? (
            <div
              className="oversight-bar"
              aria-hidden="true"
              data-testid="oversight-decision-bar"
            >
              <span
                className="oversight-bar-accept"
                style={{ flexGrow: decisions.acceptChallenge }}
              />
              <span
                className="oversight-bar-uphold"
                style={{ flexGrow: decisions.upholdClaim }}
              />
              <span
                className="oversight-bar-defer"
                style={{ flexGrow: decisions.requestMoreAnalysis }}
              />
            </div>
          ) : null}
          <p className="oversight-note" data-testid="oversight-accept-rate">
            质询被采纳的比例：<strong>{formatRate(acceptedRate)}</strong>
            {acceptedRate === null
              ? ""
              : "。这只说明人有多少次没有顺着主张走，不说明主张是错的。"}
          </p>
        </section>

        <section className="oversight-block" aria-labelledby="oversight-runs">
          <h2 id="oversight-runs">运行可靠性</h2>
          <dl className="oversight-figures">
            <div>
              <dt>全部运行</dt>
              <dd>{runs.total}</dd>
            </div>
            <div>
              <dt>跑完</dt>
              <dd>{runs.completed}</dd>
            </div>
            <div>
              <dt>失败</dt>
              <dd>{runs.failed}</dd>
            </div>
            <div>
              <dt>超时</dt>
              <dd>{runs.timedOut}</dd>
            </div>
            <div>
              <dt>取消</dt>
              <dd>{runs.cancelled}</dd>
            </div>
            <div>
              <dt>由重试产生</dt>
              <dd data-testid="oversight-retried">{runs.retried}</dd>
            </div>
          </dl>
          <p className="oversight-note">
            跑完的比例：<strong>{formatRate(runRate)}</strong>
            。取消和超时都不算跑完 —— 把它们算进成功，界面就会说出「取消了也算好」。
          </p>
        </section>
      </div>

      {/*
        The footnote is part of the artifact, not a disclaimer bolted on. These
        numbers are the evidence that a person is in the loop; they are not
        evidence that any conclusion is right, and a reader who takes them as
        the latter has been misled by the panel.
      */}
      <p className="oversight-footnote" data-testid="oversight-caveat">
        这些数字能证明的只有一件事：是否真的有人参与、以及运行是否如实记录。
        它们不能证明任何结论正确 —— 人工裁决次数多，既可能是因为分歧确实多，
        也可能是因为审核做得细。要判断结论是否可信，看报告里的证据与引用核实状态。
      </p>
    </div>
  );
}
