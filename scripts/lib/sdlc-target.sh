# shellcheck shell=bash
# Shared checks for registering a target repository with this SDLC control plane.
# Sourced by scripts/sdlc-target-setup.sh and scripts/sdlc-target-verify.sh. Requires gh, jq, and bash 3.2 or newer.
#
# SDLC_MODE selects what a needed change does: verify reports it as a failure, plan lists it, and apply makes it.
# Only apply mode sends anything other than GET requests.

SDLC_MODE=verify
FAILS=0
WARNS=0
CHANGES=0
API_ERROR=''
SKIP_APPS=0
CALLER_PR=''
INSTALLATIONS=''
INSTALLATIONS_ERROR=''
VALUE=''

INTAKE_WORKFLOW='.github/workflows/sdlc-intake.yml'
RECEIPT_WORKFLOW='.github/workflows/sdlc-intake-receipt.yml'
INTAKE_TEMPLATE='.github/sdlc/templates/sdlc-intake.yml'
POLICY_FILE='.github/sdlc/policy.json'
REGISTRY_FILE='.github/sdlc/targets.json'
# Mirrors targetPermissions in src/installation.ts and the Reader token request in .github/workflows/sdlc-source.yml.
CONTROLLER_PERMISSIONS='{"actions":"read","checks":"write","contents":"write","issues":"write","pull_requests":"write"}'
READER_PERMISSIONS='{"contents":"read"}'
REPOSITORY_PATTERN='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
SHA_PATTERN='^[0-9a-f]{40}$'
# Mirrors safeLabel in src/receipts.ts: the label is interpolated into a quoted workflow expression.
LABEL_PATTERN='^[A-Za-z0-9]([A-Za-z0-9 ._:-]{0,48}[A-Za-z0-9])?$'

say() { printf '%s\n' "$*"; }
section() { say ''; say "$*"; }
ok() { say "  [ok]    $*"; }
note() { say "  [note]  $*"; }
warn() { WARNS=$((WARNS + 1)); say "  [warn]  $*"; }
fail() { FAILS=$((FAILS + 1)); say "  [FAIL]  $*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 2; }
abort() { fail "$*"; summary; exit 1; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
uri() { jq -rn --arg value "$1" '$value | @uri'; }

summary() {
  say ''
  case $SDLC_MODE in
    plan) say "Summary: $FAILS failed, $WARNS warnings, $CHANGES changes planned." ;;
    apply) say "Summary: $FAILS failed, $WARNS warnings, $CHANGES changes applied." ;;
    *) say "Summary: $FAILS failed, $WARNS warnings." ;;
  esac
}

# Records a needed change. Returns 0 only in apply mode, where the caller then makes it.
needs_change() {
  case $SDLC_MODE in
    verify) fail "$1"; return 1 ;;
    plan) CHANGES=$((CHANGES + 1)); say "  [plan]  $1"; return 1 ;;
    apply) CHANGES=$((CHANGES + 1)); say "  [apply] $1"; return 0 ;;
    *) die "unknown mode $SDLC_MODE" ;;
  esac
}

require_tools() { # gh|local: local skips the GitHub CLI for registry-only edits
  [ "$1" = local ] || command -v gh >/dev/null 2>&1 || die 'the GitHub CLI (gh) is required: https://cli.github.com'
  command -v jq >/dev/null 2>&1 || die 'jq is required: https://jqlang.org'
  SDLC_WORK=$(mktemp -d "${TMPDIR:-/tmp}/sdlc-target.XXXXXX")
  trap 'rm -rf "$SDLC_WORK"' EXIT
}

gh_api() { gh api -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' "$@"; }

# api_get PATH OUT [gh flags]: 0 on success, 4 when the resource does not exist, 1 on any other error.
api_get() {
  local path=$1 out=$2
  shift 2
  if gh_api "$@" "$path" >"$out" 2>"$SDLC_WORK/stderr"; then return 0; fi
  API_ERROR=$(tr '\n' ' ' <"$SDLC_WORK/stderr")
  case $API_ERROR in *'(HTTP 404)'*) return 4 ;; esac
  return 1
}

