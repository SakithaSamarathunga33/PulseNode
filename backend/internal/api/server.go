package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"

	"pulsenode/backend/internal/auth"
	"pulsenode/backend/internal/caddy"
	"pulsenode/backend/internal/db"
	"pulsenode/backend/internal/docker"
	"pulsenode/backend/internal/hub"
	"pulsenode/backend/internal/proc"
	"pulsenode/backend/internal/queue"
	"pulsenode/backend/internal/security"
)

type Config struct {
	Docker    *docker.Client
	Collector *proc.Collector
	Hub       *hub.Hub
	DB        *db.DB
	Queue     *queue.Queue
	Origins   []string
}

type Server struct {
	docker    *docker.Client
	collector *proc.Collector
	hub       *hub.Hub
	db        *db.DB
	queue     *queue.Queue
	security  *security.Service
	caddy     *caddy.Client
	auth      *auth.Middleware
	origins   []string
	backupMu  sync.Mutex
	backups   map[string]*backupJob

	insecureNoAuth bool       // PULSENODE_INSECURE_NO_AUTH=true: no admin account → open dashboard
	setupMu        sync.Mutex // guards setupToken
	setupToken     string     // one-time token required to create the first admin
	setupTokenPath string
}

func NewServer(cfg Config) *Server {
	dataDir := firstNonEmpty(os.Getenv("PULSENODE_DATA_DIR"), "/var/lib/pulsenode")
	srv := &Server{
		docker:         cfg.Docker,
		collector:      cfg.Collector,
		hub:            cfg.Hub,
		db:             cfg.DB,
		queue:          cfg.Queue,
		security:       security.New(),
		caddy:          caddy.New(os.Getenv("CADDY_ADMIN_ADDR")),
		auth:           auth.NewMiddleware(auth.Config{Secret: jwtSecret(dataDir)}),
		origins:        cfg.Origins,
		backups:        make(map[string]*backupJob),
		insecureNoAuth: strings.EqualFold(os.Getenv("PULSENODE_INSECURE_NO_AUTH"), "true"),
	}
	srv.initSetupToken(dataDir)
	srv.startBackupCleaner()
	return srv
}

