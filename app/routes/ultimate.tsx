import { useEffect, useState } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/ultimate";
import { BackButton } from "../components/BackButton";
import { GameLayout } from "../components/GameLayout";
import { loadGame, saveGame } from "../storage";

type Player = "X" | "O";
type Cell = Player | null;
type SubOutcome = Player | "draw" | null;
type Mode = "2p" | "ai";

const TOTAL_CELLS = 81;
const SUB_COUNT = 9;
const CELLS_PER_SUB = 9;
const AI_DELAY_MS = 500;
const AI_PLAYER: Player = "O";

// Flat indexing: cells 0..8 belong to sub-board 0, 9..17 to sub-board 1, etc.
const subOf = (i: number) => Math.floor(i / CELLS_PER_SUB);
const cellOf = (i: number) => i % CELLS_PER_SUB;
const flatOf = (sub: number, cell: number) => sub * CELLS_PER_SUB + cell;

const other = (p: Player): Player => (p === "X" ? "O" : "X");
const colorFor = (p: Player) =>
  p === "X" ? "text-sky-400" : "text-amber-400";

// 8 winning lines on a 3×3 sub-board (cells 0..8, row-major).
const SUB_LINES: number[][] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

function subWinnerOf(cells: Cell[]): Player | null {
  for (const [a, b, c] of SUB_LINES) {
    const v = cells[a];
    if (v && v === cells[b] && v === cells[c]) return v;
  }
  return null;
}

// Meta-level winner: same 8 lines, but applied to sub-board outcomes.
// "draw" outcomes never align (they're not a Player) so they're skipped.
function metaWinnerOf(
  subs: SubOutcome[],
): { winner: Player; line: number[] } | null {
  for (const line of SUB_LINES) {
    const v = subs[line[0]];
    if (v !== "X" && v !== "O") continue;
    if (subs[line[1]] === v && subs[line[2]] === v) {
      return { winner: v, line };
    }
  }
  return null;
}

function subCellsOf(board: Cell[], sub: number): Cell[] {
  return board.slice(sub * CELLS_PER_SUB, (sub + 1) * CELLS_PER_SUB);
}

// All legal cell indices given the current forced-board constraint.
function legalMovesFor(
  board: Cell[],
  subWinners: SubOutcome[],
  nextSub: number | null,
): number[] {
  const moves: number[] = [];
  for (let i = 0; i < TOTAL_CELLS; i++) {
    if (board[i]) continue;
    const sub = subOf(i);
    if (subWinners[sub] !== null) continue;
    if (nextSub !== null && sub !== nextSub) continue;
    moves.push(i);
  }
  return moves;
}

// Apply a move to a board/subWinners snapshot and derive the post-state,
// including the next forced sub-board and any meta-win that just happened.
// Used by the AI for 1- and 2-ply lookahead.
function simulateMove(
  board: Cell[],
  subWinners: SubOutcome[],
  player: Player,
  i: number,
): {
  board: Cell[];
  subWinners: SubOutcome[];
  nextSub: number | null;
  metaWinner: Player | null;
} {
  const nextBoard = [...board];
  nextBoard[i] = player;
  const sub = subOf(i);
  const localCells = subCellsOf(nextBoard, sub);
  const localWin = subWinnerOf(localCells);
  let nextSubWinners = subWinners;
  if (localWin) {
    nextSubWinners = [...subWinners];
    nextSubWinners[sub] = localWin;
  } else if (localCells.every((c) => c !== null)) {
    nextSubWinners = [...subWinners];
    nextSubWinners[sub] = "draw";
  }
  const target = cellOf(i);
  const newNextSub = nextSubWinners[target] !== null ? null : target;
  const metaWin = metaWinnerOf(nextSubWinners);
  return {
    board: nextBoard,
    subWinners: nextSubWinners,
    nextSub: newNextSub,
    metaWinner: metaWin?.winner ?? null,
  };
}

// Static heuristic for a position from `player`'s perspective. Each meta-
// line contributes only if a single side holds it — a mixed line is dead
// and scores zero. A 2-of-3 live line is worth ~10× a 1-of-3 live line.
function staticScore(subWinners: SubOutcome[], player: Player): number {
  const opponent = other(player);
  let s = 0;
  for (const line of SUB_LINES) {
    let mine = 0;
    let opp = 0;
    for (const idx of line) {
      const v = subWinners[idx];
      if (v === player) mine++;
      else if (v === opponent) opp++;
    }
    if (opp === 0) {
      if (mine === 1) s += 1;
      else if (mine === 2) s += 10;
      else if (mine === 3) s += 1000;
    }
    if (mine === 0) {
      if (opp === 1) s -= 1;
      else if (opp === 2) s -= 10;
      else if (opp === 3) s -= 1000;
    }
  }
  return s;
}

