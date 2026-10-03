package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"pulsenode/backend/internal/alerts"
	"pulsenode/backend/internal/api"
	"pulsenode/backend/internal/db"
	"pulsenode/backend/internal/docker"
	"pulsenode/backend/internal/hub"
	"pulsenode/backend/internal/proc"
	"pulsenode/backend/internal/queue"
)

func main() {
	// run() returns instead of calling log.Fatal so its deferred cleanup (DB
	// close, WAL checkpoint) always executes.
	if err := run(); err != nil {
		log.Error().Err(err).Msg("fatal")
		os.Exit(1)
	}
}

func run() error {
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	if os.Getenv("LOG_FORMAT") != "json" {
		log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: "15:04:05"})
	}
	level := zerolog.InfoLevel
	if os.Getenv("LOG_LEVEL") == "debug" {
		level = zerolog.DebugLevel
	}
	zerolog.SetGlobalLevel(level)

	port := env("GO_PORT", "4002")

	dockerClient, err := docker.New()
	if err != nil {
		log.Warn().Err(err).Msg("docker socket unavailable, container features disabled")
	}

	if generated, err := db.EnsureEncryptionKey(env("PULSENODE_DATA_DIR", "/var/lib/pulsenode")); err != nil {
		return fmt.Errorf("no encryption key: set AES_KEY or make PULSENODE_DATA_DIR writable: %w", err)
	} else if generated {
		log.Warn().Msg("AES_KEY not set — using a generated key stored in PULSENODE_DATA_DIR/aes-key")
	}

	database, err := db.Open(env("DATABASE_PATH", "/data/pulsenode.db"))
	if err != nil {
		return fmt.Errorf("failed to open database: %w", err)
	}
	defer func() {
		if err := database.Close(); err != nil {
			log.Warn().Err(err).Msg("database close")
		}
	}()

	collector := proc.NewCollector(60, 3*time.Second)
	events := hub.New()
	// New websockets get the real number of firing alerts (sidebar badge).
	events.OpenAlertCount = func() int {
		n, err := database.CountFiringAlerts()
		if err != nil {
			log.Warn().Err(err).Msg("alert count unavailable")
		}
		return n
	}
	jobQueue := queue.New(database, events, 2)
	jobQueue.RecoverStuck()

	origins := []string{
		env("NEXT_PUBLIC_ORIGIN", "http://localhost:3000"),
		"http://localhost:3001",
		"http://127.0.0.1:3000",
	}
	events.AllowedOrigins = origins // gate cross-site WebSocket handshakes on /ws

	server := api.NewServer(api.Config{
		Docker:    dockerClient,
		Collector: collector,
		Hub:       events,
		DB:        database,
		Queue:     jobQueue,
		Origins:   origins,
	})

	server.SeedDomainsIfEmpty(context.Background())
	server.SeedGitHubAppFromEnv()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Background loops all stop on ctx; shutdown waits for them before the DB closes.
	var bg sync.WaitGroup
	spawn := func(f func()) {
		bg.Add(1)
		go func() { defer bg.Done(); f() }()
	}
	spawn(func() { collector.Start(ctx) })
	spawn(func() { streamSystemMetrics(ctx, collector, events) })
	spawn(func() { streamContainerStats(ctx, dockerClient, events) })
	spawn(func() { jobQueue.StartPoller(ctx, pollInterval()) })
	spawn(func() { recordContainerHeartbeats(ctx, dockerClient, database) })
	spawn(func() {
		alerts.Start(ctx, alerts.Deps{
			Store: database,
			Hub:   events,
			Host: func() (alerts.HostSample, bool) {
				s := collector.Live()
				return alerts.HostSample{CPU: s.CPU, Memory: s.RAM, Disk: s.Disk}, len(collector.History()) > 0
			},
			Containers: func(ctx context.Context) ([]alerts.ContainerState, error) {
				if dockerClient == nil {
					return nil, nil
				}
				cs, err := dockerClient.Containers(ctx)
				out := make([]alerts.ContainerState, 0, len(cs))
				for _, c := range cs {
					out = append(out, alerts.ContainerState{
						Name: c.Name, State: c.State,
						CleanExit: c.State == "exited" && c.ExitCode == 0,
						OneOff:    c.OneOff,
					})
				}
				return out, err
			},
		})
	})
	spawn(func() { pruneDaily(ctx, database) })

	httpServer := &http.Server{
		Addr:              ":" + port,
		Handler:           server.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	// Shutdown does not end SSE/websocket connections by itself; closing the hub
	// does, so it doesn't sit out the full timeout on open dashboards.
	httpServer.RegisterOnShutdown(events.Close)

	serveErr := make(chan error, 1)
	go func() {
		log.Info().Str("addr", "http://localhost:"+port).Msg("PulseNode listening")
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
		close(serveErr)
	}()

	var runErr error
	select {
	case <-ctx.Done():
	case err := <-serveErr:
		if err != nil {
			runErr = fmt.Errorf("server error: %w", err)
		}
		stop()
	}

	log.Info().Msg("shutting down…")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Warn().Err(err).Msg("http shutdown")
	}
	// Let running deployments finish (new ones are refused); past the deadline
	// they are cancelled and recovered on the next boot.
	queueCtx, queueCancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer queueCancel()
	if err := jobQueue.Close(queueCtx); err != nil {
		log.Warn().Err(err).Msg("deploy queue did not drain in time; running builds were cancelled")
	}
	bg.Wait()
	return runErr
}

