# RFC 0001: Forge Agent-First Semantic Version Control

- Status: Draft
- Authors: Forge Team
- Created: 2026-02-07
- Updated: 2026-02-07

## 1. Summary

Forge is a semantic version control system designed for massively parallel AI and human development on one codebase. Instead of storing line diffs and snapshots, Forge stores immutable semantic operations over code structures. Conflicts are first-class objects, and conflict resolution is represented as normal history.

This RFC defines the Forge core model, consistency rules, conflict semantics, API surface, storage architecture, and an MVP scope.

## 2. Problem Statement

Git-based workflows assume:

- text-level diffs are the primary unit of change
- merges are occasional and mostly human-driven
- concurrent writers are relatively low in number

These assumptions degrade when hundreds of AI agents edit the same repository continuously:

- line-level conflicts become noisy and frequent
- rebasing and branch drift consume system and human time
- history does not encode intent, confidence, or machine-usable semantics
- conflict handling is not structured for automated resolution at scale

Forge addresses this by representing changes as semantic operations in a causal graph.

## 3. Goals

- Support high write concurrency (hundreds to thousands of writers per state).
- Preserve deterministic repository materialization from server state.
- Represent conflicts as durable data, not transient CLI errors.
- Enable automated conflict resolution by agents with policy controls.
- Keep humans and agents on a single protocol and identity model.

## 4. Non-Goals

- Replacing all language tooling in v1.
- Supporting arbitrary binary merge semantics in v1.
- Eliminating human review requirements for protected states.
- Solving all semantic conflicts perfectly in fully automated mode.

## 5. Terminology

- Node: Immutable AST/CST node, content-addressed.
- Operation (Op): Atomic semantic change request.
- State: Named logical view of accepted operations.
- Conflict: Durable object representing non-commutative or invalid concurrent ops.
- Resolution: An operation that supersedes one or more conflicting ops.
- Materialization: Rendering a state into a filesystem tree.

## 6. Design Overview

Forge has four core primitives:

- `op`
- `conflict`
- `resolution` (a normal `op` with conflict references)
- `state`

All other capabilities are derived from these primitives and policy.

Key model decisions:

- operations are immutable and content-addressed
- states are causal DAG heads, not unordered sets
- conflicts are typed and persistent until resolved
- server defines authoritative op ordering for convergence

## 7. Data Model

### 7.1 Node Identity

Code is parsed into language-specific structural representations.

- semantic tree for meaning-aware transforms
- render tree metadata (including trivia/format hints) to preserve stable file output

Each node is immutable and hash-addressed by normalized payload.

### 7.2 Operation Schema

```json
{
  "id": "op_123",
  "parents": ["op_120", "op_121"],
  "state": "main",
  "target": {
    "symbol_id": "sym://ts/src/auth/login.ts#validatePassword",
    "path_hint": "src/auth/login.ts"
  },
  "preconditions": [
    {"kind": "symbol_exists"},
    {"kind": "signature_hash", "value": "hash_sig_abc"}
  ],
  "reads": ["sym://ts/src/auth/login.ts#validatePassword"],
  "writes": ["sym://ts/src/auth/login.ts#validatePassword"],
  "effect": {
    "kind": "replace_body",
    "before_hash": "hash_123",
    "after_hash": "hash_456"
  },
  "metadata": {
    "author": "agent:security",
    "intent": "Fix timing attack",
    "confidence": 0.91,
    "timestamp": "2026-02-07T00:00:00Z"
  }
}
```

### 7.3 States

A state is a named pointer to one or more DAG heads plus policy bindings.

```yaml
state: main
heads:
  - op_123
  - op_129
policy: main-default
```

States are not arbitrary unordered sets. Causal parentage is required for deterministic replay.

### 7.4 Conflict Schema

```json
{
  "id": "conf_17",
  "state": "main",
  "ops": ["op_200", "op_204"],
  "type": "semantic_write_conflict",
  "target": "sym://ts/src/auth/login.ts#validatePassword",
  "reason": "non-commutative writes on same symbol",
  "status": "open",
  "created_at": "2026-02-07T00:00:00Z"
}
```

### 7.5 Resolution Schema

Resolution is a normal operation with a `resolves` field:

```json
{
  "id": "op_250",
  "resolves": ["conf_17"],
  "effect": {"kind": "replace_body", "after_hash": "hash_999"}
}
```

## 8. Consistency and Replay

Forge guarantees:

- deterministic materialization for a given state head set and policy version
- eventual convergence of clients attached to the same state
- immutable historical audit trail

Server behavior:

- validate op schema and authn/authz
- check preconditions against current state snapshot
- classify accepted vs conflicting ops
- assign canonical ordering metadata
- publish change stream

