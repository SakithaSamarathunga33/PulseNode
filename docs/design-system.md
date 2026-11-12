# PulseNode design system ("Graphite")

Dark-first graphite + one cobalt accent, light theme on paper-white, built on **shadcn/ui** (base-ui flavour) and **Tailwind 4**.
Tokens live in `app/theme.css`; the app shell is `components/AppShell.tsx`; product context in `PRODUCT.md`.

## Principles
1. **One accent.** `--primary` (cobalt) is the only brand colour: primary actions, focus, selection, active state, the live pulse.
   Area hues (`--hue`, set by `[data-area]`) only tint the active nav icon, the page-title icon and card-title icons.
   Green/amber/red are reserved for status and always come with text, an icon or a shape (`StatusDot`).
2. **Quiet surfaces, no glow.** Graphite layers (`bg-background` → `bg-card` → `bg-popover`), hairline borders, soft offset shadows
   (`shadow-card`, `shadow-pop`). No gradient text, no glowing borders, no photo headers.
3. **Dense but readable.** Body 14px (`text-sm`), labels 12–13px, nothing under 11px. Numbers use `tabular-nums`;
   IDs, digests, commands, logs use `font-mono`.
4. **Summary first.** Page title row → vitals / summary strip → charts → toolbar → data. Actions live in the header or the row.
5. **Every list has four states:** loading (Skeleton), empty (EmptyState), error (Alert), populated.
6. **Keyboard + screen reader friendly.** Icon-only buttons need `aria-label`; inputs need a `Label`; focus rings stay visible.

## Astryx rules (applied without the Astryx package)
- **Spacing:** 4px scale steps only — 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10. No `2.5`/`3.5`/`4.5`, no `p-[18px]`. Tight gaps inside an item (1–2), generous between sections (4–6).
- **Type:** `text-2xs` 11 · `text-xs` 12 · `text-ui` 13 · `text-sm` 14 · `text-base` 16 · `text-lg` 18 · `text-title` 22 · `text-metric` 28. No arbitrary `text-[Npx]`.
- **Colour of text:** foreground and muted-foreground only; no `/50` or `opacity-*` on content.
- **Structure:** one content line per region (container owns padding; tables bleed to the card edge); rows for dense data; weakest container that groups; one primary action per region; badges only for status.

## Tokens (Tailwind classes)
Surfaces `bg-background` `bg-card` `bg-muted` `bg-accent` (hover) `bg-popover` · text `text-foreground` `text-muted-foreground` ·
borders `border` (hairline) · stronger hairlines `border-[var(--border-2)]` / `--border-3` · primary `bg-primary text-primary-foreground` ·
status `text-success|warning|danger|info`, tints `bg-success/12` · charts `var(--chart-1..5)` · shadows `shadow-card` `shadow-pop` ·
overlay `bg-[var(--scrim)]` · radius `rounded-lg` (8px) `rounded-xl` `rounded-md`.
Text tokens are contrast-checked (≥ 4.5:1) in both themes and input borders ≥ 3:1 — re-check if you change one.
**No hard-coded hex/rgb colours in components.**

## Library components (user's DevAtlas)
| Need | Use |
|---|---|
| Card surface | `Card` (`ui/card`) or free-form `Panel` (`pn/Panel`) — no cursor-following lights |
| Page-level view switch (Resources / Uptime…) | `ViewNav` (`pn/ViewNav`) — React Bits GooeyNav |
| Filter / range / sort choice | `Segmented` (`pn/Segmented`) — interior.dev SegmentedControl |
| Live number that changes | `ValueFlash` (`interior/value-flash`) — neutral accent flash |
| Copy a value | `CopyButton` (`interior/copy-button`, pass `ariaLabel`) |
| Async button with in-place result | `LoadingButton` (`interior/loading-button`) — action must throw on failure |
| Usage gauge | `AnimatedCircularProgressBar` (`magicui/…`) |
| Count-up headline numbers | `CountUp` (`reactbits/CountUp`, already in `SummaryStrip`) |

## Charts — Bklit (`components/charts/*`, vendored via the shadcn registry `@bklit`)
- **Time series** (Stats, Networks): `TimeSeriesChart` (`@/components/dashboard/TimeSeriesChart`) — `series={[{ label, values, color }]}`, `unit`, `decimals`, `height`, `max` (pins the y-axis top, e.g. `max={100}` for percentages so 2% does not look like 90%). Wraps Bklit `AreaChart` + `Area` + `Grid` + `ChartTooltip`; the tooltip carries exact values.
- **Live stream**: Bklit `LiveLineChart` + `LiveLine` fed by `appendLive` (`@/lib/live-buffer`) — only in the Dashboard Network card (`HostHealth`). Stamp samples with `Date.now()` on arrival, not the server `ts`.
- **Bars / donuts**: Bklit `BarChart` + `Bar` (+ `BarXAxis`/`BarYAxis`, `Grid`, `ChartTooltip`; stacked or horizontal), `PieChart` + `PieSlice` (`showGlow={false}`) + `PieCenter`, sparklines `AreaSparkline` / `LineSparkline` / `BarSparkline`. Examples: `components/images/ImageCharts.tsx`, `components/alerts/AlertsChart.tsx`, `components/processes/CoreLoad.tsx`. Hide a chart from screen readers (`aria-hidden`) when the same numbers are visible as text; otherwise add a text summary.
- **Progress rings**: Bklit `RingChart` + `Ring` (`showGlow={false}`) + `RingCenter` — the Dashboard `Fleet` card (`components/containers/Fleet.tsx`).
- Chart colours come from `--chart-*` tokens mapped in `app/theme.css` (one block serves both themes). Add more items with
  `npx shadcn add @bklit/<name>`, then **restore `app/globals.css`** (the installer appends a `.dark` variant and its own palette
  that override ours) and decline overwriting `lib/utils.ts`. Do not install `@bklit/stat-card-*` (it overwrites `ui/card` and `ui/badge`).

