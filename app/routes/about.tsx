import { Trans } from "@lingui/react";
import type { Route } from "./+types/about";
import { BackButton } from "../components/BackButton";

const REPO_URL = "https://github.com/toto-victoto/toto-victoto.github.io";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "About — toto-victoto" },
    { name: "description", content: "About this site and how it's built." },
  ];
}

export default function About() {
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
            </ul>
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