Client behavior:

- maintain local overlay for unsubmitted edits
- rebase local overlay logically on streamed canonical updates
- recompute and display local conflict set

## 9. Conflict Semantics

Conflict is not limited to "same node touched." Forge classifies conflicts as:

- semantic write conflict: non-commutative writes to overlapping symbols
- precondition failure: required prior structure no longer valid
- policy conflict: operation violates state policy
- verification conflict: tests/checks fail for policy-gated states
- dependency conflict: incompatible lock/package graph effects

Conflicts remain durable objects until resolved or explicitly superseded by policy.

## 10. Materialization Model

Forge stores semantic data as source of truth and materializes files on demand.

Local workspace layout:

```text
/sandbox
  /tree      # rendered source tree
  forge.db   # local cache for nodes, ops, conflicts
```

Materialization requirements:

- stable rendering (idempotent output for same state)
- formatter compatibility
- support for non-code assets via typed passthrough objects in v1

## 11. API and Wire Protocol

All resources are versioned. Initial HTTP+SSE shape:

- `GET /v1/states/{state}`
- `POST /v1/ops`
- `GET /v1/conflicts/{id}`
- `POST /v1/conflicts/{id}/resolve`
- `GET /v1/stream/states/{state}` (SSE)

Submission flow:

1. client sends op batch
2. server validates and classifies each op
3. server returns accepted op ids and conflict ids
4. state stream emits canonical updates

## 12. Policy Model

Policies are attached to states and versioned independently.

Example:

```yaml
state: prod
rules:
  allow_open_conflicts: false
  required_checks:
    - unit
    - integration
  required_human_approvals: 1
  allowed_identities:
    - human:release-engineer
```

Policy evaluation happens on op acceptance and on promotion between states.

## 13. Storage Engine

Logical layers:

- node store: content-addressed structural blobs
- op store: immutable op log + indexes by state/author/symbol
- conflict store: typed conflict objects and status transitions
- state store: state heads + policy pointers
- checkpoint store: periodic materialized snapshots for fast attach

Reference implementations:

- RocksDB/LMDB-backed single-node prototype
- FoundationDB-backed distributed implementation

## 14. Security and Identity

Requirements:

- strong agent and human identities
- signed operation envelopes
- per-state authorization policies
- tamper-evident audit chain

Ops without valid signatures or insufficient scope must be rejected.

## 15. Scaling Strategy

To support high write rates:

- partition op/conflict indexes by state and symbol hash ranges
- batch ingestion and validation
- run impacted-test selection before full verification
- checkpoint every N accepted ops for bounded replay time

## 16. MVP Scope

MVP intentionally narrows complexity:

- Language adapters: Python (`.py`), JSON (`.json`), text (`.txt`), markdown (`.md`)
- Granularity: function/module-level ops
- States: `main` + ephemeral agent workspaces
- Conflict resolution: one AI resolver + manual fallback
- Verification: impact-based tests, full suite on promotion to protected states

Out of scope for MVP:

- polyglot cross-language semantic analysis
- distributed multi-region consensus
- advanced binary semantic merging

## 17. Migration Strategy

Phase 1 (interop):

- Forge operates as semantic control plane.
- Git remains external distribution format.
- Forge emits deterministic bot commits for compatibility.

Phase 2 (primary):

- Forge state becomes canonical for internal workflows.
- Git export remains available for downstream tooling.

Phase 3 (native):

- direct Forge-native CI/CD and deployment flows.

## 18. Open Questions

- What canonical symbol identity format works across language servers and refactors?
- Which conflict classes are safe for full auto-resolution in protected states?
- How should non-deterministic tools (formatters/lints with version drift) be pinned and attested?
- What SLOs define acceptable attach latency and conflict-resolution latency?

## 19. Success Metrics

- Attach p95 latency below target (to be defined in implementation plan)
- Conflict auto-resolution rate by class
- Mean time from op submit to accepted/rejected decision
- Human intervention rate per 1,000 ops
- Deterministic replay correctness in continuous validation

## 20. Alternatives Considered

- Git + better merge bots: lower change cost, but poor semantic conflict expressiveness.
- CRDT-only text model: strong convergence, weak code semantics.
- Branch-per-agent Git flow: operationally familiar, scales poorly with heavy parallelism.

Forge is chosen to optimize for semantic correctness and high-agent concurrency.

## 21. Appendix: Minimal CLI UX

```bash
forge attach main
forge submit
forge conflicts
forge conflict show conf_17
forge conflict resolve conf_17 --agent merge-bot
```

CLI is an interface layer, not the system boundary.
