# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo. Tool-agnostic
on purpose — it should make sense whether you use Claude Code, Copilot, Cursor,
or no assistant at all.

## What this is

A personal showcase site styled like a phone home screen. Each icon opens a
self-contained mini-game (internal route) or links out (external URL). No
backend — everything runs in the browser and is prerendered to static HTML for
GitHub Pages.

Stack: Vite + React 19 + TypeScript · React Router v7 (framework mode,
`ssr: false`, `prerender: true`) · Tailwind v4 · Lingui (i18n, locales: en, fr,
zh-CN; default `fr`).

## Commands

```bash
npm run dev         # dev server
npm run build       # static build (react-router build + postbuild 404 copy)
npm run typecheck   # react-router typegen && tsc — run this before committing
npm run i18n:extract / i18n:compile   # Lingui catalog tooling
```

Deploy is automatic: pushing to `main` triggers the GitHub Actions workflow that
builds and publishes to GitHub Pages.

## Repo identity (git author)

This repo uses a dedicated git identity that differs from the global one.
`.git/config` is never versioned, so it can't be committed — after cloning,
re-apply it once:

```bash
git config --local user.name "toto-victoto"
git config --local user.email "63426102+toto-victoto@users.noreply.github.com"
```

The account has GitHub's "block pushes that expose my email" protection on, so
commits must use the `…@users.noreply.github.com` address above or the push is
rejected (`GH007`). Alternatively, configure a global `includeIf "gitdir:…"`
rule so any repo under this directory adopts the identity automatically.

## Adding a new app

Every game follows the same shape. To add one named `foo`:

1. **Route file** — create `app/routes/foo.tsx`, default-exporting the
   component. Use the standard shell and helpers:
   ```tsx
   import { Trans } from "@lingui/react";
   import type { Route } from "./+types/foo";
   import { BackButton } from "../components/BackButton";

   export function meta({}: Route.MetaArgs) {
     return [{ title: "Foo — toto-victoto" }, { name: "description", content: "…" }];
   }

   export default function Foo() {
     return (
       <>
         <BackButton />
         <main className="min-h-dvh bg-neutral-950 text-neutral-100 p-6 pt-24 pb-12">
           {/* … */}
         </main>
       </>
     );
   }
   ```

2. **Register the route** in `app/routes.ts`:
   ```ts
   route("foo", "routes/foo.tsx"),
   ```

3. **Home tile** in `app/routes/home.tsx`:
   ```tsx
   <AppIcon
     to="/foo"
     label={<Trans id="foo.title" message="Foo" />}
     tone="bg-gradient-to-br from-… to-…"
   >
     <span aria-hidden="true">🎮</span>
   </AppIcon>
   ```
   For an **external** app use `href="https://…"` instead of `to=` — it opens in
   a new tab.

4. **Translations** — add every `foo.*` key to all three catalogs:
   `app/locales/{en,fr,zh-CN}/messages.po`. Keep them in sync manually.

5. **Optional animation** — add a keyframe in `app/app.css` inside the `@theme`
   block as `--animate-foo-x: …;` and use it via `animate-foo-x`.

6. Run `npm run typecheck`.

## Building a new app interactively (teaching mode)

When the maintainer asks to build a **new** mini-game step by step ("guide me"),
follow this loop for each step (palier), in order:

1. **Intro** — a short message: what the step builds and the key concepts.
2. **Quiz before editing** — multiple-choice questions derived from the intro
   but whose answers were *not* explicitly stated, so they require inference
   rather than recall. Vary which option is correct across questions. Keep the
   option explanations neutral — don't telegraph the answer in them. Prefer
   technical, code-level questions (state vs ref, data modeling, timing, edge
   cases), and include short code excerpts when useful.
3. **Edit** — only after the answers, write the code for that step.

This applies to the **initial build** only. Later tuning iterations (adjusting
gravity, sizes, colors, etc.) skip the intro/quiz — just make the change.

Commit the whole app as **one clean commit at the end** of the build — not
after each step.

## Conventions

- **i18n**: explicit-id mode (`explicitIdAsDefault`). The `id` prop is the
  catalog key; the `message` prop is the English source/fallback. Always provide
  both, and add the key to all three `.po` files.
- **Theme**: dark — `bg-neutral-950 text-neutral-100`. Mobile-first.
- **Game positioning**: express positions/sizes in % of the playfield so the
  game is resolution-independent and scales with its responsive container.
- **Game loops**: use `requestAnimationFrame` with a delta-time (`dt`) so motion
  is framerate-independent; clamp `dt` to guard against backgrounded tabs; cancel
  the loop in the effect cleanup. Keep per-frame physics values (velocity,
  timestamps, ids) in `useRef`; keep rendered values (position, score) in
  `useState`. Read fast-changing control state (e.g. current phase/direction)
  through a ref inside loops created with empty deps.
- **Input**: `onPointerDown` unifies mouse + touch; add `touch-none` to game
  surfaces to prevent scrolling/zoom during play.
- Do **not** commit generated Lingui artifacts (`app/locales/*/messages.js`).