# api_send METHOD PATH [JSON]: the response body is left in $SDLC_WORK/response.
api_send() {
  local method=$1 path=$2 body=${3-}
  [ "$SDLC_MODE" = apply ] || die "internal error: $method $path requested outside apply mode"
  if [ -n "$body" ]; then
    if printf '%s' "$body" | gh_api -X "$method" "$path" --input - >"$SDLC_WORK/response" 2>"$SDLC_WORK/stderr"; then return 0; fi
  elif gh_api -X "$method" "$path" >"$SDLC_WORK/response" 2>"$SDLC_WORK/stderr"; then
    return 0
  fi
  API_ERROR=$(tr '\n' ' ' <"$SDLC_WORK/stderr")
  return 1
}

decode_content() { jq -j '.content | gsub("\n"; "") | @base64d' "$1"; }

# The controller renders the caller from its default-branch checkout, so the template and label come from that head.
load_control() {
  local rc=0 file=$SDLC_WORK/control.json
  api_get "repos/$1" "$file" || rc=$?
  [ "$rc" -eq 0 ] || abort "Cannot read control repository $1: $API_ERROR"
  CONTROL=$(jq -r .full_name "$file")
  CONTROL_ID=$(jq -r .id "$file")
  CONTROL_VISIBILITY=$(jq -r '.visibility // "unknown"' "$file")
  CONTROL_BRANCH=$(jq -r .default_branch "$file")
  CONTROL_OWNER=$(jq -r .owner.login "$file")
  CONTROL_OWNER_TYPE=$(jq -r .owner.type "$file")
  api_get "repos/$CONTROL/git/ref/heads/$CONTROL_BRANCH" "$SDLC_WORK/control-head.json" || abort "Cannot read $CONTROL $CONTROL_BRANCH: $API_ERROR"
  CONTROL_HEAD=$(jq -r .object.sha "$SDLC_WORK/control-head.json")
  api_get "repos/$CONTROL/contents/$POLICY_FILE?ref=$CONTROL_HEAD" "$SDLC_WORK/policy.json" || abort "Cannot read $POLICY_FILE at $CONTROL_HEAD: $API_ERROR"
  LABEL=$(decode_content "$SDLC_WORK/policy.json" | jq -r .label)
  [[ $LABEL =~ $LABEL_PATTERN ]] || abort "The policy label '$LABEL' cannot be rendered safely into a workflow"
  api_get "repos/$CONTROL/contents/$INTAKE_TEMPLATE?ref=$CONTROL_HEAD" "$SDLC_WORK/template.json" || abort "Cannot read $INTAKE_TEMPLATE at $CONTROL_HEAD: $API_ERROR"
  decode_content "$SDLC_WORK/template.json" >"$SDLC_WORK/template.yml"
}

load_target() {
  local rc=0 file=$SDLC_WORK/target.json
  api_get "repos/$1" "$file" || rc=$?
  [ "$rc" -ne 4 ] || abort "Target $1 does not exist or this account cannot read it"
  [ "$rc" -eq 0 ] || abort "Cannot read target $1: $API_ERROR"
  TARGET=$(jq -r .full_name "$file")
  TARGET_ID=$(jq -r .id "$file")
  TARGET_VISIBILITY=$(jq -r '.visibility // "unknown"' "$file")
  TARGET_BRANCH=$(jq -r .default_branch "$file")
  TARGET_OWNER=$(jq -r .owner.login "$file")
  TARGET_OWNER_TYPE=$(jq -r .owner.type "$file")
}

same_owner() { [ "$(lower "$CONTROL_OWNER")" = "$(lower "$TARGET_OWNER")" ]; }

check_identity() {
  local file=$SDLC_WORK/target.json
  section "Target $TARGET"
  if [ "$TARGET_ID" = "$CONTROL_ID" ]; then
    fail 'The control repository is the implicit self target and cannot be registered as a foreign target'
  fi
  [ "$(jq -r .archived "$file")" = false ] || fail "$TARGET is archived"
  [ "$(jq -r '.disabled // false' "$file")" = false ] || fail "$TARGET is disabled"
  [ "$(jq -r .has_issues "$file")" = true ] || fail "Issues are disabled in $TARGET; enable them under Settings > General > Features"
  [ "$(jq -r '.permissions.admin // false' "$file")" = true ] ||
    warn "This account is not an admin of $TARGET; adding App installations and some checks need admin access"
  ok "Repository ID $TARGET_ID, $TARGET_VISIBILITY, default branch $TARGET_BRANCH"
}

