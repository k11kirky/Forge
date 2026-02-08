# Forge 60-Second Demo Script

This is a literal talk track for a 1-minute screen share.

## Prep (before the call)

1. Start server in one terminal:

```bash
cd ~/Dev/Forge
FORGE_LOG_LEVEL=info FORGE_PYTHON_PARSER=auto node packages/server/src/index.mjs
```

2. Open a second terminal for the demo:

```bash
cd ~/Dev/demo-ast
forge attach main
```

3. Pick unique state names for this run:

```bash
TAG=$(date +%H%M%S)
ALICE="demo/alice-$TAG"
BOB="demo/bob-$TAG"
```

## 60-Second Live Script

### 0:00-0:12

Say:

> “Problem: Git was built for a small number of humans. With many AI agents, you get branch drift, constant rebasing, and merge errors that are hard to automate.”
>
> “Solution: I built Forge, an agent-first version control system: server + daemon + CLI, storing semantic operations in states with durable conflict objects instead of line-diff branch merges.”

Run:

```bash
forge status
```

### 0:12-0:24

Say:

> “I’ll create two parallel states from main, like two agents working concurrently.”

Run:

```bash
forge create "$ALICE" --from main
```

Edit `demo.py` in editor (other window):

```python
def calc(a, b):
    return a + b + 1
```

Run:

```bash
forge status
forge submit --message "alice local change"
```

### 0:24-0:38

Run:

```bash
forge create "$BOB" --from main
```

Edit `demo.py`:

```python
def calc(a, b):
    return a - b
```

Run:

```bash
forge status
forge submit --message "bob local change"
```

Say:

> “Both changes are stored independently as semantic ops, without rebase/cherry-pick workflows.”

### 0:38-0:52

Run:

```bash
forge log --all --limit 8
```

Say:

> “`forge log` shows the change-set timeline across states.”

Pick one `cs_...` from output, then run:

```bash
forge show <cs_id>
```

Say:

> “`forge show` gives operation-level details: symbols, effect kind, and acceptance status.”

### 0:52-1:00

Run:

```bash
forge state promote "$ALICE" --to main --author human:demo
forge state promote "$BOB" --to main --author human:demo || true
forge conflicts --state main
```

Say:

> “Promotion is explicit, and conflicting work becomes a durable conflict object with reason and target, instead of a transient merge error.”

## 15-Second Close (Why This Is Cool)

Say:

> “Why this matters for agentic workflows: many agents can work in parallel, every change is machine-readable, and conflicts are first-class records that can be resolved by policy or another agent.”
>
> “So the system optimizes for continuous AI collaboration, not just human branch hygiene.”

## Optional Visual Close

Run:

```bash
forge attach "$ALICE" && cat demo.py
forge attach "$BOB" && cat demo.py
forge attach main && cat demo.py
```

Say:

> “I can still attach any state and inspect exactly what each agent changed.”
