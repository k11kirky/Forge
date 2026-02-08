import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ForgeStore } from "./store.mjs";
import { JsonSnapshotStore } from "./persistence/json-store.mjs";
import { RocksSnapshotStore } from "./persistence/rocks-store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const port = Number(process.env.FORGE_PORT || "8787");
const backend = process.env.FORGE_STORE_BACKEND || "rocks";
const dataDir = resolve(process.env.FORGE_DATA_DIR || `${repoRoot}/data`);
const dataFile = resolve(process.env.FORGE_DATA_FILE || `${dataDir}/server.json`);
const rocksPath = resolve(process.env.FORGE_ROCKS_PATH || `${dataDir}/rocksdb`);
const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};
const logLevelName = (process.env.FORGE_LOG_LEVEL || "info").toLowerCase();
const logThreshold = LOG_LEVELS[logLevelName] ?? LOG_LEVELS.info;
const logStateUpdates = process.env.FORGE_LOG_STATE_UPDATES === "1";
let requestSequence = 0;

function shouldLog(level) {
  const levelScore = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  return levelScore >= logThreshold;
}

function log(level, message, fields = {}) {
  if (!shouldLog(level)) {
    return;
  }
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...fields
    })}\n`
  );
}

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function makeSnapshotStore() {
  if (backend === "json") {
    return new JsonSnapshotStore(dataFile);
  }
  if (backend === "rocks") {
    return new RocksSnapshotStore(rocksPath);
  }
  throw new Error(`unsupported FORGE_STORE_BACKEND=${backend}`);
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean);
}

function decodePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sseWrite(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const snapshotStore = makeSnapshotStore();
await snapshotStore.init();
const seed = await snapshotStore.load();
const store = new ForgeStore(seed);

let persistTimer = null;
async function persistStore() {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    snapshotStore.save(store.serialize()).catch((error) => {
      log("error", "snapshot_save_failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }, 100);
}

store.events.on("op_accepted", (op) => {
  persistStore();
  log("debug", "op_accepted", {
    op_id: op.id,
    state: op.state,
    effect_kind: op.effect?.kind || null,
    writes: Array.isArray(op.writes) ? op.writes.length : 0,
    parent_count: Array.isArray(op.parents) ? op.parents.length : 0
  });
});

store.events.on("conflict", (conflict) => {
  persistStore();
  log(conflict.status === "open" ? "warn" : "info", "conflict_event", {
    conflict_id: conflict.id,
    state: conflict.state,
    status: conflict.status,
    type: conflict.type,
    target: conflict.target,
    reason: conflict.reason || null,
    ops: conflict.ops
  });
});

store.events.on("change_set", (changeSet) => {
  persistStore();
  log("info", "change_set_recorded", {
    change_set_id: changeSet.id,
    state: changeSet.state,
    status: changeSet.status,
    op_count: Array.isArray(changeSet.op_ids) ? changeSet.op_ids.length : 0,
    accepted: Array.isArray(changeSet.accepted) ? changeSet.accepted.length : 0,
    conflicts: Array.isArray(changeSet.conflicts) ? changeSet.conflicts.length : 0
  });
});

store.events.on("state_update", (event) => {
  if (!logStateUpdates) {
    return;
  }
  log("debug", "state_update", {
    state: event.state,
    heads: Array.isArray(event.snapshot?.state?.heads)
      ? event.snapshot.state.heads.length
      : 0,
    open_conflicts: Array.isArray(event.snapshot?.open_conflicts)
      ? event.snapshot.open_conflicts.length
      : 0,
    files: event.snapshot?.tree ? Object.keys(event.snapshot.tree).length : 0
  });
});

const server = createServer(async (req, res) => {
  const method = req.method || "GET";
  const url = new URL(req.url || "/", "http://localhost");
  const parts = splitPath(url.pathname);
  const reqId = `req_${++requestSequence}`;
  const startedAt = Date.now();

  log("debug", "http_request", {
    req_id: reqId,
    method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries())
  });
  res.on("finish", () => {
    log("info", "http_response", {
      req_id: reqId,
      method,
      path: url.pathname,
      status: res.statusCode,
      duration_ms: Date.now() - startedAt
    });
  });

  try {
    if (method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && parts.length === 2 && parts[0] === "v1" && parts[1] === "states") {
      json(res, 200, { states: store.listStates() });
      return;
    }

    if (method === "GET" && parts.length === 2 && parts[0] === "v1" && parts[1] === "change-sets") {
      const stateFilter = url.searchParams.get("state");
      json(res, 200, { change_sets: store.listChangeSets(stateFilter) });
      return;
    }

    if (method === "GET" && parts.length === 3 && parts[0] === "v1" && parts[1] === "change-sets") {
      const id = decodePart(parts[2]);
      const changeSet = store.getChangeSet(id);
      if (!changeSet) {
        json(res, 404, { error: "change_set not found" });
        return;
      }
      json(res, 200, changeSet);
      return;
    }

    if (method === "POST" && parts.length === 2 && parts[0] === "v1" && parts[1] === "states") {
      const body = await readJsonBody(req);
      const result = store.createState(body.name, {
        from_state: body.from_state || null
      });
      if (!result.ok) {
        log("warn", "state_create_rejected", {
          req_id: reqId,
          state: body.name || null,
          from_state: body.from_state || null,
          error: result.error || "unknown"
        });
        json(res, 400, result);
        return;
      }
      log("info", "state_created", {
        req_id: reqId,
        state: result.state?.name || body.name || null,
        from_state: body.from_state || null
      });
      json(res, 201, result);
      return;
    }

    if (method === "GET" && parts.length === 3 && parts[0] === "v1" && parts[1] === "states") {
      const state = decodePart(parts[2]);
      const snapshot = store.getStateSnapshot(state);
      if (!snapshot) {
        json(res, 404, { error: `state ${state} not found` });
        return;
      }
      json(res, 200, snapshot);
      return;
    }

    if (
      method === "GET" &&
      parts.length === 4 &&
      parts[0] === "v1" &&
      parts[1] === "states" &&
      parts[3] === "conflicts"
    ) {
      const state = decodePart(parts[2]);
      json(res, 200, { conflicts: store.listConflicts(state) });
      return;
    }

    if (
      method === "POST" &&
      parts.length === 4 &&
      parts[0] === "v1" &&
      parts[1] === "states" &&
      parts[3] === "promote"
    ) {
      const sourceState = decodePart(parts[2]);
      const body = await readJsonBody(req);
      const result = store.promoteState(
        sourceState,
        body.target_state,
        body.author || "agent:promoter"
      );
      if (!result.ok) {
        log("warn", "state_promote_rejected", {
          req_id: reqId,
          source_state: sourceState,
          target_state: body.target_state || null,
          error: result.error || "unknown"
        });
        json(res, 400, result);
        return;
      }
      log("info", "state_promoted", {
        req_id: reqId,
        source_state: sourceState,
        target_state: body.target_state || null,
        accepted: Array.isArray(result.accepted) ? result.accepted.length : 0,
        conflicts: Array.isArray(result.conflicts) ? result.conflicts.length : 0
      });
      json(res, 200, result);
      return;
    }

    if (method === "GET" && parts.length === 3 && parts[0] === "v1" && parts[1] === "conflicts") {
      const conflict = store.getConflict(decodePart(parts[2]));
      if (!conflict) {
        json(res, 404, { error: "conflict not found" });
        return;
      }
      json(res, 200, conflict);
      return;
    }

    if (method === "POST" && parts.length === 2 && parts[0] === "v1" && parts[1] === "ops") {
      const body = await readJsonBody(req);
      const payload = Array.isArray(body.ops) ? body.ops : body.op ? [body.op] : [body];
      const result = store.submitOps(payload);
      log("info", "ops_submitted", {
        req_id: reqId,
        state: payload[0]?.state || null,
        op_count: payload.length,
        status: result.status || null,
        accepted: Array.isArray(result.accepted) ? result.accepted.length : 0,
        conflicts: Array.isArray(result.conflicts) ? result.conflicts.length : 0
      });
      json(res, 200, result);
      return;
    }

    if (method === "GET" && parts.length === 3 && parts[0] === "v1" && parts[1] === "ops") {
      const id = decodePart(parts[2]);
      const op = store.getOperation(id);
      if (!op) {
        json(res, 404, { error: "operation not found" });
        return;
      }
      json(res, 200, op);
      return;
    }

    if (method === "POST" && parts.length === 2 && parts[0] === "v1" && parts[1] === "change-sets") {
      const body = await readJsonBody(req);
      const changeSetPayload = body.change_set ? body.change_set : body;
      const result = store.submitChangeSet(changeSetPayload);
      if (!result.ok) {
        log("warn", "change_set_rejected", {
          req_id: reqId,
          state: changeSetPayload?.state || null,
          op_count: Array.isArray(changeSetPayload?.ops) ? changeSetPayload.ops.length : 0,
          error: result.error || "unknown"
        });
        json(res, 400, result);
        return;
      }
      log("info", "change_set_submitted", {
        req_id: reqId,
        change_set_id: result.change_set_id || changeSetPayload?.id || null,
        state: changeSetPayload?.state || null,
        op_count: Array.isArray(changeSetPayload?.ops) ? changeSetPayload.ops.length : 0,
        status: result.status || null,
        accepted: Array.isArray(result.accepted) ? result.accepted.length : 0,
        conflicts: Array.isArray(result.conflicts) ? result.conflicts.length : 0
      });
      json(res, 200, result);
      return;
    }

    if (
      method === "POST" &&
      parts.length === 4 &&
      parts[0] === "v1" &&
      parts[1] === "conflicts" &&
      parts[3] === "resolve"
    ) {
      const conflictId = decodePart(parts[2]);
      const body = await readJsonBody(req);
      if (!body.op || typeof body.op !== "object") {
        log("warn", "conflict_resolve_rejected", {
          req_id: reqId,
          conflict_id: conflictId,
          error: "body.op is required"
        });
        json(res, 400, { error: "body.op is required" });
        return;
      }
      const result = store.resolveConflict(conflictId, body.op);
      if (!result.ok) {
        log("warn", "conflict_resolve_rejected", {
          req_id: reqId,
          conflict_id: conflictId,
          error: result.error || "unknown"
        });
        json(res, 400, result);
        return;
      }
      log("info", "conflict_resolved", {
        req_id: reqId,
        conflict_id: conflictId,
        resolution_op_id: body.op.id || null
      });
      json(res, 200, result);
      return;
    }

    if (
      method === "GET" &&
      parts.length === 4 &&
      parts[0] === "v1" &&
      parts[1] === "stream" &&
      parts[2] === "states"
    ) {
      const state = decodePart(parts[3]);
      log("info", "state_stream_open", {
        req_id: reqId,
        state
      });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      sseWrite(res, "state_update", store.getStateSnapshot(state));

      let streamUpdates = 0;
      const onUpdate = (event) => {
        if (event.state !== state) {
          return;
        }
        sseWrite(res, "state_update", event.snapshot);
        streamUpdates += 1;
      };

      const heartbeat = setInterval(() => {
        res.write(": keepalive\n\n");
      }, 15000);

      store.events.on("state_update", onUpdate);
      req.on("close", () => {
        clearInterval(heartbeat);
        store.events.off("state_update", onUpdate);
        log("info", "state_stream_closed", {
          req_id: reqId,
          state,
          updates: streamUpdates,
          duration_ms: Date.now() - startedAt
        });
      });
      return;
    }

    log("warn", "route_not_found", {
      req_id: reqId,
      method,
      path: url.pathname
    });
    json(res, 404, { error: "not found" });
  } catch (error) {
    log("error", "http_handler_failed", {
      req_id: reqId,
      method,
      path: url.pathname,
      error: error instanceof Error ? error.message : String(error)
    });
    json(res, 500, {
      error: "internal error",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(port, () => {
  log("info", "server_listening", {
    bind: `http://localhost:${port}`,
    backend,
    log_level: logLevelName,
    data_file: dataFile,
    rocks_path: rocksPath
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    log("info", "server_shutdown_signal", { signal });
    server.close();
    try {
      await snapshotStore.close();
      log("info", "server_shutdown_complete", { signal });
    } finally {
      process.exit(0);
    }
  });
}
