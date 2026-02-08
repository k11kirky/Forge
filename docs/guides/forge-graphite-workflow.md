# Forge Stacked Workflow

- Date: 2026-02-07
- Goal: make Forge feel like stacked branch submission with `forge create`, `forge submit`, and `forge stack`.

## 1. Core idea

Forge maps Graphite branch stacks to state stacks:

- Graphite branch -> Forge state
- Graphite stacked branches -> Forge `base_state` chain
- `forge submit` -> change-set submit on current state
- `forge submit --to <target>` -> change-set submit + promotion(s)

The local workflow uses your attached sandbox:

1. Attach a state into `sandbox/tree`.
2. Edit files.
3. Run `forge submit`.
4. Forge computes changed files and submits one atomic change set.
5. Optionally promote current state (or stack) with `--to`.

## 2. Commands

Initialize workspace:

```bash
./forge init --server http://localhost:8787 --state main --mode inplace
./forge attach
```

Create a new stacked state from current state (or `main`):

```bash
./forge create ws/alice/login-hardening
```

Show stack lineage from root to current state:

```bash
./forge stack
```

Submit current local edits as one change set (no promotion):

```bash
./forge submit --message "Login hardening"
```

Submit current local edits and promote current state:

```bash
./forge submit --to main --message "Login hardening"
```

Submit and promote whole stack to `main` in root-to-leaf order:

```bash
./forge submit --stack --to main --message "Auth stack"
```

## 3. What `forge submit` does under the hood

`forge submit` reads:

- baseline tree from local cache (`.forge/forge.db` in `inplace` mode, `<sandbox>/forge.db` in `sandbox` mode)
- current working tree (current folder in `inplace` mode, `<sandbox>/tree` in `sandbox` mode)

Then it:

1. Computes changed files.
2. Builds one atomic `change_set` with one op per changed file.
3. Sends `POST /v1/change-sets`.
4. Re-attaches current state to refresh baseline.
5. If `--to` is set, promotes state(s) via `POST /v1/states/{state}/promote`.

## 4. Multi-file edits

If you edit several files before submit, Forge groups them into one change set.  
Either all ops are accepted, or conflicts/rejections stop the whole set.

This prevents partial submissions that leave stack states inconsistent.

## 5. Session behavior

`forge attach` and `forge create` write local session context to:

- `.forge/session.json`

That session defines:

- active state
- server URL
- sandbox path

`forge create`, `forge submit`, and `forge stack` use this session automatically.
