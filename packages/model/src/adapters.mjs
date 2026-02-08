import { spawnSync } from "node:child_process";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pythonAstScript = resolve(__dirname, "../scripts/python_ast_adapter.py");
const configuredPythonBin = process.env.FORGE_PYTHON_BIN || null;
const configuredPythonParser = (process.env.FORGE_PYTHON_PARSER || "auto").toLowerCase();
const strictPythonParser = process.env.FORGE_PYTHON_PARSER_STRICT === "1";
let cachedPythonBin = undefined;

function normalizePath(path) {
  return String(path || "").split("\\").join("/");
}

function encoded(value) {
  return encodeURIComponent(String(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stableJson(item));
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
      out[key] = stableJson(value[key]);
    }
    return out;
  }
  return value;
}

export function stableJsonStringify(value) {
  return JSON.stringify(stableJson(value));
}

export function adapterForPath(path) {
  const extension = extname(String(path || "")).toLowerCase();
  if (extension === ".py") {
    return "python";
  }
  if (extension === ".json") {
    return "json";
  }
  if (extension === ".md" || extension === ".markdown") {
    return "markdown";
  }
  if (extension === ".txt") {
    return "text";
  }
  return "file";
}

export function fileDocumentSymbol(path, adapter = "file") {
  return `sym://${adapter}/${normalizePath(path)}#document`;
}

export function jsonKeySymbol(path, key) {
  return `sym://json/${normalizePath(path)}#key:${encoded(key)}`;
}

export function pythonSymbol(path, kind, name) {
  return `sym://python/${normalizePath(path)}#${encoded(kind)}:${encoded(name)}`;
}

