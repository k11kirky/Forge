# Forge MVP Build Plan

- Date: 2026-02-07
- Scope: Execute RFC 0001 with a working end-to-end MVP

## 1. Build Objective

Deliver a usable Forge vertical slice that supports:

- attaching to a state
- creating and submitting operations
- creating and submitting atomic change sets (multi-op submissions)
- conflict detection as durable objects
- resolving conflicts with a resolution operation
- rendering a local tree from server state

This plan intentionally excludes staffing, schedules, and milestone dates.

## 2. MVP Boundaries

Included:

- Adapter-based semantic targets:
- Python (`.py`) top-level function/class symbols
- JSON (`.json`) top-level keys
- Text/Markdown (`.txt`, `.md`) document-level fallback
- Full edit coverage is preserved via fallback document-level ops when semantic decomposition is not reliable.
- Python symbol extraction uses a sidecar adapter with `libcst` when available and stdlib `ast` fallback.
- Forced `libcst` mode degrades safely to document-level ops if `libcst` is not installed.
- Python verification blocks operations that would introduce duplicate top-level symbols.
- single-node server with persistent RocksDB local storage
- CLI and daemon with local sandbox render path
- policy gate for open conflicts and required checks (stubbed checks in MVP)
- append-only operation history with canonical ordering

Excluded:

- distributed multi-region storage
- full AST-level polyglot parsing beyond the MVP adapters
- production-grade auth provider integrations
- advanced auto-resolution strategies beyond one default resolver

## 3. Invariants (Must Hold)

- All accepted operations are immutable and content-addressed.
- States are represented by causal DAG heads, never raw unordered op sets.
- Conflicts are durable records until explicitly resolved/superseded.
- Materialization of the same state/heads must be deterministic.
- Resolution is represented as a normal operation with `resolves` links.

## 4. System Shape

Components:

- `forge-server`: source of truth for ops, conflicts, states, policies
- `forge-daemon`: local sync + render engine into `/sandbox/tree`
- `forge-cli`: human/agent interface for attach, submit, conflict flows
- shared model package: schemas, validation, serialization

Primary flow:

1. CLI submits op to server.
2. Server validates preconditions and policy.
3. Server accepts op or creates conflict object.
4. Daemon streams updates and rematerializes local tree.
5. Resolver submits resolution op with `resolves` references.

## 5. Build Tracks

### Track A: Shared Model

- Define TypeScript schemas for `op`, `conflict`, `state`, `policy`, `checkpoint`.
- Enforce strict runtime validation for all incoming payloads.
- Provide deterministic content-hash helper for canonical op IDs.

### Track B: Server Core

- Implement append-only op log and indexes by state/symbol.
- Implement conflict classifier (`semantic_write_conflict` and `precondition_failure` first).
- Add REST endpoints and state stream.
- Persist server data in RocksDB with clean adapter boundaries for future distributed backends.

### Track C: Materialization Engine

- Build minimal renderer from canonical state snapshot into filesystem tree.
- Preserve deterministic output ordering and newline strategy.
- Cache parsed structures and support incremental rematerialization.

### Track D: CLI and Daemon

- CLI commands: `attach`, `create`, `submit`, `stack`, `states`, `state create`, `state promote`, `conflicts`, `conflict show`, `conflict resolve`.
- Daemon command: state stream listener + render trigger.
- Local op overlay for edits not yet accepted by server.

### Track E: Policy and Verification

- Add state policy definition and evaluator.
- Stub verification checks in MVP with deterministic pass/fail hooks.
- Gate protected states on policy outcome.

### Track F: Observability

- Structured logs for op ingestion, conflict creation, resolution.
- Basic metrics endpoints (op accept rate, conflict count, attach latency).

## 6. Data Contracts (Initial)

Operation:

- `id`, `parents`, `state`, `target`, `preconditions`, `reads`, `writes`, `effect`, `metadata`

Conflict:

- `id`, `state`, `ops`, `type`, `target`, `reason`, `status`, `created_at`

State:

- `name`, `heads`, `policy`, `updated_at`

Resolution:

- standard operation plus `resolves: string[]`

## 7. Repository Layout (Target)

```text
/packages
  /model
  /server
  /daemon
  /cli
/docs
  /rfcs
  /implementation
```

## 8. Validation and Tests

Required test layers:

- schema validation tests for all contracts
- server behavior tests for accept/conflict/resolve paths
- replay determinism test for same state heads
- CLI integration tests against local server process
- materialization golden tests for stable output

## 9. Delivery Sequence

1. Land shared model and hash determinism helpers.
2. Land in-memory server with core endpoints and conflict persistence.
3. Land CLI operations for submit/list/show/resolve.
4. Land daemon attach + materialize loop.
5. Add policy gates and verification stubs.
6. Add checkpoints and replay performance path.
7. Harden with integration and determinism tests.

## 10. Exit Criteria for MVP

- End-to-end flow works locally without manual data surgery.
- Two conflicting ops produce a durable conflict object.
- Conflict resolution operation transitions conflict to resolved.
- Attach + stream + render loop converges deterministically.
- Protected state policy blocks invalid promotions.
