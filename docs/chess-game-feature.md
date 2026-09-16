# [Feature] Portable Chess: local and computer opponents

## Objective

Build a complete, untimed chess game for two people sharing a desktop, tablet,
or phone, or one person playing against a local computer opponent. Players
should be able to start immediately, make only legal moves, understand whose
turn it is, finish a game, and resume after an accidental reload.
Deliver the application as a self-contained folder that can be copied to an
ordinary static web host without a backend, account, or external runtime service.

Draft updated 2026-09-16 for requester review, including the requested option
to play against the computer. Other scope choices below remain proposed defaults,
not recorded requester approval. Creating this specification does not authorize
dependency changes, issue creation, deployment, or execution of the agentic pipeline.

### Scope Baseline and Assumptions

- New application; it does not extend the turtle feature or the SDLC controller.
- Casual players who already know basic chess, not a tutorial or tournament site.
- Two modes: local two-player, named White and Black, and one human versus the
  computer. Local two-player is the first-visit default. Computer mode offers
  human color White/Black and Easy/Normal/Hard difficulty; defaults are White
  and Normal. No online opponent in the first release.
- Standard starting position and standard move legality, with the explicit
  automatic-draw policy in REQ-009. This is not tournament-certified software.
- Click/tap and keyboard moves, legal-destination indicators, promotion choice,
  turn/result status, move history, board flip, undo, new game, resignation,
  agreed draw in local two-player mode, one locally saved game, and PGN export
  are in scope. Computer moves are calculated on the playing device, not by a
  remote service or generative AI.
- Portable means a self-contained static release served over HTTP or HTTPS,
  including from a nested URL path. Direct `file://` opening, installable PWA
  behavior, and guaranteed offline reopening are not first-release requirements.
- A game already fully loaded must remain playable after network loss. Local
  saves are browser/origin-specific; copying the app does not copy saved games.

## Acceptance Criteria

### User Scenarios and Testing

**P1: Start and play a legal game.** Given local two-player mode on a first visit
with no saved game,
when White selects e2 and then e4, the pawn moves once, Black becomes the side
to move, and the history records `1. e4`. An attempt to move Black's e7 pawn
to e4 is rejected without changing the position, turn, history, or saved game.

**P1: Complete a special move.** Given a position with a legal promotion,
when the player selects its destination, the game waits for a queen, rook,
bishop, or knight choice. Choosing a knight commits that promotion exactly
once. Cancelling leaves the entire pre-move state unchanged.

**P1: Finish a game correctly.** Given local two-player mode at the standard initial position,
when `1. f3 e5 2. g4 Qh4#` is played, the result is `0-1`, the status identifies
Black's checkmate win, and further board moves are disabled. Undoing the final
move reopens the position with Black to move and removes the result.

**P1: Play against the computer.** Given a new Computer game with the human
playing White, when the human plays e4, a visible thinking state appears and
exactly one legal Black reply is applied. The human cannot move Black's pieces.
Given the human chooses Black instead, the computer makes the opening White
move without requiring a human board action, then waits for the human.

**P1: Cancel an obsolete reply.** Given a Computer game in which the human
has just moved and the engine is thinking, when Undo is activated, the search
is cancelled and the position before that human move is restored. A late reply
from the cancelled search changes neither the board, history, nor saved game.

**P1: Use the distributed app.** Given only the release folder copied outside
the repository and served beneath `/demo/chess/`, when a browser opens that URL,
the board, artwork, rules, and controls load without missing files or requests
outside that folder. After all required assets, including the computer engine,
load, disabling the network does not prevent moves by either side, promotion,
undo, new games in either mode, or PGN export.

**P2: Recover a game.** Given a game with move history and a flipped board,
when the page is refreshed at the same app URL, its committed position, turn,
move history, repetition history, orientation, mode, human color, difficulty,
and any final result are restored. A pending promotion or confirmation is not
restored as a committed action. If it is the computer's turn in an ongoing game,
one fresh search starts from the restored history; an old reply is not replayed.

**P2: Play without a pointer.** Given keyboard focus on the board, when a
player navigates to e2, selects it, navigates to e4, and confirms, the same
move and announcements occur as with a pointer. Board flipping changes visual
navigation consistently but never changes the chess position.

**P2: Restart without accidental loss.** Given a game containing moves,
when the New game setup is opened and cancelled, nothing committed changes.
Confirming starts the selected mode at the standard initial position, clears
history and result, and replaces the single saved game. The previous game is
not retained as a hidden second save.

