import { useEffect, useState } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/rps";
import { BackButton } from "../components/BackButton";

type Move = "rock" | "paper" | "scissors";
type Outcome = "win" | "lose" | "draw";

const MOVES: { id: Move; emoji: string }[] = [
  { id: "rock", emoji: "✊" },
  { id: "paper", emoji: "✋" },
  { id: "scissors", emoji: "✌️" },
];

const BEATS: Record<Move, Move> = {
  rock: "scissors",
  paper: "rock",
  scissors: "paper",
};

const COUNT_TICK_MS = 200;
const COUNT_START = 3;

function judge(player: Move, cpu: Move): Outcome {
  if (player === cpu) return "draw";
  return BEATS[player] === cpu ? "win" : "lose";
}

function randomMove(): Move {
  return MOVES[Math.floor(Math.random() * MOVES.length)].id;
}

function emojiOf(m: Move): string {
  return MOVES.find((x) => x.id === m)!.emoji;
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Rock Paper Scissors — toto-victoto" },
    {
      name: "description",
      content: "Play rock paper scissors against the computer.",
    },
  ];
}

type Phase =
  | { type: "idle" }
  | {
      type: "counting";
      count: number;
      player: Move;
      cpu: Move;
      outcome: Outcome;
    }
  | { type: "revealed"; player: Move; cpu: Move; outcome: Outcome };

export default function RPS() {
  const [phase, setPhase] = useState<Phase>({ type: "idle" });
  const [score, setScore] = useState({ player: 0, cpu: 0 });

  useEffect(() => {
    if (phase.type !== "counting") return;
    const t = setTimeout(() => {
      if (phase.count > 1) {
        setPhase({ ...phase, count: phase.count - 1 });
      } else {
        setPhase({
          type: "revealed",
          player: phase.player,
          cpu: phase.cpu,
          outcome: phase.outcome,
        });
        setScore((s) => ({
          player: s.player + (phase.outcome === "win" ? 1 : 0),
          cpu: s.cpu + (phase.outcome === "lose" ? 1 : 0),
        }));
      }
    }, COUNT_TICK_MS);
    return () => clearTimeout(t);
  }, [phase]);

  const play = (player: Move) => {
    if (phase.type === "counting") return;
    const cpu = randomMove();
    const outcome = judge(player, cpu);
    setPhase({ type: "counting", count: COUNT_START, player, cpu, outcome });
  };

  const reset = () => {
    setPhase({ type: "idle" });
    setScore({ player: 0, cpu: 0 });
  };

  const isCounting = phase.type === "counting";
  const hasHistory =
    phase.type !== "idle" || score.player > 0 || score.cpu > 0;

  return (
    <>
      <BackButton />
      <main className="min-h-dvh bg-neutral-950 text-neutral-100 p-6 pt-24 pb-12">
        <div className="max-w-md mx-auto space-y-10">
          <header className="text-center">
            <h1 className="text-3xl font-semibold tracking-tight">
              <Trans id="rps.title" message="Rock Paper Scissors" />
            </h1>
          </header>

          <section className="flex items-center justify-around text-center">
            <ScoreCell
              label={<Trans id="rps.score.you" message="You" />}
              value={score.player}
            />
            <span aria-hidden="true" className="text-neutral-700 text-2xl">
              ·
            </span>
            <ScoreCell
              label={<Trans id="rps.score.cpu" message="CPU" />}
              value={score.cpu}
            />
          </section>

          <section className="min-h-32 flex items-center justify-center">
            {phase.type === "idle" && (
              <p className="text-neutral-400">
                <Trans id="rps.choose" message="Choose your move" />
              </p>
            )}
            {phase.type === "counting" && (
              <div className="text-center space-y-2">
                <div className="text-5xl" aria-hidden="true">
                  {emojiOf(phase.player)}
                </div>
                <div
                  key={phase.count}
                  className="text-3xl font-bold tabular-nums text-neutral-400 motion-safe:animate-rps-tick"
                  aria-live="polite"
                >
                  {phase.count}
                </div>
              </div>
            )}
            {phase.type === "revealed" && <RoundResult round={phase} />}
          </section>

          <section className="grid grid-cols-3 gap-4">
            {MOVES.map((m) => (
              <button
                key={m.id}
                onClick={() => play(m.id)}
                disabled={isCounting}
                aria-label={m.id}
                className="aspect-square rounded-2xl bg-neutral-800 hover:bg-neutral-700 active:scale-95 disabled:opacity-50 disabled:hover:bg-neutral-800 disabled:active:scale-100 transition text-5xl flex items-center justify-center"
              >
                <span aria-hidden="true">{m.emoji}</span>
              </button>
            ))}
          </section>

          {hasHistory && (
            <div className="text-center">
              <button
                onClick={reset}
                disabled={isCounting}
                className="text-sm text-sky-400 hover:underline disabled:opacity-50"
              >
                <Trans id="rps.reset" message="Reset" />
              </button>
            </div>
          )}
        </div>
      </main>
    </>
  );
}

function ScoreCell({
  label,
  value,
}: {
  label: React.ReactNode;
  value: number;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

function RoundResult({
  round,
}: {
  round: { player: Move; cpu: Move; outcome: Outcome };
}) {
  const tone =
    round.outcome === "win"
      ? "text-emerald-400"
      : round.outcome === "lose"
        ? "text-rose-400"
        : "text-neutral-400";

  return (
    <div className="text-center space-y-3">
      <div className="flex items-center justify-center gap-6 text-5xl">
        <span aria-hidden="true">{emojiOf(round.player)}</span>
        <span className="text-neutral-600 text-2xl">vs</span>
        <span aria-hidden="true">{emojiOf(round.cpu)}</span>
      </div>
      <div className={`text-lg font-medium ${tone}`}>
        {round.outcome === "win" && (
          <Trans id="rps.win" message="You win!" />
        )}
        {round.outcome === "lose" && (
          <Trans id="rps.lose" message="You lose." />
        )}
        {round.outcome === "draw" && <Trans id="rps.draw" message="Draw" />}
      </div>
    </div>
  );
}
