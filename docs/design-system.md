# PulseNode design system ("Spectrum")

Light + dark + system themes, built on **shadcn/ui** (base-ui flavour) and **Tailwind 4**.
Tokens live in `app/theme.css`; the app shell is `components/AppShell.tsx`.

## Principles
1. **Colour has jobs.** Each app area owns one hue — monitor (teal), resource (blue), deploy (orange), security (violet).
   Green/amber/red are reserved for status and always come with text or an icon.
2. **Dense but readable.** Body text 14px (`text-sm`), labels 12px (`text-xs`), nothing under 11px.
   Numbers use `tabular-nums`; IDs, digests, commands, logs use `font-mono`.
3. **Summary first.** Page header → stat cards → toolbar → data. Actions live in the header or the row, never floating.
4. **Every list has four states:** loading (Skeleton), empty (EmptyState), error (Alert), populated.
5. **Keyboard + screen reader friendly.** Icon-only buttons need `aria-label`; inputs need a `Label`; focus rings stay visible.

## Hue per area
`AppShell` wraps page content in `data-area="monitor|resource|deploy|security|neutral"`, which sets `--hue` / `--hue-fg`.
Use it for accents: `text-[var(--hue)]`, `bg-[color-mix(in_srgb,var(--hue)_14%,transparent)]`, `border-[color-mix(in_srgb,var(--hue)_25%,var(--border))]`.
For *text* on a surface use `var(--hue-fg)` (contrast-safe in both themes).

## Tokens (Tailwind classes)
Surfaces `bg-background` `bg-card` `bg-muted` `bg-popover` · text `text-foreground` `text-muted-foreground` ·
borders `border` (default colour) `border-input` · primary `bg-primary text-primary-foreground` ·
status `text-success|warning|danger|info`, tints `bg-success/12` · chart colours `var(--chart-1..5)` ·
shadows `shadow-card` `shadow-pop` · radius `rounded-lg` (10px) `rounded-xl` `rounded-md`.
Legacy variables (`--acc`, `--bg-2`, `--fg-3`, `--ok`, `--bad` …) still resolve but are being removed — don't add new uses.
**No hard-coded hex/rgb colours in components.**

## Building blocks
| Need | Use |
|---|---|
| Page title band | `PageHeader` (`@/components/pn/PageHeader`) — `icon`, `title`, `description`, `actions`, `children` (tabs/filters) |
| Page content wrapper | `PageBody` (same file) — gutters, max width, vertical rhythm |
| Metric tile | `StatCard` (`@/components/dashboard/StatCard`) — tinted by area hue; `tone` ok/warn/bad/info for status |
| Status badge | `Pill` (`@/components/dashboard/Pill`) — tone ok/warn/bad/info/acc/outline, `dot` |
| Usage bar | `ProgressBar` (`@/components/dashboard/ProgressBar`) |
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
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{/* StatCards */}</div>
    {/* toolbar: SearchInput + Segmented + buttons, flex flex-wrap items-center gap-2 */}
    {/* data: Card > Table, with Skeleton / EmptyState / Alert states */}
  </PageBody>
</>
```
Pages that need a fixed header + scrolling body (e.g. project detail with a live log) use a `flex h-full min-h-0 flex-col` wrapper with the body `min-h-0 flex-1 overflow-auto`.

## Motion
Subtle only: 150–250ms transitions; use `motion-safe:` for animations; no entrance animations that hide content.
