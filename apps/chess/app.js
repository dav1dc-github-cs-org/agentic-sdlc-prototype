// Static app layer: DOM/event wiring only (REQ-001, REQ-002, REQ-006,
// REQ-007, REQ-008, REQ-009, REQ-010, REQ-011, REQ-012). This module owns no
// chess-rule logic; every legality decision, move application, result, and
// computer-reply guard is delegated to the compiled `src/chess` modules
// (`session.js`, `computer.js`) which in turn delegate to the vendored
// chess.js rules library. This file only renders the DOM from that state and
// forwards user input (clicks, keys, touches) to the session API.
//
// Import paths below are relative to this file's location *after*
// packaging by build.mjs (see apps/chess/build.mjs), where the compiled
// chess modules are copied to ./src/chess/ alongside this file.
import { createSession } from './src/chess/session.js';
import { selectComputerMove } from './src/chess/computer.js';
import {
  boardFromFen,
  squareToCoords,
  coordsToSquare,
  nextSquareForArrowKey,
  fileLabels,
  rankLabels,
  isLightSquare,
} from './board-geometry.mjs';
import { pieceSvg, pieceName } from './pieces.mjs';

const PROMOTION_PIECES = ['q', 'r', 'b', 'n'];

/** Root application controller. Holds only view state; all game state lives in `session`. */
function createApp(doc) {
  const boardEl = doc.getElementById('board');
  const statusEl = doc.getElementById('status-line');
  const modeLabelEl = doc.getElementById('mode-label');
  const historyListEl = doc.getElementById('history-list');
  const announcerEl = doc.getElementById('announcer');
  const boardHintEl = doc.getElementById('board-hint');

  const newGameBtn = doc.getElementById('new-game-btn');
  const undoBtn = doc.getElementById('undo-btn');
  const flipBtn = doc.getElementById('flip-btn');

  const newGameBackdrop = doc.getElementById('new-game-backdrop');
  const newGameCancel = doc.getElementById('new-game-cancel');
  const newGameConfirm = doc.getElementById('new-game-confirm');
  const humanColorFieldset = doc.getElementById('human-color-fieldset');

  const promotionBackdrop = doc.getElementById('promotion-backdrop');
  const promotionChoices = doc.getElementById('promotion-choices');
  const promotionCancel = doc.getElementById('promotion-cancel');

  const errorBackdrop = doc.getElementById('error-backdrop');
  const errorMessage = doc.getElementById('error-message');
  const errorUndo = doc.getElementById('error-undo');
  const errorNewGame = doc.getElementById('error-new-game');
  const errorRetry = doc.getElementById('error-retry');

  let session = createSession();
  let orientation = 'w';
  let selectedSquare = null;
  let focusedSquare = 'e1';
  let pendingPromotion = null; // { from, to }
  let lastMoveFrom = null;
  let lastMoveTo = null;
  let lastFocusBeforeDialog = null;

  function announce(message) {
    announcerEl.textContent = message;
  }

  function currentLegalTargets() {
    if (!selectedSquare) return [];
    return session.getGame().legalMovesFrom(selectedSquare);
  }

  function isHumanTurnSquareSelectable(square, board) {
    const piece = board.get(square);
    if (!piece) return false;
    const game = session.getGame();
    if (game.isGameOver()) return false;
    if (game.turn() !== piece.color) return false;
    if (session.getMode() === 'computer' && session.getHumanColor() !== game.turn()) return false;
    return true;
  }

  function render() {
    const game = session.getGame();
    const board = boardFromFen(game.fen());
    const legalTargets = new Set(currentLegalTargets());
    const files = fileLabels(orientation);
    const ranks = rankLabels(orientation);

    boardEl.innerHTML = '';
    boardEl.setAttribute('aria-label', 'Chess board, 8 by 8');

    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const square = coordsToSquare(row, col, orientation);
        const piece = board.get(square);
        const cell = doc.createElement('div');
        cell.className = `square ${isLightSquare(square) ? 'light' : 'dark'}`;
        cell.dataset.square = square;
        cell.setAttribute('role', 'gridcell');
        cell.tabIndex = square === focusedSquare ? 0 : -1;

        const selectable = isHumanTurnSquareSelectable(square, board);
        let label = square;
        if (piece) {
          label = `${piece.color === 'w' ? 'White' : 'Black'} ${pieceName(piece.type)} on ${square}`;
        } else {
          label = `Empty square ${square}`;
        }
        if (square === selectedSquare) {
          cell.classList.add('selected');
          label += ', selected';
        }
        if (legalTargets.has(square)) {
          cell.classList.add(piece ? 'legal-capture' : 'legal-target');
          label += piece ? ', legal capture' : ', legal move';
        }
        if (square === lastMoveFrom || square === lastMoveTo) {
          cell.classList.add('last-move');
          label += ', last move';
        }
        if (game.inCheck() && piece && piece.type === 'k' && piece.color === game.turn()) {
          cell.classList.add('in-check');
          label += ', in check';
        }
        cell.setAttribute('aria-label', label);
        cell.setAttribute('aria-selected', square === selectedSquare ? 'true' : 'false');

        if (piece) {
          const wrapper = doc.createElement('span');
          wrapper.className = 'piece-svg';
          wrapper.innerHTML = pieceSvg(piece.type, piece.color);
          cell.appendChild(wrapper);
        }

        if (col === 0) {
          const rankLabel = doc.createElement('span');
          rankLabel.className = 'coord-rank';
          rankLabel.textContent = String(ranks[row]);
          rankLabel.setAttribute('aria-hidden', 'true');
          cell.appendChild(rankLabel);
        }
        if (row === 7) {
          const fileLabel = doc.createElement('span');
          fileLabel.className = 'coord-file';
          fileLabel.textContent = files[col];
          fileLabel.setAttribute('aria-hidden', 'true');
          cell.appendChild(fileLabel);
        }

        cell.addEventListener('click', () => onSquareActivate(square));
        cell.addEventListener('keydown', (event) => onSquareKeydown(event, square));

        boardEl.appendChild(cell);
      }
    }

    renderStatus();
    renderHistory();
    renderModeLabel();
    undoBtn.disabled = !canUndo();
  }

  function canUndo() {
    if (session.getMode() === 'local') {
      return session.getGame().history().length > 0;
    }
    // Computer mode: Undo is only meaningful once the human has made a move
    // (REQ-009), i.e. there is at least one half-move by the human on the board.
    const history = session.getGame().historyVerbose();
    return history.some((m) => m.color === session.getHumanColor());
  }

  function renderModeLabel() {
    modeLabelEl.textContent =
      session.getMode() === 'local'
        ? 'Local two-player'
        : `Vs. Basic computer (you are ${session.getHumanColor() === 'w' ? 'White' : 'Black'})`;
  }

  function renderStatus() {
    const game = session.getGame();
    const result = game.result();
    if (result.over) {
      const reasonText = {
        checkmate: 'Checkmate',
        stalemate: 'Stalemate',
        insufficient_material: 'Draw (insufficient material)',
        threefold_repetition: 'Draw (threefold repetition)',
        fifty_move_rule: 'Draw (fifty-move rule)',
      }[result.reason];
      statusEl.textContent = `${reasonText} \u2014 ${result.outcome}`;
      boardHintEl.textContent = 'The game has ended. Start a new game to continue playing.';
      return;
    }
    const turnLabel = game.turn() === 'w' ? 'White' : 'Black';
    const checkLabel = game.inCheck() ? ' (in check)' : '';
    if (session.isComputerTurn() || session.isComputerReplyPending()) {
      statusEl.textContent = `${turnLabel} to move${checkLabel} \u2014 computer is thinking\u2026`;
    } else {
      statusEl.textContent = `${turnLabel} to move${checkLabel}`;
    }
    boardHintEl.textContent = 'Select a piece, then choose a highlighted destination. Press Escape to cancel a selection.';
  }

  function renderHistory() {
    const entries = session.getGame().historyByMoveNumber();
    historyListEl.innerHTML = '';
    for (const entry of entries) {
      const li = doc.createElement('li');
      const num = doc.createElement('span');
      num.className = 'history-move-number';
      num.textContent = `${entry.moveNumber}.`;
      const white = doc.createElement('span');
      white.textContent = entry.white ?? '';
      const black = doc.createElement('span');
      black.textContent = entry.black ?? '';
      li.append(num, white, black);
      historyListEl.appendChild(li);
    }
  }

  function clearSelection() {
    selectedSquare = null;
  }

  function onSquareActivate(square) {
    if (pendingPromotion) return;
    focusedSquare = square;
    const game = session.getGame();
    const board = boardFromFen(game.fen());

    if (selectedSquare === square) {
      clearSelection();
      render();
      return;
    }

    if (selectedSquare) {
      const legalTargets = currentLegalTargets();
      if (legalTargets.includes(square)) {
        attemptMove(selectedSquare, square);
        return;
      }
      if (isHumanTurnSquareSelectable(square, board)) {
        selectedSquare = square;
        render();
        return;
      }
      announce('Invalid destination. Selection unchanged.');
      return;
    }

    if (isHumanTurnSquareSelectable(square, board)) {
      selectedSquare = square;
      render();
    }
  }

  function attemptMove(from, to) {
    const game = session.getGame();
    const needsPromotion =
      game
        .legalMovesFrom(from)
        .includes(to) &&
      game.legalMovesVerbose().some((m) => m.from === from && m.to === to && m.promotion);
    if (needsPromotion) {
      pendingPromotion = { from, to };
      clearSelection();
      openPromotionDialog();
      return;
    }
    commitMove({ from, to });
  }

  function commitMove(input) {
    try {
      session.applyHumanMove(input);
      lastMoveFrom = input.from;
      lastMoveTo = input.to;
      clearSelection();
      announce(`Move played: ${input.from} to ${input.to}`);
      render();
      maybeQueueComputerReply();
    } catch {
      announce('Illegal move. Selection unchanged.');
    }
  }

  function maybeQueueComputerReply() {
    if (!session.isComputerTurn()) return;
    session.queueComputerReply((game) => selectComputerMove(game, Math.random()));
    render();
    // Poll for completion; the session itself guards staleness/validity.
    const checkInterval = setInterval(() => {
      if (!session.isComputerReplyPending()) {
        clearInterval(checkInterval);
        lastMoveFrom = null;
        lastMoveTo = null;
        const last = session.getGame().historyVerbose().at(-1);
        if (last) {
          lastMoveFrom = last.from;
          lastMoveTo = last.to;
        }
        render();
      }
    }, 30);
  }

  function openPromotionDialog() {
    promotionChoices.innerHTML = '';
    for (const piece of PROMOTION_PIECES) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.innerHTML = pieceSvg(piece, session.getGame().turn());
      btn.setAttribute('aria-label', `Promote to ${pieceName(piece)}`);
      btn.addEventListener('click', () => {
        const { from, to } = pendingPromotion;
        pendingPromotion = null;
        closeDialog(promotionBackdrop);
        commitMove({ from, to, promotion: piece });
      });
      promotionChoices.appendChild(btn);
    }
    openDialog(promotionBackdrop, promotionCancel);
  }

  function openDialog(backdrop, focusTarget) {
    lastFocusBeforeDialog = doc.activeElement;
    backdrop.hidden = false;
    if (focusTarget) focusTarget.focus();
  }

  function closeDialog(backdrop) {
    backdrop.hidden = true;
    if (lastFocusBeforeDialog && typeof lastFocusBeforeDialog.focus === 'function') {
      lastFocusBeforeDialog.focus();
    }
  }

  function onSquareKeydown(event, square) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSquareActivate(square);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      clearSelection();
      render();
      return;
    }
    if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      const next = nextSquareForArrowKey(square, event.key, orientation);
      focusedSquare = next;
      render();
      const nextEl = boardEl.querySelector(`[data-square="${next}"]`);
      if (nextEl) nextEl.focus();
    }
  }

  newGameBtn.addEventListener('click', () => {
    session.onDialogOpen();
    openDialog(newGameBackdrop, doc.querySelector('#new-game-dialog input[name="mode"]:checked'));
  });

  newGameCancel.addEventListener('click', () => {
    closeDialog(newGameBackdrop);
  });

  newGameConfirm.addEventListener('click', () => {
    const mode = doc.querySelector('input[name="mode"]:checked').value;
    const humanColor = doc.querySelector('input[name="human-color"]:checked').value;
    closeDialog(newGameBackdrop);
    session = createSession({ mode, humanColor: mode === 'computer' ? humanColor : 'w' });
    orientation = mode === 'computer' ? humanColor : orientation;
    selectedSquare = null;
    lastMoveFrom = null;
    lastMoveTo = null;
    focusedSquare = orientation === 'w' ? 'e1' : 'e8';
    announce('New game started.');
    render();
    maybeQueueComputerReply();
  });

  promotionCancel.addEventListener('click', () => {
    pendingPromotion = null;
    closeDialog(promotionBackdrop);
    announce('Promotion cancelled. Selection unchanged.');
    render();
  });

  undoBtn.addEventListener('click', () => {
    session.undo();
    clearSelection();
    lastMoveFrom = null;
    lastMoveTo = null;
    announce('Move undone.');
    render();
  });

  flipBtn.addEventListener('click', () => {
    orientation = orientation === 'w' ? 'b' : 'w';
    render();
  });

  doc.addEventListener('visibilitychange', () => {
    if (doc.hidden) session.onPageHidden();
  });

  errorUndo.addEventListener('click', () => {
    session.undo();
    closeDialog(errorBackdrop);
    render();
  });
  errorNewGame.addEventListener('click', () => {
    closeDialog(errorBackdrop);
    newGameBtn.click();
  });
  errorRetry.addEventListener('click', () => {
    closeDialog(errorBackdrop);
    maybeQueueComputerReply();
  });

  render();

  return { render, getSession: () => session };
}

if (typeof document !== 'undefined') {
  createApp(document);
}

export { createApp };