**P2: Recover from an engine failure.** Given an ongoing Computer game, when
engine initialization or a reply fails, the position and history remain intact,
the waiting state ends with an explicit error, and the human can retry the
computer, undo where possible, export, or start a new game. There is no silent
switch to random moves, a remote engine, or local two-player mode.

### Functional Requirements

**REQ-001: Immediate playable board.** On first visit, show one 8-by-8 board
in local two-player mode with 32 pieces in the standard initial position, White
to move, and White's pieces at the bottom. The lower-right square from White's
view, h1, is light.
Show file/rank coordinates, side to move, move history, and game controls. No
landing page, login, instruction modal, or start button blocks the first move.
A valid saved game replaces the initial position as specified in REQ-015.

**REQ-002: Selection and legal destinations.** Only a piece of the side to
move that is controlled by a human can become selected. Both colors are human
controlled in local two-player mode; only the chosen human color is selectable
in Computer mode, and only on its turn. Selecting a piece reveals all and only its legal target
squares, distinguishing captures. Selecting it again or pressing Escape clears
selection; selecting another friendly piece changes selection. Activating a
nonlegal destination retains the selection, announces that the move is invalid,
and changes no committed game state. Selection, last move, and a checked king
are distinguishable without relying on color alone.

**REQ-003: Chess legality.** Enforce piece movement, blocked paths, captures,
pawn single/double advances and diagonal captures, and alternating turns.
Reject moves that leave or place the moving player's king in check, including
discovered attacks and illegal en passant. Kings are never captured and may
not occupy adjacent squares. Board orientation does not affect legality.

**REQ-004: One activation, one committed move.** A completed destination
activation commits exactly one legal move. Repeated events, rapid double taps,
or mixing keyboard and pointer input must not produce duplicate moves. Position,
turn, history, status, and save state update as one logical operation; invalid
input or cancelled dialogs must not partly mutate them. Computer replies follow
the same commit path and are accepted only for a live current-turn request
(REQ-027). No duplicate or speculative auto-moves, touch-plus-click double
handling, or continuous movement on pointer hold.

**REQ-005: Castling.** Support kingside and queenside castling for both colors.
The king and relevant rook must retain castling rights, intervening squares must
be empty, and the king cannot start in, pass through, or end in check. Castling
moves both pieces in one committed move. Moving a king or rook and moving it
back does not restore rights; capturing a rook does not allow a replacement rook
to acquire its rights. Undo restores the actual prior rights.

**REQ-006: En passant.** Allow a pawn to capture en passant only on the move
immediately after the opposing pawn's qualifying two-square advance, and only
if the capture leaves its own king safe. Remove the captured pawn from its
actual square. An intervening move expires the opportunity. Undo and reload
restore the opportunity exactly when it existed in the saved position.

**REQ-007: Promotion.** A human-controlled pawn reaching its last rank, by
movement or capture, must offer queen, rook, bishop, and knight of the moving
color. Do not silently auto-queen a human move. Until a choice is confirmed,
retain the pre-move position and turn;
other game-changing controls are unavailable. Escape or Cancel dismisses the
choice, clears selection, and returns focus to the origin square. Confirmation
updates the board, history, check/result state, and save exactly once. A computer
promotion uses the engine's explicit legal promotion choice with no human dialog;
an absent or invalid choice is an invalid reply, not permission to auto-queen.

**REQ-008: Check and checkmate.** Announce check with the side to move and
identify the checked king. If that side has no legal move, end the game as
checkmate and identify the winner with `1-0` or `0-1`. Checkmate takes precedence
over a simultaneously reached move-count draw threshold. Final status remains
visible without a modal obscuring the board; only board moves are locked.
Undo, flip, new game, and export remain available as applicable.

**REQ-009: Explicit casual draw policy.** Automatically end with `1/2-1/2`
and a specific reason for stalemate, threefold repetition, the fifty-move rule,
or the material cases below. Threefold counts the same side to move, piece
placement, castling rights, and legally relevant en-passant availability; a
board image or current FEN alone is not a repetition history. Fifty moves means
100 consecutive half-moves without a pawn move or capture, resetting on either.
Material draws cover bare kings, king and one bishop versus king, king and one
knight versus king, and kings with bishops only when every bishop occupies the
same square color. Do not declare king and two knights versus king drawn merely
because checkmate cannot be forced. When several draw conditions coincide,
report stalemate, then material, then repetition, then fifty-move in that order.
For this casual release, repetition and fifty-move draws are automatic rather
than claim-based. Document that distinction; do not claim complete FIDE
tournament adjudication or general detection of every possible dead position.

