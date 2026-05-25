import { useEffect, useState } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/morpion";
import { BackButton } from "../components/BackButton";
import { GameLayout } from "../components/GameLayout";
import { loadGame, saveGame } from "../storage";

type Player = "X" | "O";
type Cell = Player | null;
type Placement = { player: Player; index: number };
type Mode = "2p" | "ai";

const BOARD_SIZE = 5;
const WIN_LEN = 4;
const PIECES_PER_PLAYER = 8;
const MAX_TURNS = 50;
const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;
const AI_DELAY_MS = 500;
const AI_PLAYER: Player = "O";

// Every straight WIN_LEN-in-a-row line that fits on the board: rows, columns,
// and both diagonal directions. Indices are 0–24, row-major.
function buildLines(): number[][] {
  const lines: number[][] = [];
  const idx = (r: number, c: number) => r * BOARD_SIZE + c;
  const max = BOARD_SIZE - WIN_LEN;
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c <= max; c++) {
      lines.push(Array.from({ length: WIN_LEN }, (_, k) => idx(r, c + k)));
    }
  }
  for (let c = 0; c < BOARD_SIZE; c++) {
    for (let r = 0; r <= max; r++) {
      lines.push(Array.from({ length: WIN_LEN }, (_, k) => idx(r + k, c)));
    }
  }
  for (let r = 0; r <= max; r++) {
    for (let c = 0; c <= max; c++) {
      lines.push(Array.from({ length: WIN_LEN }, (_, k) => idx(r + k, c + k)));
    }
  }
  for (let r = 0; r <= max; r++) {
    for (let c = WIN_LEN - 1; c < BOARD_SIZE; c++) {
      lines.push(Array.from({ length: WIN_LEN }, (_, k) => idx(r + k, c - k)));
    }
  }
  return lines;
}

const LINES = buildLines();

function checkWin(b: Cell[]): { winner: Player; line: number[] } | null {
  for (const line of LINES) {
    const first = b[line[0]];
    if (first && line.every((i) => b[i] === first)) {
      return { winner: first as Player, line };
    }
  }
  return null;
}

const other = (p: Player): Player => (p === "X" ? "O" : "X");
const colorFor = (p: Player) =>
  p === "X" ? "text-sky-400" : "text-amber-400";

// Apply a placement the same way play() does, including the FIFO eviction
// when the acting player is already at the piece cap. Used by the AI to
// look one move ahead.
function simulatePlay(
  board: Cell[],
  placements: Placement[],
  player: Player,
  index: number,
): { board: Cell[]; placements: Placement[] } {
  const nextBoard = [...board];
  const nextPlacements = [...placements];
  const owned = nextPlacements.filter((p) => p.player === player);
  if (owned.length >= PIECES_PER_PLAYER) {
    const oldest = owned[0];
    nextBoard[oldest.index] = null;
    const removeAt = nextPlacements.findIndex(
      (p) => p.player === oldest.player && p.index === oldest.index,
    );
    nextPlacements.splice(removeAt, 1);
  }
  nextBoard[index] = player;
  nextPlacements.push({ player, index });
  return { board: nextBoard, placements: nextPlacements };
}

// Heuristic value of every line passing through `cell`, scored from `player`'s
// perspective. Lines already contested by both sides are dead and ignored.
// Extending an own line is weighted slightly higher than blocking an opponent
// line of the same length, so the AI leans offensive at equal opportunity.
function scoreCell(board: Cell[], cell: number, player: Player): number {
  const lineValue = [0, 1, 10, 100]; // 0/1/2/3 same-colour pieces in a 4-cell line
  const opponent = other(player);
  let score = 0;
  for (const line of LINES) {
    if (!line.includes(cell)) continue;
    let mine = 0;
    let opp = 0;
    for (const j of line) {
      if (j === cell) continue;
      if (board[j] === player) mine++;
      else if (board[j] === opponent) opp++;
    }
    if (opp === 0) score += lineValue[mine + 1] ?? 1000;
    if (mine === 0) score += (lineValue[opp] ?? 1000) * 0.7;
  }
  // Slight centrality bias — break ties toward the middle of the board.
  const row = Math.floor(cell / BOARD_SIZE);
  const col = cell % BOARD_SIZE;
  score -= (Math.abs(row - 2) + Math.abs(col - 2)) * 0.5;
  return score;
}

