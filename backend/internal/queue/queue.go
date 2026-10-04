package queue

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"

	"pulsenode/backend/internal/builder"
	"pulsenode/backend/internal/db"
	"pulsenode/backend/internal/github"
	"pulsenode/backend/internal/hub"
	"pulsenode/backend/internal/proxy"
)

var (
	// ErrBusy: the project already has a queued or running deployment.
	ErrBusy = errors.New("a deployment is already in progress for this project")
	// ErrNoProject: the project to deploy does not exist.
	ErrNoProject = errors.New("project not found")
	// ErrQueueFull: the job buffer is full; callers should answer 503.
	ErrQueueFull = errors.New("deploy queue is full, try again shortly")
	// ErrClosed: the queue is shutting down and accepts no new work.
	ErrClosed = errors.New("deploy queue is shutting down")
)

const (
	queueSize     = 256
	deployTimeout = 30 * time.Minute
)

// buildFunc runs the actual clone/build/deploy; swapped out in tests.
type buildFunc func(ctx context.Context, cfg builder.Config, dep *db.Deployment) (builder.Result, error)

func realBuild(ctx context.Context, cfg builder.Config, dep *db.Deployment) (builder.Result, error) {
	// A rollback redeploys a previously-built image instead of cloning/building.
	if dep.Trigger == "rollback" && dep.ImageTag != "" {
		res, err := builder.RunFromImage(ctx, cfg, dep.ImageTag)
		res.CommitSHA, res.CommitMsg = dep.CommitSHA, dep.CommitMsg // carried from the target deploy
		return res, err
	}
	return builder.Run(ctx, cfg)
}

type Queue struct {
	db   *db.DB
	hub  *hub.Hub
	jobs chan string
	wg   sync.WaitGroup

	// baseCtx parents every deployment's context, so Close can abort in-flight
	// builds if they outlive the shutdown deadline.
	baseCtx    context.Context
	baseCancel context.CancelFunc

	mu     sync.RWMutex // guards closed + sends on jobs (never send after close)
	closed bool

	pending   atomic.Int64 // jobs accepted and not yet finished
	projLocks sync.Map     // projectID -> *sync.Mutex: one deploy per project at a time
	runBuild  buildFunc
}

func New(database *db.DB, events *hub.Hub, workers int) *Queue {
	if workers <= 0 {
		workers = 2
	}
	ctx, cancel := context.WithCancel(context.Background())
	q := &Queue{
		db: database, hub: events, jobs: make(chan string, queueSize),
		baseCtx: ctx, baseCancel: cancel, runBuild: realBuild,
	}
	for i := 0; i < workers; i++ {
		q.wg.Add(1)
		go q.worker()
	}
	return q
}

// Busy reports whether any deployment is queued or running (the self-updater
// refuses to restart the stack underneath a build).
func (q *Queue) Busy() bool { return q.pending.Load() > 0 }

// Close stops intake and waits for in-flight deployments. Jobs that have not
// started are left "queued" in the DB and recovered on the next boot. If ctx
// expires first, running builds are cancelled and ctx.Err() is returned.
func (q *Queue) Close(ctx context.Context) error {
	q.mu.Lock()
	if !q.closed {
		q.closed = true
		close(q.jobs)
	}
	q.mu.Unlock()

	done := make(chan struct{})
	go func() { q.wg.Wait(); close(done) }()
	select {
	case <-done:
		q.baseCancel()
		return nil
	case <-ctx.Done():
		q.baseCancel() // abort running builds; workers then mark them failed
		select {
		case <-done:
		case <-time.After(5 * time.Second):
		}
		return ctx.Err()
	}
}

// Enqueue hands an existing deployment to the workers without blocking.
func (q *Queue) Enqueue(deploymentID string) error {
	q.mu.RLock()
	defer q.mu.RUnlock()
	if q.closed {
		return ErrClosed
	}
	q.pending.Add(1)
	select {
	case q.jobs <- deploymentID:
		return nil
	default:
		q.pending.Add(-1)
		return ErrQueueFull
	}
}