**REQ-010: Readable move record.** Display the committed main line in Standard
Algebraic Notation (SAN), grouped by move number with White and Black moves.
Include captures, disambiguation, castling, promotion, check, and mate notation.
Keep the latest move visible without scrolling the whole page unexpectedly.
History and current result must agree with the board after moves, undo, and
reload. In-progress result is `*`; a selected square is not a history entry.

**REQ-011: Resignation and agreed draw.** Resign opens a confirmation naming
the side to move in local two-player mode, or the human's color in Computer mode.
Confirmation awards the other side the win. The human may resign while the
computer is thinking; cancel that search before opening the confirmation and
reject its late replies. Cancelling the dialog leaves committed state unchanged
and starts a fresh search if it is still the computer's turn. Draw is available
only in local two-player mode and confirms that both local players agree before
ending the game. There is no computer draw negotiation or computer resignation
in this release; automatic draws and checkmate apply to both modes. These actions
require an ongoing game with no promotion pending, add no fictitious chess move,
and are not remote consent or authentication mechanisms.

**REQ-012: Undo.** In local two-player mode, Undo removes exactly one most
recent committed action: one half-move or an explicit resignation/agreed draw.
In Computer mode, undoing moves cancels any search and restores the position
immediately before the most recent human move, removing that move and any
computer reply after it. This lets the human choose again rather than immediately
triggering a replacement computer reply. With no prior human move, move-Undo is
disabled, including after the computer's opening move when the human is Black.
In either mode, undoing an explicit ending first removes only that ending and
reopens the same position; a fresh computer search starts if appropriate.
Undoing a move restores captured pieces, promotion, castling/en-passant rights,
move counters, repetition history, turn, and the previous last-move marker, and
re-evaluates board-derived endings. Disable Undo with no undoable action or during
a pending dialog, not merely because a search is running. Reject replies from
cancelled searches. There is no redo or variation tree; a new move after undo
replaces the removed line.

**REQ-013: New game.** New game opens a setup dialog for mode and, when
applicable, human color and difficulty (REQ-024). Opening it cancels active
searches and pauses new ones; the committed game is unchanged while it is open.
Make replacement explicit if moves or a final result exist. Cancel preserves
the game and resumes a fresh search only if needed. Confirm replaces the game
with the standard initial position, White to move, no history, and no result,
using the chosen settings. For a new Computer game, put the human's color at
the bottom; for a local game, preserve the previous orientation. Persist the
reset so refresh cannot resurrect the discarded game. Invalidate old searches
before replacement, and start the computer's opening move if the human is Black.
Reset itself is not undoable.

**REQ-014: Flip board.** Flip rotates the board view by 180 degrees and places
the other color at the bottom, including piece and coordinate placement. Piece
artwork and text remain upright for the viewer. It never changes turn, rights,
history, result, logical square identities, mode, or which color the human owns.
Do not automatically flip after each turn. Clear any transient selection and
preserve meaningful keyboard focus. Flipping during a search does not invalidate
an otherwise current reply or let the human play the computer's side.

**REQ-015: One resumable local game.** Save each committed move, undo, reset,
explicit ending, and orientation change in browser-local storage. After reload,
reconstruct the same position and full legal history, including repetition and
undo capability; saving only a board snapshot is insufficient. Include the
committed mode, human color, and difficulty. Restore finished games as finished.
Do not persist an in-flight search or its engine memory as a completed move.
For an ongoing restored computer turn, initialize the engine from the restored
game history and issue one new search. A completed human move must not be lost
merely because its reply was pending. Saves belong to this application and its
base path, not to other apps sharing an origin. Support one game in one active
tab; multi-tab coordination and cross-device synchronization are not promised.

**REQ-016: Safe storage failure.** Treat saved content as untrusted, bounded,
versioned data and replay/validate it before use. Limit a serialized save to
1 MiB and reject larger records before parsing or replay. An unreadable, corrupt,
illegal, oversized, or unsupported-version save must not crash the app, execute
content, or silently masquerade as a valid game. Show a concise recovery message
and a new playable board; retain the rejected save until the player explicitly
chooses to discard it. Until then, new play stays in memory with working export;
after discard, save the current game. If storage is unavailable, a write exceeds
the size limit, or a write fails, continue in memory with a visible not-saved
state and working export. Do not claim a save succeeded when it failed or
repeatedly interrupt play with dialogs.

