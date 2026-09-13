import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/cross";
import { BackButton } from "../components/BackButton";
import { GameLayout } from "../components/GameLayout";
import { useStoredGame } from "../storage";
import { sfx, tone } from "../sound";

// Cross — a d-pad dodger. The avatar can only stand on five pads laid out like
// a Nintendo d-pad (centre + up/down/left/right). Projectiles fly across the
// square playfield along six lanes (three columns × three rows, from either
// end); the avatar must hop between pads to stay out of their way, and hop
// *into* the way of the goodies.
//
// All positions are % of the square playfield, so the whole thing scales with
// its container (see AGENTS.md → Game positioning).

// The three lane coordinates: the pads sit at the intersections that exist on a
// cross (never at the corners), so a lane at 50 sweeps three pads while a lane
// at 30 / 70 only clips one arm pad. Every pad is covered by exactly four lane
// directions, so no pad is a safe camp.
//
// The cross is deliberately tucked into the middle of the field rather than
// spread to its edges: that leaves ~30% of runway on every side, so a
// projectile is on screen and readable for half again as long as it would be
// with the arms pushed out to 20 / 80.
const LANES = [30, 50, 70] as const;
type LaneCoord = (typeof LANES)[number];
const LANE_MIN = LANES[0];
const LANE_MAX = LANES[LANES.length - 1];
const PAD_SIZE = 16; // % — visual pad side
const HIT_R = 6; // % — projectile-vs-avatar hit radius (a bit under a pad half)
const CATCH_R = 7.5; // % — bonuses are a touch easier to grab than to dodge
const MAX_DT = 0.05; // clamp dt so a backgrounded tab can't teleport things

// Emoji font sizes, in cqw of the field. Kept a little under the pad so a piece
// never spills past the pad it is standing on.
const AVATAR_EM = 9; // cqw
const PROJ_EM = 8;
const BONUS_EM = 7.5;
const POP_EM = 5.5;

type PadId = "center" | "up" | "down" | "left" | "right";
const PADS: Record<PadId, { x: number; y: number }> = {
  center: { x: 50, y: 50 },
  up: { x: 50, y: LANE_MIN },
  down: { x: 50, y: LANE_MAX },
  left: { x: LANE_MIN, y: 50 },
  right: { x: LANE_MAX, y: 50 },
};

// Swipe control: press anywhere, push in a direction to shift onto that arm,
// release to spring back to centre. Inside this radius of the press point you
// are in neutral — like the gate of a gear stick.
const SWIPE_DEADZONE = 8; // % of the field

// Difficulty ramps with elapsed time: quicker spawns, faster flight, and later
// on a chance to fire two things at once. Values interpolate linearly from
// START to MAX over RAMP_SECONDS.
const RAMP_SECONDS = 90;
const SPAWN_GAP_START = 1.15; // s between spawns
const SPAWN_GAP_MIN = 0.36;
const SPEED_START = 55; // %/s
const SPEED_MAX = 125;
const DOUBLE_CHANCE_MAX = 0.45; // chance a spawn fires a 2nd projectile
const WARN_START = 0.75; // s — telegraph before a projectile takes off
const WARN_MIN = 0.42;
const BONUS_CHANCE = 0.16; // per spawn, replaces the projectile with a goodie
const MAX_LIVES = 3;
const INVULN_S = 1.1; // post-hit mercy window
const SLOW_S = 4; // ⏳ duration
const SLOW_SCALE = 0.45; // time multiplier while ⏳ is active
const SCORE_PER_SEC = 10;
const SCORE_PER_DODGE = 5;
const SCORE_STAR = 60;

const AVATARS = ["🐸", "🐵", "🐱", "🦊", "🐼", "🐧", "🐙", "🦄", "🤖", "👻", "🐢", "🐝", "🐹", "🦖"];
const PROJECTILES = ["🔥", "☄️", "🪨", "💣", "🗡️", "⚡", "🌵", "🧨", "🏀", "🪓"];