# The controller refuses a target less visible than the control repository, and GitHub refuses a caller
# more visible than a private or internal callee, so the two visibilities must match.
check_visibility() {
  local rc=0 required current
  section 'Visibility and workflow access'
  if [ "$TARGET_VISIBILITY" != "$CONTROL_VISIBILITY" ]; then
    case "$CONTROL_VISIBILITY>$TARGET_VISIBILITY" in
      public\>*|internal\>private)
        fail "A $CONTROL_VISIBILITY control repository refuses a $TARGET_VISIBILITY target: its state and logs would expose the target" ;;
      *) fail "A $TARGET_VISIBILITY target cannot call a reusable workflow in a $CONTROL_VISIBILITY repository" ;;
    esac
    note 'Use a control repository with the same visibility as the target.'
    return
  fi
  ok "The target and control repositories are both $TARGET_VISIBILITY"
  note "Confirm that everyone who can read $CONTROL may read $TARGET; matching visibility does not prove it."
  [ "$CONTROL_VISIBILITY" = public ] && return
  if same_owner; then
    required=organization
    [ "$CONTROL_OWNER_TYPE" = User ] && required=user
  elif [ "$CONTROL_OWNER_TYPE" = Organization ] && [ "$TARGET_OWNER_TYPE" = Organization ]; then
    required=enterprise
    note "$CONTROL_OWNER and $TARGET_OWNER must belong to the same enterprise."
  else
    fail "A $CONTROL_VISIBILITY repository owned by a user shares workflows only with that user's repositories"
    return
  fi
  api_get "repos/$CONTROL/actions/permissions/access" "$SDLC_WORK/access.json" || rc=$?
  if [ "$rc" -ne 0 ]; then fail "Cannot read the Actions access level of $CONTROL (admin required): $API_ERROR"; return; fi
  current=$(jq -r .access_level "$SDLC_WORK/access.json")
  if [ "$current" = "$required" ] || { [ "$required" = organization ] && [ "$current" = enterprise ]; }; then
    ok "$CONTROL workflows are accessible at level $current"
  elif needs_change "Set the Actions access level of $CONTROL from $current to $required"; then
    api_send PUT "repos/$CONTROL/actions/permissions/access" "{\"access_level\":\"$required\"}" ||
      fail "Could not set the access level: $API_ERROR"
  fi
}

check_target_actions() {
  local rc=0 allowed file=$SDLC_WORK/actions.json selected=$SDLC_WORK/selected-actions.json
  section "Actions policy in $TARGET"
  api_get "repos/$TARGET/actions/permissions" "$file" || rc=$?
  if [ "$rc" -ne 0 ]; then fail "Cannot read the Actions policy of $TARGET: $API_ERROR"; return; fi
  if [ "$(jq -r .enabled "$file")" != true ]; then
    fail "Actions is disabled in $TARGET; the intake caller cannot run"
    return
  fi
  allowed=$(jq -r .allowed_actions "$file")
  case $allowed in
    all) ok 'All actions and reusable workflows are allowed' ;;
    local_only) fail "$TARGET allows only $TARGET_OWNER actions; the receipt workflow uses actions/upload-artifact, which GitHub authors" ;;
    selected)
      rc=0
      api_get "repos/$TARGET/actions/permissions/selected-actions" "$selected" || rc=$?
      if [ "$rc" -ne 0 ]; then fail "Cannot read the allowed actions of $TARGET: $API_ERROR"; return; fi
      if [ "$(jq -r .github_owned_allowed "$selected")" != true ]; then
        fail "$TARGET must allow actions created by GitHub; the receipt workflow uses actions/upload-artifact"
      elif same_owner; then
        ok "GitHub-authored actions and $TARGET_OWNER workflows are allowed"
      elif jq -e --arg control "$(lower "$CONTROL")" --arg owner "$(lower "$CONTROL_OWNER")" --arg path "$RECEIPT_WORKFLOW" '
          [.patterns_allowed[]? | ascii_downcase]
          | any(. == "*" or . == "\($owner)/*" or . == "\($control)/*" or . == "\($control)/\($path)@*")' "$selected" >/dev/null; then
        ok "GitHub-authored actions and the $CONTROL receipt workflow are allowed"
      else
        warn "Allow $CONTROL/$RECEIPT_WORKFLOW@* in the allowed actions of $TARGET, or confirm an existing pattern covers it"
      fi ;;
    *) warn "Unrecognized allowed_actions value '$allowed' in $TARGET" ;;
  esac
  note 'Organization and enterprise Actions policies can restrict this further.'
}