func (s *Server) Routes() http.Handler {
	r := chi.NewRouter()
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   s.origins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		AllowCredentials: true,
		MaxAge:           300,
	}))
	r.Use(RateLimit(300, time.Minute)) // 300 req/min per IP
	r.Use(s.sameOriginWrites)
	r.Use(s.AuditLog)

	r.Get("/health", s.health)
	r.Get("/config", s.clientConfig)
	// Realtime streams carry deploy logs / provisioning detail to every subscriber,
	// so they must be authenticated. Browser EventSource/WebSocket send the
	// pn_session cookie same-origin; the cookie is SameSite=Lax so it isn't sent
	// cross-site.
	r.With(s.requireAuth).Get("/events", s.hub.ServeSSE)
	r.With(s.requireAuth).Get("/ws", s.hub.ServeWebSocket)

	// Container shell — WebSocket exec into a container (root). MUST be authenticated:
	// the WS upgrader accepts all origins, so without requireAuth this is an
	// unauthenticated remote shell. Browser handshake carries the pn_session cookie.
	r.With(s.requireAuth).Get("/api/ws/containers/{id}/shell", s.containerShell)
	r.With(s.requireAuth).Post("/api/ws/containers/resize", s.containerShellResize)

	// OAuth callback — a top-level GET navigation from github.com, so the Lax
	// session cookie is sent; requiring it (plus the state check in the handler)
	// stops anyone from attaching their own GitHub account to this panel.
	r.With(s.requireAuth).Get("/api/github/callback", s.githubCallback)
	// GitHub push webhook — public, authenticated by HMAC signature (see handler).
	r.Post("/api/github/webhook", s.githubWebhook)
	// GitHub App installation callback — GitHub redirects here after install/uninstall.
	r.With(s.requireAuth).Get("/api/github/app/callback", s.githubAppCallback)
	// JSON registration endpoint called by the frontend /github/app/callback page.
	r.With(s.requireAuth).Get("/api/github/app/register", s.githubAppRegister)

	r.Get("/api/auth/status", s.authStatus)
	r.Post("/api/auth/logout", s.authLogout)
	// Password-checking endpoints get a much tighter per-IP budget than the
	// global limiter: 10 attempts per minute is plenty for a human.
	r.Group(func(r chi.Router) {
		r.Use(RateLimit(10, time.Minute))
		r.Post("/api/auth/login", s.authLogin)
		r.Post("/api/auth/setup", s.authSetup)
	})

	r.Route("/api", func(r chi.Router) {
		r.Use(s.requireAuth)
		r.Get("/docker/containers", s.dockerContainers)
		r.Get("/docker/container-stats", s.containerStats)
		r.Get("/docker/heartbeats", s.dockerHeartbeats)
		r.Get("/docker/images", s.dockerImages)
		r.Get("/docker/networks", s.dockerNetworks)
		r.Get("/docker/databases", s.dockerDatabases)
		r.Get("/docker/logs/{id}", s.dockerLogs)
		r.Post("/docker/restart/{id}", s.dockerAction("restart"))
		r.Post("/docker/start/{id}", s.dockerAction("start"))
		r.Post("/docker/stop/{id}", s.dockerAction("stop"))
		r.Delete("/docker/remove/{id}", s.dockerAction("remove"))
		r.Post("/docker/exec/{id}", s.dockerExec)
		r.Post("/docker/build-cache/clear", s.clearBuildCache)
		r.Post("/docker/pull", s.dockerPullImage)
		r.Post("/docker/images/prune", s.dockerPruneImages)

		r.Get("/host", s.host)
		r.Get("/pm2/list", s.processes)
		r.Post("/pm2/restart/{name}", notImplemented)
		r.Post("/processes/kill/{pid}", signalHandler(os.Kill))
		r.Post("/processes/suspend/{pid}", signalHandler(syscall.SIGSTOP))
		r.Post("/processes/resume/{pid}", signalHandler(syscall.SIGCONT))

		r.Get("/system/version", s.version)
		r.Get("/system/update/status", s.updateStatus)
		r.Post("/system/update", s.systemUpdate)

		r.Get("/coolify/projects", s.coolifyProjects)
		r.Get("/coolify/deployments", s.coolifyDeployments)

		// GitHub integration
		r.Get("/github/auth-url", s.githubAuthURL)
		r.Get("/github/account", s.githubAccount)
		r.Delete("/github/account", s.githubDisconnect)
		r.Post("/github/pat", s.githubSavePAT)
		r.Get("/github/repos", s.githubRepos)
		r.Get("/github/branches", s.githubBranches)
		r.Get("/github/detect-layout", s.detectRepoLayout)
		r.Get("/github/oauth-settings", s.githubOAuthSettings)
		r.Post("/github/oauth-settings", s.githubSaveOAuthSettings)
		r.Get("/github/webhook-info", s.githubWebhookInfo)

		// GitHub App
		r.Get("/github/app/settings", s.githubAppSettings)
		r.Post("/github/app/settings", s.githubAppSaveSettings)
		r.Get("/github/app/install-url", s.githubAppInstallURL)
		r.Get("/github/app/installations", s.listAppInstallations)
		r.Delete("/github/app/installations/{id}", s.deleteAppInstallation)
		r.Get("/github/app/repos", s.githubAppRepos)
		r.Get("/github/app/installation-details", s.githubAppInstallationDetails)
		r.Get("/github/app/projects", s.githubAppProjects)
		r.Get("/github/app/repos/{owner}/{repo}/commits", s.githubRepoCommits)
		r.Get("/github/app/repos/{owner}/{repo}/tree", s.githubRepoTree)
		r.Get("/github/app/repos/{owner}/{repo}/file", s.githubRepoFile)
		r.Put("/github/app/repos/{owner}/{repo}/file", s.githubRepoUpdateFile)

		// Domain settings
		r.Get("/domain/settings", s.domainSettings)
		r.Get("/domain/check", s.checkDomain)

		// Saved domains + live inventory
		r.Get("/domains", s.listDomains)
		r.Post("/domains", s.saveDomain)
		r.Get("/domains/in-use", s.inUseDomains)
		r.Post("/domains/{host}/recheck", s.recheckDomain)
		r.Post("/domains/{host}/primary", s.setPrimaryDomain)
		r.Delete("/domains/{host}", s.deleteDomain)

		// Projects (deploy)
		r.Get("/projects/free-port", s.freePort)
		r.Get("/projects", s.listProjects)
		r.Post("/projects", s.createProject)
		r.Get("/projects/{id}", s.getProject)
		r.Put("/projects/{id}", s.updateProject)
		r.Delete("/projects/{id}", s.deleteProject)
		r.Post("/projects/{id}/deploy", s.deployProject)
		r.Get("/projects/{id}/deployments", s.listDeployments)
		r.Post("/projects/{id}/deployments/{depID}/rollback", s.rollbackDeployment)
		r.Get("/projects/{id}/deployments/{depID}/logs", s.getDeploymentLogs)
		r.Get("/projects/{id}/webhook", s.getProjectWebhook)
		r.Post("/projects/{id}/webhook", s.installProjectWebhookHandler)

		// Managed databases (PulseNode-provisioned)
		r.Get("/databases/managed", s.listManagedDatabases)
		r.Post("/databases/managed", s.provisionDatabase)
		r.Get("/databases/managed/{id}", s.getManagedDatabase)
		r.Get("/databases/managed/{id}/credentials", s.getManagedDBCredentials)
		r.Delete("/databases/managed/{id}", s.deleteManagedDatabase)

		// Connected databases (user-provided)
		r.Get("/databases/connected", s.listConnectedDatabases)
		r.Post("/databases/connected", s.connectDatabase)
		r.Delete("/databases/connected/{id}", s.deleteConnectedDatabase)

		// Alert rules + history
		r.Get("/alerts/rules", s.listAlertRules)
		r.Post("/alerts/rules", s.createAlertRule)
		r.Patch("/alerts/rules/{id}", s.updateAlertRule)
		r.Delete("/alerts/rules/{id}", s.deleteAlertRule)
		r.Get("/alerts/history", s.listAlertHistory)

		// Notification channels
		r.Get("/alerts/channels", s.listNotificationChannels)
		r.Post("/alerts/channels", s.createNotificationChannel)
		r.Delete("/alerts/channels/{id}", s.deleteNotificationChannel)

		// Audit log
		r.Get("/audit", s.listAuditLog)

		// Caddy Admin API proxy (never exposed publicly — Admin API is localhost:2019)
		r.Get("/caddy/config", s.caddyConfig)
		r.Get("/caddy/routes", s.caddyRoutes)
		r.Post("/caddy/routes", s.caddyAddRoute)
		r.Delete("/caddy/routes/{id}", s.caddyRemoveRoute)

		// Legacy stubs kept for backward compat
		r.Get("/database/custom", emptyList)
		r.Post("/database/custom/test", notImplemented)
		r.Post("/database/custom/save", notImplemented)
		r.Delete("/database/custom/{id}", notImplemented)
		r.Post("/database/provision", notImplemented)
		r.Get("/database/{name}/connection-string", s.databaseConnectionString)
		r.Get("/database/{name}/schema", s.databaseSchema)
		r.Get("/database/{name}/metrics", s.databaseMetrics)
		r.Post("/database/{name}/backup", s.startBackup)
		r.Get("/database/backup/{jobId}", s.backupStatus)
		r.Get("/database/backup/{jobId}/download", s.downloadBackup)
		r.Post("/database/{name}/restore", s.restoreDatabase)
		r.Post("/database/{name}/query", s.databaseQuery)
		r.Get("/database/connections", s.databaseConnections)
	})

	// These live outside the /api group for legacy path reasons but are reachable
	// externally via Caddy's /go/* proxy, so they must require auth too.
	r.With(s.requireAuth).Get("/metrics/live", s.metricsLive)
	r.With(s.requireAuth).Get("/metrics/history", s.metricsHistory)
	r.With(s.requireAuth).Get("/metrics/processes", s.processes)

	r.With(s.requireAuth).Get("/security/scans", s.securityScans)
	r.With(s.requireAuth).Post("/security/scan", s.securityScan)
	r.With(s.requireAuth).Get("/security/sboms", s.securitySBOMs)
	r.With(s.requireAuth).Post("/security/sbom", s.securitySBOM)

	r.With(s.requireAuth).Get("/database/inspect", emptyList)

	return r
}