## Building blocks
| Need | Use |
|---|---|
| Page title band | `PageHeader` (`@/components/pn/PageHeader`) — `icon`, `title`, `description`, `actions`, `children` (tabs/filters) |
| Page content wrapper | `PageBody` (same file) — gutters, max width, vertical rhythm |
| Metric tile | `SummaryStrip` for a row of headline numbers; the Dashboard vitals are `HostHealth` (capacity meter with 60/80% ticks) |
| Status badge | `Pill` (`@/components/dashboard/Pill`) — tone ok/warn/bad/info/acc/outline, `dot` |
| Usage bar | `ProgressBar` (`@/components/dashboard/ProgressBar`) — amber at 60%, red at 80% (matches `toneFor`) |
| Severity counts | `VulnBar` |
| Single-choice filter / range / sort | `Segmented` (`@/components/pn/Segmented`) |
| Search box | `SearchInput` (`@/components/pn/SearchInput`) |
| Empty list / no results | `EmptyState` (`@/components/pn/EmptyState`) |
| Destructive/risky confirm | `ConfirmDialog` (`@/components/pn/ConfirmDialog`) — replaces `window.confirm` |
| Live indicator | `LiveBadge` (`@/components/pn/LiveBadge`) |
| Toasts | `import { toast } from "sonner"` — `toast.success/error/info` — replaces `alert()` and ad-hoc toasts |
| Everything else | shadcn components in `@/components/ui/*` |

### shadcn (base-ui) usage notes — this is NOT the Radix API
- **No `asChild`.** Use `render`: `<Button render={<Link href="/x" />}>Open</Button>`, `<DropdownMenuTrigger render={<Button .../>}>`, `<TooltipTrigger render={<Button .../>}>`.
- **Button** variants `default | outline | secondary | ghost | destructive | link`; sizes `xs | sm | default | lg | icon | icon-xs | icon-sm | icon-lg`. Icon buttons: `<Button variant="ghost" size="icon-sm" aria-label="Restart">`.
- **Select**: `<Select value={v} onValueChange={(x) => setV(x as string)} items={[{ value: "a", label: "A" }]}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="a">A</SelectItem></SelectContent></Select>` — passing `items` makes `SelectValue` show labels.
- **Tabs**: `<Tabs value onValueChange><TabsList variant="line"><TabsTrigger value="x">…</TabsTrigger></TabsList><TabsContent value="x">…</TabsContent></Tabs>`. Use `variant="line"` for page tabs (put them in `PageHeader` children), default pill style for in-card tabs.
- **Dialog**: `<Dialog open onOpenChange><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle/><DialogDescription/></DialogHeader>…<DialogFooter>…</DialogFooter></DialogContent></Dialog>` (default width is small — set `sm:max-w-*`). **Sheet** (side drawer): `<SheetContent side="right" className="sm:max-w-xl">`.
- **Checkbox/Switch**: `checked` + `onCheckedChange(boolean)`. **Textarea/Input/Label**: standard (`<Label htmlFor>`).
- **Table**: `Table, TableHeader, TableBody, TableRow, TableHead, TableCell` inside a `Card` with `overflow-x-auto`; add `font-mono tabular-nums` on numeric cells, `text-right` on numeric columns; row actions = `Button size="icon-sm" variant="ghost"` with `aria-label` + tooltip.
- **Card**: `Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter`.
- **Skeleton** for loading rows/cards; **Alert** (`variant="destructive"`) for fetch errors.

## Page skeleton
```tsx
<>
  <PageHeader icon={Box} title="Runtime Monitor" description="…" actions={<>…</>}>
    {/* optional page tabs: <Tabs><TabsList variant="line">…</TabsList></Tabs> */}
  </PageHeader>
  <PageBody>
    <SummaryStrip items={[…]} />
    {/* toolbar: SearchInput + Segmented + buttons, flex flex-wrap items-center gap-2 */}
    {/* data: Card > Table, with Skeleton / EmptyState / Alert states */}
  </PageBody>
</>
```
Pages that need a fixed header + scrolling body (e.g. project detail with a live log) use a `flex h-full min-h-0 flex-col` wrapper with the body `min-h-0 flex-1 overflow-auto`.

## Motion
Subtle only: 150–300ms transitions with an ease-out curve; use `motion-safe:` for animations; no entrance animations that hide content.
The one signature move is the **pulse rail** — a short accent sweep along the top bar's bottom hairline on every live metrics frame.
Buttons press with `scale-[0.97]`; the login card carries a single slow Magic UI `BorderBeam`.
