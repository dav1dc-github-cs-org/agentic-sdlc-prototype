import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyCommand,
  createInitialState,
  type Command,
  type Heading,
  type TurtleState,
} from '../../src/turtle-graphics/engine.ts';

const HEADINGS: Heading[] = ['up', 'left', 'down', 'right'];

const VECTORS: Record<Heading, { x: number; y: number }> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

function stateWithHeading(heading: Heading): TurtleState {
  return { ...createInitialState(), heading };
}

test('createInitialState returns the documented defaults', () => {
  const state = createInitialState();
  assert.deepEqual(state.position, { x: 200, y: 200 });
  assert.equal(state.heading, 'up');
  assert.equal(state.pen, 'down');
  assert.deepEqual(state.segments, []);
});

for (const heading of HEADINGS) {
  test(`forward moves 20 units along heading ${heading} and leaves heading/pen unchanged`, () => {
    const start = stateWithHeading(heading);
    const next = applyCommand(start, 'forward');
    const vector = VECTORS[heading];
    assert.deepEqual(next.position, {
      x: start.position.x + vector.x * 20,
      y: start.position.y + vector.y * 20,
    });
    assert.equal(next.heading, heading);
    assert.equal(next.pen, start.pen);
  });

  test(`backward moves 20 units opposite heading ${heading} and leaves heading/pen unchanged`, () => {
    const start = stateWithHeading(heading);
    const next = applyCommand(start, 'backward');
    const vector = VECTORS[heading];
    assert.deepEqual(next.position, {
      x: start.position.x - vector.x * 20,
      y: start.position.y - vector.y * 20,
    });
    assert.equal(next.heading, heading);
    assert.equal(next.pen, start.pen);
  });

  test(`forward then backward from heading ${heading} returns to the original position`, () => {
    const start = stateWithHeading(heading);
    const forwardThenBack = applyCommand(applyCommand(start, 'forward'), 'backward');
    assert.deepEqual(forwardThenBack.position, start.position);
  });
}

test('turnLeft rotates through the full up->left->down->right->up cycle without touching position or segments', () => {
  let state = createInitialState();
  const expected: Heading[] = ['left', 'down', 'right', 'up'];
  for (const heading of expected) {
    const before = state;
    state = applyCommand(state, 'turnLeft');
    assert.equal(state.heading, heading);
    assert.deepEqual(state.position, before.position);
    assert.equal(state.segments, before.segments);
  }
});

test('turnRight rotates through the full up->right->down->left->up cycle without touching position or segments', () => {
  let state = createInitialState();
  const expected: Heading[] = ['right', 'down', 'left', 'up'];
  for (const heading of expected) {
    const before = state;
    state = applyCommand(state, 'turnRight');
    assert.equal(state.heading, heading);
    assert.deepEqual(state.position, before.position);
    assert.equal(state.segments, before.segments);
  }
});

test('turnLeft and turnRight are exact inverses of one another for every heading', () => {
  for (const heading of HEADINGS) {
    const start = stateWithHeading(heading);
    assert.equal(applyCommand(applyCommand(start, 'turnLeft'), 'turnRight').heading, heading);
    assert.equal(applyCommand(applyCommand(start, 'turnRight'), 'turnLeft').heading, heading);
  }
});

test('pen commands only change the pen field and repeating an active pen command is a no-op by reference', () => {
  const down = createInitialState();
  const up = applyCommand(down, 'penUp');
  assert.equal(up.pen, 'up');
  assert.equal(up.position, down.position);
  assert.equal(up.segments, down.segments);
  assert.equal(up.heading, down.heading);

  const upAgain = applyCommand(up, 'penUp');
  assert.equal(upAgain, up);

  const downAgain = applyCommand(up, 'penDown');
  assert.equal(downAgain.pen, 'down');

  const downAgainAgain = applyCommand(downAgain, 'penDown');
  assert.equal(downAgainAgain, downAgain);

  const initialPenDownAgain = applyCommand(down, 'penDown');
  assert.equal(initialPenDownAgain, down);
});

test('a successful pen-down move appends exactly one segment from old to new position', () => {
  const start = createInitialState();
  const next = applyCommand(start, 'forward');
  assert.equal(next.segments.length, 1);
  assert.deepEqual(next.segments[0], { from: start.position, to: next.position });
});

