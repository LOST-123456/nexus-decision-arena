# 0012 Decision Map Workspace

## Actual Task Prompt

```text
You are implementing Task 10: Build the Decision Workspace and Map Adapter.

Read the task brief:
E:\AI创新应用挑战赛\.worktrees\decision-arena\.superpowers\sdd\2026-09-10-decision-arena-implementation\task-10-brief.md

Work from E:\AI创新应用挑战赛\.worktrees\decision-arena on branch feature/decision-arena. Do not send progress-only messages; finish, test, commit, return final contract. Use escalated exec commands if sandbox helpers fail.

Requirements:
- Create the Next.js 15/React 19 web app, reducer, Decision Map adapter, Agent Panel, and Decision Map using XYFlow.
- Consume `SessionView` from `@nexus/shared`; Web must not import Core internals.
- Implement all required map states and semantic edge colors. Human checkpoint pauses must be visually unmistakable.
- Visual direction: “AI command room,” not a generic admin dashboard. Keep the Decision Map as the first-viewport center. Use dark neutral surfaces with restrained cyan/green/amber/red status accents, not a purple-blue gradient theme, no decorative orbs, no giant marketing hero.
- Typography should feel operational: a compact grotesk/utility hierarchy, tabular numerals, and strong information density. Avoid oversized card-heavy layouts.
- Desktop layout: 18rem Agent Panel, central Decision Map, Inspector column, bottom Timeline. Responsive below 768px becomes a vertical flow/drawers; no text overlap or horizontal clipping.
- Respect reduced motion and keyboard focus. Animations only encode execution state.
- Tests: map adapter and event reducer tests exactly as in the brief; add focused tests for out-of-order/duplicate event handling and conflict edge semantics.
- Run web tests, typecheck, and production build. If Next build needs network for fonts, do not add remote font dependencies; use system/web-safe fonts.
- Create `docs/ai-history/0012-decision-map-ui.md` with real prompt, design rationale, corrections, RED/GREEN evidence, and commit title.
- Commit with the exact brief message. Do not touch unrelated files and do not dispatch subagents.
```

## Design Rationale

- The workspace is organized as a command room rather than a dashboard: a fixed
  18rem Agent Panel, the Decision Map as the central execution surface, a
  20rem evidence Inspector, and a 96px Decision Timeline.
- The map has explicit Agent, Claim, Challenge, Conflict, and Conclusion node
  kinds. Status rendering covers idle, running, completed, challenged, paused,
  conflict, and failed states.
- Edge color is semantic. Cyan represents active flow, red represents an
  unresolved challenge, amber represents conflict, green represents an accepted
  or resolved relation, and neutral gray represents ordinary provenance.
  Unresolved conflict edges remain animated so execution state is visible
  without decorating the interface for its own sake.
- A human checkpoint is a paused operational state, not an ordinary warning.
  The map displays a full-width amber checkpoint banner, the Node status is
  marked `conflict`, and the Inspector repeats the pending human action.
- The visual system uses compact, tabular typography and dense borders instead
  of oversized cards. It avoids remote fonts, decorative orbs, gradients, and
  marketing composition.

## Corrections Applied

1. The event reducer rejects sequence gaps. Applying an event with
   `sequence > lastSequence + 1` would silently skip durable events, so the
   reducer leaves the projection unchanged and lets the SSE replay layer fill
   the gap first.
2. A human-review event now changes both `phase` and `operationalStatus`, making
   the checkpoint a real paused state rather than only a phase label.
3. Conflict edges use the amber conflict semantic, while unresolved challenge
   edges use red. This preserves the design specification's distinction
   between detected conflicts and unresolved challenges.
4. The API client normalizes the persisted session row shape and computes
   `lastSequence` from `nextEventSequence` without importing any Core package.
5. The Next.js production build added `allowJs: true` to the generated
   TypeScript configuration. No remote font dependency was introduced.
6. The map zoom floor was lowered so the full graph can fit within a narrow
   mobile viewport while remaining pan-and-zoom interactive on desktop.

## RED Evidence

The brief tests and focused tests were created before the adapter and reducer:

```text
FAIL features/arena/event-reducer.test.ts
Error: Failed to resolve import "./event-reducer"

FAIL features/arena/map-adapter.test.ts
Error: Failed to resolve import "./map-adapter"

Test Files  2 failed (2)
Tests  no tests
```

## GREEN Evidence

Focused map and reducer tests:

```text
Test Files  2 passed (2)
Tests  5 passed (5)
```

Full web test suite:

```text
Test Files  2 passed (2)
Tests  5 passed (5)
```

Typecheck:

```text
tsc --noEmit completed with no diagnostics
```

Production build:

```text
Next.js 15.2.4 compiled successfully
Routes generated: /, /_not-found, /sessions/[sessionId]
```

Runtime layout verification at 1440x900 reported the map at 808px wide,
checkpoint visible, Timeline at 96px high, zero map-node overlap, and no
horizontal document overflow. At 390x844 the map remained first, the page had
no horizontal overflow, and the Agent and Inspector columns flowed below it.

## Commit Record

- Commit title: `feat(web): add decision map workspace`

## Review Fixes

### Review Corrections

1. `ReplayableSession` now carries an optional sequence-keyed
   `pendingEvents` map. Non-consecutive events are buffered, and every
   contiguous run is applied in order when the missing sequence arrives.
   Duplicate contiguous and pending events are ignored.
2. Claim nodes now derive status only from the Claim status: `proposed`,
   `supported`, `accepted`, `contested`, and `rejected` map to distinct node
   states. Agent stance is represented only as `supports`/`opposes`
   provenance edges.
3. Agent node status reads the runtime Agent status when present and otherwise
   falls back to session execution phase. Unresolved Challenges map to
   `challenged`; `failed` is reserved for execution failures.
4. Edge semantics now include `ariaLabel` values and visible legend labels, so
   meaning is not carried by color alone.
5. Agent rows use list-item semantics, while human-decision choices are real
   disabled buttons until their command wiring is added.
6. Map sizing is governed by the pure
   `getDecisionMapSizingPolicy(viewportWidth)` function with an 0.85 readable
   zoom floor. Pan/scroll remains enabled when the complete graph does not fit.
7. XYFlow source and target handles were added to the custom nodes so the
   semantic edges actually render and expose their accessibility labels.

### Review RED Evidence

Runtime inspection before the XYFlow handle fix:

```text
renderedEdges: 0
[React Flow]: Couldn't create edge for source handle id: "null"
```

### Review GREEN Evidence

```text
Test Files  4 passed (4)
Tests  11 passed (11)
```

```text
tsc --noEmit completed with no diagnostics
Next.js production build compiled successfully
```

Runtime verification after the fixes:

```text
desktop 1440x900:
  zoom: 0.85
  scaled primary node heading: 11.05px
  rendered edges: 14
  accessible edges: 14
  agent buttons: 0
  disabled human-decision buttons: 3
  horizontal overflow: none

mobile 390x844:
  zoom: 0.85
  scaled primary node heading: 11.05px
  rendered edges: 14
  accessible edges: 14
  agent buttons: 0
  disabled human-decision buttons: 3
  horizontal overflow: none
```