package queue

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"pulsenode/backend/internal/builder"
	"pulsenode/backend/internal/db"
	"pulsenode/backend/internal/hub"
)

func TestMain(m *testing.M) {
	os.Setenv("AES_KEY", "0123456789abcdef0123456789abcdef")
	os.Exit(m.Run())
}

func testDB(t *testing.T) *db.DB {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "q.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d
}

func addProject(t *testing.T, d *db.DB, id, container string) {
	t.Helper()
	p := &db.Project{ID: id, Name: id, RepoURL: "https://github.com/a/b", Branch: "main", BuildMethod: "auto", Port: 3000, Domain: id + ".example", Status: "running", EnvVars: "{}"}
	if err := d.CreateProject(p); err != nil {
		t.Fatal(err)
	}
	if err := d.UpdateProjectStatus(id, "running", container); err != nil {
		t.Fatal(err)
	}
}

func newQ(d *db.DB, workers int, build buildFunc) *Queue {
	q := New(d, hub.New(), workers)
	q.runBuild = build
	return q
}

func waitDep(t *testing.T, d *db.DB, id, want string) *db.Deployment {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		dep, _ := d.GetDeploymentByID(id)
		if dep != nil && dep.Status == want {
			return dep
		}
		time.Sleep(10 * time.Millisecond)
	}
	dep, _ := d.GetDeploymentByID(id)
	t.Fatalf("deployment %s never reached %q (now %+v)", id, want, dep)
	return nil
}

func newDep(proj string) *db.Deployment {
	return &db.Deployment{ID: db.NewID("dep"), ProjectID: proj, Status: "queued", Trigger: "manual"}
}

func TestSuccessfulDeployKeepsPrevContainerAndFlushesLogs(t *testing.T) {
	d := testDB(t)
	addProject(t, d, "p1", "old-container")
	var gotPrev atomic.Value
	q := newQ(d, 2, func(ctx context.Context, cfg builder.Config, dep *db.Deployment) (builder.Result, error) {
		gotPrev.Store(cfg.PrevContainerID)
		cfg.Log("stdout", "building…")
		return builder.Result{ContainerID: "new-container", CommitSHA: "abc123", CommitMsg: "msg"}, nil
	})
	dep := newDep("p1")
	if err := q.Submit(dep, "", ""); err != nil {
		t.Fatal(err)
	}
	waitDep(t, d, dep.ID, "success")

	// The regression: starting a deploy used to wipe container_id, so the worker
	// always saw PrevContainerID == "".
	if gotPrev.Load() != "old-container" {
		t.Fatalf("PrevContainerID = %v, want old-container", gotPrev.Load())
	}
	p, _ := d.GetProject("p1")
	if p.Status != "running" || p.ContainerID != "new-container" || p.LastCommitSHA != "abc123" {
		t.Fatalf("project after success: %+v", p)
	}
	logs, _ := d.GetLogs(dep.ID)
	if len(logs) < 2 { // "building…" + the success line, flushed on completion
		t.Fatalf("expected flushed logs, got %v", logs)
	}
}

func TestFailedDeployKeepsContainerRef(t *testing.T) {
	d := testDB(t)
	addProject(t, d, "p1", "still-serving")
	q := newQ(d, 1, func(context.Context, builder.Config, *db.Deployment) (builder.Result, error) {
		return builder.Result{}, errors.New("boom")
	})
	dep := newDep("p1")
	if err := q.Submit(dep, "", ""); err != nil {
		t.Fatal(err)
	}
	waitDep(t, d, dep.ID, "failed")
	p, _ := d.GetProject("p1")
	if p.Status != "failed" || p.ContainerID != "still-serving" {
		t.Fatalf("failed deploy must keep container_id: %+v", p)
	}
}

func TestPanicInBuilderFailsDeploymentAndKeepsWorkerAlive(t *testing.T) {
	d := testDB(t)
	addProject(t, d, "p1", "c1")
	addProject(t, d, "p2", "c2")
	q := newQ(d, 1, func(_ context.Context, cfg builder.Config, _ *db.Deployment) (builder.Result, error) {
		if cfg.ProjectID == "p1" {
			panic("kaboom")
		}
		return builder.Result{ContainerID: "ok"}, nil
	})
	d1, d2 := newDep("p1"), newDep("p2")
	_ = q.Submit(d1, "", "")
	_ = q.Submit(d2, "", "")
	waitDep(t, d, d1.ID, "failed")
	waitDep(t, d, d2.ID, "success") // the single worker survived the panic
	p, _ := d.GetProject("p1")
	if p.Status != "failed" || p.ContainerID != "c1" {
		t.Fatalf("p1 after panic: %+v", p)
	}
}