**REQ-017: PGN export.** Export the currently committed main line as a UTF-8
`.pgn` download, using Portable Game Notation (PGN) with conventional headers,
White/Black player labels for local play, or Human/Computer labels assigned to
their correct colors in Computer mode, SAN moves, and a result consistent with
the game. Do not invent a rating for the computer or player.
Both the Result header and final movetext marker must reflect the application's
outcome, including resignation and agreed draw; a library's default `*` is not
acceptable for a completed game. Do not assume an exporter infers the result.
Use unknown metadata placeholders rather than invented event/player details.
Export works for empty, in-progress, undone, and completed games without changing
them; snapshot committed state on activation, excluding an abandoned line,
pending promotion, or unfinished computer search. The exported
main line must parse and reproduce the position and result in a separate rules
library instance. Download is user-initiated and involves no upload or clipboard
permission. General PGN import, custom starting positions, and annotations are
not first-release features.

### Portability and Experience Requirements

**REQ-018: Self-contained release.** Supply one documented build command that
produces a redistributable folder with the HTML entry point and every required
script, stylesheet, rules-library resource, computer-engine worker/resource,
font if any, and piece asset, including any engine WebAssembly or evaluation data.
Serving that folder alone must work both at `/` and at a nested path such as
`/demo/chess/`, after copying it outside the repository. No runtime dependency
may resolve through repository source, parent build folders, `node_modules`, a
CDN, or a root-absolute application path. No special server routes or environment
variables, cross-origin-isolation headers, or SharedArrayBuffer support are
required. Select an engine build that meets those restrictions, rather than
requiring special host configuration. Recipients need only a static host and a supported
browser, not Node.js or a build tool on the playing device. Include necessary
third-party redistribution notices in the release.

**REQ-019: Offline continuity.** Once the playable board and required assets
for both modes are ready, network loss must not affect rules, piece rendering,
human or computer moves, promotion, history, undo, new game, local save attempts,
or export. Make engine resources available for a fresh worker after undo, retry,
or mode change without a new network fetch; merely keeping one running worker
alive is insufficient. Do not defer required game assets to a later network
fetch. An initial rules/UI asset failure must show an explicit failure/retry
state rather than an inert playable-looking board. Engine-only failure follows
REQ-028 and must not prevent local two-player games from working; do not claim
both-mode readiness before all its resources are available. Cold-start offline
use, offline reload, and installation are not claimed without a PWA scope.

**REQ-020: Accessible interaction.** All actions work with keyboard and
pointer/touch. Provide one predictable tab entry into the board, arrow-key
navigation in the displayed directions, Enter/Space selection and destination
activation, and Escape cancellation. Tab must leave the board normally. Expose
square coordinate, piece/color or empty state, selection, and legal-target state
to assistive technology; announce moves, side to move, check, invalid actions,
and final results, as well as computer thinking and engine failures. Do not
announce continuous search scores or steal focus when a computer move arrives.
Dialogs have names, contained focus, and focus restoration.
Use visible focus, text contrast of at least 4.5:1 for normal text, and non-text
control/focus contrast of at least 3:1. Non-board controls have targets of at
least 44 by 44 CSS pixels; board squares remain at least 32 pixels at a 320-pixel
viewport. No action depends on dragging, hover, color alone, sound, or animation.

**REQ-021: Stable responsive layout and assets.** The board remains square
with eight equal rows and columns, stable dimensions, and legible recognizable
piece artwork on contrasting light/dark squares. Use bundled, redistributable
piece assets rather than platform-dependent chess font glyphs. At viewport
widths 320, 390, 768, and 1280 CSS pixels, and at 200% text zoom, there is no
horizontal page scrolling, clipped labels, overlapping controls, or obscured
squares. Vertical scrolling is acceptable. Put history beside the board when
space permits and below it on narrow screens. Resizing/orientation changes
preserve the game. Honor reduced-motion preferences. The first viewport is the
playable experience, with a restrained toolbar and no marketing section.

**REQ-022: Privacy and safety.** No accounts, cookies, analytics, advertising,
external fonts, remote inference, background requests, or data collection.
Network activity is limited to the application's own static assets. Restrict
storage writes/deletion to the application's own save; never clear unrelated
origin storage. Render data as text or trusted artwork, not executable markup.
No camera, microphone, location, or notification permissions are required.