export function parseJsonDocument(content) {
  if (typeof content !== "string") {
    return null;
  }
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function jsonValueEqual(left, right) {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

export function diffJsonTopLevel(beforeContent, afterContent) {
  const beforeValue = parseJsonDocument(beforeContent);
  const afterValue = parseJsonDocument(afterContent);
  if (!isPlainObject(beforeValue) || !isPlainObject(afterValue)) {
    return null;
  }

  const keys = new Set([
    ...Object.keys(beforeValue),
    ...Object.keys(afterValue)
  ]);
  const changes = [];
  for (const key of Array.from(keys).sort((a, b) => a.localeCompare(b))) {
    const hasBefore = Object.prototype.hasOwnProperty.call(beforeValue, key);
    const hasAfter = Object.prototype.hasOwnProperty.call(afterValue, key);
    if (!hasBefore && !hasAfter) {
      continue;
    }
    if (hasBefore && hasAfter && jsonValueEqual(beforeValue[key], afterValue[key])) {
      continue;
    }
    changes.push({
      key,
      before_exists: hasBefore,
      after_exists: hasAfter,
      before_value: hasBefore ? beforeValue[key] : null,
      after_value: hasAfter ? afterValue[key] : null
    });
  }
  return changes;
}

export function renderJsonDocument(value) {
  const normalized = stableJson(value);
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

export function applyJsonTopLevelEffect(currentContent, effect) {
  const path = effect?.path;
  if (typeof path !== "string") {
    return currentContent;
  }
  const current = parseJsonDocument(currentContent);
  const obj = isPlainObject(current) ? { ...current } : {};
  if (effect.kind === "json_set_key") {
    obj[effect.key] = effect.value;
    return renderJsonDocument(obj);
  }
  if (effect.kind === "json_delete_key") {
    delete obj[effect.key];
    return renderJsonDocument(obj);
  }
  return currentContent;
}

function detectPythonBinary() {
  if (cachedPythonBin !== undefined) {
    return cachedPythonBin;
  }

  const candidates = configuredPythonBin
    ? [configuredPythonBin]
    : ["python3", "python"];
  for (const candidate of candidates) {
    try {
      const check = spawnSync(candidate, ["--version"], {
        encoding: "utf8",
        timeout: 2000
      });
      if (check.error) {
        continue;
      }
      if (check.status === 0) {
        cachedPythonBin = candidate;
        return cachedPythonBin;
      }
    } catch {
      // Keep trying candidates.
    }
  }

  cachedPythonBin = null;
  return cachedPythonBin;
}

function runPythonAst(action, content) {
  const pythonBin = detectPythonBinary();
  if (!pythonBin) {
    return null;
  }

  try {
    const proc = spawnSync(
      pythonBin,
      [pythonAstScript],
      {
        input: JSON.stringify({
          action,
          content: typeof content === "string" ? content : "",
          parser: configuredPythonParser
        }),
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 3000
      }
    );
    if (proc.error || proc.status !== 0) {
      return null;
    }
    const raw = (proc.stdout || "").trim();
    if (!raw) {
      return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function pythonDefinitionRegex() {
  return /^(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\b[^\n]*$/gm;
}

function parsePythonTopLevelRegex(content) {
  const source = typeof content === "string" ? content : "";
  const matches = [];
  const regex = pythonDefinitionRegex();
  let match = regex.exec(source);
  while (match) {
    matches.push({
      kind: match[1],
      name: match[2],
      start: match.index
    });
    match = regex.exec(source);
  }

  const symbols = new Map();
  const order = [];
  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    const next = matches[i + 1];
    const start = current.start;
    const end = next ? next.start : source.length;
    const body = source.slice(start, end);
    const key = `${current.kind}:${current.name}`;
    symbols.set(key, {
      key,
      kind: current.kind,
      name: current.name,
      start,
      end,
      body
    });
    order.push(key);
  }

  const counts = new Map();
  for (const key of order) {
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const duplicates = Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort((a, b) => a.localeCompare(b));

  return {
    symbols,
    order,
    duplicates,
    parse_error: false,
    parser: "regex"
  };
}

function parsePythonTopLevelAst(content) {
  const response = runPythonAst("parse_top_level", content);
  if (!response) {
    return { status: "unavailable", parser: "python-sidecar" };
  }
  if (response.ok !== true || !Array.isArray(response.symbols)) {
    if (response.error === "parser_unavailable") {
      return {
        status: "unavailable",
        parser: typeof response.parser === "string" ? response.parser : "python-sidecar"
      };
    }
    if (response.error === "syntax_error") {
      return {
        status: "syntax_error",
        parser: typeof response.parser === "string" ? response.parser : "python-sidecar"
      };
    }
    return {
      status: "error",
      parser: typeof response.parser === "string" ? response.parser : "python-sidecar"
    };
  }

  const rawSymbols = [];
  for (const item of response.symbols) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if (typeof item.kind !== "string" || typeof item.name !== "string") {
      continue;
    }
    const key = `${item.kind}:${item.name}`;
    const start = Number.isInteger(item.start) ? item.start : 0;
    const end = Number.isInteger(item.end) ? item.end : start;
    rawSymbols.push({
      key,
      kind: item.kind,
      name: item.name,
      start,
      end
    });
  }

  // Sidecar AST spans end at node end and exclude inter-symbol whitespace.
  // Normalize to contiguous top-level regions so insert/delete/replace preserve spacing.
  rawSymbols.sort((left, right) => {
    if (left.start !== right.start) {
      return left.start - right.start;
    }
    return left.end - right.end;
  });
  for (let i = 0; i < rawSymbols.length; i += 1) {
    const current = rawSymbols[i];
    const next = rawSymbols[i + 1];
    const maxEnd = typeof content === "string" ? content.length : current.end;
    let adjustedEnd = next ? next.start : maxEnd;
    if (!Number.isInteger(adjustedEnd)) {
      adjustedEnd = current.end;
    }
    if (adjustedEnd < current.start) {
      adjustedEnd = current.start;
    }
    if (adjustedEnd > maxEnd) {
      adjustedEnd = maxEnd;
    }
    current.end = adjustedEnd;
  }

  const symbols = new Map();
  const order = [];
  for (const item of rawSymbols) {
    const start = item.start;
    const end = item.end;
    const body =
      typeof content === "string" ? content.slice(start, end) : "";
    const symbol = {
      key: item.key,
      kind: item.kind,
      name: item.name,
      start,
      end,
      body
    };
    symbols.set(item.key, symbol);
    order.push(item.key);
  }

  const counts = new Map();
  for (const key of order) {
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const duplicates = Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort((a, b) => a.localeCompare(b));

  return {
    status: "success",
    parsed: {
      symbols,
      order,
      duplicates,
      parse_error: false,
      parser: typeof response.parser === "string" ? response.parser : "python-sidecar"
    }
  };
}

export function parsePythonTopLevel(content) {
  const astResult = parsePythonTopLevelAst(content);
  if (astResult.status === "success") {
    return astResult.parsed;
  }
  if (astResult.status === "syntax_error") {
    return {
      symbols: new Map(),
      order: [],
      duplicates: [],
      parse_error: true,
      parser: astResult.parser || "python-sidecar"
    };
  }
  if (configuredPythonParser === "libcst" && strictPythonParser) {
    return {
      symbols: new Map(),
      order: [],
      duplicates: [],
      parse_error: true,
      parser: astResult.parser || "libcst"
    };
  }

  return parsePythonTopLevelRegex(content);
}

function normalizePythonBlock(content) {
  if (typeof content !== "string" || content.length === 0) {
    return "";
  }
  let out = content;
  if (!out.endsWith("\n")) {
    out += "\n";
  }
  return out;
}

function replaceSlice(content, start, end, replacement) {
  return `${content.slice(0, start)}${replacement}${content.slice(end)}`;
}

function insertSlice(content, offset, insertion) {
  const before = content.slice(0, offset);
  const after = content.slice(offset);
  let middle = insertion;
  if (before.length > 0 && !before.endsWith("\n")) {
    middle = `\n${middle}`;
  }
  if (after.length > 0 && !middle.endsWith("\n")) {
    middle = `${middle}\n`;
  }
  return `${before}${middle}${after}`;
}

export function applyPythonSymbolEffect(currentContent, effect) {
  const source = typeof currentContent === "string" ? currentContent : "";
  const symbolKind = effect?.symbol_kind;
  const symbolName = effect?.symbol_name;
  if (typeof symbolKind !== "string" || typeof symbolName !== "string") {
    return source;
  }
  const key = `${symbolKind}:${symbolName}`;
  const parsed = parsePythonTopLevel(source);
  const symbol = parsed.symbols.get(key) || null;
  const beforeContent =
    typeof effect.before_content === "string" ? effect.before_content : null;

  if (effect.kind === "python_replace_symbol") {
    if (typeof effect.after_content !== "string") {
      return source;
    }
    if (!symbol) {
      if (beforeContent && source.includes(beforeContent)) {
        return source.replace(beforeContent, normalizePythonBlock(effect.after_content));
      }
      return source;
    }
    return replaceSlice(source, symbol.start, symbol.end, normalizePythonBlock(effect.after_content));
  }

  if (effect.kind === "python_delete_symbol") {
    if (!symbol) {
      if (beforeContent && source.includes(beforeContent)) {
        return source.replace(beforeContent, "");
      }
      return source;
    }
    return replaceSlice(source, symbol.start, symbol.end, "");
  }

  if (effect.kind === "python_insert_symbol") {
    if (symbol || typeof effect.after_content !== "string") {
      return source;
    }

    const block = normalizePythonBlock(effect.after_content);
    const afterKey = effect.insert_after_key;
    const beforeKey = effect.insert_before_key;

    if (typeof afterKey === "string") {
      const anchor = parsed.symbols.get(afterKey);
      if (anchor) {
        return insertSlice(source, anchor.end, block);
      }
    }

    if (typeof beforeKey === "string") {
      const anchor = parsed.symbols.get(beforeKey);
      if (anchor) {
        return insertSlice(source, anchor.start, block);
      }
    }

    return insertSlice(source, source.length, block);
  }

  return source;
}
