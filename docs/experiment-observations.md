# Experiment Observations

What this prototype has actually demonstrated, what it has not, and what the
evidence cost to obtain. Every figure here is measured from this repository's own
runs rather than estimated. Where a claim is inferred rather than observed, it
says so.

This is a record of an experiment in progress, not a recommendation.

Evidence reviewed on 2026-09-16. Historical measurements and setup observations
below retain their original scope; they are not refreshed live accounting or
repository-setting snapshots.

## What has run so far

The retained run inventory includes 34 lifecycle jobs for issue #1 and 31 for
issue #19, across all plan versions and agent/check stages. A later inspection
on the same date also captured the first research job for issue #27.

| Lifecycle | Latest recorded evidence | Jobs observed |
| --- | --- | --- |
| Issue #1, multi-timezone clocks | Cancelled at `pr_open`; PR #18 left open at the earlier checkpoint | 34 |
| Issue #19, turtle graphics | [Final review, job 19-31](https://github.com/dav1dc-github-cs-org/agentic-sdlc-prototype/actions/runs/34885277394), passed on 2026-09-14 | 31 |
| Issue #27, portable chess | [Research, job 27-1](https://github.com/dav1dc-github-cs-org/agentic-sdlc-prototype/actions/runs/35151310739), returned `blocked` on 2026-09-16 | 1 |

The earlier checkpoint recorded five plans and two of two repair rounds for
issue #1, and two plans, 13 jobs, and one of two repair rounds for issue #19.
Those counters remain historical measurements, not refreshed totals. Issue #19
was replanning at that checkpoint; it is no longer accurately described by the
old `decomposing` snapshot. The later review result does not establish current
PR state or a merge, neither of which was rechecked for this update.

Issue #1 reached a published pull request of 391 lines across 8 files, having
passed every gate. At the recorded checkpoint, its lifecycle was cancelled
rather than merged. A traversal through PR publication is therefore demonstrated;
the inspected evidence does not establish a merged feature.

## Learnings

### An opaque gate is the most expensive failure mode found

The CodeQL gate originally reported only `CodeQL found N blocking or unclassified
findings`. No rule, no path, no line. A coding agent receiving that feedback
cannot act on it, and the observed behaviour was a blind search that consumed
repair attempts and credits before stopping without a result. The provider
errors and near-cap usage do not alone establish credit-limit pre-emption.

The fix propagates rule identifier, file, line, and severity through the check
job's output into the agent's feedback. This is the single highest-value change
made to the system so far, and it cost nothing in gate strength.

The generalisation is worth stating plainly: **a gate that rejects without
actionable diagnostics converts a cheap fix into an expensive search.** When a
human hit the same gate, they could download the SARIF artifact and read it in a
minute. The agent had no equivalent recourse and paid for the difference in
credits.

### Deterministic gates caught what agent review did not

CodeQL found a genuine time-of-check-to-time-of-use defect in `collectChanges`,
the function that ingests untrusted agent output. That is precisely the code
where the defect mattered most. It was found by a scanner, not by the security
agent or the review agent.

Two of the three findings in the initial baseline scans were treated as false
positives, both in test assertions. Later candidate scans found additional URL
assertion issues, so that historical ratio is not a measure of all runs. The
genuine file-race finding demonstrates the value of an independent scanner;
this small sample does not establish a general true-positive rate.

### Refusal is a feature, and it worked

A revision asked the agents to add Playwright screenshot capture. That request
contradicted the issue's own stated constraints, because `package.json` is a
protected path and the non-goals excluded browser tooling. The research agent
refused, explained which constraints conflicted, asked three specific questions,
and changed nothing.

An agent that fabricates compliance is far more dangerous than one that stops.
This behaviour should be protected in any future prompt changes.

### Missing capabilities need a maintainer-approved handoff