**REQ-023: Compatibility and responsiveness.** Support current stable Chrome,
Edge, Firefox, and Safari at verification time, including Android Chrome and
iOS Safari for touch use. Record exact tested versions and devices. On a
documented reference device with unthrottled CPU, 95% of sampled human legal
moves must visibly update the board, turn, and history within 150 ms of activation,
excluding promotion-choice time. Applying a current legal computer reply has
the same target measured from receipt, excluding its search time. Exercise at
least 40 legal half-moves and state the measurement method. Replay of the same
initial position and recorded moves must produce identical game state, history,
rights, and result, independent of board orientation, reload, or input method.
Time-bounded engine searches are not required to choose identical moves across
devices; reproducibility applies to replaying the committed moves.

### Computer Opponent Requirements

**REQ-024: Mode and side selection.** The New game setup offers Local two-player
and Computer modes. Computer mode offers White or Black for the human and
Easy, Normal, or Hard difficulty using familiar selection controls. Defaults
for the first Computer game are White and Normal; later setup dialogs start
from the current game's settings. Mode, human color, and difficulty take effect
only when the player confirms a new game, never midway through the existing
line. Display the current mode, human color, and difficulty outside the dialog.
Selecting Black assigns White to the computer, which moves first after readiness.
Local play remains immediately available without an engine or setup requirement.

**REQ-025: Local bounded engine.** Use a proven, maintained browser-capable
chess engine, separate from the authoritative rules library; chess.js is not
an opponent engine. Run search off the browser UI thread in a worker, using
only bundled resources and no remote inference, APIs, or per-move services.
Keep at most one active search and do not ponder on the human's turn. Include
full relevant game history when preparing a search, not just visible pieces.
The rules library remains responsible for legal moves and game endings; engine
scores cannot override REQ-003 or REQ-009. Browser engine selection, resource
limits, licensing, and redistributable packaging require maintainer review.

**REQ-026: Meaningful difficulty.** Easy, Normal, and Hard must map to distinct
documented supported engine strength settings or search limits. Maximum requested
search times are 250 ms, 750 ms, and 1,500 ms respectively; an earlier reply can
be played immediately, with no artificial minimum delay. Research must document
the chosen engine's mapping, readiness/memory costs, and a reproducible tactical
test demonstrating that the settings are not merely different labels. Use skill
controls where supported and do not represent these levels as calibrated Elo,
guaranteed win rates, or proof that every Hard move is better than every Easy
move. Tests should assert the requested limits, legal replies, and cancellation,
not time-sensitive equality to a particular engine move on every device.

**REQ-027: Current-turn replies and cancellation.** Start exactly one search
when an ongoing ready Computer game reaches the computer's turn, including
after restoring a saved game. Expose a visible thinking state; block human board
moves for that turn while keeping applicable Undo, New game, Resign, Flip, and
Export controls responsive. Bind each search to the game instance, position
revision/history, side to move, difficulty, and unique request identity. Accept
at most one final reply only if those bindings still match, no game-changing
dialog is pending, and the game is ongoing on the computer's turn. Revalidate
the complete move, including promotion, through the rules library before commit.
Intermediate evaluations or principal variations are not moves. A legal mating
or drawing move commits normally and ends further searching.

Cancel and invalidate the search before undo, new-game setup, confirmed mode
replacement, resignation confirmation, or disposal of the current game. Ignore
late/duplicate replies even if their move happens to be legal in the new position.
Cancel a search when the page becomes hidden; after visibility returns, issue
one fresh search only if the same game still needs a computer move and no dialog
is open. Never advance a hidden or discarded game using an obsolete reply.

**REQ-028: Engine failure and retry.** If the engine cannot initialize within
10 seconds after its resources are available, or no valid final reply arrives
within 10 seconds of a foreground search request, end that attempt and show an
engine error. The same recovery applies to worker crashes, malformed/illegal
moves, or an empty/no-move reply while the rules library says the game is ongoing.
Invalidate the attempt and stop its worker; retain the last committed board,
history, settings, and result without substituting a move, declaring a chess
loss, or silently changing mode. Expose a user-initiated Retry computer action
that starts a fresh bounded attempt from current state, plus applicable Undo,
New game, and Export. No automatic infinite retries. Returning from a hidden
page uses a fresh request rather than timing out its intentionally cancelled
predecessor. Local two-player mode can be chosen through New game even when
computer assets or execution are unavailable.

### Required Rules Examples

