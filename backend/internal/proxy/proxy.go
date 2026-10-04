// Package proxy runs and manages PulseNode's built-in Traefik reverse proxy.
//
// Deployed projects are routed by Traefik labels (see internal/builder). Servers
// that already run Traefik keep using it; on a server without one, this package
// starts a small Traefik container of its own (automatic Let's Encrypt HTTPS) so
// those labels have something to talk to.
//
// The proxy is configured to match the labels the builder emits — never the
// reverse — so external-Traefik setups are unaffected: entrypoint "websecure"
// and certificate resolver "letsencrypt".
package proxy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// Names and tags. EntryPointSecure and CertResolver MUST equal what
// internal/builder writes into every deployed container's Traefik labels.
const (
	Network          = "pulsenode-proxy"
	Container        = "pulsenode-traefik"
	Volume           = "pulsenode-traefik-acme"
	Image            = "traefik:v3.6"
	EntryPointWeb    = "web"
	EntryPointSecure = "websecure"
	CertResolver     = "letsencrypt"
	HTTPPort         = 80
	HTTPSPort        = 443

	labelManaged = "pulsenode.managed"
	labelSpec    = "pulsenode.proxy.spec"
	labelEmail   = "pulsenode.proxy.email"
)

// Runner executes docker CLI commands. It exists so the manager can be tested
// with a fake instead of a real daemon.
type Runner interface {
	// Docker runs `docker <args…>` and returns its combined output. On failure the
	// returned error's message is the command's output.
	Docker(ctx context.Context, args ...string) (string, error)
}

// ExecRunner runs the docker CLI found on PATH (the go-api image ships it and
// talks to the mounted host socket).
type ExecRunner struct{}

type cmdError struct {
	out string
	err error
}

func (e *cmdError) Error() string {
	if s := strings.TrimSpace(e.out); s != "" {
		return s
	}
	return e.err.Error()
}
func (e *cmdError) Unwrap() error { return e.err }

// Docker implements Runner.
func (ExecRunner) Docker(ctx context.Context, args ...string) (string, error) {
	out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	if err != nil {
		return string(out), &cmdError{out: string(out), err: err}
	}
	return string(out), nil
}

// PortConflictError means ports 80/443 are already taken by something else.
type PortConflictError struct{ Detail string }

func (e *PortConflictError) Error() string {
	return "ports 80/443 are in use — free them or use the Traefik overlay"
}

var portConflictRe = regexp.MustCompile(`(?i)port is already allocated|address already in use|bind for [^ ]+ failed|ports are not available`)

// IsPortConflict reports whether err means ports 80/443 are taken.
func IsPortConflict(err error) bool {
	var pc *PortConflictError
	return errors.As(err, &pc)
}

// ExternalTraefikError means another Traefik is already running, so the managed
// proxy would only fight it for ports 80/443.
type ExternalTraefikError struct{ Network string }

func (e *ExternalTraefikError) Error() string {
	return "an existing Traefik is already running (network " + e.Network + ") — PulseNode uses it instead of starting its own proxy"
}

// Options are the user-tunable parts of the managed proxy.
type Options struct {
	ACMEEmail string // optional contact address for Let's Encrypt expiry notices
}

// State is a snapshot of the managed container.
type State struct {
	Exists  bool
	Running bool
	Email   string
}

// Manager creates and supervises the managed proxy container.
type Manager struct {
	R Runner
	// Ready reports whether the proxy answers on port 80. Defaults to a TCP check
	// executed inside the container.
	Ready func(ctx context.Context) error
	// Timeout caps how long Ensure waits for readiness (default 30s).
	Timeout time.Duration
	// SocketPath is the host path of the Docker socket (default /var/run/docker.sock,
	// overridable with PULSENODE_DOCKER_SOCKET).
	SocketPath string
}

// NewManager returns a Manager that drives the local docker CLI.
func NewManager() *Manager { return &Manager{R: ExecRunner{}} }

func (m *Manager) socket() string {
	if m.SocketPath != "" {
		return m.SocketPath
	}
	if v := strings.TrimSpace(os.Getenv("PULSENODE_DOCKER_SOCKET")); v != "" {
		return v
	}
	return "/var/run/docker.sock"
}