type BonusKind = "star" | "shield" | "life" | "slow";
const BONUSES: { kind: BonusKind; emoji: string; weight: number }[] = [
  { kind: "star", emoji: "⭐", weight: 5 },
  { kind: "shield", emoji: "🛡️", weight: 3 },
  { kind: "slow", emoji: "⏳", weight: 2 },
  { kind: "life", emoji: "❤️", weight: 1 },
];

// A projectile or bonus. `axis` is the axis it travels along: "y" means it
// moves vertically down the column x=lane; "x" means horizontally along the
// row y=lane. `dir` is +1 (from the top/left edge) or -1 (from bottom/right).
// `pos` is its coordinate along the axis; it starts just off the edge while
// telegraphed, then flies to the opposite side.
type Entity = {
  id: number;
  kind: "proj" | "bonus";
  bonus?: BonusKind;
  emoji: string;
  axis: "x" | "y";
  lane: LaneCoord;
  dir: 1 | -1;
  pos: number;
  speed: number;
  warnLeft: number; // s of telegraph remaining (0 = flying)
  spin: number; // deg/s, purely cosmetic
  rot: number;
  passed: boolean; // crossed the far pad — counted as dodged
};

type Phase = "idle" | "playing" | "gameover";

// A short-lived floating marker ("+60", "🛡️", "💥") over a pad.
type Pop = { id: number; x: number; y: number; text: string; tone: string };

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickBonus(): (typeof BONUSES)[number] {
  const total = BONUSES.reduce((s, b) => s + b.weight, 0);
  let r = Math.random() * total;
  for (const b of BONUSES) {
    r -= b.weight;
    if (r <= 0) return b;
  }
  return BONUSES[0];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.min(Math.max(t, 0), 1);
}

// World-space (x, y) of an entity right now.
function entityXY(e: Entity): { x: number; y: number } {
  return e.axis === "y" ? { x: e.lane, y: e.pos } : { x: e.pos, y: e.lane };
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Cross — toto-victoto" },
    {
      name: "description",
      content: "Hop between five d-pad pads to dodge emoji projectiles and catch bonuses.",
    },
  ];
}