function chooseAIMove(
  board: Cell[],
  placements: Placement[],
  player: Player,
): number {
  const empty: number[] = [];
  for (let i = 0; i < CELL_COUNT; i++) if (!board[i]) empty.push(i);
  if (empty.length === 0) return -1;
  const opponent = other(player);

  // Win immediately if there's a winning placement.
  for (const i of empty) {
    const sim = simulatePlay(board, placements, player, i);
    if (checkWin(sim.board)?.winner === player) return i;
  }
  // Otherwise block any immediate threat from the opponent.
  for (const i of empty) {
    const sim = simulatePlay(board, placements, opponent, i);
    if (checkWin(sim.board)?.winner === opponent) return i;
  }
  // Fall back to the line-based heuristic.
  let bestI = empty[0];
  let bestScore = -Infinity;
  for (const i of empty) {
    const s = scoreCell(board, i, player);
    if (s > bestScore) {
      bestScore = s;
      bestI = i;
    }
  }
  return bestI;
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Morpion XTreme 🔥 — toto-victoto" },
    {
      name: "description",
      content:
        "Two-player tic-tac-toe on a 5×5 grid with rolling pieces — 8 pieces max per side, line up four to win. Play locally or against the CPU.",
    },
  ];
}

export default function Morpion() {
  const [board, setBoard] = useState<Cell[]>(() =>
    Array(CELL_COUNT).fill(null),
  );
  const [turn, setTurn] = useState<Player>("X");
  const [startedBy, setStartedBy] = useState<Player>("X");
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [turnCount, setTurnCount] = useState(0);
  const [winner, setWinner] = useState<Player | null>(null);
  const [winLine, setWinLine] = useState<number[] | null>(null);
  const [scores, setScores] = useState({ X: 0, O: 0, draws: 0 });
  const [mode, setMode] = useState<Mode>("2p");
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from localStorage on mount. The board is derived from placements
  // rather than persisted separately — single source of truth, smaller blob.
  useEffect(() => {
    const saved = loadGame("morpion", {
      mode: "2p" as Mode,
      scores: { X: 0, O: 0, draws: 0 },
      placements: [] as Placement[],
      turn: "X" as Player,
      startedBy: "X" as Player,
      turnCount: 0,
      winner: null as Player | null,
      winLine: null as number[] | null,
    });
    setMode(saved.mode);
    setScores(saved.scores);
    setPlacements(saved.placements);
    setTurn(saved.turn);
    setStartedBy(saved.startedBy);
    setTurnCount(saved.turnCount);
    setWinner(saved.winner);
    setWinLine(saved.winLine);
    const restored: Cell[] = Array(CELL_COUNT).fill(null);
    for (const p of saved.placements) restored[p.index] = p.player;
    setBoard(restored);
    setHydrated(true);
  }, []);

  // Save the whole in-progress round plus cumulative scores and mode on any
  // change. Cheap because the blob is small.
  useEffect(() => {
    if (!hydrated) return;
    saveGame("morpion", {
      mode,
      scores,
      placements,
      turn,
      startedBy,
      turnCount,
      winner,
      winLine,
    });
  }, [
    hydrated,
    mode,
    scores,
    placements,
    turn,
    startedBy,
    turnCount,
    winner,
    winLine,
  ]);

  const isDraw = !winner && turnCount >= MAX_TURNS;
  const phase: "playing" | "win" | "draw" = winner
    ? "win"
    : isDraw
      ? "draw"
      : "playing";

  const xOldest =
    placements.filter((p) => p.player === "X").length >= PIECES_PER_PLAYER
      ? (placements.find((p) => p.player === "X")?.index ?? null)
      : null;
  const oOldest =
    placements.filter((p) => p.player === "O").length >= PIECES_PER_PLAYER
      ? (placements.find((p) => p.player === "O")?.index ?? null)
      : null;

  const isAiTurn = mode === "ai" && turn === AI_PLAYER && phase === "playing";

  const play = (i: number) => {
    if (phase !== "playing" || board[i]) return;
    const nextBoard = [...board];
    const nextPlacements = [...placements];

    const owned = nextPlacements.filter((p) => p.player === turn);
    if (owned.length >= PIECES_PER_PLAYER) {
      const oldest = owned[0];
      nextBoard[oldest.index] = null;
      const removeAt = nextPlacements.findIndex(
        (p) => p.player === oldest.player && p.index === oldest.index,
      );
      nextPlacements.splice(removeAt, 1);
    }

    nextBoard[i] = turn;
    nextPlacements.push({ player: turn, index: i });

    const nextTurnCount = turnCount + 1;
    setBoard(nextBoard);
    setPlacements(nextPlacements);
    setTurnCount(nextTurnCount);

    const w = checkWin(nextBoard);
    if (w) {
      setWinner(w.winner);
      setWinLine(w.line);
      setScores((s) => ({ ...s, [w.winner]: s[w.winner] + 1 }));
    } else if (nextTurnCount >= MAX_TURNS) {
      setScores((s) => ({ ...s, draws: s.draws + 1 }));
    } else {
      setTurn(other(turn));
    }
  };

  // Let the AI take its turn after a short delay so the move doesn't feel
  // instantaneous. The cleanup cancels the timer if anything relevant changes
  // (mode toggled, round reset, game ended) before the AI got to play.
  useEffect(() => {
    if (!isAiTurn) return;
    const id = window.setTimeout(() => {
      const move = chooseAIMove(board, placements, AI_PLAYER);
      if (move >= 0) play(move);
    }, AI_DELAY_MS);
    return () => clearTimeout(id);
    // play() depends on the latest closure, so re-run whenever board state
    // changes — board/placements are already in the deps via isAiTurn's data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAiTurn, board, placements]);

  const startNewRound = (starter: Player) => {
    setStartedBy(starter);
    setTurn(starter);
    setBoard(Array(CELL_COUNT).fill(null));
    setPlacements([]);
    setTurnCount(0);
    setWinner(null);
    setWinLine(null);
  };

  const nextRound = () => startNewRound(other(startedBy));

  const resetAll = () => {
    setScores({ X: 0, O: 0, draws: 0 });
    startNewRound("X");
  };

  // Switching mode wipes the current round (mixing a half-played human round
  // into the AI mid-game would be confusing) but keeps the running score.
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
            <h1 className="bg-gradient-to-r from-red-400 via-amber-300 to-red-500 bg-clip-text text-3xl font-bold tracking-tight text-transparent">
              <Trans id="morpion.title" message="Tic-Tac-Toe XTreme 🔥" />
            </h1>
            <p className="text-xs uppercase tracking-wider text-neutral-500">
              <Trans
                id="morpion.rules"
                message="8 pieces max — line up 4 to win"
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
                <Trans id="morpion.mode.2p" message="2 Players" />
              </button>
              <button
                onClick={() => switchMode("ai")}
                className={`rounded-full px-3 py-1.5 transition ${
                  mode === "ai"
                    ? "bg-neutral-700 text-white"
                    : "text-neutral-400 hover:text-neutral-200"
                }`}
              >
                <Trans id="morpion.mode.ai" message="vs CPU" />
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
                <Trans id="morpion.draws" message="Draws" />
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
                <Trans id="morpion.wins" message="wins!" />
              </p>
            ) : phase === "draw" ? (
              <p className="text-xl font-bold text-neutral-300">
                <Trans id="morpion.draw" message="Draw" />
              </p>
            ) : (
              <p className="text-xl font-bold">
                <Trans id="morpion.turn" message="Turn:" />{" "}
                <span
                  className={`${colorFor(turn)} ${isAiTurn ? "motion-safe:animate-pulse" : ""}`}
                >
                  {turn}
                </span>
              </p>
            )}
          </section>

          {/* Board: wrapper flex absorbs the leftover height; the grid inside
              is aspect-square (so the whole 5×5 stays a square) and each cell
              has its own aspect-square as a belt-and-suspenders guarantee. */}
          <section className="flex min-h-0 flex-1 items-center justify-center">
            <div className="grid aspect-square h-full max-w-full grid-cols-5 gap-1.5">
            {board.map((cell, i) => {
              const isWinning = winLine?.includes(i) ?? false;
              const canPlay = !cell && phase === "playing" && !isAiTurn;
              const willFade = i === xOldest || i === oOldest;
              return (
                <button
                  key={i}
                  onClick={() => play(i)}
                  disabled={!canPlay}
                  className={`aspect-square select-none rounded-lg text-4xl font-bold transition active:scale-95 disabled:active:scale-100 ${
                    isWinning
                      ? "bg-neutral-800 ring-2 ring-emerald-500"
                      : "bg-neutral-800 hover:bg-neutral-700"
                  }`}
                >
                  {cell && (
                    <span
                      className={`inline-block motion-safe:animate-rps-tick ${colorFor(cell)} ${
                        willFade && !isWinning ? "opacity-40" : ""
                      }`}
                    >
                      {cell}
                    </span>
                  )}
                </button>
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
              className="text-sm text-neutral-500 hover:text-neutral-300 transition"
            >
              <Trans id="common.reset" message="Reset" />
            </button>
          </div>
      </GameLayout>
    </>
  );
}
