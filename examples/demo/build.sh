#!/usr/bin/env bash
# Regenerate the public demo dashboard (yaylayer.com/demo/dashboard.html).
#
# Builds a small "coinwatch" project with a deliberate spread of Cell states
# (green / yellow / red / unsigned / pink), two signers, a verifier attestation,
# and an Autopilot grant with one delegated + one rejected Cell — then runs the
# current `yay map` so the demo always reflects the live dashboard design.
#
# Usage:  bash examples/demo/build.sh [output.html]
#   default output: examples/demo/dashboard.html
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
YAY="$HERE/../../bin/yay.js"
OUT="${1:-$HERE/dashboard.html}"
WORK="$(mktemp -d)/coinwatch"
export YAY_PASSPHRASE="demo-pass-123"

mkdir -p "$WORK"; cd "$WORK"; git init -q
node "$HERE/write-src.js" "$WORK" >/dev/null

node "$YAY" init --key local --name "Alex Rivera" --no-adopt --no-plan >/dev/null

# Human-signed Briefs → Green (C-1), signed-but-unproven / Yellow (C-2, C-4, C-8), Red (C-3).
node "$YAY" sign --cell C-1 --title "Portfolio math"   --brief "Add coins to a running total, floored at zero." >/dev/null
node "$YAY" sign --cell C-2 --title "Money formatting"  --brief "Show amounts as USD price strings." >/dev/null
node "$YAY" sign --cell C-3 --title "Live price sync"   --brief "Fetch latest prices for a set of symbols." >/dev/null
node "$YAY" sign --cell C-4 --title "Access control"    --tags security --brief "Gate portfolio viewing by session." >/dev/null

# A Go Cell (signed-only tier) → a clean Yellow.
mkdir -p "$WORK/svc"
printf '//\xe2\x88\xb7YAY\xe2\x9f\xa8C-8\xe2\x9f\xa9\n// unit: NotifyDrop\n// intent: Alert the user when a coin falls more than the given percent.\n// in: symbol string, pct float64\n// out: error\n// pure: no\n//\xe2\x88\xb7YAY-END\xe2\x9f\xa8C-8\xe2\x9f\xa9\nfunc NotifyDrop(symbol string, pct float64) error {\n\treturn send(symbol, pct)\n}\n' > "$WORK/svc/notify.go"
node "$YAY" sign --cell C-8 --title "Drop alerts" --brief "Notify when a coin drops past a threshold." >/dev/null

# Verifier attestation over the current verdict (demo spread blocks the gate, so --force).
node "$YAY" attest --force >/dev/null

# A second signer, so the Signers view is populated.
node "$YAY" keygen --name "Sara Okoro" >/dev/null

# Autopilot: a grant + one delegated (awaiting) + one rejected Cell → governance views.
node "$YAY" grant --for 2h --count 5 --allow "src/**" --max-risk medium >/dev/null
node "$HERE/write-delegated.js" "$WORK" >/dev/null
node "$YAY" sign --cell C-6 --title "Sparkline points" --brief "Scale a price series into sparkline coordinates." >/dev/null
node "$YAY" sign --cell C-7 --title "Trend badge"      --brief "Label a percent change up/down/flat." >/dev/null
node "$YAY" ratify --reject --cell C-7 --reason "Prefer arrows over words; redo with icon set." --category ui >/dev/null

node "$YAY" map -o "$OUT" >/dev/null
echo "✓ demo dashboard → $OUT"
echo "  copy to yaylayer-site/public/demo/dashboard.html to publish."