func TestOnlyOneDeployPerProject(t *testing.T) {
	d := testDB(t)
	addProject(t, d, "p1", "c1")
	release := make(chan struct{})
	q := newQ(d, 2, func(ctx context.Context, _ builder.Config, _ *db.Deployment) (builder.Result, error) {
		<-release
		return builder.Result{ContainerID: "n"}, nil
	})
	var ok, busy int32
	var wg sync.WaitGroup
	var firstID atomic.Value
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			dep := newDep("p1")
			switch err := q.Submit(dep, "", ""); {
			case err == nil:
				atomic.AddInt32(&ok, 1)
				firstID.Store(dep.ID)
			case errors.Is(err, ErrBusy):
				atomic.AddInt32(&busy, 1)
			default:
				t.Errorf("unexpected: %v", err)
			}
		}()
	}
	wg.Wait()
	if ok != 1 || busy != 9 {
		t.Fatalf("ok=%d busy=%d, want 1 and 9", ok, busy)
	}
	if !q.Busy() {
		t.Fatal("Busy() should be true while a deploy runs")
	}
	close(release)
	waitDep(t, d, firstID.Load().(string), "success")
	// A finished deploy releases the project for the next one.
	deadline := time.Now().Add(2 * time.Second)
	for q.Busy() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if err := q.Submit(newDep("p1"), "", ""); err != nil {
		t.Fatalf("project should be free again: %v", err)
	}
}

func TestSubmitUnknownProject(t *testing.T) {
	d := testDB(t)
	q := newQ(d, 1, nil)
	if err := q.Submit(newDep("nope"), "", ""); !errors.Is(err, ErrNoProject) {
		t.Fatalf("err = %v, want ErrNoProject", err)
	}
}

func TestQueueFullIsNonBlockingAndReleasesClaim(t *testing.T) {
	d := testDB(t)
	addProject(t, d, "p1", "c1")
	// No workers and a 1-slot buffer: the second enqueue must fail, not block.
	ctx, cancel := context.WithCancel(context.Background())
	q := &Queue{db: d, hub: hub.New(), jobs: make(chan string, 1), baseCtx: ctx, baseCancel: cancel, runBuild: nil}
	defer cancel()
	addProject(t, d, "p2", "c2")

	if err := q.Submit(newDep("p1"), "", ""); err != nil {
		t.Fatal(err)
	}
	dep := newDep("p2")
	done := make(chan error, 1)
	go func() { done <- q.Submit(dep, "", "") }()
	select {
	case err := <-done:
		if !errors.Is(err, ErrQueueFull) {
			t.Fatalf("err = %v, want ErrQueueFull", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Submit blocked on a full queue")
	}
	p, _ := d.GetProject("p2")
	if p.Status != "running" { // claim released back to its previous status
		t.Fatalf("p2 status = %s, want running", p.Status)
	}
	got, _ := d.GetDeploymentByID(dep.ID)
	if got.Status != "failed" {
		t.Fatalf("unqueued deployment status = %s, want failed", got.Status)
	}
	if q.Busy() != true { // p1's job is still pending
		t.Fatal("pending count should still include p1")
	}
}

func TestCloseWaitsForInFlightAndRejectsNewWork(t *testing.T) {
	d := testDB(t)
	addProject(t, d, "p1", "c1")
	started := make(chan struct{})
	q := newQ(d, 1, func(ctx context.Context, _ builder.Config, _ *db.Deployment) (builder.Result, error) {
		close(started)
		time.Sleep(150 * time.Millisecond)
		return builder.Result{ContainerID: "n"}, nil
	})
	dep := newDep("p1")
	_ = q.Submit(dep, "", "")
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := q.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}
	got, _ := d.GetDeploymentByID(dep.ID)
	if got.Status != "success" {
		t.Fatalf("in-flight deploy should finish before Close returns, status=%s", got.Status)
	}
	if err := q.Enqueue("x"); !errors.Is(err, ErrClosed) {
		t.Fatalf("Enqueue after Close = %v, want ErrClosed", err)
	}
}

func TestCloseTimeoutCancelsRunningBuild(t *testing.T) {
	d := testDB(t)
	addProject(t, d, "p1", "c1")
	started := make(chan struct{})
	q := newQ(d, 1, func(ctx context.Context, _ builder.Config, _ *db.Deployment) (builder.Result, error) {
		close(started)
		<-ctx.Done()
		return builder.Result{}, ctx.Err()
	})
	dep := newDep("p1")
	_ = q.Submit(dep, "", "")
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := q.Close(ctx); err == nil {
		t.Fatal("expected deadline error")
	}
	waitDep(t, d, dep.ID, "failed")
	p, _ := d.GetProject("p1")
	if p.ContainerID != "c1" {
		t.Fatalf("aborted deploy must keep container ref, got %q", p.ContainerID)
	}
}

func TestRecoverStuckKeepsNewestPerProject(t *testing.T) {
	d := testDB(t)
	addProject(t, d, "p1", "c1")
	old := &db.Deployment{ID: "dep-old", ProjectID: "p1", Status: "building", Trigger: "manual"}
	newer := &db.Deployment{ID: "dep-new", ProjectID: "p1", Status: "queued", Trigger: "manual"}
	_ = d.CreateDeployment(old)
	time.Sleep(1100 * time.Millisecond) // created_at has 1s resolution
	_ = d.CreateDeployment(newer)
	_ = d.UpdateProjectStatusKeep("p1", "building")

	var ran sync.Map
	q := newQ(d, 1, func(_ context.Context, cfg builder.Config, dep *db.Deployment) (builder.Result, error) {
		ran.Store(dep.ID, true)
		return builder.Result{ContainerID: "n"}, nil
	})
	q.RecoverStuck()
	waitDep(t, d, "dep-new", "success")
	waitDep(t, d, "dep-old", "failed")
	if _, ok := ran.Load("dep-old"); ok {
		t.Fatal("superseded deployment must not run")
	}
}
