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
  return (
    <footer className="timeline" aria-label="Decision Timeline">
      <div className="timeline-title">
        <p className="eyebrow">DECISION TIMELINE</p>
        <span>
          SEQUENCE / {events.at(-1)?.sequence ?? selectedSequence}
        </span>
      </div>
      <ol className="timeline-list">
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
