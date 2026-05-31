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
   component. Wrap everything in `GameLayout` (see "Layout" below):
   ```tsx
   import { Trans } from "@lingui/react";
   import type { Route } from "./+types/foo";
   import { BackButton } from "../components/BackButton";
   import { GameLayout } from "../components/GameLayout";

   export function meta({}: Route.MetaArgs) {
     return [{ title: "Foo — toto-victoto" }, { name: "description", content: "…" }];
   }

   export default function Foo() {
     return (
       <>
         <BackButton />
         <GameLayout>
           <header className="text-center">{/* … */}</header>
           <section>{/* score, status, etc. */}</section>
           <section className="flex-1 min-h-0">{/* playfield */}</section>
         </GameLayout>
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

5. **Persistence** — if the game has state worth keeping (score, balance,
   in-progress round), extend the `Persisted` type in `app/storage.ts` with a
   `foo` slot and use `useStoredGame("foo", defaults)` (or `loadGame`/`saveGame`
   manually for shapes that don't map 1-for-1 to component state — see roulette
   and ultimate). Bump `SCHEMA_VERSION` if you change the on-disk shape of an
   existing slot incompatibly; older blobs are then discarded silently.

6. **Optional animation** — add a keyframe in `app/app.css` inside the `@theme`
   block as `--animate-foo-x: …;` and use it via `animate-foo-x`.

7. Run `npm run typecheck`.

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

## Layout

Every game shares the same chrome via `app/components/GameLayout.tsx`:

- `<main>` is `h-dvh flex flex-col overflow-hidden` — the page is pinned to the
  dynamic viewport height. **No scrollbar ever appears**, so the fixed
  `LanguageSelector` at `top-right` can't jiggle horizontally when something
  inside the page causes a sub-pixel layout shift (the wheel rotation in
  roulette used to do exactly this).
- Edge-to-edge on phones (`px-3 pt-14 pb-2`) and capped at `max-w-md` on bigger
  screens.
- The inner column is `flex-1 min-h-0 flex flex-col gap-2`. Sections you put
  inside stack vertically; whichever holds the playfield should be marked
  `flex-1 min-h-0` so it absorbs the leftover height.

Because of the constraint above, each playfield uses relative sizing:

- **Cells in a fixed grid (snake, ultimate)** — wrap the grid in
  `<section className="flex flex-1 min-h-0 items-center justify-center">` and
  use `aspect-square` both on the grid container *and* on each cell. The
  container gives the largest square that fits the remaining area; the per-cell
  `aspect-square` is the belt-and-suspenders so individual cells stay square
  even when the container's aspect drifts due to gap rounding.
- **Variable-aspect playfield (flappy)** — same wrapper, with the inner box at
  `aspect-[3/4] h-full max-w-full` so the playfield is the largest 3:4 portrait
  rectangle that fits both axes.
- **Mixed grid (roulette)** — the board itself is `flex flex-1 flex-col`; the
  numbers grid splits its rows with `grid-rows-12` (cells without `h-X`); the
  rotating wheel overlay carries `max-h-[92%]` so it can't overflow a short
  board.

When a displayed value can change digit count (e.g. roulette balance crossing
`99 → 100`, or the wheel's central readout flipping between 1- and 2-digit
pockets), reserve the wider slot with `min-w-[3ch]` (or pad to 2 chars) so the
intrinsic width is stable. The sub-pixel reflow from a width change inside
`place-items-center` is one of the things that used to retrigger the scrollbar
issue.

## Persistence

`app/storage.ts` holds a single localStorage blob (`tv:state`) keyed by game.
A top-level `schema: 1` lets you invalidate older shapes by bumping the version
— older blobs are discarded silently on read instead of fed into the wrong
slot. Reads and writes are SSR-safe (guarded by `typeof window`) and survive
Safari private mode / quota errors via try/catch.

Three entry points:

- `loadGame(game, defaults)` — low-level read with a shallow merge over
  defaults so fields added later don't break older saves.
- `saveGame(game, state)` — low-level write.
- `useStoredGame(game, defaults)` — hook for the common case where component
  state maps 1-for-1 to the persisted shape. Initial render returns
  `defaults` (keeps the prerendered HTML stable); the first effect hydrates,
  then every state change writes back.

For games whose persisted shape doesn't match component state one-for-one
(roulette derives the saved balance as `balance + wagered` so an in-play
refresh refunds the wager), skip the hook and do hydration + save effects
by hand.

## Conventions

- **i18n**: explicit-id mode (`explicitIdAsDefault`). The `id` prop is the
  catalog key; the `message` prop is the English source/fallback. Always provide
  both, and add the key to all three `.po` files. For strings that are identical
  across games (e.g. `common.best`, `common.play_again`, `common.reset`), reuse
  a shared `common.*` id rather than a per-game key — the catalog is flat, so
  one entry serves every game.
- **Page titles**: keep `meta()` titles hardcoded (brand-style, e.g.
  "Snake — toto-victoto"). Don't translate them via Lingui: `meta()` returns
  descriptors (no `<Trans>`), and prerender would bake the default locale only.
- **Theme**: dark — `bg-neutral-950 text-neutral-100`. Mobile-first.
- **Game positioning**: express positions/sizes in % of the playfield so the
  game is resolution-independent and scales with its responsive container.
  Avoid pixel sizes for cells and paddings — prefer `aspect-*`, `flex-1`,
  `grid-rows-N`, `vmin`, etc.
- **Game loops**: use `requestAnimationFrame` with a delta-time (`dt`) so motion
  is framerate-independent; clamp `dt` to guard against backgrounded tabs; cancel
  the loop in the effect cleanup. Keep per-frame physics values (velocity,
  timestamps, ids) in `useRef`; keep rendered values (position, score) in
  `useState`. Read fast-changing control state (e.g. current phase/direction)
  through a ref inside loops created with empty deps. If a value would update
  every frame purely for display (e.g. the roulette wheel's live readout),
  mutate the DOM through a ref instead of going through React state — that
  avoids reconciling the whole component 60 times a second.
- **Input**: `onPointerDown` unifies mouse + touch; add `touch-none` to game
  surfaces to prevent scrolling/zoom during play.
- Do **not** commit generated Lingui artifacts (`app/locales/*/messages.js`).
