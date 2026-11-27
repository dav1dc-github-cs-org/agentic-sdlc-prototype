#!/usr/bin/env bash
# Prepares a target repository for agentic SDLC intake from this control plane. See docs/target-setup.md.
# jq filters passed to write_registry use jq variables, which the shell must not expand.
# shellcheck disable=SC2016
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source-path=SCRIPTDIR source=lib/sdlc-target.sh
. "$ROOT/scripts/lib/sdlc-target.sh"

usage() {
  cat <<'EOF'
Usage: scripts/sdlc-target-setup.sh --target OWNER/REPO [options]

Checks a target repository against this control plane and prepares it for intake. Without --apply the
script only reads from GitHub and lists the changes it would make.

Options:
  --target OWNER/REPO   target repository (required)
  --control OWNER/REPO  control repository (default: the origin remote of this checkout)
  --registry FILE       target registry (default: .github/sdlc/targets.json in this checkout)
  --receipt-ref SHA     pin the receipt workflow to a commit on the control default branch; "default"
                        pins its current head (default: the registered pin, or the head for a new target)
  --enable              enable a registered target after verifying it end to end
  --disable             disable a registered target in the local registry, without calling GitHub
  --skip-apps           skip the App installation checks, for tokens that cannot list installations
  --apply               make the changes
  -h, --help            show this help

Changes made with --apply: the Actions access level of a private or internal control repository, the
target's App installation selection, the intake label, a branch and pull request in the target with the
rendered intake caller, and the local registry file. Registry edits take effect only when merged into the
control repository's default branch.

Exit status: 0 when ready, 1 when a check failed, 2 on a usage error.
EOF
}

