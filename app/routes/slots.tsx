import { useEffect, useRef, useState } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/slots";
import { BackButton } from "../components/BackButton";
import { GameLayout } from "../components/GameLayout";
import { useStoredGame } from "../storage";
import { sfx, tone, startSlotSpin, stopSlotSpin } from "../sound";

// Faithful to the SMB3 "Spade Panel": each prize (🍄 / 🌸 / ⭐) is sliced into
// three horizontal bands. Reel 0 carries the top bands, reel 1 the middle, reel
// 2 the bottom. Stop all three so one column shows the SAME prize top-to-bottom
// and its bands reassemble into a whole picture — that wins the lives.
//
// A reel is ONE number — its `offset`, how many cells its strip has rolled.
// Everything drawn is DERIVED from that offset by arithmetic; the modulo wraps
// the short strip into an endless ribbon.
//
// The timings and the strip below are lifted from the original 6502 code
// (`Roulette_*` in bank 22 of the Southbird SMB3 disassembly) and converted
// from NES frames/subpixels into seconds/cells — see NES_* further down.
const REELS = 3;

// The real reel is FOUR cells, not three: the mushroom appears twice, which is
// why mushrooms come up half the time. Rendered left to right the window reads
// ⭐(right half) 🍄 🌸 🍄 ⭐(left half) — one wrap of this strip.
const STRIP = ["🍄", "🌸", "🍄", "⭐"] as const;
const CELLS = STRIP.length;

// Lives paid per cell, in strip order — 🍄 2, 🌸 3, 🍄 2, ⭐ 5.
const PAYOUTS = [2, 3, 2, 5];

// Both mushroom cells are the same prize, so the original accepts either one on
// reels 2 and 3 when reel 1 stopped on a mushroom. Folding cell 2 onto cell 0
// reproduces that leniency exactly.
const prizeOf = (cell: number): number => (cell === 2 ? 0 : cell);

// You buy in with five lives and every pull costs one, so the panel is a wager
// rather than a free toy. (The cabinet gave you exactly one free pull —
// `Roulette_Turns` is hard-wired to 0 — so the economy is ours.) Stopped at
// random the reels agree about 1 spin in 6, worth ≈ 0.38 lives per 1 staked:
// still a losing game until you learn to read the bands.
const LIVES_START = 5;
const PULL_COST = 1;

// Geometry. Everything is in `cqw` — percent of the cabinet's own width — so
// the machine scales with the screen instead of being pinned to a pixel size.
//
// A prize is 12 tiles wide on the NES's 32-tile screen, so barely 2⅔ of them
// are ever in view at once. We go a little wider still — a phone is narrower
// than a TV and the prize should be the biggest thing on the page. One band is
// BAND tall, a whole prize spans all three, and the prize is square: GLYPH
// stays just under a cell so it never clips sideways and a matched column
// reassembles seamlessly.
const PAD = 3; // cabinet padding
const WINDOW_W = 100 - 2 * PAD; // reels window, as a share of the cabinet
const CELL = 44; // % of the window taken by one cell
const ICON = (WINDOW_W * CELL) / 100;
const BAND = ICON / REELS;
const GLYPH = ICON * 0.92;
const HALF_WINDOW = 2; // cells drawn on each side of center
// Bands butted edge to edge draw a hairline between them, and it is NOT a gap.
// A boundary lands mid-device-pixel, so both bands clip there at partial
// coverage and that row gets painted twice, each time at about half alpha.
// Compositing gives C(f + g − f·g) — three quarters of the colour at f = g = ½,
// measurably (0.76×) darker than its neighbours. Rounding sharpens it at the
// 2nd/3rd boundary, where `2 × BAND` and `BAND + BAND` disagree by 1/64px.
//
// The cure is to overlap the bands by a little over one device pixel, so the
// band above covers that row completely and the one below redraws the very
// same pixels on top of it. It works only because the glyphs line up exactly —
// see the band contents below. The cost is about 0.6px of the reel above
// showing past the boundary, which is under a pixel and reads as antialiasing.
//
// Do NOT give the bands an opaque background to hide that overhang: the band
// below then wipes the one above at its own partial coverage and paints back
// the exact hairline this removes. Measured, not guessed. The last band's
// overhang is clipped by the window.
const SEAM = 0.3;

