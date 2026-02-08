#!/usr/bin/env bash
set -e

if [ "${1:-}" = "" ]; then
  echo "usage: bash examples/demo-log-show.sh /path/to/workspace [server-url]"
  exit 1
fi

WORKSPACE="$1"
SERVER="${2:-http://localhost:8787}"
TAG="${FORGE_DEMO_TAG:-rfc3demo}"
ALICE_STATE="demo/alice-${TAG}"
BOB_STATE="demo/bob-${TAG}"

pause() {
  echo
  echo "$1"
  read -r -p "Press Enter when done..."
}

echo "workspace=$WORKSPACE"
echo "server=$SERVER"
echo "alice_state=$ALICE_STATE"
echo "bob_state=$BOB_STATE"
echo

cd "$WORKSPACE"

echo "== attach main =="
forge attach main --server "$SERVER"
forge status --server "$SERVER"

pause "Edit demo.py in another window to create/seed baseline:
def calc(a, b):
    return a + b"

forge status --server "$SERVER"
forge submit --server "$SERVER" --message "seed demo baseline"

echo "== create alice state =="
forge create "$ALICE_STATE" --from main --server "$SERVER"
pause "Edit demo.py on $ALICE_STATE:
def calc(a, b):
    return a + b + 1"
forge status --server "$SERVER"
forge submit --server "$SERVER" --message "alice local change"

echo "== create bob state =="
forge create "$BOB_STATE" --from main --server "$SERVER"
pause "Edit demo.py on $BOB_STATE:
def calc(a, b):
    return a - b"
forge status --server "$SERVER"
forge submit --server "$SERVER" --message "bob local change"

echo "== show timeline =="
forge log --all --limit 12 --server "$SERVER"
echo
echo "Find a change set id from above (cs_...) and inspect with:"
echo "forge show <cs_id> --server $SERVER"

echo "== promote alice then bob =="
forge state promote "$ALICE_STATE" --to main --author human:demo --server "$SERVER"
forge state promote "$BOB_STATE" --to main --author human:demo --server "$SERVER" || true

echo "== inspect conflicts and main =="
forge conflicts --state main --server "$SERVER" || true
forge attach main --server "$SERVER"
cat demo.py

echo
echo "Demo complete."
