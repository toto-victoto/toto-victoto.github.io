import { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react";
import type { Route } from "./+types/piano";
import { BackButton } from "../components/BackButton";
import { GameLayout } from "../components/GameLayout";
import { useStoredGame } from "../storage";
import { piano, sfx } from "../sound";

// Absolute Piano: a note sounds, you find it. One octave, so the question is
// only ever "which of the twelve is this?" — never "which octave was that?".
// That is the absolute-pitch question in its smallest form.
//
// The keys are blank. Writing the names on them would turn the keyboard into
// a lookup table — you would hear a note, name it in your head, and then just
// read the labels until one matched. Blank keys mean you have to know both the
// pitch AND where it lives, which is what playing by ear actually is. The
// reveal does the teaching instead: the right key lights up, so you see where
// it was, and the line above names it, so you learn what it was called.
//
// The one rule that keeps it honest: during a question a key does NOT sound
// when you touch it. If it did you could hunt for the answer by comparing
// tones, which is relative pitch, which is the thing this game isn't.

// Semitones above C. The NAMES are not universal — France says Do Ré Mi where
// English says C D E — so they live in the catalogs, as one entry holding the
// seven naturals in order. Every black key is a semitone above a white one, so
// the five sharps are built from that same list and need no entry of their own.
const SEMITONES = 12;
const SHARP = "♯";
const ALL = Array.from({ length: SEMITONES }, (_, i) => i);

// The keyboard always shows ONE octave, but the note you hear can come from up
// to three. That is deliberate: the answer is the note, not the register, so
// tapping Fa is right whether it was Fa3, Fa4 or Fa5. Recognising a pitch
// regardless of how high it was played is what absolute pitch actually is —
// and it means a wider range costs no extra keys.
//
// Spans grow upward first so that "one octave" stays exactly the game it was.
const SPANS: number[][] = [[4], [4, 5], [3, 4, 5]];

// Typing keys to semitones, in the layout every DAW and web piano already
// uses — the home row is the white keys, the row above holds the black ones
// where they physically sit:
//
//     W E   T Y U
//    A S D F G H J
//
// Worth having because the piano keys are the one control a mouse is bad at:
// twelve small targets you want to hit quickly and in sequence, especially
// while exploring after a miss. On a phone it costs nothing.
const TYPED: Record<string, number> = {
  a: 0,
  w: 1,
  s: 2,
  e: 3,
  d: 4,
  f: 5,
  t: 6,
  g: 7,
  y: 8,
  h: 9,
  u: 10,
  j: 11,
};
const TYPED_FOR: Record<number, string> = Object.fromEntries(
  Object.entries(TYPED).map(([k, s]) => [s, k.toUpperCase()]),
);

// MIDI numbering: C-1 is 0, so octave o starts at 12 * (o + 1). C4 = 60.
const midiOf = (octave: number, semitone: number) => 12 * (octave + 1) + semitone;
const semitoneOf = (midi: number) => midi % SEMITONES;
const octaveOf = (midi: number) => Math.floor(midi / SEMITONES) - 1;

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
const freqOf = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

const REVEAL_HOLD = 1000; // ms a correct answer sits before the next note

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Absolute Piano — toto-victoto" },
    { name: "description", content: "Hear a note, find it on the keyboard." },
  ];
}

type Phase = "idle" | "asking" | "revealed";

