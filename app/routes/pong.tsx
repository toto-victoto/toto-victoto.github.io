import { useCallback, useEffect, useRef, useState } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/pong";
import { BackButton } from "../components/BackButton";
import { GameLayout } from "../components/GameLayout";
import { PairingPanel } from "../components/PairingPanel";
import { useNetGame, type NetRole } from "../net";
import { useStoredGame } from "../storage";
import { sfx, tone } from "../sound";

// Pong for two phones held the short way: paddles top and bottom rather than
// left and right, and each screen is drawn from ITS OWN end — your paddle is
// always the one at the bottom. So both players slide a thumb along the near
// edge and the field simply reads upside down to the other one.
//
// The host simulates. Every frame it dispatches a `tick`, the referee steps the
// ball, and the result goes over the wire; the guest only ever sends where its
// thumb is. That is the whole networking story — see `useNetGame` in net.ts.
// The one exception is the guest's own paddle, which it draws from its own
// finger without waiting for the round trip, so the control never feels
// borrowed.
//
// Everything is in field percent: x and y both run 0–100 across their own axis,
// so the maths is resolution-free. Only the ball has to undo that (a circle
// sized in x would go oval on a tall field), which it does with aspect-square.

// The field just takes whatever box the layout gives it — no locked aspect
// ratio, because the physics is normalised per axis (0–100 across each) and so
// doesn't care about the shape. Two phones with different screens still agree
// on every position; only the ball has to undo the stretch, which it does by
// sizing off the width and staying square.
const BALL_R = 3.2; // in x-percent
const PADDLE_W = 22; // in x-percent
const PADDLE_H = 2.2; // in y-percent
const PADDLE_Y = 6; // centre of a paddle, measured from its own end
const SERVE_WAIT = 0.9; // seconds of pause after a point
const START_SPEED = 52; // y-percent per second
const MAX_SPEED = 115;
const SPEEDUP = 1.04; // per paddle hit
const SPIN = 55; // how much an off-centre hit bends the ball
const TARGET = 7;
const MAX_DT = 0.05; // a backgrounded tab must not teleport the ball
const AI_SPEED = 62; // x-percent per second the solo opponent can move

type Stage = "lobby" | "serve" | "rally" | "over";

type Pong = {
  stage: Stage;
  solo: boolean;
  ball: { x: number; y: number; vx: number; vy: number };
  // Paddle centres, in x-percent. `host` defends y=100, `guest` defends y=0.
  paddles: { host: number; guest: number };
  scores: { host: number; guest: number };
  rally: number; // hits in the current exchange
  longest: number;
  wait: number; // seconds left before the serve
  champion: NetRole | null;
};

type Intent =
  | { type: "tick"; dt: number }
  | { type: "paddle"; x: number }
  | { type: "serve" }
  | { type: "reset"; solo: boolean };

const other = (who: NetRole): NetRole => (who === "host" ? "guest" : "host");
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function serveBall(toward: NetRole): Pong["ball"] {
  // Always leaves at a readable angle — never so flat that it crawls across.
  const angle = (Math.random() * 0.5 + 0.25) * (Math.random() < 0.5 ? 1 : -1);
  return {
    x: 50,
    y: 50,
    vx: START_SPEED * angle,
    vy: toward === "host" ? START_SPEED : -START_SPEED,
  };
}

const FRESH: Pong = {
  stage: "lobby",
  solo: false,
  ball: { x: 50, y: 50, vx: 0, vy: 0 },
  paddles: { host: 50, guest: 50 },
  scores: { host: 0, guest: 0 },
  rally: 0,
  longest: 0,
  wait: 0,
  champion: null,
};

// Did the ball just cross this paddle's line, and was the paddle there?
function hits(ball: Pong["ball"], paddleX: number, line: number, coming: number) {
  if (Math.sign(ball.vy) !== coming) return null;
  const reached = coming > 0 ? ball.y + BALL_R >= line : ball.y - BALL_R <= line;
  if (!reached) return null;
  const offset = (ball.x - paddleX) / (PADDLE_W / 2);
  return Math.abs(offset) <= 1 ? offset : null;
}

