import { request } from "node:http";
import { request as requestTls } from "node:https";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function usage() {
  process.stdout.write(
    [
      "forge-daemon usage:",
      "  node packages/daemon/src/index.mjs attach <state> [--server http://localhost:8787]",
      "    [--sandbox ./sandbox] [--tree ./sandbox/tree] [--cache ./sandbox/forge.db] [--safe] [--once]",
      ""
    ].join("\n")
  );
}

function parseArgs(argv) {
  const [cmd, maybeState, ...rest] = argv;
  const flags = {
    server: "http://localhost:8787",
    sandbox: null,
    tree: null,
    cache: null,
    safe: false,
    once: false
  };

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--server") {
      flags.server = rest[i + 1];
      i += 1;
      continue;
    }
    if (token === "--sandbox") {
      flags.sandbox = resolve(rest[i + 1]);
      i += 1;
      continue;
    }
    if (token === "--tree") {
      flags.tree = resolve(rest[i + 1]);
      i += 1;
      continue;
    }
    if (token === "--cache") {
      flags.cache = resolve(rest[i + 1]);
      i += 1;
      continue;
    }
    if (token === "--safe") {
      flags.safe = true;
      continue;
    }
    if (token === "--once") {
      flags.once = true;
      continue;
    }
  }

  return { cmd, state: maybeState, flags };
}

function resolvePaths(flags) {
  if (flags.tree || flags.cache) {
    if (!flags.tree || !flags.cache) {
      throw new Error("--tree and --cache must be provided together");
    }
    return {
      treePath: resolve(flags.tree),
      cachePath: resolve(flags.cache)
    };
  }

  const sandboxRoot = resolve(flags.sandbox || "./sandbox");
  return {
    treePath: resolve(sandboxRoot, "tree"),
    cachePath: resolve(sandboxRoot, "forge.db")
  };
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

async function loadCache(cachePath) {
  try {
    const raw = await readFile(cachePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCache(cachePath, payload) {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(payload, null, 2), "utf8");
}

async function writeTree(treePath, tree, options) {
  const entries = Object.entries(tree || {}).sort(([a], [b]) => a.localeCompare(b));
  const previousTree = options.previousTree || {};

  if (!options.safe) {
    await rm(treePath, { recursive: true, force: true });
    await mkdir(treePath, { recursive: true });
    for (const [relativePath, content] of entries) {
      const destination = resolve(treePath, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content, "utf8");
    }
    return;
  }

  await mkdir(treePath, { recursive: true });
  for (const [relativePath, content] of entries) {
    const destination = resolve(treePath, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }

  const nextSet = new Set(entries.map(([path]) => path));
  const previousEntries = Object.entries(previousTree);
  for (const [relativePath, previousContent] of previousEntries) {
    if (nextSet.has(relativePath)) {
      continue;
    }
    const destination = resolve(treePath, relativePath);
    try {
      const currentContent = await readFile(destination, "utf8");
      if (currentContent === previousContent) {
        await rm(destination, { force: true });
      } else {
        process.stderr.write(
          `safe-sync skipped delete for modified file: ${relativePath}\n`
        );
      }
    } catch {
      // File already absent.
    }
  }
}

async function syncState(serverUrl, state, paths, options) {
  const encodedState = encodeURIComponent(state);
  const response = await requestJson("GET", `${serverUrl}/v1/states/${encodedState}`);
  if (response.status !== 200) {
    throw new Error(`attach failed with status ${response.status}: ${JSON.stringify(response.body)}`);
  }

  const previousCache = await loadCache(paths.cachePath);
  const previousTree = previousCache?.tree || {};
  const tree = response.body.tree || {};

  await writeTree(paths.treePath, tree, {
    safe: options.safe,
    previousTree
  });

  await writeCache(paths.cachePath, {
    ...response.body,
    tree
  });

  process.stdout.write(
    `synced state=${state} files=${Object.keys(tree).length} tree=${paths.treePath}\n`
  );
}

function streamState(serverUrl, state, onSnapshot) {
  const encodedState = encodeURIComponent(state);
  const url = new URL(`${serverUrl}/v1/stream/states/${encodedState}`);
  const transport = url.protocol === "https:" ? requestTls : request;

  const req = transport(
    url,
    {
      method: "GET",
      headers: { accept: "text/event-stream" }
    },
    (res) => {
      let buffer = "";
      let eventName = null;

      res.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          const lines = block.split("\n");
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventName = line.slice("event:".length).trim();
            }
            if (line.startsWith("data:")) {
              data += line.slice("data:".length).trim();
            }
          }
          if (eventName === "state_update" && data) {
            try {
              onSnapshot(JSON.parse(data));
            } catch (error) {
              process.stderr.write(`failed to parse stream payload: ${error}\n`);
            }
          }
          eventName = null;
        }
      });
    }
  );

  req.on("error", (error) => {
    process.stderr.write(`stream error: ${error}\n`);
  });
  req.end();
  return req;
}

async function run() {
  const { cmd, state, flags } = parseArgs(process.argv.slice(2));
  if (cmd !== "attach" || !state) {
    usage();
    process.exitCode = 1;
    return;
  }

  const paths = resolvePaths(flags);
  await syncState(flags.server, state, paths, { safe: flags.safe });
  if (flags.once) {
    return;
  }

  process.stdout.write(`streaming state=${state} from ${flags.server}\n`);
  streamState(flags.server, state, async (snapshot) => {
    try {
      const previousCache = await loadCache(paths.cachePath);
      const previousTree = previousCache?.tree || {};
      const nextTree = snapshot.tree || {};
      await writeTree(paths.treePath, nextTree, {
        safe: flags.safe,
        previousTree
      });
      await writeCache(paths.cachePath, {
        ...snapshot,
        tree: nextTree
      });
      process.stdout.write(
        `updated state=${state} files=${Object.keys(nextTree).length}\n`
      );
    } catch (error) {
      process.stderr.write(`sync error: ${error}\n`);
    }
  });
}

run().catch((error) => {
  process.stderr.write(`forge-daemon failed: ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