export default function Cross() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [avatar, setAvatar] = useState(AVATARS[0]);
  const [pad, setPad] = useState<PadId>("center");
  const [entities, setEntities] = useState<Entity[]>([]);
  const [pops, setPops] = useState<Pop[]>([]);
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(MAX_LIVES);
  const [shield, setShield] = useState(false);
  const [slowLeft, setSlowLeft] = useState(0);
  const [invuln, setInvuln] = useState(false);
  const [shake, setShake] = useState(false);
  const [{ best }, setBestState] = useStoredGame("cross", { best: 0 });

  // Per-frame simulation state lives in refs; React state above is only what
  // gets rendered. The loop is created once (empty deps) and reads controls
  // through refs.
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  const padRef = useRef<PadId>(pad);
  padRef.current = pad;
  const entitiesRef = useRef<Entity[]>([]);
  const idRef = useRef(0);
  const elapsedRef = useRef(0); // s of play time (unscaled)
  const spawnInRef = useRef(0); // s until next spawn (scaled by slow-mo)
  const livesRef = useRef(MAX_LIVES);
  const shieldRef = useRef(false);
  const slowRef = useRef(0);
  const invulnRef = useRef(0);
  const dodgedRef = useRef(0);
  const bonusScoreRef = useRef(0);
  const lastTimeRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  // Active swipe: the pointer id we captured and where it first landed.
  const dragRef = useRef<{ id: number; x: number; y: number } | null>(null);
  // Direction keys currently held, most recent last — so rolling from one key
  // to another follows the newest, and releasing falls back to the one still
  // down rather than snapping home.
  const heldRef = useRef<PadId[]>([]);

  // Pick the avatar on the client only so the prerendered HTML is stable.
  useEffect(() => {
    setAvatar(pick(AVATARS));
  }, []);

  const addPop = (x: number, y: number, text: string, tone: string) => {
    const id = idRef.current++;
    setPops((p) => [...p, { id, x, y, text, tone }]);
    setTimeout(() => setPops((p) => p.filter((q) => q.id !== id)), 700);
  };

  const start = () => {
    entitiesRef.current = [];
    elapsedRef.current = 0;
    spawnInRef.current = 1.2;
    livesRef.current = MAX_LIVES;
    shieldRef.current = false;
    slowRef.current = 0;
    invulnRef.current = 0;
    dodgedRef.current = 0;
    bonusScoreRef.current = 0;
    lastTimeRef.current = null;
    dragRef.current = null;
    heldRef.current = [];
    setEntities([]);
    setPops([]);
    setScore(0);
    setLives(MAX_LIVES);
    setShield(false);
    setSlowLeft(0);
    setInvuln(false);
    setPad("center");
    setAvatar(pick(AVATARS));
    setPhase("playing");
    sfx.ui();
  };

  // Move to a pad. Every input is "hold to stay out, release to come home", so
  // this is just a setter with a click.
  const go = (target: PadId) => {
    if (phaseRef.current !== "playing") return;
    if (target === padRef.current) return;
    padRef.current = target;
    setPad(target);
    tone(target === "center" ? 300 : 380, 0.04, { type: "square", gain: 0.04 });
  };

  // Which arm a push of (dx, dy) — in % of the field, measured from wherever
  // the finger landed — selects. Inside the dead zone you're back in neutral,
  // so you can slide through the middle from one arm to the opposite one.
  const padFromPush = (dx: number, dy: number): PadId => {
    if (Math.hypot(dx, dy) < SWIPE_DEADZONE) return "center";
    return Math.abs(dx) > Math.abs(dy)
      ? dx > 0
        ? "right"
        : "left"
      : dy > 0
        ? "down"
        : "up";
  };

  // Keyboard mirrors the swipe: hold a direction to sit on that arm, let go to
  // come back to the centre.
  useEffect(() => {
    const map: Record<string, PadId> = {
      arrowup: "up",
      w: "up",
      z: "up",
      arrowdown: "down",
      s: "down",
      arrowleft: "left",
      a: "left",
      q: "left",
      arrowright: "right",
      d: "right",
    };
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === " " || k === "enter") {
        e.preventDefault();
        if (phaseRef.current !== "playing") start();
        return;
      }
      const target = map[k];
      if (!target) return;
      e.preventDefault();
      if (e.repeat) return;
      if (phaseRef.current === "idle") start();
      heldRef.current = [...heldRef.current.filter((p) => p !== target), target];
      go(target);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const target = map[e.key.toLowerCase()];
      if (!target) return;
      const held = heldRef.current.filter((p) => p !== target);
      heldRef.current = held;
      go(held.length ? held[held.length - 1] : "center");
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swipe anywhere on the field. The press point becomes neutral, so the stick
  // is wherever your thumb already is rather than a fixed spot on screen; you
  // can then rake the finger around to shift between arms without lifting, and
  // letting go always drops you back to the centre.
  const onFieldDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (phaseRef.current !== "playing") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    go("center");
  };

  const onFieldMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
    const el = fieldRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    go(
      padFromPush(
        ((e.clientX - drag.x) / r.width) * 100,
        ((e.clientY - drag.y) / r.height) * 100,
      ),
    );
  };

  const onFieldUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id !== e.pointerId) return;
    dragRef.current = null;
    go("center");
  };

  const spawn = (t: number) => {
    const ramp = t / RAMP_SECONDS;
    const speed = lerp(SPEED_START, SPEED_MAX, ramp) * (0.85 + Math.random() * 0.3);
    const warn = lerp(WARN_START, WARN_MIN, ramp);
    const axis: "x" | "y" = Math.random() < 0.5 ? "x" : "y";
    const lane = pick(LANES);
    const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
    const isBonus = Math.random() < BONUS_CHANCE;
    const bonus = isBonus ? pickBonus() : null;
    entitiesRef.current.push({
      id: idRef.current++,
      kind: isBonus ? "bonus" : "proj",
      bonus: bonus?.kind,
      emoji: bonus ? bonus.emoji : pick(PROJECTILES),
      axis,
      lane,
      dir,
      pos: dir === 1 ? -8 : 108,
      speed: isBonus ? speed * 0.8 : speed,
      warnLeft: isBonus ? warn * 0.6 : warn,
      spin: isBonus ? 0 : (Math.random() < 0.5 ? -1 : 1) * (240 + Math.random() * 360),
      rot: 0,
      passed: false,
    });
  };

  useEffect(() => {
    const step = (now: number) => {
      if (lastTimeRef.current !== null && phaseRef.current === "playing") {
        const dt = Math.min((now - lastTimeRef.current) / 1000, MAX_DT);
        elapsedRef.current += dt;
        const t = elapsedRef.current;

        // Slow-mo scales everything that moves, but not the player's timers.
        if (slowRef.current > 0) {
          slowRef.current = Math.max(0, slowRef.current - dt);
          setSlowLeft(slowRef.current);
        }
        const scale = slowRef.current > 0 ? SLOW_SCALE : 1;
        const sdt = dt * scale;

        if (invulnRef.current > 0) {
          invulnRef.current = Math.max(0, invulnRef.current - dt);
          if (invulnRef.current === 0) setInvuln(false);
        }

        // Spawning: a countdown that resets to the current (ramped) gap.
        spawnInRef.current -= sdt;
        if (spawnInRef.current <= 0) {
          const ramp = t / RAMP_SECONDS;
          spawn(t);
          if (Math.random() < lerp(0, DOUBLE_CHANCE_MAX, ramp)) spawn(t);
          spawnInRef.current =
            lerp(SPAWN_GAP_START, SPAWN_GAP_MIN, ramp) * (0.8 + Math.random() * 0.4);
        }

        const me = PADS[padRef.current];
        const list = entitiesRef.current;
        for (let i = list.length - 1; i >= 0; i--) {
          const e = list[i];
          if (e.warnLeft > 0) {
            e.warnLeft = Math.max(0, e.warnLeft - sdt);
            if (e.warnLeft === 0)
              tone(e.kind === "bonus" ? 720 : 240, 0.05, {
                type: e.kind === "bonus" ? "sine" : "sawtooth",
                gain: 0.05,
              });
            continue;
          }
          e.pos += e.dir * e.speed * sdt;
          e.rot += e.spin * sdt;

          const p = entityXY(e);
          const d = dist(p, me);
          if (e.kind === "bonus") {
            if (d < CATCH_R) {
              list.splice(i, 1);
              bonusScoreRef.current += e.bonus === "star" ? SCORE_STAR : 0;
              if (e.bonus === "shield") {
                shieldRef.current = true;
                setShield(true);
              } else if (e.bonus === "life") {
                livesRef.current = Math.min(MAX_LIVES, livesRef.current + 1);
                setLives(livesRef.current);
              } else if (e.bonus === "slow") {
                slowRef.current = SLOW_S;
                setSlowLeft(SLOW_S);
              }
              addPop(me.x, me.y, e.bonus === "star" ? `+${SCORE_STAR}` : e.emoji, "text-amber-300");
              sfx.rise(e.bonus === "star" ? 4 : 0);
              continue;
            }
          } else if (d < HIT_R && invulnRef.current === 0) {
            list.splice(i, 1);
            if (shieldRef.current) {
              shieldRef.current = false;
              setShield(false);
              addPop(me.x, me.y, "🛡️", "text-sky-300");
              tone(520, 0.1, { type: "triangle", gain: 0.1 });
            } else {
              livesRef.current -= 1;
              setLives(livesRef.current);
              addPop(me.x, me.y, "💥", "text-rose-400");
              setShake(true);
              if (livesRef.current <= 0) {
                setPhase("gameover");
                sfx.lose();
              } else {
                tone(180, 0.16, { type: "sawtooth", gain: 0.12 });
              }
            }
            invulnRef.current = INVULN_S;
            setInvuln(true);
            continue;
          }

          // Count a dodge once the projectile has cleared the last pad on its
          // lane, then drop it once it's fully off-screen.
          if (!e.passed && e.kind === "proj") {
            const far = e.dir === 1 ? LANE_MAX + HIT_R : LANE_MIN - HIT_R;
            if ((e.dir === 1 && e.pos > far) || (e.dir === -1 && e.pos < far)) {
              e.passed = true;
              dodgedRef.current += 1;
            }
          }
          if (e.pos < -12 || e.pos > 112) list.splice(i, 1);
        }

        setEntities(list.map((e) => ({ ...e })));
        setScore(
          Math.floor(t * SCORE_PER_SEC) +
            dodgedRef.current * SCORE_PER_DODGE +
            bonusScoreRef.current,
        );
      }
      lastTimeRef.current = now;
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      lastTimeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase === "gameover") setBestState((s) => ({ best: Math.max(s.best, score) }));
  }, [phase, score, setBestState]);

  const me = PADS[pad];
  const slowActive = slowLeft > 0;

  return (
    <>
      <BackButton />
      <GameLayout>
        <header className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight">
            <Trans id="cross.title" message="Cross" />
          </h1>
        </header>

        <section className="flex items-center justify-between px-1 text-sm text-neutral-400">
          <div className="flex items-center gap-1 text-base leading-none" aria-label="Lives">
            {Array.from({ length: MAX_LIVES }, (_, i) => (
              <span key={i} className={i < lives ? "" : "opacity-20 grayscale"} aria-hidden="true">
                ❤️
              </span>
            ))}
            <span
              className={`ml-2 transition-opacity ${shield ? "opacity-100" : "opacity-20 grayscale"}`}
              aria-hidden="true"
            >
              🛡️
            </span>
            <span
              className={`transition-opacity ${slowActive ? "opacity-100" : "opacity-20 grayscale"}`}
              aria-hidden="true"
            >
              ⏳
            </span>
          </div>
          <div className="flex items-baseline gap-3 tabular-nums">
            <span className="text-2xl font-bold text-neutral-100 min-w-[4ch] text-right">
              {score}
            </span>
            <span>
              <Trans id="common.best" message="Best" />{" "}
              <span className="font-bold text-neutral-200">{best}</span>
            </span>
          </div>
        </section>

        {/* The field is the largest square that fits the leftover area: width
            is capped by both the column width and the section height (cqh). */}
        <section
          className="flex min-h-0 flex-1 items-center justify-center"
          style={{ containerType: "size" } as CSSProperties}
        >
          <div
            ref={fieldRef}
            onPointerDown={onFieldDown}
            onPointerMove={onFieldMove}
            onPointerUp={onFieldUp}
            onPointerCancel={onFieldUp}
            onAnimationEnd={(e) => {
              if (e.animationName === "cross-shake") setShake(false);
            }}
            style={{ containerType: "inline-size" } as CSSProperties}
            className={`relative aspect-square w-[min(100%,100cqh)] overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900 select-none touch-none ${
              shake ? "animate-cross-shake" : ""
            } ${slowActive ? "ring-2 ring-sky-400/60" : ""}`}
          >
            {/* Lane guides: faint lines through the three rows/columns. */}
            {LANES.map((l) => (
              <div key={`v${l}`} aria-hidden="true">
                <div
                  className="absolute inset-y-0 w-px bg-neutral-800/80"
                  style={{ left: `${l}%` }}
                />
                <div
                  className="absolute inset-x-0 h-px bg-neutral-800/80"
                  style={{ top: `${l}%` }}
                />
              </div>
            ))}

            {/* The five pads. */}
            {(Object.keys(PADS) as PadId[]).map((id) => {
              const p = PADS[id];
              const active = id === pad;
              return (
                <div
                  key={id}
                  aria-hidden="true"
                  className={`absolute rounded-[22%] transition-colors duration-150 ${
                    active
                      ? "bg-neutral-700/80 shadow-[0_0_0_2px_rgba(255,255,255,0.15)]"
                      : "bg-neutral-800/70"
                  }`}
                  style={{
                    left: `${p.x}%`,
                    top: `${p.y}%`,
                    width: `${PAD_SIZE}%`,
                    height: `${PAD_SIZE}%`,
                    transform: "translate(-50%, -50%)",
                  }}
                />
              );
            })}

            {/* Telegraphs: a pulsing marker at the edge a projectile will enter from. */}
            {entities
              .filter((e) => e.warnLeft > 0)
              .map((e) => {
                const edge = e.dir === 1 ? 3 : 97;
                const pos = e.axis === "y" ? { x: e.lane, y: edge } : { x: edge, y: e.lane };
                return (
                  <div
                    key={`w${e.id}`}
                    aria-hidden="true"
                    className={`absolute rounded-full animate-cross-warn ${
                      e.kind === "bonus" ? "bg-amber-300" : "bg-rose-500"
                    }`}
                    style={{
                      left: `${pos.x}%`,
                      top: `${pos.y}%`,
                      width: e.axis === "y" ? "12cqw" : "2.4cqw",
                      height: e.axis === "y" ? "2.4cqw" : "12cqw",
                      transform: "translate(-50%, -50%)",
                    }}
                  />
                );
              })}

            {/* Flying projectiles and bonuses. */}
            {entities
              .filter((e) => e.warnLeft === 0)
              .map((e) => {
                const p = entityXY(e);
                return (
                  <div
                    key={e.id}
                    aria-hidden="true"
                    className={`absolute leading-none ${
                      e.kind === "bonus" ? "animate-cross-bonus" : ""
                    }`}
                    style={{
                      left: `${p.x}%`,
                      top: `${p.y}%`,
                      fontSize: `${e.kind === "bonus" ? BONUS_EM : PROJ_EM}cqw`,
                      transform: `translate(-50%, -50%) rotate(${e.rot}deg)`,
                    }}
                  >
                    {e.emoji}
                  </div>
                );
              })}

            {/* Avatar: snaps between pads with a short ease. */}
            <div
              aria-hidden="true"
              className={`absolute leading-none transition-[left,top] duration-100 ease-out ${
                invuln ? "animate-cross-blink" : ""
              }`}
              style={{
                left: `${me.x}%`,
                top: `${me.y}%`,
                fontSize: `${AVATAR_EM}cqw`,
                transform: "translate(-50%, -50%)",
                filter: shield ? "drop-shadow(0 0 6px rgba(56,189,248,0.9))" : undefined,
              }}
            >
              {avatar}
            </div>

            {pops.map((p) => (
              <div
                key={p.id}
                aria-hidden="true"
                className={`absolute animate-cross-pop font-bold ${p.tone}`}
                style={{
                  left: `${p.x}%`,
                  top: `${p.y - 10}%`,
                  fontSize: `${POP_EM}cqw`,
                  transform: "translate(-50%, -50%)",
                }}
              >
                {p.text}
              </div>
            ))}

            {phase !== "playing" && (
              <div
                onPointerDown={(e) => e.stopPropagation()}
                className="absolute inset-0 flex items-center justify-center bg-neutral-950/60 backdrop-blur-[1px]"
              >
                <div className="text-center space-y-3 px-6">
                  {phase === "idle" ? (
                    <>
                      <p className="text-5xl" aria-hidden="true">
                        {avatar}
                      </p>
                      <p className="text-base font-medium text-white">
                        <Trans
                          id="cross.start"
                          message="Hop between the five pads to dodge everything — and catch the goodies."
                        />
                      </p>
                      <p className="text-xs text-neutral-300 leading-relaxed">
                        <Trans id="cross.legend.controls" message="Swipe to move — let go to snap back to centre. Or hold arrows / WASD / ZQSD." />
                        <br />
                        ⭐ <Trans id="cross.legend.star" message="points" /> · 🛡️{" "}
                        <Trans id="cross.legend.shield" message="blocks one hit" /> · ⏳{" "}
                        <Trans id="cross.legend.slow" message="slows time" /> · ❤️{" "}
                        <Trans id="cross.legend.life" message="extra life" />
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-3xl font-bold text-white">
                        <Trans id="cross.gameover" message="Squashed!" />
                      </p>
                      <p className="text-sm text-white/90">
                        <span className="text-2xl font-bold tabular-nums">{score}</span>
                        <br />
                        <Trans id="common.best" message="Best" />{" "}
                        <span className="font-bold tabular-nums">{best}</span>
                      </p>
                    </>
                  )}
                  <button
                    onClick={start}
                    className="rounded-full bg-white/90 px-8 py-3 text-lg font-semibold text-neutral-900 hover:bg-white"
                  >
                    {phase === "idle" ? (
                      <Trans id="cross.play" message="Play" />
                    ) : (
                      <Trans id="common.play_again" message="Play again" />
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      </GameLayout>
    </>
  );
}
