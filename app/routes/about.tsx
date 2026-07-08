import { useEffect, useState } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/about";
import { BackButton } from "../components/BackButton";
import { clearGame, peekGame } from "../storage";
import { GAMES } from "../games";

const REPO_URL = "https://github.com/toto-victoto/toto-victoto.github.io";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "About — toto-victoto" },
    { name: "description", content: "About this site and how it's built." },
  ];
}

// Headline stat per game, read straight from saved state (client-only).
function readRecords(): Record<string, string> {
  const u = peekGame("ultimate")?.scores;
  const rps = peekGame("rps");
  return {
    snake: String(peekGame("snake")?.best ?? 0),
    flappy: String(peekGame("flappy")?.best ?? 0),
    threader: String(peekGame("threader")?.best ?? 0),
    trias: String(peekGame("trias")?.best ?? 0),
    roulette: String(peekGame("roulette")?.best ?? 0),
    rps: rps?.infiniteBest
      ? `Lv ${rps.bestLevel ?? 0} · ♾️${rps.infiniteBest}`
      : `Lv ${rps?.bestLevel ?? 0}`,
    ultimate: `${u?.X ?? 0} · ${u?.O ?? 0} · ${u?.draws ?? 0}`,
  };
}

export default function About() {
  // null until the client reads localStorage, so the prerendered HTML is stable.
  const [records, setRecords] = useState<Record<string, string> | null>(null);
  // Which game's reset is currently "armed" (waiting for a confirming 2nd tap).
  const [confirmKey, setConfirmKey] = useState<string | null>(null);

  useEffect(() => {
    setRecords(readRecords());
  }, []);

  // A first tap arms a row's reset; it disarms itself after a beat.
  useEffect(() => {
    if (!confirmKey) return;
    const t = setTimeout(() => setConfirmKey(null), 3000);
    return () => clearTimeout(t);
  }, [confirmKey]);

  const onReset = (key: string) => {
    if (confirmKey !== key) {
      setConfirmKey(key);
      return;
    }
    clearGame(key);
    setRecords(readRecords());
    setConfirmKey(null);
  };

  // Same order as the home grid — both come from GAMES.
  const games = GAMES.map((g) => ({
    key: g.slug,
    label: <Trans id={g.titleId} message={g.title} />,
  }));

  return (
    <>
      <BackButton />
      <main className="min-h-dvh bg-neutral-950 text-neutral-100 p-6 pt-24 pb-12">
        <article className="max-w-prose mx-auto space-y-10">
          <header>
            <h1 className="text-3xl font-semibold tracking-tight">
              <Trans id="about.title" message="About" />
            </h1>
          </header>

          <section>
            <h2 className="text-lg font-medium mb-3 text-neutral-300">
              <Trans id="about.section.built_with" message="Built with" />
            </h2>
            <ul className="text-neutral-400 space-y-1 list-disc pl-5">
              <li>Vite + React + TypeScript</li>
              <li>React Router v7 (framework mode, static prerendering)</li>
              <li>Tailwind CSS</li>
              <li>Lingui (i18n)</li>
              <li>GitHub Pages + GitHub Actions</li>
              <li>
                <Trans
                  id="about.built.claude"
                  message="Co-authored with Claude (Anthropic)"
                />
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3 text-neutral-300">
              <Trans id="about.section.records" message="Records" />
            </h2>
            <table className="w-full text-sm">
              <tbody>
                {games.map((g) => (
                  <tr
                    key={g.key}
                    className="border-b border-neutral-800/70 last:border-0"
                  >
                    <td className="py-2 text-neutral-400">{g.label}</td>
                    <td className="py-2 text-right font-bold tabular-nums text-neutral-100">
                      {records ? records[g.key] : "—"}
                    </td>
                    <td className="py-2 pl-4 text-right">
                      <button
                        type="button"
                        onClick={() => onReset(g.key)}
                        className={`rounded-full px-3 py-1 text-xs font-medium transition active:scale-95 ${
                          confirmKey === g.key
                            ? "bg-rose-500 text-neutral-950 hover:bg-rose-400"
                            : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
                        }`}
                      >
                        {confirmKey === g.key ? (
                          <Trans id="about.records.confirm" message="Confirm" />
                        ) : (
                          <Trans id="about.records.reset" message="Reset" />
                        )}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3 text-neutral-300">
              <Trans id="about.section.source" message="Source code" />
            </h2>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-400 hover:underline break-all"
            >
              {REPO_URL.replace("https://", "")}
            </a>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3 text-neutral-300">
              <Trans id="about.section.legal" message="Legal" />
            </h2>
            <p className="text-neutral-400 text-sm leading-relaxed">
              <Trans
                id="about.legal.body"
                message="Personal non-commercial site published by toto-victoto. Hosted by GitHub, Inc. (88 Colin P Kelly Jr St, San Francisco, CA 94107, USA). No analytics, no cookies, no third-party tracking."
              />
            </p>
          </section>
        </article>
      </main>
    </>
  );
}
