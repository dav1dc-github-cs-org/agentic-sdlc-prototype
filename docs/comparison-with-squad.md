# Comparison with Squad

**This repository is delivery-pipeline-first; Squad is persistent-team-first.**
This repository centers on controlling how an approved change reaches a reviewable
PR. [Squad](https://github.com/bradygaster/squad) centers on maintaining a reusable
team of specialists that can plan and execute work across projects and sessions.

That distinction is useful, but **"strict controller versus loosely coordinated
agents" would misrepresent current Squad**. Its GitHub Actions integration includes
substantial deterministic approval, provenance, and review controls.

## Comparison Scope

This assessment was made on **2026-10-23**, using documentation and implementation
code from:

- This repository at commit
  [`42d6b84`](https://github.com/dav1dc-github-cs-org/agentic-sdlc-prototype/tree/42d6b84e4c10c245a4bcc41edabe92a844084326).
- Squad's default `dev` branch at commit
  [`f22847a`](https://github.com/bradygaster/squad/tree/f22847a9898d5c90d70a679ee63d9d5f49cd5fed).

Squad's development branch may differ from a released installation. The comparison
distinguishes its general interactive team model from its GitHub Actions delivery
path. It is an architectural assessment, not a measured comparison of speed,
cost, reliability, or generated-code quality.

## Side-by-Side

| Dimension | This repository | Squad |
| --- | --- | --- |
| **Primary abstraction** | A lifecycle for delivering one approved feature. Agents fill specific stages. | A persistent team: roster, specialist charters, routing rules, shared decisions, and individual histories. |
| **Orchestration** | A deterministic TypeScript controller chooses transitions, registers jobs, accepts results, and publishes changes. Workers cannot choose their own lifecycle progression. | Coordination combines routing code, agent judgment, and host-specific delegation. Its Actions workflows add deterministic controls at activation, publication, and review boundaries. |
| **Planning** | Research proposes a versioned, hashed plan. Explicit human approval precedes decomposition and implementation. Scope changes require revision or an approved amendment. | Offers research, triage, program planning, implementation planning, validation, acceptance, and activation. Fast paths combine stages; granular paths separate strategic scope approval from task-plan approval. |
| **Delivery unit** | Sequential tasks accumulate on one feature branch. The final feature PR appears only after integrated gates pass. | The Actions epic workflow creates a branch and draft PR per task, with up to three active implementation PRs. Merges release capacity and unblock dependent work. |
| **State and memory** | Authoritative JSON on `sdlc-state` records approval, jobs, evidence, recovery, and costs. Each role executes fresh with explicit context. | Persistent specialist knowledge and team decisions are first-class. State can live in working-tree files or optional Git-backed storage; Actions planning also uses structured issue artifacts. |
| **Quality model** | A prescribed pre-publication sequence: scanners, independent security assessment, independent test preparation, deterministic execution/coverage, documentation, and integrated review. | Workers run relevant project checks, then an independent PR-review workflow enforces a current-head verdict. This is not the same fixed, integrated six-stage pre-PR evidence contract. |
| **Recovery** | Classifies failures and bounds retries, repairs, continuations, amendments, and baseline maintenance. Authority determines which remedies are permitted. | Includes review reassignment/escalation, watch-loop recovery, merge-driven continuation, retrospectives, and guarded activation recovery. Mechanisms vary by execution mode. |
| **Scope** | Deliberately narrow: one GitHub repository, Actions-hosted execution, Node.js/TypeScript validation, sequential coding. | Broader framework: interactive hosts, CLI/SDK integration, portable teams, multiple language ecosystems, and an Actions delivery path. |

Sources: [this repository's architecture][local-architecture],
[Squad planning][squad-planning], [Squad implementation][squad-implementation],
[Squad memory][squad-memory], and [Squad state backends][squad-state].

## The Three Most Consequential Differences

### Integrated Feature Gates Versus Task PRs

Consider a feature involving an API, UI, and tests.

**In this repository**, tasks build up one candidate. The controller evaluates the
integrated result before opening the feature PR. Dependencies become ready when
predecessor tasks are implemented, not when separately merged.

**In Squad's Actions path**, independent tasks can become separate PRs concurrently.
Human review and merging are part of the progression through the task graph.

The tradeoff is **integrated assurance versus incremental delivery**. This
repository's approach provides one final review unit and a clear whole-feature
gate, but delays PR feedback and limits concurrency. Squad provides smaller,
earlier review units, but integration confidence depends more on task boundaries
and repository CI. Neither inherently produces better code.

### Authorization and Evidence Versus Accumulated Knowledge

This repository's controller answers questions such as:

> Which plan authorized this job, and does its evidence apply to this exact
> candidate?

Squad's persistent team additionally answers:

> What has this specialist learned, and which decisions should the whole team
> remember?

These are complementary capabilities. Fresh workers and explicit inputs reduce
dependence on conversational history; persistent knowledge can reduce repeated
discovery and preserve architectural reasoning.

Crucially, **memory should inform work, not authorize it**. A remembered decision
should not substitute for a current approval or passing evidence.

### An End-to-End Evidence Contract, Not Simply Gates

The distinctive strength of this repository is its explicit contract between
implementation, validation, and publication. The
[lifecycle implementation][local-evidence] makes this concrete:

- `assertCurrentResult` checks the registered job, source SHA, run ID, trusted
  revision, plan, and execution breakdown.
- `recordChange` clears previous gate evidence when the candidate changes.
- `assertPublishable` requires current-head evidence for every required stage.

However, Squad also implements real controls. Its
[activation writer][squad-activation] freezes and validates the selected plan,
and its [review guard][squad-review] binds verdicts to exact
PR/base/head/workflow/run identities and rejects self-review attribution. It is
**not merely asking an agent to obey a checklist**.

Both Actions approaches separate agent reasoning from privileged publication,
protect governance paths, and retain human review and merge responsibility.
Neither establishes correctness merely by having an independent agent review.

## Assessment

**Keep this repository's controller as the foundation if the objective is a
tightly bounded, auditable issue-to-feature pipeline.** Squad is the more natural
foundation if the objective is a general-purpose AI engineering team with
persistent expertise, flexible delegation, and incremental parallel delivery.

The most valuable ideas to borrow are Squad's **durable specialist knowledge,
configurable expertise routing, and richer planning decomposition**, without
letting those mechanisms replace this repository's approval and evidence checks.
Parallel execution could follow, but only with explicit integration and
evidence-invalidation rules.

In short: **Squad offers a richer model of the team; this repository offers a more
prescribed contract for delivering the integrated change.**

[local-architecture]: https://github.com/dav1dc-github-cs-org/agentic-sdlc-prototype/blob/42d6b84e4c10c245a4bcc41edabe92a844084326/docs/architecture.md
[local-evidence]: https://github.com/dav1dc-github-cs-org/agentic-sdlc-prototype/blob/42d6b84e4c10c245a4bcc41edabe92a844084326/src/lifecycle.ts#L305-L353
[squad-planning]: https://github.com/bradygaster/squad/blob/f22847a9898d5c90d70a679ee63d9d5f49cd5fed/docs/src/content/docs/guide/gh-aw.md#research-and-planning
[squad-implementation]: https://github.com/bradygaster/squad/blob/f22847a9898d5c90d70a679ee63d9d5f49cd5fed/docs/src/content/docs/guide/gh-aw.md#implementing-issues
[squad-memory]: https://github.com/bradygaster/squad/blob/f22847a9898d5c90d70a679ee63d9d5f49cd5fed/docs/src/content/docs/concepts/memory-and-knowledge.md
[squad-state]: https://github.com/bradygaster/squad/blob/f22847a9898d5c90d70a679ee63d9d5f49cd5fed/docs/src/content/docs/features/state-backends.md
[squad-activation]: https://github.com/bradygaster/squad/blob/f22847a9898d5c90d70a679ee63d9d5f49cd5fed/docs/src/content/docs/guide/gh-aw.md#deterministic-activation-and-no-create-recovery
[squad-review]: https://github.com/bradygaster/squad/blob/f22847a9898d5c90d70a679ee63d9d5f49cd5fed/workflows/shared/squad-review-guard.mjs#L57-L102