export default function Piano() {
  const { i18n } = useLingui();
  const [phase, setPhase] = useState<Phase>("idle");
  const [target, setTarget] = useState<number | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [streak, setStreak] = useState(0);
  const [hard, setHard] = useState(false); // all twelve, vs the white keys only
  const [span, setSpan] = useState(1); // how many octaves notes are drawn from
  const [showNames, setShowNames] = useState(false);
  // Whether to bother showing the typing letters. Starts false so the
  // prerendered HTML and the first client render agree, then asks the browser.
  const [typable, setTypable] = useState(false);
  useEffect(() => {
    setTypable(window.matchMedia("(pointer: fine)").matches);
  }, []);
  const [{ best }, setBest] = useStoredGame("piano", { best: 0 });

  // Seven naturals in keyboard order, in whatever the reader calls them.
  const naturals = i18n
    ._({ id: "piano.notes", message: "C D E F G A B" })
    .split(/\s+/);
  const nameOf = (semitone: number): string => {
    const white = WHITE.indexOf(semitone);
    if (white >= 0) return naturals[white];
    return naturals[WHITE.indexOf(semitone - 1)] + SHARP;
  };

  // Every note in play: each allowed pitch class, in each octave of the span.
  // Taken as arguments rather than read from state, because the settings
  // handler needs a pool built from values React has not committed yet.
  const poolFor = (twelve: boolean, octaves: number) =>
    SPANS[octaves - 1].flatMap((octave) =>
      (twelve ? ALL : WHITE).map((semitone) => midiOf(octave, semitone)),
    );

  // Avoid the pitch class just asked, not the exact note — the same key twice
  // in a row reads as a bug even an octave apart, and even when it's honest
  // chance.
  const askFrom = useCallback(
    (twelve: boolean, octaves: number, avoid: number | null) => {
      const all = poolFor(twelve, octaves);
      const choices = all.filter((m) => semitoneOf(m) !== avoid);
      const from = choices.length > 0 ? choices : all;
      const next = from[Math.floor(Math.random() * from.length)];
      setTarget(next);
      setPicked(null);
      setPhase("asking");
      piano(freqOf(next));
    },
    [],
  );

  const ask = useCallback(
    (avoid: number | null) => askFrom(hard, span, avoid),
    [askFrom, hard, span],
  );

  const answer = (semitone: number) => {
    if (phase !== "asking" || target === null) return;
    setPicked(semitone);
    setPhase("revealed");
    // Sound the right note, not the one that was touched: the point of the
    // reveal is to tie the pitch you just heard to the key it belongs to.
    piano(freqOf(target));
    if (semitone === semitoneOf(target)) {
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
  const right =
    phase === "revealed" && target !== null && picked === semitoneOf(target);
  const targetRef = useRef(target);
  targetRef.current = target;
  useEffect(() => {
    if (!right) return;
    const t = window.setTimeout(
      () => ask(targetRef.current === null ? null : semitoneOf(targetRef.current)),
      REVEAL_HOLD,
    );
    return () => window.clearTimeout(t);
  }, [right, ask]);

  // One rule for all three settings, because all three change how hard a
  // correct answer is — names make the keyboard a lookup table, the slider
  // widens the range, the pills add the black keys. A streak earned under the
  // old settings is not a claim about the new ones, so changing any of them
  // ends the run.
  //
  // It does NOT send you back to the start screen though: if a note was in
  // flight it is replaced by a fresh one from the new pool straight away, so
  // the only thing a change costs you is the number. That also means a target
  // can never outlive the settings that made it legal — the stale case was a
  // black key left unanswerable by switching to white-only, and a note from an
  // octave the slider had just excluded.
  const retune = (next: {
    hard?: boolean;
    span?: number;
    showNames?: boolean;
  }) => {
    const twelve = next.hard ?? hard;
    const octaves = next.span ?? span;
    const names = next.showNames ?? showNames;
    if (twelve === hard && octaves === span && names === showNames) return;
    setHard(twelve);
    setSpan(octaves);
    setShowNames(names);
    setStreak(0);
    if (phase !== "idle") askFrom(twelve, octaves, null);
  };

  const keyState = (semitone: number): "right" | "wrong" | null => {
    if (phase !== "revealed" || target === null) return null;
    if (semitone === semitoneOf(target)) return "right";
    if (semitone === picked) return "wrong";
    return null;
  };

  // A miss opens the keyboard up: every key sounds, in the octave the note you
  // missed came from, until you ask for the next one. That is the one moment
  // where letting keys sing can't be cheated — the answer is already on screen
  // — and it is the moment it teaches most, because you can walk around the
  // note you got wrong and hear what it actually sits between.
  const exploring = phase === "revealed" && !right;
  const answering = phase === "asking";
  const exploreOctave = target === null ? SPANS[0][0] : octaveOf(target);

  const touch = (semitone: number) => {
    if (answering) return answer(semitone);
    if (exploring) piano(freqOf(midiOf(exploreOctave, semitone)));
  };

  // Black keys are greyed out in white-keys mode — but not while exploring:
  // free means free, and hearing the semitone either side is the point.
  const dim = (semitone: number) =>
    !exploring && !hard && !WHITE.includes(semitone);

  // Space and Enter do whatever the obvious button does right now.
  const primary = () => {
    if (phase === "idle") return ask(null);
    if (exploring) return ask(target === null ? null : semitoneOf(target));
    if (answering && target !== null) piano(freqOf(target)); // hear it again
  };

  // Playing from the typing keyboard. Two rules keep it from fighting the
  // page: a held key must not machine-gun notes (`repeat`), and Space or
  // Enter is left alone whenever a control has focus, so tabbing to a button
  // and pressing Space still works that button rather than firing both it and
  // this. No dependency array — it re-registers each render so the handler
  // always closes over the current phase.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const on = document.activeElement;
      if (on instanceof HTMLInputElement || on instanceof HTMLTextAreaElement) {
        return;
      }
      const semitone = TYPED[e.key.toLowerCase()];
      if (semitone !== undefined) {
        if (dim(semitone)) return;
        e.preventDefault();
        touch(semitone);
        return;
      }
      if (e.key !== " " && e.key !== "Enter") return;
      if (on instanceof HTMLButtonElement) return; // let the button have it
      e.preventDefault();
      primary();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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

        {/* The prompt. Replaying is free — this is a trainer, not an exam.
            "Next note" lives up here rather than below so that revealing an
            answer never resizes the keyboard. */}
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center gap-2">
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
            {phase === "revealed" && !right && (
              <button
                onClick={() =>
                  ask(target === null ? null : semitoneOf(target))
                }
                className="rounded-full bg-indigo-500 px-6 py-2.5 font-semibold text-neutral-50 hover:bg-indigo-400"
              >
                <Trans id="piano.next" message="Next note" />
              </button>
            )}
          </div>

          <p className="h-6 text-sm font-medium">
            {phase === "revealed" && target !== null ? (
              right ? (
                <span className="text-emerald-400">
                  <Trans id="piano.right" message="Yes —" />{" "}
                  {nameOf(semitoneOf(target))}
                  {octaveOf(target)}
                </span>
              ) : (
                <>
                  <span className="text-rose-300">
                    <Trans id="piano.wrong" message="It was" />{" "}
                    {nameOf(semitoneOf(target))}
                    {octaveOf(target)}
                  </span>
                  {/* On the same line, so opening free mode doesn't resize
                      the keyboard underneath. */}
                  <span className="text-neutral-500">
                    {" · "}
                    <Trans
                      id="piano.explore"
                      message="try any key"
                    />
                  </span>
                </>
              )
            ) : phase === "asking" ? (
              <span className="text-neutral-400">
                <Trans id="piano.find" message="Find it on the keyboard" />
              </span>
            ) : (
              <span className="text-neutral-500">
                {span === 1 ? (
                  <Trans
                    id="piano.hint"
                    message="One octave. Which of the twelve is it?"
                  />
                ) : (
                  <Trans
                    id="piano.hint.wide"
                    message="Any octave — the note is what counts."
                  />
                )}
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
                    onPointerDown={() => touch(semitone)}
                    disabled={!answering && !exploring}
                    aria-label={nameOf(semitone)}
                    className={`relative flex flex-1 items-end justify-center rounded-b-lg pb-2 text-sm font-semibold transition-colors ${
                      state === "right"
                        ? "bg-emerald-400 text-emerald-950"
                        : state === "wrong"
                          ? "bg-rose-400 text-rose-950"
                          : "bg-neutral-100 text-neutral-500 active:bg-neutral-300"
                    }`}
                  >
                    {showNames && (
                      <span className="flex flex-col items-center leading-none">
                        {typable && (
                          <span className="mb-1 text-[0.6rem] font-normal opacity-45">
                            {TYPED_FOR[semitone]}
                          </span>
                        )}
                        {nameOf(semitone)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {BLACK.map(([semitone, seam]) => {
              const state = keyState(semitone);
              return (
                <button
                  key={semitone}
                  onPointerDown={() => touch(semitone)}
                  disabled={(!answering && !exploring) || dim(semitone)}
                  aria-label={nameOf(semitone)}
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
                  {showNames && (
                    <span className="flex flex-col items-center leading-none">
                      {typable && (
                      <span className="mb-1 text-[0.6rem] font-normal opacity-45">
                        {TYPED_FOR[semitone]}
                      </span>
                    )}
                      {nameOf(semitone)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Settings. Always on screen, so nothing below the keyboard moves
            when an answer is revealed. */}
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center gap-2">
            <div className="flex rounded-full bg-neutral-900 p-1 text-sm">
              <button
                onClick={() => retune({ hard: false })}
                className={`rounded-full px-4 py-1.5 font-medium transition-colors ${
                  hard ? "text-neutral-400" : "bg-neutral-700 text-neutral-100"
                }`}
              >
                <Trans id="piano.white" message="White keys" />
              </button>
              <button
                onClick={() => retune({ hard: true })}
                className={`rounded-full px-4 py-1.5 font-medium transition-colors ${
                  hard ? "bg-neutral-700 text-neutral-100" : "text-neutral-400"
                }`}
              >
                <Trans id="piano.all" message="All twelve" />
              </button>
            </div>

            <button
              onClick={() => retune({ showNames: !showNames })}
              aria-pressed={showNames}
              className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                showNames
                  ? "bg-indigo-500 text-neutral-50"
                  : "bg-neutral-900 text-neutral-400"
              }`}
            >
              <Trans id="piano.shownames" message="Names" />
            </button>
          </div>

          <label className="flex items-center gap-2 text-xs text-neutral-400">
            <Trans id="piano.octaves" message="Octaves" />
            <input
              type="range"
              min={1}
              max={SPANS.length}
              step={1}
              value={span}
              onChange={(e) => retune({ span: Number(e.target.value) })}
              aria-label={i18n._({ id: "piano.octaves", message: "Octaves" })}
              className="h-1 w-32 accent-indigo-500"
            />
            <span className="w-3 font-semibold text-neutral-200 tabular-nums">
              {span}
            </span>
          </label>
        </div>
      </GameLayout>
    </>
  );
}
