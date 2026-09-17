export interface SquareCoords {
  row: number;
  col: number;
}

export interface FileRank {
  file: number;
  rank: number;
}

export interface BoardPiece {
  type: 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
  color: 'w' | 'b';
}

export function parseSquare(square: string): FileRank;
export function toSquare(file: number, rank: number): string;
export function squareToCoords(square: string, orientation: string): SquareCoords;
export function coordsToSquare(row: number, col: number, orientation: string): string;
export function isLightSquare(square: string): boolean;
export function fileLabels(orientation: string): string[];
export function rankLabels(orientation: string): number[];
export function nextSquareForArrowKey(square: string, key: string, orientation: string): string;
export function boardFromFen(fen: string): Map<string, BoardPiece>;