test('a successful pen-up move appends no segment', () => {
  const start = applyCommand(createInitialState(), 'penUp');
  const next = applyCommand(start, 'forward');
  assert.equal(next.segments.length, 0);
  assert.equal(next.segments, start.segments);
});

test('mixed command sequences accumulate segments and heading changes correctly', () => {
  const commands: Command[] = ['forward', 'turnRight', 'forward', 'penUp', 'forward', 'penDown', 'turnLeft', 'backward'];
  let state = createInitialState();
  const positions: { x: number; y: number }[] = [state.position];
  for (const command of commands) {
    state = applyCommand(state, command);
    positions.push(state.position);
  }
  assert.equal(state.heading, 'up');
  // forward, forward(right), forward(up, pen up, no segment), backward(up) -> 3 segments total
  assert.equal(state.segments.length, 3);
});

test('boundary edges: moving out of the [20,380] range is a no-op returning the same state reference', () => {
  const top = { ...createInitialState(), position: { x: 200, y: 20 }, heading: 'up' as Heading };
  assert.equal(applyCommand(top, 'forward'), top);

  const bottom = { ...createInitialState(), position: { x: 200, y: 380 }, heading: 'down' as Heading };
  assert.equal(applyCommand(bottom, 'forward'), bottom);

  const left = { ...createInitialState(), position: { x: 20, y: 200 }, heading: 'left' as Heading };
  assert.equal(applyCommand(left, 'forward'), left);

  const right = { ...createInitialState(), position: { x: 380, y: 200 }, heading: 'right' as Heading };
  assert.equal(applyCommand(right, 'forward'), right);
});

test('boundary corners: both types of corners reject out-of-range moves in either axis', () => {
  const topLeftUp = { ...createInitialState(), position: { x: 20, y: 20 }, heading: 'up' as Heading };
  assert.equal(applyCommand(topLeftUp, 'forward'), topLeftUp);
  const topLeftLeft = { ...createInitialState(), position: { x: 20, y: 20 }, heading: 'left' as Heading };
  assert.equal(applyCommand(topLeftLeft, 'forward'), topLeftLeft);

  const bottomRightDown = { ...createInitialState(), position: { x: 380, y: 380 }, heading: 'down' as Heading };
  assert.equal(applyCommand(bottomRightDown, 'forward'), bottomRightDown);
  const bottomRightRight = { ...createInitialState(), position: { x: 380, y: 380 }, heading: 'right' as Heading };
  assert.equal(applyCommand(bottomRightRight, 'forward'), bottomRightRight);

  const withinBounds = { ...createInitialState(), position: { x: 20, y: 20 }, heading: 'right' as Heading };
  const moved = applyCommand(withinBounds, 'forward');
  assert.notEqual(moved, withinBounds);
  assert.deepEqual(moved.position, { x: 40, y: 20 });
});

test('a boundary no-op never mutates segments or heading', () => {
  const edge = { ...createInitialState(), position: { x: 200, y: 20 }, heading: 'up' as Heading, pen: 'down' as const };
  const result = applyCommand(edge, 'forward');
  assert.equal(result, edge);
  assert.equal(result.segments.length, 0);
});

test('a determinism replay of 500 mixed commands from the initial state is bit-for-bit identical when run twice', () => {
  const commandPool: Command[] = ['penUp', 'penDown', 'forward', 'backward', 'turnLeft', 'turnRight'];
  const commands: Command[] = [];
  let seed = 12345;
  for (let i = 0; i < 500; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    commands.push(commandPool[seed % commandPool.length] as Command);
  }

  function replay(): TurtleState {
    let state = createInitialState();
    for (const command of commands) {
      state = applyCommand(state, command);
    }
    return state;
  }

  const first = replay();
  const second = replay();
  assert.deepEqual(first, second);
});

test('the documented square scenario returns to (200,200) facing up with exactly 4 segments', () => {
  let state = createInitialState();
  for (let i = 0; i < 4; i++) {
    state = applyCommand(state, 'forward');
    state = applyCommand(state, 'turnRight');
  }
  assert.deepEqual(state.position, { x: 200, y: 200 });
  assert.equal(state.heading, 'up');
  assert.equal(state.segments.length, 4);
});

test('the documented pen-up scenario yields exactly one segment', () => {
  let state = createInitialState();
  state = applyCommand(state, 'penUp');
  state = applyCommand(state, 'forward');
  state = applyCommand(state, 'penDown');
  state = applyCommand(state, 'forward');
  assert.equal(state.segments.length, 1);
});