These are test fixtures, not a requirement for a public position editor or FEN
import UI. FEN means Forsyth-Edwards Notation. Each example must become an
executable assertion with an independently specified expectation; do not derive
the expected result from the function under test. Move-by-move human sequences
and single-ply Undo expectations below use local two-player mode unless stated
otherwise. Add symmetric black/white and relevant negative cases beyond these anchors.

| Requirement | Starting position or actions | Expected result |
| --- | --- | --- |
| REQ-001, REQ-003 | Standard initial position | White to move, 32 pieces, 20 legal moves; e2 has e3/e4 targets and g1 has f3/h3 targets |
| REQ-003, REQ-004 | Initial position, attempt e2-e5 | Rejected; position, turn, history, and save unchanged |
| REQ-003 | FEN `k3r3/8/8/8/8/8/4R3/4K3 w - - 0 1`, attempt e2-f2 | Rejected because it exposes White's king to the e8 rook |
| REQ-005 | FEN `r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1` | O-O puts White king on g1 and rook on f1; on a fresh fixture O-O-O puts them on c1/d1; each is one history move |
| REQ-005 | FEN `4kr2/8/8/8/8/8/8/4K2R w K - 0 1`, attempt O-O | Rejected because f1 is attacked, although e1 is not in check |
| REQ-006 | Initial position, `1. e4 a6 2. e5 d5`, then e5-d6 | Legal en passant; White pawn on d6 and Black pawn removed from d5; Undo restores both and the capture opportunity |
| REQ-007 | FEN `7k/P6p/8/8/8/8/8/7K w - - 0 1`, a7-a8 | Each of Q/R/B/N is offered and produces that piece when chosen; Cancel leaves the fixture unchanged |
| REQ-008, REQ-012, REQ-017 | Initial position, `1. f3 e5 2. g4 Qh4#` | Black wins by checkmate, result `0-1`, moves locked, export ends with `0-1`; Undo removes Qh4# and reopens with Black to move |
| REQ-009 | FEN `7k/5Q2/6K1/8/8/8/8/8 b - - 0 1` | Stalemate, not checkmate; result `1/2-1/2` |
| REQ-009 | FEN `7k/8/8/8/8/8/8/K7 w - - 0 1` | Material draw; no winner |
| REQ-009, REQ-015 | Initial position, `1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8` | Draw on the third occurrence after 4...Ng8; refreshing after 2...Ng8 does not lose repetition history |
| REQ-009 | FEN `7k/8/8/8/8/8/R7/K7 w - - 99 50`, then Ra3 | Half-move counter reaches 100 and the game draws by fifty-move rule; corresponding pawn/capture cases reset the counter |

### Required Computer Scenarios

Use controllable engine-response fixtures for timing, cancellation, errors, and
late-message tests, plus real bundled-engine browser tests for readiness, legal
play, difficulty mapping, and offline continuity. Fixtures must exercise the
same reply-validation/commit path as the real engine.

| Requirement | Scenario | Expected result |
| --- | --- | --- |
| REQ-024, REQ-027 | New Computer game, human Black | One White search begins after readiness; its legal reply commits once; human input cannot move White's pieces |
| REQ-012, REQ-027 | Human White plays e4; controlled engine replies e5; Undo | Both moves are removed, White chooses again from the initial position, and no replacement Black search starts |
| REQ-012, REQ-027 | Human White plays e4; Undo before the Black reply; deliver that reply late | e4 is removed; late reply leaves the restored board, history, result, and save unchanged |
| REQ-013, REQ-027 | Open New game during a search, deliver its old reply, then cancel the dialog | Old reply is ignored; current game/settings stay intact; exactly one fresh search resumes when appropriate |
| REQ-024, REQ-027 | Confirm Local two-player while a Computer game has an outstanding reply | New local game starts; even a legal old reply cannot move a piece or overwrite the save |
| REQ-007, REQ-027 | Computer controls White in the promotion fixture and returns a7-a8=N | A White knight appears on a8 once with no human promotion dialog; missing promotion choice is rejected |
| REQ-015, REQ-027 | Reload after a human move while waiting for the computer | Human move and selected mode/color/difficulty survive; one new current-position search runs; no phantom reply is restored |
| REQ-011, REQ-012 | Human resigns during computer thinking, then undoes resignation | Old reply is ignored; undo restores the same ongoing position and starts a fresh search only if the computer is to move |
| REQ-014, REQ-027 | Flip during a search, then deliver the current reply twice | One move commits on the correct logical squares, human color is unchanged, and the duplicate is ignored |
| REQ-028 | Malformed reply, illegal move, crashed worker, or a foreground request exceeding 10 seconds | No move or result is invented; error replaces thinking state; retry uses a new identity and controls remain usable |
| REQ-019, REQ-025 | Load both modes at a nested path, disable network, then play, undo, retry and start another Computer game | Required engine resources remain available; both colors can complete legal turns with no outside/network dependency |

