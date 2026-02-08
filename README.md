# Forge

```text
 ______
|  ____|
| |__ ___  _ __ __ _  ___
|  __/ _ \| '__/ _` |/ _ \
| | | (_) | | | (_| |  __/
|_|  \___/|_|  \__, |\___|
                 __/ |
                |___/
```

Agent-first semantic version control.

Forge is a protocol + storage system for concurrent AI and human software development.  
Instead of line-diff merges as the source of truth, Forge stores semantic operations in named states and represents conflicts as durable objects.

## Problem and approach

Git works well for human branch workflows, but high-concurrency agent workflows create friction:

- frequent branch drift and rebasing
- conflict handling that is mostly textual and late in the process
- hard-to-automate merge decisions for many small parallel edits

Forge addresses this by:

- storing semantic ops, not just text snapshots
- making conflicts first-class records with type, target, and reason
- promoting state-to-state explicitly (`create`, `submit`, `promote`)

## Architecture

Forge has three runtime components:

- `Forge Server`  
  Persists ops/states/conflicts, enforces policy, exposes API.
- `Forge Daemon`  
  Materializes server state into local files and keeps cache/tree in sync.
- `Forge CLI`  
  User workflow: `init`, `attach`, `status`, `create`, `submit`, `log`, `show`, `promote`.

Source locations:

- Server: `packages/server/src/index.mjs`
- Daemon: `packages/daemon/src/index.mjs`
- CLI: `packages/cli/src/index.mjs`
- Model/validation: `packages/model/src/index.mjs`

## Quick start

Install dependencies:

```bash
npm install
```

Use local CLI:

```bash
./forge <command>
```

Optional global command:

```bash
npm link
forge <command>
```

Start server:

```bash
node packages/server/src/index.mjs
```

Initialize any project folder as a Forge workspace:

```bash
forge init --server http://localhost:8787 --state main --mode inplace
forge attach
```

Now edit files locally, then:

```bash
forge status
forge submit --message "your change"
```

`forge submit` writes to the current state only.  
Promotion to another state is explicit:

```bash
forge state promote <source-state> --to <target-state> --author human:local
```

## Core commands

```bash
forge init --server http://localhost:8787 --state main --mode inplace|sandbox [--sandbox ./sandbox]
forge attach [state]
forge status
forge create <state> [--from <state>]
forge submit [--message "..."] [--author human:local] [--to <target>] [--stack]
forge states
forge stack
forge log [--state <state>] [--limit 20] [--all]
forge show <cs_id|op_id|conf_id> [--json]
forge conflicts [--state <state>]
forge conflict show <conf_id>
forge conflict resolve <conf_id> --file <op.json>
forge state promote <source> --to <target> [--author human:local]
```

## Typical workflow

```bash
forge attach main
forge create ws/alice/feature-x --from main

# edit files
forge status
forge submit --message "alice local change"

forge state promote ws/alice/feature-x --to main --author human:local
forge conflicts --state main
forge log --all --limit 10
```

## Workspace modes

- `inplace`  
  Uses your current directory as the materialized tree. Useful when using existing editors/tooling directly.
- `sandbox`  
  Materializes into `<sandbox>/tree` and stores local cache at `<sandbox>/forge.db`.

Example:

```bash
forge init --server http://localhost:8787 --mode sandbox --sandbox ./sandbox
forge attach main
```

## Why Forge for agentic workflows

- high parallelism with explicit state promotion
- machine-readable operation history for automated reasoning
- durable conflict objects suitable for policy-driven or agent-driven resolution
- clearer submit/promote lifecycle than ad-hoc branch juggling

## Forge vs Git

| Area | Git | Forge |
|---|---|---|
| Source of truth | commits/snapshots + line diffs | semantic ops + states |
| Parallel work model | branches + merge/rebase | named states + promotion |
| Conflict model | transient merge failures | durable conflict objects |
| Automation fit | strong ecosystem, text-centric | operation-centric, agent-friendly |
| Interop maturity | very high | early-stage MVP |

Pragmatically: Git remains the ecosystem standard. Forge is optimized for concurrent agent collaboration workflows.

## Language adapter support (current MVP)

`forge submit` routes files by extension:

- `.py` -> Python semantic adapter (`def`/`class` symbols) with safe fallback
- `.json` -> top-level key semantic adapter
- `.txt` -> document-level ops
- `.md` / `.markdown` -> document-level ops
- all other files -> document-level ops

Notes:

- all file edits are supported
- semantic granularity is currently top-level for Python/JSON
- unsafe/unavailable semantic paths fall back to document-level ops
- Python verification rejects malformed/duplicate top-level symbol outcomes

Python parser controls:

- `FORGE_PYTHON_BIN=/path/to/python3`
- `FORGE_PYTHON_PARSER=auto|libcst|ast` (default: `auto`)
- `FORGE_PYTHON_PARSER_STRICT=1` to fail closed if selected parser backend is unavailable

Install optional `libcst`:

```bash
python3 -m pip install libcst
```

## Storage and runtime configuration

Storage backend:

- `FORGE_STORE_BACKEND=rocks` (default)
- `FORGE_ROCKS_PATH=./data/rocksdb`
- `FORGE_STORE_BACKEND=json` (fallback)
- `FORGE_DATA_FILE=./data/server.json`

Server logging:

- `FORGE_LOG_LEVEL=debug|info|warn|error|silent` (default: `info`)
- `FORGE_LOG_STATE_UPDATES=1` to include state update logs

Example:

```bash
FORGE_LOG_LEVEL=debug FORGE_LOG_STATE_UPDATES=1 node packages/server/src/index.mjs
```

## Limitations (current MVP)

- single-node server design
- no auth/multi-tenant security model yet
- conflict resolution UX is still basic
- adapter depth is intentionally narrow for early stability

## Docs

- RFC: `docs/rfcs/0001-forge-agent-first-semantic-version-control.md`
- Build plan: `docs/implementation/forge-mvp-build-plan.md`
- Git mental model: `docs/guides/forge-for-git-users.md`
- Graphite-style workflow: `docs/guides/forge-graphite-workflow.md`
- 1-minute demo script: `docs/guides/one-minute-demo-script.md`
- Example payloads: `examples/op-upsert-file.json`, `examples/op-conflicting-upsert.json`, `examples/op-resolve-conflict.json`
