# Tidebase v0.2.0

v0.2.0 adds the first durable history primitives on top of Tidebase's existing checkpoint model.

## Highlights

- Added versioned state streams.
- Added state versions for every `run.state.set()` and `run.state.patch()`.
- Added `run.state.save(label)` for labeled milestone versions.
- Added snapshot convenience APIs backed by labeled state versions.
- Added child-run edges for parent/child run trees.
- Added SDK helpers for `run.child()` and `run.fanout()`.
- Added checkpointed fanout joins via `join:<name>` steps.

## Why It Matters

Tidebase now has a coherent foundation for time travel and forking without turning snapshots into a separate state concept:

```text
current state = latest version in a stream
snapshot = labeled state version
time travel = read an older version
fork = start new state/run context from an older version
restore = append a new version based on an older version
```

Subagent workflows can now be represented as observable run trees. A parent run can create child runs idempotently, wait for them, and checkpoint the joined result so parent resume does not duplicate completed subagent work.

## New SDK Shape

```typescript
await run.state.patch({ progress: 0.5 })

await run.state.save('before-approval', {
  reason: 'user is about to approve sending'
})

await run.snapshots.create('draft-v1', {
  target: { type: 'report', id: reportId },
  state: draft,
  reason: 'first complete draft'
})
```

```typescript
const results = await run.fanout('research-options', [
  {
    name: 'flights',
    workflow: researchFlights,
    input: { destination }
  },
  {
    name: 'hotels',
    workflow: researchHotels,
    input: { destination }
  }
])
```

## Storage Changes

New tables:

- `state_streams`
- `state_versions`
- `run_edges`

The existing `run_state` table remains as the latest-state cache for backwards compatibility.

## Compatibility Notes

Existing `run.state.set()` and `run.state.patch()` calls continue to work. They now also append state versions automatically.

The snapshot APIs are convenience APIs over labeled state versions. Tidebase does not own app-specific restore behavior; consumers such as Aura decide what restore or fork means for their own state targets.