// ── The original's numbers ────────────────────────────────────────────────
// `Roulette_Pos` counts 128 units per cell; `Roulette_Speed` is a signed 8.4
// fixed-point value, so raw/16 units advance per 60 Hz frame. This converts a
// raw speed straight into our unit, cells per second.
const FPS = 60;
const FRAME = 1 / FPS;
const cps = (raw: number): number => (raw * FPS) / (16 * 128);

// `Roulette_Init`: $70, $90, $7F. $90 is negative as a signed byte, which is
// the whole reason the middle reel scrolls the other way — and reel 3 is set a
// hair faster than the outer two.
const SPEEDS = [cps(0x70), cps(-0x70), cps(0x7f)]; // ≈ +3.28, −3.28, +3.72

// `RouletteRow_Slow` bleeds 2 raw off the speed every frame, and hands over as
// soon as the magnitude drops under $40 — about 0.42 s and 1.1 cells of coast.
const DECEL = cps(2) * FPS; // ≈ 3.52 cells/s²
const CRAWL = cps(0x40); // ≈ 1.875 cells/s

// `Roulette_Run` arms a countdown on the press and the reel keeps running at
// FULL speed until it expires — so no tap ever stops a reel where you saw it.
// Each window is double the one before, and since the reel runs flat out for
// the whole countdown, that doubling is positional uncertainty: reel 1 can only
// land 0.82 cells either side of where your timing put it, reel 2 1.70 — but
// reel 3 gets 3.91, on a strip four cells long. Your press decides the first
// two reels and has essentially no bearing on the third.
const STOP_DELAY: [number, number][] = [
  [0x20 * FRAME, 0x2f * FRAME], // reel 1: 32–47 frames, 0.53–0.78 s
  [0x20 * FRAME, 0x3f * FRAME], // reel 2: 32–63 frames, 0.53–1.05 s
  [0x40 * FRAME, 0x7f * FRAME], // reel 3: 64–127 frames, 1.07–2.12 s
];

// `RouletteRow_HitLockPos` then `RouletteRow_LockDecide`: the reel snaps to the
// next cell edge, jitters at ±$10 flipping every 4 frames for $12 frames, and
// only then is the payline read.
const BOUNCE_SPEED = cps(0x10); // ≈ 0.47 cells/s
const BOUNCE_FLIP = 4 * FRAME;
const BOUNCE_TIME = 0x12 * FRAME; // 0.3 s

const MAX_DT = 0.05; // clamp so a backgrounded tab can't teleport the reels

// Reels start phase-shifted so an idle panel doesn't read as a fake win.
// Deterministic, so the prerendered HTML and the first client render agree.
const START_OFFSETS = [0, 1, 2];

type Phase = "idle" | "spinning" | "result";
// The original's `Roulette_StopState`, one per reel. A reel can only be armed
// once the one before it has come to rest, so the three stop strictly in turn
// and mashing the button cannot take two at once.
const REEL_STATES = [
  "rolling", // free-running at full speed
  "armed", // press registered, still at full speed, countdown ticking
  "slowing", // bleeding off speed
  "seeking", // crawling to the next cell edge
  "bouncing", // snapped, wobbling in place
  "locked",
] as const;
type ReelState = (typeof REEL_STATES)[number];

type Result = { symbol: string; prize: number };
// A won prize, tagged with a serial so a second win restarts the "×UP" rise
// instead of leaving the finished animation frozen on screen.
type Reward = { prize: number; id: number };

// `Roulette_GiveReward` slides the "×UP" sprite up 4px a frame from y=240 until
// it passes y=96 — the full height of a 240px screen in 36 frames — then holds
// it there while the lives are handed over one at a time.
const XUP_RISE = (240 - 96) / 4 / 60; // 0.6 s
const XUP_HOLD = 2.4; // then it lingers while the 1-ups land
// …and the lives arrive one at a time, not in a lump: `Roulette_GiveReward`
// grants the next only once the 1-up sound has finished. Ours runs 0.44s, so
// half a second a life keeps them from treading on each other, and even the
// 5-life jackpot finishes (0.6 + 4 × 0.5 = 2.6s) before the banner fades.
const LIFE_TICK = 0.5;

