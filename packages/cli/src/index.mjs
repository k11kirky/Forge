import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { request } from "node:http";
import { request as requestTls } from "node:https";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash, nowIso } from "../../model/src/index.mjs";
import {
  applyJsonTopLevelEffect,
  applyPythonSymbolEffect,
  adapterForPath,
  diffJsonTopLevel,
  fileDocumentSymbol,
  jsonKeySymbol,
  parsePythonTopLevel,
  pythonSymbol
} from "../../model/src/adapters.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliRoot = resolve(__dirname, "../../..");
const daemonEntry = resolve(cliRoot, "packages/daemon/src/index.mjs");

function usage() {
  process.stdout.write(
    [
      "forge CLI",
      "",
      "Primary commands:",
      "  forge init [--server http://localhost:8787] [--state main] [--mode sandbox|inplace] [--sandbox ./sandbox]",
      "  forge attach [state] [--server http://localhost:8787] [--sandbox ./sandbox]",
      "  forge create <state> [--from <state>] [--sandbox ./sandbox]",
      "  forge status",
      "  forge submit [--message \"...\"] [--author human:me] [--to <target>] [--stack]",
      "  forge stack",
      "  forge log [--state <state>] [--limit 20] [--all]",
      "  forge show <cs_id|op_id|conflict_id>",
      "",
      "Other commands:",
      "  forge submit --file <op.json> [--server http://localhost:8787]   # manual payload mode",
      "  forge states [--server http://localhost:8787]",
      "  forge state create <name> [--from main] [--server http://localhost:8787]",
      "  forge state promote <source> --to <target> [--author agent:merge-bot] [--server http://localhost:8787]",
      "  forge conflicts [--state main] [--server http://localhost:8787]",
      "  forge conflict show <conflict-id> [--server http://localhost:8787]",
      "  forge conflict resolve <conflict-id> --file <op.json> [--server http://localhost:8787]",
      ""
    ].join("\n")
  );
}

function parseFlags(tokens) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--server") {
      flags.server = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token === "--sandbox") {
      flags.sandbox = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token === "--file") {
      flags.file = resolve(tokens[i + 1]);
      i += 1;
      continue;
    }
    if (token === "--state") {
      flags.state = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token === "--from") {
      flags.from = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token === "--to") {
      flags.to = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token === "--author") {
      flags.author = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token === "--message") {
      flags.message = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token === "--limit") {
      flags.limit = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token === "--mode") {
      flags.mode = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token === "--all") {
      flags.all = true;
      continue;
    }
    if (token === "--stack") {
      flags.stack = true;
      continue;
    }
    if (token === "--json") {
      flags.json = true;
      continue;
    }
    if (token === "--force") {
      flags.force = true;
      continue;
    }
    positional.push(token);
  }
  return { flags, positional };
}

function requestJson(method, urlString, body = null) {
  const url = new URL(urlString);
  const transport = url.protocol === "https:" ? requestTls : request;

  return new Promise((resolvePromise, rejectPromise) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = transport(
      url,
      {
        method,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload)
            }
          : {}
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed = {};
          if (raw) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = { raw };
            }
          }
          resolvePromise({ status: res.statusCode || 0, body: parsed });
        });
      }
    );
    req.on("error", rejectPromise);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function isRootPath(path) {
  return resolve(path) === resolve(path, "..");
}

function findWorkspaceRoot(startPath) {
  let current = resolve(startPath);
  while (true) {
    const configPath = resolve(current, ".forge/config.json");
    try {
      if (statSync(configPath).isFile()) {
        return current;
      }
    } catch {
      // continue
    }
    if (isRootPath(current)) {
      return null;
    }
    current = resolve(current, "..");
  }
}

function configPath(root) {
  return resolve(root, ".forge/config.json");
}

function sessionPath(root) {
  return resolve(root, ".forge/session.json");
}

async function readJson(path) {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

async function loadContext(flags, options = {}) {
  const root = findWorkspaceRoot(process.cwd());
  if (!root) {
    if (options.requireConfig) {
      throw new Error("not initialized here. Run `forge init --server <url>` first.");
    }
    return {
      root: resolve(process.cwd()),
      config: null,
      session: null,
      server: flags.server || "http://localhost:8787"
    };
  }

  const config = await readJson(configPath(root));
  let session = null;
  try {
    session = await readJson(sessionPath(root));
  } catch {
    session = null;
  }

  return {
    root,
    config,
    session,
    server: flags.server || session?.server || config.server || "http://localhost:8787"
  };
}

function resolveWorkspacePaths(context, flags) {
  const mode = flags.mode || context.session?.workspace_mode || context.config?.workspace_mode || "sandbox";
  if (mode !== "sandbox" && mode !== "inplace") {
    throw new Error(`unsupported workspace mode: ${mode}`);
  }

  if (mode === "inplace") {
    return {
      workspace_mode: mode,
      sandbox_root: context.root,
      tree_path: context.root,
      cache_path: resolve(context.root, ".forge/forge.db"),
      safe_sync: true
    };
  }

  const sandboxRoot = resolve(
    context.root,
    flags.sandbox ||
      context.session?.sandbox_root ||
      context.config?.sandbox_path ||
      "sandbox"
  );
  return {
    workspace_mode: mode,
    sandbox_root: sandboxRoot,
    tree_path: resolve(sandboxRoot, "tree"),
    cache_path: resolve(sandboxRoot, "forge.db"),
    safe_sync: false
  };
}

async function runNode(args) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`command failed: node ${args.join(" ")}`));
      }
    });
  });
}

