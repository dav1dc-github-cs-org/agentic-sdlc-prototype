# [Feature] Portable Chess Practice: local play and a basic computer

## Objective

Build a small, untimed chess web app for two people sharing a device or one
person practicing against a basic computer. Keep standard chess move legality,
a usable board, turn/result feedback, move history, undo, and board flip. Deliver
static files that work on an ordinary web host without accounts or services.

This is a revised draft for a new feature request after issue #27 was closed.
It replaces the earlier 28-requirement draft, rather than retrying its unmet
toolchain prerequisites. Requirements below use a new numbered baseline. It does
not reopen #27, approve a plan, publish an issue, or change repository policy.

### Scope Changes for This Pilot

- Keep local two-player and human White/Black versus computer modes.
- Use one basic practice opponent that selects from the rules library's legal
  moves. It is deliberately weak, not Stockfish or a rated/search-based opponent.
  Difficulty levels and an advanced engine are deferred, not implied features.
- Explicitly permit the pinned, license-bearing JavaScript rules files listed
  below as application source. This replaces the old blanket ban on vendoring.
  No package installation, manifest, lockfile, or workflow change is required.
- Use the existing TypeScript compiler and a small Node-standard-library copying
  script for packaging, not a new framework, bundler, or release pipeline.
- Existing Node tests and deterministic gates remain mandatory. Browser checks
  are explicit human PR-review requirements, not new automated pipeline gates.
- Defer saved games, PGN import/export, resignation, agreed draws, clocks, and
  difficulty settings. Refresh starts a fresh local game. Game state stays in
  memory; no persistence, migration, or cross-device contract is needed.

The tradeoff is intentional: a smaller playable chess pilot using current
tooling, not the earlier full-featured product. The source dependency still needs
normal plan/license/security review. Its inclusion is not permission to bypass
scanners, exceed budgets, or import arbitrary third-party code.

## Acceptance Criteria

### User Scenarios and Testing

**P1: Play locally.** Given a fresh page, White selects e2 then e4. The pawn
moves once, Black becomes the side to move, and history shows `1. e4`. An illegal
e7-e4 attempt changes neither board, turn, nor history. No start screen intervenes.

**P1: Play the computer.** Given a new Computer game with the human as White,
after e4 the computer makes exactly one legal Black move and waits. With the
human as Black, the computer makes the first White move. The human cannot move
the computer's pieces. Both modes work without external network calls after load.

**P1: Finish a game.** In Local mode, playing `1. f3 e5 2. g4 Qh4#` produces
Black's checkmate win and locks further board moves. Undo removes Qh4#, clears
that ending, and returns Black's turn. New game resets the board and history.

**P1: Cancel a queued reply.** In Computer mode, after the human's e4 but
before the computer callback runs, Undo restores the initial position. Invoking
that old callback later, even twice, cannot change the restored game.

**P2: Use the portable output.** Build, copy only the output folder outside
the repository, and serve it at `/` and `/demo/chess/`. In each location the page,
rules, controls, and pieces load. Disconnect the network after readiness and
play, undo, flip, and start a game in either mode without requesting more assets.

**P2: Use keyboard and touch.** Make a legal move with keyboard only, then
with touch. Resize and flip the board without losing state. Focus remains
visible, buttons remain reachable, and no square is obscured or clipped.

### Functional Requirements

**REQ-001: Immediate game.** Start in Local two-player mode with the standard
32-piece position, White to move, and White at the bottom. h1 is light. Show
coordinates, current mode/side to move, move history, New game, Undo, and Flip.
The first screen is the board, not a landing page, tutorial, or sign-in screen.

**REQ-002: Move selection.** Only a human-controlled piece of the side to move
can be selected. Show its legal destinations, distinguishing captures. Selecting
it again or pressing Escape clears selection; another friendly piece replaces
selection. An illegal target retains selection and announces the invalid action
without changing committed state. Distinguish selection, last move, and check
without relying on color alone. Dragging is optional, never required.

**REQ-003: Legal chess.** Use the pinned rules library as the single authority
for legal moves, captures, king safety, check, and position history. Do not
reimplement move generation or allow a move that leaves one's king in check.
Kings are never captured. UI actions, computer choices, and tests use the same
application state owner; the board view does not maintain a second rules engine.

**REQ-004: Special moves.** Support both castling sides for both colors,
including lost rights and check/transit restrictions. Support en passant only
on the immediately eligible turn and only when the moving king remains safe.
Human promotion offers queen, rook, bishop, and knight before committing;
Cancel/Escape leaves the pre-move state unchanged and restores focus. Other
game-changing controls are unavailable until promotion is resolved. Computer
promotion uses the full legal move selected by the library, without a dialog.

