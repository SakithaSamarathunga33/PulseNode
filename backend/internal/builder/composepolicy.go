package builder

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
)

// A repo's docker-compose.yml runs with PulseNode's Docker socket, so without
// limits anyone who can push to a deployed branch gets host root (privileged,
// pid: host, a bind of / or the socket) or can read the panel's own secrets
// (a build context, env_file or secret file pointing at /workspace/.env.local).
// checkComposePolicy rejects those before `docker compose up`.
//
// project is the fixed compose project name (see composeProject) passed with -p:
// the repo's own top-level `name:` must never choose it, or a repo could name
// itself after the panel (or another app) and take over its services and volumes.
func (cfg Config) checkComposePolicy(ctx context.Context, dir, file, project string) error {
	out, err := runOutput(ctx, dir, "docker", "compose", "-p", project, "-f", file,
		"config", "--format", "json", "--no-env-resolution")
	if err != nil {
		return fmt.Errorf("%s could not be parsed: %w", file, err)
	}
	problems := composeViolations([]byte(out), dir, project)

	// Some compose versions (e.g. v2.36) drop env_file from the output above,
	// so read the paths again uninterpolated; any path still containing "$"
	// (like ${X:-/workspace/.env.local}) is rejected rather than guessed at.
	raw, err := runOutput(ctx, dir, "docker", "compose", "-p", project, "-f", file,
		"config", "--format", "json", "--no-env-resolution", "--no-interpolate")
	if err != nil {
		return fmt.Errorf("%s could not be parsed: %w", file, err)
	}
	problems = append(problems, envFileViolations([]byte(raw), dir)...)

	if len(problems) > 0 {
		return fmt.Errorf("%s uses settings PulseNode does not allow:\n  - %s", file,
			strings.Join(problems, "\n  - "))
	}
	return nil
}

// envFileViolations checks env_file paths in uninterpolated compose JSON.
func envFileViolations(raw []byte, dir string) []string {
	var cf composeFile
	if err := json.Unmarshal(raw, &cf); err != nil {
		return []string{"unreadable compose config: " + err.Error()}
	}
	var out []string
	for name, s := range cf.Services {
		for _, f := range s.EnvFile {
			switch {
			case strings.Contains(f.Path, "$"):
				out = append(out, fmt.Sprintf("%s: env_file must be a literal path, not %s", name, f.Path))
			case !resolvedWithin(dir, f.Path):
				out = append(out, fmt.Sprintf("%s: env_file outside the repository: %s", name, f.Path))
			}
		}
	}
	return out
}

type composeFile struct {
	Name     string                    `json:"name"`
	Services map[string]composeService `json:"services"`
	Volumes  map[string]struct {
		Name       string            `json:"name"`
		External   bool              `json:"external"`
		DriverOpts map[string]string `json:"driver_opts"`
	} `json:"volumes"`
	Networks map[string]struct {
		Name     string `json:"name"`
		External bool   `json:"external"`
		Driver   string `json:"driver"`
	} `json:"networks"`
	Secrets map[string]struct {
		File string `json:"file"`
	} `json:"secrets"`
	Configs map[string]struct {
		File string `json:"file"`
	} `json:"configs"`
}

type composeService struct {
	Privileged   bool              `json:"privileged"`
	Pid          string            `json:"pid"`
	Cgroup       string            `json:"cgroup"`
	Ipc          string            `json:"ipc"`
	Uts          string            `json:"uts"`
	UsernsMode   string            `json:"userns_mode"`
	NetworkMode  string            `json:"network_mode"`
	CapAdd       []string          `json:"cap_add"`
	Devices      []json.RawMessage `json:"devices"`
	SecurityOpt  []string          `json:"security_opt"`
	CgroupParent string            `json:"cgroup_parent"`
	Ports        json.RawMessage   `json:"ports"`
	Sysctls      json.RawMessage   `json:"sysctls"`
	Ulimits      json.RawMessage   `json:"ulimits"`
	ExtraHosts   json.RawMessage   `json:"extra_hosts"`
	VolumesFrom  []string          `json:"volumes_from"`
	Labels       map[string]string `json:"labels"`
	Volumes      []struct {
		Type   string `json:"type"`
		Source string `json:"source"`
	} `json:"volumes"`
	EnvFile []struct {
		Path string `json:"path"`
	} `json:"env_file"`
	Build *struct {
		Context            string            `json:"context"`
		Dockerfile         string            `json:"dockerfile"`
		AdditionalContexts map[string]string `json:"additional_contexts"`
		Network            string            `json:"network"`
		Privileged         bool              `json:"privileged"`
		ExtraHosts         json.RawMessage   `json:"extra_hosts"`
	} `json:"build"`
}