### Key Entities

- **Game:** standard initial position, ordered legal moves, current position and
  rights, repetition history, active side, result, reason for termination, mode,
  human color, and difficulty when applicable.
- **Move:** origin, destination, optional promotion, and derived SAN/capture data;
  one half-move, also called one ply.
- **Game action:** a move or explicit resignation/agreement, with enough history
  to undo the most recent action without losing rule state.
- **View state:** orientation, focused/selected square, and pending dialog;
  orientation is saved, but incomplete actions are not committed moves.
- **Saved game:** bounded, versioned local record that can be validated and
  replayed, including committed opponent settings but no unfinished engine work;
  untrusted on read, never a source of executable instructions.
- **Computer request:** one bounded asynchronous search bound to a particular
  game, position/history revision, side, difficulty, and request identity; its
  output is a move proposal, not authority to change a different position.
- **Release:** the self-contained static folder and redistribution notices,
  separate from source code, test fixtures, and controller automation.

### Success Criteria

- Two people can play from the initial position to a correct final result using
  pointer/touch or keyboard, with no illegal or duplicate committed moves.
- One person can play either color against the local engine at each difficulty.
  Human controls remain responsive during search; late, invalid, duplicated, or
  cancelled replies never alter an unrelated or superseded game state.
- Every requirement has an acceptance-to-evidence mapping. All rules examples,
  storage-failure cases, and the agreed browser scenarios pass on the final
  candidate, with no skipped required checks or invented measurements.
- The copied release loads at both root and nested paths with no missing assets,
  uncaught errors, or outside requests. The same release completes both-mode
  offline continuity, including fresh engine initialization, without access to
  the repository, package registry, or specially configured host headers.
- Refresh and undo preserve all legal-state information, including castling,
  en passant, repetition, and explicit endings. A PGN export can be parsed and
  replayed to the same committed position and result.
- The viewport, input, accessibility, and response-time requirements are verified
  with recorded browser/device evidence, not inferred from CSS text or unit-test
  coverage. Any manual PR checks have named expected results and remain pending
  until performed.

## Constraints and Non-goals

- Use a proven, maintained chess-rules library for legal move generation,
  validation, notation, and rule-state tracking. Do not hand-roll a second rules
  engine, copy one into an allowed path, or substitute permissive piece movement.
- Use a proven local chess-search engine for the computer opponent; do not
  hand-roll minimax or call a remote/generative AI service. Keep search proposals
  separate from authoritative rules and comply with the selected engine's license.
- No online multiplayer, server, accounts, matchmaking, rating, clocks,
  tournaments, puzzles, hints, evaluation bar, separate opening-book feature,
  self-play mode, or variants such as Chess960. These are future product decisions.
- No PWA/service-worker installation, guaranteed cold-start offline operation,
  `file://` support, native wrappers, public hosting, or GitHub settings changes.
- No PGN/FEN import UI, arbitrary starting positions, multiple saved games,
  branching analysis, redo, annotations, cloud sync, or cross-tab collaboration.
- No paid assets, runtime CDN calls, telemetry, background downloads, or
  unreviewed third-party redistribution. Keep visible UI concise and English-only.
- Fit within at most six approved coding tasks and the existing job, repair,
  file-count, and text-change budgets. Research must flag an infeasible scope
  instead of silently dropping requirements or increasing limits.
- Do not modify controller code, workflow policy, credentials, agent profiles,
  existing baseline tests, dependency manifests/lockfiles, TypeScript settings,
  or scanner/coverage configuration during feature jobs. Protected prerequisites
  require a separate reviewed maintainer change, not approval inferred from this
  issue. Keep all existing coverage and security thresholds.

## Context

This document follows the four fields in the
[Agentic Feature issue form](../.github/ISSUE_TEMPLATE/agentic-feature.yml).
It is a draft input for research and requester approval, not an approved plan
or a claim that the current pipeline can execute every requirement unchanged.

### Research and Maintainer Prerequisites

The current [manifest](../package.json) contains no chess-rules library,
computer-opponent engine, browser-test framework, or browser bundler. The existing build compiles
TypeScript; it does not by itself establish a self-contained browser release.
The [policy](../.github/sdlc/policy.json) protects manifests and configuration,
and the [validation runner](../src/validate.ts) targets Node tests rather than
browser rendering. Consequently, the current draft **requires maintainer
prerequisites before implementation is runnable under this pipeline**.