**REQ-005: Results.** Announce check and the side to move. End on checkmate,
stalemate, insufficient material, threefold repetition, or the fifty-move rule,
with a specific reason and `1-0`, `0-1`, or `1/2-1/2`. Evaluate checkmate first,
then stalemate, material, repetition, and fifty-move in that order. Use the
library's history-aware repetition and half-move counters, not a board-image
comparison. Material draws cover bare kings, king plus a lone bishop/knight
versus king, and bishops-only positions with all bishops on the same square
color; two knights versus king is not automatically drawn merely because mate
cannot be forced. For this casual pilot repetition and fifty-move draws are
automatic, not claim-based; do not claim full tournament adjudication or general
dead-position detection. Ending locks board moves, not Undo, Flip, or New game.

**REQ-006: Move history.** Display the committed main line in the library's
Standard Algebraic Notation (SAN), grouped by move number. Captures, castling,
promotion, checks, and mate are represented correctly. History, turn, last-move
marker, and result always agree with the board. Selecting a piece adds no move.

**REQ-007: Basic computer.** Computer mode offers human White or Black and
one level labelled `Basic computer`. Select uniformly from the current legal
move list, including complete promotion choices, using a supplied random value
in `[0, 1)`. Production may use `Math.random`; Node tests supply fixed values.
The computer performs no minimax, evaluation search, remote inference, or
prediction of human moves. No second engine, worker, WebAssembly, engine data,
or difficulty dependency is required. This is a legal-move practice partner,
not a strong opponent; make no Elo or tactical-strength claim.

**REQ-008: One current reply.** Queue at most one computer callback for a
foreground ongoing game on the computer's turn, including its opening move when
the human is Black. Expose a brief computer-turn status and disable human board
moves for that turn, but keep other applicable controls responsive. Do not run
a continuous loop. Bind the callback to its game instance, position revision,
and request identity; accept it once only while all still match. Revalidate the
selected move through the rules library before committing. Invalid/duplicate
human events or stale callbacks never partially update board, history, or result.

Cancel and invalidate queued replies before undo, opening New game, or disposing
of the game. Pause replies while a dialog is open or the page is hidden; resume
one fresh callback when appropriate. An old reply is ignored even if its move
would be legal in the replacement position. No reply occurs after game over.
Unexpected chooser errors preserve state and show a bounded error with Retry,
Undo where applicable, and New game; no retry loop or invented move/result.

**REQ-009: Undo.** In Local mode remove one half-move. In Computer mode
restore the position immediately before the most recent human move, removing
that move and any following computer reply, so the human can choose again.
Disable Undo with no prior human move in Computer mode, including after the
computer's opening White move. Cancel outstanding replies first. Restore all
rights, captures, promotion, counters, repetition history, turn, and result.
Undoing a terminal move re-evaluates the restored position. There is no redo;
a subsequent move replaces the undone continuation.

**REQ-010: New game and flip.** New game offers Local or Computer, and human
White/Black for Computer. It defaults to the current settings; the first Computer
choice defaults to human White. Confirming explicitly discards the old game,
starts the standard position, and orients Computer games toward the human.
Local games preserve the prior orientation. Cancel preserves committed state
and resumes one pending computer turn if needed. Settings never change midway
through a game. Flip rotates only the view and coordinates; pieces/text stay
upright, selection clears, and turn/human ownership/history never change.
Do not auto-flip after turns. Flip alone does not invalidate a current reply.

**REQ-011: Accessible responsive board.** Use stable square board dimensions,
eight equal rows/columns, contrasting squares, and recognizable original SVG
piece artwork stored as text. No external images, fonts, or platform-dependent
chess glyphs. Provide one tab entry to the board, visual-direction arrow-key
navigation, Enter/Space activation, Escape cancellation, and normal Tab exit.
Expose square names, piece/color, selection, and legal targets to assistive
technology. Announce moves, turn, check, errors, and results without stealing
focus. Dialogs have names, contained focus, and focus restoration. Use visible
focus and contrast of at least 4.5:1 for normal text and 3:1 for controls/focus.

At 320, 390, 768, and 1280 CSS pixels and 200% text zoom, no horizontal scrolling,
overlap, or clipped controls/labels. Vertical scrolling is fine. Non-board
controls are at least 44 by 44 CSS pixels and board squares at least 32 pixels
at the narrowest viewport. Keep history beside or below the board as space
permits. Resizing preserves the game; reduced-motion settings are respected.

