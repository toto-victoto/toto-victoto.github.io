import { useEffect, useRef, useState } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/snake";
import { BackButton } from "../components/BackButton";

const COLS = 15;
const ROWS = 15;
const TICK_MS = 175;
const SWIPE_THRESHOLD = 20;

type Dir = "up" | "down" | "left" | "right";
type Cell = { x: number; y: number };
type Phase = "idle" | "playing" | "gameover";

const OPPOSITE: Record<Dir, Dir> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};

const DELTA: Record<Dir, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

function makeInitialSnake(): Cell[] {
  const cy = Math.floor(ROWS / 2);
  const cx = Math.floor(COLS / 2);
  return [
    { x: cx, y: cy },
    { x: cx - 1, y: cy },
    { x: cx - 2, y: cy },
  ];
}

function randomFood(snake: Cell[]): Cell {
  const occupied = new Set(snake.map((c) => `${c.x},${c.y}`));
  const free: Cell[] = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (!occupied.has(`${x},${y}`)) free.push({ x, y });
    }
  }
  if (free.length === 0) return { x: 0, y: 0 };
  return free[Math.floor(Math.random() * free.length)];
}

const KEY_TO_DIR: Record<string, Dir> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  W: "up",
  z: "up",
  Z: "up",
  s: "down",
  S: "down",
  a: "left",
  A: "left",
  q: "left",
  Q: "left",
  d: "right",
  D: "right",
};

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Snake — toto-victoto" },
    {
      name: "description",
      content: "Play snake with swipe gestures or arrow keys.",
    },
  ];
}

export default function Snake() {
  const [snake, setSnake] = useState<Cell[]>(makeInitialSnake);
  const [food, setFood] = useState<Cell>(() => randomFood(makeInitialSnake()));
  const [phase, setPhase] = useState<Phase>("idle");
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);

  const dirRef = useRef<Dir>("right");
  const dirQueueRef = useRef<Dir[]>([]);
  const phaseRef = useRef<Phase>(phase);
  const foodRef = useRef<Cell>(food);
  phaseRef.current = phase;
  foodRef.current = food;
  const touchAnchorRef = useRef<{ x: number; y: number } | null>(null);

  const queueDir = (d: Dir) => {
    if (phaseRef.current === "gameover") return;
    const queue = dirQueueRef.current;
    const last = queue.length ? queue[queue.length - 1] : dirRef.current;
    if (d === last || OPPOSITE[d] === last) return;
    if (queue.length < 4) queue.push(d);
    if (phaseRef.current === "idle") setPhase("playing");
  };

  const reset = () => {
    const s = makeInitialSnake();
    setSnake(s);
    setFood(randomFood(s));
    dirRef.current = "right";
    dirQueueRef.current = [];
    setScore(0);
    setPhase("idle");
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = KEY_TO_DIR[e.key];
      if (!d) return;
      e.preventDefault();
      queueDir(d);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (phase !== "playing") return;
    const id = setInterval(() => {
      setSnake((current) => {
        const nextDir = dirQueueRef.current.shift();
        if (nextDir && OPPOSITE[nextDir] !== dirRef.current) {
          dirRef.current = nextDir;
        }
        const [dx, dy] = DELTA[dirRef.current];
        const head = current[0];
        const next: Cell = { x: head.x + dx, y: head.y + dy };
        if (next.x < 0 || next.x >= COLS || next.y < 0 || next.y >= ROWS) {
          setPhase("gameover");
          return current;
        }
        const eats =
          next.x === foodRef.current.x && next.y === foodRef.current.y;
        const body = eats ? current : current.slice(0, -1);
        if (body.some((c) => c.x === next.x && c.y === next.y)) {
          setPhase("gameover");
          return current;
        }
        const nextSnake = [next, ...body];
        if (eats) {
          setScore((s) => s + 1);
          setFood(randomFood(nextSnake));
        }
        return nextSnake;
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [phase]);

  useEffect(() => {
    if (phase === "gameover") setBest((b) => Math.max(b, score));
  }, [phase, score]);

  const handleTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchAnchorRef.current = { x: t.clientX, y: t.clientY };
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const anchor = touchAnchorRef.current;
    if (!anchor) return;
    const t = e.touches[0];
    const dx = t.clientX - anchor.x;
    const dy = t.clientY - anchor.y;
    if (Math.abs(dx) < SWIPE_THRESHOLD && Math.abs(dy) < SWIPE_THRESHOLD) return;
    if (Math.abs(dx) > Math.abs(dy)) {
      queueDir(dx > 0 ? "right" : "left");
    } else {
      queueDir(dy > 0 ? "down" : "up");
    }
    touchAnchorRef.current = { x: t.clientX, y: t.clientY };
  };

  const handleTouchEnd = () => {
    touchAnchorRef.current = null;
  };

  const cellState = new Map<string, "head" | "body" | "food">();
  snake.forEach((c, i) =>
    cellState.set(`${c.x},${c.y}`, i === 0 ? "head" : "body"),
  );
  if (!cellState.has(`${food.x},${food.y}`)) {
    cellState.set(`${food.x},${food.y}`, "food");
  }

  return (
    <>
      <BackButton />
      <main className="min-h-dvh bg-neutral-950 text-neutral-100 p-6 pt-24 pb-12">
        <div className="max-w-md mx-auto space-y-8">
          <header className="text-center">
            <h1 className="text-3xl font-semibold tracking-tight">
              <Trans id="snake.title" message="Snake" />
            </h1>
          </header>

          <section className="flex items-center justify-around text-center">
            <ScoreCell
              label={<Trans id="snake.score" message="Score" />}
              value={score}
            />
            <span aria-hidden="true" className="text-neutral-700 text-2xl">
              ·
            </span>
            <ScoreCell
              label={<Trans id="snake.best" message="Best" />}
              value={best}
            />
          </section>

          <section
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            className="relative touch-none select-none"
          >
            <div
              className="grid w-full aspect-square rounded-2xl bg-neutral-900 p-1 gap-px"
              style={{
                gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${ROWS}, minmax(0, 1fr))`,
              }}
              role="grid"
              aria-label="Snake board"
            >
              {Array.from({ length: ROWS * COLS }).map((_, i) => {
                const x = i % COLS;
                const y = Math.floor(i / COLS);
                const state = cellState.get(`${x},${y}`);
                let cls = "rounded-[2px]";
                if (state === "head") cls += " bg-emerald-300";
                else if (state === "body") cls += " bg-emerald-500";
                else if (state === "food")
                  cls += " bg-rose-400 motion-safe:animate-snake-food";
                else cls += " bg-neutral-950/40";
                return <div key={i} className={cls} />;
              })}
            </div>

            {phase !== "playing" && (
              <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-neutral-950/70 backdrop-blur-[2px]">
                <div className="text-center space-y-3 px-6">
                  {phase === "idle" ? (
                    <p className="text-neutral-200">
                      <Trans
                        id="snake.start"
                        message="Swipe or use arrow keys to start"
                      />
                    </p>
                  ) : (
                    <>
                      <p className="text-2xl font-semibold text-rose-300">
                        <Trans id="snake.gameover" message="Game over" />
                      </p>
                      <button
                        onClick={reset}
                        className="text-sm text-sky-400 hover:underline"
                      >
                        <Trans id="snake.reset" message="Play again" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </section>

          <p className="text-center text-xs text-neutral-500">
            <Trans
              id="snake.hint"
              message="Swipe on the board · arrow keys or WASD on desktop"
            />
          </p>
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
