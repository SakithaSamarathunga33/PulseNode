package builder

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// LogFunc is called for each output line from the build process.
type LogFunc func(stream, line string)

// Config holds all information needed to run one deployment.
type Config struct {
	DeploymentID string
	ProjectID    string
	ProjectName  string
	RepoURL      string // plain clone URL — never embed credentials (argv, logs and .git/config leak them)
	GitToken     string // optional token for private repos, passed to git via env
	Branch       string
	Method       Method // auto | compose | dockerfile | nixpacks
	BuildCommand string // optional override
	Port         int
	Domain       string
	EnvVars      string // JSON {"KEY":"VALUE"} — frontend/single-service env
	BackendEnvVars string // JSON {"KEY":"VALUE"} — monorepo backend env (ignored for single-service)
	BaseDir      string // "" | "frontend" | "backend" — subfolder to build from when this project is one component of a monorepo deployed separately. Skips monorepo auto-split.
	TraefikNet   string
	PrevContainerID string // previous running container, removed after the new one is healthy
	Log          LogFunc
}

// Result is the outcome of a successful build.
type Result struct {
	ContainerID string
	CommitSHA   string // full SHA of the built commit
	CommitMsg   string // first line of the commit message
	ImageTag    string // docker image:tag produced (empty for compose); enables rollback
}

// healthTimeout is how long a new container has to become healthy before the
// deploy is considered failed and rolled back. stableWindow is how long a
// container without its own HEALTHCHECK must stay up to be deemed healthy.
const (
	healthTimeout = 90 * time.Second
	stableWindow  = 6 * time.Second
)

