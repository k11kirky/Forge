# Forge For Git Users

- Date: 2026-02-07
- Audience: teams moving from Git/GitHub workflows to Forge state workflows

## 1. Mental Model

Forge is not branch pointers over file snapshots. Forge is semantic operations over a state graph.

You can still map most concepts directly:

| Git / GitHub | Forge |
| --- | --- |
| Repository | Project in one Forge server/store |
| Branch | `state` |
| Commit | `op` (semantic operation) |
| Merge conflict in PR | Durable `conflict` object |
| Merge commit | `resolution` operation + state promotion |
| Rebase | Not required as a user workflow; server applies causal ordering and conflict objects |
| Pull latest | `attach` + stream updates |
| Working tree | `/sandbox/tree` materialized from state |
| `.git` metadata | `forge.db` local cache + server graph |

## 2. Branches vs States

In Forge, use states the way you used branches:

- protected shared states: `main`, `prod`
- short-lived agent states: `ws/<agent>/<task>`

Initialize Forge in any folder (similar to `git init`):

```bash
./forge init --server http://localhost:8787 --state main --mode inplace
./forge attach
```

Create workspace state from `main`:

```bash
./forge state create ws/agent-security/login-hardening --from main
```

Attach workspace:

```bash
./forge attach ws/agent-security/login-hardening --sandbox ./sandbox
```

Submit operations to that workspace state only.

Promote workspace back to `main`:

```bash
./forge state promote ws/agent-security/login-hardening --to main --author agent:merge-bot
```

## 3. Multi-Agent Workflow

Example with 3 agents:

1. Agent A creates `ws/agent-a/auth-hardening` from `main`.
2. Agent B creates `ws/agent-b/oauth-refactor` from `main`.
3. Agent C creates `ws/agent-c/rate-limit` from `main`.
4. Each agent submits ops independently to its own state.
5. Promotions happen one workspace at a time into `main`.
6. If an op cannot commute with current `main`, Forge creates a conflict object.
7. Resolver agent/human submits a resolution op, then promotion continues.

This replaces long-lived branch drift with short-lived state promotions and explicit conflict objects.

## 4. What Changes for Humans

Old Git behavior:

- conflicts appear at merge time as text hunks
- conflict information is partially lost after merge

Forge behavior:

- conflicts are first-class records with type and reason
- conflict history remains queryable
- resolution is part of normal operation history

## 5. What Changes for AI Agents

Agents no longer need:

- ad-hoc textual patch merges
- continuous rebases against moving branches

Agents should:

- operate in isolated workspace states
- submit semantic ops with clear `writes` targets (`python` symbol-level, `json` key-level in current MVP)
- rely on conflict API + resolution ops when non-commutative updates occur

## 6. Command Cheat Sheet

List states:

```bash
./forge states
```

Create workspace state:

```bash
./forge create ws/<agent>/<task> --from main
```

Submit op:

```bash
./forge submit --file examples/op-upsert-file.json
```

List conflicts:

```bash
./forge conflicts --state main
```

Resolve conflict:

```bash
./forge conflict resolve conf_1 --file examples/op-resolve-conflict.json
```

Promote workspace:

```bash
./forge state promote ws/<agent>/<task> --to main --author agent:merge-bot
```

Create + stacked submit:

```bash
./forge create ws/<agent>/<task>
# edit files in workspace (inplace mode) or sandbox/tree (sandbox mode)
./forge submit --message "State-local submission"
# optional explicit promotion:
./forge submit --stack --to main --message "Stacked submission"
```

Show local stack from current attached state:

```bash
./forge stack
```

## 7. Migration Pattern From Existing VCS

Use a three-stage migration:

1. Keep Git as external artifact/log while Forge manages semantic ops internally.
2. Move CI and conflict handling to Forge state promotion paths.
3. Keep Git export for downstream tooling that still expects commits/branches.

This avoids forcing teams to switch all tooling at once.