variable_value() { # PATH: sets VALUE
  local rc=0
  VALUE=''
  api_get "$1" "$SDLC_WORK/variable.json" || rc=$?
  [ "$rc" -eq 0 ] && VALUE=$(jq -r .value "$SDLC_WORK/variable.json")
  return "$rc"
}

check_secret() { # ENVIRONMENT NAME
  local rc=0
  api_get "repos/$CONTROL/environments/$1/secrets/$2" "$SDLC_WORK/secret.json" || rc=$?
  case $rc in
    0) ok "Secret $2 is set in environment $1" ;;
    4) fail "Secret $2 is missing from environment $1 of $CONTROL" ;;
    *) fail "Cannot read secret $2 in environment $1 (admin required): $API_ERROR" ;;
  esac
}

check_control_config() {
  local rc=0
  section "Control plane $CONTROL"
  ok "Default branch $CONTROL_BRANCH at $CONTROL_HEAD; intake label '$LABEL'"
  variable_value "repos/$CONTROL/actions/variables/SDLC_APP_ID" || rc=$?
  CONTROLLER_APP_ID=$VALUE
  case $rc in
    0) ok "Controller App ID $CONTROLLER_APP_ID (repository variable SDLC_APP_ID)" ;;
    4) fail "Repository variable SDLC_APP_ID is missing from $CONTROL" ;;
    *) fail "Cannot read SDLC_APP_ID: $API_ERROR" ;;
  esac
  check_secret sdlc-controller SDLC_APP_PRIVATE_KEY
  rc=0
  variable_value "repos/$CONTROL/environments/sdlc-reader/variables/SDLC_READER_APP_ID" || rc=$?
  READER_APP_ID=$VALUE
  case $rc in
    0) ok "Reader App ID $READER_APP_ID (sdlc-reader variable SDLC_READER_APP_ID)" ;;
    4) fail "Environment sdlc-reader or its variable SDLC_READER_APP_ID is missing from $CONTROL" ;;
    *) fail "Cannot read SDLC_READER_APP_ID: $API_ERROR" ;;
  esac
  check_secret sdlc-reader SDLC_READER_PRIVATE_KEY
  if [ -n "$CONTROLLER_APP_ID" ] && ! [[ $CONTROLLER_APP_ID =~ ^[0-9]+$ ]]; then
    fail "SDLC_APP_ID '$CONTROLLER_APP_ID' is not a numeric App ID"
    CONTROLLER_APP_ID=''
  fi
  if [ -n "$READER_APP_ID" ] && ! [[ $READER_APP_ID =~ ^[0-9]+$ ]]; then
    fail "SDLC_READER_APP_ID '$READER_APP_ID' is not a numeric App ID"
    READER_APP_ID=''
  fi
  if [ -n "$CONTROLLER_APP_ID" ] && [ "$CONTROLLER_APP_ID" = "$READER_APP_ID" ]; then
    fail 'The Reader App must be a separate App from the controller App'
  fi
}

check_receipt_ref() { # REF
  local rc=0 status
  section 'Receipt pin'
  api_get "repos/$CONTROL/contents/$RECEIPT_WORKFLOW?ref=$1" "$SDLC_WORK/receipt.json" || rc=$?
  case $rc in
    0) ;;
    4) fail "$CONTROL has no $RECEIPT_WORKFLOW at $1"; return ;;
    *) fail "Cannot read $RECEIPT_WORKFLOW at $1: $API_ERROR"; return ;;
  esac
  rc=0
  api_get "repos/$CONTROL/compare/$1...$CONTROL_HEAD" "$SDLC_WORK/compare.json" || rc=$?
  if [ "$rc" -ne 0 ]; then fail "Pin $1 is not a commit on $CONTROL: $API_ERROR"; return; fi
  status=$(jq -r .status "$SDLC_WORK/compare.json")
  case $status in
    identical) ok "Pin $1 is the head of $CONTROL_BRANCH" ;;
    ahead) ok "Pin $1 is on $CONTROL_BRANCH, $(jq -r .ahead_by "$SDLC_WORK/compare.json") commits behind its head" ;;
    *) fail "Pin $1 is not on the default branch $CONTROL_BRANCH of $CONTROL (compare status $status)" ;;
  esac
}