// Run clones the repo, builds, and starts the container.
// Returns the running container and the commit that was built.
func Run(ctx context.Context, cfg Config) (Result, error) {
	tmpDir, err := os.MkdirTemp("", "pn-build-*")
	if err != nil {
		return Result{}, fmt.Errorf("mktemp: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	cfg.log("system", "=== PulseNode Build Started ===")
	cfg.log("system", fmt.Sprintf("Repo: %s  Branch: %s", cfg.RepoURL, cfg.Branch))

	// 1. Clone
	cfg.log("system", "→ Cloning repository…")
	// Only http(s) transports, and `--` so a URL can't be parsed as an option.
	if err := cfg.runEnv(ctx, tmpDir, gitAuthEnv(cfg.RepoURL, cfg.GitToken), "git",
		"-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.http.allow=always",
		"clone", "--depth", "1", "--branch", cfg.Branch, "--", cfg.RepoURL, "."); err != nil {
		return Result{}, fmt.Errorf("clone: %w", err)
	}

	// Capture the commit that was actually checked out.
	commitSHA, commitMsg := CommitInfo(tmpDir)
	if commitSHA != "" {
		cfg.log("system", fmt.Sprintf("→ Building commit %s — %s", shortSHA(commitSHA), commitMsg))
	}

	// 2. Parse env vars
	envMap, err := parseEnvVars(cfg.EnvVars)
	if err != nil {
		return Result{}, err
	}

	slug := sanitizeName(cfg.ProjectName)
	// Tag the image per-deploy (pn-<slug>:<shortSHA>) so a previous image stays
	// available for rollback instead of being overwritten each build.
	verTag := shortSHA(commitSHA)
	if verTag == "" {
		verTag = shortID(cfg.DeploymentID)
	}
	imageRef := fmt.Sprintf("pn-%s:%s", slug, verTag)

	// buildDir is the repo root, unless this project is one component of a
	// monorepo deployed as its own separate project (BaseDir set), in which case
	// it's the component's subfolder — and monorepo auto-split below is skipped
	// since the split decision was already made explicitly at project creation.
	buildDir := tmpDir
	if cfg.BaseDir != "" {
		buildDir = filepath.Join(tmpDir, cfg.BaseDir)
		cfg.log("system", fmt.Sprintf("→ Building from %s/ (deployed as a separate project)", cfg.BaseDir))
	}

	// 3. Detect method if auto. A frontend/ + backend/ monorepo is deployed as
	// two services on one domain (frontend at /, backend at /api). An explicit
	// build method (set by the user) is always respected and never split.
	method := cfg.Method
	if method == "auto" || method == "" {
		if cfg.BaseDir == "" {
			if feDir, beDir, ok := DetectMonorepo(tmpDir); ok {
				cfg.log("system", "→ Detected a frontend/ + backend/ monorepo — deploying two services on one domain")
				// Backend gets its own env (kept separate from the frontend's), so
				// backend secrets never land in the frontend container.
				beEnvMap, err := parseEnvVars(cfg.BackendEnvVars)
				if err != nil {
					return Result{}, fmt.Errorf("backend env: %w", err)
				}
				res, err := cfg.runMonorepo(ctx, slug, verTag, envMap, beEnvMap, feDir, beDir)
				if err != nil {
					return Result{}, err
				}
				res.CommitSHA, res.CommitMsg = commitSHA, commitMsg
				return res, nil
			}
		}
		method = Detect(buildDir)
		cfg.log("system", fmt.Sprintf("→ Auto-detected build method: %s", method))
	} else {
		cfg.log("system", fmt.Sprintf("→ Build method: %s", method))
	}

	// 4. Build & run
	res := Result{CommitSHA: commitSHA, CommitMsg: commitMsg}
	switch method {
	case MethodCompose:
		// Compose manages its own images/services; no single image to tag or roll back.
		res.ContainerID, err = cfg.buildCompose(ctx, buildDir, fmt.Sprintf("pn-%s", slug), envMap)
	case MethodDockerfile:
		res.ContainerID, err = cfg.buildDockerfile(ctx, buildDir, imageRef, slug, envMap)
		res.ImageTag = imageRef
	case MethodNixpacks:
		res.ContainerID, err = cfg.buildNixpacks(ctx, buildDir, imageRef, slug, envMap)
		res.ImageTag = imageRef
	default:
		return Result{}, fmt.Errorf("unknown build method: %s", method)
	}
	if err != nil {
		return Result{}, err
	}

	cfg.log("system", fmt.Sprintf("✓ Container healthy: %s", res.ContainerID[:min(12, len(res.ContainerID))]))
	cfg.log("system", fmt.Sprintf("✓ Live at https://%s", cfg.Domain))
	return res, nil
}

// RunFromImage redeploys a previously-built image (rollback) without cloning or
// rebuilding. The image must still exist locally. It uses the same zero-downtime
// swap + health gate as a normal deploy.
func RunFromImage(ctx context.Context, cfg Config, imageRef string) (Result, error) {
	cfg.log("system", "=== PulseNode Rollback Started ===")
	cfg.log("system", "→ Redeploying image "+imageRef)
	if err := runSilent(ctx, "docker", "image", "inspect", imageRef); err != nil {
		return Result{}, fmt.Errorf("image %s is no longer available locally (it may have been pruned)", imageRef)
	}
	envMap, err := parseEnvVars(cfg.EnvVars)
	if err != nil {
		return Result{}, err
	}
	cid, err := cfg.deployContainer(ctx, imageRef, sanitizeName(cfg.ProjectName), envMap)
	if err != nil {
		return Result{}, err
	}
	cfg.log("system", fmt.Sprintf("✓ Rolled back. Live at https://%s", cfg.Domain))
	return Result{ContainerID: cid, ImageTag: imageRef}, nil
}

// shortID returns the trailing 8 chars of a deployment id (after the prefix).
func shortID(id string) string {
	if i := strings.LastIndex(id, "_"); i >= 0 && i+1 < len(id) {
		id = id[i+1:]
	}
	if len(id) > 8 {
		return id[len(id)-8:]
	}
	return id
}

// shortSHA returns the first 7 characters of a commit SHA.
func shortSHA(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

func (cfg Config) buildCompose(ctx context.Context, dir, containerName string, envMap map[string]string) (string, error) {
	// Write overlay with Traefik labels for the first service
	cfg.log("system", "→ Writing Traefik labels overlay…")
	traefikNet := cfg.resolveTraefikNetwork(ctx)
	if traefikNet == "" {
		return "", fmt.Errorf("TRAEFIK_NETWORK is not configured and no Traefik Docker network could be detected")
	}
	overlay := cfg.composeOverlay(traefikNet)
	if err := os.WriteFile(filepath.Join(dir, "docker-compose.pulsenode.yml"), []byte(overlay), 0o644); err != nil {
		return "", err
	}

	// Write .env for compose
	if _, ok := envMap["PORT"]; !ok {
		envMap["PORT"] = fmt.Sprintf("%d", cfg.Port)
	}
	if err := validateEnvMap(envMap); err != nil {
		return "", err
	}
	if len(envMap) > 0 {
		cfg.log("system", "→ Writing .env file…")
		var sb strings.Builder
		for k, v := range envMap {
			fmt.Fprintf(&sb, "%s=%s\n", k, v)
		}
		if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(sb.String()), 0o600); err != nil {
			return "", err
		}
	}

	// One compose file, one project name, used for the policy check AND for up/ps,
	// so what was validated is exactly what runs.
	file := composeFileName(dir)
	if file == "" {
		return "", fmt.Errorf("no docker-compose.yml found")
	}
	project := composeProject(cfg.ProjectID)

	// After .env is written, so ${VAR:?required} interpolation resolves.
	cfg.log("system", fmt.Sprintf("→ Checking %s…", file))
	configJSON, err := cfg.checkComposePolicy(ctx, dir, file, project)
	if err != nil {
		return "", err
	}

	// Same protections single-container deploys get, applied through a generated
	// override merged last (never read from the repo). Only fills in what the
	// service did not set itself.
	files := []string{"-f", file, "-f", "docker-compose.pulsenode.yml"}
	hardening, err := composeHardeningOverlay([]byte(configJSON))
	if err != nil {
		return "", err
	}
	if hardening != nil {
		if err := os.WriteFile(filepath.Join(dir, composeHardeningFile), hardening, 0o644); err != nil {
			return "", err
		}
		files = append(files, "-f", composeHardeningFile)
		cfg.log("system", "→ Applying resource limits, dropped capabilities and log rotation to services that don't set their own")
	}
	compose := func(sub ...string) []string {
		args := append([]string{"compose", "-p", project}, files...)
		return append(args, sub...)
	}

	cfg.log("system", "→ Building and starting containers…")
	if err := cfg.run(ctx, dir, "docker", compose("up", "-d", "--build")...); err != nil {
		return "", fmt.Errorf("compose up: %w", err)
	}
	cfg.removeStaleComposeContainers(ctx, project)

	// Get first running container name from compose project
	out, err := runOutput(ctx, dir, "docker", compose("ps", "-q")...)
	if err != nil || strings.TrimSpace(out) == "" {
		return "compose-unknown", nil
	}
	ids := strings.Fields(strings.TrimSpace(out))
	return ids[0][:min(12, len(ids[0]))], nil
}

// composeProject is the fixed compose project name for a project's deployments.
// Before this, the name came from the (random) temp clone directory, so every
// deploy was a brand-new compose project and old containers were never replaced.
func composeProject(projectID string) string {
	return "pn-" + sanitizeName(projectID)
}

// removeStaleComposeContainers removes containers that still carry this project's
// Traefik router label but belong to a different compose project (or none) — the
// leftovers of earlier deploys that used a per-deploy project name. Old and new
// share identical routing labels, so a leftover would keep taking traffic.
func (cfg Config) removeStaleComposeContainers(ctx context.Context, project string) {
	out, _ := runOutput(ctx, "", "docker", "ps", "-aq", "--filter",
		"label=traefik.http.routers.pn-"+cfg.ProjectID+".entrypoints")
	for _, id := range strings.Fields(out) {
		owner, err := runOutput(ctx, "", "docker", "inspect", "-f", `{{index .Config.Labels "com.docker.compose.project"}}`, id)
		if err != nil || strings.TrimSpace(owner) == project {
			continue
		}
		cfg.log("system", "→ Removing a container left over from a previous deploy")
		_ = runSilent(ctx, "docker", "rm", "-f", id)
	}
}

func (cfg Config) buildDockerfile(ctx context.Context, dir, imageRef, slug string, envMap map[string]string) (string, error) {
	cfg.log("system", "→ Building Docker image…")
	if err := cfg.run(ctx, dir, "docker", "build", "-t", imageRef, "."); err != nil {
		return "", fmt.Errorf("docker build: %w", err)
	}
	return cfg.deployContainer(ctx, imageRef, slug, envMap)
}

// defaultNodeVersion is injected for Node projects that don't pin their own
// version. Nixpacks otherwise defaults to Node 18, which is too old for modern
// frameworks (e.g. Next.js 16 requires Node >= 20.9.0).
const defaultNodeVersion = "20"

func (cfg Config) buildNixpacks(ctx context.Context, dir, imageRef, slug string, envMap map[string]string) (string, error) {
	cfg.log("system", "→ Building with Nixpacks (this may take a few minutes)…")
	args := []string{"build", dir, "--name", imageRef}
	// NIXPACKS_NODE_VERSION overrides engines.node/.nvmrc, so only inject a
	// default when the project hasn't pinned a version itself.
	if isNodeProject(dir) && !pinsNodeVersion(dir) {
		cfg.log("system", fmt.Sprintf("→ No Node version pinned; defaulting to Node %s", defaultNodeVersion))
		args = append(args, "--env", "NIXPACKS_NODE_VERSION="+defaultNodeVersion)
	}
	if err := cfg.run(ctx, dir, "nixpacks", args...); err != nil {
		return "", fmt.Errorf("nixpacks build: %w", err)
	}
	return cfg.deployContainer(ctx, imageRef, slug, envMap)
}

// isNodeProject reports whether the build directory contains a package.json.
func isNodeProject(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "package.json"))
	return err == nil
}

