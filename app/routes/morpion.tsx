import { useState } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/morpion";
import { BackButton } from "../components/BackButton";

type Player = "X" | "O";
type Cell = Player | null;

// Every winning triple on a 3×3 board: the three rows, three columns and
// both diagonals. Indices are 0–8, row-major.
const LINES: number[][] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

function checkWin(b: Cell[]): { winner: Player; line: number[] } | null {
  for (const line of LINES) {
    const [a, c, d] = line;
    if (b[a] && b[a] === b[c] && b[a] === b[d]) {
      return { winner: b[a] as Player, line };
    }
  }
  return null;
}

const other = (p: Player): Player => (p === "X" ? "O" : "X");
const colorFor = (p: Player) =>
  p === "X" ? "text-sky-400" : "text-amber-400";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Morpion — toto-victoto" },
    {
      name: "description",
      content: "A two-player tic-tac-toe game on the same device.",
    },
  ];
}

export default function Morpion() {
  const [board, setBoard] = useState<Cell[]>(() => Array(9).fill(null));
  const [turn, setTurn] = useState<Player>("X");
  // Who opened the current round — flipped at every reset so the starter
  // alternates between rounds (neither side gets the first-move advantage
  // every time).
  const [startedBy, setStartedBy] = useState<Player>("X");
  const [winner, setWinner] = useState<Player | null>(null);
  const [winLine, setWinLine] = useState<number[] | null>(null);
  const [scores, setScores] = useState({ X: 0, O: 0, draws: 0 });

  const isDraw = !winner && board.every((c) => c !== null);
  const phase: "playing" | "win" | "draw" = winner
    ? "win"
    : isDraw
      ? "draw"
      : "playing";

  const play = (i: number) => {
    if (phase !== "playing" || board[i]) return;
    const next = [...board];
    next[i] = turn;
    setBoard(next);
    const w = checkWin(next);
    if (w) {
      setWinner(w.winner);
      setWinLine(w.line);
      setScores((s) => ({ ...s, [w.winner]: s[w.winner] + 1 }));
    } else if (next.every((c) => c !== null)) {
      setScores((s) => ({ ...s, draws: s.draws + 1 }));
    } else {
      setTurn(other(turn));
    }
  };

  const nextRound = () => {
    const next = other(startedBy);
    setStartedBy(next);
    setTurn(next);
    setBoard(Array(9).fill(null));
    setWinner(null);
    setWinLine(null);
  };

  const resetAll = () => {
    setScores({ X: 0, O: 0, draws: 0 });
    setStartedBy("X");
    setTurn("X");
    setBoard(Array(9).fill(null));
    setWinner(null);
    setWinLine(null);
  };

  return (
    <>
      <BackButton />
      <main className="min-h-dvh bg-neutral-950 text-neutral-100 p-6 pt-24 pb-12">
        <div className="max-w-sm mx-auto space-y-5">
          <header className="text-center">
            <h1 className="text-3xl font-semibold tracking-tight">
              <Trans id="morpion.title" message="Tic-Tac-Toe" />
            </h1>
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

          <section className="grid grid-cols-3 gap-2">
            {board.map((cell, i) => {
              const isWinning = winLine?.includes(i) ?? false;
              const canPlay = !cell && phase === "playing";
              return (
                <button
                  key={i}
                  onClick={() => play(i)}
                  disabled={!canPlay}
                  className={`aspect-square select-none rounded-xl text-6xl font-bold transition active:scale-95 disabled:active:scale-100 ${
                    isWinning
                      ? "bg-neutral-800 ring-2 ring-emerald-500"
                      : "bg-neutral-800 hover:bg-neutral-700"
                  }`}
                >
                  {cell && (
                    <span
                      className={`inline-block motion-safe:animate-rps-tick ${colorFor(cell)}`}
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