// 2-ply lookahead: pick the move whose worst-case opponent reply is best
// from our perspective. Wins and losses use ±100000 sentinels so they
// dominate any positional score; ties broken by static evaluation.
function chooseAIMove(
  board: Cell[],
  subWinners: SubOutcome[],
  nextSub: number | null,
  player: Player,
): number {
  const moves = legalMovesFor(board, subWinners, nextSub);
  if (moves.length === 0) return -1;
  const opponent = other(player);

  let bestMove = moves[0];
  let bestScore = -Infinity;

  for (const move of moves) {
    const after = simulateMove(board, subWinners, player, move);
    let score: number;

    if (after.metaWinner === player) {
      score = 100000;
    } else {
      const oppMoves = legalMovesFor(
        after.board,
        after.subWinners,
        after.nextSub,
      );
      if (oppMoves.length === 0) {
        score = staticScore(after.subWinners, player);
      } else {
        let oppBest = -Infinity;
        for (const oppMove of oppMoves) {
          const after2 = simulateMove(
            after.board,
            after.subWinners,
            opponent,
            oppMove,
          );
          const s =
            after2.metaWinner === opponent
              ? 100000
              : -staticScore(after2.subWinners, player);
          if (s > oppBest) oppBest = s;
        }
        score = -oppBest;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }
  }

  return bestMove;
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Ultimate Tic-Tac-Toe — toto-victoto" },
    {
      name: "description",
      content:
        "Ultimate Tic-Tac-Toe: nine boards inside one. Where you play within a small board sends your rival to that sub-board next.",
    },
  ];
}