// Submit atomically claims the project (so two deploys can never run for one
// project), creates the deployment record and enqueues it. The project's
// container_id is preserved so the worker can still retire the old container
// and a failed deploy keeps pointing at the one that is still serving.
// commitSHA/commitMsg are optional display metadata.
func (q *Queue) Submit(dep *db.Deployment, commitSHA, commitMsg string) error {
	prev, claimed, err := q.db.ClaimProjectForDeploy(dep.ProjectID)
	if err != nil {
		return err
	}
	if !claimed {
		if prev == "" {
			return ErrNoProject
		}
		return ErrBusy
	}
	release := func() {
		if err := q.db.UpdateProjectStatusKeep(dep.ProjectID, prev); err != nil {
			log.Printf("[queue] release claim on %s: %v", dep.ProjectID, err)
		}
	}
	if err := q.db.CreateDeployment(dep); err != nil {
		release()
		return err
	}
	if commitSHA != "" {
		q.logErr("record commit", q.db.UpdateDeploymentCommit(dep.ID, commitSHA, commitMsg))
	}
	if dep.Trigger == "rollback" && dep.CommitSHA != "" {
		q.logErr("record rollback commit", q.db.UpdateDeploymentCommit(dep.ID, dep.CommitSHA, dep.CommitMsg))
	}
	if err := q.Enqueue(dep.ID); err != nil {
		now := time.Now()
		q.logErr("fail unqueued deployment", q.db.UpdateDeploymentStatus(dep.ID, "failed", &now, &now))
		release()
		return err
	}
	return nil
}

// RecoverStuck re-queues deployments left queued/building by a crash or restart
// (only the newest per project — older ones are superseded) and resets projects
// whose deploy vanished. Call once at startup.
func (q *Queue) RecoverStuck() {
	if n, err := q.db.ResetStuckProjects(); err != nil {
		log.Printf("[queue] reset stuck projects: %v", err)
	} else if n > 0 {
		log.Printf("[queue] reset %d project(s) stuck in building/queued", n)
	}

	deps, err := q.db.GetQueuedDeployments() // oldest first
	if err != nil {
		log.Printf("[queue] recover: %v", err)
		return
	}
	newest := map[string]string{}
	for _, d := range deps {
		newest[d.ProjectID] = d.ID
	}
	var ids []string
	for _, d := range deps {
		if newest[d.ProjectID] != d.ID {
			now := time.Now()
			log.Printf("[queue] deployment %s superseded by %s after restart", d.ID, newest[d.ProjectID])
			q.logErr("supersede deployment", q.db.UpdateDeploymentStatus(d.ID, "failed", &now, &now))
			continue
		}
		ids = append(ids, d.ID)
	}
	// Feed the queue without ever blocking startup: retry until accepted.
	go func() {
		for _, id := range ids {
			log.Printf("[queue] recovering deployment %s", id)
			for {
				err := q.Enqueue(id)
				if err == nil || errors.Is(err, ErrClosed) {
					break
				}
				select {
				case <-time.After(2 * time.Second):
				case <-q.baseCtx.Done():
					return
				}
			}
		}
	}()
}

func (q *Queue) logErr(what string, err error) {
	if err != nil {
		log.Printf("[queue] %s: %v", what, err)
	}
}

// setting reads one settings-table value; unset or unreadable is "".
func (q *Queue) setting(key string) string {
	v, err := q.db.GetSetting(key)
	q.logErr("read setting "+key, err)
	return v
}

func (q *Queue) worker() {
	defer q.wg.Done()
	for depID := range q.jobs {
		q.mu.RLock()
		stopping := q.closed
		q.mu.RUnlock()
		if stopping || q.baseCtx.Err() != nil {
			// Shutting down: leave the deployment "queued" so the next boot resumes it.
			q.pending.Add(-1)
			continue
		}
		q.safeRun(depID)
		q.pending.Add(-1)
	}
}

// safeRun keeps a worker alive no matter what runDeployment does.
func (q *Queue) safeRun(depID string) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[queue] worker recovered from panic on %s: %v\n%s", depID, r, debug.Stack())
		}
	}()
	q.runDeployment(depID)
}

func (q *Queue) projectLock(id string) *sync.Mutex {
	m, _ := q.projLocks.LoadOrStore(id, &sync.Mutex{})
	return m.(*sync.Mutex)
}

