# Target Repository Setup

This guide registers another repository, the *target*, with this control plane.
Once a target is enabled, a writer applies the intake label to an issue in the
target, everyone uses `/sdlc` commands in comments on that issue, and the
pipeline publishes the feature branch, final PR, and `SDLC / Complete` check in
the target. State, workers, and both App keys stay in this repository; the
target receives only a secret-free caller workflow.

[Registered Targets](operations.md#registered-targets) describes the moving
parts, and [Cross-Repository Intake](architecture.md#cross-repository-intake)
and [Target Execution](architecture.md#target-execution) describe how receipts
are authenticated and how target source reaches workers.

> [!IMPORTANT]
> Targets have not yet completed a live pilot. Register one disposable target
> first and run the [pilot](#8-run-a-pilot) before onboarding real work.

## What the Scripts Do

Two scripts in [`scripts/`](../scripts) automate the checks and the routine
changes:

| Script | Purpose |
| --- | --- |
| [`sdlc-target-setup.sh`](../scripts/sdlc-target-setup.sh) | Checks a target, then on `--apply` makes the changes needed to register, enable, re-pin, or disable it |
| [`sdlc-target-verify.sh`](../scripts/sdlc-target-verify.sh) | Read-only check that a registered target is ready for intake |

Without `--apply`, the setup script only sends `GET` requests and prints a plan.
With `--apply`, it first runs the same checks as a plan; if any check fails it
changes nothing. Re-running it is safe: it reuses its branch and pull request
and skips changes already made.

To preview the output without contacting GitHub, record the test suite's runs
against its fake `gh`:

```sh
SDLC_SCRIPT_TRANSCRIPTS=/tmp/sdlc-transcripts.md node --test test/target-scripts.test.ts
```

With `--apply` it can:

- set the Actions access level of this repository so the target may call its
  receipt workflow;
- add the target to an existing Controller App or Reader App installation;
- create the intake label in the target, or fix its letter case;
- commit the rendered caller to a branch in the target and open a pull request;
- edit the local registry file, `.github/sdlc/targets.json`.

It never creates or configures Apps, keys, environments, or branch rules; never
pushes to this repository; never merges anything; and never changes
`SDLC_ENABLED`. Registry edits take effect only after you merge them into this
repository's default branch.

Both scripts and their library are protected paths in the
[policy](../.github/sdlc/policy.json) and are covered by
[CODEOWNERS](../.github/CODEOWNERS), because operators run them with
administrator credentials. Pipeline agents cannot edit them.

## Before You Start

You need:

- This repository already set up and working for its own issues: steps 1 to 4
  of [GitHub Setup and Operations](operations.md), including the `sdlc-reader`
  environment.
- Administrator access to both this repository and the target. Installing an
  App on an organization may also need an organization owner.
- The [GitHub CLI](https://cli.github.com) signed in with the `repo`,
  `read:org`, and `workflow` scopes. Writing a workflow file in the target needs
  `workflow`:

  ```sh
  gh auth login
  gh auth refresh -s workflow
  ```

- [jq](https://jqlang.org) 1.6 or newer and Bash 3.2 or newer. The macOS system
  Bash works.
- A checkout of this repository's default branch, up to date, to run the
  scripts from. The scripts read the policy and caller template from the default
  branch on GitHub, not from your working tree.

Every command takes `--target OWNER/REPO`. The control repository defaults to
this checkout's `origin` remote; pass `--control OWNER/REPO` to override it.

## 1. Check Fit

### Visibility

The target must have the same visibility as this repository. Two rules combine
to require that:

- The controller refuses a target that is less visible than this repository,
  because issue text, plans, logs, and source bundles from the target are
  mirrored into this repository's state and Actions runs.
- GitHub lets a repository call a reusable workflow in a private or internal
  repository only when the caller is no more visible than the callee. A public
  target cannot call a private or internal receipt workflow, and an internal
  target cannot call a private one.

For a private or internal control repository, the Actions access level under
**Settings > Actions > General > Access** must also reach the target:

| This repository | Allowed targets | Access level |
| --- | --- | --- |
| Public | Public repositories | Not applicable |
| Internal | Internal repositories in the same organization | Organization or enterprise |
| Internal | Internal repositories in another organization of the same enterprise | Enterprise |
| Private, organization-owned | Private repositories in the same organization | Organization or enterprise |
| Private, organization-owned | Private repositories in another organization of the same enterprise | Enterprise |
| Private, user-owned | Private repositories of the same user | User |

The setup script checks the visibility and raises the access level when
needed. Raising it lets workflows in those repositories call any reusable
workflow in this repository. A caller never receives this repository's secrets,
variables, or environments, but anyone who can read a caller's Actions runs,
including outside collaborators, can read the called workflow's logs.

Matching visibility does not prove matching audiences: two private repositories
can have different readers. Register a target only after confirming that
everyone who can read this repository may read the target. Use a separate
control plane for a target with a narrower audience. See
[Exposure and Trust Domains](operations.md#exposure-and-trust-domains).

### Stack, Policy, and CI

Review [Target Requirements](operations.md#target-requirements): the target
must use the supported Node.js and TypeScript stack and fit this repository's
policy, the source bundle must stay under 256 MiB, and CodeQL licensing must
cover scanning it here. Then review the target's own workflows against
[Target CI](operations.md#target-ci), because pipeline pushes and pull requests
trigger them.

### Actions Policy in the Target

The receipt workflow runs in the target and uses `actions/upload-artifact`. The
target's Actions policy must allow GitHub-authored actions and, when the target
has a different owner from this repository, this repository's receipt
workflow. The script checks the repository-level policy; organization and
enterprise policies can restrict it further.

## 2. Install the Apps

Install both Apps on the target under **Only select repositories**:

- **Controller App:** the App in `SDLC_APP_ID`, with the permissions in
  [Create a Controller App](operations.md#1-create-a-controller-app). The
  controller requests only Actions read and Checks, Contents, Issues, and Pull
  requests write for a target.
- **Reader App:** the App in the `sdlc-reader` environment's
  `SDLC_READER_APP_ID`, with only Contents read. See
  [Reader App](operations.md#reader-app).

If the target belongs to a different account than this repository, both Apps
must allow installation on any account: in each App's settings, open
**Advanced** and choose **Make public**. A private App can be installed only on
its owner's account. Then install it from `https://github.com/apps/<app-slug>`
and pick the target's account.

If an App is already installed on the target's account, the setup script adds
the target to that installation. Adding a repository needs administrator access
to it, and GitHub may refuse the request for some token types; the script then
tells you to add it under **Settings > GitHub Apps > Configure** instead. If your
token cannot list installations at all, the script warns and you confirm both
installations by hand. Pass `--skip-apps` to skip these checks entirely.

## 3. Dry Run

From an up-to-date checkout of this repository's default branch:

```sh
git switch main
git pull --ff-only
scripts/sdlc-target-setup.sh --target octo-org/app
```

The script prints a section per check:

| Marker | Meaning |
| --- | --- |
| `[ok]` | The check passed |
| `[note]` | Information to confirm or act on manually |
| `[warn]` | Something the script could not prove or recommends changing; does not block |
| `[FAIL]` | A blocking problem; see [Troubleshooting](#troubleshooting) |
| `[plan]` | A change `--apply` would make |
| `[apply]` | A change being made |

It checks, in order: the target's identity and settings, visibility and
workflow access, the target's Actions policy, this repository's App IDs and
keys, the receipt pin, both App installations, the intake label, and the caller
workflow. Finally it plans the registry entry.

The receipt pin defaults to the head of this repository's default branch for a
new target, or to the registered pin for an existing one. Pass
`--receipt-ref <sha>` to choose a specific commit on the default branch.

Exit status is 0 when nothing failed, 1 when a check failed, and 2 on a usage
error.

## 4. Apply

Resolve every `[FAIL]`, then run:

```sh
scripts/sdlc-target-setup.sh --target octo-org/app --apply
```

The script prints the plan, applies it, and prints the next steps. It opens a
pull request in the target from the branch `sdlc/intake-<first 12 characters of
the pin>` that adds `.github/workflows/sdlc-intake.yml`, and adds a disabled
entry to `.github/sdlc/targets.json` in your checkout:

```json
{
  "id": 123456789,
  "repository": "octo-org/app",
  "enabled": false,
  "activatedAt": "2026-09-01T00:00:00Z",
  "intake": {
    "workflow": ".github/workflows/sdlc-intake.yml",
    "receiptRef": "<40-character commit SHA>"
  }
}
```

The entry records the numeric repository ID, so a renamed or recreated
repository cannot inherit the registration.

## 5. Merge Both Changes

1. **Target pull request.** Review and merge it in the target without editing
   the file. The controller compares the caller on the target's default branch
   with its own rendering byte for byte, ignoring only line endings; any other
   edit makes every receipt fail authentication.
2. **Registry pull request.** Commit the registry change here and open a pull
   request for code-owner review:

   ```sh
   git switch -c register-octo-org-app
   git add .github/sdlc/targets.json
   git commit -m "Register octo-org/app as an SDLC target"
   git push -u origin register-octo-org-app
   gh pr create --fill
   ```

The order does not matter while the entry is disabled.

## 6. Verify

After both pull requests merge, update your checkout and run:

```sh
git switch main
git pull --ff-only
scripts/sdlc-target-verify.sh --target octo-org/app
```

Verification sends only `GET` requests. It repeats every setup check, requires
the caller on the target's default branch to match the registered pin, and
warns when the registry on this repository's default branch differs from your
local file. It exits 0 when the target is ready.

## 7. Enable

```sh
scripts/sdlc-target-setup.sh --target octo-org/app --enable
scripts/sdlc-target-setup.sh --target octo-org/app --enable --apply
```

`--enable` repeats the verification and refuses to continue if anything fails.
It then sets `enabled` to `true` and `activatedAt` to the current time; label
events from before then are never accepted. Commit the registry change through
a pull request as in step 5. Intake starts when it merges: the controller scans
targets every 10 minutes, or run the controller manually with the `target` input
set to the repository ID to scan it at once.

While any target is enabled, the controller's Node step receives
`SDLC_APP_PRIVATE_KEY` so it can mint target tokens.

## 8. Run a Pilot

Run the [bounded pilot](operations.md#5-run-a-bounded-pilot) against a
disposable target issue, then also confirm that:

- applying the label creates a receipt run in the target and, within one
  controller scan, a lifecycle comment on the target issue;
- a label applied by a user without write access is ignored;
- `/sdlc` commands on the target issue are honored, and commands on this
  repository's issues do not affect the target lifecycle;
- the feature branch, final PR, and `SDLC / Complete` check appear in the
  target, and the target's own CI behaves as reviewed.

## Upgrading the Receipt Pin

Move the pin after the receipt workflow changes here, or to adopt a newer
reviewed revision:

```sh
scripts/sdlc-target-setup.sh --target octo-org/app --receipt-ref default --apply
```

This opens a new caller pull request in the target and moves the pin in your
registry file. Merge the two close together: while the caller and the registry
disagree, receipts fail authentication and labels applied in that window are
rejected. Reapply the label to any such issue afterwards. Run the verify script
once both have merged.

## Disabling and Removing a Target

To pause intake:

```sh
scripts/sdlc-target-setup.sh --target octo-org/app --disable --apply
```

This edits only the local registry and makes no GitHub calls. Merge the change
through a pull request. Disabling freezes the target's lifecycles in place, and
re-enabling resumes them.

To remove a target, disable it and let in-flight lifecycles finish or close
their issues. Then delete its registry entry through a pull request, delete
`.github/workflows/sdlc-intake.yml` and the label from the target, remove the
target from both App installations, and lower this repository's Actions access
level if no other target needs it. State already recorded under
`targets/<id>/` on the `sdlc-state` branch remains as history.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `A <visibility> control repository refuses a <visibility> target` | The target is less visible than this repository. Use a control plane with the target's visibility. |
| `A <visibility> target cannot call a reusable workflow in a <visibility> repository` | The target is more visible than this repository. Use a control plane with the target's visibility. |
| `A private repository owned by a user shares workflows only with that user's repositories` | Move this repository to an organization, or use a control plane owned by the target's account. |
| `Cannot read the Actions access level` | Run the script as an administrator of this repository. |
| `<target> allows only <owner> actions` or `must allow actions created by GitHub` | In the target, under **Settings > Actions > General**, allow actions created by GitHub. |
| `Allow <control>/.github/workflows/sdlc-intake-receipt.yml@*` | In the target's allowed actions, add that pattern or confirm an existing one covers it. |
| `Repository variable SDLC_APP_ID is missing`, `Secret ... is missing`, or `Environment sdlc-reader ... is missing` | Finish [steps 1 and 2](operations.md#1-create-a-controller-app) of the operations guide. |
| `The Reader App must be a separate App` | Create a separate [Reader App](operations.md#reader-app). |
| `Pin <sha> is not on the default branch` | Pick a commit on this repository's default branch, or pass `--receipt-ref default`. |
| `The <name> App (<id>) is not installed on <owner>` | [Install the App](#2-install-the-apps) on the target's account. |
| `installation <id> lacks <permission>` | Update the App's permissions, then accept the new permissions on the target's account. |
| `Cannot list App installations with this token` | Confirm both installations by hand, or pass `--skip-apps`. |
| `Could not commit the caller` | Run `gh auth refresh -s workflow`, then run the script again. |
| `differs from the template pinned to <sha>` | Merge the caller pull request unchanged, or run the setup script again to open a fresh one. |
| `a renamed or recreated repository needs a deliberate registry edit` | Confirm the repository is the intended one, then correct or replace its registry entry by hand through a reviewed pull request. |
| Labels have no effect after an outage | Receipts older than 24 hours are not accepted. Remove and reapply the label. |