export default function Ultimate() {
  const [board, setBoard] = useState<Cell[]>(() =>
    Array(TOTAL_CELLS).fill(null),
  );
  const [subWinners, setSubWinners] = useState<SubOutcome[]>(() =>
    Array(SUB_COUNT).fill(null),
  );
  const [turn, setTurn] = useState<Player>("X");
  const [startedBy, setStartedBy] = useState<Player>("X");
  // null = free move (any open sub-board); otherwise the sub-board the
  // active player is forced into.
  const [nextSub, setNextSub] = useState<number | null>(null);
  const [winner, setWinner] = useState<Player | null>(null);
  const [winLine, setWinLine] = useState<number[] | null>(null);
  const [scores, setScores] = useState({ X: 0, O: 0, draws: 0 });
  const [mode, setMode] = useState<Mode>("2p");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const saved = loadGame("ultimate", {
      mode: "2p" as Mode,
      scores: { X: 0, O: 0, draws: 0 },
      board: Array(TOTAL_CELLS).fill(null) as Cell[],
      subWinners: Array(SUB_COUNT).fill(null) as SubOutcome[],
      turn: "X" as Player,
      startedBy: "X" as Player,
      nextSub: null as number | null,
      winner: null as Player | null,
      winLine: null as number[] | null,
    });
    setMode(saved.mode);
    setScores(saved.scores);
    setBoard(saved.board);
    setSubWinners(saved.subWinners);
    setTurn(saved.turn);
    setStartedBy(saved.startedBy);
    setNextSub(saved.nextSub);
    setWinner(saved.winner);
    setWinLine(saved.winLine);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveGame("ultimate", {
      mode,
      scores,
      board,
      subWinners,
      turn,
      startedBy,
      nextSub,
      winner,
      winLine,
    });
  }, [
    hydrated,
    mode,
    scores,
    board,
    subWinners,
    turn,
    startedBy,
    nextSub,
    winner,
    winLine,
  ]);

  const metaDraw = !winner && subWinners.every((s) => s !== null);
  const phase: "playing" | "win" | "draw" = winner
    ? "win"
    : metaDraw
      ? "draw"
      : "playing";

  const isAiTurn = mode === "ai" && turn === AI_PLAYER && phase === "playing";

  const play = (i: number) => {
    if (phase !== "playing") return;
    if (board[i]) return;
    const sub = subOf(i);
    if (subWinners[sub] !== null) return;
    if (nextSub !== null && sub !== nextSub) return;

    const nextBoard = [...board];
    nextBoard[i] = turn;

    // Re-evaluate the sub-board this move landed in.
    const localCells = subCellsOf(nextBoard, sub);
    const localWin = subWinnerOf(localCells);
    let nextSubWinners = subWinners;
    if (localWin) {
      nextSubWinners = [...subWinners];
      nextSubWinners[sub] = localWin;
    } else if (localCells.every((c) => c !== null)) {
      nextSubWinners = [...subWinners];
      nextSubWinners[sub] = "draw";
    }

    // Meta-level resolution: does this move close the game?
    const metaWin = metaWinnerOf(nextSubWinners);
    const metaDrawNow =
      !metaWin && nextSubWinners.every((s) => s !== null);

    // Forced-board rule: opponent's next sub-board = the cell position we
    // just played within our sub-board. If that target is already closed
    // (won or drawn), the opponent gets a free move.
    const target = cellOf(i);
    const newNextSub = nextSubWinners[target] !== null ? null : target;

    setBoard(nextBoard);
    if (nextSubWinners !== subWinners) setSubWinners(nextSubWinners);
    setNextSub(newNextSub);
    if (metaWin) {
      setWinner(metaWin.winner);
      setWinLine(metaWin.line);
      setScores((s) => ({ ...s, [metaWin.winner]: s[metaWin.winner] + 1 }));
    } else if (metaDrawNow) {
      setScores((s) => ({ ...s, draws: s.draws + 1 }));
    } else {
      setTurn(other(turn));
    }
  };

  const isPlayableSub = (sub: number): boolean => {
    if (phase !== "playing") return false;
    if (isAiTurn) return false;
    if (subWinners[sub] !== null) return false;
    return nextSub === null || sub === nextSub;
  };

  // AI takes its turn after a short delay so the move doesn't feel
  // instantaneous. Cleanup cancels the timer if anything relevant changes
  // (mode toggled, round reset, game ended) before the AI got to play.
  useEffect(() => {
    if (!isAiTurn) return;
    const id = window.setTimeout(() => {
      const move = chooseAIMove(board, subWinners, nextSub, AI_PLAYER);
      if (move >= 0) play(move);
    }, AI_DELAY_MS);
    return () => clearTimeout(id);
    // play() depends on the latest closure — re-run whenever inputs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAiTurn, board, subWinners, nextSub]);

  const startNewRound = (starter: Player) => {
    setStartedBy(starter);
    setTurn(starter);
    setBoard(Array(TOTAL_CELLS).fill(null));
    setSubWinners(Array(SUB_COUNT).fill(null));
    setNextSub(null);
    setWinner(null);
    setWinLine(null);
  };

  const nextRound = () => startNewRound(other(startedBy));

  const resetAll = () => {
    setScores({ X: 0, O: 0, draws: 0 });
    startNewRound("X");
  };

  const switchMode = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    startNewRound("X");
  };

  return (
    <>
      <BackButton />
      <GameLayout>
        <header className="space-y-2 text-center">
          <h1 className="bg-gradient-to-r from-violet-400 via-fuchsia-400 to-indigo-400 bg-clip-text text-3xl font-bold tracking-tight text-transparent">
            <Trans id="ultimate.title" message="Ultimate Tic-Tac-Toe" />
          </h1>
          <p className="text-xs uppercase tracking-wider text-neutral-500">
            <Trans
              id="ultimate.rules"
              message="Your cell sends your rival to that sub-board"
            />
          </p>
          <div className="inline-flex rounded-full bg-neutral-900 p-1 text-xs font-medium ring-1 ring-neutral-800">
            <button
              onClick={() => switchMode("2p")}
              className={`rounded-full px-3 py-1.5 transition ${
                mode === "2p"
                  ? "bg-neutral-700 text-white"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              <Trans id="ultimate.mode.2p" message="2 Players" />
            </button>
            <button
              onClick={() => switchMode("ai")}
              className={`rounded-full px-3 py-1.5 transition ${
                mode === "ai"
                  ? "bg-neutral-700 text-white"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              <Trans id="ultimate.mode.ai" message="vs CPU" />
            </button>
          </div>
        </header>

        <section className="flex items-end justify-center gap-8 text-center">
          <div>
            <div
              className={`min-w-[2ch] text-3xl font-bold tabular-nums ${colorFor("X")}`}
            >
              {scores.X}
            </div>
            <div className="text-xs uppercase tracking-wide text-neutral-500">
              X
            </div>
          </div>
          <div>
            <div className="min-w-[2ch] text-2xl font-semibold tabular-nums text-neutral-400">
              {scores.draws}
            </div>
            <div className="text-xs uppercase tracking-wide text-neutral-500">
              <Trans id="ultimate.draws" message="Draws" />
            </div>
          </div>
          <div>
            <div
              className={`min-w-[2ch] text-3xl font-bold tabular-nums ${colorFor("O")}`}
            >
              {scores.O}
            </div>
            <div className="text-xs uppercase tracking-wide text-neutral-500">
              O
            </div>
          </div>
        </section>

        <section className="flex min-h-10 items-center justify-center text-center">
          {phase === "win" && winner ? (
            <p className="text-xl font-bold">
              <span className={colorFor(winner)}>{winner}</span>{" "}
              <Trans id="ultimate.wins" message="wins!" />
            </p>
          ) : phase === "draw" ? (
            <p className="text-xl font-bold text-neutral-300">
              <Trans id="ultimate.draw" message="Draw" />
            </p>
          ) : (
            <p className="text-xl font-bold">
              <Trans id="ultimate.turn" message="Turn:" />{" "}
              <span
                className={`${colorFor(turn)} ${isAiTurn ? "motion-safe:animate-pulse" : ""}`}
              >
                {turn}
              </span>
            </p>
          )}
        </section>

        {/* Meta-grid: 3×3 of sub-boards. Each sub-board is itself a 3×3 grid.
            Larger gap between sub-boards (gap-1.5) vs inside (gap-0.5) makes
            the nesting visible without extra borders. */}
        <section className="flex min-h-0 flex-1 items-start justify-center">
          <div className="grid aspect-square w-full max-h-full grid-cols-3 gap-1.5">
            {Array.from({ length: SUB_COUNT }, (_, sub) => {
              const outcome = subWinners[sub];
              const targeted = nextSub === sub && phase === "playing";
              const playable = isPlayableSub(sub);
              const onWinLine = winLine?.includes(sub) ?? false;
              return (
                <div
                  key={sub}
                  className={`relative grid aspect-square grid-cols-3 gap-0.5 rounded-md p-0.5 transition ${
                    onWinLine
                      ? "bg-neutral-900 ring-2 ring-emerald-500"
                      : targeted
                        ? "bg-neutral-900 ring-1 ring-emerald-500"
                        : outcome
                          ? "bg-neutral-900/20 ring-1 ring-neutral-800/60"
                          : "bg-neutral-900/40 ring-1 ring-neutral-800"
                  }`}
                >
                  {Array.from({ length: CELLS_PER_SUB }, (_, cell) => {
                    const i = flatOf(sub, cell);
                    const value = board[i];
                    const canPlay = playable && value === null;
                    return (
                      <button
                        key={cell}
                        onClick={() => play(i)}
                        disabled={!canPlay}
                        className={`aspect-square select-none rounded text-base font-bold transition active:scale-95 disabled:active:scale-100 ${
                          canPlay
                            ? targeted
                              ? "bg-emerald-900/40 hover:bg-emerald-800/50"
                              : "bg-neutral-800 hover:bg-neutral-700"
                            : "bg-neutral-800/40 disabled:cursor-default"
                        }`}
                      >
                        {value && (
                          <span
                            className={`inline-block motion-safe:animate-rps-tick ${colorFor(value)}`}
                          >
                            {value}
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {outcome && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                      <span
                        className={`text-5xl font-black drop-shadow-lg motion-safe:animate-rps-tick ${
                          outcome === "draw"
                            ? "text-neutral-500"
                            : colorFor(outcome)
                        }`}
                      >
                        {outcome === "draw" ? "—" : outcome}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {phase !== "playing" && (
          <button
            onClick={nextRound}
            className="w-full rounded-full bg-emerald-500 py-3 font-semibold text-neutral-950 transition hover:bg-emerald-400 active:scale-[0.99]"
          >
            <Trans id="common.play_again" message="Play again" />
          </button>
        )}

        <div className="text-center">
          <button
            onClick={resetAll}
            className="text-sm text-neutral-500 transition hover:text-neutral-300"
          >
            <Trans id="common.reset" message="Reset" />
          </button>
        </div>
      </GameLayout>
    </>
  );
}