// processStart marks when this go-api process booted. Exposed via /health so the
// dashboard can detect when the backend has actually restarted (e.g. after a
// self-update) and reload to the new version — rather than reloading the moment
// /health responds, which during a build still answers from the old container.
var processStart = time.Now()

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "service": "pulsenode-go",
		"ts": time.Now().UnixMilli(), "startedAt": processStart.UnixMilli(),
	})
}

func (s *Server) clientConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"coolifyEnabled": os.Getenv("COOLIFY_API_URL") != "" && os.Getenv("COOLIFY_API_TOKEN") != "",
	})
}

// installedVersion reports the version PulseNode is running. Prefers the most
// recent git tag in the workspace — that auto-refreshes when `git pull` runs
// during self-update, so we don't depend on install.sh keeping
// PULSENODE_VERSION in sync (it doesn't; it writes the value once at install
// and never touches it again, so the env stays frozen at install-time).
// Falls back to PULSENODE_VERSION env, then "dev".
func installedVersion() string {
	workspace := workspaceDir()
	out, err := exec.Command("git", "-C", workspace,
		"-c", "safe.directory="+workspace,
		"describe", "--tags", "--abbrev=0").Output()
	if err == nil {
		v := strings.TrimSpace(strings.TrimPrefix(string(out), "v"))
		if v != "" {
			return v
		}
	}
	return firstNonEmpty(os.Getenv("PULSENODE_VERSION"), "dev")
}

