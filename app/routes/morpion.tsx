import { useState } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/morpion";
import { BackButton } from "../components/BackButton";

type Player = "X" | "O";
type Cell = Player | null;
type Placement = { player: Player; index: number };

const BOARD_SIZE = 5;
// Four in a row on a 5×5 board — the attacker needs an open-three before
// completing four, which takes long enough to set up that the defender has
// real chances to block.
const WIN_LEN = 4;
// Each side may hold this many pieces on the board at once. Once at the cap,
// placing a new piece rolls out the player's chronologically oldest one
// (FIFO), so the late game shifts as defenders rotate out.
const PIECES_PER_PLAYER = 8;
// Safety cap. Once both sides are at the piece limit, the board can never
// fill up, so without this the game could loop indefinitely. After this many
// total placements without a winner we declare a draw.
const MAX_TURNS = 50;
const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;

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

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Morpion XTreme 🔥 — toto-victoto" },
    {
      name: "description",
      content:
        "Two-player tic-tac-toe on a 5×5 grid with rolling pieces — 8 pieces max per side, line up four to win.",
    },
  ];
}

export default function Morpion() {
  const [board, setBoard] = useState<Cell[]>(() =>
    Array(CELL_COUNT).fill(null),
  );
  const [turn, setTurn] = useState<Player>("X");
  // Who opened the current round — flipped at every reset so the starter
  // alternates between rounds (neither side keeps the first-move advantage).
  const [startedBy, setStartedBy] = useState<Player>("X");
  // Chronological list of every piece still on the board. Each player's
  // oldest entry is what rolls out when they place their next piece.
  const [placements, setPlacements] = useState<Placement[]>([]);
  // Total placements ever in this round. Needed for the draw cap because
  // `placements.length` plateaus once both sides hit the piece limit.
  const [turnCount, setTurnCount] = useState(0);
  const [winner, setWinner] = useState<Player | null>(null);
  const [winLine, setWinLine] = useState<number[] | null>(null);
  const [scores, setScores] = useState({ X: 0, O: 0, draws: 0 });

  const isDraw = !winner && turnCount >= MAX_TURNS;
  const phase: "playing" | "win" | "draw" = winner
    ? "win"
    : isDraw
      ? "draw"
      : "playing";

  // Each player's oldest piece, but only revealed once they're already at the
  // cap — that's the one the board will eat next time they place.
  const xOldest =
    placements.filter((p) => p.player === "X").length >= PIECES_PER_PLAYER
      ? (placements.find((p) => p.player === "X")?.index ?? null)
      : null;
  const oOldest =
    placements.filter((p) => p.player === "O").length >= PIECES_PER_PLAYER
      ? (placements.find((p) => p.player === "O")?.index ?? null)
      : null;

  const play = (i: number) => {
    if (phase !== "playing" || board[i]) return;
    const nextBoard = [...board];
    const nextPlacements = [...placements];

    const owned = nextPlacements.filter((p) => p.player === turn);
    if (owned.length >= PIECES_PER_PLAYER) {
      // Drop this player's chronologically first piece off the board.
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

  const nextRound = () => {
    const next = other(startedBy);
    setStartedBy(next);
    setTurn(next);
    setBoard(Array(CELL_COUNT).fill(null));
    setPlacements([]);
    setTurnCount(0);
    setWinner(null);
    setWinLine(null);
  };

  const resetAll = () => {
    setScores({ X: 0, O: 0, draws: 0 });
    setStartedBy("X");
    setTurn("X");
    setBoard(Array(CELL_COUNT).fill(null));
    setPlacements([]);
    setTurnCount(0);
    setWinner(null);
    setWinLine(null);
  };

  return (
    <>
      <BackButton />
      <main className="min-h-dvh bg-neutral-950 text-neutral-100 p-6 pt-24 pb-12">
        <div className="max-w-sm mx-auto space-y-5">
          <header className="text-center">
            <h1 className="bg-gradient-to-r from-red-400 via-amber-300 to-red-500 bg-clip-text text-3xl font-bold tracking-tight text-transparent">
              <Trans id="morpion.title" message="Tic-Tac-Toe XTreme 🔥" />
            </h1>
            <p className="mt-1 text-xs uppercase tracking-wider text-neutral-500">
              <Trans
                id="morpion.rules"
                message="8 pieces max — line up 4 to win"
              />
            </p>
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
                <span className={colorFor(turn)}>{turn}</span>
              </p>
            )}
          </section>

          <section className="grid grid-cols-5 gap-1.5">
            {board.map((cell, i) => {
              const isWinning = winLine?.includes(i) ?? false;
              const canPlay = !cell && phase === "playing";
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
              <Trans id="morpion.reset_scores" message="Reset scores" />
            </button>
          </div>
        </div>
      </main>
    </>
  );
}
