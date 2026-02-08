import { EventEmitter } from "node:events";
import {
  CONFLICT_TYPES,
  clone,
  contentHash,
  defaultPolicyForState,
  makeConflictRecord,
  normalizeChangeSet,
  normalizeOperation,
  nowIso,
  validateChangeSetShape,
  validateOperationShape
} from "../../model/src/index.mjs";
import {
  applyJsonTopLevelEffect,
  applyPythonSymbolEffect,
  parseJsonDocument,
  parsePythonTopLevel
} from "../../model/src/adapters.mjs";

function toSet(values = []) {
  return new Set(values);
}

function sortedIds(values = []) {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function decodePart(value) {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseSymbolId(symbolId) {
  if (typeof symbolId !== "string" || !symbolId.startsWith("sym://")) {
    return null;
  }

  const hashIdx = symbolId.indexOf("#");
  if (hashIdx === -1) {
    return null;
  }
  const base = symbolId.slice("sym://".length, hashIdx);
  const fragment = symbolId.slice(hashIdx + 1);
  const slashIdx = base.indexOf("/");
  if (slashIdx === -1) {
    return null;
  }

  return {
    adapter: base.slice(0, slashIdx),
    path: decodePart(base.slice(slashIdx + 1)),
    fragment
  };
}

function hashForSymbolFromTree(symbolId, pathHint, tree) {
  const parsed = parseSymbolId(symbolId);
  const path = parsed?.path || pathHint || null;
  if (!path || !tree || typeof tree !== "object") {
    return undefined;
  }

  const content = tree[path];
  if (typeof content !== "string") {
    return null;
  }

  if (parsed?.fragment === "document") {
    return contentHash(content);
  }

  if (parsed?.adapter === "json" && parsed.fragment.startsWith("key:")) {
    const key = decodePart(parsed.fragment.slice("key:".length));
    const doc = parseJsonDocument(content);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      return null;
    }
    if (!Object.prototype.hasOwnProperty.call(doc, key)) {
      return null;
    }
    return contentHash(doc[key]);
  }

  if (parsed?.adapter === "python") {
    const splitAt = parsed.fragment.indexOf(":");
    if (splitAt === -1) {
      return undefined;
    }
    const kind = decodePart(parsed.fragment.slice(0, splitAt));
    const name = decodePart(parsed.fragment.slice(splitAt + 1));
    const py = parsePythonTopLevel(content);
    if (py.parse_error) {
      return null;
    }
    const symbol = py.symbols.get(`${kind}:${name}`);
    if (!symbol) {
      return null;
    }
    return contentHash(symbol.body);
  }

  return undefined;
}

export class ForgeStore {
  constructor(seed = null) {
    this.events = new EventEmitter();
    this.ops = new Map();
    this.changeSets = new Map();
    this.conflicts = new Map();
    this.states = new Map();
    this.stateOps = new Map();
    this.stateSymbolHead = new Map();
    this.stateSymbolHash = new Map();
    this.sequence = 0;
    this.conflictSequence = 0;
    this.changeSetSequence = 0;

    if (seed) {
      this.hydrate(seed);
    }
    if (!this.states.has("main")) {
      this.createState("main");
    }
  }

  hydrate(seed) {
    this.sequence = seed.sequence || 0;
    this.conflictSequence = seed.conflictSequence || 0;
    this.changeSetSequence = seed.change_set_sequence || 0;

    for (const stateEntry of seed.states || []) {
      this._ensureStateContainers(stateEntry.name);
      this.states.set(stateEntry.name, {
        name: stateEntry.name,
        base_state: stateEntry.base_state || null,
        base_heads: Array.isArray(stateEntry.base_heads) ? stateEntry.base_heads : [],
        heads: Array.isArray(stateEntry.heads) ? stateEntry.heads : [],
        policy: stateEntry.policy || defaultPolicyForState(stateEntry.name),
        created_at: stateEntry.created_at || nowIso(),
        updated_at: stateEntry.updated_at || nowIso()
      });
    }

    for (const op of seed.ops || []) {
      if (!this.states.has(op.state)) {
        this.createState(op.state);
      }
      this.ops.set(op.id, op);
      this._ensureStateContainers(op.state);
      this.stateOps.get(op.state).push(op.id);
    }

    for (const changeSet of seed.change_sets || []) {
      this.changeSets.set(changeSet.id, changeSet);
    }

    for (const conflict of seed.conflicts || []) {
      this.conflicts.set(conflict.id, conflict);
    }

    this._rebuildDerivedCaches();
  }

  serialize() {
    return {
      sequence: this.sequence,
      conflictSequence: this.conflictSequence,
      change_set_sequence: this.changeSetSequence,
      ops: Array.from(this.ops.values()),
      change_sets: Array.from(this.changeSets.values()),
      conflicts: Array.from(this.conflicts.values()),
      states: Array.from(this.states.values())
    };
  }

  listStates() {
    return Array.from(this.states.values())
      .map((state) => ({
        ...clone(state),
        open_conflicts: this.listConflicts(state.name, "open").length,
        op_count: (this.stateOps.get(state.name) || []).length
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  listChangeSets(state = null) {
    const out = [];
    for (const changeSet of this.changeSets.values()) {
      if (state && changeSet.state !== state) {
        continue;
      }
      out.push(clone(changeSet));
    }
    out.sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
    return out;
  }

  getChangeSet(id) {
    const changeSet = this.changeSets.get(id);
    return changeSet ? clone(changeSet) : null;
  }

  getOperation(id) {
    const op = this.ops.get(id);
    return op ? clone(op) : null;
  }

  createState(name, options = {}) {
    if (!name || typeof name !== "string") {
      return { ok: false, error: "state name is required" };
    }
    if (this.states.has(name)) {
      return { ok: false, error: `state ${name} already exists` };
    }

    const fromState = options.from_state || null;
    if (fromState && !this.states.has(fromState)) {
      return { ok: false, error: `parent state ${fromState} not found` };
    }

    this._ensureStateContainers(name);
    const parent = fromState ? this.states.get(fromState) : null;
    const baseHeads = parent ? clone(parent.heads || []) : [];
    const policy = options.policy || defaultPolicyForState(name);

    if (fromState) {
      this.stateSymbolHead.set(name, new Map(this.stateSymbolHead.get(fromState)));
      this.stateSymbolHash.set(name, new Map(this.stateSymbolHash.get(fromState)));
    }

    const stateEntry = {
      name,
      base_state: fromState,
      base_heads: baseHeads,
      heads: baseHeads,
      policy,
      created_at: nowIso(),
      updated_at: nowIso()
    };

    this.states.set(name, stateEntry);
    this.events.emit("state_update", {
      state: name,
      snapshot: this.getStateSnapshot(name)
    });
    return { ok: true, state: clone(stateEntry) };
  }

  getStateSnapshot(state) {
    if (!this.states.has(state)) {
      return null;
    }
    const stateEntry = clone(this.states.get(state));
    const conflicts = this.listConflicts(state, "open");
    const tree = this.materializeState(state);

    return {
      state: stateEntry,
      open_conflicts: conflicts,
      tree
    };
  }

  listConflicts(state, status = null) {
    const out = [];
    for (const conflict of this.conflicts.values()) {
      if (state && conflict.state !== state) {
        continue;
      }
      if (status && conflict.status !== status) {
        continue;
      }
      out.push(clone(conflict));
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  getConflict(id) {
    const conflict = this.conflicts.get(id);
    return conflict ? clone(conflict) : null;
  }

  submitChangeSet(changeSetInput) {
    const normalizedSet = normalizeChangeSet(changeSetInput);
    const setError = validateChangeSetShape(normalizedSet);
    if (setError) {
      return {
        ok: false,
        error: setError
      };
    }

    if (!this.states.has(normalizedSet.state)) {
      return {
        ok: false,
        error: `state ${normalizedSet.state} not found`
      };
    }

    const existing = this.changeSets.get(normalizedSet.id);
    if (existing) {
      const conflictDetails = (existing.conflicts || [])
        .map((id) => this.conflicts.get(id))
        .filter(Boolean)
        .map((conflict) => clone(conflict));
      return {
        ok: true,
        duplicate: true,
        change_set_id: existing.id,
        status: existing.status,
        accepted: clone(existing.accepted || []),
        conflicts: clone(existing.conflicts || []),
        conflict_details: conflictDetails,
        results: clone(existing.results || [])
      };
    }

    const state = this.states.get(normalizedSet.state);
    const stagedSymbolHeads = new Map(this.stateSymbolHead.get(normalizedSet.state) || []);
    const stagedSymbolHashes = new Map(this.stateSymbolHash.get(normalizedSet.state) || []);
    const stagedTree = this.materializeState(normalizedSet.state);
    const stagedOps = [];
    const localParents = new Map();
    const results = [];
    const conflictRecords = [];
    const accepted = [];
    let hasOpenConflicts = this.listConflicts(normalizedSet.state, "open").length > 0;
    let blocked = false;

    for (let i = 0; i < normalizedSet.ops.length; i += 1) {
      const rawOp = normalizedSet.ops[i];
      if (blocked) {
        results.push({
          index: i,
          status: "skipped",
          reason: "not evaluated because a prior operation failed"
        });
        continue;
      }

      const op = normalizeOperation({
        ...rawOp,
        state: rawOp.state || normalizedSet.state
      });
      if (op.state !== normalizedSet.state) {
        results.push({
          index: i,
          op_id: op.id,
          status: "rejected",
          reason: `operation state ${op.state} does not match change_set state ${normalizedSet.state}`
        });
        blocked = true;
        continue;
      }

      const validationError = validateOperationShape(op);
      if (validationError) {
        results.push({
          index: i,
          op_id: op.id,
          status: "rejected",
          reason: validationError
        });
        blocked = true;
        continue;
      }

      if (this.ops.has(op.id)) {
        results.push({
          index: i,
          op_id: op.id,
          status: "accepted",
          duplicate: true
        });
        accepted.push(op.id);
        continue;
      }

      const opConflicts = this._classifyConflictsWithContext(op, state, {
        symbolHeads: stagedSymbolHeads,
        symbolHashes: stagedSymbolHashes,
        hasOpenConflicts,
        localParents,
        stagedTree
      });
      if (opConflicts.length > 0) {
        const ids = opConflicts.map((conflict) => conflict.id);
        results.push({
          index: i,
          op_id: op.id,
          status: "conflicted",
          conflicts: sortedIds(ids)
        });
        conflictRecords.push(...opConflicts);
        blocked = true;
        continue;
      }

      stagedOps.push(op);
      localParents.set(op.id, [...op.parents]);
      accepted.push(op.id);
      results.push({
        index: i,
        op_id: op.id,
        status: "accepted"
      });
      for (const symbol of op.writes) {
        stagedSymbolHeads.set(symbol, op.id);
        const hash = this._symbolHashForWrite(op.effect, symbol, op);
        if (hash === null) {
          stagedSymbolHashes.delete(symbol);
        } else if (typeof hash === "string") {
          stagedSymbolHashes.set(symbol, hash);
        }
      }
      this._applyEffectToVirtualTree(stagedTree, op);
      hasOpenConflicts = hasOpenConflicts || false;
    }

    const conflictIds = [];
    for (const conflict of conflictRecords) {
      this.conflicts.set(conflict.id, conflict);
      conflictIds.push(conflict.id);
      this.events.emit("conflict", clone(conflict));
    }

    if (conflictRecords.length > 0 || blocked) {
      const status = conflictRecords.length > 0 ? "conflicted" : "rejected";
      const record = this._recordChangeSet(normalizedSet, {
        status,
        accepted,
        conflicts: conflictIds,
        results
      });

      return {
        ok: true,
        change_set_id: record.id,
        status: record.status,
        accepted: sortedIds(accepted),
        conflicts: sortedIds(conflictIds),
        conflict_details: conflictRecords.map((conflict) => clone(conflict)),
        results
      };
    }

    for (const op of stagedOps) {
      this._acceptOperation(op);
    }

    const record = this._recordChangeSet(normalizedSet, {
      status: "accepted",
      accepted,
      conflicts: [],
      results
    });

    return {
      ok: true,
      change_set_id: record.id,
      status: record.status,
      accepted: sortedIds(accepted),
      conflicts: [],
      conflict_details: [],
      results
    };
  }

  submitOps(payload) {
    const ops = Array.isArray(payload) ? payload : [payload];
    const changeSetPayload = {
      state: ops[0]?.state || "",
      metadata: {
        author: ops[0]?.metadata?.author || "agent:unknown",
        intent: "submit_ops compatibility path",
        source: "legacy_submit_ops"
      },
      ops
    };
    return this.submitChangeSet(changeSetPayload);
  }

  promoteState(sourceState, targetState, author = "agent:promoter") {
    if (!this.states.has(sourceState)) {
      return { ok: false, error: `source state ${sourceState} not found` };
    }
    if (!this.states.has(targetState)) {
      return { ok: false, error: `target state ${targetState} not found` };
    }
    if (sourceState === targetState) {
      return { ok: false, error: "source and target states must differ" };
    }

    const sourceOpIds = [...(this.stateOps.get(sourceState) || [])];
    const targetPromotions = this._existingPromotionSet(targetState);
    let parentHeads = clone(this.states.get(targetState).heads || []);

    const accepted = [];
    const conflicts = [];
    const results = [];

    for (const sourceOpId of sourceOpIds) {
      if (targetPromotions.has(sourceOpId)) {
        results.push({
          source_op_id: sourceOpId,
          status: "skipped",
          reason: "already promoted"
        });
        continue;
      }

      const sourceOp = this.ops.get(sourceOpId);
      if (!sourceOp) {
        continue;
      }

      const promoted = clone(sourceOp);
      promoted.id = `op_promote_${contentHash({
        source_op_id: sourceOp.id,
        source_state: sourceState,
        target_state: targetState,
        parents: parentHeads
      }).replace("hash_", "")}`;
      promoted.state = targetState;
      promoted.parents = parentHeads;
      promoted.resolves = [];
      promoted.metadata = {
        ...sourceOp.metadata,
        author,
        intent: `Promote ${sourceOp.id} from ${sourceState}`,
        source_state: sourceState,
        source_op_id: sourceOp.id,
        timestamp: nowIso()
      };

      const submit = this.submitOps(promoted);
      const firstResult = submit.results[0] || { status: "unknown" };
      results.push({
        source_op_id: sourceOp.id,
        promoted_op_id: promoted.id,
        status: firstResult.status,
        conflicts: firstResult.conflicts || [],
        reason: firstResult.reason || null
      });

      if (firstResult.status === "accepted") {
        accepted.push(promoted.id);
        parentHeads = [promoted.id];
        targetPromotions.add(sourceOp.id);
        continue;
      }

      if (firstResult.status === "conflicted") {
        for (const id of firstResult.conflicts || []) {
          conflicts.push(id);
        }
        break;
      }

      if (firstResult.status === "rejected") {
        break;
      }
    }

    return {
      ok: true,
      source_state: sourceState,
      target_state: targetState,
      accepted: sortedIds(accepted),
      conflicts: sortedIds(conflicts),
      results
    };
  }

  resolveConflict(conflictId, opInput) {
    const conflict = this.conflicts.get(conflictId);
    if (!conflict) {
      return {
        ok: false,
        error: `conflict ${conflictId} not found`
      };
    }
    if (conflict.status !== "open") {
      return {
        ok: false,
        error: `conflict ${conflictId} is not open`
      };
    }

    const op = normalizeOperation({
      ...opInput,
      resolves: Array.from(new Set([...(opInput.resolves || []), conflictId]))
    });

    const result = this.submitOps(op);
    const accepted = result.accepted.includes(op.id);
    if (!accepted) {
      return {
        ok: false,
        error: "resolution operation was not accepted",
        submit_result: result
      };
    }

    return {
      ok: true,
      conflict: this.getConflict(conflictId),
      submit_result: result
    };
  }

  materializeState(stateName, visiting = new Set()) {
    if (!this.states.has(stateName)) {
      return {};
    }
    if (visiting.has(stateName)) {
      return {};
    }
    visiting.add(stateName);

    const state = this.states.get(stateName);
    const fileMap = new Map();
    if (state.base_state) {
      const baseTree = this.materializeState(state.base_state, visiting);
      for (const [path, content] of Object.entries(baseTree)) {
        fileMap.set(path, content);
      }
    }

    const opIds = this.stateOps.get(stateName) || [];
    for (const opId of opIds) {
      const op = this.ops.get(opId);
      if (!op) {
        continue;
      }
      const effect = op.effect || {};
      if (effect.kind === "delete_file") {
        const path = effect.path || op.target.path_hint;
        if (path) {
          fileMap.delete(path);
        }
        continue;
      }

      if (effect.kind === "upsert_file") {
        if (typeof effect.path === "string" && typeof effect.content === "string") {
          fileMap.set(effect.path, effect.content);
        }
        continue;
      }

      if (effect.kind === "json_set_key" || effect.kind === "json_delete_key") {
        if (typeof effect.path === "string") {
          const current = fileMap.get(effect.path) || "";
          fileMap.set(effect.path, applyJsonTopLevelEffect(current, effect));
        }
        continue;
      }

      if (
        effect.kind === "python_replace_symbol" ||
        effect.kind === "python_insert_symbol" ||
        effect.kind === "python_delete_symbol"
      ) {
        const path = effect.path || op.target.path_hint;
        if (typeof path === "string") {
          const current = fileMap.get(path) || "";
          fileMap.set(path, applyPythonSymbolEffect(current, effect));
        }
        continue;
      }

      if (effect.kind === "replace_body") {
        const path = op.target.path_hint;
        if (typeof path === "string" && typeof effect.after_content === "string") {
          fileMap.set(path, effect.after_content);
        }
      }
    }

    visiting.delete(stateName);
    return Object.fromEntries(
      Array.from(fileMap.entries()).sort(([pathA], [pathB]) => pathA.localeCompare(pathB))
    );
  }

  _ensureStateContainers(state) {
    if (!this.stateOps.has(state)) {
      this.stateOps.set(state, []);
    }
    if (!this.stateSymbolHead.has(state)) {
      this.stateSymbolHead.set(state, new Map());
    }
    if (!this.stateSymbolHash.has(state)) {
      this.stateSymbolHash.set(state, new Map());
    }
  }

  _recordChangeSet(changeSet, outcome) {
    this.changeSetSequence += 1;
    const record = {
      id: changeSet.id,
      sequence: this.changeSetSequence,
      state: changeSet.state,
      metadata: clone(changeSet.metadata || {}),
      atomic: true,
      op_ids: changeSet.ops.map((op) => op.id || null),
      status: outcome.status,
      accepted: sortedIds(outcome.accepted || []),
      conflicts: sortedIds(outcome.conflicts || []),
      results: clone(outcome.results || []),
      created_at: nowIso()
    };
    this.changeSets.set(record.id, record);
    this.events.emit("change_set", clone(record));
    return record;
  }

  _existingPromotionSet(stateName) {
    const out = new Set();
    for (const opId of this.stateOps.get(stateName) || []) {
      const op = this.ops.get(opId);
      const sourceOpId = op?.metadata?.source_op_id;
      if (typeof sourceOpId === "string") {
        out.add(sourceOpId);
      }
    }
    return out;
  }

  _rebuildDerivedCaches() {
    for (const stateName of this.states.keys()) {
      this._ensureStateContainers(stateName);
      this.stateOps.set(stateName, []);
      this.stateSymbolHead.set(stateName, new Map());
      this.stateSymbolHash.set(stateName, new Map());
    }

    for (const op of this.ops.values()) {
      if (!this.stateOps.has(op.state)) {
        this._ensureStateContainers(op.state);
      }
      this.stateOps.get(op.state).push(op.id);
    }

    for (const [stateName, opIds] of this.stateOps.entries()) {
      opIds.sort((a, b) => {
        const opA = this.ops.get(a);
        const opB = this.ops.get(b);
        return (opA?.canonical_order || 0) - (opB?.canonical_order || 0);
      });
      this.stateOps.set(stateName, opIds);
    }

    const memo = new Map();
    const build = (stateName, visiting = new Set()) => {
      if (memo.has(stateName)) {
        return memo.get(stateName);
      }
      if (visiting.has(stateName)) {
        return { heads: new Map(), hashes: new Map() };
      }
      visiting.add(stateName);

      const state = this.states.get(stateName);
      let symbolHeads = new Map();
      let symbolHashes = new Map();
      if (state && state.base_state && this.states.has(state.base_state)) {
        const inherited = build(state.base_state, visiting);
        symbolHeads = new Map(inherited.heads);
        symbolHashes = new Map(inherited.hashes);
      }

      for (const opId of this.stateOps.get(stateName) || []) {
        const op = this.ops.get(opId);
        if (!op) {
          continue;
        }
        for (const symbol of op.writes || []) {
          symbolHeads.set(symbol, op.id);
          const hash = this._symbolHashForWrite(op.effect, symbol, op);
          if (hash === null) {
            symbolHashes.delete(symbol);
          } else if (typeof hash === "string") {
            symbolHashes.set(symbol, hash);
          }
        }
      }

      const value = { heads: symbolHeads, hashes: symbolHashes };
      memo.set(stateName, value);
      this.stateSymbolHead.set(stateName, symbolHeads);
      this.stateSymbolHash.set(stateName, symbolHashes);
      visiting.delete(stateName);
      return value;
    };

    for (const stateName of this.states.keys()) {
      build(stateName);
    }

    // Self-heal legacy snapshots where `state.heads` drifted or was missing.
    // Recompute heads from base-state lineage plus accepted ops.
    const headMemo = new Map();
    const computeHeads = (stateName, visiting = new Set()) => {
      if (headMemo.has(stateName)) {
        return headMemo.get(stateName);
      }
      if (visiting.has(stateName)) {
        return [];
      }
      visiting.add(stateName);

      const state = this.states.get(stateName);
      const headSet = new Set();
      if (state?.base_state && this.states.has(state.base_state)) {
        for (const inherited of computeHeads(state.base_state, visiting)) {
          headSet.add(inherited);
        }
      }

      for (const opId of this.stateOps.get(stateName) || []) {
        const op = this.ops.get(opId);
        if (!op) {
          continue;
        }
        for (const parent of op.parents || []) {
          headSet.delete(parent);
        }
        headSet.add(op.id);
      }

      const heads = Array.from(headSet);
      headMemo.set(stateName, heads);

      if (state) {
        state.base_heads =
          state.base_state && this.states.has(state.base_state)
            ? Array.from(computeHeads(state.base_state, visiting))
            : [];
        state.heads = heads;
        this.states.set(stateName, state);
      }

      visiting.delete(stateName);
      return heads;
    };

    for (const stateName of this.states.keys()) {
      computeHeads(stateName);
    }
  }

  _classifyConflicts(op, state) {
    return this._classifyConflictsWithContext(op, state, {
      symbolHeads: this.stateSymbolHead.get(state.name) || new Map(),
      symbolHashes: this.stateSymbolHash.get(state.name) || new Map(),
      hasOpenConflicts: this.listConflicts(state.name, "open").length > 0,
      stagedTree: this.materializeState(state.name)
    });
  }

  _classifyConflictsWithContext(op, state, context) {
    const out = [];
    const stateName = state.name;
    const symbolHeads = context.symbolHeads || new Map();
    const symbolHashes = context.symbolHashes || new Map();
    const parentSet = toSet(op.parents);

    for (const precondition of op.preconditions) {
      if (precondition.kind === "symbol_exists") {
        if (!symbolHeads.get(op.target.symbol_id)) {
          out.push(
            this._newConflict({
              state: stateName,
              opId: op.id,
              type: CONFLICT_TYPES.precondition,
              target: op.target.symbol_id,
              reason: "required symbol does not exist"
            })
          );
        }
      }

      if (precondition.kind === "signature_hash") {
        const derived = hashForSymbolFromTree(
          op.target.symbol_id,
          op.target?.path_hint,
          context.stagedTree || null
        );
        const current = derived === undefined ? symbolHashes.get(op.target.symbol_id) || null : derived;
        if (current !== precondition.value) {
          out.push(
            this._newConflict({
              state: stateName,
              opId: op.id,
              type: CONFLICT_TYPES.precondition,
              target: op.target.symbol_id,
              reason: `signature hash mismatch (expected ${precondition.value}, got ${current})`
            })
          );
        }
      }
    }

    for (const symbol of op.writes) {
      const existingOpId = symbolHeads.get(symbol);
      if (
        existingOpId &&
        !this._isAncestorOrSelf(existingOpId, parentSet, context.localParents)
      ) {
        out.push(
          this._newConflict({
            state: stateName,
            opId: op.id,
            existingOpId,
            type: CONFLICT_TYPES.semanticWrite,
            target: symbol,
            reason: "non-commutative write against current symbol head"
          })
        );
      }
    }

    if (!state.policy.allow_open_conflicts && context.hasOpenConflicts) {
      out.push(
        this._newConflict({
          state: stateName,
          opId: op.id,
          type: CONFLICT_TYPES.policy,
          target: op.target.symbol_id,
          reason: "state policy forbids accepting ops while conflicts are open"
        })
      );
    }

    const verificationConflicts = this._verifyOperation(op, stateName, context);
    for (const conflict of verificationConflicts) {
      out.push(conflict);
    }

    return out;
  }

  _newConflict({ state, opId, existingOpId, type, target, reason }) {
    this.conflictSequence += 1;
    const id = `conf_${this.conflictSequence}`;
    return makeConflictRecord({
      id,
      state,
      opId,
      existingOpId,
      type,
      target,
      reason
    });
  }

  _effectPath(effect, op) {
    return effect?.path || op?.target?.path_hint || null;
  }

  _applyEffectToVirtualTree(tree, op) {
    const effect = op.effect || {};
    const path = this._effectPath(effect, op);
    if (!path) {
      return { applied: false, path: null, nextContent: null };
    }

    if (effect.kind === "delete_file") {
      delete tree[path];
      return { applied: true, path, nextContent: null };
    }

    if (effect.kind === "upsert_file") {
      if (typeof effect.content === "string") {
        tree[path] = effect.content;
        return { applied: true, path, nextContent: effect.content };
      }
      return { applied: false, path, nextContent: null };
    }

    if (effect.kind === "json_set_key" || effect.kind === "json_delete_key") {
      const current = typeof tree[path] === "string" ? tree[path] : "";
      const next = applyJsonTopLevelEffect(current, effect);
      tree[path] = next;
      return { applied: true, path, nextContent: next };
    }

    if (
      effect.kind === "python_replace_symbol" ||
      effect.kind === "python_insert_symbol" ||
      effect.kind === "python_delete_symbol"
    ) {
      const current = typeof tree[path] === "string" ? tree[path] : "";
      const next = applyPythonSymbolEffect(current, effect);
      tree[path] = next;
      return { applied: true, path, nextContent: next };
    }

    if (effect.kind === "replace_body") {
      if (typeof effect.after_content === "string") {
        tree[path] = effect.after_content;
        return { applied: true, path, nextContent: effect.after_content };
      }
      return { applied: false, path, nextContent: null };
    }

    return { applied: false, path, nextContent: null };
  }

  _verifyOperation(op, stateName, context) {
    const effect = op.effect || {};
    const path = this._effectPath(effect, op);
    if (!path || !String(path).toLowerCase().endsWith(".py")) {
      return [];
    }

    const tree = {
      ...(context.stagedTree || this.materializeState(stateName))
    };
    const preview = this._applyEffectToVirtualTree(tree, op);
    if (!preview.applied || typeof preview.nextContent !== "string") {
      return [];
    }

    const parsed = parsePythonTopLevel(preview.nextContent);
    if (parsed.parse_error) {
      return [
        this._newConflict({
          state: stateName,
          opId: op.id,
          type: CONFLICT_TYPES.verification,
          target: op.target.symbol_id,
          reason: "python adapter parse failed after applying operation"
        })
      ];
    }

    if ((parsed.duplicates || []).length > 0) {
      return [
        this._newConflict({
          state: stateName,
          opId: op.id,
          type: CONFLICT_TYPES.verification,
          target: op.target.symbol_id,
          reason: `python duplicate top-level symbols: ${(parsed.duplicates || []).join(", ")}`
        })
      ];
    }

    return [];
  }

  _symbolHashForWrite(effect, symbol, op = null) {
    if (!effect || typeof effect !== "object") {
      return undefined;
    }
    const symbolHashes = effect.symbol_hashes;
    if (
      symbolHashes &&
      typeof symbolHashes === "object" &&
      Object.prototype.hasOwnProperty.call(symbolHashes, symbol)
    ) {
      const value = symbolHashes[symbol];
      if (value === null) {
        return null;
      }
      if (typeof value === "string") {
        return value;
      }
    }

    // Legacy fallback: some older semantic ops omitted symbol_hashes.
    // Only map `after_hash` onto the symbol directly mutated by the effect.
    if (typeof effect.after_hash === "string") {
      if (effect.kind === "upsert_file") {
        const parsed = parseSymbolId(symbol);
        if (!parsed || parsed.fragment === "document") {
          return effect.after_hash;
        }
      }
      if (effect.kind === "replace_body") {
        return effect.after_hash;
      }

      if (effect.kind === "json_set_key") {
        const parsed = parseSymbolId(symbol);
        const path = effect.path || op?.target?.path_hint || null;
        const expectedFragment = `key:${encodeURIComponent(String(effect.key || ""))}`;
        if (
          parsed &&
          parsed.adapter === "json" &&
          parsed.path === path &&
          parsed.fragment === expectedFragment
        ) {
          return effect.after_hash;
        }
      }

      if (effect.kind === "python_replace_symbol" || effect.kind === "python_insert_symbol") {
        const parsed = parseSymbolId(symbol);
        const path = effect.path || op?.target?.path_hint || null;
        const expectedFragment = `${encodeURIComponent(
          String(effect.symbol_kind || "")
        )}:${encodeURIComponent(String(effect.symbol_name || ""))}`;
        if (
          parsed &&
          parsed.adapter === "python" &&
          parsed.path === path &&
          parsed.fragment === expectedFragment
        ) {
          return effect.after_hash;
        }
      }
    }
    return undefined;
  }

  _isAncestorOrSelf(candidateOpId, directParents, localParents = null) {
    if (!candidateOpId) {
      return false;
    }

    const stack = [...directParents];
    const seen = new Set();
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || seen.has(current)) {
        continue;
      }
      if (current === candidateOpId) {
        return true;
      }
      seen.add(current);

      const local = localParents?.get(current);
      const parents = Array.isArray(local) ? local : this.ops.get(current)?.parents || [];
      for (const parentId of parents) {
        stack.push(parentId);
      }
    }
    return false;
  }

  _acceptOperation(op) {
    this.sequence += 1;
    op.accepted_at = nowIso();
    op.canonical_order = this.sequence;

    this.ops.set(op.id, op);
    this._ensureStateContainers(op.state);
    this.stateOps.get(op.state).push(op.id);

    const state = this.states.get(op.state);
    const heads = new Set(state.heads || []);
    for (const parent of op.parents) {
      heads.delete(parent);
    }
    heads.add(op.id);
    state.heads = Array.from(heads);
    state.updated_at = nowIso();
    this.states.set(op.state, state);

    for (const symbol of op.writes) {
      this.stateSymbolHead.get(op.state).set(symbol, op.id);
      const hash = this._symbolHashForWrite(op.effect, symbol, op);
      if (hash === null) {
        this.stateSymbolHash.get(op.state).delete(symbol);
      } else if (typeof hash === "string") {
        this.stateSymbolHash.get(op.state).set(symbol, hash);
      }
    }

    for (const conflictId of op.resolves || []) {
      const conflict = this.conflicts.get(conflictId);
      if (!conflict || conflict.status !== "open") {
        continue;
      }
      conflict.status = "resolved";
      conflict.resolved_by = op.id;
      conflict.resolved_at = nowIso();
      this.conflicts.set(conflictId, conflict);
      this.events.emit("conflict", clone(conflict));
    }

    this.events.emit("state_update", {
      state: op.state,
      snapshot: this.getStateSnapshot(op.state)
    });
    this.events.emit("op_accepted", clone(op));
  }
}