// present reports whether a JSON value carries anything (not absent, null, {} or []).
func present(raw json.RawMessage) bool {
	s := strings.TrimSpace(string(raw))
	return s != "" && s != "null" && s != "{}" && s != "[]"
}

// composeViolations returns a human-readable list of disallowed settings in the
// JSON output of `docker compose config`. dir is the cloned repo root and
// project the compose project name forced with -p.
func composeViolations(raw []byte, dir, project string) []string {
	var cf composeFile
	if err := json.Unmarshal(raw, &cf); err != nil {
		return []string{"unreadable compose config: " + err.Error()}
	}
	var out []string
	add := func(format string, a ...any) { out = append(out, fmt.Sprintf(format, a...)) }

	if project != "" && cf.Name != "" && cf.Name != project {
		add("compose project name must be %s, not %s", project, cf.Name)
	}
	for name, s := range cf.Services {
		if s.Privileged {
			add("%s: privileged: true", name)
		}
		// Sharing a namespace with the host or another container (e.g. go-api,
		// which holds the Docker socket) escapes the sandbox. Private namespaces
		// and ones shared with this project's own services are fine.
		for key, v := range map[string]string{"pid": s.Pid, "ipc": s.Ipc, "uts": s.Uts, "userns_mode": s.UsernsMode, "cgroup": s.Cgroup} {
			if v != "" && v != "private" && v != "shareable" && !strings.HasPrefix(v, "service:") {
				add("%s: %s: %s", name, key, v)
			}
		}
		if s.NetworkMode == "host" || strings.HasPrefix(s.NetworkMode, "container:") {
			add("%s: network_mode: %s", name, s.NetworkMode)
		}
		// Publishing host ports would squat on the host (80/443/8080 …) or expose
		// internals directly; traffic reaches the app through Traefik instead.
		if present(s.Ports) {
			add("%s: ports — publishing host ports is not allowed (PulseNode routes traffic through Traefik; remove ports or use expose)", name)
		}
		if present(s.Sysctls) {
			add("%s: sysctls", name)
		}
		if present(s.Ulimits) {
			add("%s: ulimits", name)
		}
		if present(s.ExtraHosts) {
			add("%s: extra_hosts", name)
		}
		if s.CgroupParent != "" {
			add("%s: cgroup_parent: %s", name, s.CgroupParent)
		}
		if len(s.CapAdd) > 0 {
			add("%s: cap_add: %s", name, strings.Join(s.CapAdd, ", "))
		}
		if len(s.Devices) > 0 {
			add("%s: devices", name)
		}
		for _, o := range s.SecurityOpt {
			if strings.Contains(o, "unconfined") || strings.Contains(o, "disable") {
				add("%s: security_opt: %s", name, o)
			}
		}
		for _, v := range s.VolumesFrom {
			if strings.HasPrefix(v, "container:") {
				add("%s: volumes_from: %s", name, v)
			}
		}
		// Router/service labels could claim another app's or the panel's domain.
		// Harmless ones (traefik.enable, traefik.docker.network) are allowed.
		for k := range s.Labels {
			lk := strings.ToLower(k)
			if strings.HasPrefix(lk, "traefik.http.") || strings.HasPrefix(lk, "traefik.tcp.") || strings.HasPrefix(lk, "traefik.udp.") {
				add("%s: label %s (routing is managed by PulseNode — set the project domain instead)", name, k)
			}
		}
		// Bind sources are host paths. Ones under the clone dir resolve to an
		// empty host directory, which is harmless; anything else is the host.
		for _, v := range s.Volumes {
			switch v.Type {
			case "bind":
				if !lexicallyWithin(dir, v.Source) {
					add("%s: bind mount of host path %s", name, v.Source)
				}
			case "volume", "tmpfs", "":
			default:
				add("%s: volume type %s", name, v.Type)
			}
		}
		// These are read by the compose CLI inside the PulseNode container, so a
		// path outside the repo could read PulseNode's own secrets.
		for _, f := range s.EnvFile {
			if !resolvedWithin(dir, f.Path) {
				add("%s: env_file outside the repository: %s", name, f.Path)
			}
		}
		if b := s.Build; b != nil {
			if b.Privileged {
				add("%s: build.privileged: true", name)
			}
			if b.Network != "" && b.Network != "default" && b.Network != "none" {
				add("%s: build.network: %s", name, b.Network)
			}
			if present(b.ExtraHosts) {
				add("%s: build.extra_hosts", name)
			}
			if !isRemoteContext(b.Context) && !resolvedWithin(dir, b.Context) {
				add("%s: build context outside the repository: %s", name, b.Context)
			}
			for k, c := range b.AdditionalContexts {
				if !isRemoteContext(c) && !strings.HasPrefix(c, "docker-image://") && !strings.HasPrefix(c, "service:") && !resolvedWithin(dir, c) {
					add("%s: additional build context %s outside the repository: %s", name, k, c)
				}
			}
		}
	}
	for name, v := range cf.Volumes {
		if v.DriverOpts["device"] != "" || strings.Contains(v.DriverOpts["o"], "bind") {
			add("volume %s: driver_opts bind-mounts a host path", name)
		}
		// Only volumes owned by this compose project: an external or explicitly
		// named volume could be PulseNode's own (keys, database, backups).
		if v.External || (project != "" && !strings.HasPrefix(v.Name, project+"_")) {
			add("volume %s: external or explicitly named volumes are not allowed (%s)", name, v.Name)
		}
	}
	// Only networks owned by this project. The Traefik network is attached by the
	// overlay PulseNode writes, never by the repo, so no external network is
	// needed — and one could reach the panel or other apps' databases.
	for name, n := range cf.Networks {
		if n.External || (project != "" && !strings.HasPrefix(n.Name, project+"_")) {
			add("network %s: external or explicitly named networks are not allowed (%s)", name, n.Name)
		}
		if n.Driver != "" && n.Driver != "bridge" {
			add("network %s: driver %s", name, n.Driver)
		}
	}
	for name, s := range cf.Secrets {
		if s.File != "" && !resolvedWithin(dir, s.File) {
			add("secret %s: file outside the repository: %s", name, s.File)
		}
	}
	for name, c := range cf.Configs {
		if c.File != "" && !resolvedWithin(dir, c.File) {
			add("config %s: file outside the repository: %s", name, c.File)
		}
	}
	return out
}

func isRemoteContext(c string) bool {
	return strings.Contains(c, "://") || strings.HasPrefix(c, "git@")
}

func lexicallyWithin(dir, p string) bool {
	if !filepath.IsAbs(p) {
		p = filepath.Join(dir, p)
	}
	rel, err := filepath.Rel(dir, filepath.Clean(p))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, "../")
}

// resolvedWithin is lexicallyWithin after following symlinks, so a committed
// symlink like `env -> /workspace/.env.local` can't escape the repo.
func resolvedWithin(dir, p string) bool {
	if !filepath.IsAbs(p) {
		p = filepath.Join(dir, p)
	}
	realDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		realDir = dir
	}
	if real, err := filepath.EvalSymlinks(p); err == nil {
		return lexicallyWithin(realDir, real)
	}
	return lexicallyWithin(dir, p)
}