load_installations() {
  local rc=0
  case $INSTALLATIONS in
    loaded) return 0 ;;
    unavailable) API_ERROR=$INSTALLATIONS_ERROR; return 1 ;;
  esac
  api_get user/installations "$SDLC_WORK/installations-pages.json" --paginate || rc=$?
  if [ "$rc" -ne 0 ]; then
    INSTALLATIONS=unavailable
    INSTALLATIONS_ERROR=$API_ERROR
    return 1
  fi
  jq -s '[.[].installations[]?]' "$SDLC_WORK/installations-pages.json" >"$SDLC_WORK/installations.json"
  INSTALLATIONS=loaded
}

check_app() { # NAME APP_ID PERMISSIONS EXCLUSIVE
  local name=$1 app=$2 permissions=$3 exclusive=$4 file=$SDLC_WORK/installation.json rc=0 missing extra id
  [ -n "$app" ] || return 0
  if ! load_installations; then
    warn "Cannot list App installations with this token ($API_ERROR); confirm in Settings > GitHub Apps that the $name App ($app) is installed on $TARGET"
    return
  fi
  jq --argjson app "$app" --arg owner "$(lower "$TARGET_OWNER")" \
    'map(select(.app_id == $app and (.account.login | ascii_downcase) == $owner)) | first // empty' \
    "$SDLC_WORK/installations.json" >"$file"
  if [ ! -s "$file" ]; then
    fail "The $name App ($app) is not installed on $TARGET_OWNER; install it on $TARGET under Only select repositories"
    return
  fi
  id=$(jq -r .id "$file")
  [ "$(jq -r '.suspended_at // ""' "$file")" = '' ] || fail "The $name App installation $id on $TARGET_OWNER is suspended"
  missing=$(jq -r --argjson need "$permissions" 'def rank: {"read": 1, "write": 2, "admin": 3}[.] // 0;
    .permissions as $has | [$need | to_entries[] | select((.value | rank) > ($has[.key] // "" | rank)) | "\(.key): \(.value)"] | join(", ")' "$file")
  if [ -n "$missing" ]; then
    fail "The $name App installation $id lacks $missing; update the App permissions and accept them on $TARGET_OWNER"
  else
    ok "The $name App installation $id grants the required permissions"
  fi
  if [ "$exclusive" = 1 ]; then
    extra=$(jq -r --argjson need "$permissions" '[.permissions | keys[] | select(. != "metadata" and ($need[.] == null))] | join(", ")' "$file")
    [ -z "$extra" ] || warn "The $name App also holds $extra; its key could mint more than Contents read"
  fi
  if [ "$(jq -r .repository_selection "$file")" = all ]; then
    warn "The $name App is installed on all $TARGET_OWNER repositories; prefer Only select repositories"
    return
  fi
  api_get "user/installations/$id/repositories" "$SDLC_WORK/installation-repositories.json" --paginate || rc=$?
  if [ "$rc" -ne 0 ]; then
    warn "Cannot list the repositories of installation $id ($API_ERROR); confirm $TARGET is selected"
    return
  fi
  if jq -s -e --argjson target "$TARGET_ID" 'any(.[].repositories[]?; .id == $target)' "$SDLC_WORK/installation-repositories.json" >/dev/null; then
    ok "$TARGET is selected in installation $id"
  elif needs_change "Add $TARGET to the $name App installation $id"; then
    api_send PUT "user/installations/$id/repositories/$TARGET_ID" ||
      fail "Could not add $TARGET to installation $id ($API_ERROR); add it under Settings > GitHub Apps > Configure"
  fi
}

check_apps() {
  section 'GitHub App installations'
  if [ "$SKIP_APPS" = 1 ]; then
    note 'Skipped (--skip-apps); confirm both installations manually'
    return
  fi
  same_owner || note "$TARGET_OWNER differs from $CONTROL_OWNER, so both Apps must allow installation on any account"
  check_app Controller "$CONTROLLER_APP_ID" "$CONTROLLER_PERMISSIONS" 0
  check_app Reader "$READER_APP_ID" "$READER_PERMISSIONS" 1
}

check_label() {
  local rc=0 name file=$SDLC_WORK/label.json body
  section 'Intake label'
  api_get "repos/$TARGET/labels/$(uri "$LABEL")" "$file" || rc=$?
  case $rc in
    0)
      name=$(jq -r .name "$file")
      # Receipts compare the label name exactly, though GitHub matches label names without case.
      if [ "$name" = "$LABEL" ]; then
        ok "Label '$LABEL' exists"
      elif needs_change "Rename label '$name' to '$LABEL' in $TARGET"; then
        body=$(jq -cn --arg name "$LABEL" '{new_name: $name}')
        api_send PATCH "repos/$TARGET/labels/$(uri "$name")" "$body" || fail "Could not rename the label: $API_ERROR"
      fi ;;
    4)
      if needs_change "Create label '$LABEL' in $TARGET"; then
        body=$(jq -cn --arg name "$LABEL" '{name: $name, color: "5319e7", description: "Request agentic SDLC delivery"}')
        api_send POST "repos/$TARGET/labels" "$body" || fail "Could not create the label: $API_ERROR"
      fi ;;
    *) fail "Cannot read labels of $TARGET: $API_ERROR" ;;
  esac
}

render_caller() { # REF OUT
  [[ $1 =~ $SHA_PATTERN ]] || abort "Receipt pin $1 is not a full commit SHA"
  [[ $CONTROL =~ $REPOSITORY_PATTERN ]] || abort "Control repository name $CONTROL is invalid"
  # Mirrors renderIntakeWorkflow in src/receipts.ts; the controller compares the target's file to it byte for byte.
  jq -Rsj --arg control "$CONTROL" --arg ref "$1" --arg label "$LABEL" '
    . as $template
    | if (["__CONTROL_REPOSITORY__", "__RECEIPT_REF__", "__LABEL__"] | all(. as $p | $template | contains($p)))
      then $template | gsub("__CONTROL_REPOSITORY__"; $control) | gsub("__RECEIPT_REF__"; $ref) | gsub("__LABEL__"; $label)
      else error("the intake template is missing a placeholder") end' "$SDLC_WORK/template.yml" >"$2"
}

check_caller() { # REF
  local ref=$1 rc=0 branch expected=$SDLC_WORK/caller.yml current=$SDLC_WORK/current.yml
  local base sha body message
  section "Intake caller in $TARGET"
  render_caller "$ref" "$expected"
  api_get "repos/$TARGET/contents/$INTAKE_WORKFLOW?ref=$(uri "$TARGET_BRANCH")" "$SDLC_WORK/current.json" || rc=$?
  case $rc in
    0)
      jq -j '.content | gsub("\n"; "") | @base64d | gsub("\r\n"; "\n")' "$SDLC_WORK/current.json" >"$current"
      if cmp -s "$expected" "$current"; then
        ok "$INTAKE_WORKFLOW on $TARGET_BRANCH matches the template pinned to $ref"
        return
      fi
      message="$INTAKE_WORKFLOW on $TARGET_BRANCH differs from the template pinned to $ref" ;;
    4) message="$INTAKE_WORKFLOW is not on $TARGET_BRANCH" ;;
    *) fail "Cannot read $INTAKE_WORKFLOW in $TARGET: $API_ERROR"; return ;;
  esac
  branch="sdlc/intake-${ref:0:12}"
  rc=0
  api_get "repos/$TARGET/pulls?state=open&head=$(uri "$TARGET_OWNER:$branch")" "$SDLC_WORK/pulls.json" || rc=$?
  [ "$rc" -eq 0 ] || echo '[]' >"$SDLC_WORK/pulls.json"
  CALLER_PR=$(jq -r '.[0].html_url // empty' "$SDLC_WORK/pulls.json")
  if [ "$SDLC_MODE" = verify ]; then
    fail "$message${CALLER_PR:+; merge $CALLER_PR}"
    return
  fi
  note "$message"
  if ! needs_change "Commit the rendered caller to branch $branch and open a pull request in $TARGET"; then
    [ -z "$CALLER_PR" ] || note "Pull request already open: $CALLER_PR"
    note 'Writing a workflow file needs a token with the workflow scope: gh auth refresh -s workflow'
    return
  fi
  rc=0
  api_get "repos/$TARGET/git/ref/heads/$branch" "$SDLC_WORK/branch.json" || rc=$?
  if [ "$rc" -eq 4 ]; then
    api_get "repos/$TARGET/git/ref/heads/$TARGET_BRANCH" "$SDLC_WORK/base.json" || { fail "Cannot read $TARGET_BRANCH: $API_ERROR"; return; }
    base=$(jq -r .object.sha "$SDLC_WORK/base.json")
    body=$(jq -cn --arg ref "refs/heads/$branch" --arg sha "$base" '{ref: $ref, sha: $sha}')
    api_send POST "repos/$TARGET/git/refs" "$body" || { fail "Could not create branch $branch: $API_ERROR"; return; }
  elif [ "$rc" -ne 0 ]; then
    fail "Cannot read branch $branch: $API_ERROR"
    return
  fi
  rc=0
  sha=''
  api_get "repos/$TARGET/contents/$INTAKE_WORKFLOW?ref=$(uri "$branch")" "$SDLC_WORK/branch-file.json" || rc=$?
  if [ "$rc" -eq 0 ]; then
    sha=$(jq -r .sha "$SDLC_WORK/branch-file.json")
    jq -j '.content | gsub("\n"; "") | @base64d' "$SDLC_WORK/branch-file.json" >"$current"
  elif [ "$rc" -ne 4 ]; then
    fail "Cannot read $INTAKE_WORKFLOW on $branch: $API_ERROR"
    return
  fi
  if [ -n "$sha" ] && cmp -s "$expected" "$current"; then
    ok "Branch $branch already holds the rendered caller"
  else
    body=$(jq -Rs --arg message "Install the SDLC intake caller pinned to $ref" --arg branch "$branch" --arg sha "$sha" \
      '{message: $message, content: @base64, branch: $branch} + (if $sha == "" then {} else {sha: $sha} end)' "$expected")
    api_send PUT "repos/$TARGET/contents/$INTAKE_WORKFLOW" "$body" ||
      { fail "Could not commit the caller ($API_ERROR); writing a workflow file needs the workflow scope: gh auth refresh -s workflow"; return; }
  fi
  if [ -n "$CALLER_PR" ]; then
    ok "Pull request already open: $CALLER_PR"
    return
  fi
  body=$(jq -cn --arg head "$branch" --arg base "$TARGET_BRANCH" --arg control "$CONTROL" --arg ref "$ref" --arg label "$LABEL" '{
    title: "Install the SDLC intake caller",
    head: $head, base: $base,
    body: ("This adds the intake caller for the agentic SDLC control plane at `\($control)`.\n\n"
      + "When a writer applies the `\($label)` label to an issue here, the caller runs `\($control)/.github/workflows/sdlc-intake-receipt.yml` "
      + "at `\($ref)`. That workflow holds no secrets and no token permissions; it uploads a snapshot of the label event that the controller "
      + "authenticates before acting.\n\nMerge this file unchanged. The controller compares it byte for byte with its rendered template, "
      + "so any edit stops intake instead of widening it.")
  }')
  api_send POST "repos/$TARGET/pulls" "$body" || { fail "Could not open the pull request: $API_ERROR"; return; }
  CALLER_PR=$(jq -r .html_url "$SDLC_WORK/response")
  ok "Opened $CALLER_PR"
}