// Fold an offset back into [0, CELLS). Invisible on screen — the strip is
// periodic — but it keeps the number tiny forever (perfect float precision).
const wrap = (offset: number): number => ((offset % CELLS) + CELLS) % CELLS;

// The cell parked on the payline for a given offset — pure arithmetic.
export function centered(offset: number): number {
  return ((Math.round(offset) % CELLS) + CELLS) % CELLS;
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "1-UP Slots — toto-victoto" },
    { name: "description", content: "An SMB3-style prize slot machine." },
  ];
}

export default function Slots() {
  // One offset per reel. The screen must redraw as they roll → useState.
  const [offsets, setOffsets] = useState<number[]>(START_OFFSETS);
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [reward, setReward] = useState<Reward | null>(null);
  const [lives, setLives] = useState(LIVES_START);
  const [{ best }, setBest] = useStoredGame("slots", { best: 0 });

  // The rAF loop runs once (empty deps) and reads live values from refs, not
  // captured state (the Flappy pattern). All the reel motion is computed in the
  // callback and handed to setOffsets as a finished array, so the updater stays
  // pure.
  const offsetsRef = useRef<number[]>(START_OFFSETS);
  // score() is captured by the rAF loop's first render, so it reads the live
  // count through a ref rather than a stale closure.
  const livesRef = useRef(lives);
  livesRef.current = lives;
  const phaseRef = useRef<Phase>("idle");
  const stateRef = useRef<ReelState[]>(["locked", "locked", "locked"]);
  const speedRef = useRef<number[]>([0, 0, 0]); // cells/s, signed
  const timerRef = useRef<number[]>([0, 0, 0]); // seconds left in this state
  const lockRef = useRef<number[]>([0, 0, 0]); // cell edge to settle back onto
  const rewardIdRef = useRef(0);
  const owedRef = useRef(0); // lives won but not yet counted in
  const lastTimeRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  // Pull the lever: pay a life, then every reel rolls again from where it
  // rests. The stake is taken up front, so the counter can sit at 0 through a
  // spin — that last pull can still pay you back out.
  const pull = () => {
    // Lives still being counted in are already yours — clearing the reward
    // below pays out whatever is left, so spend against the full balance.
    if (lives + owedRef.current < PULL_COST) return;
    setLives((l) => l - PULL_COST);
    setResult(null);
    setReward(null);
    stateRef.current = ["rolling", "rolling", "rolling"];
    speedRef.current = [...SPEEDS];
    phaseRef.current = "spinning";
    setPhase("spinning");
    sfx.spin();
    startSlotSpin();
  };

  // Buy back in after busting out.
  const restart = () => {
    setLives(LIVES_START);
    setResult(null);
    setReward(null);
    phaseRef.current = "idle";
    setPhase("idle");
    sfx.ui();
  };

  // Press the button: arm the next reel that is still free-running. The press
  // does NOT place the reel — it only starts that reel's countdown, after which
  // the reel coasts, decelerates and settles wherever it happens to land.
  //
  // One reel at a time: until the reel before this one has come to rest the
  // press is swallowed, so you always take them in order and never lose two to
  // a double tap. (`Roulette_Run` opens its gate a touch earlier, the moment
  // the previous reel starts braking — but waiting for the full stop is what
  // the machine reads as, and it makes each press unambiguous.)
  const stop = () => {
    if (phaseRef.current !== "spinning") return;
    const i = stateRef.current.indexOf("rolling");
    if (i < 0) return;
    if (i > 0 && stateRef.current[i - 1] !== "locked") return;
    const [lo, hi] = STOP_DELAY[i];
    stateRef.current[i] = "armed";
    timerRef.current[i] = lo + Math.random() * (hi - lo);
    sfx.place();
  };

  // Score the payline once all three reels rest.
  const score = () => {
    phaseRef.current = "result";
    stopSlotSpin();
    const cells = offsetsRef.current.map(centered);
    const [a, b, c] = cells.map(prizeOf);
    const win = a === b && b === c;
    const prize = win ? PAYOUTS[cells[0]] : 0;
    setResult({ symbol: STRIP[cells[0]], prize });
    if (prize > 0) {
      // No fanfare here: the cabinet plays nothing on the match itself, it just
      // raises the banner and then counts the lives in, one 1-up at a time.
      setReward({ prize, id: ++rewardIdRef.current });
    } else if (livesRef.current < PULL_COST) {
      // That miss spent the last life — sting rather than the usual shrug.
      sfx.lose();
    } else {
      tone(330, 0.12, { type: "triangle" });
      tone(247, 0.16, { type: "triangle", delay: 0.1 });
    }
    setPhase("result");
  };

  // Out of credit. Only ever true between spins: the stake for a spin in
  // flight is already paid, and that spin can still pay out — nor are you
  // broke while a win is still being counted in.
  const broke = lives < PULL_COST && phase !== "spinning" && !reward;

  const primary = phase === "spinning" ? stop : broke ? restart : pull;

  // One reel, one frame. Walks the same six states the original's
  // `RouletteRow_DoStopState` jump table walks, and returns the new offset.
  const advance = (i: number, o: number, dt: number): number => {
    const state = stateRef.current[i];
    const v = speedRef.current[i];

    switch (state) {
      // Free-running, and running for as long as the countdown lasts. The
      // press that armed the reel bought no precision at all.
      case "armed":
        timerRef.current[i] -= dt;
        if (timerRef.current[i] <= 0) stateRef.current[i] = "slowing";
      // fallthrough — an armed reel still moves at full speed this frame
      case "rolling":
        return wrap(o + v * dt);

      // Bleed speed off until the reel is down to a crawl.
      case "slowing": {
        const slowed = v - Math.sign(v) * DECEL * dt;
        speedRef.current[i] = slowed;
        if (Math.abs(slowed) < CRAWL) stateRef.current[i] = "seeking";
        return wrap(o + slowed * dt);
      }

      // Crawl on until the next cell edge comes under the payline, then take
      // it — whichever one that turns out to be.
      case "seeking": {
        const edge = v > 0 ? Math.floor(o) + 1 : Math.ceil(o) - 1;
        const moved = o + v * dt;
        if (v > 0 ? moved < edge : moved > edge) return moved;
        stateRef.current[i] = "bouncing";
        timerRef.current[i] = BOUNCE_TIME;
        lockRef.current[i] = wrap(edge);
        // A different sound from the press, so the ear can tell "I asked" from
        // "it landed" — the two moments the original also scores separately.
        tone(196, 0.1, { type: "square", gain: 0.1 });
        return lockRef.current[i];
      }

      // Settled, but still shivering: ±0.03 of a cell, flipping every four
      // frames. Left deliberately unwrapped so the wobble stays around the
      // lock position instead of jumping the seam.
      case "bouncing": {
        timerRef.current[i] -= dt;
        if (timerRef.current[i] <= 0) {
          stateRef.current[i] = "locked";
          return lockRef.current[i];
        }
        const elapsed = BOUNCE_TIME - timerRef.current[i];
        const dir = Math.floor(elapsed / BOUNCE_FLIP) % 2 ? -1 : 1;
        return o + dir * BOUNCE_SPEED * dt;
      }

      default:
        return o;
    }
  };

  // The reel loop: step every reel, and score once the last one locks.
  useEffect(() => {
    const stepFrame = (t: number) => {
      if (lastTimeRef.current !== null) {
        const dt = Math.min((t - lastTimeRef.current) / 1000, MAX_DT);
        const next = offsetsRef.current.map((o, i) => advance(i, o, dt));
        offsetsRef.current = next;
        setOffsets(next);

        if (
          phaseRef.current === "spinning" &&
          stateRef.current.every((s) => s === "locked")
        ) {
          score();
        }
      }
      lastTimeRef.current = t;
      rafRef.current = requestAnimationFrame(stepFrame);
    };
    rafRef.current = requestAnimationFrame(stepFrame);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      lastTimeRef.current = null;
    };
  }, []);

  // Keyboard: Space / Enter pulls, then stops each reel in turn.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " && e.key !== "Enter") return;
      e.preventDefault();
      primary();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Once the reels are rolling the WHOLE page is the stop button — no aiming at
  // the panel mid-spin. Real controls (the lever, Home, the language picker)
  // still speak for themselves, so taps that land on one are left alone. Only
  // stopping is this generous: pulling stays on the button so a stray tap on
  // the result screen can't quietly spend a life.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (phaseRef.current !== "spinning") return;
      if ((e.target as Element | null)?.closest("button, a")) return;
      stop();
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  });

  // Let the "×UP" banner clear itself, so a win left on screen doesn't sit
  // there forever waiting for the next pull.
  useEffect(() => {
    if (!reward) return;
    const id = window.setTimeout(
      () => setReward(null),
      (XUP_RISE + XUP_HOLD) * 1000,
    );
    return () => window.clearTimeout(id);
  }, [reward]);

  // Count the prize in, a life and a 1-up at a time, starting once the banner
  // has finished climbing. `owedRef` holds what is won but not yet paid, so the
  // lever still knows you can afford a pull in the middle of the payout.
  useEffect(() => {
    if (!reward) return;
    owedRef.current = reward.prize;
    let timer = 0;
    const tick = () => {
      owedRef.current -= 1;
      setLives((l) => l + 1);
      sfx.oneUp();
      if (owedRef.current > 0) timer = window.setTimeout(tick, LIFE_TICK * 1000);
    };
    timer = window.setTimeout(tick, XUP_RISE * 1000);
    return () => {
      window.clearTimeout(timer);
      // Cut short by a fresh pull or by leaving: hand over the rest at once
      // rather than pocketing what the player already won.
      if (owedRef.current > 0) setLives((l) => l + owedRef.current);
      owedRef.current = 0;
    };
  }, [reward]);

  // Best is the most lives ever banked in one session.
  useEffect(() => {
    if (lives > 0) setBest((s) => ({ best: Math.max(s.best, lives) }));
  }, [lives, setBest]);

  // Silence the spin loop if the player leaves mid-spin.
  useEffect(() => stopSlotSpin, []);

  return (
    <>
      <BackButton />

      <GameLayout>
        <header className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight">
            <Trans id="slots.title" message="1-UP Slots" />
          </h1>
          <p className="mt-1 text-lg font-semibold text-amber-400 tabular-nums">
            🍄 {lives}
            {best > 0 && (
              <span className="ml-2 text-sm font-medium text-neutral-500">
                <Trans id="common.best" message="Best" /> {best}
              </span>
            )}
          </p>
        </header>

        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
          {/* The host's spiel, in the cream dialogue box SMB3 frames it with.
              The first line is word for word from the ROM
              (`BonusGame_Spade_Text`). The second replaces its "You only get
              one try." — true of the cabinet, which gave exactly one pull, but
              a lie here, where you buy in with five lives and spend one a go. */}
          {/* Fades out under the reward banner, which parks across this gap —
              nobody needs the rules read to them mid-win, and fading keeps the
              layout still where hiding it would make the machine jump. On a
              short screen (landscape phones) the box would push the lever off
              the bottom, and the machine matters more than the flavour. */}
          <div
            className={`w-full max-w-[72vh] rounded-lg border-4 border-neutral-100 bg-[#f8f0d8] px-4 py-3 text-center text-sm leading-snug font-semibold text-neutral-900 transition-opacity duration-300 [@media(max-height:600px)]:hidden sm:text-base ${
              reward ? "opacity-0" : "opacity-100"
            }`}
          >
            <p>
              <Trans
                id="slots.host.line1"
                message="Line up the pictures and get a prize!"
              />
            </p>
            <p>
              <Trans
                id="slots.host.line2"
                message="Each try costs you a life."
              />
            </p>
          </div>

          {/* The cabinet: a Spade Panel marquee over the three sliced reels.
              It is the `cqw` container everything inside sizes against, and it
              takes the full width unless the screen is too short for that. */}
          <div
            className="relative w-full max-w-[72vh]"
            style={{ containerType: "inline-size" }}
          >
            {/* The cabinet's payoff: a "2 UP" / "3 UP" / "5 UP" banner that
                sweeps up from under the machine and parks across its top edge —
                the move `Roulette_GiveReward` makes on the NES. Anchored to the
                cabinet, and sized in cqw, so it belongs to the machine and
                scales with it; it comes to rest clear of the payline, which is
                the one thing you actually want to look at when you win. Keyed
                by the win's serial so back-to-back wins each get a run. */}
            {reward && (
              <span
                key={reward.id}
                aria-hidden="true"
                className="animate-slots-1up pointer-events-none absolute left-1/2 z-40 -translate-x-1/2 -translate-y-1/2 text-[16cqw] leading-none font-black tracking-[0.12em] whitespace-nowrap text-amber-300 tabular-nums"
                style={{
                  WebkitTextStroke: "0.1em #1c1917",
                  paintOrder: "stroke fill",
                }}
              >
                {reward.prize} UP
              </span>
            )}

            <div
              className="relative rounded-3xl bg-gradient-to-b from-red-800 to-red-950 shadow-2xl ring-4 ring-amber-400/90"
              style={{ padding: `${PAD}cqw` }}
            >
              <div className="mb-[2cqw] flex items-center justify-center gap-[2cqw] text-amber-300">
                <span className="text-[5cqw] leading-none">♠</span>
                <span className="text-[3cqw] font-bold uppercase tracking-[0.25em]">
                  Spade Panel
                </span>
                <span className="text-[5cqw] leading-none">♠</span>
              </div>

              {/* Reels window. Mid-spin, anywhere on the page stops a reel. */}
              <div
                className="relative overflow-hidden rounded-xl bg-neutral-950 ring-2 ring-amber-900/70 select-none"
                style={{ height: `${ICON}cqw` }}
              >
                {[0, 1, 2].map((r) => {
                  const offset = offsets[r];
                  // Only the handful of cells near the payline are drawn. Cell k
                  // shows band r of STRIP[k mod CELLS] and sits at
                  // x = 50% + (k − offset) cells, so cells slide and wrap.
                  const base = Math.floor(offset);
                  const cells = [];
                  for (
                    let k = base - HALF_WINDOW;
                    k <= base + HALF_WINDOW + 1;
                    k++
                  ) {
                    const sym = STRIP[((k % CELLS) + CELLS) % CELLS];
                    const x = 50 + (k - offset) * CELL;
                    cells.push(
                      <div
                        key={k}
                        className="absolute top-0 overflow-hidden"
                        style={{
                          left: `${x}%`,
                          width: `${CELL}%`,
                          height: `${BAND + SEAM}cqw`,
                          transform: "translateX(-50%)",
                        }}
                      >
                        {/* A full icon, shifted up so this band shows. The
                            shift is `top`, not a transform: `top` resolves to
                            the same rounded length as the band's own `top`, so
                            the two cancel exactly and every band lands the
                            glyph on the identical pixel. A transform is
                            resolved at composite time instead, which left the
                            picture a hair out of step across a boundary. */}
                        <div
                          className="absolute left-0 flex w-full items-center justify-center"
                          style={{
                            top: `-${r * BAND}cqw`,
                            height: `${ICON}cqw`,
                            fontSize: `${GLYPH}cqw`,
                            lineHeight: 1,
                          }}
                        >
                          {sym}
                        </div>
                      </div>,
                    );
                  }
                  return (
                    <div
                      key={r}
                      className="absolute inset-x-0"
                      style={{
                        top: `${r * BAND}cqw`,
                        height: `${BAND + SEAM}cqw`,
                      }}
                    >
                      {cells}
                    </div>
                  );
                })}

                {/* Payline: the center column the bands must line up in. */}
                <div
                  className="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 rounded-md border-2 border-amber-400/90"
                  style={{ width: `${CELL}%` }}
                  aria-hidden="true"
                />
              </div>
            </div>
          </div>

          <div className="flex h-7 items-center justify-center">
            {broke ? (
              <p className="text-lg font-semibold text-rose-300">
                <Trans id="slots.broke" message="Out of lives" />
              </p>
            ) : (
              result &&
              (result.prize > 0 ? (
                <p className="text-lg font-semibold text-amber-400">
                  {result.symbol} 1-UP! +{result.prize}
                </p>
              ) : (
                <p className="text-lg font-semibold text-neutral-400">
                  <Trans id="slots.nomatch" message="No match" />
                </p>
              ))
            )}
          </div>

          <button
            onClick={primary}
            className="rounded-full bg-amber-500 px-10 py-4 text-xl font-semibold text-neutral-900 hover:bg-amber-400"
          >
            {phase === "spinning" ? (
              <Trans id="slots.stop" message="Stop" />
            ) : broke ? (
              <Trans id="common.play_again" message="Play again" />
            ) : phase === "result" ? (
              <Trans id="slots.again" message="Pull again" />
            ) : (
              <Trans id="slots.pull" message="Pull the lever" />
            )}
          </button>
        </div>
      </GameLayout>
    </>
  );
}
