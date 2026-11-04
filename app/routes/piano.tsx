import { useCallback, useEffect, useRef, useState } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/piano";
import { BackButton } from "../components/BackButton";
import { GameLayout } from "../components/GameLayout";
import { useStoredGame } from "../storage";
import { piano, sfx } from "../sound";

// Absolute Piano: a note sounds, you find it. One octave, so the question is
// only ever "which of the twelve is this?" — never "which octave was that?".
// That is the absolute-pitch question in its smallest form.
//
// The keys carry their names, deliberately. Hiding them would add a second
// test — do you know where F♯ lives on a keyboard — on top of the one this
// game is about. With the names shown, the only thing standing between you and
// the right key is your ear.
//
// The one rule that keeps it honest: during a question a key does NOT sound
// when you touch it. If it did you could hunt for the answer by comparing
// tones, which is relative pitch, which is the thing this game isn't.

// Semitones above C, and the name each one wears.
const NAMES = [
  "C",
  "C♯",
  "D",
  "D♯",
  "E",
  "F",
  "F♯",
  "G",
  "G♯",
  "A",
  "A♯",
  "B",
] as const;

// The octave the whole game lives in. C4 is middle C = MIDI 60.
const OCTAVE = 4;
const MIDI_C = 12 * (OCTAVE + 1);

// Which semitones are white, in keyboard order, and where the black ones sit.
// A black key straddles the seam between two whites, so its centre is a whole
// number of white-key widths from the left edge.
const WHITE = [0, 2, 4, 5, 7, 9, 11];
const BLACK: [semitone: number, seam: number][] = [
  [1, 1],
  [3, 2],
  [6, 4],
  [8, 5],
  [10, 6],
];

const BLACK_W = 0.62; // of a white key's width
const BLACK_H = 62; // % of the keyboard's height

// Equal temperament, anchored at A4 = 440Hz (MIDI 69).
const freqOf = (semitone: number): number =>
  440 * 2 ** ((MIDI_C + semitone - 69) / 12);

const REVEAL_HOLD = 1000; // ms a correct answer sits before the next note

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Absolute Piano — toto-victoto" },
    { name: "description", content: "Hear a note, find it on the keyboard." },
  ];
}

type Phase = "idle" | "asking" | "revealed";

