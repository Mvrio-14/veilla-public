# Veilla — frontend

Next.js 16 App Router. Reads the FastAPI backend; holds no business
logic of its own beyond what a screen needs to render.

> **Next.js 16 has breaking changes.** Read the relevant guide in
> `node_modules/next/dist/docs/` before writing code — the API surface
> has moved since 14, and the middleware is `proxy.ts`.

## Running it

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # Vitest
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```

Copy `.env.example` to `.env.local` and fill it in; each variable is
explained there.

## Routes

`app/page.tsx` is the public landing; everything under `app/(app)/` is
behind authentication, sharing one layout.

| Route | What it is |
|---|---|
| `/watch` | the main screen: sidebar, story list, detail panel |
| `/library` | bookmarked stories, outside the time window |
| `/library/[id]` | a folder |
| `/monitors` | what is fetched for the reader, and how each monitor is doing |
| `/signal/*` | agents, the reader's context, and the agents' decisions |
| `/settings/*` | profile, preferences, notifications |
| `/admin/*` | operator surface — sources and feeds, users, audit |
| `/login` | one email field; the magic link both signs in and signs up |

`proxy.ts` refreshes the Supabase session on every navigation.
Authorisation itself happens in server components and in the API.

## Conventions

**State follows the props during render, not after.** `lib/use-changed.ts`
adjusts state when a prop changes; `lib/use-hydrated.ts` answers "is the
browser available yet". Neither is optional styling — the `setState`-in-
effect lint rule is on, and the codebase has no suppressions.

**Dialogs mount their body only while open**, so a draft cannot survive
a close and there is no reset code to keep in step with the fields.

**Sidebar selection is exclusive.** View, scope and folder are mutually
exclusive; only the advanced filter dialog stacks on top, and only in
the "All" view.

**UI state lives in `sessionStorage`**, scoped per tab, mirrored into the
URL with `history.replaceState`.

**Every string goes through `next-intl`.** French and English, selected
by the `NEXT_LOCALE` cookie set at login from the user's content
language.

**Tailwind utilities and CVA only.** `globals.css` holds design tokens
and nothing else.

## Tests

Vitest with Testing Library, in jsdom. Test files sit next to what they
test. `test/render.tsx` wraps a component in the providers the app
always gives it, and `test/fixtures.ts` holds the shared payloads —
deliberately minimal, widened per test with a spread.

Nothing reaches the network: `next/navigation` is mocked globally in
`test/setup.ts`, and the API layer is mocked per file.
