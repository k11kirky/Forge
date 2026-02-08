# Forge

Agent-first semantic version control MVP scaffold.

## What is in this repo

- RFC: `docs/rfcs/0001-forge-agent-first-semantic-version-control.md`
- Build plan: `docs/implementation/forge-mvp-build-plan.md`
- Git mental model guide: `docs/guides/forge-for-git-users.md`
- Graphite-style workflow guide: `docs/guides/forge-graphite-workflow.md`
- Server: `packages/server/src/index.mjs`
- Daemon: `packages/daemon/src/index.mjs`
- CLI: `packages/cli/src/index.mjs`
- Shared model: `packages/model/src/index.mjs`

## Quickstart

Install dependencies:

```bash
npm install
```

Run CLI directly from this repo:

```bash
./forge <command>
```

Optional global install:

```bash
npm link
# then run: forge <command>
```

Initialize Forge in your project folder:

```bash
./forge init --server http://localhost:8787 --state main --mode inplace
```

Start the server:

```bash
node packages/server/src/index.mjs
```

Submit an operation:

```bash
./forge submit --file examples/op-upsert-file.json
```

Submit a multi-file change set from local sandbox edits (Graphite-style):

```bash
./forge submit --message "Harden auth flow"
```

`forge submit` keeps changes on the current state.  
Promote only when you explicitly pass `--to <target-state>`.

Attach and render local tree:

```bash
./forge attach
```

List conflicts:

```bash
./forge conflicts --state main
```

Create an agent workspace state from `main`:

```bash
./forge create ws/agent-security/login-hardening
```

Promote workspace state back to `main`:

```bash
./forge state promote ws/agent-security/login-hardening --to main --author agent:merge-bot
```

Graphite-like stacked workflow:

```bash
./forge create ws/agent-security/login-hardening
# edit files in your workspace (inplace mode) or sandbox/tree (sandbox mode)
./forge submit --message "Login hardening stack"
# explicit promotion step:
./forge submit --stack --to main --message "Promote login hardening stack"
```

List states:

```bash
./forge states
```

Run daemon stream:

```bash
node packages/daemon/src/index.mjs attach main --sandbox ./sandbox
```

## Workspace modes

- `inplace`: renders directly in your current folder (safe sync mode).
- `sandbox`: renders into `<sandbox>/tree` and cache in `<sandbox>/forge.db`.

Set mode during init:

```bash
./forge init --server http://localhost:8787 --mode sandbox --sandbox ./sandbox
```

## Language adapters (MVP)

`forge submit` now routes files through extension adapters:

- `.py` -> `python` adapter: top-level `def`/`class` symbol ops (`python_replace_symbol`, `python_insert_symbol`, `python_delete_symbol`)
- `.json` -> `json` adapter: top-level key ops (`json_set_key`, `json_delete_key`)
- `.txt` -> `text` adapter: document-level op
- `.md`/`.markdown` -> `markdown` adapter: document-level op

Coverage note:

- All file edits are supported.
- "Top-level" here means current semantic conflict granularity, not capability limits.
- Python changes that cannot be represented safely at symbol granularity still submit via document-level fallback.
- JSON nested changes are represented at the owning top-level key in the current MVP.
- Python symbol extraction uses the Python stdlib `ast` parser via a local sidecar call.
- If `libcst` is installed, Python parsing can use `libcst` (format-aware) and otherwise falls back.
- Override Python binary with `FORGE_PYTHON_BIN=/path/to/python3` when needed.
- Control parser mode with `FORGE_PYTHON_PARSER=auto|libcst|ast` (default: `auto`).
- In `libcst` mode, if `libcst` is unavailable, Forge falls back to regex parsing for continuity.
- Set `FORGE_PYTHON_PARSER_STRICT=1` to fail closed if the selected parser backend is unavailable.

Install `libcst` for best Python adapter fidelity:

```bash
python3 -m pip install libcst
```

Fallback behavior:

- If a semantic adapter cannot safely derive symbol edits, Forge falls back to a document-level `upsert_file` op.
- Add/delete file changes always use document-level ops.
- Python verification guard rejects ops/promotions that produce duplicate top-level `def`/`class` symbols.

## Example payloads

- `examples/op-upsert-file.json`
- `examples/op-conflicting-upsert.json`
- `examples/op-resolve-conflict.json`

## Storage backend

Server defaults to RocksDB persistence:

- `FORGE_STORE_BACKEND=rocks` (default)
- `FORGE_ROCKS_PATH=./data/rocksdb` (default path)

Fallback backend:

- `FORGE_STORE_BACKEND=json`
- `FORGE_DATA_FILE=./data/server.json`

## Server logging

Server logs are JSON lines.

- `FORGE_LOG_LEVEL=debug|info|warn|error|silent` (default: `info`)
- `FORGE_LOG_STATE_UPDATES=1` to include `state_update` event logs

Example:

```bash
FORGE_LOG_LEVEL=debug FORGE_LOG_STATE_UPDATES=1 node packages/server/src/index.mjs
```