// pinsNodeVersion reports whether the project declares a Node version via
// package.json "engines.node" or a .nvmrc file.
func pinsNodeVersion(dir string) bool {
	if _, err := os.Stat(filepath.Join(dir, ".nvmrc")); err == nil {
		return true
	}
	data, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return false
	}
	var pkg struct {
		Engines struct {
			Node string `json:"node"`
		} `json:"engines"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return false
	}
	return strings.TrimSpace(pkg.Engines.Node) != ""
}

// serviceSpec describes one Traefik-routed service. A single-service deploy uses
// the default spec (component ""); a frontend/ + backend/ monorepo uses one spec
// per component so each gets its own router/service labels and is swapped
// independently.
type serviceSpec struct {
	component  string // "" single-service | "frontend" | "backend"
	routerName string // Traefik router/service key, e.g. "pn-<id>" or "pn-<id>-api"
	rule       string // Traefik rule, e.g. Host(`d`) or Host(`d`) && PathPrefix(`/api`)
	priority   int    // Traefik router priority (0 = default/by rule length)
	port       int    // port the container listens on / Traefik forwards to
}

// defaultSpec is the single-service layout: the whole app on the domain root.
func (cfg Config) defaultSpec() serviceSpec {
	return serviceSpec{
		routerName: "pn-" + cfg.ProjectID,
		rule:       fmt.Sprintf("Host(`%s`)", cfg.Domain),
		port:       cfg.Port,
	}
}

// frontendSpec serves the domain root.
func (cfg Config) frontendSpec() serviceSpec {
	return serviceSpec{
		component:  "frontend",
		routerName: "pn-" + cfg.ProjectID,
		rule:       fmt.Sprintf("Host(`%s`)", cfg.Domain),
		port:       cfg.Port,
	}
}

// backendSpec serves /api on the same domain (higher priority than the root
// router so /api wins). Its listen port comes from the BACKEND_PORT env var, or
// the project port if unset.
func (cfg Config) backendSpec(envMap map[string]string) serviceSpec {
	port := cfg.Port
	if v := strings.TrimSpace(envMap["BACKEND_PORT"]); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			port = n
		}
	}
	return serviceSpec{
		component:  "backend",
		routerName: "pn-" + cfg.ProjectID + "-api",
		rule:       fmt.Sprintf("Host(`%s`) && PathPrefix(`/api`)", cfg.Domain),
		priority:   100,
		port:       port,
	}
}

// deployContainer deploys the project as a single service on the domain root.
func (cfg Config) deployContainer(ctx context.Context, imageRef, slug string, envMap map[string]string) (string, error) {
	return cfg.deployService(ctx, imageRef, slug, envMap, cfg.defaultSpec())
}

// deployService starts a NEW container from imageRef under a unique name with
// the given Traefik routing spec, waits for it to become healthy, and only then
// removes the previous container(s) for that service — so a failed deploy never
// takes down the running version (zero-downtime). Old and new carry identical
// router/service labels, so Traefik load-balances across them during the overlap.
func (cfg Config) deployService(ctx context.Context, imageRef, slug string, envMap map[string]string, spec serviceSpec) (string, error) {
	id := cfg.ProjectID
	port := fmt.Sprintf("%d", spec.port)
	traefikNet := cfg.resolveTraefikNetwork(ctx)
	if traefikNet == "" {
		return "", fmt.Errorf("TRAEFIK_NETWORK is not configured and no Traefik Docker network could be detected")
	}

	if err := validateEnvMap(envMap); err != nil {
		return "", err
	}

	namePrefix := "pn-" + slug
	if spec.component != "" {
		namePrefix += "-" + spec.component
	}
	newName := fmt.Sprintf("%s-%d", namePrefix, time.Now().Unix())

	args := []string{"run", "-d", "--name", newName, "--restart", "unless-stopped", "--network", traefikNet}
	args = append(args, appHardeningArgs()...)
	args = append(args,
		"--label", "traefik.enable=true",
		"--label", fmt.Sprintf("pulsenode.project=%s", id),
	)
	if spec.component != "" {
		args = append(args, "--label", fmt.Sprintf("pulsenode.component=%s", spec.component))
	}
	args = append(args,
		"--label", fmt.Sprintf("traefik.http.routers.%s.rule=%s", spec.routerName, spec.rule),
		"--label", fmt.Sprintf("traefik.http.routers.%s.entrypoints=websecure", spec.routerName),
		"--label", fmt.Sprintf("traefik.http.routers.%s.tls.certresolver=letsencrypt", spec.routerName),
		"--label", fmt.Sprintf("traefik.http.services.%s.loadbalancer.server.port=%s", spec.routerName, port),
		"--label", fmt.Sprintf("traefik.docker.network=%s", traefikNet),
	)
	if spec.priority > 0 {
		args = append(args, "--label", fmt.Sprintf("traefik.http.routers.%s.priority=%d", spec.routerName, spec.priority))
	}

	// Inject PORT. For a monorepo component the per-service port is authoritative
	// (Traefik forwards to spec.port), so it overrides any shared PORT env;
	// single-service keeps honoring a user-provided PORT.
	forcePort := spec.component != ""
	if _, ok := envMap["PORT"]; forcePort || !ok {
		args = append(args, "-e", "PORT="+port)
	}
	for k, v := range envMap {
		if k == "PORT" && forcePort {
			continue
		}
		args = append(args, "-e", fmt.Sprintf("%s=%s", k, v))
	}
	args = append(args, imageRef)

	cfg.log("system", "→ Starting new container…")
	out, err := runOutput(ctx, "", "docker", args...)
	if err != nil {
		_ = runSilent(ctx, "docker", "rm", "-f", newName)
		return "", fmt.Errorf("docker run: %w", err)
	}
	cid := strings.TrimSpace(out)
	if len(cid) > 12 {
		cid = cid[:12]
	}

	// Health gate — keep the old version serving until the new one is proven healthy.
	cfg.log("system", "→ Waiting for the new container to become healthy…")
	if err := cfg.waitHealthy(ctx, newName); err != nil {
		cfg.log("system", "✕ New container failed its health check — keeping the previous version running")
		_ = runSilent(ctx, "docker", "rm", "-f", newName)
		return "", fmt.Errorf("health check failed: %w", err)
	}
	cfg.log("system", "✓ New container is healthy — switching traffic over")

	cfg.removeOldContainers(ctx, id, spec.component, cid)
	return cid, nil
}

// appCaps are the only capabilities a deployed app keeps. Docker's default set
// minus the ones almost nothing needs (raw sockets, mknod, audit, setfcap…):
// enough for nginx/postgres/node images to drop privileges and bind low ports.
var appCaps = []string{"CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID", "NET_BIND_SERVICE", "KILL"}

// envLimit returns an env override for a resource limit, or def. "0" or
// "unlimited" turns the limit off (returns "").
func envLimit(key, def string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		v = def
	}
	if v == "0" || strings.EqualFold(v, "unlimited") {
		return ""
	}
	return v
}

// appHardeningArgs are the `docker run` flags every deployed app gets: no extra
// privileges, a minimal capability set, memory/CPU/pids ceilings so one app can't
// starve the host or its neighbours, and rotated logs so a chatty app can't fill
// the disk. Limits are overridable (or disabled with 0) via
// PULSENODE_APP_MEMORY (default 1g), PULSENODE_APP_PIDS (1024) and PULSENODE_APP_CPUS
// (default unlimited — docker rejects a value above the host's core count, so there
// is no safe universal number).
func appHardeningArgs() []string {
	args := []string{"--cap-drop", "ALL"}
	for _, c := range appCaps {
		args = append(args, "--cap-add", c)
	}
	args = append(args, "--security-opt", "no-new-privileges")
	if v := envLimit("PULSENODE_APP_MEMORY", "1g"); v != "" {
		args = append(args, "--memory", v)
	}
	if v := envLimit("PULSENODE_APP_CPUS", ""); v != "" {
		args = append(args, "--cpus", v)
	}
	if v := envLimit("PULSENODE_APP_PIDS", "1024"); v != "" {
		args = append(args, "--pids-limit", v)
	}
	return append(args, "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=3")
}

// runMonorepo builds and deploys a frontend/ + backend/ repo as two services on
// the same domain: frontend at /, backend at /api. Both images are built first
// so a build error never leaves a half-swapped deploy; then each is rolled out
// through the zero-downtime health gate. Rollback is not supported (Result has
// no single ImageTag), matching compose deploys.
func (cfg Config) runMonorepo(ctx context.Context, slug, verTag string, feEnv, beEnv map[string]string, feDir, beDir string) (Result, error) {
	feImage := fmt.Sprintf("pn-%s-frontend:%s", slug, verTag)
	beImage := fmt.Sprintf("pn-%s-backend:%s", slug, verTag)

	cfg.log("system", "→ Building frontend…")
	if err := cfg.buildImage(ctx, feDir, feImage, "frontend"); err != nil {
		return Result{}, fmt.Errorf("frontend build: %w", err)
	}
	cfg.log("system", "→ Building backend…")
	if err := cfg.buildImage(ctx, beDir, beImage, "backend"); err != nil {
		return Result{}, fmt.Errorf("backend build: %w", err)
	}

	cfg.log("system", fmt.Sprintf("→ Deploying frontend (serves https://%s/)…", cfg.Domain))
	feCID, err := cfg.deployService(ctx, feImage, slug, feEnv, cfg.frontendSpec())
	if err != nil {
		return Result{}, fmt.Errorf("frontend deploy: %w", err)
	}
	cfg.log("system", fmt.Sprintf("→ Deploying backend (serves https://%s/api)…", cfg.Domain))
	beCID, err := cfg.deployService(ctx, beImage, slug, beEnv, cfg.backendSpec(beEnv))
	if err != nil {
		return Result{}, fmt.Errorf("backend deploy: %w", err)
	}

	cfg.log("system", fmt.Sprintf("✓ Frontend %s • Backend %s", feCID, beCID))
	cfg.log("system", fmt.Sprintf("✓ Live at https://%s (API at /api)", cfg.Domain))
	// ContainerID tracks the frontend (the project's primary, root-routed service).
	return Result{ContainerID: feCID}, nil
}

// buildImage builds dir into imageRef using its own detected method (Dockerfile
// or nixpacks). label is the component name used in log lines. A nested
// docker-compose in a monorepo component is not supported.
func (cfg Config) buildImage(ctx context.Context, dir, imageRef, label string) error {
	method := Detect(dir)
	cfg.log("system", fmt.Sprintf("→ [%s] build method: %s", label, method))
	switch method {
	case MethodDockerfile:
		return cfg.run(ctx, dir, "docker", "build", "-t", imageRef, ".")
	case MethodNixpacks:
		args := []string{"build", dir, "--name", imageRef}
		if isNodeProject(dir) && !pinsNodeVersion(dir) {
			cfg.log("system", fmt.Sprintf("→ [%s] no Node version pinned; defaulting to Node %s", label, defaultNodeVersion))
			args = append(args, "--env", "NIXPACKS_NODE_VERSION="+defaultNodeVersion)
		}
		return cfg.run(ctx, dir, "nixpacks", args...)
	default:
		return fmt.Errorf("[%s] a nested docker-compose is not supported in monorepo mode — use a Dockerfile or a buildable project", label)
	}
}

// removeOldContainers removes every container that routes to this project
// except keepID (the container we just deployed). Old and new containers carry
// identical Traefik routing labels, so any leftover old container keeps
// receiving a share of traffic until it's removed — leaving one live means the
// user sees the old version on ~half of requests.
//
// Candidates are gathered by every signal old and new deploys can share:
//   - the pulsenode.project label (new naming scheme), and
//   - the Traefik router label keyed on the project id, which is ALSO present on
//     pre-label legacy containers, so they get cleaned up even though they
//     predate the pulsenode.project label.
//
// PrevContainerID is still honored as a final fallback for containers that
// somehow carry neither label.
//
// component scopes the cleanup so a monorepo deploy swaps only its own service:
// a "frontend" deploy must not remove the "backend" container and vice versa.
// component "" is the single-service case (legacy behavior). Containers carrying
// no component label are treated as legacy and removed by the frontend/default
// pass (they shared the root router pn-<id>), which also converts a previously
// single-service project to monorepo cleanly.
func (cfg Config) removeOldContainers(ctx context.Context, projectID, component, keepID string) {
	seen := map[string]bool{}
	var ids []string
	add := func(list ...string) {
		for _, id := range list {
			id = strings.TrimSpace(id)
			if id != "" && !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
	}

	// Project-labeled containers: only this service's component, plus any
	// unlabeled legacy ones (which predate per-component labels).
	out, _ := runOutput(ctx, "", "docker", "ps", "-aq", "--filter", "label=pulsenode.project="+projectID)
	for _, id := range strings.Fields(out) {
		if comp := componentLabel(ctx, id); comp == "" || comp == component {
			add(id)
		}
	}

	// Truly-legacy containers predate the pulsenode.project label entirely; the
	// shared root router label still identifies them. The backend uses a distinct
	// -api router, so this pass only applies to the frontend/default service.
	if component == "" || component == "frontend" {
		out, _ := runOutput(ctx, "", "docker", "ps", "-aq", "--filter", "label=traefik.http.routers.pn-"+projectID+".entrypoints")
		add(strings.Fields(out)...)
		add(cfg.PrevContainerID)
	}

	for _, id := range ids {
		if strings.HasPrefix(keepID, id) || strings.HasPrefix(id, keepID) {
			continue // never remove the container we just deployed
		}
		_ = runSilent(ctx, "docker", "rm", "-f", id)
	}
}

// RemoveProjectContainers force-removes every container belonging to a
// project (matched by the pulsenode.project label — covers both components
// of a monorepo deploy). Used when a project is deleted, so its container(s)
// don't keep running and squatting the project's Traefik routes.
func RemoveProjectContainers(ctx context.Context, projectID string) {
	out, _ := runOutput(ctx, "", "docker", "ps", "-aq", "--filter", "label=pulsenode.project="+projectID)
	for _, id := range strings.Fields(out) {
		_ = runSilent(ctx, "docker", "rm", "-f", id)
	}
}

// componentLabel returns a container's pulsenode.component label, or "" if it
// has none (legacy / single-service container).
func componentLabel(ctx context.Context, id string) string {
	out, err := runOutput(ctx, "", "docker", "inspect", "-f", `{{index .Config.Labels "pulsenode.component"}}`, id)
	if err != nil {
		return ""
	}
	s := strings.TrimSpace(out)
	if s == "<no value>" {
		return ""
	}
	return s
}

// waitHealthy blocks until the container reports healthy, fails, or healthTimeout
// elapses. If the image defines a HEALTHCHECK its status is authoritative;
// otherwise the container is considered healthy once it has stayed up (not
// exited, not restarting) for stableWindow.
func (cfg Config) waitHealthy(ctx context.Context, name string) error {
	deadline := time.Now().Add(healthTimeout)
	var stableSince time.Time
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		st := inspectState(ctx, name)
		switch {
		case st.health == "healthy":
			return nil
		case st.health == "unhealthy":
			return fmt.Errorf("container reported unhealthy")
		case st.health != "": // "starting" — image healthcheck still running
			stableSince = time.Time{}
		case st.status == "exited" || st.status == "dead":
			return fmt.Errorf("container exited (code %d)", st.exitCode)
		case st.running && !st.restarting:
			if stableSince.IsZero() {
				stableSince = time.Now()
			}
			if time.Since(stableSince) >= stableWindow {
				return nil
			}
		default:
			stableSince = time.Time{}
		}
		time.Sleep(1500 * time.Millisecond)
	}
	return fmt.Errorf("timed out after %s", healthTimeout)
}

type containerState struct {
	running, restarting bool
	status              string
	exitCode            int
	health              string
}

func inspectState(ctx context.Context, name string) containerState {
	out, err := runOutput(ctx, "", "docker", "inspect", "-f",
		"{{.State.Running}}|{{.State.Restarting}}|{{.State.Status}}|{{.State.ExitCode}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}", name)
	var st containerState
	if err != nil {
		return st
	}
	parts := strings.SplitN(strings.TrimSpace(out), "|", 5)
	if len(parts) != 5 {
		return st
	}
	st.running = parts[0] == "true"
	st.restarting = parts[1] == "true"
	st.status = parts[2]
	fmt.Sscanf(parts[3], "%d", &st.exitCode)
	st.health = parts[4]
	return st
}

func (cfg Config) composeOverlay(net string) string {
	id := cfg.ProjectID
	domain := cfg.Domain
	port := fmt.Sprintf("%d", cfg.Port)
	return fmt.Sprintf(`services:
  app:
    labels:
      traefik.enable: "true"
      traefik.http.routers.pn-%s.rule: "Host(`+"`%s`"+`)"
      traefik.http.routers.pn-%s.entrypoints: "websecure"
      traefik.http.routers.pn-%s.tls.certresolver: "letsencrypt"
      traefik.http.services.pn-%s.loadbalancer.server.port: "%s"
      traefik.docker.network: "%s"
    environment:
      PORT: "%s"
    networks:
      - default
      - traefik-net
networks:
  traefik-net:
    external: true
    name: %s
`, id, domain, id, id, id, port, net, port, net)
}

func (cfg Config) resolveTraefikNetwork(ctx context.Context) string {
	if net := strings.TrimSpace(cfg.TraefikNet); net != "" {
		return net
	}

	workspace := os.Getenv("PULSENODE_WORKSPACE")
	if workspace == "" {
		workspace = "/workspace"
	}
	if net := envFileValue(filepath.Join(workspace, ".env.local"), "TRAEFIK_NETWORK"); net != "" {
		cfg.log("system", fmt.Sprintf("→ Using Traefik network from .env.local: %s", net))
		return net
	}

	net := detectTraefikNetwork(ctx)
	if net != "" {
		cfg.log("system", fmt.Sprintf("→ Detected Traefik network: %s", net))
	}
	return net
}

func envFileValue(path, key string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	prefix := key + "="
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || !strings.HasPrefix(line, prefix) {
			continue
		}
		return strings.Trim(strings.TrimSpace(strings.TrimPrefix(line, prefix)), "\"")
	}
	return ""
}

func detectTraefikNetwork(ctx context.Context) string {
	out, err := runOutput(ctx, "", "docker", "ps", "--filter", "name=traefik", "--format", "{{.ID}}")
	if err != nil {
		return ""
	}
	for _, id := range strings.Fields(out) {
		data, err := runOutput(ctx, "", "docker", "inspect", id, "--format", "{{json .NetworkSettings.Networks}}")
		if err != nil {
			continue
		}
		var networks map[string]any
		if err := json.Unmarshal([]byte(data), &networks); err != nil {
			continue
		}
		for net := range networks {
			if net != "bridge" && net != "host" && net != "none" {
				return net
			}
		}
	}
	return ""
}

// ── helpers ───────────────────────────────────────────────────────────────────

// passEnv is the only part of go-api's environment that build commands see.
// Everything else (JWT_SECRET, AES_KEY, GitHub/Coolify credentials) stays out,
// since a repo's compose file could interpolate ${VAR} and a build step could
// read its environment.
var passEnv = []string{
	"PATH", "HOME", "USER", "TMPDIR", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR",
	"DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "DOCKER_BUILDKIT", "BUILDKIT_PROGRESS",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
}

func buildEnv(extra []string) []string {
	env := []string{"GIT_TERMINAL_PROMPT=0"}
	for _, k := range passEnv {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	return append(env, extra...)
}

// gitAuthEnv sends the token as an HTTP header scoped to the repo's host, via
// git's env-based config, so it never appears in argv or the clone's .git/config.
// The token is a GitHub credential, so it is only ever sent to https://github.com:
// a project pointing at any other host (or plain http) clones without it, instead
// of handing a `repo`-scope token to whoever runs that server.
func gitAuthEnv(repoURL, token string) []string {
	u, err := url.Parse(repoURL)
	if token == "" || err != nil || u.Scheme != "https" || u.User != nil || !strings.EqualFold(u.Host, "github.com") {
		return nil
	}
	cred := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + token))
	return []string{
		"GIT_CONFIG_COUNT=1",
		"GIT_CONFIG_KEY_0=http.https://github.com/.extraheader",
		"GIT_CONFIG_VALUE_0=Authorization: Basic " + cred,
	}
}

func (cfg Config) run(ctx context.Context, dir string, name string, args ...string) error {
	return cfg.runEnv(ctx, dir, nil, name, args...)
}

func (cfg Config) runEnv(ctx context.Context, dir string, extraEnv []string, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = buildEnv(extraEnv)
	// A grandchild (buildx, git helper) can keep the output pipe open after the
	// context kills the command; without WaitDelay Wait would block forever.
	cmd.WaitDelay = 10 * time.Second
	// Plain writers (not StdoutPipe + goroutines): os/exec then owns the copy
	// goroutines and Wait() returns only after every byte was delivered, so the
	// tail of the output — usually the error message — is never lost.
	var mu sync.Mutex // stdout and stderr copy concurrently
	emit := func(stream string) func(string) {
		return func(line string) {
			mu.Lock()
			defer mu.Unlock()
			cfg.log(stream, line)
		}
	}
	stdout, stderr := &lineWriter{emit: emit("stdout")}, &lineWriter{emit: emit("stderr")}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	err := cmd.Run()
	stdout.flush()
	stderr.flush()
	return err
}

// maxLogLine caps one emitted log line; longer output is split rather than
// buffered without bound (and, unlike bufio.Scanner, never stops reading).
const maxLogLine = 1 << 20

// lineWriter turns a byte stream into log lines.
type lineWriter struct {
	emit func(string)
	buf  []byte
}

func (w *lineWriter) Write(p []byte) (int, error) {
	w.buf = append(w.buf, p...)
	for {
		i := bytes.IndexByte(w.buf, '\n')
		if i < 0 {
			break
		}
		w.emit(strings.TrimSuffix(string(w.buf[:i]), "\r"))
		w.buf = w.buf[i+1:]
	}
	if len(w.buf) >= maxLogLine {
		w.emit(string(w.buf))
		w.buf = nil
	}
	return len(p), nil
}

func (w *lineWriter) flush() {
	if len(w.buf) > 0 {
		w.emit(strings.TrimSuffix(string(w.buf), "\r"))
		w.buf = nil
	}
}

func runOutput(ctx context.Context, dir string, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = buildEnv(nil)
	out, err := cmd.Output()
	return string(out), err
}

func runSilent(ctx context.Context, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = buildEnv(nil)
	return cmd.Run()
}

func (cfg Config) log(stream, line string) {
	if cfg.Log != nil {
		cfg.Log(stream, line)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// sanitizeName lowercases and replaces non-alphanumeric chars with hyphens.
func sanitizeName(name string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(name) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteRune('-')
		}
	}
	s := strings.Trim(b.String(), "-")
	if s == "" {
		return "app"
	}
	return s
}

// CommitInfo returns the full SHA and subject line from the cloned repo.
func CommitInfo(dir string) (sha, msg string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sha, _ = runOutput(ctx, dir, "git", "rev-parse", "HEAD")
	msg, _ = runOutput(ctx, dir, "git", "log", "-1", "--pretty=%s")
	return strings.TrimSpace(sha), strings.TrimSpace(msg)
}