assert_registry() {
  jq -e '.schemaVersion == 1 and (.targets | type) == "array"' "$REGISTRY" >/dev/null 2>&1 ||
    abort "$REGISTRY is not a version 1 target registry"
}

# Looks up the registry entry by repository ID or name; a match on only one of them means the repository was
# renamed or recreated, which needs a deliberate registry edit.
registry_lookup() {
  local matches count
  ENTRY=''
  assert_registry
  matches=$(jq -c --argjson id "$TARGET_ID" --arg name "$(lower "$TARGET")" \
    '[.targets[] | select(.id == $id or (.repository | ascii_downcase) == $name)]' "$REGISTRY")
  count=$(jq length <<<"$matches")
  [ "$count" -eq 0 ] && return 0
  [ "$count" -eq 1 ] || abort "$REGISTRY has separate entries for the ID and the name of $TARGET"
  ENTRY=$(jq -c '.[0]' <<<"$matches")
  if [ "$(jq -r .id <<<"$ENTRY")" != "$TARGET_ID" ] || [ "$(lower "$(jq -r .repository <<<"$ENTRY")")" != "$(lower "$TARGET")" ]; then
    abort "The registry records $(jq -r '"\(.repository) (ID \(.id))"' <<<"$ENTRY"), but GitHub reports $TARGET (ID $TARGET_ID); a renamed or recreated repository needs a deliberate registry edit"
  fi
}

