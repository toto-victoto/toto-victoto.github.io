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
