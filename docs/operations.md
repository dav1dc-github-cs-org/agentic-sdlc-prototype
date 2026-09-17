# GitHub Setup and Operations

## Prerequisites

- A repository on GitHub.com with Actions enabled and permission to run the
  SHA-pinned actions used by the workflows.
- Copilot inference access. The agent workflow bills inference to an
  organization's Copilot subscription through the per-run Actions token, which
  requires an organization-owned repository with centralized Copilot billing.
  Step 2 describes the personal-account fallback. This implementation runs
  Copilot through Agentic Workflows, not issue assignment to the managed Copilot
  cloud agent.
- CodeQL availability. Private repositories need the appropriate GitHub Code
  Security entitlement. Missing scanner access is a blocking error, not an
  automatically waived security gate.
- Permission to configure repository variables, environments, and branch rules.
- A reviewed default-branch installation of the complete repository contents.

The built-in test harness targets Node.js/TypeScript, an npm lockfile, a
TypeScript configuration, and Node's test runner. Supporting a different stack
requires a reviewed validator and policy change before enabling agents.

The [Research agent](../.github/agents/research.agent.md) evaluates product-fit
technology separately from pipeline compatibility. Its plan must compare
credible approaches and state whether the recommendation is `supported`,
`requires maintainer changes`, or `unknown`. If implementation or required
validation is unsupported, its blocked summary lists the recommendation,
specific gaps, and decisions needed. Plan approval alone cannot authorize
protected-path edits or weaker gates. Maintainers must separately approve and
land prerequisite tooling or policy changes, then obtain a supported research
plan and fresh approval under the normal trusted-revision rules.

## 1. Create a Controller App

Create a GitHub App with webhooks disabled and install it only on this
repository. No separately hosted App server is required. Register the App under
the same account that owns the repository: a private App can only be installed on
its owner's account, so transferring either the App or the repository later
uninstalls it and every controller run then fails to mint a token. Give it these
repository permissions:

| Permission | Access | Purpose |
| --- | --- | --- |
| Contents | Read and write | State branch and approved feature commits |
| Issues | Read and write | Intake, comments, task links, closure |
| Pull requests | Read and write | Final PR and advisory review |
| Actions | Read and write | Dispatch, cancel, and inspect registered workers |
| Checks | Read and write | Commit-bound completion check |
| Metadata | Read | Repository identity and permission queries |

Do not grant Administration permission. Do not give this App a bypass on the
default branch. Generate an App private key and enter it directly into GitHub's
secret configuration, never into an issue, prompt, committed file, or chat.

Create repository variables:

| Variable | Value |
| --- | --- |
| `SDLC_APP_ID` | Numeric App ID |
| `SDLC_APP_SLUG` | App slug, without the `[bot]` suffix |
| `SDLC_ENABLED` | `false` until all setup and checks are complete |
| `SDLC_MODEL` | Optional Copilot inference model ID; defaults to `auto` when unset or empty |
| `SDLC_AIC_CREDIT_LIMIT` | Optional per-inference-job AI credit cap, a whole number from 1 to 10,000; defaults to `250` when unset or empty |

The App slug is used to authenticate worker runs. It must match the App that
mints the controller token; it is not the App's human-readable display name.
The controller compares this variable against the slug of the App it
authenticates as and fails the run when they differ. Without that check a stale
value leaves every dispatched worker skipping its own actor gate, stalling the
lifecycle with no failed run to investigate.

Configure `SDLC_MODEL` under **Settings > Secrets and variables > Actions >
Variables** with a model identifier supported by the Copilot runtime and enabled
for your organization. It applies to all eight SDLC agent stages and gh-aw's
threat-detection pass. Changes apply to subsequent workflow runs without editing
or recompiling workflows; remove the variable or leave it empty to restore `auto`.

### AI Credit Limit

Create `SDLC_AIC_CREDIT_LIMIT` in the same repository **Variables** tab, not as
a secret. For example, `500` permits each inference job to consume up to that
configured budget. Delete the variable or leave it empty to restore `250`.
Use plain decimal digits with no leading zeros or surrounding whitespace.
Zero, negative values, fractions, non-numeric values, and values above 10,000
are rejected before inference rather than disabling the limit.

The agent workflow's credential-free `budget` job validates and captures the
value after the normal activation gates. Both the primary agent and the
threat-detection job use that captured value, with a separate budget for each
job. This is not a combined workflow or lifecycle spending cap. Actions minutes
and organization billing limits are separate. Once this workflow update is
deployed, changing the variable requires no source changes or recompilation.

The worker context and controller status use the resolved limit. New
`sdlc-cost` receipts also record the primary agent's `creditLimit`, so near-limit
classification uses the cap that applied to that run even if the repository
variable changes before reconciliation. Older receipts without `creditLimit`
remain readable and use the controller's resolved limit as a fallback. Already
recorded totals are not recalculated. The existing receipt measures primary-agent
inference; threat-detection usage remains in gh-aw's separate diagnostics.

Missing or malformed usage/stop-signal outputs are recorded as `null`, separately
from a measured zero or explicit `false`. Missing, expired, duplicate, or oversized
agent cost artifacts also mean unavailable telemetry. Malformed artifact content
still fails validation. Deterministic `scan` and `validate` jobs have known zero
inference usage. Unavailable telemetry is kept pending for bounded retry, not
immediately marked costed. If collection cannot recover it, cost history is
marked incomplete and only observed values are recorded. Near-limit
classification requires measured usage and an explicit non-pre-emption signal.

The pinned gh-aw v0.88.7 compiler only supports literals in `max-ai-credits`.
This workflow instead uses its supported `engine.env.GH_AW_MAX_AI_CREDITS`
override. Do not add a literal cap or edit the generated workflow manually.
The compiler's generic failure handler still carries its own `1000`-credit
default; it is not the effective inference limit. Use the explicit
"Per-inference-job credit limit" step summary, the receipt's `creditLimit`,
and the archived firewall configuration when investigating budget errors.

### Final PR Cost

