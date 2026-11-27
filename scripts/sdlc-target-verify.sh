#!/usr/bin/env bash
# Verifies, without changing anything, that a registered target repository is ready for intake.
# See docs/target-setup.md.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source-path=SCRIPTDIR source=lib/sdlc-target.sh
. "$ROOT/scripts/lib/sdlc-target.sh"

usage() {
  cat <<'EOF'
Usage: scripts/sdlc-target-verify.sh --target OWNER/REPO [options]

Checks a registered target repository against this control plane using only read requests.

Options:
  --target OWNER/REPO   target repository (required)
  --control OWNER/REPO  control repository (default: the origin remote of this checkout)
  --registry FILE       target registry (default: .github/sdlc/targets.json in this checkout)
  --skip-apps           skip the App installation checks, for tokens that cannot list installations
  -h, --help            show this help

Exit status: 0 when ready, 1 when a check failed, 2 on a usage error.
EOF
}

while [ $# -gt 0 ]; do
  case $1 in
    -h | --help) usage; exit 0 ;;
    --skip-apps) SKIP_APPS=1 ;;
    --target | --control | --registry)
      [ $# -ge 2 ] || die "$1 needs a value"
      parse_common "$1" "$2"
      shift ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

require_tools gh
validate_common "$ROOT"
SDLC_MODE=verify
load_control "$CONTROL_ARG"
load_target "$TARGET_ARG"
registry_lookup
print_header
[ -n "$ENTRY" ] || abort "$TARGET is not in $REGISTRY; run scripts/sdlc-target-setup.sh first"
REF=$(jq -r .intake.receiptRef <<<"$ENTRY")
say "Receipt pin    $REF"
run_checks "$REF"
section 'Registry'
ok "$(describe_entry)"
check_published_entry
[ "$(jq -r .enabled <<<"$ENTRY")" = true ] ||
  note "Intake stays off until scripts/sdlc-target-setup.sh --target $TARGET --enable --apply is merged."
summary
[ "$FAILS" -eq 0 ] || exit 1
say "$TARGET is ready for intake from $CONTROL."