func (q *Queue) runDeployment(depID string) {
	dep, err := q.db.GetDeploymentByID(depID)
	if err != nil {
		log.Printf("[queue] deployment %s lookup failed: %v", depID, err)
		now := time.Now()
		q.logErr("fail deployment", q.db.UpdateDeploymentStatus(depID, "failed", &now, &now))
		return
	}
	if dep == nil {
		log.Printf("[queue] deployment %s not found", depID)
		return
	}

	// One deploy per project at a time, even for stale recovered duplicates.
	pl := q.projectLock(dep.ProjectID)
	pl.Lock()
	defer pl.Unlock()

	lw := q.db.NewLogWriter(depID)
	defer lw.Close()

	emit := func(stream, line string) {
		lw.Add(stream, line)
		q.hub.Broadcast("deploy:log", map[string]any{
			"deploymentId": depID,
			"stream":       stream,
			"line":         line,
			"ts":           time.Now().Format(time.RFC3339),
		})
	}

	startedAt := time.Now()
	fail := func(msg string) {
		emit("system", msg)
		finished := time.Now()
		q.logErr("mark deployment failed", q.db.UpdateDeploymentStatus(depID, "failed", &startedAt, &finished))
		// Zero-downtime: the previous container is still serving on a failed
		// deploy, so only the status changes — container_id stays.
		q.logErr("mark project failed", q.db.UpdateProjectStatusKeep(dep.ProjectID, "failed"))
	}

	// Registered after lw.Close so it runs first: a panic in the builder must
	// fail this deployment (and flush its log) instead of killing the process.
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[queue] panic in deployment %s: %v\n%s", depID, r, debug.Stack())
			fail(fmt.Sprintf("✕ Internal error: %v", r))
		}
	}()

	q.logErr("mark deployment building", q.db.UpdateDeploymentStatus(depID, "building", &startedAt, nil))

	proj, err := q.db.GetProject(dep.ProjectID)
	if err != nil {
		fail("✕ Could not load project: " + err.Error())
		return
	}
	if proj == nil {
		fail("✕ Project not found")
		return
	}

	token := ""
	acct, err := q.db.GetGitHubAccount()
	if err != nil {
		log.Printf("[queue] github account lookup: %v", err)
		emit("system", "! Could not read the connected GitHub account — building without credentials")
	} else if acct != nil {
		token = acct.AccessToken
	}

	ctx, cancel := context.WithTimeout(q.baseCtx, deployTimeout)
	defer cancel()

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
		ManagedProxyOff: !proxy.Enabled(q.setting(proxy.SettingManaged)),
		ACMEEmail:       q.setting(proxy.SettingACMEEmail),
		PrevContainerID: proj.ContainerID,
		Log:             emit,
	}

	res, buildErr := q.runBuild(ctx, cfg, dep)

	// Record the commit that was built (even on failure, for history/diagnostics).
	if res.CommitSHA != "" {
		q.logErr("record commit", q.db.UpdateDeploymentCommit(depID, res.CommitSHA, res.CommitMsg))
	}

	if buildErr != nil {
		fail("✕ Build failed: " + buildErr.Error())
		return
	}

	if res.ImageTag != "" {
		q.logErr("record image", q.db.UpdateDeploymentImage(depID, res.ImageTag))
	}
	// Project first, deployment status last, in ONE transaction: nothing can
	// observe a "successful" deployment on a project still "building", and a
	// crash cannot leave the two disagreeing.
	if err := q.db.CompleteDeployment(depID, proj.ID, res.ContainerID, res.CommitSHA, startedAt, time.Now()); err != nil {
		fail("✕ Deployed, but recording the result failed: " + err.Error())
		return
	}
	emit("system", "=== Deployment Successful ===")
}

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
	if err != nil {
		log.Printf("[poller] github account: %v", err)
		return
	}
	if acct == nil {
		return // no GitHub connection → nothing to poll
	}
	projects, err := q.db.ListProjects()
	if err != nil {
		log.Printf("[poller] list projects: %v", err)
		return
	}
	client := github.NewClient(acct.AccessToken) // 10s HTTP timeout per request
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

		dep := &db.Deployment{ID: db.NewID("dep"), ProjectID: p.ID, Status: "queued", Trigger: "auto"}
		switch err := q.Submit(dep, sha, msg); {
		case err == nil:
			log.Printf("[poller] %s: new commit %.7s on %s — auto-deploying", p.Name, sha, p.Branch)
			// Mark the commit as seen up-front so a failing build doesn't loop.
			q.logErr("poller baseline commit", q.db.UpdateProjectCommit(p.ID, sha))
		case errors.Is(err, ErrBusy):
			// A webhook/manual deploy got there first; re-check next tick.
		case errors.Is(err, ErrQueueFull), errors.Is(err, ErrClosed):
			log.Printf("[poller] %s: not queued: %v", p.Name, err)
			return
		default:
			log.Printf("[poller] %s: submit: %v", p.Name, err)
		}
	}
}
