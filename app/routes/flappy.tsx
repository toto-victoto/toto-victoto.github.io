import { useEffect, useRef, useState } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/flappy";
import { BackButton } from "../components/BackButton";

// All positions are expressed in % of the playfield, so the game is
// resolution-independent and scales with the responsive container.
const BIRD_X = 28; // % from the left edge
const BIRD_HALF = 4; // % half-size of the bird's hitbox
const GROUND_Y = 86; // % from the top — bird rests here
const START_Y = 35; // % from the top — where the bird begins

// Physics in %-of-field per second. Multiplying by dt keeps the motion
// identical regardless of the screen's refresh rate.
const GRAVITY = 560; // %/s² downward acceleration
const FLAP_VELOCITY = -120; // %/s upward impulse — replaces velocity on each tap
const MAX_DT = 0.05; // clamp dt so a backgrounded tab can't teleport the bird

// Bird tilt: snaps to FLAP_ROTATION (nose up) on each flap, then noses down
// toward MAX_ROTATION. 180°/s ≈ 3°/frame at 60fps → -45°→90° in ~0.75s.
const FLAP_ROTATION = -45; // deg
const MAX_ROTATION = 90; // deg — pointing straight down
const ROT_PER_SEC = 180; // deg/s

// Pipes
const PIPE_SPEED = 35; // %/s leftward scroll
const PIPE_WIDTH = 16; // % wide
const PIPE_SPACING = 55; // % horizontal distance between consecutive pipes
const GAP_MIN = 25; // % — smallest (hardest) opening
const GAP_MAX = 40; // % — largest (easiest) opening
const GAP_EDGE = 8; // % — keep the opening this far from the top edge / ground

type Pipe = { id: number; x: number; gapY: number; gap: number };
type Phase = "idle" | "playing" | "gameover";

function makeGap(): { gap: number; gapY: number } {
  const gap = GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN);
  const minCenter = GAP_EDGE + gap / 2;
  const maxCenter = GROUND_Y - GAP_EDGE - gap / 2;
  const gapY = minCenter + Math.random() * (maxCenter - minCenter);
  return { gap, gapY };
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Flappy — toto-victoto" },
    { name: "description", content: "A Flappy Bird style mini-game." },
  ];
}