async function loadJsonFile(path) {
  if (!path) {
    throw new Error("--file is required");
  }
  return readJson(path);
}

async function cmdInit(flags) {
  const root = resolve(process.cwd());
  const mode = flags.mode || "sandbox";
  if (mode !== "sandbox" && mode !== "inplace") {
    throw new Error("--mode must be `sandbox` or `inplace`");
  }

  const cfgPath = configPath(root);
  try {
    await readFile(cfgPath, "utf8");
    if (!flags.force) {
      throw new Error(`workspace already initialized at ${cfgPath}. Use --force to overwrite.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("already initialized")) {
      throw error;
    }
  }

  const config = {
    version: 1,
    server: flags.server || "http://localhost:8787",
    default_state: flags.state || "main",
    workspace_mode: mode,
    sandbox_path: flags.sandbox || "sandbox",
    initialized_at: nowIso()
  };

  await writeJson(cfgPath, config);
  await mkdir(resolve(root, ".forge"), { recursive: true });

  process.stdout.write(`initialized Forge workspace at ${root}\n`);
  process.stdout.write(`server=${config.server} default_state=${config.default_state} mode=${mode}\n`);
  process.stdout.write("next: run `forge attach` to materialize the working tree\n");
}

async function writeSession(root, session) {
  await writeJson(sessionPath(root), session);
}

async function cmdAttach(stateArg, flags, options = {}) {
  const context = await loadContext(flags, { requireConfig: false });
  const state =
    stateArg ||
    flags.state ||
    context.session?.state ||
    context.config?.default_state ||
    "main";
  const paths = resolveWorkspacePaths(context, flags);
  const daemonArgs = [
    daemonEntry,
    "attach",
    state,
    "--server",
    context.server,
    "--tree",
    paths.tree_path,
    "--cache",
    paths.cache_path,
    "--once"
  ];
  if (paths.safe_sync) {
    daemonArgs.push("--safe");
  }

  await runNode(daemonArgs);
  if (!options.skipSessionWrite) {
    await writeSession(context.root, {
      state,
      server: context.server,
      workspace_mode: paths.workspace_mode,
      sandbox_root: paths.sandbox_root,
      tree_path: paths.tree_path,
      cache_path: paths.cache_path,
      updated_at: nowIso()
    });
    process.stdout.write(`session updated: state=${state}\n`);
  }
}

async function cmdCreate(stateName, flags) {
  if (!stateName) {
    throw new Error("create requires <state>");
  }
  const context = await loadContext(flags, { requireConfig: true });
  const fromState = flags.from || context.session?.state || context.config.default_state || "main";

  const response = await requestJson("POST", `${context.server}/v1/states`, {
    name: stateName,
    from_state: fromState
  });
  if (response.status !== 201) {
    throw new Error(`create failed: ${JSON.stringify(response.body)}`);
  }

  await cmdAttach(stateName, flags);
  process.stdout.write(`created state ${stateName} from ${fromState}\n`);
}

async function cmdStates(flags) {
  const context = await loadContext(flags, { requireConfig: false });
  const response = await requestJson("GET", `${context.server}/v1/states`);
  if (response.status !== 200) {
    throw new Error(JSON.stringify(response.body));
  }
  for (const state of response.body.states || []) {
    process.stdout.write(
      `${state.name} heads=${(state.heads || []).length} ops=${state.op_count} open_conflicts=${state.open_conflicts} base=${state.base_state || "-"}\n`
    );
  }
}

async function cmdStack(flags) {
  const context = await loadContext(flags, { requireConfig: true });
  if (!context.session?.state) {
    throw new Error("no active session. Run `forge attach` first.");
  }

  const response = await requestJson("GET", `${context.server}/v1/states`);
  if (response.status !== 200) {
    throw new Error(JSON.stringify(response.body));
  }
  const stateByName = new Map((response.body.states || []).map((state) => [state.name, state]));
  const chain = [];
  const seen = new Set();
  let cursor = context.session.state;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(cursor);
    cursor = stateByName.get(cursor)?.base_state || null;
  }
  chain.reverse();
  for (let i = 0; i < chain.length; i += 1) {
    const marker = i === chain.length - 1 ? "*" : " ";
    process.stdout.write(`${marker} ${chain[i]}\n`);
  }
}

function shouldIgnorePath(relativePath, mode) {
  if (!relativePath) {
    return true;
  }
  if (relativePath === ".DS_Store" || relativePath.endsWith("/.DS_Store")) {
    return true;
  }
  if (relativePath.startsWith(".git/") || relativePath === ".git") {
    return true;
  }
  if (relativePath.startsWith(".forge/") || relativePath === ".forge") {
    return true;
  }
  if (mode === "inplace" && (relativePath.startsWith("node_modules/") || relativePath === "node_modules")) {
    return true;
  }
  return false;
}

async function readTree(rootPath, mode) {
  const tree = {};

  async function walk(currentPath) {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(currentPath, entry.name);
      const rel = relative(rootPath, fullPath).split("\\").join("/");
      if (shouldIgnorePath(rel, mode)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const content = await readFile(fullPath, "utf8");
      tree[rel] = content;
    }
  }

  try {
    const info = await stat(rootPath);
    if (!info.isDirectory()) {
      return {};
    }
  } catch {
    return {};
  }

  await walk(rootPath);
  return tree;
}

async function loadBaselineTree(cachePath) {
  try {
    const parsed = await readJson(cachePath);
    return parsed.tree || {};
  } catch {
    return {};
  }
}

function sanitizeTreeForDiff(tree, mode) {
  const out = {};
  for (const [path, value] of Object.entries(tree || {})) {
    if (shouldIgnorePath(path, mode)) {
      continue;
    }
    out[path] = value;
  }
  return out;
}

function diffTrees(before, after, options) {
  const allPaths = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out = [];
  for (const path of Array.from(allPaths).sort((a, b) => a.localeCompare(b))) {
    const prev = Object.prototype.hasOwnProperty.call(before, path) ? before[path] : null;
    const next = Object.prototype.hasOwnProperty.call(after, path) ? after[path] : null;
    if (prev === next) {
      continue;
    }
    if (prev === null && next !== null && !options.allowAdditions) {
      continue;
    }
    out.push({
      path,
      before: prev,
      after: next
    });
  }
  return out;
}

function makeOperation({ state, parents, symbol, path, preconditions, effect, author, message }) {
  const opBody = {
    state,
    path,
    symbol,
    parents,
    preconditions,
    effect
  };

  return {
    id: `op_local_${contentHash(opBody).replace("hash_", "")}`,
    state,
    parents,
    target: {
      symbol_id: symbol,
      path_hint: path
    },
    preconditions,
    reads: [symbol],
    writes: [symbol],
    effect,
    metadata: {
      author,
      intent: message,
      confidence: 0.5,
      timestamp: nowIso()
    }
  };
}

function collectAdapterSymbolHashes(path, adapter, content) {
  if (typeof content !== "string") {
    return {};
  }

  if (adapter === "json") {
    const edits = diffJsonTopLevel("{}", content);
    if (!Array.isArray(edits)) {
      return {};
    }
    const out = {};
    for (const edit of edits) {
      if (!edit.after_exists) {
        continue;
      }
      const symbol = jsonKeySymbol(path, edit.key);
      out[symbol] = contentHash(edit.after_value);
    }
    return out;
  }

  if (adapter === "python") {
    const parsed = parsePythonTopLevel(content);
    const out = {};
    for (const key of parsed.order || []) {
      const symbolInfo = parsed.symbols.get(key);
      if (!symbolInfo) {
        continue;
      }
      const symbol = pythonSymbol(path, symbolInfo.kind, symbolInfo.name);
      out[symbol] = contentHash(symbolInfo.body);
    }
    return out;
  }

  return {};
}

function buildDocumentLevelOps({ state, change, parents, author, message, adapter }) {
  const symbol = fileDocumentSymbol(change.path, adapter);
  const beforeSymbolHashes = collectAdapterSymbolHashes(change.path, adapter, change.before);
  const afterSymbolHashes = collectAdapterSymbolHashes(change.path, adapter, change.after);
  const mergedSymbolHashes = {
    ...afterSymbolHashes
  };
  for (const prevSymbol of Object.keys(beforeSymbolHashes)) {
    if (Object.prototype.hasOwnProperty.call(afterSymbolHashes, prevSymbol)) {
      continue;
    }
    mergedSymbolHashes[prevSymbol] = null;
  }

  const writes = [symbol, ...Object.keys(mergedSymbolHashes)].sort((a, b) => a.localeCompare(b));
  const preconditions = [];
  if (change.before !== null) {
    preconditions.push({
      kind: "signature_hash",
      value: contentHash(change.before)
    });
  }

  const effect =
    change.after === null
        ? {
            kind: "delete_file",
            adapter,
            path: change.path,
            symbol_hashes: {
              [symbol]: null,
              ...mergedSymbolHashes
            }
          }
        : {
            kind: "upsert_file",
            adapter,
            path: change.path,
            content: change.after,
            after_hash: contentHash(change.after),
            symbol_hashes: {
              [symbol]: contentHash(change.after),
              ...mergedSymbolHashes
            }
          };

  const op = {
    ...makeOperation({
      state,
      parents,
      symbol,
      path: change.path,
      preconditions,
      effect,
      author,
      message
    }),
    reads: writes,
    writes
  };

  return {
    ops: [op],
    nextParents: [op.id]
  };
}

function buildJsonSemanticOps({ state, change, parents, author, message }) {
  const edits = diffJsonTopLevel(change.before, change.after);
  if (!Array.isArray(edits) || edits.length === 0) {
    return null;
  }

  const documentSymbol = fileDocumentSymbol(change.path, "json");
  const ops = [];
  let localParents = Array.isArray(parents) ? parents : [];
  let workingContent = typeof change.before === "string" ? change.before : "";
  for (const edit of edits) {
    const symbol = jsonKeySymbol(change.path, edit.key);
    const preconditions = [];
    if (edit.before_exists) {
      preconditions.push({
        kind: "signature_hash",
        value: contentHash(edit.before_value)
      });
    }

    const effect =
      edit.after_exists
        ? {
            kind: "json_set_key",
            adapter: "json",
            path: change.path,
            key: edit.key,
            value: edit.after_value,
            after_hash: contentHash(edit.after_value),
            symbol_hashes: {
              [symbol]: contentHash(edit.after_value)
            }
          }
        : {
            kind: "json_delete_key",
            adapter: "json",
            path: change.path,
            key: edit.key,
            symbol_hashes: {
              [symbol]: null
            }
          };

    const nextContent = applyJsonTopLevelEffect(workingContent, effect);
    effect.symbol_hashes[documentSymbol] = contentHash(nextContent);

    const op = {
      ...makeOperation({
      state,
      parents: localParents,
      symbol,
      path: change.path,
      preconditions,
      effect,
      author,
      message
      }),
      reads: [documentSymbol, symbol],
      writes: [documentSymbol, symbol]
    };
    ops.push(op);
    localParents = [op.id];
    workingContent = nextContent;
  }

  return {
    ops,
    nextParents: localParents
  };
}

function buildPythonSemanticOps({ state, change, parents, author, message }) {
  const before = parsePythonTopLevel(change.before);
  const after = parsePythonTopLevel(change.after);
  if (
    before.parse_error ||
    after.parse_error ||
    (before.duplicates || []).length > 0 ||
    (after.duplicates || []).length > 0
  ) {
    return null;
  }
  const beforeKeys = new Set(before.order || []);
  const afterKeys = new Set(after.order || []);

  const orderedKeys = [];
  for (const key of after.order || []) {
    orderedKeys.push(key);
  }
  const beforeOnly = [];
  for (const key of beforeKeys) {
    if (!afterKeys.has(key)) {
      beforeOnly.push(key);
    }
  }
  beforeOnly.sort((a, b) => a.localeCompare(b));
  orderedKeys.push(...beforeOnly);

  const documentSymbol = fileDocumentSymbol(change.path, "python");
  const ops = [];
  let localParents = Array.isArray(parents) ? parents : [];
  let workingContent = typeof change.before === "string" ? change.before : "";

  for (const key of orderedKeys) {
    const beforeSymbol = before.symbols.get(key) || null;
    const afterSymbol = after.symbols.get(key) || null;
    if (beforeSymbol && afterSymbol && beforeSymbol.body === afterSymbol.body) {
      continue;
    }

    const symbolInfo = afterSymbol || beforeSymbol;
    if (!symbolInfo) {
      continue;
    }

    const symbol = pythonSymbol(change.path, symbolInfo.kind, symbolInfo.name);
    const preconditions = [];
    if (beforeSymbol) {
      preconditions.push({
        kind: "signature_hash",
        value: contentHash(beforeSymbol.body)
      });
    }

    let effect = null;
    if (beforeSymbol && afterSymbol) {
      effect = {
        kind: "python_replace_symbol",
        adapter: "python",
        path: change.path,
        symbol_kind: symbolInfo.kind,
        symbol_name: symbolInfo.name,
        before_content: beforeSymbol.body,
        after_content: afterSymbol.body,
        after_hash: contentHash(afterSymbol.body),
        symbol_hashes: {
          [symbol]: contentHash(afterSymbol.body)
        }
      };
    } else if (!beforeSymbol && afterSymbol) {
      const index = (after.order || []).indexOf(key);
      const prevKey = index > 0 ? after.order[index - 1] : null;
      const nextKey = index >= 0 && index < after.order.length - 1 ? after.order[index + 1] : null;
      effect = {
        kind: "python_insert_symbol",
        adapter: "python",
        path: change.path,
        symbol_kind: symbolInfo.kind,
        symbol_name: symbolInfo.name,
        after_content: afterSymbol.body,
        insert_after_key: prevKey || null,
        insert_before_key: nextKey || null,
        after_hash: contentHash(afterSymbol.body),
        symbol_hashes: {
          [symbol]: contentHash(afterSymbol.body)
        }
      };
    } else if (beforeSymbol && !afterSymbol) {
      effect = {
        kind: "python_delete_symbol",
        adapter: "python",
        path: change.path,
        symbol_kind: symbolInfo.kind,
        symbol_name: symbolInfo.name,
        before_content: beforeSymbol.body,
        symbol_hashes: {
          [symbol]: null
        }
      };
    }

    if (!effect) {
      continue;
    }

    const nextContent = applyPythonSymbolEffect(workingContent, effect);
    effect.symbol_hashes[documentSymbol] = contentHash(nextContent);

    const op = {
      ...makeOperation({
      state,
      parents: localParents,
      symbol,
      path: change.path,
      preconditions,
      effect,
      author,
      message
      }),
      reads: [documentSymbol, symbol],
      writes: [documentSymbol, symbol]
    };
    ops.push(op);
    localParents = [op.id];
    workingContent = nextContent;
  }

  if (ops.length === 0) {
    return null;
  }

  return {
    ops,
    nextParents: localParents
  };
}

function buildOpsForChange({ state, change, parents, author, message }) {
  const adapter = adapterForPath(change.path);

  if (change.after === null || change.before === null) {
    return buildDocumentLevelOps({
      state,
      change,
      parents,
      author,
      message,
      adapter
    });
  }

  if (adapter === "json") {
    const semantic = buildJsonSemanticOps({
      state,
      change,
      parents,
      author,
      message
    });
    if (semantic) {
      return semantic;
    }
  }

  if (adapter === "python") {
    const semantic = buildPythonSemanticOps({
      state,
      change,
      parents,
      author,
      message
    });
    if (semantic) {
      return semantic;
    }
  }

  return buildDocumentLevelOps({
    state,
    change,
    parents,
    author,
    message,
    adapter
  });
}

function buildChangeSetFromDiff({ state, heads, changes, author, message }) {
  const ops = [];
  let parents = Array.isArray(heads) ? heads : [];

  for (const change of changes) {
    const built = buildOpsForChange({
      state,
      change,
      parents,
      author,
      message
    });
    ops.push(...built.ops);
    parents = built.nextParents;
  }

  return {
    state,
    metadata: {
      author,
      intent: message,
      timestamp: nowIso()
    },
    ops
  };
}

function resolvePromotionOrder({ currentState, targetState, stateByName, stackMode }) {
  if (currentState === targetState) {
    return [];
  }
  if (!stackMode) {
    return [currentState];
  }

  const lineage = [];
  const seen = new Set();
  let cursor = currentState;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    lineage.push(cursor);
    if (cursor === targetState) {
      break;
    }
    cursor = stateByName.get(cursor)?.base_state || null;
  }

  if (!lineage.includes(targetState)) {
    return [currentState];
  }
  return lineage.filter((name) => name !== targetState).reverse();
}

async function submitPayloadFile(flags) {
  const context = await loadContext(flags, { requireConfig: false });
  const filePayload = await loadJsonFile(flags.file);
  const body = Array.isArray(filePayload.ops)
    ? { ops: filePayload.ops }
    : filePayload.op
      ? { op: filePayload.op }
      : filePayload;
  const response = await requestJson("POST", `${context.server}/v1/ops`, body);
  if (response.status !== 200) {
    throw new Error(JSON.stringify(response.body));
  }
  process.stdout.write(JSON.stringify(response.body, null, 2) + "\n");
}

async function cmdStatus(flags) {
  const context = await loadContext(flags, { requireConfig: true });
  if (!context.session?.state) {
    throw new Error("no active session. Run `forge attach` first.");
  }

  const paths = resolveWorkspacePaths(context, flags);
  const baselineTree = sanitizeTreeForDiff(
    await loadBaselineTree(paths.cache_path),
    paths.workspace_mode
  );
  const workingTree = sanitizeTreeForDiff(
    await readTree(paths.tree_path, paths.workspace_mode),
    paths.workspace_mode
  );
  const changes = diffTrees(baselineTree, workingTree, {
    allowAdditions: true
  });

  process.stdout.write(
    `state=${context.session.state} mode=${paths.workspace_mode} tree=${paths.tree_path}\n`
  );
  process.stdout.write(
    `changed_files=${changes.length} baseline_files=${Object.keys(baselineTree).length} working_files=${Object.keys(workingTree).length}\n`
  );
  if (changes.length === 0) {
    process.stdout.write("working tree clean\n");
    return;
  }

  const grouped = {
    added: 0,
    modified: 0,
    deleted: 0
  };
  for (const change of changes) {
    let marker = "M";
    if (change.before === null && change.after !== null) {
      marker = "A";
      grouped.added += 1;
    } else if (change.before !== null && change.after === null) {
      marker = "D";
      grouped.deleted += 1;
    } else {
      grouped.modified += 1;
    }
    const adapter = adapterForPath(change.path);
    process.stdout.write(`${marker} ${change.path} adapter=${adapter}\n`);
  }
  process.stdout.write(
    `summary added=${grouped.added} modified=${grouped.modified} deleted=${grouped.deleted}\n`
  );
}

async function cmdSubmit(flags) {
  if (flags.file) {
    await submitPayloadFile(flags);
    return;
  }

  const context = await loadContext(flags, { requireConfig: true });
  if (!context.session?.state) {
    throw new Error("no active session. Run `forge attach` first.");
  }

  const paths = resolveWorkspacePaths(context, flags);
  const baselineTree = sanitizeTreeForDiff(
    await loadBaselineTree(paths.cache_path),
    paths.workspace_mode
  );
  const workingTree = sanitizeTreeForDiff(
    await readTree(paths.tree_path, paths.workspace_mode),
    paths.workspace_mode
  );
  const changes = diffTrees(baselineTree, workingTree, {
    allowAdditions: true
  });

  if (changes.length === 0) {
    process.stdout.write("no local changes detected\n");
  } else {
    const stateSnapshot = await requestJson(
      "GET",
      `${context.server}/v1/states/${encodeURIComponent(context.session.state)}`
    );
    if (stateSnapshot.status !== 200) {
      throw new Error(JSON.stringify(stateSnapshot.body));
    }

    const message = flags.message || `Update ${changes.length} file(s)`;
    const author = flags.author || "human:local";
    const changeSet = buildChangeSetFromDiff({
      state: context.session.state,
      heads: stateSnapshot.body.state?.heads || [],
      changes,
      author,
      message
    });

    const submitResponse = await requestJson("POST", `${context.server}/v1/change-sets`, {
      change_set: changeSet
    });
    if (submitResponse.status !== 200) {
      throw new Error(JSON.stringify(submitResponse.body));
    }
    if (submitResponse.body.status !== "accepted") {
      const body = {
        ...submitResponse.body
      };
      if (
        (!Array.isArray(body.conflict_details) || body.conflict_details.length === 0) &&
        Array.isArray(body.conflicts) &&
        body.conflicts.length > 0
      ) {
        const details = [];
        for (const conflictId of body.conflicts) {
          const conflictResponse = await requestJson(
            "GET",
            `${context.server}/v1/conflicts/${encodeURIComponent(conflictId)}`
          );
          if (conflictResponse.status === 200 && conflictResponse.body) {
            details.push(conflictResponse.body);
          }
        }
        if (details.length > 0) {
          body.conflict_details = details;
        }
      }
      process.stdout.write(JSON.stringify(body, null, 2) + "\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `submitted change set ${submitResponse.body.change_set_id} with ${submitResponse.body.accepted.length} op(s)\n`
    );

    await cmdAttach(context.session.state, flags, { skipSessionWrite: true });
  }

  if (flags.stack && !flags.to) {
    throw new Error("--stack requires --to <target-state>");
  }

  const targetState = flags.to || null;
  if (!targetState) {
    process.stdout.write(
      `kept changes on state ${context.session.state}; no promotion target specified\n`
    );
    return;
  }

  const statesResponse = await requestJson("GET", `${context.server}/v1/states`);
  if (statesResponse.status !== 200) {
    throw new Error(JSON.stringify(statesResponse.body));
  }
  const stateByName = new Map((statesResponse.body.states || []).map((state) => [state.name, state]));
  const order = resolvePromotionOrder({
    currentState: context.session.state,
    targetState,
    stateByName,
    stackMode: Boolean(flags.stack)
  });
  if (order.length === 0) {
    process.stdout.write(`already at target state ${targetState}; no promotion needed\n`);
    return;
  }

  const author = flags.author || "human:local";
  for (const source of order) {
    const response = await requestJson(
      "POST",
      `${context.server}/v1/states/${encodeURIComponent(source)}/promote`,
      {
        target_state: targetState,
        author
      }
    );
    if (response.status !== 200) {
      throw new Error(JSON.stringify(response.body));
    }
    const promoted = response.body.accepted?.length || 0;
    const conflicts = response.body.conflicts?.length || 0;
    process.stdout.write(
      `promote ${source} -> ${targetState}: accepted=${promoted} conflicts=${conflicts}\n`
    );
    if (conflicts > 0) {
      process.stdout.write(JSON.stringify(response.body, null, 2) + "\n");
      process.exitCode = 1;
      return;
    }
  }
}

async function cmdStateCreate(name, flags) {
  if (!name) {
    throw new Error("state name is required");
  }
  const context = await loadContext(flags, { requireConfig: false });
  const response = await requestJson("POST", `${context.server}/v1/states`, {
    name,
    from_state: flags.from || "main"
  });
  if (response.status !== 201) {
    throw new Error(JSON.stringify(response.body));
  }
  process.stdout.write(JSON.stringify(response.body, null, 2) + "\n");
}

async function cmdStatePromote(source, flags) {
  if (!source) {
    throw new Error("source state is required");
  }
  if (!flags.to) {
    throw new Error("--to <target-state> is required");
  }
  const context = await loadContext(flags, { requireConfig: false });
  const response = await requestJson(
    "POST",
    `${context.server}/v1/states/${encodeURIComponent(source)}/promote`,
    {
      target_state: flags.to,
      author: flags.author || "agent:merge-bot"
    }
  );
  if (response.status !== 200) {
    throw new Error(JSON.stringify(response.body));
  }
  process.stdout.write(JSON.stringify(response.body, null, 2) + "\n");
  if ((response.body.results || []).length === 0) {
    process.stdout.write(
      `no promotable ops found in ${source}; submit accepted changes on that state first\n`
    );
  }

  if (context.config && context.session?.state === flags.to) {
    await cmdAttach(flags.to, flags, { skipSessionWrite: true });
    process.stdout.write(
      `refreshed attached target state ${flags.to} after promotion\n`
    );
  }
}

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`expected a positive integer, got: ${value}`);
  }
  return parsed;
}

function compactText(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "-";
  }
  return value.replace(/\s+/g, " ").trim();
}

function formatStatus(status) {
  if (status === "accepted") {
    return "accepted";
  }
  if (status === "conflicted") {
    return "conflicted";
  }
  if (status === "rejected") {
    return "rejected";
  }
  if (status === "skipped") {
    return "skipped";
  }
  return status || "unknown";
}

async function cmdLog(flags) {
  const context = await loadContext(flags, { requireConfig: false });
  const limit = parsePositiveInt(flags.limit, 20);
  const state = flags.state || context.session?.state || context.config?.default_state || "main";
  const stateFilter = flags.all ? null : state;
  const suffix = stateFilter ? `?state=${encodeURIComponent(stateFilter)}` : "";
  const response = await requestJson("GET", `${context.server}/v1/change-sets${suffix}`);
  if (response.status !== 200) {
    throw new Error(JSON.stringify(response.body));
  }

  const all = (response.body.change_sets || []).slice().sort((left, right) => {
    return (right.sequence || 0) - (left.sequence || 0);
  });
  const shown = all.slice(0, limit);
  process.stdout.write(
    `log scope=${stateFilter || "all"} total=${all.length} showing=${shown.length}\n`
  );
  if (shown.length === 0) {
    return;
  }

  for (const changeSet of shown) {
    const author = compactText(changeSet.metadata?.author);
    const intent = compactText(changeSet.metadata?.intent);
    const opCount = Array.isArray(changeSet.op_ids) ? changeSet.op_ids.length : 0;
    const accepted = Array.isArray(changeSet.accepted) ? changeSet.accepted.length : 0;
    const conflicts = Array.isArray(changeSet.conflicts) ? changeSet.conflicts.length : 0;
    process.stdout.write(
      `[${String(changeSet.sequence || 0).padStart(4, "0")}] ${changeSet.id} state=${changeSet.state} status=${formatStatus(changeSet.status)} ops=${opCount} accepted=${accepted} conflicts=${conflicts}\n`
    );
    process.stdout.write(
      `       author=${author} at=${changeSet.created_at || "-"} intent=${intent}\n`
    );
  }
}

function renderJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function printChangeSet(changeSet) {
  const opIds = Array.isArray(changeSet.op_ids) ? changeSet.op_ids : [];
  const results = Array.isArray(changeSet.results) ? changeSet.results : [];
  process.stdout.write(
    `change_set ${changeSet.id}\nsequence=${changeSet.sequence || 0} state=${changeSet.state} status=${formatStatus(changeSet.status)} created_at=${changeSet.created_at || "-"}\n`
  );
  process.stdout.write(
    `author=${compactText(changeSet.metadata?.author)} intent=${compactText(changeSet.metadata?.intent)}\n`
  );
  process.stdout.write(
    `ops=${opIds.length} accepted=${Array.isArray(changeSet.accepted) ? changeSet.accepted.length : 0} conflicts=${Array.isArray(changeSet.conflicts) ? changeSet.conflicts.length : 0}\n`
  );
  if (opIds.length > 0) {
    process.stdout.write("op_ids:\n");
    for (const opId of opIds) {
      process.stdout.write(`  - ${opId}\n`);
    }
  }
  if (results.length > 0) {
    process.stdout.write("results:\n");
    for (const result of results) {
      const conflicts = Array.isArray(result.conflicts) ? result.conflicts.join(",") : "-";
      process.stdout.write(
        `  - index=${result.index} op_id=${result.op_id || "-"} status=${formatStatus(result.status)} conflicts=${conflicts} reason=${result.reason || "-"}\n`
      );
    }
  }
}

function printOperation(op) {
  const parents = Array.isArray(op.parents) ? op.parents : [];
  const reads = Array.isArray(op.reads) ? op.reads : [];
  const writes = Array.isArray(op.writes) ? op.writes : [];
  process.stdout.write(
    `operation ${op.id}\nstate=${op.state} target=${op.target?.symbol_id || "-"} path=${op.target?.path_hint || "-"}\n`
  );
  process.stdout.write(
    `effect=${op.effect?.kind || "-"} parents=${parents.length} reads=${reads.length} writes=${writes.length}\n`
  );
  process.stdout.write(
    `author=${compactText(op.metadata?.author)} intent=${compactText(op.metadata?.intent)} accepted_at=${op.accepted_at || "-"}\n`
  );
  if (parents.length > 0) {
    process.stdout.write("parents:\n");
    for (const id of parents) {
      process.stdout.write(`  - ${id}\n`);
    }
  }
  if (writes.length > 0) {
    process.stdout.write("writes:\n");
    for (const symbol of writes) {
      process.stdout.write(`  - ${symbol}\n`);
    }
  }
}

async function cmdShow(ref, flags) {
  if (!ref) {
    throw new Error("show requires an id (cs_..., op_..., or conf_...)");
  }
  if (ref.startsWith("conf_")) {
    await cmdConflictShow(ref, flags);
    return;
  }

  const context = await loadContext(flags, { requireConfig: false });
  if (ref.startsWith("cs_")) {
    const response = await requestJson("GET", `${context.server}/v1/change-sets/${encodeURIComponent(ref)}`);
    if (response.status !== 200) {
      throw new Error(JSON.stringify(response.body));
    }
    if (flags.json) {
      renderJson(response.body);
      return;
    }
    printChangeSet(response.body);
    return;
  }
  if (ref.startsWith("op_")) {
    const response = await requestJson("GET", `${context.server}/v1/ops/${encodeURIComponent(ref)}`);
    if (response.status !== 200) {
      throw new Error(JSON.stringify(response.body));
    }
    if (flags.json) {
      renderJson(response.body);
      return;
    }
    printOperation(response.body);
    return;
  }

  throw new Error("unknown id prefix. expected cs_, op_, or conf_.");
}

async function cmdConflicts(flags) {
  const context = await loadContext(flags, { requireConfig: false });
  const state = flags.state || "main";
  const response = await requestJson(
    "GET",
    `${context.server}/v1/states/${encodeURIComponent(state)}/conflicts`
  );
  if (response.status !== 200) {
    throw new Error(JSON.stringify(response.body));
  }
  const conflicts = response.body.conflicts || [];
  if (conflicts.length === 0) {
    process.stdout.write(`no conflicts for state=${state}\n`);
    return;
  }
  for (const conflict of conflicts) {
    process.stdout.write(
      `${conflict.id} ${conflict.status} ${conflict.type} ${conflict.target} ops=${conflict.ops.join(",")} reason=${conflict.reason || "-"}\n`
    );
  }
}

async function cmdConflictShow(conflictId, flags) {
  const context = await loadContext(flags, { requireConfig: false });
  const response = await requestJson(
    "GET",
    `${context.server}/v1/conflicts/${encodeURIComponent(conflictId)}`
  );
  if (response.status !== 200) {
    throw new Error(JSON.stringify(response.body));
  }
  process.stdout.write(JSON.stringify(response.body, null, 2) + "\n");
}

async function cmdConflictResolve(conflictId, flags) {
  const context = await loadContext(flags, { requireConfig: false });
  const payload = await loadJsonFile(flags.file);
  const body = payload.op ? payload : { op: payload };
  const response = await requestJson(
    "POST",
    `${context.server}/v1/conflicts/${encodeURIComponent(conflictId)}/resolve`,
    body
  );
  if (response.status !== 200) {
    throw new Error(JSON.stringify(response.body));
  }
  process.stdout.write(JSON.stringify(response.body, null, 2) + "\n");
}

async function run() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    usage();
    return;
  }

  const { flags, positional } = parseFlags(rest);

  if (command === "init") {
    await cmdInit(flags);
    return;
  }
  if (command === "attach") {
    await cmdAttach(positional[0], flags);
    return;
  }
  if (command === "create") {
    await cmdCreate(positional[0], flags);
    return;
  }
  if (command === "status") {
    await cmdStatus(flags);
    return;
  }
  if (command === "submit") {
    await cmdSubmit(flags);
    return;
  }
  if (command === "stack") {
    await cmdStack(flags);
    return;
  }
  if (command === "states") {
    await cmdStates(flags);
    return;
  }
  if (command === "log") {
    await cmdLog(flags);
    return;
  }
  if (command === "show") {
    await cmdShow(positional[0], flags);
    return;
  }

  if (command === "state") {
    const sub = positional[0];
    if (sub === "create") {
      await cmdStateCreate(positional[1], flags);
      return;
    }
    if (sub === "promote") {
      await cmdStatePromote(positional[1], flags);
      return;
    }
  }

  if (command === "conflicts") {
    await cmdConflicts(flags);
    return;
  }
  if (command === "conflict") {
    const sub = positional[0];
    if (sub === "show") {
      if (!positional[1]) {
        throw new Error("conflict id is required");
      }
      await cmdConflictShow(positional[1], flags);
      return;
    }
    if (sub === "resolve") {
      if (!positional[1]) {
        throw new Error("conflict id is required");
      }
      if (!flags.file) {
        throw new Error("--file is required");
      }
      await cmdConflictResolve(positional[1], flags);
      return;
    }
  }

  usage();
  process.exitCode = 1;
}

run().catch((error) => {
  const rendered =
    error instanceof Error ? `${error.message}\n${error.stack || ""}` : String(error);
  process.stderr.write(`forge CLI failed: ${rendered}\n`);
  process.exitCode = 1;
});