New feature PRs include the controller's resolved `SDLC_MODEL` and
`SDLC_AIC_CREDIT_LIMIT` settings in the Cost section, alongside existing cost
totals and warnings. Unset or empty settings appear as `auto` and `250`.
The values are labeled as configuration at PR creation, not settings measured
for every earlier run. In particular, `auto` does not identify the concrete
model chosen by the inference service. The credit limit is per inference job,
not per model turn. Publication retries reuse the existing PR without rewriting
its configuration snapshot. No additional repository variables or permissions
are required.

**Observed agent models** separately lists the distinct concrete model IDs
reported in available primary-agent token-usage records. The workflow post-step
reads the `model` field from
`/tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs/token-usage.jsonl`, the same
structured source used by the
[pinned gh-aw usage parser](https://github.com/github/gh-aw/blob/v0.88.7/actions/setup/js/parse_mcp_gateway_log.cjs).
The workflow summary and `sdlc-cost` receipt include up to 20 unique IDs per run.
The controller retains them during partial cost recovery and accumulates them
when costs settle, including retries, failed runs, and superseded plans. This
does not change credit totals, limits, or result acceptance.
PR and status displays show at most 20 model IDs plus a remaining count; the
complete captured set stays in `spend.models`.

`auto` and `unknown` are not concrete model IDs. Missing, unreadable, oversized,
or invalid model telemetry yields no model observation and cannot turn measured
credits into an accounting failure. The report says `unavailable` when no
concrete model is recorded. Legacy receipts remain readable but are not
backfilled. An observed list is informational, not a complete per-run history or
a per-model billing breakdown: missing/legacy runs and separate threat-detection
inference are outside its coverage. Models may vary with automatic selection;
the configuration snapshot must not be interpreted as one resolved model for
every stage.

The totals are also a snapshot at PR creation. Any pending cost entries are
explicitly counted and excluded from those totals, not represented as free runs.
Publication does not wait for them. Follow the linked epic's lifecycle status
for later settlement and observed models, including after PR closure or merge;
an existing PR body is not rewritten when receipts recover.

### Retained Model Usage

Settled attribution is stored in the lifecycle's optional `usageHistory` array
on `sdlc-state`, not just in the aggregate Cost display or expiring Actions
artifacts. There is at most one entry per registered job, bounded to 100 entries
by the supported job budget. The controller binds identity from its registered
job; the receipt cannot supply a stage, persona, task, plan, or approval.

| Field | Collected meaning |
| --- | --- |
| `job.id`, `job.stage`, `persona` | Original job, assigned stage, and `sdlc-<stage>` role; `persona: null` for deterministic `scan` and `validate` |
| `job.taskId`, `job.attempt` | Original task and dispatch-attempt counter when known; old pending records may omit them |
| `job.runId`, `job.createdAt` | Matched Actions run, when discovered, and original job creation time; only first-attempt Actions runs are eligible |
| `job.inputSha`, `job.controlSha`, `job.planHash` | Original source, trusted workflow revision, and registered plan hash, which can be null before planning |
| `observed.requestedModel` | Workflow-time configured selector, such as `auto`, distinct from the PR-time configuration snapshot |
| `observed.models` | Available concrete model IDs, including multiple models within one primary-agent run |
| `observed.tokenUsage` | Telemetry status and per-model request, input, output, cache-read, and cache-write token counts |
| `observed.credits`, `observed.runnerMs` | Existing measured primary-agent credits and workflow runner time, not per-model billing allocations |
| `acceptedResult.outcome`, `acceptedResult.outputSha` | Controller-accepted report outcome and resulting commit; absent when no acceptance was recorded |

Token telemetry is `available`, `partial`, or `unavailable`. Counts are summed
from structured usage records per model, deduplicating repeated nonempty request
IDs. Without an ID, each record is counted. Missing or invalid token fields
make that model's corresponding total `null`, not zero. Malformed records and
the 20-model capture cap make usable telemetry partial. Counts preserve runtime
semantics; input and cache counts can overlap and must not be naively added or
converted into charges. The existing credit calculation is unchanged.

Partial cost recovery retains the first observed requested selector and the
best single token snapshot, preferring available over partial telemetry, then
more observed requests. Repeated snapshots are never summed together. Empty or
degraded reads cannot erase better telemetry. A missing model/token field does
not extend cost collection or block an otherwise valid result.

Settlement saves the ledger entry, cost tally, and pending-entry removal or
active cost marker in the same SHA-checked update. Interrupted writes and lost
acknowledgements cannot duplicate attribution or charges. Expired or permanently
unavailable accounting retains the known job identity even with no observations.
Accepted-result metadata is kept with pending costs when result acceptance
precedes settlement. Failed workflows and stale results never acquire accepted
metadata merely because they consumed tokens.

This is historical accounting, not active gate evidence or proof that the
persona instructions were followed. It survives source changes and replanning
but cannot authorize work or resurrect old evidence. No adversarial selection,
cross-lab policy, or originating-lab catalog is implemented. Inference still
uses the existing `SDLC_MODEL` setting. Separate threat-detection inference and
fine-grained tool/subagent attribution remain outside this primary-agent scope.

Older receipts and state load unchanged. Old aggregate model lists cannot be
reconstructed into job attribution, and already-costed runs are not reread for
backfill. Missing history or absent token fields must not be treated as zero
usage or proof of model diversity. `spend.historyComplete` describes credit
accounting, not model/token-history completeness. Deploy the controller and
generated workflow together after draining old runs, and preserve these optional
fields in rollbacks because older strict readers reject them.

## 2. Configure Environments

Create both environments before enabling the controller. Limit deployment
branches to this repository's default branch. Do not add a required reviewer
unless you intentionally want a human checkpoint on every job.

Each environment takes two calls: one to enable custom branch policies, one to
name the branch. Substitute your repository and default branch.

```sh
repo=OWNER/REPO
for environment in sdlc-controller sdlc-agent; do
  gh api -X PUT "/repos/$repo/environments/$environment" --input - <<'JSON'
{ "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
  gh api -X POST "/repos/$repo/environments/$environment/deployment-branch-policies" \
    -f name=main -f type=branch
done
```

### sdlc-controller

Store `SDLC_APP_PRIVATE_KEY` as an environment secret. Only the trusted
controller references this environment. Do not also store this key as a
repository-wide secret: candidate workflows must not be able to request it.

### sdlc-agent

This environment holds no secrets. The [agent source](../.github/workflows/sdlc-agent.md)
sets `permissions.copilot-requests` to `write`, so inference uses the per-run
Actions token and bills through the organization's Copilot subscription. No
personal access token is created, stored, or rotated. The environment still
exists to restrict agent runs to the default branch.

This mode requires an organization-owned repository whose organization has a
Copilot subscription with centralized billing enabled. Confirm the organization's
Copilot policies permit it before enabling the controller.

If inference fails with `403`, inspect the `agent` artifact and its proxy usage
before changing credentials. The status alone does not establish missing
Copilot access, especially after successful requests near the configured credit cap.
See [Blocked Scan Repairs](#blocked-scan-repairs). If diagnostics confirm that
organization inference access is unavailable, a fallback is to set
`permissions.copilot-requests` to `none`,
recompile with the pinned compiler, and store `COPILOT_GITHUB_TOKEN` as an
environment secret here. That fallback needs a fine-grained token owned by a user
account rather than an organization, with Account permissions then Copilot
Requests set to read, following the
[Copilot engine authentication guide](https://github.github.io/gh-aw/engines/copilot/).
Read-only repository access uses the workflow token in either mode.

The generated workflow uses sandbox containers on GitHub-hosted runners. Docker
is not a local development requirement. Do not run untrusted candidate tests
on a persistent runner with organization credentials or access to production.

## 3. Protect Branches

Every command below assumes these two values. For `Integration` bypass actors,
`actor_id` is the numeric App ID, not the installation ID.

```sh
repo=OWNER/REPO
app=$(gh api "/repos/$repo/actions/variables/SDLC_APP_ID" --jq .value)
```

Create both `sdlc-state` rulesets before the branch's first creation, because
`creation` is only evaluated when the branch does not yet exist. The state
branch needs two rulesets rather than one: bypass is granted per ruleset, not
per rule, so a single ruleset would also hand the App the deletion and
force-push rights it must never hold. Rules aggregate across rulesets, so the
split leaves the App able to create and push state commits while staying bound
by the locks. The controller initializes this branch with an isolated root
commit and maintains an auditable JSON history; it never deletes or rewrites it.

```sh
gh api -X POST "/repos/$repo/rulesets" --input - <<JSON
{
  "name": "sdlc-state controller writes",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [{ "actor_id": $app, "actor_type": "Integration", "bypass_mode": "always" }],
  "conditions": { "ref_name": { "include": ["refs/heads/sdlc-state"], "exclude": [] } },
  "rules": [{ "type": "creation" }, { "type": "update" }]
}
JSON
```

```sh
gh api -X POST "/repos/$repo/rulesets" --input - <<'JSON'
{
  "name": "sdlc-state immutable history",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["refs/heads/sdlc-state"], "exclude": [] } },
  "rules": [{ "type": "deletion" }, { "type": "non_fast_forward" }]
}
JSON
```

Do not require a PR for state updates, and do not require signed commits on
either ruleset. The isolated root commit carries no signature, so a signing rule
in the unbypassed ruleset permanently blocks branch creation.

For the default branch, require pull requests, `CI / Verify`, `CI / CodeQL`, and human review.
Protect automation and policy changes with code-owner or designated maintainer
review. Do not permit the controller App to bypass these requirements.

```sh
gh api -X POST "/repos/$repo/rulesets" --input - <<'JSON'
{
  "name": "default branch protection",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [{ "context": "CI / Verify" }, { "context": "CI / CodeQL" }] } }
  ]
}
JSON
```

Code-owner review only takes effect once the repository has a `CODEOWNERS` file.
The included [.github/CODEOWNERS](../.github/CODEOWNERS) covers `.github/`,
top-level controller modules, tests, and the root dependency manifests and
TypeScript configuration. It covers only part of the protected paths in
[policy.json](../.github/sdlc/policy.json): `.agents/**`, `.vscode/**`, nested
manifests, instruction files outside `.github/`, and several other protected
configuration patterns have no matching ownership entry. Those paths remain
blocked to agents, but code-owner review is not automatically required for them.
Review ownership coverage separately from agent path restrictions before enabling
the pipeline; broader coverage requires a reviewed maintainer change.

Replace the owner handle with a maintainer or team in your own account, then
confirm GitHub resolves it:
`gh api "/repos/$repo/codeowners/errors"` reports unknown owners and owners
without write access, and an unresolvable owner silently disables the rule.

In a dedicated pipeline-only sandbox, also require `SDLC / Complete` and select
the controller App as its expected source after the first pilot check appears.
This check is deliberately absent on unprocessed commits. Requiring it for all
PRs also blocks manually authored maintenance PRs; handle those through an
explicit human governance policy, never an automatic App bypass.

Restrict updates to `agentic/epic-*` branches to the controller where practical.
Changes made outside a registered job stop automatic integration. Changes after
the final PR is published do not inherit evidence from its old head commit.

```sh
gh api -X POST "/repos/$repo/rulesets" --input - <<JSON
{
  "name": "agentic epic branches",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [{ "actor_id": $app, "actor_type": "Integration", "bypass_mode": "always" }],
  "conditions": { "ref_name": { "include": ["refs/heads/agentic/epic-*"], "exclude": [] } },
  "rules": [{ "type": "creation" }, { "type": "update" }]
}
JSON
```

Do not lock deletions on that pattern. A new plan version starts a new branch and
preserves the previous one, so superseded branches accumulate and need cleanup.

Confirm the result with `gh api "/repos/$repo/rulesets"`. On an organization-owned
repository, organization rulesets layer on top of these and repository admins
cannot bypass them; check the organization's rules for conflicting targets.

Disable automatic merge. Feature PRs are published only after all required gates;
separate maintenance draft PRs need an explicit writer command and normal review.
The prototype does not decide whether humans should merge either kind of PR.

## 4. Install and Enable

Run the local verification in the [README](../README.md). Review the Markdown
workflow and generated lockfile, then commit and push them to the default branch.
The controller and worker workflows must all exist on that branch before
dispatch can work. If the default branch is not `main`, update the push filter
in [CI](../.github/workflows/ci.yml) as part of installation.

Create the `agentic-SDLC` label in the repository. Optionally use the included
[issue form](../.github/ISSUE_TEMPLATE/agentic-feature.yml); automatic labels on
the form still require the label to exist and the labeler to have write access.

```sh
gh label create agentic-SDLC --repo "$repo" --color B60205 \
  --description "Approval-gated agentic delivery pipeline"
```

Harden the repository's Actions defaults. Every workflow here declares explicit
permissions, so nothing depends on the repository default, but a newly added or
contributed workflow would otherwise inherit write access and be able to approve
a pull request.

```sh
gh api -X PUT "/repos/$repo/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
```

On a public repository, require approval before a fork pull request can run any
workflow. Approving such a run executes contributed code on your runner. The
token is read-only and environment secrets stay unreachable, but the compute is
yours, so read the diff first.

```sh
gh api -X PUT "/repos/$repo/actions/permissions/fork-pr-contributor-approval" \
  -f approval_policy=all_external_contributors
```

Set Actions and inference spending limits. Set `SDLC_ENABLED` to `true` only
after the environments, App installation, label, and permissions are ready.
The editor may show unknown-context warnings for the variables and environments
until those GitHub settings exist.

### Verify before enabling

Scan the baseline with CodeQL and fix what it reports first. `CI / CodeQL` now
enforces the same whole-tree security-extended policy as SDLC; `CI / Verify`
still covers typecheck, tests, and build separately. New lifecycles also preflight
the baseline before inference. Findings at security severity 7 or above, errors,
and unclassified findings remain blockers. A protected-file defect can produce
a maintainer repair proposal, not an automatic feature-stage edit or waiver.
For existing installations, add `CI / CodeQL` to required checks only after the
reviewed workflow is deployed and the check has appeared. This is a separate
maintainer settings action, not performed by the controller or local tests.

Then confirm the configuration reports what you expect:

```sh
gh api "/repos/$repo/actions/variables" --jq '.variables[] | "\(.name)=\(.value)"'
gh api "/repos/$repo/actions/secrets" --jq '.secrets[].name'
gh api "/repos/$repo/environments" --jq '.environments[].name'
gh api "/repos/$repo/environments/sdlc-agent/secrets" --jq '.secrets | length'
gh api "/repos/$repo/rulesets" --jq '.[].name'
gh api "/repos/$repo/codeowners/errors" --jq '.errors | length'
gh api "/repos/$repo/labels" --jq '[.[].name] | index("agentic-SDLC")'
gh api "/repos/$repo/contents/.github/workflows?ref=main" --jq '.[].name'
```

`SDLC_APP_PRIVATE_KEY` must not appear in the repository secret list, and the
`sdlc-agent` environment must hold zero secrets. Candidate workflows can request
repository secrets; they cannot request another environment's. All four
workflows must already exist on the default branch, and the codeowners and
label checks must return `0` and a non-null index respectively.

First intake requires an `issues:labeled` event sent by a human with current
write access. Schedules and manual dispatches reconcile durable state but do not
create a lifecycle from a pre-existing label. If an issue was labeled while the
controller was disabled, remove the label and have a writer reapply it.

## 5. Run a Bounded Pilot

Use a small change with explicit acceptance criteria in an allowed application
path. For this repository, a documentation-only change or a new independently
tested module under a subdirectory is a suitable first pilot; the controller
source and existing baseline tests are protected.

1. Have a repository writer apply `agentic-SDLC` to the issue.
2. Confirm the issue receives a status comment and a proposed plan.
3. Request one revision with a new `/sdlc revise ...` comment.
4. Confirm that approving the old version is rejected.
5. Approve the current version with a new `/sdlc approve vN` comment.
6. Observe native sub-issues, sequential coding, scans, security review, testing,
   coverage comparison, and independent review.
7. Confirm no feature PR exists before all gates pass.
8. Inspect the final PR's plan hash, current-commit evidence, advisory review,
   and `SDLC / Complete` check. Review and merge it yourself.
9. Confirm the epic and child tasks close after merge.

Also test pausing an in-flight job and a deliberately failing test on a disposable
pilot. Do not treat local mocks as evidence that live credentials, billing,
network policies, CodeQL licensing, or Copilot behavior work in your organization.

## Coding and Repair Evidence

The [Coding profile](../.github/agents/code.agent.md) maps each assigned criterion
and relevant worked example to an observable result and check before editing.
It adds regression coverage within permitted paths, treats test code as scanned
source, and verifies the actual consumer entry point, including build output,
module or asset resolution, and the launch working directory or server root.
Checks use approved available tools; static markup or DOM-mock assertions do
not establish browser behavior. Only manual follow-up explicitly permitted by
the approved plan may remain pending without blocking required validation.

Repairs start from the current diagnostic's checker or command, rule, path, and
line where available, not an earlier agent's explanation. The agent distinguishes
candidate regressions from pre-existing or protected defects and infrastructure
failures. It uses a bounded reproduction and focused checks; missing evidence or
protected-file repairs require an actionable `blocked` report, not a blind search
or weaker gate. Final evidence records commands, working directories, exit
statuses, and limitations. `npm run verify` runs typecheck, coverage tests, and
build; it is not CodeQL execution or proof of browser behavior.

Before expensive investigation and after meaningful progress, the coding agent
writes a provisional `blocked` report beginning `Coding work incomplete` and
packages it with `node control/src/worker.ts collect`. Trusted preparation seeds
both coding and Security with an initial incomplete-work blocker. The final
upload attempts to retain the last packaged result, but runner termination can
prevent capture. A valid structured `incomplete_work` report from the current
job can retain a bounded draft for a registered successor. Failed workflows
still cannot supply accepted results or gate evidence. Source, approved plan,
trusted workflow revision, task, execution breakdown, and step must all match
before restoration. The successor inspects and validates the draft afresh.

The summary includes scope and changes, acceptance and evidence, outstanding
work, and the stop reason and handoff. `pass` requires completed assigned work
and required coding checks; later independent gates are not self-approved.
The structured recovery contract does not prove semantic completeness, but does
enforce bounded routing and authority. Workers can query the shared permission
checker, including the exact immutable baseline test list, before proposing edits.

## Test Design and Coverage

The [Testing agent](../.github/agents/test.agent.md) derives a starting test plan
from the approved behavior, request, and established public contracts. Sparse
test instructions alone are not a blocker. Its summary maps criteria to inputs,
actions, independently justified expectations, risk, tests, and execution status.
Relevant positive, negative, boundary, repeated-operation, state-transition,
failure-recovery, and regression cases fill gaps without inventing product rules.

An undefined expected outcome requires a precise question, ideally resolved in
Research before implementation. Testing returns `blocked` for such ambiguity,
unavailable required validation, or unfinished testing. A demonstrated production
defect returns `changes_requested` with the reproduction and failing command in
the summary: that outcome does not publish proposed test changes. The subsequent
attempt must re-establish the tests at its registered commit, not assume an
unaccepted test patch was preserved on the branch.

Only permitted test paths may change, and tests present at `state.baseSha` remain
immutable. The agent runs new or changed tests and relevant regressions, reports
actual exit codes and counts, and distinguishes its results from the controller's
later full-suite and coverage checks. Browser rendering, touch behavior, and
visual accessibility remain unverified by Node or DOM-mock tests. Later human
checks explicitly assigned by the approved plan stay pending; they cannot
silently replace required automated validation.

This is guidance for test design and honest reporting. The report schema does
not independently prove the coverage map is complete. Test-only permissions,
immutable baseline tests, deterministic validation, and coverage gates remain
unchanged.

## Documentation Edits

The shared worker instructions and the [Documentation profile](../.github/agents/document.agent.md)
permit the `document` stage to propose changes only within `policy.docsPaths`.
The `test` stage remains limited to `policy.testPaths`, and only `code`, `test`,
and `document` may propose file changes. Protected paths and existing baseline
tests remain immutable regardless of these path allowances. Other agent stages
must leave the source checkout unchanged.

Documentation proposals use the existing report and collect contract. The
controller validates and publishes accepted changes; agents receive no direct
GitHub write authority. Accepted doc changes invalidate older gate evidence and
return the lifecycle to scanning before final review. No-change documentation
results continue directly to review.

## Incomplete Security Reviews

The [Security profile](../.github/agents/security.agent.md) reviews the full
integrated diff, prioritizing scanner diagnostics and changed trust boundaries.
It must list reviewed, not-applicable, and pending areas, distinguish confirmed
defects from suspicions, identify protected-path blockers, and record the exact
remaining work. It must not return `pass` while required review is unfinished.
Those completeness instructions guide the model; they are not a semantic
validator of its claims.

After validating a registered Security job, trusted preparation seeds
`.sdlc-output/result.json` with an initial `blocked` result stating that review
has not started. The agent updates its provisional report and runs the existing
collect command after meaningful progress. Checkpoints stay `blocked` until a
final outcome is justified. The fixed `always()` upload step attempts to retain
the last packaged result even when inference fails. Checkpoints are local until
that upload succeeds; runner termination can still prevent capture entirely.

When collecting a failed worker workflow, the controller posts a stable
**Worker attempt diagnostics** comment before recording its cost. It includes
the registered stage, job, source and trusted revision, plan hash, run link,
measured or unavailable usage, applied cap (or labeled fallback), and reported
or unknown pre-emption signal. For failed Security runs, it also includes up to
6000 characters of the last available checkpoint/result, after validating the
job, commit, plan, and read-only change policy. Missing or invalid checkpoints
are labeled unavailable, never treated as completed work. A failed run cannot
provide passing evidence even if its uploaded report claims `pass`.

Successful worker workflows with unavailable telemetry or reported pre-emption
also receive diagnostic warnings. Diagnostic comments are idempotent by job and
run, separate from accepted evidence, and remain visible after a retry starts.
Comment retries cannot double-charge the run. Failed-stage retry budgets,
human commands, and current-commit acceptance checks remain unchanged. An
explicit legacy `blocked` report still blocks. A structured `incomplete_work`
checkpoint uses bounded continuation; an approval conflict requests a decision.

For an interrupted review:

1. Read the attempt comment and linked `sdlc-result`, `sdlc-cost`, and `agent`
  artifacts. Distinguish missing progress from an actual list of finished
  checks. The checkpoint excerpt is untrusted context, not proof or authority.
2. Compare the captured cap with measured usage and proxy errors. The model
  cannot infer remaining credits from the configured limit, and neither
  proximity to the cap nor HTTP 403 alone proves exhaustion.
3. Resolve the cause before a manual retry. A replacement Security job must
  revalidate previous observations at its registered commit. Protected-path
  findings require maintainer changes, not a waiver or a blind repair loop.

Automatic rejection based solely on `preempted` remains deferred. A successful
workflow with a valid `pass` report can still advance despite a telemetry
warning. Before adding that gate, conduct a separately authorized experiment
on a disposable lifecycle: compare a deliberately constrained run with a normal
run, inspect actual proxy-stop evidence, verify `true` versus `false`/unknown
outputs, and confirm incomplete reviews cannot publish. Do not lower a shared
repository cap while unrelated work is active. No such live experiment is run
by the local test suite.

Deploy the controller and generated workflow together after draining older
runs. Older code may reject the new nullable cost fields. Existing numeric
receipts remain readable and persisted lifecycle state stays at version 2;
this change adds no new required state fields or permissions.

## State Upgrades

The controller writes `schemaVersion: 2`. Its shared loader accepts valid
version-1 records with or without `spend`, validates their complete structure,
and upgrades them in memory. Workers only read; the controller persists upgrades
using the original state-file SHA before processing commands, PR disposition, or
terminal-state early returns. Scheduled reconciliation includes all stored issue
records, even when their issues or PRs are closed.

Existing cost totals and `job.costedRun` receipts are preserved. Records without
`spend` start a new recorded-cost tally with `spend.historyComplete: false`.
Issue status and newly created PR summaries label these totals "earlier costs
unavailable"; they are not the full historical lifecycle cost. Later runs add to
the tally without clearing that warning. This migration does not reconstruct
past costs or rewrite existing PR descriptions. Version-1 records that already
have cost totals retain them with `historyComplete: true`.

Deferred accounting adds optional `pendingCosts` to version 2. Existing records
without it remain valid; no counters or approvals are reset. New entries preserve
an unsettled job's original identity, deadline, and any observed measurements
across interruptions. Empty queues are omitted. The extension cannot reconstruct
jobs already discarded by older code or safely retry receipts already marked
`job.costedRun`; existing totals and history flags are preserved, not backfilled.
Older strict version-2 readers reject this field, so drain older runs before
deployment and retain `pendingCosts` support in any rollback.

Observed-model reporting adds optional `models` arrays to cost receipts,
pending observations, and `spend`, without changing the state version. Records
without them load unchanged; model history is not inferred or backfilled.
Deploy the controller and recompiled agent workflow together after draining
older runs, and preserve these fields in any rollback because older strict
readers reject them. Model availability does not change `historyComplete`,
which describes cost accounting, not completeness of the model list.

The collection-only attribution extension adds optional `usageHistory`,
`requestedModel`, `tokenUsage`, and accepted-result metadata, plus optional task
and dispatch-attempt fields on retained identities. Version 2 remains unchanged;
legacy records are not backfilled. All of these fields require upgraded readers
on the controller and workers, including during rollback.

Recovery adds optional version-2 fields: `recoveries`, `retryAt`, `amendment`,
`amendmentHistory`, `planVersion`, `preflight`, `vendorRepair`, `maintenanceRecovery`,
`dependencyChoices`, and `dependencyPatches`. Plans may carry hashed `policy`;
tasks may carry requirement IDs, block references and execution steps; new jobs
bind an `executionHash`, optional `stepId`, preflight purpose and probe SHA.
Old states and report payloads load without these fields. New permissions are
never inferred from old prose, and new preflight is not backfilled as evidence.
Older strict readers cannot load the new fields or phases. Drain old runs and
deploy controller, worker, policy, profiles, Markdown workflow and generated
lockfile together. Preserve these readers in any rollback.

For an existing installation:

1. Set `SDLC_ENABLED=false`. Wait for running controller and worker jobs to
  finish, or cancel them in Actions, and cancel queued runs of the old revision.
  The variable alone does not stop jobs already running.
2. Deploy the reviewed upgrade to the default branch while disabled. Do not
  edit or delete state records on `sdlc-state`, close issues or PRs, or relabel
  issues to work around the old missing-`spend` validation error.
3. Set `SDLC_ENABLED=true` and start a new controller run on the default branch,
  leaving its optional issue input empty to reconcile all stored records, or
  let the next scheduled run do so. Do not rerun an old failed workflow revision.
4. Check that the controller succeeds, records now have `schemaVersion: 2`, and
  affected issue summaries qualify their cost history. If an active lifecycle
  reports a changed trusted revision, use a maintainer-requested
  `/sdlc amend <feedback>` to retain source, or `/sdlc revise <feedback>` to start
  over, then approve the new proposal. Migration does not bypass that gate. A lifecycle with
  an open feature PR remains managed through PR review.

A failed or conflicting migration write stops that issue's reconciliation before
other effects. The next run reloads state: if the write never committed, it retries
the migration; if the response was lost after the commit, it reads version 2 and
does not migrate again. Malformed costs, invalid authority fields, and unknown
schema versions still fail validation rather than being defaulted or discarded.

Once version-2 records exist, older code that only understands version 1 is not
a compatible rollback. Any rollback must retain version-2 read/write support;
restoring old state can lose accepted work and cost receipts.

## Recovery

Controller runs are serialized. Actions may coalesce pending events; every
10 minutes the schedule rereads durable state and issue commands. It can also
be run manually from the Actions tab, optionally for one issue.

- A lost dispatch is rediscovered by job identity, actor, and workflow revision,
  then retried within policy if no run appears.
- A transient `404`, `408`, `429`, rate-limited `403`, or `5xx` while retrieving
  a completed worker artifact, or a successful listing where that artifact is
  not visible yet, preserves the registered job for another reconciliation. If
  retrieval remains unavailable past the job timeout, it consumes one
  infrastructure failure.
- A transient failure after a branch write can recover the matching commit.
  Do not manually rewrite the state file to work around a failed run.
- Structured failures are classified using path policy and diagnostic evidence.
  Legacy repair feedback retains its bounded coding path; missing or malformed
  results consume infrastructure attempts.
- Use `/sdlc retry` only for eligible infrastructure or legacy blocks after
  correcting the cause. Structured approval, maintenance, unsafe-output and
  exhausted-recovery records reject unchanged retries. Do not use GitHub's rerun button on
  worker jobs: rerun attempts are deliberately excluded from trusted results.
- If the default branch name changes, use full `/sdlc revise ...`. For scope or
  protected-path changes, choose a scoped amendment or full revision and approve
  the new plan. A trusted-baseline amendment requires a maintainer. Movement outside
  protected paths is adopted as the trusted workflow revision between jobs;
  it does not automatically rebase the candidate branch. Earlier branches remain
  available for inspection.
- Cancellation saves any unsettled accounting identity while invalidating
  in-flight results, before requesting cancellation of the worker run. A late
  receipt can update costs; a late result cannot restart the lifecycle.

`SDLC_ENABLED=false` prevents new controller transitions and worker starts.
For an immediate emergency stop, also cancel in-progress controller and worker
runs in Actions. Removing the label or closing the issue cancels that lifecycle.

Logs and artifacts are retained according to Actions policy; worker evidence
artifacts request 14-day retention. Durable state and issue/PR summaries retain
the links, not perpetual copies of expiring artifacts. Adjust retention for
your audit needs through a reviewed workflow change.

### Structured Recovery

Workers report `blocker.category`, `scope`, affected `paths`, the conflicting
`constraint`, structured `diagnostics`, and proposed `remedies`. The controller
does not treat these claims as authorization. It checks baseline ownership and
protected paths, binds records to the original job and commits, and persists
attempt fingerprints before another job is dispatched.

| Category | Recovery |
| --- | --- |
| `transient` | Bounded retry with an earliest retry time of 30 seconds, then exponential backoff |
| `candidate_defect` | Targeted coding repair within both repair and attempt budgets |
| `incomplete_work` | Continue the original registered stage, or execute an explicitly permitted acceptance-preserving coding split |
| `approval_conflict` | Prepare an amendment only for an already approved plan when no ready work or pending amendment prevents it and the trusted head is current; otherwise wait for a decision |
| `baseline_defect` | Prepare a separate maintainer patch for the exact diagnosed files |
| `unsafe_output` | Reject without applying changes or bypassing a gate |

The scheduled reconciler runs every ten minutes, so backoff is an earliest
retry time, not a promise of a 30-second restart. Artifact and cost retrieval
retain their existing same-job, timeout-bounded recollection behavior.
Recovery attempt counts are separate from the global 40-job and two-repair
budgets, which never reset merely because a worker changes its explanation.
Identical deterministic repair keys stop early. Stage/task/step fingerprints
avoid sharing one retry counter between unrelated work. History has at most
40 recovery records and 40 amendment decisions. Only one current draft is kept,
limited to 300 KB of serialized changes; lifecycle writes are capped at 1 MB.

A task-local decision or exhausted automatic recovery marks that task unavailable
and allows another dependency-ready task to run. Its dependents stay unavailable.
Automatic retries and incomplete-work continuations resume their registered stage,
not always coding. Repository-wide trust or baseline failures stop feature work.
No unresolved recovery can satisfy final publication.
Worker permission queries use `node control/src/worker.ts check <path>...` and
the same validator as publication. This is a path-policy check, not authorization
for a new feature or a guarantee the complete patch is publishable.

Baseline-test immutability is separate from protected-path drift. Tests present at
`state.baseSha` cannot be edited by feature workers, whether or not they match
`isProtectedPath`. An upstream change to an unprotected baseline test does not
alone trigger trusted-revision blocking. Adopting that workflow revision between
jobs does not incorporate the change into the feature or replace its baseline.

### Scoped Amendments

Use a new standalone `/sdlc amend <specific changed constraint and remedy>`
comment only when a plan is already approved. Before the first approval, use
`/sdlc revise` to change the plan or recheck a repaired baseline. Eligible approval
conflicts can prepare an amendment automatically after unrelated ready work
finishes, provided no amendment is already pending and the trusted head is current.
The controller retains the source commit and task history, snapshots the target
default-branch commit and issue text, and asks Research for a versioned amendment.
Research cannot approve it. The displayed plan includes structured requirements,
repair permissions, dependency declarations, and a hash covering all of them.

Approve with `/sdlc approve-amendment vN`, or reject with
`/sdlc reject-amendment vN`. The requester or a writer may decide ordinary scope
changes. A writer is required for a trusted-baseline change, a baseline-repair
recovery, or an explicit integration resolution. Approval checks the exact
source, target baseline, workflow revision, issue snapshot, and proposal version.
A moved baseline or changed issue needs a fresh `/sdlc amend ...`; this replaces
the stale proposal with a higher version without losing source. Rejection does
not reset budgets or grant a legacy retry path.

A credential-limited `integrate` job computes a deterministic three-way tree
merge without executing candidate code. The controller independently recomputes
its hash and publishes only that tree to a new versioned feature branch without
force. An identical published commit is recovered after a lost acknowledgement.
Conflicting edits are not silently chosen. Research may propose at most ten
`planPolicy.integrationResolutions` with exact base/source/target blob SHAs and
replacement content. These require maintainer approval and may only resolve
actual conflicts in unprotected application files. Baseline tests, protected
paths, symlinks and unrelated edits are rejected. The entire plan-policy payload
is bounded to 16 KB, so larger conflicts require separate maintainer work.

After integration, decomposition revalidates the task graph and requirement-ID
coverage. Completed tasks survive only when the structured requirements and
their task definitions match exactly and their dependencies remain completed.
Legacy plans without structured requirements retain code but revalidate task
completion through new jobs. If every task is retained complete, decomposition
proceeds directly to scanning without another coding job. Every required final
gate runs on the new commit;
preflight, old passing evidence, and a successful integration are not substitutes.

### Dependency Preflight

`policy.preflight` is enabled in this repository. New intake and full revisions
scan the current baseline before research. Newly declared vendored dependencies
are staged in disposable scanner workspaces before feature implementation.
Only exact public npm package versions and `package/` archive members are
supported. Each file has an approved path, SHA-256 and runtime/types/license
role. Package scripts are disabled, subprocess credentials are not forwarded,
compressed input is bounded to 20 MB, individual extracted files to 512 KB, and
the normal aggregate change budget still applies.

CodeQL and secret scanning inspect the staged bytes with the normal policy.
The manifest audit still audits the lockfile; it does not pretend to inventory
vendored files. Up to three explicitly proposed dependency variants may be
preflighted in order. Human approval binds the alternatives and their pins.
If all fail and no patch permission was proposed, a new decision is required.

An explicit `vendorSecurityPatches` list can permit fixes only to named pinned
non-license files with a registered CodeQL finding. Before approval, the controller
holds the repair at the approval gate. After approval it registers a dependency-only
repair, records upstream and patched hashes, and requires an installed-byte rescan
before decomposition. Every later candidate scan verifies the original bytes or
current-plan patch provenance. Licenses, protected manifests and scanner policy
remain unchanged. This is bounded public-npm vendoring support, not permission
to fetch arbitrary URLs, install packages, omit a declaration, or waive findings.

### Baseline Maintenance

The `maintain` agent leaves the feature checkout unchanged and returns proposed
file replacements separately as `maintenanceChanges`. It cannot execute a modified
harness or create a PR. The controller displays a patch hash and bounded preview.
Review the full result artifact, not just a truncated preview, before issuing
`/sdlc propose-maintenance JOB HASH` as a repository writer.

That exact command durably authorizes only draft publication. The controller
verifies the baseline, hash, file ownership and regular-file types, then creates
or reuses `agentic/maintenance-JOB-HASHPREFIX` and its draft PR. It does not modify
the feature branch, approve reviews, change settings, or merge. Branch and PR
retries reuse the same identity after lost responses. Maintainers must inspect
the diff and required CI, then merge through normal rules. Some protected
workflow changes may exceed the App's permissions and require a direct maintainer
change instead; the system does not elevate credentials.

After merge, use a maintainer-requested scoped amendment to retain feature work.
If the defect was found before any approved plan exists, use full `/sdlc revise`
to recheck the repaired baseline and begin research. Existing issue #28 is not
automatically resumed by deploying these changes; its current scope and new
trusted revision still require the appropriate explicit decision.

### Cost Receipt Failures

A completed workflow can still have an unreadable or invalid `sdlc-cost`
receipt. Cost retrieval errors use the same retry classification as result
retrieval: transient errors retain the registered job until its
`jobTimeoutMinutes` deadline (90 minutes from job creation by default).
Recovered retrieval is charged once and continues normal result validation.

Malformed receipts and non-retryable download failures consume one worker
failure immediately; transient failures still occurring after the deadline do
the same. The controller clears that attempt without accepting its result and
registers a replacement in the same stage while the failure budget remains.
At `maxJobAttempts` consecutive failures (two by default), the lifecycle becomes
`blocked` instead of repeatedly reading the same bad receipt. The issue status
identifies the stage, job, bounded error detail, and run link.

Known totals are preserved and `spend.historyComplete` is set to `false` when
active-job cost collection is abandoned. Previously observed pending values are
settled once; no missing duration or credits are invented. This bounded worker
failure path handles thrown retrieval and validation errors. Explicit `null`
telemetry and costs of abandoned jobs use the independent path below.

Inspect the linked run and correct the cause before a manual `/sdlc retry`.
Do not rewrite the receipt as zero, lower validation gates, or use GitHub's
worker rerun button. Changes to protected controller code still require the
normal trusted-revision recovery process.

### Deferred Cost Collection

Before pause, cancellation, replanning, or replacement drops a dispatched,
uncosted job, the controller saves its compact identity in `pendingCosts` in
the same state write. Failed cancellation or a lost response cannot erase that
identity. Incomplete receipts are also retained there when an active stage
continues or advances. Pending values are excluded from aggregate totals and
shown as pending in status, not charged again on every read.

Scheduled, completion-event, and manual reconciliation use the job's original
workflow, actor, trusted revision, and first-attempt run ID, even after the
current plan changes. Abandoned running jobs receive cancellation retries.
Accounting runs before paused, blocked, cancelled, merged, and closed-issue
returns. It reads costs only, never old worker results, and cannot authorize
changes or satisfy a gate. Transient accounting API failures do not stop a
newer job or consume its infrastructure-failure budget.

The collection deadline is fixed at first deferral plus `jobTimeoutMinutes`
(90 minutes by default). Retries, resume, and revision do not extend it. A
complete receipt settles once; partial reads retain known credits, stop signals,
the largest observed runner duration, and an available original cap. Tally
updates and queue removal are one compare-and-swap state write. Failed writes
retry from persisted state; a committed write with a lost response is not charged
again on reload.

If telemetry is still incomplete after the deadline, or a lookup or receipt
fails permanently, automatic collection stops with an **Incomplete cost
accounting** comment. Only observed values are added and
`spend.historyComplete` becomes `false`; unavailable is never measured zero.
The comment retains the original job, commit, plan, and any run reference.
Check those records manually if further accounting is needed. Recovering another
receipt never clears an earlier incomplete-history warning. Turning
`SDLC_ENABLED` off also stops these reconciliation attempts until re-enabled.

### Blocked Scan Repairs

1. Read the stored failure and repair feedback, not just the most recent
  controller conclusion. A successful scheduled controller run can correctly
  leave an issue blocked after two consecutive worker failures.
2. For CodeQL, start with the rule, file, line, and severity in the repair
  feedback. If they are unavailable, inspect the linked scan's validator step
  and `sdlc-codeql` SARIF artifact. A missing report is not a clean scan. Test
  files are scanned too, so a newly added test can trigger a repair even when
  the preceding source-only scan passed. Fix the reported code without
  suppressing rules or lowering thresholds.
3. If the repair worker failed without a result, inspect its `agent` and
  `sdlc-cost` artifacts. Compare recorded inference usage and proxy failures
  with the per-run cap before changing authentication or billing. The compiler
  can report HTTP 403 as authentication failure without setting the
  pre-emption flag. Do not raise limits or repeatedly retry without a diagnosis.
4. For a legacy or eligible infrastructure block, when the cause is resolved under the same approved scope and trusted revision,
  a writer can post a new standalone `/sdlc retry` comment. This resumes the
  stored phase with the same feedback, clears consecutive worker failures, and
  retains job and repair counters. Ordinary comments do not update job feedback,
  and GitHub's worker rerun button does not create an acceptable replacement.
5. If the fix changes protected controller code or workflows, deploy it through
  human review, then use a maintainer `/sdlc amend <specific findings and recovery scope>`
  and approve the exact amendment to retain source. Full `/sdlc revise` remains
  available when starting over is intended. Retry
  cannot bypass the trusted-revision check or automatically refresh old feedback.
