export type Heading = 'up' | 'left' | 'down' | 'right';
export type PenState = 'up' | 'down';

export interface Point {
  x: number;
  y: number;
}

export interface Segment {
  from: Point;
  to: Point;
}

export interface TurtleState {
  position: Point;
  heading: Heading;
  pen: PenState;
  segments: Segment[];
}

export type Command =
  | 'penUp'
  | 'penDown'
  | 'forward'
  | 'backward'
  | 'turnLeft'
  | 'turnRight';

const STEP = 20;
const MIN_COORD = 20;
const MAX_COORD = 380;

const HEADING_VECTORS: Record<Heading, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const LEFT_CYCLE: Record<Heading, Heading> = {
  up: 'left',
  left: 'down',
  down: 'right',
  right: 'up',
};

const RIGHT_CYCLE: Record<Heading, Heading> = {
  up: 'right',
  right: 'down',
  down: 'left',
  left: 'up',
};

function inRange(value: number): boolean {
  return value >= MIN_COORD && value <= MAX_COORD;
}

function move(state: TurtleState, direction: 1 | -1): TurtleState {
  const vector = HEADING_VECTORS[state.heading];
  const candidate: Point = {
    x: state.position.x + vector.x * STEP * direction,
    y: state.position.y + vector.y * STEP * direction,
  };
  if (!inRange(candidate.x) || !inRange(candidate.y)) return state;
  if (state.pen === 'down') {
    const segment: Segment = { from: state.position, to: candidate };
    return {
      position: candidate,
      heading: state.heading,
      pen: state.pen,
      segments: [...state.segments, segment],
    };
  }
  return {
    position: candidate,
    heading: state.heading,
    pen: state.pen,
    segments: state.segments,
  };
}

export function createInitialState(): TurtleState {
  return {
    position: { x: 200, y: 200 },
    heading: 'up',
    pen: 'down',
    segments: [],
  };
}

export function applyCommand(state: TurtleState, command: Command): TurtleState {
  switch (command) {
    case 'penUp':
      if (state.pen === 'up') return state;
      return { position: state.position, heading: state.heading, pen: 'up', segments: state.segments };
    case 'penDown':
      if (state.pen === 'down') return state;
      return { position: state.position, heading: state.heading, pen: 'down', segments: state.segments };
    case 'forward':
      return move(state, 1);
    case 'backward':
      return move(state, -1);
    case 'turnLeft':
      return {
        position: state.position,
        heading: LEFT_CYCLE[state.heading],
        pen: state.pen,
        segments: state.segments,
      };
    case 'turnRight':
      return {
        position: state.position,
        heading: RIGHT_CYCLE[state.heading],
        pen: state.pen,
        segments: state.segments,
      };
  }
}