**REQ-012: Privacy and session behavior.** Keep game state only in page memory.
Refresh starts a new Local game; do not claim save/resume. No cookies, browser
persistence, analytics, accounts, uploads, permissions prompts, or external
runtime requests. After the app's own static assets load, both modes, undo, flip,
and new game continue after network loss. Cold-start/offline reload, PWA install,
and direct `file://` opening are not required. Render data as text or trusted
artwork, not executable user-controlled markup.

**REQ-013: Portable build with existing tools.** Use `npm run build` unchanged
and a new Node-standard-library packaging script under `apps/chess/`. The script
copies only compiled chess modules, application HTML/CSS/JS/artwork, and the
pinned vendor files/license into a self-contained folder under `dist/`. It must
not fetch packages, invoke a new bundler, copy controller/test modules, or require
a new manifest, lockfile, or compiler configuration. Document exact commands,
working directories, output paths, entry URL, and a local serving command using
installed tooling or a small Node-standard-library server. No `npx` downloads
are a prerequisite for building, testing, serving, or playing this pilot.

The copied output must work at `/` and `/demo/chess/` on an ordinary static
host. All relative module/asset references stay inside it and match actual output
paths; no runtime imports from the repository, parent build folder, `node_modules`,
CDN, or site-root absolute application paths. No custom routes, headers, secrets,
or cross-origin isolation. An asset/rules load failure displays an explicit
error, not an apparently working board. Generated output is not an agent proposal
or a request for deployment/release automation.

**REQ-014: Automated evidence.** Add discovered Node tests for application
state, all rules examples below, computer choice/cancellation, undo, mode changes,
and package integrity/import resolution. Test the pinned library through the
same application integration used by the browser, not a substitute npm version.
Use fixed random values and controlled scheduling for computer tests. Assertions
state expected outcomes independently; a coverage percentage is not a criteria
map. All authored game behavior belongs in covered TypeScript under `src/chess/`,
with the browser layer limited to DOM/event wiring. Existing coverage thresholds,
baseline non-regression, CodeQL, audit, and secret gates remain unchanged.

**REQ-015: Human browser acceptance.** Browser behavior is checked by a human
before merge, not by adding a required Playwright/Chromium/WebKit workflow. The
final documentation must give exact steps and expected results for the scenarios
below. Record browser/device versions and results when executed; absent tooling
leaves these checks explicitly pending for human review, not falsely passed and
not by itself a research-stage prerequisite. Existing browser tools may provide
additional evidence but must not require installation or workflow changes. No
agent may claim that Node tests or static CSS assertions prove browser behavior.

### Required Automated Examples

FEN fixtures are test inputs, not a public position-editor/import feature. Add
relevant symmetric and negative cases; these are anchors, not exhaustive coverage.

| Requirements     | Position/actions                                                | Expected result                                                                                                           |
| ---------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| REQ-001, REQ-003 | Initial position                                                | 32 pieces, White to move, 20 legal moves; e2 targets e3/e4 and g1 targets f3/h3                                           |
| REQ-002, REQ-003 | Initial position, e2-e5                                         | Rejected; board, turn, and history unchanged                                                                              |
| REQ-003          | FEN `k3r3/8/8/8/8/8/4R3/4K3 w - - 0 1`, e2-f2                   | Rejected for exposing White's king                                                                                        |
| REQ-004          | FEN `r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1`                      | Fresh instances allow O-O and O-O-O; king/rook finish on g1/f1 or c1/d1; Undo restores rights                             |
| REQ-004          | FEN `4kr2/8/8/8/8/8/8/4K2R w K - 0 1`, O-O                      | Rejected because the king would cross attacked f1                                                                         |
| REQ-004          | Initial position, `1. e4 a6 2. e5 d5`, e5-d6                    | En passant removes d5 pawn; Undo restores it and the opportunity; an intervening move expires the opportunity             |
| REQ-004          | FEN `7k/P6p/8/8/8/8/8/7K w - - 0 1`, a7-a8                      | All Q/R/B/N choices work; cancelled human promotion changes nothing; complete computer move needs no dialog               |
| REQ-005, REQ-009 | Local game, `1. f3 e5 2. g4 Qh4#`                               | Black wins `0-1`; moves lock; Undo removes Qh4# and restores Black's turn                                                 |
| REQ-005          | FEN `7k/5Q2/6K1/8/8/8/8/8 b - - 0 1`                            | Stalemate, not checkmate; `1/2-1/2`                                                                                       |
| REQ-005          | FEN `7k/8/8/8/8/8/8/K7 w - - 0 1`                               | Material draw; two-knight-versus-king negative fixture is not declared drawn                                              |
| REQ-005          | Initial position, `1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8` | Third occurrence draws; Undo restores nonterminal prior history                                                           |
| REQ-005          | FEN `7k/8/8/8/8/8/R7/K7 w - - 99 50`, Ra3                       | Counter reaches 100 and fifty-move draw; pawn/capture cases reset the counter                                             |
| REQ-007          | Inject random values 0 and just below 1                         | Select first and last complete legal moves respectively; no out-of-range or illegal move; no choice in terminal positions |
| REQ-008, REQ-009 | Human e4, queued reply, Undo, invoke old callback twice         | Initial position unchanged by stale/duplicate callbacks                                                                   |
| REQ-007, REQ-009 | Computer game, human e4 then controlled e5, Undo                | Both moves removed; human chooses again, no replacement reply queued                                                      |
| REQ-008, REQ-010 | Switch to a new Local game before an old reply runs             | Old reply cannot alter the new game even if the move is legal there                                                       |
| REQ-008          | Hide page or open setup before reply; return/cancel             | Old callback ignored, committed state unchanged, at most one fresh reply resumes                                          |
| REQ-010          | Human Black, Computer starts; Flip during queued reply          | Exactly one White opening move; logical squares and human ownership unchanged                                             |
| REQ-013          | Build/copy fixture outside repo                                 | Entry imports resolve inside copied output, license retained, controller/test files absent, no network required to build  |