function point(state: Pong, to: NetRole): Pong {
  const scores = { ...state.scores, [to]: state.scores[to] + 1 };
  const won = scores[to] >= TARGET;
  return {
    ...state,
    scores,
    stage: won ? "over" : "serve",
    champion: won ? to : null,
    wait: SERVE_WAIT,
    rally: 0,
    longest: Math.max(state.longest, state.rally),
    ball: serveBall(other(to)),
  };
}

/** The referee. Pure, and run on the host only — see `useNetGame`. */
export function reduce(state: Pong, intent: Intent, from: NetRole): Pong {
  switch (intent.type) {
    case "paddle": {
      const x = clamp(intent.x, PADDLE_W / 2, 100 - PADDLE_W / 2);
      return { ...state, paddles: { ...state.paddles, [from]: x } };
    }

    case "serve":
      if (state.stage !== "lobby" && state.stage !== "over") return state;
      return {
        ...FRESH,
        solo: state.solo,
        longest: state.longest,
        stage: "serve",
        wait: SERVE_WAIT,
        ball: serveBall(Math.random() < 0.5 ? "host" : "guest"),
      };

    case "reset":
      return { ...FRESH, solo: intent.solo, longest: state.longest };

    case "tick": {
      const dt = Math.min(intent.dt, MAX_DT);
      let next = state;

      // In solo the far paddle chases the ball, but only so fast — that speed
      // cap is the entire difficulty knob.
      if (state.solo && state.stage !== "lobby") {
        const want = state.ball.vy < 0 ? state.ball.x : 50;
        const step = clamp(want - state.paddles.guest, -AI_SPEED * dt, AI_SPEED * dt);
        next = {
          ...next,
          paddles: {
            ...next.paddles,
            guest: clamp(next.paddles.guest + step, PADDLE_W / 2, 100 - PADDLE_W / 2),
          },
        };
      }

      if (next.stage === "serve") {
        const wait = next.wait - dt;
        return wait > 0 ? { ...next, wait } : { ...next, wait: 0, stage: "rally" };
      }
      if (next.stage !== "rally") return next;

      const b = next.ball;
      let { x, y, vx, vy } = b;
      x += vx * dt;
      y += vy * dt;

      // Side walls.
      if (x < BALL_R) {
        x = BALL_R;
        vx = Math.abs(vx);
      } else if (x > 100 - BALL_R) {
        x = 100 - BALL_R;
        vx = -Math.abs(vx);
      }

      // Paddles. `host` guards the bottom (y = 100), `guest` the top.
      const moving = { ...b, x, y, vx, vy };
      const low = hits(moving, next.paddles.host, 100 - PADDLE_Y, 1);
      const high = hits(moving, next.paddles.guest, PADDLE_Y, -1);
      const off = low ?? high;
      if (off !== null) {
        const speed = Math.min(Math.hypot(vx, vy) * SPEEDUP, MAX_SPEED);
        vy = -vy;
        vx = clamp(vx + off * SPIN, -speed * 0.9, speed * 0.9);
        // Renormalise so a steep spin can't quietly make the ball faster.
        const now = Math.hypot(vx, vy) || 1;
        vx = (vx / now) * speed;
        vy = (vy / now) * speed;
        y = low !== null ? 100 - PADDLE_Y - BALL_R : PADDLE_Y + BALL_R;
        return { ...next, ball: { x, y, vx, vy }, rally: next.rally + 1 };
      }

      // Missed.
      if (y > 100 + BALL_R) return point(next, "guest");
      if (y < -BALL_R) return point(next, "host");

      return { ...next, ball: { x, y, vx, vy } };
    }
  }
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Pong — toto-victoto" },
    { name: "description", content: "Two-phone Pong over a direct link." },
  ];
}