// traefikArgs are the static-config flags passed to Traefik. There is no
// dashboard and no API.
func traefikArgs(o Options) []string {
	args := []string{
		"--providers.docker=true",
		"--providers.docker.exposedbydefault=false",
		"--providers.docker.network=" + Network,
		"--entrypoints." + EntryPointWeb + ".address=:80",
		"--entrypoints." + EntryPointWeb + ".http.redirections.entrypoint.to=" + EntryPointSecure,
		"--entrypoints." + EntryPointWeb + ".http.redirections.entrypoint.scheme=https",
		"--entrypoints." + EntryPointSecure + ".address=:443",
		"--certificatesresolvers." + CertResolver + ".acme.httpchallenge=true",
		"--certificatesresolvers." + CertResolver + ".acme.httpchallenge.entrypoint=" + EntryPointWeb,
		"--certificatesresolvers." + CertResolver + ".acme.storage=/acme/acme.json",
	}
	if o.ACMEEmail != "" {
		args = append(args, "--certificatesresolvers."+CertResolver+".acme.email="+o.ACMEEmail)
	}
	return append(args,
		"--api=false",
		"--api.dashboard=false",
		"--api.insecure=false",
		"--log.level=WARN",
		"--global.checknewversion=false",
		"--global.sendanonymoususage=false",
	)
}

// runArgs builds the full `docker run` argument list (without the "docker"
// word). The spec hash label lets Ensure notice when the desired configuration
// changed (new Traefik tag after a panel update, different e-mail) and recreate.
func (m *Manager) runArgs(o Options) []string {
	core := append([]string{
		"-p", fmt.Sprintf("0.0.0.0:%d:80", HTTPPort),
		"-p", fmt.Sprintf("0.0.0.0:%d:443", HTTPSPort),
		"-v", m.socket() + ":/var/run/docker.sock:ro",
		"-v", Volume + ":/acme",
		Image,
	}, traefikArgs(o)...)
	sum := sha256.Sum256([]byte(strings.Join(core, "\x00")))
	spec := hex.EncodeToString(sum[:8])

	args := []string{
		"run", "-d",
		"--name", Container,
		"--restart", "unless-stopped",
		"--network", Network,
		"--memory", "128m",
		"--security-opt", "no-new-privileges",
		"--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
		"--label", labelManaged + "=proxy",
		"--label", labelSpec + "=" + spec,
		"--label", labelEmail + "=" + o.ACMEEmail,
	}
	return append(args, core...)
}

const inspectFormat = `{{.State.Running}}|{{index .Config.Labels "` + labelEmail + `"}}|{{index .Config.Labels "` + labelSpec + `"}}`

func isNoSuch(err error) bool { return strings.Contains(strings.ToLower(err.Error()), "no such") }

// inspect reads the managed container; a missing one yields State{} and no error.
func (m *Manager) inspect(ctx context.Context) (st State, spec string, err error) {
	out, err := m.R.Docker(ctx, "inspect", "-f", inspectFormat, Container)
	if err != nil {
		if isNoSuch(err) {
			return State{}, "", nil
		}
		return State{}, "", err
	}
	st, spec = parseState(out)
	return st, spec, nil
}

// Status inspects the managed container. A missing container is not an error.
func (m *Manager) Status(ctx context.Context) (State, error) {
	st, _, err := m.inspect(ctx)
	return st, err
}

func parseState(out string) (State, string) {
	parts := strings.SplitN(strings.TrimSpace(out), "|", 3)
	st := State{Exists: true}
	spec := ""
	if len(parts) > 0 {
		st.Running = parts[0] == "true"
	}
	if len(parts) > 1 {
		st.Email = parts[1]
	}
	if len(parts) > 2 {
		spec = parts[2]
	}
	return st, spec
}

