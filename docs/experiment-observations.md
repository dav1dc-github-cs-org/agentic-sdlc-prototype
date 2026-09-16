# Experiment Observations

What this prototype has actually demonstrated, what it has not, and what the
evidence cost to obtain. Every figure here is measured from this repository's own
runs rather than estimated. Where a claim is inferred rather than observed, it
says so.

This is a record of an experiment in progress, not a recommendation.

## What has run so far

| Lifecycle | Outcome | Plans | Jobs | Repairs |
| --- | --- | --- | --- | --- |
| Issue #1, multi-timezone clocks | Cancelled at `pr_open`; PR #18 left open | 5 | 34 | 2 of 2 |
| Issue #19, turtle graphics | In progress, still `decomposing` | 2 | 13 | 1 of 2 |

Issue #1 reached a published pull request of 391 lines across 8 files, having
passed every gate. It was then cancelled rather than merged. One complete
traversal of the lifecycle is therefore demonstrated; a merged feature is not.

## Learnings

### An opaque gate is the most expensive failure mode found

The CodeQL gate originally reported only `CodeQL found N blocking or unclassified
findings`. No rule, no path, no line. A coding agent receiving that feedback
cannot act on it, and the observed behaviour was a blind search that consumed
repair rounds and eventually exhausted the credit budget for the run.

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

Two of the three findings across the period were false positives, both cheap to
reshape. A roughly one-in-three true positive rate on security-severity 7 or
above is a reasonable argument for keeping the threshold as a hard block.

### Refusal is a feature, and it worked

A revision asked the agents to add Playwright screenshot capture. That request
contradicted the issue's own stated constraints, because `package.json` is a
protected path and the non-goals excluded browser tooling. The research agent
refused, explained which constraints conflicted, asked three specific questions,
and changed nothing.

An agent that fabricates compliance is far more dangerous than one that stops.
This behaviour should be protected in any future prompt changes.

### Cost is front-loaded, non-linear, and larger than it appears

Issue #19 has consumed 978.5 AI credits and 96.2 runner minutes across 12 runs
**before implementation began**. It is still decomposing.

A point-in-time measurement of issue #1's first 30 agent runs recorded 1,356.2
credits, 466,487 agent tokens, and 3.6 hours. Two observations follow:

- Planning and replanning, not coding, dominated spend in both lifecycles.
- The headline token figure excludes gh-aw's threat-detection pass, which
  consumed 371,400 input tokens against the agent's 171,562. Roughly half of all
  token traffic is the injection scan re-reading agent output.

Three of issue #19's twelve runs finished near the then-configured 200-credit per-run cap. That
rate suggests the cap is close to the working size of these prompts rather than a
distant safety net.

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
renames it, the expression evaluates empty and every run is recorded as never
pre-empted — a silent failure producing confidently wrong data.

A test asserts the identifier still exists in the lockfile, so an upgrade fails CI
rather than corrupting the metric. The coupling remains.

### Pre-emption detection is still unvalidated

Issue #19 records `preempted: 0` across 12 runs, while a commit exists describing
a run that exhausted the credit budget. Either the exhaustion predates the
accounting, or the detection did not fire. **The positive path has never been
observed in production.** Until a run is deliberately forced over a lowered cap
and the flag is seen to flip, this metric should not be trusted.

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
while describing work the agent was interrupted part-way through is **accepted
normally** — the phase advances, evidence is recorded against the head commit,
and the lifecycle proceeds toward publication.

That third case is also the most likely one, because the cap is applied between
inferences rather than mid-request. The agent is stopped at a boundary where it
has probably already written a well-formed file.

The consequence is that a feature can reach a pull request carrying work that was
cut short, despite the new warning comment. The Security profile now requires
explicit review coverage and provisional blocked checkpoints, but that is model
guidance, not independent proof that a final pass means the review was complete.

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
2. Is roughly 1,000 credits of planning before implementation inherent to the
   approach, or an artefact of prompt size and replanning churn?
3. Does the repair budget of two rounds fit the work? Issue #1 succeeded on its
   last available attempt, which is not reassuring.
4. What is the merged-feature quality? PR #18 passed every gate and was cancelled
   rather than merged, so the most important question — is the output good — is
   still unanswered.
