import { createHash } from "node:crypto";

export const CONFLICT_TYPES = {
  semanticWrite: "semantic_write_conflict",
  precondition: "precondition_failure",
  policy: "policy_conflict",
  verification: "verification_conflict"
};

export function nowIso() {
  return new Date().toISOString();
}

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortObject(item));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortObject(value[key]);
    }
    return out;
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(sortObject(value));
}

export function contentHash(value) {
  const hash = createHash("sha256");
  hash.update(stableStringify(value));
  return `hash_${hash.digest("hex").slice(0, 20)}`;
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function validateOperationShape(op) {
  if (!op || typeof op !== "object") {
    return "operation must be an object";
  }
  if (!op.state || typeof op.state !== "string") {
    return "operation.state is required";
  }
  if (!op.target || typeof op.target !== "object") {
    return "operation.target is required";
  }
  if (!op.target.symbol_id || typeof op.target.symbol_id !== "string") {
    return "operation.target.symbol_id is required";
  }
  if (!Array.isArray(op.parents)) {
    return "operation.parents must be an array";
  }
  if (!Array.isArray(op.preconditions)) {
    return "operation.preconditions must be an array";
  }
  if (!Array.isArray(op.reads)) {
    return "operation.reads must be an array";
  }
  if (!Array.isArray(op.writes) || op.writes.length === 0) {
    return "operation.writes must be a non-empty array";
  }
  if (!op.effect || typeof op.effect !== "object") {
    return "operation.effect is required";
  }
  if (!op.effect.kind || typeof op.effect.kind !== "string") {
    return "operation.effect.kind is required";
  }
  if (!op.metadata || typeof op.metadata !== "object") {
    return "operation.metadata is required";
  }
  if (!op.metadata.author || typeof op.metadata.author !== "string") {
    return "operation.metadata.author is required";
  }
  return null;
}

export function normalizeOperation(opInput) {
  const op = clone(opInput);
  op.parents = Array.isArray(op.parents) ? op.parents : [];
  op.preconditions = Array.isArray(op.preconditions) ? op.preconditions : [];
  op.reads = Array.isArray(op.reads) ? op.reads : [];
  op.writes = Array.isArray(op.writes) ? op.writes : [];
  op.resolves = Array.isArray(op.resolves) ? op.resolves : [];
  op.metadata = op.metadata || {};
  if (!op.metadata.timestamp) {
    op.metadata.timestamp = nowIso();
  }

  if (!op.id) {
    const unsigned = { ...op };
    delete unsigned.id;
    op.id = `op_${contentHash(unsigned).replace("hash_", "")}`;
  }

  return op;
}

export function validateChangeSetShape(changeSet) {
  if (!changeSet || typeof changeSet !== "object") {
    return "change_set must be an object";
  }
  if (!changeSet.state || typeof changeSet.state !== "string") {
    return "change_set.state is required";
  }
  if (!Array.isArray(changeSet.ops) || changeSet.ops.length === 0) {
    return "change_set.ops must be a non-empty array";
  }
  return null;
}

export function normalizeChangeSet(changeSetInput) {
  const changeSet = clone(changeSetInput);
  changeSet.ops = Array.isArray(changeSet.ops) ? changeSet.ops.map((op) => clone(op)) : [];
  changeSet.metadata = changeSet.metadata || {};
  if (!changeSet.metadata.timestamp) {
    changeSet.metadata.timestamp = nowIso();
  }
  if (!changeSet.id) {
    const unsigned = {
      state: changeSet.state,
      metadata: changeSet.metadata,
      ops: changeSet.ops
    };
    changeSet.id = `cs_${contentHash(unsigned).replace("hash_", "")}`;
  }
  return changeSet;
}

export function makeConflictRecord({
  id,
  state,
  opId,
  existingOpId,
  type,
  target,
  reason
}) {
  const ops = existingOpId ? [existingOpId, opId] : [opId];
  return {
    id,
    state,
    ops,
    type,
    target,
    reason,
    status: "open",
    created_at: nowIso(),
    resolved_at: null,
    resolved_by: null
  };
}

export function defaultPolicyForState(state) {
  if (state === "prod") {
    return {
      name: "prod-default",
      allow_open_conflicts: false,
      required_checks: ["unit", "integration"],
      required_human_approvals: 1
    };
  }
  return {
    name: "main-default",
    allow_open_conflicts: true,
    required_checks: [],
    required_human_approvals: 0
  };
}
