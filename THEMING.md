# Theme mechanics for distinct products

Read this to color an app at the token level: on a turn-1 build and when the user asks to
recolor, restyle, or retheme an existing app. The platform serves the current copy at
`/opt/appbuilder/templates/v1/THEMING.md`; an app-local copy is a stale snapshot.

Tokens support composition, not a finish pack. Choose surface contrast, radius and content typography together: crisp ruled evidence and tactile selectable objects need not share a treatment. Keep `--background`, `--card`, `--muted` and `--border` neutral; never tint them toward the primary hue. Keep Geist for UI; local `ui-serif` can give document/product content a voice, and `ui-monospace` serves code and identifiers. No font downloads: never add a CDN/webfont `@import` or `<link>` — the offline sandbox cannot fetch it, and tenant CSP may also block it.

## Preset table

An explicit requested hue wins. Otherwise, parse the first two hexadecimal characters of the stable UUID directory in `apps/<uuid>/` — never an `[app_N]` display alias — as one byte and choose the zero-indexed row at `byte modulo palette row count` (6); this is a hue fallback, never a layout or personality assignment. For an unlisted requested hue, use the closest preset for tokens and readable built-in Tailwind shades for the requested content accents. Paste values verbatim; never derive OKLCH by hand.

L/D/F are light primary, dark primary and dark primary-foreground. Light primary-foreground is `.99 0 0`. Wrap triplets in `oklch(...)`; set `--ring` to primary.

| # | Hue | L | D | F |
|---|---|---|---|---|
| 0 | Indigo | .47 .16 265 | .63 .16 265 | .15 .01 265 |
| 1 | Teal | .45 .07 195 | .64 .1 195 | .15 .01 195 |
| 2 | Steel | .42 .04 255 | .72 .05 255 | .15 .01 255 |
| 3 | Green | .45 .12 150 | .64 .13 150 | .15 .01 150 |
| 4 | Amber | .509 .11 70 | .76 .15 70 | .18 .03 70 |
| 5 | Rose | .42 .17 25 | .64 .17 25 | .15 .01 25 |

## How to theme

Edit existing token declarations in `src/index.css`: light values in `:root`, identical dark values in `.dark` and the OS-dark `@media (prefers-color-scheme: dark) { :root:not(.light) }` mirror (skipping the mirror leaves OS-dark users on the old theme). On a restyle of an existing app, first reset `--background`, `--card`, `--popover`, `--border`, `--input`, `--muted-foreground`, `--accent`, `--accent-foreground` and `--chart-2` to `--chart-5` in all three blocks to their values in `/opt/appbuilder/templates/v1/src/index.css`; existing apps may carry values tinted toward their previous hue. Set `--primary`, `--primary-foreground` and `--ring`; leave `--accent`/`--accent-foreground` on their scaffold neutrals (shadcn uses them for hover/selection surfaces). Keep scaffold neutral pairs as the base, not a ban on colored regions. Set `--radius` to suit the objects. Synchronize sidebar primary/foreground/ring with their main counterparts; keep hover/selection pairs readable on the actual sidebar. Set `--chart-1` to primary; retain other chart tokens unless data encoding needs them.

Use semantic tokens for adaptive surfaces and text. Colored fields need explicit foreground pairs: literal `-700/-800` fills with white text work for strong fields; never assume `text-foreground` suits an arbitrary hue. Use complete literal Tailwind classes, not dynamically assembled names.

Define one typed state-tone map, reused in badges and visual marks: green success/healthy, amber warning/pending, red failed/overdue, blue active/information, gray inactive. Every visible status, priority, severity, health or due-state value renders through it as a labeled tinted badge or dot, never plain text, identical outline pills or brand-colored states. Keep workflow and urgency separate; categories use their own stable key.

Text must reach 4.5:1 against its actual surface in both themes and all states; meaningful marks need 3:1. Chart text uses semantic tokens. When muted text fails, use `text-foreground` and hierarchy rather than fading it.