func workspaceDir() string {
	if ws := os.Getenv("PULSENODE_WORKSPACE"); ws != "" {
		return ws
	}
	return "/workspace"
}

// runningAtLeast reports whether the workspace HEAD is at or ahead of commitSHA
// (i.e. commitSHA is an ancestor of HEAD). The dev/publish box pushes commits
// but never pulls the tags CI creates, so its local tags — and thus
// installedVersion() — lag behind the code it's actually running. Comparing
// commits instead of local tags lets us recognise it's up to date.
func runningAtLeast(commitSHA string) bool {
	if commitSHA == "" {
		return false
	}
	ws := workspaceDir()
	err := exec.Command("git", "-C", ws,
		"-c", "safe.directory="+ws,
		"merge-base", "--is-ancestor", commitSHA, "HEAD").Run()
	return err == nil
}

func (s *Server) version(w http.ResponseWriter, r *http.Request) {
	current := installedVersion()

	type ghRelease struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
		Body    string `json:"body"`
	}

	fetchLatest := func() (tag, rawTag, url, body string, err error) {
		client := &http.Client{Timeout: 5 * time.Second}
		req, _ := http.NewRequest(http.MethodGet, "https://api.github.com/repos/SakithaSamarathunga33/PulseNode/releases/latest", nil)
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		resp, err := client.Do(req)
		if err != nil {
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			err = fmt.Errorf("github api %d", resp.StatusCode)
			return
		}
		var rel ghRelease
		if err = json.NewDecoder(resp.Body).Decode(&rel); err != nil {
			return
		}
		rawTag = rel.TagName
		tag = strings.TrimPrefix(rel.TagName, "v")
		url = rel.HTMLURL
		body = rel.Body
		return
	}

	// resolveCommit returns the commit SHA a tag points to (deref'ing annotated
	// tags), so we can compare the latest release to what HEAD is running.
	resolveCommit := func(tag string) string {
		if tag == "" {
			return ""
		}
		client := &http.Client{Timeout: 5 * time.Second}
		req, _ := http.NewRequest(http.MethodGet, "https://api.github.com/repos/SakithaSamarathunga33/PulseNode/commits/"+tag, nil)
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		resp, err := client.Do(req)
		if err != nil {
			return ""
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return ""
		}
		var c struct {
			SHA string `json:"sha"`
		}
		if json.NewDecoder(resp.Body).Decode(&c) != nil {
			return ""
		}
		return c.SHA
	}

	latest, latestRaw, releaseURL, changelog, err := fetchLatest()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"current": current, "latest": nil, "hasUpdate": false, "releaseUrl": nil, "changelog": nil,
		})
		return
	}

	// If the box is actually running code at or ahead of the latest release
	// (its commit is an ancestor of HEAD), report it as current even when local
	// tags are stale. Fixes the dev/publish box showing an old version.
	if latest != "" && current != latest && current != "dev" {
		if runningAtLeast(resolveCommit(latestRaw)) {
			current = latest
		}
	}

	hasUpdate := latest != "" && latest != current && current != "dev"
	writeJSON(w, http.StatusOK, map[string]any{
		"current": current, "latest": latest, "hasUpdate": hasUpdate, "releaseUrl": releaseURL, "changelog": changelog,
	})
}

func notImplemented(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "not implemented in Go backend yet"})
}

func emptyList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, []any{})
}

func signalHandler(sig os.Signal) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		pid, err := strconv.Atoi(chi.URLParam(r, "pid"))
		if err != nil || pid < 2 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid pid"})
			return
		}
		// Resuming is always safe; killing or freezing PulseNode itself or the
		// Docker daemon would take the panel down with no way to undo it from here.
		if sig != syscall.SIGCONT && protectedPID(pid) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "refusing to signal a process PulseNode depends on"})
			return
		}
		if err := proc.Signal(pid, sig); err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "pid": pid, "signal": sig.String()})
	}
}

// protectedPID reports whether pid is this server, its parent, or the Docker
// daemon (go-api shares the host PID namespace).
func protectedPID(pid int) bool {
	if pid == os.Getpid() || pid == os.Getppid() {
		return true
	}
	comm, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/comm")
	if err != nil {
		return false
	}
	switch strings.TrimSpace(string(comm)) {
	case "dockerd", "containerd":
		return true
	}
	return false
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