Research must recommend the application architecture on product fit, separately
from these pipeline limits, and identify the smallest reviewed prerequisites:

1. Select and pin a rules library after checking its current license, behavior,
   maintenance, browser distribution, and compatibility with REQ-009. The
   [chess.js documentation](https://jhlywa.github.io/chess.js/), consulted on
   2026-09-16, describes legal moves, special moves, history, undo, SAN/PGN, and
   draw detection; it is a candidate, not an installed dependency or an AI engine.
2. Select and pin a maintained browser-capable opponent engine with documented
  strength controls/search limits, worker support, and a build that does not
  require cross-origin isolation or SharedArrayBuffer. Review license and
  redistribution obligations, including corresponding source where required,
  and document the strength mapping and memory/resource costs. Verify it runs
  offline on the required browsers. Neither chess.js nor a mocked opponent is
  a substitute for this engine dependency.
3. Establish a reproducible build/package path that includes the approved libraries,
  engine workers and any WebAssembly/evaluation resources, and all assets within
  one static release folder. Supply the exact build command,
   release entry point, serving command and working directory. Verify both root
  and nested-path URLs and offline fresh-worker initialization after cancellation;
  a development server or a warm engine alone is not release evidence.
4. Establish approved real-browser validation and artifact capture. Browser
   tooling may need protected dependency/workflow changes before the feature job.
   Missing support must be reported as `blocked`, not replaced by text-pattern
   assertions, an unapproved package download, or a claim that Node tests prove
   browser behavior.
5. Confirm allowed application, test, documentation, and generated-output paths
   and dependency notices. Keep generated release artifacts separate from source
   proposals; the text-only collector is not a binary release publishing system.

Land any prerequisites through normal maintainer review before approved feature
execution. Then obtain a supported research plan and fresh approval against the
trusted revision. This draft does not grant an exception to protected paths.

### Implementation and Verification Boundaries

- Prefer an isolated application module and UI with one rules-state owner. The
  same rules and game actions must drive the browser and application tests;
  do not maintain test-only or browser-only copies of chess behavior. The search
  engine proposes moves to that owner and does not mutate the board directly.
- Derive tests from the numbered requirements and examples, including castling
  after a king/rook moves back, castling out of/through check, expired or pinned
  en passant, both promotion colors and every promotion piece, material draw
  exclusions, repetition across reload, undo of every special move and ending,
  corrupt/incompatible saves, denied/quota-exceeded storage, and failed assets.
- Add current-request tests for both human colors, difficulty selection,
  computer promotion, round-based Undo, reload while thinking, mode changes,
  hidden-page cancellation, duplicate/late replies, stale legal replies, illegal
  replies, and bounded failure/retry. Assert state and history preservation, not
  only that a worker received a stop message. Use controllable fixtures for races
  and real engine execution for browser compatibility and strength/packaging claims.
- Run the repository's required `npm ci --ignore-scripts` and `npm run verify`
  in addition to approved application/browser checks. Report their actual scope:
  typecheck, coverage, and build are not browser or CodeQL execution. Measure
  coverage against the new plan's baseline and retain independent scanner gates.
- Exercise the built release in Chromium, Firefox, and WebKit with keyboard and
  touch emulation, and record a real mobile Safari/Chrome smoke check at PR
  review. Engine emulation is not evidence of a physical-device test. A plan may
  assign those real-device checks to humans, but must name them and require them
  before merge; required automated browser checks cannot be waived silently.
- Capture readable desktop/mobile screenshots showing the board and pieces,
  inspect console/network failures, and assert that a legal move changes the
  rendered position and history. Include promotion, checkmate, flip, undo,
  reload, export, network loss, nested-path hosting, and storage-failure flows.
  Exercise both play modes, all difficulty settings, engine startup/failure,
  responsive controls during thinking, and offline initialization after retry.
  Screenshots support evidence; they do not replace interaction assertions.
- Validate PGN with the existing parser in a fresh instance and compare expected
  final state. Use independent expected moves/results for representative cases;
  agreement between two calls to the same faulty code is not the sole test oracle.
- Bind the final evidence to the source commit and the built release tested.
  Separate executed checks, unavailable tooling, and pending human checks.
  Passing an earlier commit or merely returning a schema-valid report is not
  proof that the final app satisfies this specification.
