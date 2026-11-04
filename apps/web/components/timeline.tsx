"use client";

import { useEffect, useRef, useState } from "react";

export type TimelineEvent = {
  id: string;
  sequence: number;
  type: string;
  label?: string;
};

export function Timeline({
  events,
  selectedSequence,
  onSelect
}: {
  events: readonly TimelineEvent[];
  selectedSequence: number;
  onSelect(sequence: number): void;
}) {
  /**
   * 这一条时间线是不是比屏幕宽。
   *
   * 一排事件卡片默认是横向滚动的，但滚动条被样式收进去了：实测在 1080px
   * 宽的窗口里，第 8 张卡正好被右边缘切成半张，看起来像"只记了 8 条"。
   * 真实事件有几十条。所以这里量一次，把"还有"说出来。
   */
  const listRef = useRef<HTMLOListElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const list = listRef.current;
    if (list === null) {
      return;
    }
    const measure = () => {
      // 留 4px 容差：亚像素取整会让"刚好装下"误判成溢出。
      setOverflowing(list.scrollWidth - list.clientWidth > 4);
    };
    measure();
    // 窗口变宽变窄都会改变"装不装得下"，所以两条路都要重新量。
    window.addEventListener("resize", measure);
    // jsdom 没有 ResizeObserver；那里 scrollWidth 恒为 0，也就永远不提示。
    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => {
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, [events.length]);

  return (
    <footer
      className="timeline"
      aria-label="Decision Timeline"
      data-testid="timeline"
      data-overflow={overflowing ? "true" : "false"}
    >
      <div className="timeline-title">
        <p className="eyebrow">DECISION TIMELINE</p>
        <span>SEQUENCE / {events.at(-1)?.sequence ?? selectedSequence}</span>
        {overflowing ? (
          <small className="timeline-overflow" data-testid="timeline-overflow">
            共 {events.length} 条 · 还在往右延伸，横向滚动查看
          </small>
        ) : null}
      </div>
      <ol
        ref={listRef}
        className="timeline-list"
        tabIndex={0}
        aria-label="执行事件时间线"
      >
        {events.map((event) => {
          const selected = event.sequence === selectedSequence;
          return (
            <li key={event.id}>
              <button
                type="button"
                className={`timeline-event ${
                  selected ? "timeline-event-selected" : ""
                }`}
                aria-label={`Sequence ${event.sequence} ${event.type}`}
                aria-current={selected ? "step" : undefined}
                onClick={() => onSelect(event.sequence)}
              >
                <span>#{String(event.sequence).padStart(2, "0")}</span>
                <strong>{event.label ?? event.type.replaceAll("_", " ")}</strong>
                <small>{event.type}</small>
              </button>
            </li>
          );
        })}
      </ol>
    </footer>
  );
}