func streamSystemMetrics(ctx context.Context, collector *proc.Collector, events *hub.Hub) {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			events.Broadcast("system:metrics", collector.Live())
		}
	}
}

func streamContainerStats(ctx context.Context, dockerClient *docker.Client, events *hub.Hub) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Collecting costs one Docker stats call per container, so skip it
			// while no dashboard is connected.
			if dockerClient == nil || events.Subscribers() == 0 {
				continue
			}
			stats, err := dockerClient.ContainerStats(ctx)
			if err == nil {
				events.Broadcast("container:stats", stats)
			}
		}
	}
}

// heartbeatRetention is how long container_heartbeats rows are kept before
// being pruned — matches the longest range the Uptime tab can select (7d).
const heartbeatRetention = 7 * 24 * time.Hour

// recordContainerHeartbeats snapshots every container's up/down state once a
// minute so the Uptime tab can show real history instead of just what
// accumulated since the page was opened.
func recordContainerHeartbeats(ctx context.Context, dockerClient *docker.Client, database *db.DB) {
	if dockerClient == nil {
		return
	}
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			containers, err := dockerClient.Containers(ctx)
			if err != nil {
				continue
			}
			beats := make([]db.Heartbeat, 0, len(containers))
			for _, c := range containers {
				beats = append(beats, db.Heartbeat{ContainerName: c.Name, Up: c.State == "running"})
			}
			if err := database.InsertHeartbeats(beats); err != nil {
				log.Warn().Err(err).Msg("failed to record container heartbeats")
			}
			if err := database.PruneHeartbeats(time.Now().Add(-heartbeatRetention)); err != nil {
				log.Warn().Err(err).Msg("failed to prune container heartbeats")
			}
		}
	}
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// pollInterval reads DEPLOY_POLL_INTERVAL (e.g. "60s", "2m"), defaulting to 60s.
func pollInterval() time.Duration {
	if v := os.Getenv("DEPLOY_POLL_INTERVAL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return 60 * time.Second
}

// Retention for append-only tables (heartbeats have their own, shorter window).
const (
	deployLogRetention = 30 * 24 * time.Hour
	auditRetention     = 180 * 24 * time.Hour
	alertRetention     = 90 * 24 * time.Hour
)

// pruneDaily trims deployment logs, the audit log and alert history so they
// can't grow without bound. Runs once at start-up, then every 24h.
func pruneDaily(ctx context.Context, database *db.DB) {
	prune := func() {
		if err := database.PruneOld(deployLogRetention, auditRetention, alertRetention); err != nil {
			log.Warn().Err(err).Msg("retention prune failed")
		}
	}
	select {
	case <-time.After(time.Minute): // let start-up settle first
		prune()
	case <-ctx.Done():
		return
	}
	t := time.NewTicker(24 * time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			prune()
		}
	}
}