### Required Human Browser Scenarios

At PR review, test a current desktop Chromium browser and a current mobile
Safari or Android Chrome browser. Record exact tested versions/devices; do not
claim a complete cross-browser matrix from those two checks.

1. Build and serve the copied output at root and a nested URL. Check that pieces,
   styles, and modules render and there are no console errors, failed requests,
   or external-origin calls. Record the actual working commands and URLs.
2. Play locally with pointer and keyboard, including promotion and the checkmate
   sequence. Verify illegal moves, history, focus, result, and Undo.
3. Start Computer games with each human color. Verify one legal reply per turn,
   correct side selection, and usable controls. Undo/reset during a queued reply
   must not produce a late move. The basic opponent need not play well.
4. Check the listed viewport widths, text zoom, touch input, board flip, and
   selection/status visibility. Capture a readable desktop/mobile screenshot.
5. Disable networking after readiness; play, undo, flip, and start both modes.
   Refresh deliberately starts a new Local game when assets can load; no offline
   reload or preservation claim is made.

These checks remain required before human merge even when all pipeline stages
pass. Report pending checks as pending. This spec does not implement automatic
enforcement of human browser acceptance in the controller.

### Key Entities and Success Criteria

- **Game:** authoritative rules instance, legal history, mode, human color,
  turn, result, and position revision. Identical committed moves replay to
  identical game state; random computer selection itself need not be identical.
- **View:** orientation, selected/focused square, and pending dialog. Viewing
  operations do not mutate game rules or control ownership.
- **Reply:** one scheduled computer choice bound to the current game and revision,
  cancellable and acceptable at most once.
- **Portable output:** only the app, compiled game modules, vendored rules, artwork,
  and redistribution notices, independent of its original repository location.

Success means both modes are playable with legal chess, the automated examples
and existing gates pass at the final commit, packaging works without additional
installed tools, and the documented human checks pass before merge. No stage
claims a browser, security, portability, or quality result it has not established.

## Constraints and Non-goals

- No protected manifest, lockfile, TypeScript setting, controller, workflow,
  agent instruction, existing baseline test, scanner, or coverage-policy edits.
  Never lower thresholds, skip required gates, suppress findings, or claim new
  permissions from the issue text. Research still requires normal plan approval.
- The only newly permitted third-party code is the exact rules-library material
  listed below. Retain its license, record provenance/hashes, and apply existing
  scanners. No runtime CDN dependency or automatic package download/install.
- Do not hand-roll chess legality. The computer is expressly a random legal-move
  practice partner using that library, not a custom search engine. Stronger AI,
  Stockfish, UCI protocols, WebAssembly, workers, ratings, and difficulty levels
  are deferred. Do not silently reintroduce them as implementation requirements.
- No persistence, PGN/FEN import/export UI, resignation/agreed-draw controls,
  clocks, undo trees/redo, cloud services, multiplayer networking, accounts,
  puzzles, tutorials, hints, PWA, native wrapper, or deployment automation.
