# Agentic SDLC Architecture

This document describes the implemented process from an `agentic-SDLC` issue
through baseline and dependency preflight, research, human plan approval, task execution, security, testing,
independent review, and final PR publication. The controller makes lifecycle
decisions deterministically; agents propose plans, code, and assessments.

The scope is one GitHub repository, Node.js/TypeScript, and sequential coding
tasks. The diagrams describe implementation behavior, not proof of a successful
live deployment. See [operations.md](operations.md) for activation, credentials,
branch protection, and the first live pilot.

## Diagram Guide

- [Application Architecture](#application-architecture): services and trust zones.
- [Detailed Process Flow](#detailed-process-flow): the complete feature lifecycle.
- [Approval Conversation](#approval-conversation): requester decisions and revisions.
- [Worker Handoff](#worker-handoff): dispatch, artifacts, and result acceptance.
- [Security and Testing](#security-and-testing): deterministic gate execution.
- [Recovery Flow](#recovery-flow): pauses, repairs, retries, and cancellation.
- [Component Relationships](#component-relationships): implementation ownership.
- [State and Evidence](#state-and-evidence): durable records and publication rules.

Solid arrows show control or data flow. Dotted arrows show credentials or
supporting context. A gate's outgoing edge labels state the decision; agents
cannot choose an unauthorized transition merely by requesting it.

## Application Architecture

Everything runs through GitHub Actions and GitHub APIs. There is no locally
hosted controller, separate webhook receiver, database server, or message broker.

<!-- mermaid-checked: safe quoted labels, unique IDs, closed subgraphs -->
```mermaid
flowchart TD
    subgraph ArchInterface["GitHub interaction"]
        ArchIssue["Epic issue, label, and human comments"]
        ArchEvents["Issue events, completion events, schedule"]
    end
    subgraph ArchControl["Trusted sdlc-controller environment"]
        ArchApp["Scoped GitHub App installation token"]
        ArchController["Deterministic controller on Actions"]
    end
    subgraph ArchExecution["Separate hosted worker jobs"]
      ArchBudget["Validate and snapshot repository AI credit limit"]
        ArchAgent["Fresh Copilot role worker in sdlc-agent"]
        ArchChecks["Scanner, test, and integration jobs without App credentials"]
        ArchInference["Copilot inference service"]
        ArchContext["Repository and allowlisted documentation"]
    end
    subgraph ArchRecords["GitHub records and outputs"]
        ArchState[("Protected lifecycle, recovery, approvals, costs and usage")]
        ArchArtifacts[("Actions result, evidence, and cost artifacts")]
        ArchBranch[("Versioned feature branch")]
        ArchTasks["Native sub-issues and dependencies"]
        ArchPR["Final PR, advisory review, completion check"]
        ArchMaintenance["Explicitly authorized draft maintenance PR"]
    end
    ArchIssue --> ArchEvents
    ArchEvents -->|"Reconcile current state"| ArchController
    ArchApp -.->|"Repository-scoped write authority"| ArchController
    ArchController -->|"Read and checkpoint"| ArchState
    ArchController -->|"Create and link tasks"| ArchTasks
    ArchController -->|"Explicit agent workflow dispatch"| ArchBudget
    ArchBudget -->|"Validated per-inference-job cap"| ArchAgent
    ArchController -->|"Explicit workflow dispatch"| ArchChecks
    ArchAgent -->|"Inference requests"| ArchInference
    ArchContext -.->|"Untrusted input"| ArchAgent
    ArchAgent -->|"Reports and proposed text changes"| ArchArtifacts
    ArchChecks -->|"Check results and supporting evidence"| ArchArtifacts
    ArchArtifacts -->|"Download and validate"| ArchController
    ArchController -->|"Publish accepted changes or approved integration"| ArchBranch
    ArchController -->|"Only after all required gates"| ArchPR
    ArchController -->|"Exact maintainer patch-hash command only"| ArchMaintenance
    ArchController -->|"Plans and progress"| ArchIssue
```

### Technology Stack

| Layer | Technology | Version | Purpose |
| --- | --- | --- | --- |
| Control | Node.js | 24.8+ | Run the controller and validators |
| Source | TypeScript | Pinned | Model state and API contracts |
| Agents | gh-aw and Copilot | gh-aw v0.88.7 | Compile and run role workers |
| API | Octokit | Pinned | Access GitHub REST APIs |
| Contracts | Zod | Pinned | Validate state and worker reports |
| Evidence | Actions artifacts | Managed | Transfer reports between runs |
| Security | CodeQL, npm audit, Gitleaks | Pinned where applicable | Scan code |
| Testing | Node test runner and c8 | Pinned where applicable | Test and cover |

State and source changes are stored in separate Git branches. GitHub Issues
provides the human interface, while Actions artifacts carry worker output.
Copilot inference, npm advisories, and allowlisted documentation are external
dependencies; unavailable services do not automatically waive a gate.

### Key Decisions

- **Separate reasoning from authority.** Workers have read-only repository
  access. Only the controller receives the App token used for publishing.
- **Keep state outside the conversation.** Versioned JSON is authoritative;
  comments are commands, proposed-plan displays, or progress projections.
- **Publish the feature PR last.** Intermediate work lives on a feature branch.
  A separate baseline-maintenance draft requires an explicit maintainer command;
  neither PR is approved or merged by an agent.

The hosted agent runtime uses sandbox containers. Local development and
documentation rendering do not require Docker. Deterministic check jobs are
separate Actions jobs, not additional Copilot agents.

## Detailed Process Flow

The labels `researching`, `awaiting_approval`, and so on are persisted lifecycle
phases. Transitions below assume the worker result has passed the acceptance
checks described in [Worker Handoff](#worker-handoff).

The [Research profile](../.github/agents/research.agent.md) requires a Technology
and Architecture Decision in proposed plans. It separates the application's
baseline from controller tooling, compares product-fit options, recommends
components and data flow, and independently assesses pipeline support and
maintainer prerequisites. Unsupported implementation or validation requires a
structured blocker with actionable diagnostics and remedies rather than an
executable plan with unapproved prerequisites. Optional structured plan policy
binds requirement IDs, task-splitting permission, dependency pins and exact
vendor-patch permissions into the plan hash. These fields constrain authority,
not the truth of model reasoning. Human review and deterministic validation
remain necessary. The pipeline still targets Node.js/TypeScript.

<!-- mermaid-checked: safe quoted labels, unique IDs, closed subgraphs -->
```mermaid
flowchart TD
    ProcIntake["Open issue carrying agentic-SDLC"]
    ProcAuthorize["Labeled-event sender is a human repository writer"]
    ProcIgnore["Ignore unauthorized intake"]
    ProcInitialize["Bind event request snapshot and default-branch revision"]
    ProcBaseline["preflighting: scan baseline before inference"]
    subgraph ProcPlanning["Research and human approval"]
        ProcResearch["researching: inspect context and propose plan"]
        ProcPlan["Version and hash the accepted plan proposal"]
        ProcDependencies["Preflight declared dependency artifacts when needed"]
        ProcWait["awaiting_approval: end run and wait"]
        ProcRevise["Retire old tasks and clear approval and evidence"]
        ProcReject["Reject stale or invalid approval"]
    end
    subgraph ProcImplementation["Bounded sequential implementation"]
        ProcDecompose["decomposing: propose tasks and dependencies"]
        ProcVendor["Approved dependency-only repair and rescan when needed"]
        ProcGraph["Validate task count, IDs, and acyclic graph"]
        ProcLink["Create or reuse sub-issues and dependency links"]
        ProcSelect["Select ready task or repair-only job"]
        ProcCode["coding: implement within the approved plan"]
        ProcApply["Validate and publish any proposed file changes"]
        ProcProgress["Mark assigned task or execution step implemented"]
    end
    subgraph ProcQuality["Current-commit quality gates"]
        ProcScan["scanning: CodeQL, dependency audit, secrets"]
        ProcSecurity["security: independent agent assessment"]
        ProcPrepared["Test preparation already covers this commit"]
        ProcTest["testing: add or evaluate independent tests"]
        ProcTestChanges["Testing agent proposed file changes"]
        ProcPublishTests["Publish tests and invalidate older evidence"]
        ProcValidate["validating: execute tests and measure coverage"]
        ProcDocument["documenting: reconcile docs with verified behaviour"]
        ProcDocChanges["Documentation agent proposed file changes"]
        ProcReview["reviewing: assess full feature and evidence"]
    end
    ProcRepair["Verify blocker and choose bounded recovery"]
    ProcContinue["Resume the registered stage within its budget"]
    ProcDecision["Amendment or maintenance proposal: see Recovery Flow"]
    ProcBlocked["blocked: human intervention required"]
    ProcPublish["publishing: enforce final publication conditions"]
    ProcPR["pr_open: final PR, cost snapshot, review and check"]
    ProcHuman["Normal PR CI, configured rules, human review"]
    ProcMerged["merged: reconcile and close child tasks"]
    ProcCancelled["cancelled: PR closed without merge"]

    ProcIntake --> ProcAuthorize
    ProcAuthorize -->|"No"| ProcIgnore
    ProcAuthorize -->|"Yes"| ProcInitialize
    ProcInitialize --> ProcBaseline -->|"Pass"| ProcResearch --> ProcPlan --> ProcDependencies --> ProcWait
    ProcBaseline -->|"Finding or incomplete check"| ProcRepair
    ProcDependencies -->|"No permitted remedy"| ProcRepair
    ProcWait -->|"Revision command"| ProcRevise --> ProcBaseline
    ProcWait -->|"Invalid approval"| ProcReject --> ProcWait
    ProcWait -->|"Exact version approved by authorized human"| ProcVendor --> ProcDecompose
    ProcDecompose --> ProcGraph --> ProcLink
    ProcLink -->|"Ready tasks remain"| ProcSelect
    ProcLink -->|"All tasks retained complete"| ProcScan
    ProcSelect --> ProcCode --> ProcApply --> ProcProgress
    ProcProgress -->|"More ready tasks or steps"| ProcSelect
    ProcProgress -->|"All tasks implemented"| ProcScan
    ProcProgress -->|"Remaining tasks await a decision"| ProcRepair
    ProcScan -->|"Pass"| ProcSecurity
    ProcSecurity -->|"Pass"| ProcPrepared
    ProcPrepared -->|"No"| ProcTest
    ProcPrepared -->|"Yes"| ProcValidate
    ProcTest -->|"Pass"| ProcTestChanges
    ProcTestChanges -->|"Yes"| ProcPublishTests --> ProcScan
    ProcTestChanges -->|"No"| ProcValidate
    ProcValidate -->|"Pass"| ProcDocument
    ProcDocument -->|"Pass"| ProcDocChanges
    ProcDocChanges -->|"Yes"| ProcScan
    ProcDocChanges -->|"No"| ProcReview
    ProcReview -->|"Pass"| ProcPublish
    ProcScan -->|"Non-passing report"| ProcRepair
    ProcSecurity -->|"Non-passing report"| ProcRepair
    ProcTest -->|"Non-passing report"| ProcRepair
    ProcValidate -->|"Non-passing report"| ProcRepair
    ProcDocument -->|"Non-passing report"| ProcRepair
    ProcReview -->|"Non-passing report"| ProcRepair
    ProcCode -->|"Structured incomplete work or conflict"| ProcRepair
    ProcRepair -->|"Permitted coding repair"| ProcSelect
    ProcRepair -->|"Eligible retry or continuation"| ProcContinue
    ProcRepair -->|"Task-local wait with unrelated ready work"| ProcSelect
    ProcRepair -->|"Eligible approval or baseline conflict"| ProcDecision
    ProcRepair -->|"No authorized recovery within budget"| ProcBlocked
    ProcPublish -->|"Missing prerequisites"| ProcBlocked
    ProcPublish -->|"All prerequisites satisfied"| ProcPR --> ProcHuman
    ProcHuman -->|"Human merges"| ProcMerged
    ProcHuman -->|"Closed without merging"| ProcCancelled
```

Important details behind the diagram:

1. A lifecycle is created once per issue. Relabeling or reopening does not
   restart a permanently cancelled lifecycle.
2. Task selection uses the first incomplete, unblocked task whose dependencies
  are all implemented. Approved execution steps preserve its original criteria.
  There is one registered active job per lifecycle, even when multiple tasks
  are independent. After an amendment, retaining every completed task skips
  coding and proceeds directly to scanning; it does not reuse old gate evidence.
3. The controller records a testing-stage result on the commit containing the
   accepted tests. It then reruns scanning and security, preserving that new
   test-preparation evidence so testing does not loop indefinitely.
4. Any subsequent code change clears earlier evidence. Repair feedback also
   clears evidence, even when a repair later produces no file changes.
5. Tasks marked implemented in state remain open as GitHub issues until merge.
   The final PR contains `Closes #<epic-number>`; GitHub handles epic closure
   on merge to its default branch, and reconciliation closes child tasks.
6. Invalid output, missing artifacts, pauses, and scope drift follow the
  separate [Recovery Flow](#recovery-flow), not an unconditional success edge.
  `ProcContinue` returns to the registered phase, not necessarily coding:
  incomplete Security resumes Security, Testing resumes Testing, and so on.
  Approved splits resume the next registered coding step. Proposal nodes may
  wait for authority; a task-local wait can leave unrelated ready tasks running.
7. Pending cost reconciliation is independent of these phases. It may continue
  after cancellation or merge but never authorizes a worker result or new work.

## Approval Conversation

Approval is an issue-comment protocol, not a model-generated decision and not
a runner waiting for keyboard input. Each event starts a short controller run.

<!-- mermaid-checked: quoted participant aliases, closed conditional blocks -->
```mermaid
sequenceDiagram
  participant ApHuman as "Requester or repository writer"
  participant ApIssue as "Epic issue"
  participant ApControl as "Controller runs"
  participant ApState as "State branch"
  participant ApWorker as "Research worker"
  participant ApChecks as "Read-only preflight and integration jobs"

  ApHuman->>ApIssue: Describe the feature and have a writer apply the label
  ApIssue-)ApControl: Issue event
  ApControl->>ApControl: Verify label-event sender and bind its issue snapshot
  ApControl->>ApState: Persist baseline preflight and registered scan job
  ApControl-)ApChecks: Scan the bound baseline before inference
  ApChecks-->>ApControl: Current registered scan result
  ApControl->>ApState: On success register research
  ApControl-)ApWorker: Dispatch the registered job
  ApWorker-->>ApControl: Artifact and completion event through GitHub
  ApControl->>ApControl: Validate result, version and hash proposed plan
  ApControl->>ApState: Persist proposed plan before any dependency preflight
    opt Newly declared dependency artifacts
  ApControl-)ApChecks: Hash-check and scan declared artifacts with required policy
  ApChecks-->>ApControl: Pass, bounded alternative, or explicit repair decision
    end
  ApControl->>ApState: When eligible persist awaiting_approval
  ApControl->>ApIssue: Display plan, hash, and approval command
  Note over ApControl,ApState: Run ends with no runner waiting

    alt Human requests a different approach
    ApHuman->>ApIssue: New /sdlc revise feedback comment
    ApIssue-)ApControl: New comment event
    ApControl->>ApState: Retain unsettled cost identity, clear approval and active job, snapshot scope
      opt Superseded worker is still running
    ApControl-)ApWorker: Request cancellation without accepting old results
      end
    ApControl->>ApIssue: Retire superseded task issues
    ApControl-)ApChecks: Recheck the revised baseline
    ApControl-)ApWorker: After preflight dispatch revised research
    ApWorker-->>ApControl: New plan proposal through artifact and event
    ApControl->>ApState: Persist the next plan version
      opt Revised plan declares dependency artifacts
    ApControl-)ApChecks: Preflight declared dependency bytes before approval
    ApChecks-->>ApControl: Pass or route the failed preflight through recovery
      end
    ApControl->>ApIssue: Request approval of the new version
    else Human approves the displayed plan
    ApHuman->>ApIssue: New standalone /sdlc approve vN comment
    ApIssue-)ApControl: New comment event
    ApControl->>ApControl: Check author, version, hash, issue text, and trusted revision
        alt Approval is valid
      ApControl->>ApState: Bind actor and comment to plan hash
      ApControl->>ApState: Repin the base to the approved revision
      ApControl->>ApState: Register required dependency repair or decomposition
        else Command is stale or invalid
      ApControl->>ApIssue: Reject command without starting implementation
        end
    end
    opt Scoped amendment of an already approved plan
    ApControl->>ApState: Retain source and tasks and snapshot new scope and baseline
    ApControl-)ApWorker: Propose exact amendment without approving it
    ApWorker-->>ApControl: Versioned plan and structured permissions
    ApControl->>ApState: Persist amendment proposal and required approver
      opt Amendment declares dependency artifacts
    ApControl-)ApChecks: Preflight the declared bytes against the nominated baseline
    ApChecks-->>ApControl: Pass or route the failed preflight through recovery
      end
    ApControl->>ApIssue: Request exact amendment approval and required approver
    ApHuman->>ApIssue: New approve-amendment or reject-amendment vN command
    ApIssue-)ApControl: New comment event
    ApControl->>ApControl: Verify version, plan integrity and required human authority
      alt Exact approval and source, target, workflow and issue bindings match
    ApControl-)ApChecks: Compute the explicitly approved three-way integration
    ApChecks-->>ApControl: Deterministic tree hash or unresolved conflict
        alt Integration succeeds and controller recomputes the same tree
    ApControl->>ApControl: Publish integration without force to a new feature branch
    ApControl->>ApState: Retain source with fresh task and gate validation
        else Conflict or stale integration
    ApControl->>ApState: Record bounded recovery without applying the integration
        end
      else Authorized rejection
    ApControl->>ApState: Preserve source and block without integration
      else Invalid or stale command
    ApControl->>ApIssue: Reject command without authorizing new work
      end
    end
```

Only new, unedited human comments with standalone recognized commands are
processed, once per comment ID. The requester may approve or revise after
trusted intake, even if they are not a repository writer. Writers may also
approve. Among processed commands, those from other human authors receive an
explicit rejection without authorizing a lifecycle change. Authorized authors
also receive rejection feedback for invalid state, insufficient privileges for
the command, or stale versions.

A first lifecycle can only be created from an authorized human label event, not
from a later schedule or manual reconciliation. If the issue changes after that
event, the event snapshot remains authoritative and execution blocks before a
worker is dispatched. A revision snapshots the current issue and default branch, invalidates the
active job, clears approval and evidence, retires existing tasks as not planned,
and chooses a new versioned feature branch. Older branches and unsettled cost
identities are retained; accounting uses their original commit and plan bindings.
An edited issue requires a full revision, or a scoped amendment when a plan is
already approved, before execution can continue. The same choices apply to
protected-path default-branch movement. A trusted-baseline amendment needs a
maintainer and retains source rather than restarting it. Before the first plan
approval, use `/sdlc revise` after a baseline repair; `/sdlc amend` is rejected.
Movement outside protected paths is adopted between jobs instead of blocking,
without updating the baseline or rebasing the feature. `/sdlc retry` does not
authorize changed scope. A default-branch rename requires a full revision.

## Worker Handoff

Both agent and deterministic workers use the same durable job protocol. A
completion event is only a reconciliation hint, not sufficient proof that the
result belongs to the lifecycle.

<!-- mermaid-checked: quoted participant aliases, closed conditional blocks -->
```mermaid
sequenceDiagram
  participant HwControl as "Controller"
  participant HwState as "State branch"
  participant HwActions as "GitHub Actions"
  participant HwWorker as "Registered worker"
  participant HwArtifacts as "Actions artifacts"
  participant HwBranch as "Feature branch"
  participant HwIssue as "Epic issue"

  HwControl->>HwState: Read lifecycle and state-file SHA
  HwState-->>HwControl: Persisted lifecycle
  HwControl->>HwControl: Validate version and migrate legacy data in memory
    opt Legacy record requires an upgrade
    HwControl->>HwState: Persist version 2 using the original file SHA
    HwState-->>HwControl: Updated state-file SHA
    end
    opt Pending accounting from previous jobs
    HwControl->>HwActions: Find retained job using its original identity and bound run ID
    HwControl->>HwArtifacts: Read costs only when the run has completed
    HwControl->>HwState: Settle attributed usage once or retain until the fixed deadline
    Note over HwControl,HwState: Accounting never reads or accepts old worker results
    end
  HwControl->>HwState: Persist job, source, workflow, plan and execution hashes
  HwState-->>HwControl: Updated state-file version
  HwControl->>HwState: Persist dispatch timestamp
  HwControl->>HwActions: workflow_dispatch on trusted default branch
    opt Agent workflow
    HwActions->>HwActions: Validate and snapshot SDLC_AIC_CREDIT_LIMIT after activation
    end
  HwActions-)HwWorker: Start expected workflow revision
  HwWorker->>HwState: Read registered lifecycle using read-only access
  HwState-->>HwWorker: Registered job, proposed or approved plan, tasks and evidence
  HwWorker->>HwWorker: Validate and migrate state in memory only
  HwWorker->>HwWorker: Check registered inputs and runnable state
  HwWorker->>HwWorker: Derive capabilities with exact immutable baseline tests
    opt Matching incomplete draft
    HwWorker->>HwWorker: Restore only matching source, plan, workflow, task, step and execution hash
    end
    opt Security or coding
    HwWorker->>HwWorker: Seed blocked checkpoint and refresh it as review progresses
    end
    opt Coding role guidance
    HwWorker->>HwWorker: Agent packages blocked checkpoint before costly work and refreshes progress
    end
  HwWorker->>HwWorker: Execute assigned role or deterministic checks
  HwWorker-->>HwActions: Execution finishes or fails
    alt Agent workflow post-steps
    HwActions->>HwArtifacts: Attempt sdlc-cost upload with limit, selector, models, and token counts
    HwActions->>HwArtifacts: Attempt last packaged sdlc-result upload
    else Deterministic check workflow
    HwActions->>HwArtifacts: Upload check evidence and sdlc-result when available
    end
  HwActions->>HwActions: Finish remaining jobs and conclude workflow
  HwActions-)HwControl: workflow_run completion event
  HwControl->>HwActions: Discover expected workflow, actor, revision, and run
  HwActions-->>HwControl: Matching first-attempt run metadata
  HwControl->>HwState: Bind run ID to active job
  HwControl->>HwArtifacts: Read job durations and agent cost receipt if applicable
    break Cost retrieval or receipt validation throws
        alt Retryable error within the job timeout
      HwControl->>HwControl: Retain registered job for a later reconciliation
        else Receipt rejected or retrieval deadline exceeded
      HwControl->>HwState: Mark incomplete cost history and consume a bounded failure
      HwControl->>HwIssue: Show cost error, job identity, and run link in status
        end
    end
    opt Failed workflow or unavailable or pre-empted telemetry
        opt Failed Security workflow
      HwControl->>HwArtifacts: Read and validate checkpoint for diagnostics only
        end
    HwControl->>HwIssue: Publish idempotent attempt diagnostics
    end
    alt Complete measured receipt
    HwControl->>HwState: Charge once, append job and persona usage, and finalize cost marker
    else Incomplete telemetry within collection window
    HwControl->>HwState: Retain identity, observed values, and fixed deadline without charging
    else Incomplete telemetry past collection deadline
    HwControl->>HwIssue: Report unavailable telemetry and stop collection
    HwControl->>HwState: Retain attributed usage, charge observed values, and mark incomplete history
    end
    alt Workflow permits result acceptance
    HwControl->>HwArtifacts: Download exactly one eligible result artifact
    HwArtifacts-->>HwControl: Untrusted result JSON
    HwControl->>HwControl: Check schema, current job, plan, source, and policy
        alt Accepted pass result
          opt Explicitly approved integration stage
        HwControl->>HwControl: Independently recompute the approved integration tree
        HwControl->>HwBranch: Publish only the matching tree without force
        HwControl->>HwState: Invalidate old proof and revalidate retained tasks
          end
          opt Maintenance proposal stage
        HwControl->>HwState: Retain a separate patch proposal and wait for a writer hash command
        Note over HwControl,HwBranch: Maintenance pass does not publish feature changes or satisfy a gate
          end
            opt Coding, testing, or documentation stage proposes text changes
        HwControl->>HwBranch: Validate tree and publish without force
        HwBranch-->>HwControl: Accepted commit SHA
        HwControl->>HwControl: Invalidate older evidence
            end
        HwControl->>HwState: Annotate usage with accepted outcome and resulting commit
        HwControl->>HwState: Record stage result and next phase, retaining unresolved costs
        else Structured non-passing result
        HwControl->>HwState: Validate blocker authority and record bounded recovery
        else Legacy non-passing result or invalid output
        HwControl->>HwState: Preserve legacy repair or block or count a failure
        end
    else Failed worker workflow
      opt Eligible coding, Security, Testing, Documentation or Review stage
    HwControl->>HwArtifacts: Read optional current-job incomplete checkpoint
    HwControl->>HwControl: Check binding, path authority and continuation budget
      end
    HwControl->>HwState: Retain valid incomplete draft within budget or count failure
    Note over HwControl,HwState: Failed runs never supply accepted results or gate evidence
    end
```

The adapter selects the expected worker file from the registered stage:

- `research`, `decompose`, `code`, `security`, `test`, `document`, `review`, and `maintain`
  use the [compiled agent workflow](../.github/workflows/sdlc-agent.lock.yml).
- `scan`, `validate`, and `integrate` use the
  [deterministic check workflow](../.github/workflows/sdlc-checks.yml).

All eight agent stages select the inference model at workflow runtime from the
repository variable `SDLC_MODEL`, falling back to `auto` when it is unset or
empty. The model choice does not change worker permissions or result acceptance.
The configured selector is distinct from concrete model IDs reported by runtime
token-usage telemetry. Available observations are informational cost metadata;
`auto` is never treated as a resolved identity and need not select the same model
for every stage or inference.

The credential-free `budget` job validates `SDLC_AIC_CREDIT_LIMIT` after
activation, defaulting to `250` when unset or empty. It accepts decimal integers
from 1 to 10,000. Its output is passed to both inference jobs through
`engine.env.GH_AW_MAX_AI_CREDITS` and to the worker's runtime policy. The
primary agent and threat detector enforce the same configured cap separately;
their combined usage is not bounded by a single shared counter. Invalid
configuration prevents either inference job from starting.

Acceptance requires the controller App as the run actor, the registered trusted
workflow commit, the expected job name and workflow, and `run_attempt == 1`.
The report supplies `jobId` and `inputSha`; stage, task, and plan authority come
from the registered job, not arbitrary fields supplied by an agent.

The controller accepts one unexpired `sdlc-result` artifact, with bounded
compressed and result-file sizes. It parses `result.json` as data and never
executes downloaded code. Agent proposals remain untrusted even when their
workflow provenance matches.

The separate `sdlc-cost` artifact is written by a workflow post-step rather than
by the agent, so it records what the run actually consumed rather than what the
agent claims. Deterministic check runs upload no such artifact and are charged
runner time only.

For deterministic checks, the dedicated `SDLC Check Result` job must succeed.
That job can report a failed scanner or test even when the overall workflow
conclusion is `failure`. A failed agent workflow has no equivalent exception.

The [Coding profile](../.github/agents/code.agent.md) requires acceptance-to-check
mapping, current diagnostic triage, consumer entry-point checks, and explicit
verification limits. It instructs the agent to write and collect provisional
`blocked` progress reports. Trusted preparation seeds coding and Security reports.
Validated structured incomplete-work drafts can seed a bounded successor at the
same exact job context, including split step and execution breakdown. They are
never automatically published or accepted as evidence. A successful successor
must revalidate them. See [Coding and Repair Evidence](operations.md#coding-and-repair-evidence).

## Security and Testing

Security uses ordinary tools in addition to agent reasoning. Coverage is
measured by executing tests, not by accepting a model's estimated percentage.

<!-- mermaid-checked: safe quoted labels, unique IDs, closed subgraphs -->
```mermaid
flowchart TD
    GatePrepare["Validate dispatch and registered lifecycle"]
    GateStage["Select registered deterministic stage"]
    GateDependencies["Hash-check installed pins or stage declared preflight bytes"]
    subgraph GateScan["scan stage: two required parallel jobs"]
        GateCodeQL["CodeQL extended security queries"]
        GateSarif["Validate SARIF findings against policy"]
        GateAudit["npm dependency audit against lockfile"]
        GateSecrets["Checksum-pinned Gitleaks with trusted config"]
    end
    subgraph GateTests["validate stage: one required test job"]
        GateInstall["Install dependencies with scripts disabled"]
        GateBaseline["Typecheck and execute baseline tests"]
        GateCandidate["Typecheck and execute candidate tests"]
        GateCoverage["Compare measured coverage to fixed policy"]
    end
    GateResult["Separate result job checks required job conclusions"]
    GateIntegration["Read exact three-way trees and approved conflict resolutions"]
    GatePass["Return pass report"]
    GateFail["Return structured blocker with failed jobs and CodeQL diagnostics"]
    GateController["Controller authenticates result and chooses next phase"]

    GatePrepare --> GateStage
    GateStage -->|"scan including preflight"| GateDependencies
    GateDependencies --> GateCodeQL --> GateSarif
    GateDependencies --> GateAudit -->|"Audit succeeds"| GateSecrets
    GateDependencies -->|"Integrity or download failure"| GateResult
    GateSarif -->|"Conclusion and any bounded diagnostics"| GateResult
    GateSecrets --> GateResult
    GateAudit -->|"Audit fails; secret step is skipped"| GateResult
    GateStage -->|"validate"| GateInstall --> GateBaseline
    GateBaseline --> GateCandidate --> GateCoverage --> GateResult
    GateBaseline -->|"Failure"| GateResult
    GateCandidate -->|"Failure"| GateResult
    GateStage -->|"integrate"| GateIntegration --> GateResult
    GateResult -->|"Required jobs and stage-specific receipt are valid"| GatePass
    GateResult -->|"Required job or stage-specific receipt is not valid"| GateFail
    GatePass --> GateController
    GateFail --> GateController
```

`scan` requires `prepare`, `codeql`, and `security`. `validate` requires
`prepare` and `tests`. `integrate` requires `prepare`, `integration`, and a valid
tree-hash receipt; unrelated jobs are intentionally not required.
If preparation fails, the result job cannot produce an accepted report.

Preflight is a registered `scan` with a separate purpose and probe SHA, not a
final candidate gate. Baseline scans precede research; declared dependency bytes
are checked before implementation. Alternatives are bounded and explicit patch
permissions require human approval before any vendor-only repair. The repaired
installed bytes must pass preflight before feature tasks proceed. Ordinary
`CI / CodeQL` applies the same findings policy to PRs and default-branch pushes.

The current checks include:

- **CodeQL:** JavaScript/TypeScript, `security-extended` queries, and build mode
  `none`. SARIF is evaluated locally and retained as an artifact, not uploaded
  against the workflow's unrelated default-branch commit.
- **Dependencies:** npm audits the candidate lockfile and blocks high or
  critical vulnerabilities. Failed or malformed audit output cannot pass.
- **Secrets:** Gitleaks v8.30.1 uses a checksum-pinned binary and trusted
  configuration. Findings block the gate; source-controlled ignore files and
  inline allow comments cannot suppress them in this workflow.
- **Tests:** baseline and candidate dependencies are installed without npm
  lifecycle scripts. A trusted runner invokes TypeScript and Node tests with
  c8, using test and source patterns from policy.
- **Coverage:** at least 80% lines and 70% branches, with no permitted drop from
  the baseline. Missing tests or invalid coverage data fail validation.

On SARIF validation failure, the validator emits JSON-encoded diagnostics through
a job output. Blocking findings include at most ten rule IDs, source locations,
and severities, with bounded metadata fields and no source snippets. The result
job carries at most 6000 characters into repair feedback, labeled as untrusted
scanner data, only when CodeQL did not succeed. Missing, malformed, or oversized
diagnostics fall back to the failed job names and run link; they cannot turn a
failed check into a pass. The full SARIF remains in the `sdlc-codeql` artifact.
Registered job, approved plan, trusted revision, and source-commit checks remain
unchanged.

The security and final review agents assess the complete integrated diff and
available evidence. They are advisory assessments with limited tool access,
not proof that a feature is free of defects. Native GitHub rules and human
review remain necessary at the PR boundary.

The [Testing profile](../.github/agents/test.agent.md) first derives a risk-based
coverage map from approved behavior and public contracts, with independently
justified expected results. Missing test details may be filled in; undefined
product rules require clarification. Reports distinguish tested behavior,
demonstrated defects, unavailable tooling, and unfinished or approved later human
checks. Production defects return `changes_requested` with a reproduction in
the summary because that path does not apply proposed test changes. Ambiguity
or incomplete required testing returns `blocked`. The existing `pass` path
still leads to independent scans and deterministic validation as shown above.
These are prompt-level completeness rules, not new schema-enforced fields or
browser-validation capabilities. Test-only scope and baseline immutability at
`state.baseSha` are unchanged.

The Security profile requires explicit coverage, findings, outstanding checks,
and a handoff. It prioritizes high-risk paths without silently dropping other
applicable review areas. Trusted preparation seeds a provisional `blocked`
result after checking the registered job; the agent refreshes it through the
normal collect command as work progresses. The final post-step attempts to
upload the last packaged result even if inference fails. This is best-effort
capture, not continuous remote storage; abrupt runner termination can lose it.
Checkpoints from failed workflows are untrusted continuation inputs, never
Security evidence. A successful workflow returning a structured `incomplete_work`
blocker can continue within budget. Legacy `blocked` reports still stop normally.
Neither path is a schema-level proof of review completeness.

## Recovery Flow

The controller records state before dispatching work or invalidating a job.
Only recognized, current results can advance a running lifecycle.

State validation and any required migration must succeed before this phase-based
recovery flow runs. A schema error or failed migration write stops reconciliation
for that issue without changing its lifecycle phase.

<!-- mermaid-checked: safe quoted labels, unique IDs, closed subgraphs -->
```mermaid
flowchart TD
    RecoveryActive["Active lifecycle"]
    RecoveryInvalidate["Retain unsettled cost identity and clear active job atomically"]
    RecoveryPaused["paused"]
    RecoveryCancelled["cancelled: no automatic restart"]
    RecoveryFailure["Increment consecutive infrastructure failures"]
    RecoveryRetry["Register replacement job in the same phase"]
    RecoveryFindings["Classify blocker and fingerprint attempted remedy"]
    RecoveryCode["coding: apply repair feedback"]
    RecoveryReadyTask["coding: run an unrelated dependency-ready task"]
    RecoveryBlocked["blocked: inspect cause and evidence"]
    RecoveryRevise["Retain unsettled costs, snapshot scope and retire tasks"]
    RecoveryResearch["researching: new plan requires approval"]
    RecoveryAccounting["Reconcile pending costs in every phase"]
    RecoverySettled["Retain attributed usage and settle once without accepting old results"]
    RecoveryPartial["Record observed values and warn of incomplete history"]
    RecoveryContinue["Resume the registered stage or approved coding step"]
    RecoveryAmend["amending: retain source and propose exact change"]
    RecoveryDecision["awaiting_amendment: explicit authorized human decision"]
    RecoveryIntegrate["integrating: exact tree merge and fresh validation"]
    RecoveryMaintain["maintaining: propose diagnosed baseline replacements"]
    RecoveryMaintenancePR["Writer hash command publishes a draft repair PR"]
    RecoveryPreflight["preflighting: baseline before research"]

    RecoveryActive -->|"Pause or cancel request"| RecoveryInvalidate
    RecoveryActive -->|"Issue closed or intake label removed"| RecoveryInvalidate
    RecoveryInvalidate -->|"Pause"| RecoveryPaused
    RecoveryInvalidate -->|"Cancel"| RecoveryCancelled
    RecoveryInvalidate -->|"Replan needed"| RecoveryBlocked
    RecoveryInvalidate -.->|"Unsettled job only"| RecoveryAccounting
    RecoveryRevise -.->|"Unsettled job only"| RecoveryAccounting
    RecoveryFailure -.->|"Unsettled job only"| RecoveryAccounting
    RecoveryActive -.->|"Incomplete telemetry"| RecoveryAccounting
    RecoveryAccounting -->|"Complete receipt"| RecoverySettled
    RecoveryAccounting -->|"Deadline or permanent retrieval error"| RecoveryPartial
    RecoveryAccounting -->|"Unavailable within collection window"| RecoveryAccounting
    RecoveryPaused -->|"Writer resumes"| RecoveryRetry
    RecoveryActive -->|"Invalid result or failed worker without usable draft"| RecoveryFailure
    RecoveryActive -->|"Bound valid incomplete checkpoint"| RecoveryContinue
    RecoveryActive -->|"Cost receipt rejected or retrieval deadline exceeded"| RecoveryFailure
    RecoveryFailure -->|"Failure budget remains"| RecoveryRetry
    RecoveryFailure -->|"Failure budget exhausted"| RecoveryBlocked
    RecoveryRetry --> RecoveryActive
    RecoveryActive -->|"Structured non-passing result"| RecoveryFindings
    RecoveryFindings -->|"Permitted repair and new remedy within budget"| RecoveryCode
    RecoveryFindings -->|"Transient failure within budget"| RecoveryRetry
    RecoveryFindings -->|"Incomplete work within budget"| RecoveryContinue
    RecoveryContinue -->|"Revalidate draft and original acceptance"| RecoveryActive
    RecoveryFindings -->|"Task-local wait with unrelated ready work"| RecoveryReadyTask
    RecoveryReadyTask --> RecoveryActive
    RecoveryFindings -->|"Eligible approval conflict after ready work finishes"| RecoveryAmend
    RecoveryFindings -->|"Verified immutable baseline defect"| RecoveryMaintain
    RecoveryFindings -->|"Unsafe output or exhausted budget"| RecoveryBlocked
    RecoveryFindings -->|"Decision needed but no eligible automatic proposal"| RecoveryBlocked
    RecoveryMaintain -->|"Proposal ready but not applied"| RecoveryBlocked
    RecoveryBlocked -->|"Exact maintainer patch-hash command"| RecoveryMaintenancePR
    RecoveryMaintenancePR -->|"Reviewed and merged, approved plan: request amendment"| RecoveryAmend
    RecoveryMaintenancePR -->|"Reviewed and merged, no approval or restart: revise"| RecoveryRevise
    RecoveryAmend -->|"Proposal and required preflight complete"| RecoveryDecision
    RecoveryDecision -->|"Exact approval with required authority"| RecoveryIntegrate
    RecoveryDecision -->|"Reject"| RecoveryBlocked
    RecoveryIntegrate -->|"Recompute tree and invalidate old proof"| RecoveryActive
    RecoveryIntegrate -->|"Unresolved overlap"| RecoveryBlocked
    RecoveryCode --> RecoveryActive
    RecoveryActive -->|"Legacy blocked report or total job limit"| RecoveryBlocked
    RecoveryActive -->|"Issue, base branch, or protected paths changed"| RecoveryInvalidate
    RecoveryBlocked -->|"Eligible legacy or infrastructure retry only"| RecoveryRetry
    RecoveryBlocked -->|"Scoped amendment command with an approved plan"| RecoveryAmend
    RecoveryBlocked -->|"Authorized revision command"| RecoveryRevise
    RecoveryPaused -->|"Authorized revision command"| RecoveryRevise
    RecoveryActive -->|"Authorized revision command"| RecoveryRevise
    RecoveryRevise --> RecoveryPreflight -->|"Pass"| RecoveryResearch --> RecoveryActive
```

### Recovery Rules

- **Duplicate events:** reuse the issue lifecycle and active job. Commands are
  deduplicated by comment ID; repeated side effects reuse controller-owned
  markers or existing linked resources.
- **Lost dispatch:** wait up to 10 minutes for a matching run, then allow one
  additional dispatch of the same job identity. Exhaustion counts as an
  infrastructure failure; a replacement job receives a new identity.
- **Timeout:** after 90 minutes from job creation, reconciliation cancels an
  unfinished run and counts a failure. Agent and check jobs have their own
  shorter Actions time limits.
- **Infrastructure failures:** two consecutive failures block the lifecycle.
  Successful results reset this counter. A missing or malformed scanner report
  is not a clean scan.
- **Artifact retrieval:** transient `404`, `408`, `429`, rate-limited `403`, and
  `5xx` responses, plus an empty result-artifact listing, retain the completed
  registered job for retry until its job timeout. Persistent retrieval failure
  then consumes one infrastructure failure.
- **Active-job cost retrieval:** thrown transient errors retain the current job until the
  same timeout. Malformed receipts, non-retryable download errors, or transient
  errors past that deadline consume one worker failure without reading or
  accepting the result. Known totals are preserved, cost history is marked
  incomplete, and the issue status identifies the error and run. The existing
  consecutive-failure budget bounds replacement attempts before blocking.
- **Deferred costs:** interrupted jobs and incomplete receipts retain a compact
  original job identity outside active-job authority. Discovery and cost reads
  continue in every phase, with cancellation retried for abandoned running
  jobs. A fixed window of `jobTimeoutMinutes` starts at first deferral and is
  never extended by retries or replanning. Complete observations are settled
  once. A permanent retrieval error or still-missing data after the deadline
  records only known values, marks incomplete history, and stops collection.
  These accounting failures do not consume the current worker's failure budget.
- **Legacy repair findings:** accepted unstructured `changes_requested` after decomposition return
  to coding, with two automatic repair rounds. The same outcome from research
  or decomposition counts as a failed stage instead.
- **Structured recovery:** verified categories route separately. Automatic retries,
  repairs, continuations and splits are bounded by fingerprint, stage, task/step,
  global jobs and repairs. Identical deterministic repairs stop without another
  inference. Task-local decisions permit unrelated ready tasks; repository trust
  failures do not. Retry and continuation resume the original registered stage;
  only coding repairs and approved coding steps route to coding. Invalid recovery
  payloads consume bounded worker failures.
- **Amendments:** automatically proposed for eligible approval conflicts, never
  automatically approved. A prior approved plan is required. Automatic proposals
  start only when the lifecycle is blocked, no amendment is pending, and the
  current default-branch head still matches the trusted revision. Human commands
  bind exact source, baseline, request,
  plan and workflow. Stale proposals can be replaced with higher versions.
  Three-way integration preserves disjoint work; actual overlapping application
  files need exact maintainer-approved blob-bound resolutions. Protected files
  and baseline tests are outside the resolution path. All final gates rerun.
- **Baseline maintenance:** a proposal-only role prepares exact diagnosed file
  replacements. The controller persists a writer's explicit patch-hash command
  before creating a separate draft PR. A lost response is retried idempotently.
  Neither feature source nor main is automatically changed by the proposal.
  After normal review and merge, an already approved feature may use a scoped
  amendment. Before approval, or when starting over is intended, use full revision.
- **Manual controls:** requester or writer may pause, revise, or cancel.
  Only a writer may resume or retry. Scoped amendments additionally support
  source-preserving decisions. Retry clears infrastructure failures, not global
  budgets, and rejects unresolved structured decisions or exhausted recoveries.
- **Late output:** interruption retains any unsettled cost identity and clears
  the active job in one state write before requesting worker cancellation.
  Late costs can be collected; late results cannot authorize their own acceptance.
- **Partial publication:** if a commit was written before interruption, recovery
  verifies its parent, proposal digest, and complete expected file tree. A
  matching commit message alone is insufficient.
- **State races:** updates include the prior state-file SHA. Conflicting writes
  fail instead of silently overwriting another checkpoint. A future controller
  run reloads state; GitHub API calls and state writes are not one transaction.
- **Attempt diagnostics:** failed workflows and telemetry warnings produce a
  comment keyed by job and run before their cost is checkpointed. A failed
  Security result is validated for identity and read-only changes before its
  bounded summary is displayed as untrusted progress. Neither that summary nor
  its claimed outcome is used to accept failed work. Comment retries are
  idempotent, and a failed comment write leaves the cost unrecorded for retry.

The schedule reconciles every 10 minutes and can recover established lifecycles
after events are coalesced by Actions concurrency. Initial lifecycle creation
still requires a live authorized label event. Manual dispatch can reconcile one
issue or all known lifecycles. Turning `SDLC_ENABLED` off prevents new starts and transitions, but
already-running jobs must also be cancelled for an immediate emergency stop.

Once `pr_open` is reached, normal PR review owns further interaction. The
controller observes merge or closure; it does not autonomously respond to PR
review comments or rerun the lifecycle for subsequent PR pushes. Pending cost
collection and the issue's cost status can still progress, including after merge.

## Component Relationships

These are modules within Actions jobs, not separately deployed services.
`Platform` is the controller's boundary for GitHub effects and local test fakes.

<!-- mermaid-checked: safe quoted labels, unique IDs, closed subgraphs -->
```mermaid
flowchart LR
    subgraph ComponentControl["Controller process"]
        ComponentMain["main.ts"]
        ComponentController["controller.ts"]
        ComponentGitHub["github.ts"]
    end
    subgraph ComponentRules["Domain and validation rules"]
        ComponentDomain["domain.ts"]
        ComponentLifecycle["lifecycle.ts"]
        ComponentContracts["contracts.ts"]
        ComponentChanges["changes.ts"]
        ComponentRecovery["recovery.ts"]
        ComponentDependencies["dependencies.ts"]
    end
    subgraph ComponentExecution["Worker processes"]
        ComponentWorker["worker.ts"]
        ComponentValidate["validate.ts"]
    end
    ComponentMain -->|"Select issues and reconcile"| ComponentController
    ComponentMain -->|"Construct Platform adapter"| ComponentGitHub
    ComponentMain -->|"Resolve and validate runtime policy"| ComponentContracts
    ComponentController -->|"Commands and plan approval"| ComponentDomain
    ComponentController -->|"Jobs, cost observations and publication prerequisites"| ComponentLifecycle
    ComponentController -->|"Platform operations"| ComponentGitHub
    ComponentController -->|"Validate results"| ComponentContracts
    ComponentController -->|"Restrict proposed changes"| ComponentChanges
    ComponentController -->|"Blockers, amendments and bounded recovery"| ComponentRecovery
    ComponentController -->|"Pinned alternatives and patch authority"| ComponentDependencies
    ComponentGitHub -->|"Validate artifacts and migrate stored state"| ComponentContracts
    ComponentGitHub -->|"Validate writes and compare trusted paths"| ComponentChanges
    ComponentGitHub -->|"Recheck approved integration authority"| ComponentRecovery
    ComponentGitHub -->|"Enforce dependency pins before publication"| ComponentDependencies
    ComponentWorker -->|"Read registered lifecycle"| ComponentGitHub
    ComponentWorker -->|"Check approval integrity"| ComponentLifecycle
    ComponentWorker -->|"Validate runtime policy, job inputs and reports"| ComponentContracts
    ComponentWorker -->|"Collect bounded text changes"| ComponentChanges
    ComponentWorker -->|"Shared permission and draft-path checks"| ComponentChanges
    ComponentWorker -->|"Isolated pinned artifact preflight"| ComponentDependencies
    ComponentValidate -->|"Read trusted policy"| ComponentContracts
```

### Component Inventory

| Component | Layer | Type | Responsibility |
| --- | --- | --- | --- |
| [Entry](../src/main.ts) | Control | CLI | Select issues and reject stale runs |
| [Controller](../src/controller.ts) | Control | Orchestrator | Reconcile stages and pending costs |
| [Domain](../src/domain.ts) | Domain | Rules | Parse commands and hash plans |
| [Lifecycle](../src/lifecycle.ts) | Domain | Ledger | Jobs, tasks, evidence, cost observations |
| [Contracts](../src/contracts.ts) | Validation | Schemas | Parse untrusted data |
| [Changes](../src/changes.ts) | Validation | Policy | Restrict paths and sizes |
| [Recovery](../src/recovery.ts) | Domain | Rules | Bound remedies, proposals, amendments and task steps |
| [Dependencies](../src/dependencies.ts) | Validation | Provenance | Stage pinned public npm files and enforce exact patch authority |
| [GitHub](../src/github.ts) | Effects | Adapter | State and repository writes |
| [Worker](../src/worker.ts) | Execution | CLI | Prepare and package results |
| [Validator](../src/validate.ts) | Execution | CLI | Run tests and enforce gates |

## State and Evidence

### Domain Records

| Record | Meaning and relationship |
| --- | --- |
| Epic | Original request and human discussion; owns one lifecycle |
| Plan | Versioned proposed scope; implementation needs its approval |
| Approval | Human actor and comment bound to an exact plan hash |
| Task | Bounded work item in the approved plan's dependency graph |
| Job | One registered attempt to execute a stage against a commit |
| Recovery | Verified blocker, stage/task/step fingerprint, bounded attempts, optional unaccepted draft or maintainer proposal |
| Amendment | Retained source and tasks, nominated baseline, exact proposed permissions, required human decision |
| Dependency patch | Original and patched hashes bound to the current approved plan and accepted publication |
| Pending cost | Original job identity, fixed expiry, and optional observed measurements; not execution authority |
| Usage history | Settled job/persona attribution, observed model/token metadata, and any recorded accepted-result commit; not gate evidence |
| Evidence | Accepted stage summary and run reference for one commit |
| Feature PR | Published integrated feature, awaiting normal human review |

State is stored as `issues/<number>.json` on the protected `sdlc-state` branch.
That branch is initialized with an isolated root commit, separate from feature
history. The default feature branch pattern is `agentic/epic-<number>-v<version>`;
the branch is created lazily when an accepted text change or an approved
amendment integration is published.

### Schema Migration

New records and all writes use `schemaVersion: 2`. The shared loader validates
either version 2 or the known version-1 formats, which may have no `spend` object
or an existing cost ledger. `migrateLifecycle` converts version 1 in memory and
does not change phase, plan text or hash, approval, tasks, evidence, job identity,
commit bindings, or existing cost counters. Malformed data and unknown versions
are rejected; current-version writes never apply implicit defaults.

`pendingCosts` is an optional version-2 extension, bounded to 100 entries by
the maximum supported lifecycle job budget. Records without it remain valid
without resets or a migration write. Entries reject unexpected authority fields
and duplicate job IDs, and the field is removed when the queue empties. Older
strict version-2 readers do not support this extension; rollback must preserve it.

Optional `models` arrays extend cost receipts, pending observations, and `spend`.
They hold bounded concrete model IDs, with up to 20 IDs captured per run and
2,000 accumulated across the maximum 100 jobs. Legacy records load without them
and are not backfilled. Older strict readers reject these fields too, so the
controller and compiled workflow must be deployed together after draining old
runs, and rollback must retain model-field support. Model availability is not a
new migration or acceptance condition.

Optional `usageHistory` retains up to 100 unique registered jobs and rejects
duplicate known run IDs or mismatched stage/persona pairs. Retained identities
can also include the task and dispatch-attempt counter. Optional receipt fields
`requestedModel` and `tokenUsage` preserve selector and token observations.
Pending and settled records may include controller-accepted result metadata.
Existing records without these fields load unchanged; no history is inferred
from aggregate totals. Deployment and rollback must retain the upgraded readers.

Recovery extends version 2 with optional blocker/draft history, backoff,
amendments, decisions and a monotonic `planVersion`, preflight state, dependency selections and patches,
maintenance publication intent, task steps, and execution hashes. No permission
is backfilled from legacy plan prose. New phases and stages require the upgraded
controller, profiles and workflows together. Recovery history and draft payloads
are bounded, and state writes over 1 MB are rejected before publication.

The storage adapter returns a transient `needsMigration` flag alongside the
original file SHA. Only the controller saves the upgrade, before any command,
PR processing, or terminal-state early return. This includes `pr_open`, `merged`,
and `cancelled` records. Workers use the same read-only loader and cannot persist
an upgrade. Migration is idempotent: an uncommitted write can be retried, a lost
acknowledgement is resolved by reloading, and stale writers fail the existing
SHA concurrency check. The flag is not stored in the lifecycle JSON.

The migration does not authorize new work or relax trusted-revision checks.
Deploy only after older controller and worker runs are idle, following
[State Upgrades](operations.md#state-upgrades).

### Revision Bindings

| Binding | Purpose |
| --- | --- |
| `baseSha` | Baseline source and tests for this plan's implementation |
| `controlSha` | Trusted workflow and automation revision |
| `headSha` | Latest controller-accepted feature commit |
| `plan.hash` | Immutable plan content and version fingerprint |
| `plan.policy` | Hashed requirements, dependency pins, bounded repair flexibility and optional exact conflict resolutions |
| `job.inputSha` | Source commit supplied to a particular worker |
| `job.executionHash` and `job.stepId` | Bind an exact task breakdown and optional registered split step |
| `job.probeSha` | Separate immutable baseline used by a registered preflight scan |
| `job.runId` | Accepted GitHub run for the registered job |
| `spend` | Cumulative recorded runner time and AI credits |
| `spend.models` | Optional distinct concrete model IDs observed in settled primary-agent receipts; informational, not a complete model history |
| `spend.historyComplete` | `false` when historical or finalized cost telemetry is unavailable |
| `pendingCosts` | Unsettled original job identities, fixed collection deadlines, and optional observed values excluded from totals |
| `usageHistory` | Durable per-job stage/persona, model and token observations, original bindings, and any accepted outcome/output commit |

At initialization, approval, and replanning, baseline and controller SHAs are
captured from the default branch. `baseSha` then remains fixed while the
candidate head advances. An approved amendment updates `baseSha` only after its
integration succeeds. Dispatch inputs carry the issue, job, stage, candidate SHA,
and controller SHA.

`controlSha` tracks the default branch rather than pinning one commit for the
whole lifecycle, because `workflow_dispatch` always runs at the head: a pin left
behind by unrelated commits would fail every worker's revision gate and stall the
lifecycle silently. Between registered jobs the controller compares its pinned
revision with the current head and adopts the head when no protected path
differs. A protected-path difference means the trusted harness itself moved, so
the lifecycle stops for a full revision or a maintainer-requested scoped amendment.
Anything the comparison cannot judge cleanly, such as a revert, a force push, or
a diff at the API's file cap, is treated as a protected-path change.

Trusted-revision detection uses `isProtectedPath`: the protected patterns in
[policy.json](../.github/sdlc/policy.json) plus the hardcoded automation and
agent-instruction exclusions in [changes.ts](../src/changes.ts). This is not the
complete set of agent edit restrictions. Tests present at `baseSha` are separately
immutable to all feature workers, even when their paths are not protected. A
default-branch change confined to such a test is not itself protected-path drift;
adopting its workflow revision does not update `baseSha` or incorporate that edit
into the feature. A full revision or approved amendment is needed to change the
feature's baseline. The persisted job links these inputs to the plan and task.

### Publication Preconditions

Before creating the final PR, the controller requires:

1. An intact plan whose hash matches the recorded human approval.
2. Phase `publishing`, no active job, and at least one task.
3. Every task marked implemented and a head commit different from the baseline.
4. Accepted `scan`, `security`, `test`, `validate`, `document`, and `review` evidence on the
   exact candidate head SHA.
5. No unresolved recovery, amendment, preflight or dependency-only repair.
6. The working branch still pointing to that reviewed commit.

Publication creates or reuses the feature PR, posts the reviewer's report as an
advisory `COMMENT`, and publishes `SDLC / Complete` on the reviewed SHA. The App
does not approve or merge the PR. Configured branch rules, normal CI, and human
review govern merging. Selecting the App as the required check's expected
source is an installation step, not something these workflows configure.

### Cost Accounting

Complete worker costs are charged exactly once to `spend`. The active job's
`costedRun` marker and the tally are saved together; deferred settlement removes
its pending entry in the same SHA-checked write as the tally update. Reloading
after a failed write or lost acknowledgement cannot double count. This includes
rejected and failed results, cancelled workers, and superseded plans. Unlike
evidence, costs survive a change of head commit or plan.

The same settlement write appends a `usageHistory` entry with a copied original
job identity and its assigned persona, derived by the controller rather than
the receipt. Repeated settlement of the same identity is a no-op; conflicting
identities or duplicated known run IDs are rejected. Missing observations are
omitted, never synthesized from current settings. Jobs that were never
discovered retain identity without a fabricated run ID or charge. The history
survives pending cleanup, replanning, source changes, and artifact expiry.

Normal result acceptance separately annotates its pending or settled usage with
`acceptedResult` (outcome and resulting commit). Rejected or stale results and
failed agent workflows are not annotated. Accounting never reads an abandoned
result to fill this field, and historical accepted results never replace
current-commit gate evidence. No routing or diversity policy consumes the ledger.

Before clearing a dispatched, uncosted job, interruption and replanning retain
its ID, stage, original source and trusted revision, plan hash, creation time,
and any discovered run ID in `pendingCosts`. Incomplete receipts also retain
their observed values there even when the stage advances. Pending observations
are not yet included in totals. Repeated observations preserve known values,
use the largest observed runner duration rather than summing repeated reads,
and retain an observed credit-limit snapshot and concrete model IDs when later
reads omit them. Model IDs are deduplicated and sorted, not counted as new runs.
The first observed requested selector is retained. Token observations use a
single best snapshot, preferring available over partial and then more requests;
retries never add snapshots together or erase a better one with missing data.

Every reconciliation processes abandoned accounting before terminal-state
returns, matching the original workflow, actor, revision, job, and first run
attempt. It never reads a historical result or mutates approval or evidence.
Abandoned running workers receive renewed cancellation requests. Transient
lookup, cancellation, and receipt failures do not block unrelated stage progress.
The fixed collection window is `jobTimeoutMinutes` from first deferral (90
minutes by default), not a deadline refreshed by each poll. If data is still
missing after that window or retrieval fails permanently, an idempotent
accounting diagnostic identifies the job; only observed values are settled and
history is marked incomplete. Nothing is invented for an undiscovered run.

The current active job keeps the existing bounded error path: thrown permanent
or expired retrieval errors consume one worker failure without accepting the
result. Any previously observed pending values are settled once, its entry is
removed, and history is marked incomplete. Deferred-only failures do not fail a
newer job. Missing telemetry itself remains observational, not a new gate.

At PR creation, the publisher includes the controller's configured `SDLC_MODEL`
and resolved `SDLC_AIC_CREDIT_LIMIT` in the Cost section, with defaults of `auto`
and `250`. These are a publication-time configuration snapshot, not per-run
history or a resolved inference-model identity. The cap applies separately to
each inference job, not each turn. Existing PR descriptions are left unchanged
on publication retries, even if repository variables or settled costs have
since changed. Totals are also labeled as a creation-time snapshot, with pending
jobs explicitly excluded and a link to the issue's updating lifecycle status.
Pending accounting does not delay an otherwise eligible publication.

The Cost section also lists **Observed agent models**, independently of the
configuration snapshot. The post-step reads concrete `model` IDs from the
primary agent's structured `token-usage.jsonl`, rather than from agent prose or
the configured selector. Missing/unreadable logs, malformed records, oversized
files, `auto`, and `unknown` cannot invent a concrete model. Logs are opened as
regular non-symlink files, limited to 5 MB, and model IDs are restricted to bounded
display-safe text. No usable IDs means `unavailable`. These runtime observations
are diagnostic metadata, not attestation, acceptance evidence, or billing truth.
They do not alter credit calculations, retry deadlines, or gates. Model history
is not backfilled, and absence does not change `spend.historyComplete`.

The post-step also captures the workflow's configured selector in
`requestedModel` and per-model request/input/output/cache-read/cache-write
counts in `tokenUsage`, without changing AI-credit calculations. Repeated
nonempty request IDs are counted once. Malformed records, missing/invalid
counts, or the 20-model cap make telemetry partial; a missing count is `null`,
not measured zero. No concrete models means unavailable telemetry. Counters
preserve the runtime's cache semantics, which can overlap with input counts;
they are not normalized across labs or translated into per-model billing.
The 10 KB receipt limit remains unchanged. Token availability is not a new
stage gate or a reason to extend collection deadlines.

Model lists cover available settled primary-agent receipts, not all inference:
legacy/missing telemetry and the separate threat detector are not covered.
Several models may appear, including with automatic selection. The PR model
list is also fixed at creation; issue status reflects later settlements. Displays
show at most 20 IDs plus a remaining count, without dropping the accumulated
set from state. This is
not a per-model cost breakdown or a guarantee of model diversity across reviews.

New lifecycles and migrated version-1 cost ledgers have
`spend.historyComplete: true`. A version-1 record without `spend` starts with
zero recorded-run counters and `historyComplete: false`: earlier costs are
unknown, not zero. Issue status and newly created PR descriptions qualify those
totals as partial history. The flag remains false through subsequent charging,
repairs, and replanning; no historical backfill or existing PR rewrite occurs.
Existing `job.costedRun` receipts are preserved to prevent charging a completed
run again after migration. Job identities discarded by older controllers and
unknown receipts already marked costed cannot be safely reconstructed from the
aggregate tally. This update does not certify or backfill that earlier history.

Runner time is the sum of each job's start-to-finish duration. GitHub reports
zero billable time for public repositories, so billable minutes cannot be used.

Credits and the pre-emption flag come from a `sdlc-cost` artifact written by a
workflow post-step, not by the agent, so an agent cannot understate its own cost.
The post-step reads the compiler's `parse-mcp-gateway` outputs, where
`ai_credits_rate_limit_error` records that the firewall proxy refused a further
inference. That distinguishes a run that finished near the cap from one the
limiter actually interrupted, whose result may be incomplete. Because the cap is
applied between inferences rather than mid-request, a pre-empted run can finish
slightly above it. A true pre-emption flag confirms the compiler detected the
limit, but a false flag does not rule out a budget refusal reported instead as an
authentication error. Inspect the archived proxy usage and error records when a
worker returns HTTP 403 after successful inference near the cap; neither that
status code nor the credit total alone establishes the cause.

The runtime policy resolves `maxJobCredits` from `SDLC_AIC_CREDIT_LIMIT`, with
the checked-in policy providing the default of `250`. New cost artifacts also
include the `creditLimit` captured by the workflow's budget job. A run is
classified as near-limit at 80% of its recorded cap, unless it was pre-empted.
If an older artifact lacks this field, the controller falls back to its current
resolved limit. Changing the repository variable does not retroactively change
stored counters, and status separates near-limit counts from the current cap.
The artifact format remains backward-compatible; no lifecycle migration is
required. The custom cost artifact still measures primary-agent inference only.

Cost receipts represent unavailable usage and stop signals with `null` rather
than numeric zero or boolean false. Missing, expired, duplicate, or oversized
agent receipts produce unknown telemetry; malformed receipt content is still
rejected. Deterministic scan, validation and integration jobs have known zero inference
usage. Unknown credits or stop signals remain pending until recovery or expiry.
Unrecoverable telemetry sets `historyComplete` false; later successful settlement
never clears an existing incomplete-history flag. Only measured credits with
`preempted: false` contribute to the near-limit
counter, and only `true` contributes to the pre-emption counter.

For a failed workflow or unknown/pre-empted telemetry, the controller publishes
per-attempt diagnostics with the registered stage, job, commits, plan, run link,
cap, measured duration, and available usage/stop signals. Failed Security
checkpoints are displayed only after normal result-identity and change-policy
validation and are never accepted as evidence. Telemetry remains observational:
a successful run with a valid `pass` is not rejected solely for pre-emption.
A controlled, authorized live signal test is required before introducing such
a gate; being near the cap alone must not invalidate a completed review.

### Retention and Limits

| Control | Current value |
| --- | --- |
| Tasks per plan | 6 |
| Automatic repair rounds | 2 |
| Dispatch attempts per job | 2 |
| Consecutive infrastructure failures before blocking | 2 |
| Total registered jobs per lifecycle | 40 |
| Approved execution steps per split task | 2 to 12; original acceptance criteria retained |
| Automatic attempts per recovery fingerprint | 2; coding repairs also consume the shared repair budget |
| Recovery records and amendment decisions | Up to 40 of each |
| Retained draft or maintenance proposal changes | Up to 300,000 serialized bytes each |
| Recovery transition and persisted state size | 900,000-byte transition check; 1,000,000-byte write limit |
| Deferred cost collection window | 90 minutes from first deferral |
| Retained usage history | Up to 100 registered jobs; up to 20 models per receipt |
| Changed files per proposal | 30 |
| Total proposed text bytes | 512,000 |
| AI credits per inference job | `SDLC_AIC_CREDIT_LIMIT`, default 250 |
| Agent execution timeout | 30 minutes |
| Agent job timeout | 45 minutes |
| Controller timeout | 15 minutes |
| Agent and threat-detection caps | Configured limit applied separately to each job |
| Worker evidence artifact retention | 14 days requested |

Limits come from [policy](../.github/sdlc/policy.json), the workflow sources,
and the validated `SDLC_AIC_CREDIT_LIMIT` repository-variable override.
State history and issue/PR summaries retain evidence links, not perpetual copies
of expired artifacts. The usage ledger retains captured accounting fields, not
raw prompts, responses, or token logs. Actions minutes and aggregate inference usage need
separate billing controls.

## Trust Boundaries and Scope

The controller's App key belongs only to the `sdlc-controller` environment.
Agent inference credentials belong to `sdlc-agent`; they do not grant the
controller's repository publishing authority. The CodeQL job has scoped
`security-events: write`, but no controller App token and no candidate build.
Candidate tests run in separate jobs without publishing credentials.

File policy is enforced outside the model: only coding, testing, and documentation
may return feature edits in `report.changes`. Testing is limited to
`policy.testPaths`; documentation is limited to `policy.docsPaths`. Protected automation paths,
baseline tests, unsafe paths, case-colliding path segments, symlinks, binary
data, oversized changes, and conflicting branch history are rejected. Maintenance
uses the separate `maintenanceChanges` proposal field, not feature-edit authority;
its draft PR requires an explicit writer command. Worker role instructions provide
behavioral guidance; merely reading a role profile does not create a separate
operating-system permission boundary between roles.

Compiler-generated agent post-processing has no issue, content, pull-request,
check, deployment, package, or security-event write permission. Its isolated
`actions: write` grant is used only by pinned framework code for the daily
AI-credit cache; agent-selected safe outputs cannot use it for repository
mutation. Plan and evidence Markdown is treated as untrusted and issue-closing
keywords are neutralized before the controller builds the final PR.

The current prototype does not implement parallel coding integration, automatic
rebasing, cross-repository changes, deployment, automatic merging, or a Projects
dashboard. The public-preview agent runtime and all live permissions still
need a bounded pilot. Local fixtures and tests validate controller behavior;
they cannot guarantee model correctness or prove service-side configuration.