# The controller reads the registry from its default branch, so a local edit does nothing until it merges.
check_published_entry() {
  local rc=0 published
  api_get "repos/$CONTROL/contents/$REGISTRY_FILE?ref=$CONTROL_HEAD" "$SDLC_WORK/published.json" || rc=$?
  if [ "$rc" -ne 0 ]; then
    warn "Cannot read $REGISTRY_FILE on $CONTROL_BRANCH of $CONTROL: $API_ERROR"
    return
  fi
  published=$(decode_content "$SDLC_WORK/published.json" | jq -c --argjson id "$TARGET_ID" '[.targets[]? | select(.id == $id)] | first // empty')
  if [ -z "$published" ]; then
    warn "$TARGET is not registered on $CONTROL_BRANCH of $CONTROL yet; merge the registry change"
  elif [ "$(jq -cS . <<<"$published")" = "$(jq -cS . <<<"$ENTRY")" ]; then
    ok "The registry on $CONTROL_BRANCH matches $REGISTRY"
  else
    warn "The registry on $CONTROL_BRANCH differs from $REGISTRY: $(jq -c '{enabled, activatedAt, receiptRef: .intake.receiptRef}' <<<"$published")"
  fi
}

describe_entry() {
  jq -r '"\(.repository) (ID \(.id)) is \(if .enabled then "enabled" else "disabled" end), receipt pinned to \(.intake.receiptRef), activated \(.activatedAt)"' <<<"$ENTRY"
}

