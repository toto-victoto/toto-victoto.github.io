import { useCallback, useEffect, useRef, useState } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/duel";
import { BackButton } from "../components/BackButton";
import { GameLayout } from "../components/GameLayout";
import { PairingPanel } from "../components/PairingPanel";
import { useNetGame, type NetRole } from "../net";
import { useStoredGame } from "../storage";
import { sfx, tone } from "../sound";

// Reaction duel: two phones, one light. It goes green at a moment neither
// player can predict, and the quicker thumb takes the round. Tap before it
// turns and you hand the round away.
//
// Why this is fair over a link with lag: each device times its OWN green — from
// the frame it paints the light to the frame its player taps — and reports that
// number. Lag changes WHEN each screen turns green, not how fast someone reacts
// to it, so the two numbers stay comparable. The referee never compares clocks,
// only durations, so it never has to know how far apart the devices are.
const ARM_MIN = 1.5; // seconds of red before the light can turn
const ARM_MAX = 5;
const TARGET = 5; // rounds to take the match
const GRACE = 3000; // ms the referee waits for the slower thumb
const FALSE_START = -1; // a tap reported from the red stage

type Stage = "lobby" | "arming" | "go" | "round" | "over";

type Duel = {
  stage: Stage;
  goId: number; // bumped every round, so each device knows to re-time
  scores: { host: number; guest: number };
  taps: { host: number | null; guest: number | null };
  winner: NetRole | null;
  falseStart: boolean;
  champion: NetRole | null;
};

type Intent =
  | { type: "ready" }
  | { type: "go"; id: number }
  | { type: "tap"; ms: number; id: number }
  | { type: "timeout"; id: number }
  | { type: "reset" };

const FRESH: Duel = {
  stage: "lobby",
  goId: 0,
  scores: { host: 0, guest: 0 },
  taps: { host: null, guest: null },
  winner: null,
  falseStart: false,
  champion: null,
};

const other = (who: NetRole): NetRole => (who === "host" ? "guest" : "host");

// Award the round and see whether that takes the match.
function award(state: Duel, winner: NetRole, falseStart: boolean): Duel {
  const scores = { ...state.scores, [winner]: state.scores[winner] + 1 };
  return {
    ...state,
    stage: scores[winner] >= TARGET ? "over" : "round",
    scores,
    winner,
    falseStart,
    champion: scores[winner] >= TARGET ? winner : null,
  };
}

// The referee. Runs on the host only — see `useNetGame`.
export function reduce(state: Duel, intent: Intent, from: NetRole): Duel {
  switch (intent.type) {
    case "ready":
      if (state.stage === "arming" || state.stage === "go") return state;
      if (state.stage === "over") return state;
      return {
        ...state,
        stage: "arming",
        goId: state.goId + 1,
        taps: { host: null, guest: null },
        winner: null,
        falseStart: false,
      };

    case "go":
      // Ignore a light from a round that has already been decided.
      if (state.stage !== "arming" || intent.id !== state.goId) return state;
      return { ...state, stage: "go" };

    case "tap": {
      if (intent.id !== state.goId) return state;
      // Jumped the gun: the round goes to the other player at once.
      if (state.stage === "arming" || intent.ms === FALSE_START) {
        if (state.stage !== "arming" && state.stage !== "go") return state;
        return award(
          { ...state, taps: { ...state.taps, [from]: FALSE_START } },
          other(from),
          true,
        );
      }
      if (state.stage !== "go") return state;
      if (state.taps[from] !== null) return state;
      const taps = { ...state.taps, [from]: intent.ms };
      if (taps.host === null || taps.guest === null) return { ...state, taps };
      return award({ ...state, taps }, taps.host <= taps.guest ? "host" : "guest", false);
    }

    case "timeout": {
      // One thumb never arrived; the one that did takes the round.
      if (state.stage !== "go" || intent.id !== state.goId) return state;
      const who: NetRole | null =
        state.taps.host !== null ? "host" : state.taps.guest !== null ? "guest" : null;
      return who ? award(state, who, false) : state;
    }

    case "reset":
      return { ...FRESH, goId: state.goId + 1 };
  }
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Reflex Duel — toto-victoto" },
    { name: "description", content: "A two-phone reaction duel." },
  ];
}

