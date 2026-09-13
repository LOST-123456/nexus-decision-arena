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
  return (
    <span
      className={`runtime-mode-badge ${
        realModel ? "runtime-mode-real" : "runtime-mode-mock"
      }`}
      title={
        runtime
          ? `${runtime.provider} / ${runtime.model}`
          : "Core runtime information unavailable"
      }
    >
      {runtime
        ? realModel
          ? `REAL MODEL / ${runtime.model}`
          : "MOCK MODE / FIXTURE"
        : fallback}
    </span>
  );
}