print_header() {
  say "Control plane  $CONTROL ($CONTROL_VISIBILITY, $CONTROL_BRANCH at ${CONTROL_HEAD:0:12})"
  say "Target         $TARGET ($TARGET_VISIBILITY)"
  say "Registry       $REGISTRY"
}

write_registry() { # JQ_FILTER [jq args]
  local filter=$1
  shift
  jq --indent 2 "$@" "$filter" "$REGISTRY" >"$SDLC_WORK/registry.json" && cat "$SDLC_WORK/registry.json" >"$REGISTRY"
}

run_checks() { # REF
  check_identity
  check_visibility
  check_target_actions
  check_control_config
  check_receipt_ref "$1"
  check_apps
  check_label
  check_caller "$1"
}

parse_common() { # NAME VALUE: sets shared options and returns 1 for an unknown option
  case $1 in
    --target) TARGET_ARG=$2 ;;
    --control) CONTROL_ARG=$2 ;;
    --registry) REGISTRY=$2 ;;
    *) return 1 ;;
  esac
}

default_control() {
  local url
  url=$(git -C "$1" remote get-url origin 2>/dev/null) || return 1
  url=${url%.git}
  case $url in
    *://*) url=${url#*://}; url=${url#*/} ;;
    *:*) url=${url#*:} ;;
  esac
  printf '%s' "$url"
}

validate_common() { # ROOT [local]
  [ -n "${TARGET_ARG:-}" ] || die 'missing --target OWNER/REPO'
  [[ $TARGET_ARG =~ $REPOSITORY_PATTERN ]] || die "invalid --target $TARGET_ARG"
  REGISTRY=${REGISTRY:-$1/$REGISTRY_FILE}
  [ -f "$REGISTRY" ] || die "registry $REGISTRY not found; pass --registry"
  [ "${2-}" = local ] && return 0
  if [ -z "${CONTROL_ARG:-}" ]; then
    CONTROL_ARG=$(default_control "$1") || die 'cannot infer the control repository from the origin remote; pass --control OWNER/REPO'
  fi
  [[ $CONTROL_ARG =~ $REPOSITORY_PATTERN ]] || die "invalid control repository $CONTROL_ARG"
  [ "$(lower "$TARGET_ARG")" != "$(lower "$CONTROL_ARG")" ] || die 'the target must differ from the control repository'
}
