// Global sound: a single lazily-created AudioContext shared by every game, a
// persisted mute preference, and a small library of synthesised SFX (no asset
// files). Games just call `sfx.*` / `tone()`; muting and audio-unlock are
// handled here. The AudioContext can only start after a user gesture (autoplay
// policy), so `installAudioUnlock()` resumes it on the first interaction.

const MUTE_KEY = "tv:muted";

let ctx: AudioContext | null = null;
let unlockInstalled = false;
let muted = loadMuted();
const listeners = new Set<() => void>();

function loadMuted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(next: boolean): void {
  muted = next;
  try {
    window.localStorage.setItem(MUTE_KEY, next ? "1" : "0");
  } catch {
    // storage disabled — keep the in-memory value
  }
  listeners.forEach((l) => l());
}

export function toggleMuted(): boolean {
  setMuted(!muted);
  return muted;
}

// External-store subscription so a toggle button can reflect the mute state.
export function subscribeMuted(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (Ctor) ctx = new Ctor();
  }
  if (ctx && ctx.state === "suspended") void ctx.resume();
  return ctx;
}

// Create/resume the context on the first user gesture, then stop listening.
export function installAudioUnlock(): void {
  if (typeof window === "undefined" || unlockInstalled) return;
  unlockInstalled = true;
  const unlock = () => {
    getCtx();
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock);
}

type ToneOpts = {
  type?: OscillatorType;
  gain?: number;
  delay?: number; // seconds from now, for sequencing
};

// One decaying oscillator note. Cheap and fire-and-forget.
export function tone(freq: number, dur: number, opts: ToneOpts = {}): void {
  if (muted) return;
  const c = getCtx();
  if (!c) return;
  const { type = "triangle", gain = 0.14, delay = 0 } = opts;
  const t = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(t);
  osc.stop(t + dur);
}

// A shared vocabulary of effects, reused across games.
export const sfx = {
  ui: () => tone(480, 0.05, { type: "square", gain: 0.05 }),
  place: () => tone(340, 0.09, { type: "triangle", gain: 0.12 }),
  eat: () => tone(680, 0.08, { type: "square", gain: 0.09 }),
  flap: () => tone(430, 0.07, { type: "sine", gain: 0.12 }),
  score: () => tone(600, 0.12, { type: "triangle", gain: 0.12 }),
  // Ascending pitch with a step (combos, chained scores).
  rise: (step = 0) =>
    tone(392 * 2 ** (Math.min(step, 12) / 12), 0.14, { type: "triangle" }),
  win: () =>
    [0, 4, 7, 12].forEach((s, i) =>
      tone(440 * 2 ** (s / 12), 0.2, { type: "triangle", gain: 0.12, delay: i * 0.09 }),
    ),
  lose: () => {
    tone(200, 0.28, { type: "sawtooth", gain: 0.14 });
    tone(150, 0.34, { type: "sawtooth", gain: 0.12, delay: 0.09 });
  },
  // Roulette wheel ticking to a stop.
  spin: () => {
    for (let i = 0; i < 7; i++) {
      tone(300 + i * 24, 0.04, { type: "square", gain: 0.05, delay: i * 0.07 });
    }
  },
};

// ---- Looping title theme ---------------------------------------------------
// A little chiptune played on the RPS Saga splash. Two tracks (melody + bass)
// run on their own note-clocks so the melody can be busy over slow bass. Notes
// are played just-in-time via tone(), so the live mute state is respected and
// stopping is instant. Autoplay policy still applies — it only sounds once the
// AudioContext is unlocked by a user gesture.
const STEP = 0.15; // seconds per rhythmic unit (an eighth note)
// [freq (0 = rest), length in steps]. The two tracks share a total length so
// they stay in phase each loop.
const THEME_MELODY: [number, number][] = [
  [659.25, 2], [783.99, 2], [523.25, 2], [659.25, 2], // C:  E5 G5 C5 E5
  [587.33, 2], [783.99, 2], [493.88, 2], [587.33, 2], // G:  D5 G5 B4 D5
  [523.25, 2], [659.25, 2], [440.0, 2], [523.25, 2], //  Am: C5 E5 A4 C5
  [698.46, 2], [523.25, 2], [440.0, 2], [523.25, 2], //  F:  F5 C5 A4 C5
  [659.25, 2], [783.99, 2], [523.25, 2], [659.25, 2], // C
  [523.25, 2], [659.25, 2], [440.0, 2], [523.25, 2], //  Am
  [698.46, 2], [523.25, 2], [440.0, 2], [523.25, 2], //  F
  [587.33, 2], [493.88, 2], [392.0, 2], [0, 2], //        G  (breathe)
];
const THEME_BASS: [number, number][] = [
  [130.81, 4], [130.81, 4], // C3
  [98.0, 4], [98.0, 4], //     G2
  [110.0, 4], [110.0, 4], //   A2
  [87.31, 4], [87.31, 4], //   F2
  [130.81, 4], [130.81, 4], // C3
  [110.0, 4], [110.0, 4], //   A2
  [87.31, 4], [87.31, 4], //   F2
  [98.0, 4], [98.0, 4], //     G2
];

let themeStops: Array<() => void> = [];

function runTrack(
  track: [number, number][],
  opts: ToneOpts,
  unit = STEP,
): () => void {
  let i = 0;
  let timer: ReturnType<typeof setTimeout>;
  const step = () => {
    const [freq, len] = track[i];
    if (freq) tone(freq, unit * len * 0.9, opts);
    i = (i + 1) % track.length;
    timer = setTimeout(step, unit * len * 1000);
  };
  step();
  return () => clearTimeout(timer);
}

export function startTitleTheme(): void {
  if (typeof window === "undefined" || themeStops.length) return;
  themeStops = [
    runTrack(THEME_MELODY, { type: "triangle", gain: 0.08 }),
    runTrack(THEME_BASS, { type: "square", gain: 0.045 }),
  ];
}

export function stopTitleTheme(): void {
  themeStops.forEach((stop) => stop());
  themeStops = [];
}

// ---- Slot spin loop --------------------------------------------------------
// A fast, bouncy bonus-room riff for the 1-UP Slots reels. It runs while the
// reels spin and stops the moment they rest, so the payline jingle lands clean.
const SLOT_STEP = 0.11; // seconds per note — quick and lively
const SLOT_MELODY: [number, number][] = [
  [523.25, 1], [659.25, 1], [783.99, 1], [1046.5, 1], // C5 E5 G5 C6
  [783.99, 1], [659.25, 1], [880.0, 1], [659.25, 1], //  G5 E5 A5 E5
  [587.33, 1], [698.46, 1], [880.0, 1], [1174.66, 1], // D5 F5 A5 D6
  [880.0, 1], [698.46, 1], [587.33, 1], [523.25, 1], //  A5 F5 D5 C5
];
const SLOT_BASS: [number, number][] = [
  [130.81, 2], [130.81, 2], [196.0, 2], [196.0, 2], // C3 C3 G3 G3
  [146.83, 2], [146.83, 2], [130.81, 2], [130.81, 2], // D3 D3 C3 C3
];

let slotStops: Array<() => void> = [];

export function startSlotSpin(): void {
  if (typeof window === "undefined" || slotStops.length) return;
  slotStops = [
    runTrack(SLOT_MELODY, { type: "square", gain: 0.06 }, SLOT_STEP),
    runTrack(SLOT_BASS, { type: "triangle", gain: 0.05 }, SLOT_STEP),
  ];
}

export function stopSlotSpin(): void {
  slotStops.forEach((stop) => stop());
  slotStops = [];
}
