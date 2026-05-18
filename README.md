# toto-victoto.github.io

A personal showcase site hosted on GitHub Pages, styled like a phone home screen. Each "app" icon either opens a self-contained mini-game (JS-only) or redirects to an external link (Instagram, LinkedIn, etc.) in a new tab.

## Stack

- **Vite** — build tool and dev server
- **React + TypeScript** — UI
- **React Router v7** (framework mode) with **prerendering** — routes are statically generated at build time, so the site works on GitHub Pages' static hosting while keeping SSR-like benefits (fast first paint, crawlable HTML)
- **Tailwind CSS** — styling, mobile-first
- **Lingui** — i18n (lightweight, type-safe, plays nicely with TS)

No backend: everything runs in the browser.

## Concept

- **Home screen** — a grid of icons, iOS springboard / Android home screen style.
- **Internal apps** — each icon opens a dedicated route hosting a mini-game (vanilla JS / React).
- **External apps** — some icons redirect to external URLs (socials, etc.) in a new tab.

## Deployment

Hosted on [GitHub Pages](https://pages.github.com/) from the `main` branch. Routes are prerendered to static HTML at build time.