export default function Flappy() {
  const [birdY, setBirdY] = useState(START_Y);
  const [pipes, setPipes] = useState<Pipe[]>([]);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [rotation, setRotation] = useState(0);

  const velocityRef = useRef(0);
  const rotationRef = useRef(0);
  const lastTimeRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const pipeIdRef = useRef(0);
  const scoredRef = useRef<Set<number>>(new Set());
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  const flap = () => {
    if (phaseRef.current === "gameover") return;
    if (phaseRef.current === "idle") setPhase("playing");
    velocityRef.current = FLAP_VELOCITY;
    rotationRef.current = FLAP_ROTATION;
    setRotation(FLAP_ROTATION);
  };

  const reset = () => {
    setBirdY(START_Y);
    setPipes([]);
    setScore(0);
    velocityRef.current = FLAP_VELOCITY;
    rotationRef.current = FLAP_ROTATION;
    setRotation(FLAP_ROTATION);
    scoredRef.current = new Set();
    lastTimeRef.current = null;
    setPhase("playing");
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " ") return;
      e.preventDefault();
      if (phaseRef.current === "gameover") reset();
      else flap();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const step = (t: number) => {
      if (lastTimeRef.current !== null && phaseRef.current === "playing") {
        const dt = Math.min((t - lastTimeRef.current) / 1000, MAX_DT);

        velocityRef.current += GRAVITY * dt;
        setBirdY((prev) => Math.min(prev + velocityRef.current * dt, GROUND_Y));

        rotationRef.current = Math.min(
          rotationRef.current + ROT_PER_SEC * dt,
          MAX_ROTATION,
        );
        setRotation(rotationRef.current);

        setPipes((prev) => {
          const moved = prev
            .map((p) => ({ ...p, x: p.x - PIPE_SPEED * dt }))
            .filter((p) => p.x > -PIPE_WIDTH);
          const last = moved[moved.length - 1];
          if (!last || last.x < 100 - PIPE_SPACING) {
            moved.push({ id: pipeIdRef.current++, x: 100, ...makeGap() });
          }
          return moved;
        });
      }
      lastTimeRef.current = t;
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      lastTimeRef.current = null;
    };
  }, []);

  // Score: +1 when a pipe's right edge passes the bird (counted once per id).
  useEffect(() => {
    if (phase !== "playing") return;
    let gained = 0;
    for (const p of pipes) {
      if (!scoredRef.current.has(p.id) && p.x + PIPE_WIDTH < BIRD_X) {
        scoredRef.current.add(p.id);
        gained += 1;
      }
    }
    if (gained) setScore((s) => s + gained);
  }, [pipes, phase]);

  // Collision: end the game when the bird hits the ground or a pipe.
  useEffect(() => {
    if (phase !== "playing") return;
    const hitGround = birdY >= GROUND_Y;
    const hitPipe = pipes.some((p) => {
      const overlapX =
        p.x < BIRD_X + BIRD_HALF && p.x + PIPE_WIDTH > BIRD_X - BIRD_HALF;
      if (!overlapX) return false;
      const gapTop = p.gapY - p.gap / 2;
      const gapBottom = p.gapY + p.gap / 2;
      return birdY - BIRD_HALF < gapTop || birdY + BIRD_HALF > gapBottom;
    });
    if (hitGround || hitPipe) setPhase("gameover");
  }, [birdY, pipes, phase]);

  // Track the best score of the session.
  useEffect(() => {
    if (phase === "gameover") setBest((b) => Math.max(b, score));
  }, [phase, score]);

  return (
    <>
      <BackButton />
      <main className="min-h-dvh bg-neutral-950 text-neutral-100 p-6 pt-24 pb-12">
        <div className="max-w-sm mx-auto space-y-6">
          <header className="text-center">
            <h1 className="text-3xl font-semibold tracking-tight">
              <Trans id="flappy.title" message="Flappy" />
            </h1>
          </header>

          <div
            onPointerDown={flap}
            className="relative w-full aspect-[3/4] overflow-hidden rounded-2xl bg-gradient-to-b from-sky-400 to-sky-200 select-none touch-none cursor-pointer"
          >
            {pipes.map((p) => {
              const gapTop = p.gapY - p.gap / 2;
              const gapBottom = p.gapY + p.gap / 2;
              return (
                <div key={p.id} aria-hidden="true">
                  <div
                    className="absolute bg-green-600"
                    style={{
                      left: `${p.x}%`,
                      width: `${PIPE_WIDTH}%`,
                      top: 0,
                      height: `${gapTop}%`,
                    }}
                  />
                  <div
                    className="absolute bg-green-600"
                    style={{
                      left: `${p.x}%`,
                      width: `${PIPE_WIDTH}%`,
                      top: `${gapBottom}%`,
                      bottom: 0,
                    }}
                  />
                </div>
              );
            })}

            <div
              className="absolute text-4xl"
              style={{
                left: `${BIRD_X}%`,
                top: `${birdY}%`,
                transform: `translate(-50%, -50%) rotate(${rotation}deg) scaleX(-1)`,
              }}
              aria-hidden="true"
            >
              🐤
            </div>

            <div className="absolute inset-x-0 bottom-0 h-[12%] bg-green-600/90" />

            <div className="absolute top-3 inset-x-0 text-center text-4xl font-bold tabular-nums text-white [text-shadow:_0_2px_4px_rgb(0_0_0_/_40%)]">
              {score}
            </div>

            {phase !== "playing" && (
              <div
                onPointerDown={(e) => e.stopPropagation()}
                className={`absolute inset-0 flex items-center justify-center bg-neutral-950/40 backdrop-blur-[1px] ${
                  phase === "idle" ? "pointer-events-none" : ""
                }`}
              >
                <div className="text-center space-y-3 px-6">
                  {phase === "idle" ? (
                    <p className="text-lg font-medium text-white [text-shadow:_0_2px_4px_rgb(0_0_0_/_50%)]">
                      <Trans
                        id="flappy.start"
                        message="Tap or press Space to start"
                      />
                    </p>
                  ) : (
                    <>
                      <p className="text-3xl font-bold text-white">
                        <Trans id="flappy.gameover" message="Game over" />
                      </p>
                      <p className="text-sm text-white/90">
                        <Trans id="common.best" message="Best" />{" "}
                        <span className="font-bold tabular-nums">{best}</span>
                      </p>
                      <button
                        onClick={reset}
                        className="rounded-full bg-white/90 px-8 py-3 text-lg font-semibold text-neutral-900 hover:bg-white"
                      >
                        <Trans id="common.play_again" message="Play again" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