export default function Duel() {
  const { state, dispatch, isHost, net } = useNetGame<Duel, Intent>(FRESH, reduce);
  const [{ best }, setBest] = useStoredGame("duel", { best: 0 });
  const [practice, setPractice] = useState(false);
  const linked = net.phase === "connected";
  const me: NetRole = net.role === "guest" ? "guest" : "host";

  // The instant this device paints the light. Every reported time is measured
  // from here, never from a shared clock.
  const goAtRef = useRef<number | null>(null);
  const idRef = useRef(state.goId);
  idRef.current = state.goId;

  useEffect(() => {
    if (state.stage === "go") {
      goAtRef.current = performance.now();
      tone(880, 0.08, { type: "square", gain: 0.1 });
    } else if (state.stage !== "arming") {
      goAtRef.current = null;
    }
  }, [state.stage, state.goId]);

  // Host-only timers: when the light turns, and when to stop waiting for the
  // second player. A guest runs neither — there is exactly one referee.
  useEffect(() => {
    if (!isHost || state.stage !== "arming") return;
    const id = state.goId;
    const wait = (ARM_MIN + Math.random() * (ARM_MAX - ARM_MIN)) * 1000;
    const timer = window.setTimeout(() => dispatch({ type: "go", id }), wait);
    return () => window.clearTimeout(timer);
  }, [isHost, state.stage, state.goId, dispatch]);

  useEffect(() => {
    if (!isHost || state.stage !== "go") return;
    if (state.taps.host === null && state.taps.guest === null) return;
    const id = state.goId;
    const timer = window.setTimeout(() => dispatch({ type: "timeout", id }), GRACE);
    return () => window.clearTimeout(timer);
  }, [isHost, state.stage, state.goId, state.taps, dispatch]);

  // Best personal reaction, across duels and practice alike.
  const remember = useCallback(
    (ms: number) => {
      if (ms > 0) setBest((s) => ({ best: s.best === 0 ? ms : Math.min(s.best, ms) }));
    },
    [setBest],
  );

  useEffect(() => {
    const mine = state.taps[me];
    if (mine !== null && mine > 0) remember(mine);
  }, [state.taps, me, remember]);

  useEffect(() => {
    if (state.stage !== "round" && state.stage !== "over") return;
    if (state.winner === me) sfx.win();
    else sfx.lose();
  }, [state.stage, state.goId, state.winner, me]);

  const tap = () => {
    if (state.stage === "arming") {
      dispatch({ type: "tap", ms: FALSE_START, id: idRef.current });
      return;
    }
    if (state.stage !== "go" || goAtRef.current === null) return;
    if (state.taps[me] !== null) return;
    dispatch({
      type: "tap",
      ms: Math.round(performance.now() - goAtRef.current),
      id: idRef.current,
    });
  };

  // ---- not linked yet: pair up, or practise alone ----
  if (!linked && !practice) {
    return (
      <>
        <BackButton />
        <GameLayout>
          <header className="text-center">
            <h1 className="text-3xl font-semibold tracking-tight">
              <Trans id="duel.title" message="Reflex Duel" />
            </h1>
            <p className="mt-1 text-sm text-neutral-400">
              <Trans
                id="duel.tagline"
                message="Wait for green. Fastest thumb takes the round."
              />
            </p>
          </header>
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
            <PairingPanel game="duel" />
            <button
              onClick={() => setPractice(true)}
              className="rounded-full px-4 py-2 text-sm text-neutral-400 hover:text-neutral-200"
            >
              <Trans id="duel.practice" message="Practise alone" />
            </button>
            {best > 0 && (
              <p className="text-sm text-neutral-500 tabular-nums">
                <Trans id="duel.best" message="Best" /> {best} ms
              </p>
            )}
          </div>
        </GameLayout>
      </>
    );
  }

  if (practice && !linked) {
    return <Practice best={best} remember={remember} onLeave={() => setPractice(false)} />;
  }

  // ---- linked: the duel ----
  const lit = state.stage === "go";
  const waiting = state.stage === "go" && state.taps[me] !== null;
  const mine = state.taps[me];
  const theirs = state.taps[other(me)];

  return (
    <>
      <BackButton />
      <GameLayout>
        <header className="text-center">
          <p className="text-2xl font-bold tabular-nums">
            <span className={me === "host" ? "text-emerald-400" : "text-neutral-500"}>
              {state.scores.host}
            </span>
            <span className="mx-2 text-neutral-600">—</span>
            <span className={me === "guest" ? "text-emerald-400" : "text-neutral-500"}>
              {state.scores.guest}
            </span>
          </p>
          <p className="text-xs text-neutral-500">
            <Trans id="duel.youare" message="You are" />{" "}
            {me === "host" ? (
              <Trans id="duel.left" message="left" />
            ) : (
              <Trans id="duel.right" message="right" />
            )}
            {" · "}
            <Trans id="duel.firstto" message="First to" /> {TARGET}
          </p>
        </header>

        <button
          onPointerDown={tap}
          disabled={state.stage === "over"}
          className={`relative flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-2xl text-center transition-colors duration-75 ${
            lit
              ? "bg-emerald-500 text-neutral-950"
              : state.stage === "arming"
                ? "bg-rose-900/70"
                : "bg-neutral-900"
          }`}
        >
          {state.stage === "lobby" && (
            <span className="px-6 text-lg font-semibold text-neutral-300">
              <Trans id="duel.ready" message="Tap ready when you both are." />
            </span>
          )}
          {state.stage === "arming" && (
            <span className="px-6 text-lg font-semibold text-rose-200">
              <Trans id="duel.wait" message="Wait for green…" />
            </span>
          )}
          {lit && (
            <span className="text-5xl font-black">
              {waiting ? (
                <Trans id="duel.sent" message="Got it" />
              ) : (
                <Trans id="duel.now" message="NOW" />
              )}
            </span>
          )}
          {(state.stage === "round" || state.stage === "over") && (
            <div className="space-y-2 px-6">
              <p
                className={`text-2xl font-bold ${
                  state.winner === me ? "text-emerald-400" : "text-rose-300"
                }`}
              >
                {state.falseStart ? (
                  state.winner === me ? (
                    <Trans id="duel.theyjumped" message="They jumped the gun" />
                  ) : (
                    <Trans id="duel.youjumped" message="Too early!" />
                  )
                ) : state.winner === me ? (
                  <Trans id="duel.won" message="Round yours" />
                ) : (
                  <Trans id="duel.lost" message="Round theirs" />
                )}
              </p>
              <p className="text-sm text-neutral-400 tabular-nums">
                <Trans id="duel.you" message="You" />{" "}
                {mine === null ? "—" : mine === FALSE_START ? "✗" : `${mine} ms`}
                {" · "}
                <Trans id="duel.them" message="Them" />{" "}
                {theirs === null ? "—" : theirs === FALSE_START ? "✗" : `${theirs} ms`}
              </p>
              {state.stage === "over" && (
                <p className="text-lg font-semibold">
                  {state.champion === me ? (
                    <Trans id="duel.matchwon" message="You win the match!" />
                  ) : (
                    <Trans id="duel.matchlost" message="They win the match." />
                  )}
                </p>
              )}
            </div>
          )}
        </button>

        <div className="flex items-center justify-center gap-2">
          {state.stage === "over" ? (
            <button
              onClick={() => dispatch({ type: "reset" })}
              className="rounded-full bg-emerald-500 px-6 py-2.5 font-semibold text-neutral-900 hover:bg-emerald-400"
            >
              <Trans id="common.reset" message="Reset" />
            </button>
          ) : (
            <button
              onClick={() => dispatch({ type: "ready" })}
              disabled={state.stage === "arming" || state.stage === "go"}
              className="rounded-full bg-emerald-500 px-6 py-2.5 font-semibold text-neutral-900 hover:bg-emerald-400 disabled:opacity-40"
            >
              {state.stage === "lobby" ? (
                <Trans id="duel.start" message="Ready" />
              ) : (
                <Trans id="duel.next" message="Next round" />
              )}
            </button>
          )}
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

// Same light, one thumb: a way to warm up (and to see the game at all) before
// anybody else is on the line.
function Practice({
  best,
  remember,
  onLeave,
}: {
  best: number;
  remember: (ms: number) => void;
  onLeave: () => void;
}) {
  const [stage, setStage] = useState<"lobby" | "arming" | "go" | "done">("lobby");
  const [ms, setMs] = useState<number | null>(null);
  const goAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (stage !== "arming") return;
    const wait = (ARM_MIN + Math.random() * (ARM_MAX - ARM_MIN)) * 1000;
    const timer = window.setTimeout(() => setStage("go"), wait);
    return () => window.clearTimeout(timer);
  }, [stage]);

  useEffect(() => {
    if (stage === "go") {
      goAtRef.current = performance.now();
      tone(880, 0.08, { type: "square", gain: 0.1 });
    }
  }, [stage]);

  const tap = () => {
    if (stage === "arming") {
      setMs(FALSE_START);
      setStage("done");
      sfx.lose();
      return;
    }
    if (stage !== "go" || goAtRef.current === null) return;
    const t = Math.round(performance.now() - goAtRef.current);
    setMs(t);
    remember(t);
    setStage("done");
    sfx.score();
  };

  return (
    <>
      <BackButton />
      <GameLayout>
        <header className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            <Trans id="duel.practice.title" message="Practice" />
          </h1>
          {best > 0 && (
            <p className="text-sm text-neutral-500 tabular-nums">
              <Trans id="duel.best" message="Best" /> {best} ms
            </p>
          )}
        </header>

        <button
          onPointerDown={tap}
          className={`flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-2xl text-center transition-colors duration-75 ${
            stage === "go"
              ? "bg-emerald-500 text-neutral-950"
              : stage === "arming"
                ? "bg-rose-900/70"
                : "bg-neutral-900"
          }`}
        >
          {stage === "lobby" && (
            <span className="px-6 text-lg font-semibold text-neutral-300">
              <Trans id="duel.practice.hint" message="Tap start, then wait for green." />
            </span>
          )}
          {stage === "arming" && (
            <span className="px-6 text-lg font-semibold text-rose-200">
              <Trans id="duel.wait" message="Wait for green…" />
            </span>
          )}
          {stage === "go" && (
            <span className="text-5xl font-black">
              <Trans id="duel.now" message="NOW" />
            </span>
          )}
          {stage === "done" && (
            <span className="px-6 text-3xl font-bold tabular-nums">
              {ms === FALSE_START ? (
                <span className="text-rose-300">
                  <Trans id="duel.youjumped" message="Too early!" />
                </span>
              ) : (
                `${ms} ms`
              )}
            </span>
          )}
        </button>

        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => {
              setMs(null);
              setStage("arming");
            }}
            disabled={stage === "arming" || stage === "go"}
            className="rounded-full bg-emerald-500 px-6 py-2.5 font-semibold text-neutral-900 hover:bg-emerald-400 disabled:opacity-40"
          >
            <Trans id="duel.start" message="Ready" />
          </button>
          <button
            onClick={onLeave}
            className="rounded-full px-4 py-2 text-sm text-neutral-400 hover:text-neutral-200"
          >
            <Trans id="duel.back" message="Back to pairing" />
          </button>
        </div>
      </GameLayout>
    </>
  );
}
