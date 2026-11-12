# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
One admin per install: a developer or solo operator who runs PulseNode on their own Linux VPS. Technical, keyboard-friendly, scanning dense data. The app stays open most of the day as a "mission control" tab.

## Product Purpose
A self-hosted VPS control panel, roughly Portainer + Vercel + Uptime Kuma + Trivy in one dashboard: monitor the host live (CPU, RAM, disk, network, processes), manage Docker containers, images, networks and database containers, deploy apps from GitHub (push-to-deploy, build logs, rollback, domains), and review security (vulnerability scans, SBOMs, alerts, suspicious processes). Success: the operator sees the state of the box at a glance and acts on it without leaving the tab.

## Positioning
One self-hosted panel that covers monitoring, container management, git deploys and security scanning on the operator's own server, instead of four separate tools.

## Operating Context
Desktop-first, open all day beside an editor and terminal; still usable on tablet and phone. Live data refreshes every few seconds. Destructive actions (remove container, delete database, clear build cache) are frequent enough to need deliberate confirmation.

## Capabilities and Constraints
- Next.js (App Router) + React + TypeScript, Tailwind CSS 4, shadcn/ui (base-ui flavour), lucide-react icons, uPlot for time-series charts.
- Every page, data field and action in `docs/redesign-prompt.md` §4 must be kept.
- Light and dark themes through CSS variables with a toggle; dark is the default.
- Login and GitHub-callback pages are full-screen, without the app shell.

## Brand Commitments
- Name: PulseNode. Tagline: "Infrastructure at a glance."
- Logo: helmet mark plus "PulseNode" wordmark, dark and light variants (in `public/`).

## Evidence on Hand
Real live data from the host and Docker; no customer testimonials, benchmarks or pricing exist, and none may be invented.

## Product Principles
1. Summary first: the state of the box before the detail.
2. Dense but readable: the operator scans, so data density is a feature.
3. Destructive actions are deliberate and clearly identified.
4. Every list has loading, empty, error and populated states.

## Accessibility & Inclusion
Keyboard and screen-reader friendly: icon-only buttons have labels, inputs have labels, focus rings stay visible, status is never colour-only. Text-bearing colours meet 4.5:1 in both themes. Respect `prefers-reduced-motion`.