- Fit at most six coding tasks and the existing 30-file/512,000-byte proposal,
  job, and repair budgets. No binary assets. Keep third-party files isolated and
  unchanged; do not minify or encode them to hide contents or evade limits.

## Context

This document follows the four fields of the
[Agentic Feature form](../.github/ISSUE_TEMPLATE/agentic-feature.yml). It is a
replacement scope for a new issue, not a claim that issue #27's prerequisites
were installed. Do not reopen or retry the closed lifecycle as part of this work.

### Explicit Source Dependency

Use `chess.js` version **1.4.0**, distributed under **BSD-2-Clause**, from the
[versioned npm archive](https://registry.npmjs.org/chess.js/-/chess.js-1.4.0.tgz).
The [official documentation](https://jhlywa.github.io/chess.js/) covers legal
moves, history, undo, draw detection, and an example of random legal-move play.
The published ESM file has no runtime package dependencies. Include only the
following UTF-8 text files under `apps/chess/vendor/`, plus a short provenance
record, using the exact bytes from the archive:

| Archive member                  | Proposed app filename | Bytes  | SHA-256                                                            |
| ------------------------------- | --------------------- | ------ | ------------------------------------------------------------------ |
| `package/dist/esm/chess.js`     | `chess.js`            | 107052 | `76c7c34f0e2e9ab076521a5d6fe786a9cce537bb1b6f29d32a9c9970b5b232d2` |
| `package/dist/types/chess.d.ts` | `chess.d.ts`          | 9163   | `29f09463bf7aedb31c93b4f692b9001eb5529b9dcc52829a1c0d5895e2f2e8f8` |
| `package/LICENSE`               | `LICENSE.txt`         | 1315   | `0b3a3c2b4432a26bb18f9d06f5bba4de015bcc980306b7db28b06025495e2186` |

These sizes and hashes were inspected locally on 2026-09-16, totaling 117,530
bytes before provenance text, not a scanner pass or perpetual compatibility
guarantee. Verify them on retrieval. Do not add the archive, its package manifest,
source map, npm cache, or other package files to the repository. Approved coding
tasks may retrieve these specified files without running package scripts or
installing anything into the project. If the archive is unavailable, bytes differ,
licensing cannot be honored, or security gates reject it, report that concrete
blocker. Do not substitute another version or waive a finding automatically.

This is an explicit change to the draft's application dependency requirements,
not an exception to protected paths. The current
[change validator](../src/changes.ts) allows bounded, unprotected text proposals
from the code stage; `sourcePaths` describes coverage inclusion, not its entire
edit allowlist. The library is not installed in a manifest, so npm audit does
not provide its dependency coverage. Preserve full-source CodeQL/secret checks
and review the pinned component separately; do not claim npm audit scanned it.

### Existing Toolchain and Verification

- Put authored game behavior in `src/chess/**/*.ts`, UI/vendor/packaging sources
  in `apps/chess/`, new discovered Node tests in `test/chess/**/*.test.ts`, and
  launch/verification documentation in allowed documentation paths. Use the
  existing [compiler](../tsconfig.json), [manifest](../package.json),
  [policy](../.github/sdlc/policy.json), and [validator](../src/validate.ts)
  unchanged. No preparatory workflow or dependency-install task is required by
  this scope; source-library acquisition belongs to the approved feature tasks.
- Preserve relative imports when packaging. One feasible layout copies compiled
  `src/chess/` and static `apps/chess/` beneath the portable folder, with a root
  HTML entry that loads the nested app module. A TypeScript game module can then
  import `../../apps/chess/vendor/chess.js`, with its adjacent declaration file,
  both in source and in the copied output. Verify the actual final layout rather
  than assuming a build directory is reachable from a differently rooted server.
- Node package tests should compile/copy into temporary output and verify the
  same entrypoint/import layout used by the browser, with no live GitHub calls.
  All authored game logic remains covered; vendored JavaScript is not a reason
  to move new application behavior outside the fixed source-coverage patterns.
- Run `npm ci --ignore-scripts` and `npm run verify` with the existing lockfile,
  plus focused game/package tests. The hosted SDLC validator directly runs Node
  tests, so package/import verification must be discoverable through those tests,
  not only through an unused custom npm command. Preserve baseline non-regression.
- Research should assess this revised scope, not restore the earlier mandatory
  engine/bundler/browser-tooling prerequisites. Missing optional browser tooling
  is handled by the named human checks in REQ-015. Genuine rule, license, security,
  compatibility, or budget blockers still require an honest `blocked` report.
  This draft removes the known tooling contradiction; it cannot guarantee that
  every future run or review will pass.
