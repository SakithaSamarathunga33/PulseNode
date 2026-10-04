package proxy

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// fakeRunner answers docker calls from a handler and records them.
type fakeRunner struct {
	calls   []string
	handler func(args []string) (string, error)
}

func (f *fakeRunner) Docker(_ context.Context, args ...string) (string, error) {
	f.calls = append(f.calls, strings.Join(args, " "))
	return f.handler(args)
}

func (f *fakeRunner) called(prefix string) bool {
	for _, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			return true
		}
	}
	return false
}

func readyNow(context.Context) error { return nil }

func newTestManager(h func(args []string) (string, error)) (*Manager, *fakeRunner) {
	f := &fakeRunner{handler: h}
	return &Manager{R: f, Ready: readyNow, Timeout: time.Second, SocketPath: "/var/run/docker.sock"}, f
}

func hasPair(args []string, a, b string) bool {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == a && args[i+1] == b {
			return true
		}
	}
	return false
}

func TestRunArgsGolden(t *testing.T) {
	m := &Manager{SocketPath: "/var/run/docker.sock"}
	args := m.runArgs(Options{ACMEEmail: "ops@example.com"})
	joined := strings.Join(args, " ")

	for _, want := range []string{
		"run -d --name pulsenode-traefik --restart unless-stopped --network pulsenode-proxy",
		"--memory 128m",
		"--security-opt no-new-privileges",
		"--log-driver json-file --log-opt max-size=10m --log-opt max-file=3",
		"-p 0.0.0.0:80:80 -p 0.0.0.0:443:443",
		"-v /var/run/docker.sock:/var/run/docker.sock:ro",
		"-v pulsenode-traefik-acme:/acme",
		" traefik:v3.6 ",
		"--providers.docker=true",
		"--providers.docker.exposedbydefault=false",
		"--providers.docker.network=pulsenode-proxy",
		"--entrypoints.web.address=:80",
		"--entrypoints.web.http.redirections.entrypoint.to=websecure",
		"--entrypoints.websecure.address=:443",
		"--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web",
		"--certificatesresolvers.letsencrypt.acme.storage=/acme/acme.json",
		"--certificatesresolvers.letsencrypt.acme.email=ops@example.com",
		"--api=false",
		"--api.dashboard=false",
		"--api.insecure=false",
		"--log.level=WARN",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in\n%s", want, joined)
		}
	}
	for _, bad := range []string{"--api.insecure=true", "--api.dashboard=true", "--api=true", "docker.sock:rw", "--privileged", "--ping"} {
		if strings.Contains(joined, bad) {
			t.Errorf("unexpected %q in %s", bad, joined)
		}
	}
	// The socket must only ever appear read-only.
	for i, a := range args {
		if a == "-v" && strings.Contains(args[i+1], "docker.sock") && !strings.HasSuffix(args[i+1], ":ro") {
			t.Errorf("docker socket mounted read-write: %s", args[i+1])
		}
	}
	if specOf(args) == "" {
		t.Error("spec label missing")
	}
}

func TestRunArgsNoEmail(t *testing.T) {
	m := &Manager{SocketPath: "/s.sock"}
	args := strings.Join(m.runArgs(Options{}), " ")
	if strings.Contains(args, "acme.email") {
		t.Errorf("email flag should be omitted when unset: %s", args)
	}
	if !strings.Contains(args, "-v /s.sock:/var/run/docker.sock:ro") {
		t.Errorf("custom socket path not used: %s", args)
	}
}

func TestSpecChangesWithEmailAndImage(t *testing.T) {
	m := &Manager{SocketPath: "/s"}
	a := specOf(m.runArgs(Options{}))
	b := specOf(m.runArgs(Options{ACMEEmail: "a@b.co"}))
	if a == b {
		t.Fatal("spec hash must change with the e-mail")
	}
	if a != specOf(m.runArgs(Options{})) {
		t.Fatal("spec hash must be stable")
	}
}

