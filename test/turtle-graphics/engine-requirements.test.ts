import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyCommand,
  createInitialState,
  type Command,
} from '../../src/turtle-graphics/engine.ts';

// Regression coverage for the two concrete worked examples called out in the
// approved plan (docs/turtle-graphics-feature.md) that the existing baseline
// test/turtle-graphics/engine.test.ts does not assert verbatim: the REQ-010
// twenty-forward-presses boundary example and the REQ-016 five-hundred
// alternating forward/backward replay example.

test('REQ-010: 20 consecutive forward presses from the initial state stop at (200,20) with exactly nine segments', () => {
  let state = createInitialState();
  for (let i = 0; i < 20; i++) {
    state = applyCommand(state, 'forward');
  }
  assert.deepEqual(state.position, { x: 200, y: 20 });
  assert.equal(state.heading, 'up');
  assert.equal(state.segments.length, 9);

  // The turtle is pinned at the boundary: one further forward press must be
  // a strict no-op returning the same object reference, while a backward
  // press must move it back into the board and draw a tenth segment.
  const pinned = applyCommand(state, 'forward');
  assert.equal(pinned, state);

  const recovered = applyCommand(state, 'backward');
  assert.notEqual(recovered, state);
  assert.deepEqual(recovered.position, { x: 200, y: 40 });
  assert.equal(recovered.segments.length, 10);
});

test('REQ-016: 500 alternating forward/backward activations with the pen down stay responsive and produce exactly 500 segments with no loss or duplication', () => {
  const commands: Command[] = [];
  for (let i = 0; i < 500; i++) {
    commands.push(i % 2 === 0 ? 'forward' : 'backward');
  }

  let state = createInitialState();
  for (const command of commands) {
    const before = state;
    state = applyCommand(state, command);
    // Alternating forward/backward from (200,200) never approaches the
    // [20,380] boundary, so every activation must succeed (produce a new
    // segment), never silently drop or duplicate a move.
    assert.notEqual(state, before, `command #${commands.indexOf(command)} must not be a no-op`);
  }

  assert.equal(state.segments.length, 500);
  assert.deepEqual(state.position, { x: 200, y: 200 });
  assert.equal(state.heading, 'up');

  // Replaying the exact same alternating sequence twice is bit-for-bit
  // identical, matching the documented determinism guarantee for this
  // specific worked example (not just the pseudo-random 500-command replay
  // already covered by the baseline test).
  function replay(): ReturnType<typeof createInitialState> {
    let replayState = createInitialState();
    for (const command of commands) {
      replayState = applyCommand(replayState, command);
    }
    return replayState;
  }
  assert.deepEqual(replay(), replay());
});