export default function PongGame() {
  const { state, dispatch, isHost, net } = useNetGame<Pong, Intent>(FRESH, reduce);
  const [{ best }, setBest] = useStoredGame("pong", { best: 0 });
  const [solo, setSolo] = useState(false);
  const linked = net.phase === "connected";
  const me: NetRole = net.role === "guest" ? "guest" : "host";
  const playing = linked || solo;

  const fieldRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<number | null>(null);
  // The guest draws its own paddle from its own finger rather than waiting for
  // the state to come back, so steering never feels like it is on a leash.
  const [localPaddle, setLocalPaddle] = useState(50);

  // Only the host simulates. Exactly one clock, so the two can never disagree.
  useEffect(() => {
    if (!isHost || !playing) return;
    const step = (t: number) => {
      if (lastRef.current !== null) {
        dispatch({ type: "tick", dt: (t - lastRef.current) / 1000 });
      }
      lastRef.current = t;
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      lastRef.current = null;
    };
  }, [isHost, playing, dispatch]);

  const aim = useCallback(
    (clientX: number) => {
      const box = fieldRef.current?.getBoundingClientRect();
      if (!box) return;
      const x = clamp(((clientX - box.left) / box.width) * 100, 0, 100);
      // The guest's screen is the field upside down, so its x runs backwards.
      const sent = me === "guest" ? 100 - x : x;
      setLocalPaddle(clamp(x, PADDLE_W / 2, 100 - PADDLE_W / 2));
      dispatch({ type: "paddle", x: sent });
    },
    [dispatch, me],
  );

  // Ball sounds, driven off the state rather than the physics so both phones
  // hear the same hits.
  const rallyRef = useRef(state.rally);
  useEffect(() => {
    if (state.rally > rallyRef.current) tone(520, 0.05, { type: "square", gain: 0.09 });
    rallyRef.current = state.rally;
  }, [state.rally]);

  const scoreRef = useRef(state.scores);
  useEffect(() => {
    const before = scoreRef.current;
    if (state.scores[me] > before[me]) sfx.score();
    else if (state.scores[other(me)] > before[other(me)]) sfx.lose();
    scoreRef.current = state.scores;
  }, [state.scores, me]);

  useEffect(() => {
    if (state.longest > best) setBest({ best: state.longest });
  }, [state.longest, best, setBest]);

  // ---- not playing yet ----
  if (!playing) {
    return (
      <>
        <BackButton />
        <GameLayout>
          <header className="text-center">
            <h1 className="text-3xl font-semibold tracking-tight">
              <Trans id="pong.title" message="Pong" />
            </h1>
            <p className="mt-1 text-sm text-neutral-400">
              <Trans
                id="pong.tagline"
                message="One paddle each, one ball between two phones."
              />
            </p>
          </header>
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
            <PairingPanel game="pong" />
            <button
              onClick={() => {
                dispatch({ type: "reset", solo: true });
                setSolo(true);
              }}
              className="rounded-full px-4 py-2 text-sm text-neutral-400 hover:text-neutral-200"
            >
              <Trans id="pong.solo" message="Play the computer" />
            </button>
            {best > 0 && (
              <p className="text-sm text-neutral-500 tabular-nums">
                <Trans id="pong.longest" message="Longest rally" /> {best}
              </p>
            )}
          </div>
        </GameLayout>
      </>
    );
  }

  // ---- the field ----
  // Drawn from this player's end: their paddle at the bottom, the ball's y
  // mirrored for the guest so both see the ball coming towards them.
  const flip = me === "guest";
  const ballY = flip ? 100 - state.ball.y : state.ball.y;
  const ballX = flip ? 100 - state.ball.x : state.ball.x;
  const nearRaw = state.paddles[me];
  const near = flip ? localPaddle : nearRaw;
  const farRaw = state.paddles[other(me)];
  const far = flip ? 100 - farRaw : farRaw;

  return (
    <>
      <BackButton />
      <GameLayout>
        <header className="text-center">
          <p className="text-2xl font-bold tabular-nums">
            <span className="text-emerald-400">{state.scores[me]}</span>
            <span className="mx-2 text-neutral-600">—</span>
            <span className="text-neutral-400">{state.scores[other(me)]}</span>
          </p>
          <p className="text-xs text-neutral-500 tabular-nums">
            <Trans id="pong.rally" message="Rally" /> {state.rally}
            {best > 0 && (
              <>
                {" · "}
                <Trans id="pong.longest" message="Longest rally" /> {best}
              </>
            )}
          </p>
        </header>

        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div
            ref={fieldRef}
            // Capturing the pointer is what makes a drag keep steering after
            // the finger leaves the field — but it also swallows the click on
            // any button sitting over the field, so those are let through.
            onPointerDown={(e) => {
              if ((e.target as Element).closest("button")) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              aim(e.clientX);
            }}
            onPointerMove={(e) => {
              if (e.buttons === 0 && e.pointerType === "mouse") return;
              if ((e.target as Element).closest("button")) return;
              aim(e.clientX);
            }}
            className="relative h-full w-full touch-none overflow-hidden rounded-2xl bg-neutral-900 ring-1 ring-neutral-800 select-none"
          >
            {/* Half-way line */}
            <div
              className="absolute inset-x-0 top-1/2 border-t-2 border-dashed border-neutral-800"
              aria-hidden="true"
            />

            {/* Their paddle, at the far end */}
            <div
              className="absolute rounded-full bg-neutral-500"
              style={{
                left: `${far}%`,
                top: `${PADDLE_Y}%`,
                width: `${PADDLE_W}%`,
                height: `${PADDLE_H}%`,
                transform: "translate(-50%, -50%)",
              }}
            />

            {/* Yours, at the near end */}
            <div
              className="absolute rounded-full bg-emerald-400"
              style={{
                left: `${near}%`,
                bottom: `${PADDLE_Y}%`,
                width: `${PADDLE_W}%`,
                height: `${PADDLE_H}%`,
                transform: "translate(-50%, 50%)",
              }}
            />

            {/* The ball, sized off the width so it stays round on a tall field */}
            <div
              className="absolute aspect-square rounded-full bg-neutral-100"
              style={{
                left: `${ballX}%`,
                top: `${ballY}%`,
                width: `${BALL_R * 2}%`,
                transform: "translate(-50%, -50%)",
                visibility: state.stage === "lobby" ? "hidden" : "visible",
              }}
            />

            {(state.stage === "lobby" || state.stage === "over") && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-neutral-950/70 px-6 text-center">
                {state.stage === "over" ? (
                  <p className="text-2xl font-bold">
                    {state.champion === me ? (
                      <Trans id="pong.won" message="You win!" />
                    ) : (
                      <Trans id="pong.lost" message="They win." />
                    )}
                  </p>
                ) : (
                  <p className="text-sm font-medium text-neutral-300">
                    <Trans
                      id="pong.hint"
                      message="Slide your thumb along the bottom to move."
                    />
                  </p>
                )}
                {isHost ? (
                  <button
                    onClick={() => dispatch({ type: "serve" })}
                    className="rounded-full bg-emerald-500 px-6 py-2.5 font-semibold text-neutral-900 hover:bg-emerald-400"
                  >
                    {state.stage === "over" ? (
                      <Trans id="common.play_again" message="Play again" />
                    ) : (
                      <Trans id="pong.serve" message="Serve" />
                    )}
                  </button>
                ) : (
                  <p className="text-sm text-neutral-400">
                    <Trans id="pong.waitserve" message="Waiting for the serve…" />
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {net.phase === "closed" && (
          <p className="text-center text-sm text-amber-300">
            <Trans id="net.lost" message="The other phone dropped out." />
          </p>
        )}
      </GameLayout>
    </>
  );
}
