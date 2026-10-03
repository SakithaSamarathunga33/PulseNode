# Contributing to PulseNode

Thanks for wanting to help! All contributions are welcome — bug reports, docs fixes, features, and ideas.

## Reporting bugs / requesting features

Use the [issue templates](https://github.com/SakithaSamarathunga33/PulseNode/issues/new/choose). For security vulnerabilities, **do not open a public issue** — see [SECURITY.md](SECURITY.md).

## Development setup

PulseNode is a Next.js 15 frontend (repo root) + Go backend (`backend/`), run together via Docker Compose behind Caddy.

**Prerequisites:** Docker 24+ with Compose v2, Node 22+, Go 1.25+.

```bash
git clone https://github.com/SakithaSamarathunga33/PulseNode.git
cd PulseNode
cp .env.example .env.local          # then edit values

# Run the full stack (recommended — matches production routing):
docker compose -f docker-compose.yml -f docker-compose.standalone.yml up -d --build

# Frontend only (hot reload):
npm install
npm run dev

# Backend only:
cd backend && go build ./... && go vet ./...
```

After changing Go code or a Dockerfile, rebuild just that service:

```bash
docker compose -f docker-compose.yml -f docker-compose.standalone.yml up -d --build go-api   # or: web
```

Note: the Go API needs `/var/run/docker.sock` and `pid: host`, so the metrics and Docker features only fully work inside the compose stack on Linux.

## Commit messages — they drive releases

CI auto-versions and publishes a release on every push to `main` based on the commit prefix:

| Prefix | Effect |
|--------|--------|
| `feat: ...` | minor bump (v1.1.0 → v1.2.0) |
| `fix: ...` / `chore: ...` / others | patch bump (v1.1.0 → v1.1.1) |
| `BREAKING CHANGE` in body | major bump (v1.x → v2.0.0) |

Please write commits as `type(scope): summary`, e.g. `fix(containers): handle null ports in list view`.

## CI and the release pipeline

Run the same checks locally before pushing:

```bash
cd backend && go vet ./... && go test -race -count=1 ./...   # api tests take a few minutes with -race
npm test && npx tsc --noEmit && npx next lint && NEXT_PUBLIC_GO_API=/go npm run build
```

**`.github/workflows/ci.yml`** runs on every pull request and on pushes to every branch except `main`:

- **backend** — `go vet`, `go test -race`, and `gofmt` on the Go files your change touches (legacy files that were never formatted only fail the check once you edit them: run `gofmt -w` on them).
- **govulncheck** — report-only, so a CVE with no upstream fix cannot block a merge.
- **frontend** — `npm ci`, unit tests (vitest, `tests/`), type check, lint, production build.
- **compose** — `docker compose config -q` for every overlay combination.
- **docker** — builds both images, boots the go-api image (no Docker socket) and checks `/health` and that the tools the builder needs are present, and boots the web image and checks `/login`.

**`.github/workflows/release.yml`** runs on every push to `main`, in this order, and stops at the first failure:

1. the full CI workflow above (a broken `main` never publishes);
2. compute the next version from the commit prefixes (a dry run — **no tag yet**);
3. build both images natively on amd64 and arm64 runners and push them by digest;
4. merge the digests into `:<version>` and `:latest` multi-arch tags;
5. Trivy scan of the published images (report-only — set `exit-code: '1'` in the workflow to make it blocking);
6. only then create the git tag and the GitHub release.

The tag/release appearing therefore means the matching images are already published, which is what the self-updater relies on. The images are `ghcr.io/sakithasamarathunga33/pulsenode-web` and `...-go-api`.

## Pull requests

1. Fork and create a branch from `main`.
2. Keep PRs focused — one change per PR.
3. Make sure the stack builds: `docker compose -f docker-compose.yml -f docker-compose.standalone.yml build` and `cd backend && go build ./...`.
4. Fill in the PR template — a screenshot or clip is very helpful for UI changes.

## Code style

- **Go:** standard `gofmt`; keep handlers in `backend/internal/api`, business logic in the relevant `internal/` package. Initialize JSON slices to non-nil empty slices (Go `nil` marshals to `null` and breaks the React client).
- **TypeScript/React:** match the existing shadcn/ui + Tailwind patterns in `components/` and `app/`.
- Match the surrounding code's style, naming, and comment density.