// DetectExternal returns the Docker network of a running Traefik that is not the
// managed one, or "" if there is none.
func (m *Manager) DetectExternal(ctx context.Context) string {
	out, err := m.R.Docker(ctx, "ps", "--filter", "name=traefik", "--format", "{{.Names}}")
	if err != nil {
		return ""
	}
	for _, name := range strings.Fields(out) {
		if name == Container {
			continue
		}
		nets, err := m.R.Docker(ctx, "inspect", name, "--format", `{{range $k, $_ := .NetworkSettings.Networks}}{{$k}} {{end}}`)
		if err != nil {
			continue
		}
		for _, n := range strings.Fields(nets) {
			if n != "bridge" && n != "host" && n != "none" {
				return n
			}
		}
	}
	return ""
}

func (m *Manager) ensureNetwork(ctx context.Context) error {
	if _, err := m.R.Docker(ctx, "network", "inspect", Network); err == nil {
		return nil
	}
	if _, err := m.R.Docker(ctx, "network", "create", "--driver", "bridge", "--label", labelManaged+"=proxy", Network); err != nil {
		// Lost a race with another creator: fine as long as it exists now.
		if _, ierr := m.R.Docker(ctx, "network", "inspect", Network); ierr == nil {
			return nil
		}
		return fmt.Errorf("create network %s: %w", Network, err)
	}
	return nil
}

// Ensure makes sure the managed proxy is running with the desired options:
// network created, container created (or restarted, or recreated when its spec
// changed) and answering on port 80. It is idempotent and never stops or kills
// any container other than its own. A port clash returns *PortConflictError.
func (m *Manager) Ensure(ctx context.Context, o Options) error {
	if err := m.ensureNetwork(ctx); err != nil {
		return err
	}
	want := m.runArgs(o)
	wantSpec := specOf(want)

	st, spec, err := m.inspect(ctx)
	if err != nil {
		return err
	}
	if st.Exists {
		switch {
		case spec != wantSpec:
			if _, err := m.R.Docker(ctx, "rm", "-f", Container); err != nil {
				return fmt.Errorf("replace proxy container: %w", err)
			}
		case st.Running:
			return m.waitReady(ctx)
		default:
			if _, err := m.R.Docker(ctx, "start", Container); err != nil {
				return mapStartError(err)
			}
			return m.waitReady(ctx)
		}
	}

	if _, err := m.R.Docker(ctx, want...); err != nil {
		// A failed `docker run` leaves a created-but-dead container holding the name.
		_, _ = m.R.Docker(ctx, "rm", "-f", Container)
		return mapStartError(err)
	}
	return m.waitReady(ctx)
}

func specOf(args []string) string {
	for i, a := range args {
		if a == "--label" && i+1 < len(args) && strings.HasPrefix(args[i+1], labelSpec+"=") {
			return strings.TrimPrefix(args[i+1], labelSpec+"=")
		}
	}
	return ""
}

func mapStartError(err error) error {
	if portConflictRe.MatchString(err.Error()) {
		return &PortConflictError{Detail: strings.TrimSpace(err.Error())}
	}
	return fmt.Errorf("start proxy: %w", err)
}

// Remove stops and deletes the managed container. The ACME volume (issued
// certificates) and the network are kept so re-enabling does not re-issue.
func (m *Manager) Remove(ctx context.Context) error {
	if _, err := m.R.Docker(ctx, "rm", "-f", Container); err != nil &&
		!isNoSuch(err) {
		return err
	}
	return nil
}

// waitReady waits until the container is running and port 80 answers.
func (m *Manager) waitReady(ctx context.Context) error {
	timeout := m.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	ready := m.Ready
	if ready == nil {
		ready = m.defaultReady
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var last error
	for {
		if last = ready(ctx); last == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("proxy did not become ready: %w", last)
		case <-time.After(500 * time.Millisecond):
		}
	}
}

// defaultReady checks the container is up and its port 80 accepts connections
// (busybox nc, shipped in the Traefik image — the host's port 80 is not reachable
// from inside the go-api container).
func (m *Manager) defaultReady(ctx context.Context) error {
	out, err := m.R.Docker(ctx, "inspect", "-f", "{{.State.Status}}", Container)
	if err != nil {
		return err
	}
	if s := strings.TrimSpace(out); s != "running" {
		return fmt.Errorf("container is %s", s)
	}
	_, err = m.R.Docker(ctx, "exec", Container, "nc", "-z", "127.0.0.1", "80")
	return err
}