Issue #27 exposed a different kind of stop. Its
[research workflow](https://github.com/dav1dc-github-cs-org/agentic-sdlc-prototype/actions/runs/35151310739)
completed successfully, but the report returned `blocked`. The
[inspected lifecycle status](https://github.com/dav1dc-github-cs-org/agentic-sdlc-prototype/issues/27#issuecomment-5704612276)
recorded one job, no coding tasks, and no approval-ready plan. It used 75.9 AI
credits against a captured 300-credit limit and 8.7 runner minutes. This was an
explicit capability block, not a hung run or a reported budget exhaustion.

The chess specification requires a rules library, a local opponent engine,
self-contained browser packaging, and real-browser validation. The repository
had none of that tooling installed, and the necessary dependency manifests and
validation configuration were protected from feature-job edits. The
[specification](chess-game-feature.md#research-and-maintainer-prerequisites)
already identified those prerequisites. Research correctly stopped instead of
inventing an executable plan or claiming unsupported browser evidence.

**A detailed feature specification does not make the pipeline capable of building
it.** Product suitability and pipeline readiness are separate decisions. The
controller can surface a prerequisite request, but it has no automated process
for getting that request approved and installed. Plan approval does not grant
agents authority to change their own toolchain or gates; an unchanged retry or
a larger inference budget cannot supply the missing capabilities.

The report also overstated some restrictions. `sourcePaths` controls coverage
inclusion, not a coding-stage edit allowlist, and browser execution does not
inherently require additional GitHub permissions. The actual blockers were
missing approved dependencies and build/test integration, not a need to widen
all source-path or token permissions. Blocked reports still need factual review.

The proposed response is a maintainer-reviewed web-app foundation: pin suitable
rules and search dependencies, review engine redistribution obligations, build
one portable release, and add browser checks to the existing unprivileged SDLC
validation job. Extending `npm run verify` alone is insufficient because the
[hosted validator](../src/validate.ts) invokes the Node test suite directly.
Generated engine binaries should remain build artifacts, not exceptions to the
text-only proposal collector. Existing coverage and security gates must remain.

After those prerequisites are reviewed and landed, `/sdlc revise` and fresh
plan approval can resume normal execution against the new trusted revision.
That foundation and recovery had not been implemented or exercised at this
checkpoint. Whether a reusable prerequisite process reduces future blocked
research cycles remains to be demonstrated.

### Cumulative cost does not identify which phase spent it

An earlier issue #19 checkpoint recorded 978.5 AI credits and 96.2 runner
minutes across 12 runs, before job 19-13. That checkpoint was during replanning,
not before the first implementation. The
[engine job 19-3](https://github.com/dav1dc-github-cs-org/agentic-sdlc-prototype/actions/runs/34664319966)
and [UI job 19-4](https://github.com/dav1dc-github-cs-org/agentic-sdlc-prototype/actions/runs/34664678733)
had already implemented code on 2026-09-12. The cumulative total includes
earlier implementation and failed repairs as well as planning.

A point-in-time measurement of issue #1's first 30 agent runs recorded 1,356.2
credits, 466,487 agent tokens, and 3.6 hours. Two observations follow:

- Replanning preserves cumulative costs. The phase at the measurement time
   cannot establish which earlier stages dominated spend in either lifecycle.
- The headline token figure excludes gh-aw's threat-detection pass, which
  consumed 371,400 input tokens against the agent's 171,562. Roughly half of all
  token traffic is the injection scan re-reading agent output.

Three runs in issue #19's original twelve-run snapshot finished near the
then-configured 200-credit per-run cap. Near-cap usage is not itself proof that
the limiter stopped a run.

Subsequent runs can use `SDLC_AIC_CREDIT_LIMIT` (default 250) to tune that limit
without recompilation; the measurements above retain their original limits.

### Silent misconfiguration was the dominant setup failure

Every configuration defect found during setup failed silently rather than loudly:

| Defect | Symptom if undetected |
| --- | --- |
| `SDLC_APP_SLUG` mismatch | Every dispatched worker skips its own actor gate; lifecycle stalls with no failed run |
| `CODEOWNERS` absent | `require_code_owner_review` is configured but inert |
| Private App transferred to an org | Token minting fails for a user-owned repository |
| `sdlc-agent` environment missing a branch policy | Environment auto-created without the restriction it exists to provide |

The controller now fails loudly on the first of these. The general lesson is that
a setup checklist is insufficient; the verification pass added to
[operations](operations.md) exists because the checklist was followed correctly
and the system still did not work.

### Documentation rots in one specific place

Of seven architecture diagrams, four went stale across two changes. The two
purely structural diagrams needed nothing. Every stale item was a **rule stated in
an edge label or a sequence step** — "default-branch revision changed", "code or
testing stage proposes changes".

Structure ages well. Rules embedded in diagram labels age silently, because the
diagram that states a rule is rarely the diagram that looks relevant to the change.

### The type system and schemas caught more than review did

Adding one lifecycle stage was rejected in sequence by the exhaustive
`Record<Stage, Phase>`, then independently by the Zod phase enum that validates
persisted state, then by a protected-path check that fired before the stage
permission it was meant to test. Three independent guards, three genuine catches,
before any test assertion ran.

## Risks

### Reviewers are correlated

Every agent stage used the same model in the initial experiment: across 30
agent runs spanning research, decomposition, coding, security, testing, and
review, the distinct model set was exactly `claude-sonnet-5`.

The independence in the design is independence of *context* — fresh sessions,
separate roles, no shared reasoning. It is not independence of *judgement*. A
characteristic blind spot is present in the author and in all of its reviewers
simultaneously. The non-LLM gates are currently the only uncorrelated reviewer,
which is why they are doing disproportionate work.

`SDLC_MODEL` now parameterises the model and defaults to `auto`. Sharing that
selector does not guarantee identical resolved models. New cost receipts capture
observed primary-agent model IDs, surfaced in lifecycle status and the final PR's
Cost section. This makes the risk visible without claiming review diversity or
reconstructing missing historical telemetry.

### Baseline debt blocks the pipeline systemically

CodeQL analyses the whole tree, `CI / Verify` does not run it, and agents cannot
edit protected paths. A pre-existing finding in controller code is therefore an
unwinnable loop: the agent is blocked by something it has no permission to fix,
and burns repair budget discovering that.

This was observed, not theorised. Two baseline findings blocked every agent run
until a human fixed them directly on the default branch. The structural cause is
self-hosting; see [Packaging](#packaging).

### Cost accounting depends on a compiler internal

Pre-emption detection reads `steps.parse-mcp-gateway.outputs.ai_credits_rate_limit_error`.
That step identifier is a gh-aw implementation detail. If a compiler upgrade
renames it, the expression evaluates empty. The current workflow records an
absent stop signal as `null`, not `false`. The controller warns about unavailable
telemetry, retains it for bounded collection, and marks cost history incomplete
if it cannot recover the signal. Missing data does not establish that a run was
never pre-empted.

A test asserts the identifier still exists in the lockfile, so an upgrade fails CI
when that identifier changes. The coupling remains, and preserving `null` does
not prove that an explicit `false` signal is accurate.

### Pre-emption detection is still unvalidated

The earlier issue #19 snapshot recorded zero pre-emptions across 12 runs.
Retained receipts for
[repair 19-10](https://github.com/dav1dc-github-cs-org/agentic-sdlc-prototype/actions/runs/34667071711)
and [repair 19-11](https://github.com/dav1dc-github-cs-org/agentic-sdlc-prototype/actions/runs/34667678511)
report 202.1 and 201.7 credits respectively, both with `preempted: false`.
Both attempts ended with provider HTTP 403 and no result artifact. Neither that
status nor the credit total establishes the stop cause. The inspected evidence
does not validate the positive pre-emption signal; a separately authorized,
controlled limit test is still needed.

### Pre-emption is not an acceptance gate

`spend.preempted` reaches the issue status comment and the pull request body but
does not gate acceptance. Per-attempt diagnostics now also flag workflow-reported
pre-emption and unknown usage, and failed Security attempts can expose their
last validated checkpoint. Those comments are diagnostic, not passing evidence.
Missing telemetry is now distinguished from measured zero or an explicit false
signal. These changes improve visibility; they are not a live validation of the
positive pre-emption signal.

When the limiter stops a run, three things can happen to its output. Two are
already safe: if no `result.json` was written the upload fails and the controller
counts an infrastructure failure, and if the file is truncated the schema
rejects it. The third is not. A structurally valid result that reports `pass`
from a **successful agent workflow** can still be accepted despite incomplete
work or a pre-emption warning, provided it passes the other acceptance checks.
Failed agent workflows remain rejected even if they upload a valid `pass` report.

The cap is applied between inferences rather than mid-request, so a well-formed
file may already exist when work stops. File validity alone is not proof of
completed work; the inspected evidence does not establish how often this occurs.

The consequence is that a feature can reach a pull request carrying work that was
cut short, despite the warning comment. The Coding and Security profiles now
require explicit evidence, outstanding work, and provisional blocked checkpoints,
but that is model guidance, not independent proof that a final pass means the
assigned work was complete.

The cheapest mitigation is to treat a pre-empted run as not-pass regardless of
the outcome it reports. Pre-emption is the one case where the harness knows more
about completeness than the agent does: the agent cannot know which inference it
was denied.

That change should wait on the validation gap above. Gating a lifecycle on a
signal that has never been observed to fire would risk blocking every run on a
flag stuck at the wrong value. Force the flag first, then gate on it.

### Human bypass weakens what the experiment demonstrates

The default-branch ruleset requires pull requests, `CI / Verify`, and review, but
one human account holds an `always` bypass. Every controller change in this
period was pushed directly to the default branch. That is pragmatic for setup and
it is how the protected paths must be edited, but it means the governance model
has not itself been exercised.

### Remaining scope limits

Single repository. Node.js and TypeScript only. Sequential execution within a
lifecycle. Public repository, so anyone may open an issue and any comment
triggers a controller run — authorisation is enforced, but the compute is not
gated.

## Packaging

The controller develops features in the repository that contains the controller,
so the candidate checkout includes the harness. Three consequences have all been
observed rather than predicted:

1. Defects in controller code are reported as feature-gate failures. A finding in
   `worker.ts` blocked work on a clock-face renderer that could not possibly have
   caused it.
2. Agents cannot clear those findings, because the files are protected. The loop
   is unwinnable, and the budget is spent discovering that rather than fixing
   anything.
3. Coverage baselines and the `sourcePaths` and `testPaths` policy describe the
   controller rather than an application, so an adopting repository inherits
   settings written for something else.

The sharpest form of the problem is an asymmetry in where scanning happens.
CodeQL runs **only** in the candidate context, where nobody is permitted to act on
harness findings, and **never** in `CI / Verify`, where a human could. Controller
code is therefore scanned at exactly the moment it cannot be fixed.

### Options

**Scope the candidate scan to what the candidate can change.** Agents cannot
modify protected paths, so findings there carry no information about the work
being assessed. Moving harness scanning into CI would raise its coverage from
none to complete while removing noise from the feature gate. The honest cost is
that a harness vulnerability would no longer block feature publication — though
today it does not meaningfully block it either, it merely stalls the lifecycle
until a human intervenes.

**Block only on new findings.** Diff the candidate SARIF against a scan of
`baseSha` and fail on findings the candidate introduced. This addresses the
general class, including pre-existing debt in ordinary application code, not just
the harness. It costs a second CodeQL run per validation and requires stable
fingerprint matching across commits.

**Move the controller out of the candidate tree.** The runtime already models
this separation: every worker checks out `control` at the trusted revision and
`source` at the candidate commit as two independent directories. Only the
repository layout conflates them. Publishing the controller as a versioned
package or reusable workflow would make the trust boundary a version pin rather
than a path glob, remove harness code from the candidate scan entirely, and let
coverage thresholds and path policy describe the application being built.

### The tension worth preserving

Self-hosting is what surfaced the time-of-check-to-time-of-use defect in the
first place. Had the controller been an installed dependency, nothing in this
experiment would have scanned it. Any packaged form needs its own pipeline with
its own gates, or that class of defect simply stops being examined.

The ordering that follows from the evidence is: scan the harness in CI now,
because it is currently unscanned where it can be fixed; adopt new-findings-only
diffing next, because it solves the general case; and treat extraction into a
package as the eventual shape rather than an immediate step, since the runtime
already separates the two and the repository layout is the last thing to catch up.

## Assumptions

These are load-bearing and currently unverified or only partially verified:

- gh-aw internal step identifiers remain stable at the pinned compiler version.
- Copilot's `auto` model routing remains stable enough that stage behaviour does
  not drift between runs without a configuration change.
- Summed job duration is an acceptable proxy for cost. Public repositories report
  zero billable minutes, so this is the only available measure and it is not what
  GitHub would bill.
- `security-severity >= 7` is the right blocking threshold. It was chosen before
  any evidence existed; the observed true-positive rate now weakly supports it.
- The 80% near-limit ratio is arbitrary and has no evidence behind it.
- Threat detection catches prompt injection in agent output. Never tested
  adversarially here.
- Agent-reported outcomes are honest. Partially mitigated: the controller
  validates provenance, paths, and budgets, and cost is measured by the workflow
  rather than self-reported.

## Open questions

1. Would a different model at the `security` and `review` stages catch defects
   the author's own model produces? Currently unknowable.
2. How much cumulative spend belongs to planning, implementation, and repairs,
   and how much could be avoided by reducing replanning churn?
3. Does the repair budget of two rounds fit the work? Issue #1 succeeded on its
   last available attempt, which is not reassuring.
4. What is the merged-feature quality? PR #18 passed every gate and was cancelled
   rather than merged, so the most important question — is the output good — is
   still unanswered.
