---
version: 1
slug: "components-appshell-tsx"
primary_target: "components/AppShell.tsx"
related_targets: ["app/theme.css"]
---

# App shell + shared components (all dashboard routes)

Mode: Operate. Scope: tokens, shell (sidebar, top bar, mobile nav), shared components (components/ui, components/pn, components/dashboard), login. Pages inherit through them.
User-pinned direction: dark-first graphite + one accent (Linear/Vercel/Raycast register), keep shadcn and page structure, effects from saved libraries (Magic UI etc.). Guardrail from user: no neon / glow overload.

## Direction contract
THESIS: A quiet graphite instrument where the only thing that moves is live data. Refuses the category default of tinted hero bands, photo headers and glowing borders.
OWN-WORLD: Near-neutral graphite ground (#0a0a0c → #16161a surfaces), hairline borders, one cobalt accent (#6e8bff dark / #3a5be0 light) for selection, focus, primary action and the pulse. Area hues survive only on the active nav icon and page-title icon. Geist Sans UI, Geist Mono for numbers/IDs/logs. Light theme is the same system on paper-white.
STORY: The operator opens the tab, reads host state in one glance, and trusts the numbers are fresh because the shell visibly breathes with each metrics tick.
FIRST VIEWPORT: Sidebar (nav groups, live host CPU block) | top bar (breadcrumb, Ctrl K search, actions) with a 1px pulse rail under it | flat page title row (hued icon, 22px title, actions right) | summary strip / stat cards | dense table.
FORM: Pinned by user (graphite + one accent), not rolled. seed: none (unavailable). Signature move: the pulse rail, a short accent segment sweeping the top bar's bottom hairline on every live system:metrics frame.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
