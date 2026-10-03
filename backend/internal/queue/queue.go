package queue

import (
	"context"
	"log"
	"os"
	"sync"
	"time"

	"pulsenode/backend/internal/builder"
	"pulsenode/backend/internal/db"
	"pulsenode/backend/internal/github"
	"pulsenode/backend/internal/hub"
)

type Queue struct {
	db   *db.DB
	hub  *hub.Hub
	jobs chan string
	wg   sync.WaitGroup
}

func New(database *db.DB, events *hub.Hub, workers int) *Queue {
	if workers <= 0 {
		workers = 2
	}
	q := &Queue{db: database, hub: events, jobs: make(chan string, 64)}
	for i := 0; i < workers; i++ {
		q.wg.Add(1)
		go q.worker()
	}
	return q
}

func (q *Queue) Enqueue(deploymentID string) {
	q.jobs <- deploymentID
}

// RecoverStuck re-queues deployments left in queued/building state from a crash.
func (q *Queue) RecoverStuck() {
	deps, err := q.db.GetQueuedDeployments()
	if err != nil {
		log.Printf("[queue] recover: %v", err)
		return
	}
	for _, d := range deps {
		log.Printf("[queue] recovering deployment %s", d.ID)
		q.jobs <- d.ID
	}
}

func (q *Queue) worker() {
	defer q.wg.Done()
	for depID := range q.jobs {
		q.runDeployment(depID)
	}
}

func (q *Queue) runDeployment(depID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	emit := func(stream, line string) {
		_ = q.db.AppendLog(depID, stream, line)
		q.hub.Broadcast("deploy:log", map[string]any{
			"deploymentId": depID,
			"stream":       stream,
			"line":         line,
			"ts":           time.Now().Format(time.RFC3339),
		})
	}

	now := time.Now()
	_ = q.db.UpdateDeploymentStatus(depID, "building", &now, nil)

	dep, err := q.db.GetDeploymentByID(depID)
	if err != nil || dep == nil {
		emit("system", "✕ Deployment record not found")
		return
	}

	proj, err := q.db.GetProject(dep.ProjectID)
	if err != nil || proj == nil {
		emit("system", "✕ Project not found")
		_ = q.db.UpdateDeploymentStatus(depID, "failed", &now, timePtr(time.Now()))
		_ = q.db.UpdateProjectStatus(dep.ProjectID, "failed", "")
		return
	}

	token := ""
	if acct, _ := q.db.GetGitHubAccount(); acct != nil {
		token = acct.AccessToken
	}

	cfg := builder.Config{
		DeploymentID:    depID,
		ProjectID:       proj.ID,
		ProjectName:     proj.Name,
		RepoURL:         proj.RepoURL,
		GitToken:        token,
		Branch:          proj.Branch,
		Method:          builder.Method(proj.BuildMethod),
		BuildCommand:    proj.BuildCommand,
		Port:            proj.Port,
		Domain:          proj.Domain,
		EnvVars:         proj.EnvVars,
		BackendEnvVars:  proj.BackendEnvVars,
		BaseDir:         proj.BaseDir,
		TraefikNet:      os.Getenv("TRAEFIK_NETWORK"),
		PrevContainerID: proj.ContainerID,
		Log:             emit,
	}

	// A rollback redeploys a previously-built image instead of cloning/building.
	var res builder.Result
	var buildErr error
	if dep.Trigger == "rollback" && dep.ImageTag != "" {
		res, buildErr = builder.RunFromImage(ctx, cfg, dep.ImageTag)
		res.CommitSHA, res.CommitMsg = dep.CommitSHA, dep.CommitMsg // carried from the target deploy
	} else {
		res, buildErr = builder.Run(ctx, cfg)
	}

	// Record the commit that was built (even on failure, for history/diagnostics).
	if res.CommitSHA != "" {
		_ = q.db.UpdateDeploymentCommit(depID, res.CommitSHA, res.CommitMsg)
	}

	finishedAt := time.Now()
	if buildErr != nil {
		emit("system", "✕ Build failed: "+buildErr.Error())
		_ = q.db.UpdateDeploymentStatus(depID, "failed", &now, &finishedAt)
		// Zero-downtime: the previous container is still serving on a failed
		// deploy, so keep the project pointed at it instead of clearing the ref.
		_ = q.db.UpdateProjectStatus(proj.ID, "failed", proj.ContainerID)
		return
	}

	if res.ImageTag != "" {
		_ = q.db.UpdateDeploymentImage(depID, res.ImageTag)
	}
	_ = q.db.UpdateDeploymentStatus(depID, "success", &now, &finishedAt)
	_ = q.db.UpdateProjectStatus(proj.ID, "running", res.ContainerID)
	// Seed/refresh the baseline commit so the poller only fires on newer commits.
	if res.CommitSHA != "" {
		_ = q.db.UpdateProjectCommit(proj.ID, res.CommitSHA)
	}
	emit("system", "=== Deployment Successful ===")
}

func timePtr(t time.Time) *time.Time { return &t }

// StartPoller periodically checks each auto-deploy project's branch on GitHub
// and queues a new deployment when the branch HEAD has moved past the last
// commit that was built. It blocks until ctx is cancelled.
//
// A project only auto-deploys after it has a baseline commit (set by its first
// successful manual deploy), so brand-new projects never deploy unexpectedly.
func (q *Queue) StartPoller(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = time.Minute
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	log.Printf("[poller] watching branches every %s", interval)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			q.pollOnce(ctx)
		}
	}
}

func (q *Queue) pollOnce(ctx context.Context) {
	acct, err := q.db.GetGitHubAccount()
	if err != nil || acct == nil {
		return // no GitHub connection → nothing to poll
	}
	projects, err := q.db.ListProjects()
	if err != nil {
		log.Printf("[poller] list projects: %v", err)
		return
	}
	client := github.NewClient(acct.AccessToken)
	for _, p := range projects {
		select {
		case <-ctx.Done():
			return
		default:
		}
		if !p.AutoDeploy {
			continue
		}
		// Skip until a baseline exists and while a build is already in flight.
		if p.LastCommitSHA == "" || p.Status == "building" || p.Status == "queued" {
			continue
		}
		owner, repo, ok := github.ParseOwnerRepo(p.RepoURL)
		if !ok {
			continue
		}
		sha, msg, err := client.GetBranchHead(owner, repo, p.Branch)
		if err != nil {
			log.Printf("[poller] %s: head lookup failed: %v", p.Name, err)
			continue
		}
		if sha == "" || sha == p.LastCommitSHA {
			continue // up to date
		}

		log.Printf("[poller] %s: new commit %.7s on %s — auto-deploying", p.Name, sha, p.Branch)
		dep := &db.Deployment{
			ID:        db.NewID("dep"),
			ProjectID: p.ID,
			Status:    "queued",
			Trigger:   "auto",
		}
		if err := q.db.CreateDeployment(dep); err != nil {
			log.Printf("[poller] %s: create deployment: %v", p.Name, err)
			continue
		}
		_ = q.db.UpdateDeploymentCommit(dep.ID, sha, msg)
		// Mark the commit as seen up-front so a failing build doesn't loop.
		_ = q.db.UpdateProjectCommit(p.ID, sha)
		_ = q.db.UpdateProjectStatus(p.ID, "building", "")
		q.Enqueue(dep.ID)
	}
}