export default function Piano() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [target, setTarget] = useState<number | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [streak, setStreak] = useState(0);
  const [hard, setHard] = useState(false); // all twelve, vs the white keys only
  const [{ best }, setBest] = useStoredGame("piano", { best: 0 });

  const pool = hard ? NAMES.map((_, i) => i) : WHITE;

  // Pick a note that isn't the one just asked — a repeat reads as a bug even
  // when it's honest chance.
  const ask = useCallback(
    (avoid: number | null) => {
      const choices = pool.length > 1 ? pool.filter((n) => n !== avoid) : pool;
      const next = choices[Math.floor(Math.random() * choices.length)];
      setTarget(next);
      setPicked(null);
      setPhase("asking");
      piano(freqOf(next));
    },
    // `pool` is rebuilt every render; its contents only change with `hard`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hard],
  );

  const answer = (semitone: number) => {
    if (phase !== "asking" || target === null) return;
    setPicked(semitone);
    setPhase("revealed");
    // Sound the right note, not the one that was touched: the point of the
    // reveal is to tie the pitch you just heard to the key it belongs to.
    piano(freqOf(target));
    if (semitone === target) {
      const run = streak + 1;
      setStreak(run);
      if (run > best) setBest({ best: run });
      sfx.score();
    } else {
      setStreak(0);
      sfx.lose();
    }
  };

  // A right answer rolls straight on; a wrong one waits, so there is a moment
  // to connect the sound to the key you missed.
  const right = phase === "revealed" && picked === target;
  const targetRef = useRef(target);
  targetRef.current = target;
  useEffect(() => {
    if (!right) return;
    const t = window.setTimeout(() => ask(targetRef.current), REVEAL_HOLD);
    return () => window.clearTimeout(t);
  }, [right, ask]);

  // Changing difficulty mid-question would leave an unanswerable note hanging.
  const setDifficulty = (next: boolean) => {
    if (next === hard) return;
    setHard(next);
    setPhase("idle");
    setTarget(null);
    setPicked(null);
    setStreak(0);
  };

  const keyState = (semitone: number): "right" | "wrong" | null => {
    if (phase !== "revealed") return null;
    if (semitone === target) return "right";
    if (semitone === picked) return "wrong";
    return null;
  };

  const playable = phase === "asking";
  const dim = (semitone: number) => !hard && !WHITE.includes(semitone);

  return (
    <>
      <BackButton />
      <GameLayout>
        <header className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            <Trans id="piano.title" message="Absolute Piano" />
          </h1>
          <p className="mt-0.5 text-sm text-neutral-400 tabular-nums">
            <Trans id="piano.streak" message="Streak" />{" "}
            <span className="font-semibold text-neutral-100">{streak}</span>
            {best > 0 && (
              <>
                {" · "}
                <Trans id="common.best" message="Best" /> {best}
              </>
            )}
          </p>
        </header>

        {/* The prompt. Replaying is free — this is a trainer, not an exam. */}
        <div className="flex flex-col items-center gap-2">
          {phase === "idle" ? (
            <button
              onClick={() => ask(null)}
              className="rounded-full bg-indigo-500 px-8 py-3 text-lg font-semibold text-neutral-50 hover:bg-indigo-400"
            >
              <Trans id="piano.start" message="Play a note" />
            </button>
          ) : (
            <button
              onClick={() => target !== null && piano(freqOf(target))}
              className="flex items-center gap-2 rounded-full bg-neutral-800 px-6 py-2.5 font-semibold hover:bg-neutral-700"
            >
              <span aria-hidden="true">🔊</span>
              <Trans id="piano.again" message="Hear it again" />
            </button>
          )}

          <p className="h-6 text-sm font-medium">
            {phase === "revealed" && target !== null ? (
              right ? (
                <span className="text-emerald-400">
                  <Trans id="piano.right" message="Yes —" /> {NAMES[target]}
                  {OCTAVE}
                </span>
              ) : (
                <span className="text-rose-300">
                  <Trans id="piano.wrong" message="It was" /> {NAMES[target]}
                  {OCTAVE}
                </span>
              )
            ) : phase === "asking" ? (
              <span className="text-neutral-400">
                <Trans id="piano.find" message="Find it on the keyboard" />
              </span>
            ) : (
              <span className="text-neutral-500">
                <Trans
                  id="piano.hint"
                  message="One octave. Which of the twelve is it?"
                />
              </span>
            )}
          </p>
        </div>

        {/* The keyboard. White keys tile the width; black keys sit over the
            seams between them. Everything is in % so it scales with the box. */}
        <div className="flex min-h-0 flex-1 items-stretch">
          <div className="relative w-full touch-none select-none">
            <div className="flex h-full w-full gap-[0.4%]">
              {WHITE.map((semitone) => {
                const state = keyState(semitone);
                return (
                  <button
                    key={semitone}
                    onPointerDown={() => answer(semitone)}
                    disabled={!playable}
                    className={`relative flex flex-1 items-end justify-center rounded-b-lg pb-2 text-sm font-semibold transition-colors ${
                      state === "right"
                        ? "bg-emerald-400 text-emerald-950"
                        : state === "wrong"
                          ? "bg-rose-400 text-rose-950"
                          : "bg-neutral-100 text-neutral-500 active:bg-neutral-300"
                    }`}
                  >
                    {NAMES[semitone]}
                  </button>
                );
              })}
            </div>

            {BLACK.map(([semitone, seam]) => {
              const state = keyState(semitone);
              return (
                <button
                  key={semitone}
                  onPointerDown={() => answer(semitone)}
                  disabled={!playable || dim(semitone)}
                  style={{
                    left: `${(seam / WHITE.length) * 100}%`,
                    width: `${(BLACK_W / WHITE.length) * 100}%`,
                    height: `${BLACK_H}%`,
                    transform: "translateX(-50%)",
                  }}
                  className={`absolute top-0 flex items-end justify-center rounded-b-md pb-1.5 text-[0.7rem] font-semibold transition-colors ${
                    state === "right"
                      ? "bg-emerald-400 text-emerald-950"
                      : state === "wrong"
                        ? "bg-rose-400 text-rose-950"
                        : dim(semitone)
                          ? "bg-neutral-800 text-neutral-700"
                          : "bg-neutral-900 text-neutral-400 active:bg-neutral-700"
                  }`}
                >
                  {NAMES[semitone]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-center gap-2">
          {phase === "revealed" && !right ? (
            <button
              onClick={() => ask(target)}
              className="rounded-full bg-indigo-500 px-6 py-2 font-semibold text-neutral-50 hover:bg-indigo-400"
            >
              <Trans id="piano.next" message="Next note" />
            </button>
          ) : (
            <div className="flex rounded-full bg-neutral-900 p-1 text-sm">
              <button
                onClick={() => setDifficulty(false)}
                className={`rounded-full px-4 py-1.5 font-medium transition-colors ${
                  hard ? "text-neutral-400" : "bg-neutral-700 text-neutral-100"
                }`}
              >
                <Trans id="piano.white" message="White keys" />
              </button>
              <button
                onClick={() => setDifficulty(true)}
                className={`rounded-full px-4 py-1.5 font-medium transition-colors ${
                  hard ? "bg-neutral-700 text-neutral-100" : "text-neutral-400"
                }`}
              >
                <Trans id="piano.all" message="All twelve" />
              </button>
            </div>
          )}
        </div>
      </GameLayout>
    </>
  );
}