func TestEnsureCreatesNetworkAndContainer(t *testing.T) {
	m, f := newTestManager(func(args []string) (string, error) {
		switch args[0] {
		case "network":
			if args[1] == "inspect" {
				return "", errors.New("Error: No such network: pulsenode-proxy")
			}
			return "id", nil
		case "inspect":
			return "", errors.New("Error: No such object: pulsenode-traefik")
		}
		return "cid", nil
	})
	if err := m.Ensure(context.Background(), Options{}); err != nil {
		t.Fatal(err)
	}
	if !f.called("network create --driver bridge") || !f.called("run -d --name pulsenode-traefik") {
		t.Errorf("unexpected calls: %v", f.calls)
	}
}

func TestEnsureIdempotentWhenRunningAndCurrent(t *testing.T) {
	m, f := newTestManager(nil)
	spec := specOf(m.runArgs(Options{}))
	f.handler = func(args []string) (string, error) {
		if args[0] == "inspect" {
			return "true||" + spec, nil
		}
		return "", nil
	}
	if err := m.Ensure(context.Background(), Options{}); err != nil {
		t.Fatal(err)
	}
	if f.called("run ") || f.called("rm ") || f.called("start ") {
		t.Errorf("should not touch a healthy container: %v", f.calls)
	}
}

func TestEnsureStartsStoppedContainer(t *testing.T) {
	m, f := newTestManager(nil)
	spec := specOf(m.runArgs(Options{}))
	f.handler = func(args []string) (string, error) {
		if args[0] == "inspect" {
			return "false||" + spec, nil
		}
		return "", nil
	}
	if err := m.Ensure(context.Background(), Options{}); err != nil {
		t.Fatal(err)
	}
	if !f.called("start pulsenode-traefik") || f.called("run ") {
		t.Errorf("calls: %v", f.calls)
	}
}

func TestEnsureRecreatesOnSpecChange(t *testing.T) {
	m, f := newTestManager(func(args []string) (string, error) {
		if args[0] == "inspect" {
			return "true||oldspec", nil
		}
		return "", nil
	})
	if err := m.Ensure(context.Background(), Options{ACMEEmail: "a@b.co"}); err != nil {
		t.Fatal(err)
	}
	if !f.called("rm -f pulsenode-traefik") || !f.called("run -d") {
		t.Errorf("calls: %v", f.calls)
	}
	// Only ever removes its own container.
	for _, c := range f.calls {
		if strings.HasPrefix(c, "rm ") && !strings.HasSuffix(c, Container) {
			t.Errorf("removed something other than the managed proxy: %s", c)
		}
	}
}

func TestPortConflictMapping(t *testing.T) {
	for _, msg := range []string{
		"docker: Error response from daemon: driver failed programming external connectivity on endpoint pulsenode-traefik: Bind for 0.0.0.0:80 failed: port is already allocated.",
		"listen tcp4 0.0.0.0:443: bind: address already in use",
		"Error response from daemon: ports are not available: exposing port TCP 0.0.0.0:80",
	} {
		m, f := newTestManager(func(args []string) (string, error) {
			switch {
			case args[0] == "inspect":
				return "", errors.New("Error: No such object: pulsenode-traefik")
			case args[0] == "run":
				return "", errors.New(msg)
			}
			return "", nil
		})
		err := m.Ensure(context.Background(), Options{})
		if !IsPortConflict(err) {
			t.Fatalf("%q: want port conflict, got %v", msg, err)
		}
		if !strings.Contains(err.Error(), "ports 80/443 are in use") || !strings.Contains(err.Error(), "Traefik overlay") {
			t.Errorf("message not actionable: %v", err)
		}
		// Cleans up its own half-created container, nothing else.
		if !f.called("rm -f pulsenode-traefik") {
			t.Errorf("leftover container not removed: %v", f.calls)
		}
		for _, c := range f.calls {
			if strings.HasPrefix(c, "kill") || strings.HasPrefix(c, "stop") {
				t.Errorf("must never stop/kill: %s", c)
			}
		}
	}
}

func TestStartConflictMapped(t *testing.T) {
	m, f := newTestManager(nil)
	spec := specOf(m.runArgs(Options{}))
	f.handler = func(args []string) (string, error) {
		switch args[0] {
		case "inspect":
			return "false||" + spec, nil
		case "start":
			return "", errors.New("Bind for 0.0.0.0:80 failed: port is already allocated")
		}
		return "", nil
	}
	if err := m.Ensure(context.Background(), Options{}); !IsPortConflict(err) {
		t.Fatalf("got %v", err)
	}
}

