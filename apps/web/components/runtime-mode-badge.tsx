"use client";

import { useEffect, useState } from "react";
import { getRuntimeInfo, type RuntimeInfo } from "../features/arena/api-client";

export function RuntimeModeBadge({
  fallback = "RUNTIME UNKNOWN"
}: {
  fallback?: string;
}) {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);

  useEffect(() => {
    getRuntimeInfo()
      .then(setRuntime)
      .catch(() => setRuntime(null));
  }, []);

  const realModel = runtime?.mode === "openai-compatible";
  /*
   * 没接检索就说没接，写在徽标上。
   *
   * 这个产品到处在提醒"什么没被核实"；如果它自己在没联网时保持沉默，
   * 那句话就只对材料生效、不对系统本身生效。
   */
  const searchLabel = !runtime
    ? ""
    : runtime.search?.enabled
      ? ""
      : " · 未接入检索";
  return (
    <span
      className={`runtime-mode-badge ${
        realModel ? "runtime-mode-real" : "runtime-mode-mock"
      }`}
      title={
        runtime
          ? `${runtime.provider} / ${runtime.model} · ${
              runtime.search?.enabled
                ? `外部检索：${runtime.search.provider}（候选来源，未核实）`
                : "外部检索：未接入"
            }`
          : "Core runtime information unavailable"
      }
    >
      {runtime
        ? realModel
          ? `REAL MODEL / ${runtime.model}${searchLabel}`
          : `MOCK MODE / FIXTURE${searchLabel}`
        : fallback}
    </span>
  );
}