APPLY=0
ENABLE=0
DISABLE=0
REF_ARG=''
while [ $# -gt 0 ]; do
  case $1 in
    -h | --help) usage; exit 0 ;;
    --apply) APPLY=1 ;;
    --enable) ENABLE=1 ;;
    --disable) DISABLE=1 ;;
    --skip-apps) SKIP_APPS=1 ;;
    --receipt-ref)
      [ $# -ge 2 ] || die "$1 needs a value"
      REF_ARG=$2
      shift ;;
    --target | --control | --registry)
      [ $# -ge 2 ] || die "$1 needs a value"
      parse_common "$1" "$2"
      shift ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

[ $((ENABLE + DISABLE)) -le 1 ] || die '--enable and --disable are exclusive'
if [ -n "$REF_ARG" ]; then
  [ $((ENABLE + DISABLE)) -eq 0 ] || die '--receipt-ref cannot be combined with --enable or --disable'
  [ "$REF_ARG" = default ] || [[ $REF_ARG =~ $SHA_PATTERN ]] || die '--receipt-ref must be a full lowercase commit SHA or "default"'
fi
CHANGE_MODE=plan
[ "$APPLY" = 1 ] && CHANGE_MODE=apply

if [ "$DISABLE" = 1 ]; then
  require_tools local
  validate_common "$ROOT" local
  SDLC_MODE=$CHANGE_MODE
  assert_registry
  name=$(lower "$TARGET_ARG")
  ENTRY=$(jq -c --arg name "$name" '[.targets[] | select((.repository | ascii_downcase) == $name)] | first // empty' "$REGISTRY")
  section "Registry $REGISTRY"
  [ -n "$ENTRY" ] || abort "$TARGET_ARG is not registered"
  if [ "$(jq -r .enabled <<<"$ENTRY")" = false ]; then
    ok "$(describe_entry)"
  elif needs_change "Disable $(jq -r .repository <<<"$ENTRY")"; then
    write_registry '(.targets[] | select((.repository | ascii_downcase) == $name) | .enabled) = false' --arg name "$name"
  fi
  summary
  if [ "$CHANGES" -gt 0 ] && [ "$APPLY" = 0 ]; then say 'Re-run with --apply to make this change.'; fi
  [ "$CHANGES" -gt 0 ] && say "Merge the registry change into $REGISTRY_FILE on the control default branch; intake stops when it merges."
  exit 0
fi

require_tools gh
validate_common "$ROOT"
load_control "$CONTROL_ARG"
load_target "$TARGET_ARG"
registry_lookup
print_header

if [ "$REF_ARG" = default ]; then
  REF=$CONTROL_HEAD
elif [ -n "$REF_ARG" ]; then
  REF=$REF_ARG
elif [ -n "$ENTRY" ]; then
  REF=$(jq -r .intake.receiptRef <<<"$ENTRY")
else
  REF=$CONTROL_HEAD
fi

if [ "$ENABLE" = 1 ]; then
  say 'Mode           verify, then enable'
  [ -n "$ENTRY" ] || abort "$TARGET is not in $REGISTRY; run this script without --enable first and merge the registry change"
  SDLC_MODE=verify
  run_checks "$REF"
  section 'Registry'
  check_published_entry
  if [ "$FAILS" -gt 0 ]; then
    summary
    say "Not enabling $TARGET until every check passes."
    exit 1
  fi
  SDLC_MODE=$CHANGE_MODE
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [ "$(jq -r .enabled <<<"$ENTRY")" = true ]; then
    ok "$(describe_entry)"
  elif needs_change "Enable $TARGET with activatedAt $now; labels applied before then are never accepted"; then
    write_registry '(.targets[] | select(.id == $id)) |= (.enabled = true | .activatedAt = $now)' --argjson id "$TARGET_ID" --arg now "$now"
  fi
  summary
  if [ "$CHANGES" -gt 0 ]; then
    [ "$APPLY" = 1 ] || say 'Re-run with --apply to make this change.'
    say "Merge the registry change into $REGISTRY_FILE on $CONTROL_BRANCH of $CONTROL; intake starts when it merges."
  fi
  exit 0
fi

check_registry() {
  local now count current
  section "Registry $REGISTRY"
  if [ "$SDLC_MODE" = apply ] && [ "$FAILS" -gt 0 ]; then
    note 'Left unchanged because an earlier step failed'
    return
  fi
  if [ -z "$ENTRY" ]; then
    count=$(jq '.targets | length' "$REGISTRY")
    if [ "$count" -ge 100 ]; then
      fail 'The registry already holds the maximum of 100 targets'
      return
    fi
    if needs_change "Register $TARGET (ID $TARGET_ID) as disabled, with the receipt pinned to $REF"; then
      now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      write_registry '.targets += [{id: $id, repository: $repository, enabled: false, activatedAt: $now,
        intake: {workflow: $workflow, receiptRef: $ref}}]' \
        --argjson id "$TARGET_ID" --arg repository "$TARGET" --arg now "$now" --arg workflow "$INTAKE_WORKFLOW" --arg ref "$REF"
    fi
    return
  fi
  current=$(jq -r .intake.receiptRef <<<"$ENTRY")
  if [ "$current" = "$REF" ]; then
    ok "$(describe_entry)"
    check_published_entry
    return
  fi
  if needs_change "Move the receipt pin of $TARGET from $current to $REF"; then
    write_registry '(.targets[] | select(.id == $id) | .intake.receiptRef) = $ref' --argjson id "$TARGET_ID" --arg ref "$REF"
  fi
  [ "$(jq -r .enabled <<<"$ENTRY")" = true ] &&
    note "Merge the registry change and the caller pull request close together: intake from $TARGET stops while their pins differ."
  return 0
}

run_pass() { # MODE
  SDLC_MODE=$1
  FAILS=0
  WARNS=0
  CHANGES=0
  run_checks "$REF"
  check_registry
}

next_steps() {
  section 'Next steps'
  say "  1. Review and merge the intake caller pull request in $TARGET${CALLER_PR:+ ($CALLER_PR)} without editing the file."
  say "  2. Commit $REGISTRY_FILE in a pull request to $CONTROL and merge it after review."
  say "  3. Run scripts/sdlc-target-verify.sh --target $TARGET once both have merged."
  say "  4. Enable intake with scripts/sdlc-target-setup.sh --target $TARGET --enable --apply, and merge that registry change."
  say "  See docs/target-setup.md for the pilot checklist."
}

say "Mode           $([ "$APPLY" = 1 ] && echo 'plan, then apply' || echo 'dry run')"
say "Receipt pin    $REF"
run_pass plan
summary
if [ "$FAILS" -gt 0 ]; then
  [ "$APPLY" = 1 ] && say 'No changes made. Resolve the failures and run the script again.'
  exit 1
fi
if [ "$APPLY" = 0 ]; then
  if [ "$CHANGES" -gt 0 ]; then say 'Re-run with --apply to make these changes.'; else say 'Nothing to change.'; fi
  [ "$CHANGES" -eq 0 ] || next_steps
  exit 0
fi
if [ "$CHANGES" -eq 0 ]; then
  say 'Nothing to change.'
  exit 0
fi
section '=== Applying the plan ==='
run_pass apply
summary
[ "$FAILS" -eq 0 ] || exit 1
next_steps