func TestOtherRunErrorNotConflict(t *testing.T) {
	m, _ := newTestManager(func(args []string) (string, error) {
		switch args[0] {
		case "inspect":
			return "", errors.New("No such object")
		case "run":
			return "", errors.New("pull access denied for traefik")
		}
		return "", nil
	})
	err := m.Ensure(context.Background(), Options{})
	if err == nil || IsPortConflict(err) {
		t.Fatalf("got %v", err)
	}
}

func TestWaitReadyTimesOut(t *testing.T) {
	m, _ := newTestManager(func(args []string) (string, error) {
		if args[0] == "inspect" {
			return "true||x", nil
		}
		return "", nil
	})
	m.Timeout = 50 * time.Millisecond
	m.Ready = func(context.Context) error { return errors.New("connection refused") }
	spec := specOf(m.runArgs(Options{}))
	m.R.(*fakeRunner).handler = func(args []string) (string, error) {
		if args[0] == "inspect" {
			return "true||" + spec, nil
		}
		return "", nil
	}
	err := m.Ensure(context.Background(), Options{})
	if err == nil || !strings.Contains(err.Error(), "did not become ready") {
		t.Fatalf("got %v", err)
	}
}

func TestStatusMissingAndRunning(t *testing.T) {
	m, f := newTestManager(func(args []string) (string, error) {
		return "", errors.New("Error: No such object: pulsenode-traefik")
	})
	st, err := m.Status(context.Background())
	if err != nil || st.Exists || st.Running {
		t.Fatalf("missing: %+v %v", st, err)
	}
	f.handler = func(args []string) (string, error) { return "true|a@b.co|abc\n", nil }
	st, err = m.Status(context.Background())
	if err != nil || !st.Running || st.Email != "a@b.co" {
		t.Fatalf("running: %+v %v", st, err)
	}
}

func TestRemoveIgnoresMissing(t *testing.T) {
	m, f := newTestManager(func(args []string) (string, error) {
		return "", errors.New("Error: No such container: pulsenode-traefik")
	})
	if err := m.Remove(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !f.called("rm -f pulsenode-traefik") {
		t.Errorf("calls: %v", f.calls)
	}
	for _, c := range f.calls {
		if strings.Contains(c, "volume") {
			t.Errorf("must keep the ACME volume: %s", c)
		}
	}
}

func TestDetectExternalSkipsManaged(t *testing.T) {
	m, _ := newTestManager(func(args []string) (string, error) {
		switch args[0] {
		case "ps":
			return "pulsenode-traefik\ntraefik\n", nil
		case "inspect":
			if args[1] == "traefik" {
				return "bridge vps-monitor_proxy ", nil
			}
		}
		return "", errors.New("unexpected")
	})
	if got := m.DetectExternal(context.Background()); got != "vps-monitor_proxy" {
		t.Fatalf("got %q", got)
	}

	m, _ = newTestManager(func(args []string) (string, error) {
		if args[0] == "ps" {
			return "pulsenode-traefik\n", nil
		}
		return "", errors.New("unexpected")
	})
	if got := m.DetectExternal(context.Background()); got != "" {
		t.Fatalf("managed proxy must not count as external, got %q", got)
	}
}

func TestRegistrableRoot(t *testing.T) {
	cases := map[string]string{
		"luxe.sakitha.com":      "sakitha.com",
		"sakitha.com":           "sakitha.com",
		"a.b.c.sakitha.com":     "sakitha.com",
		"app.example.co.uk":     "example.co.uk",
		"example.co.uk":         "example.co.uk",
		"co.uk":                 "co.uk",
		"shop.example.com.au":   "example.com.au",
		"site.example.com.lk":   "example.com.lk",
		"LUXE.Sakitha.COM.":     "sakitha.com",
		"localhost":             "localhost",
		"deep.sub.example.io":   "example.io",
		"www.example.org.uk":    "example.org.uk",
		"x.example.co.za":       "example.co.za",
		"  App.Example.co.nz  ": "example.co.nz",
	}
	for in, want := range cases {
		if got := RegistrableRoot(in); got != want {
			t.Errorf("RegistrableRoot(%q) = %q, want %q", in, got, want)
		}
	}
}
