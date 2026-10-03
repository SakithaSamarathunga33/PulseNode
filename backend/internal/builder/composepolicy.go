package builder

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
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
		Driver     string            `json:"driver"`
		DriverOpts map[string]string `json:"driver_opts"`
	} `json:"volumes"`
	Networks map[string]struct {
		Name     string `json:"name"`
		External bool   `json:"external"`
		Driver   string `json:"driver"`
	} `json:"networks"`
	Secrets map[string]struct {
		File        string `json:"file"`
		Environment string `json:"environment"`
	} `json:"secrets"`
	Configs map[string]struct {
		File        string `json:"file"`
		Environment string `json:"environment"`
	} `json:"configs"`
}

type composeService struct {
	Image   string `json:"image"`
	Logging *struct {
		Driver string `json:"driver"`
	} `json:"logging"`
	ShmSize      json.RawMessage   `json:"shm_size"`
	Deploy       json.RawMessage   `json:"deploy"`
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
		Tags               []string          `json:"tags"`
		CacheFrom          []string          `json:"cache_from"`
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
	var rawTop map[string]json.RawMessage
	_ = json.Unmarshal(raw, &rawTop)
	for k := range rawTop {
		if !topLevelAllowed[k] && !strings.HasPrefix(k, "x-") {
			add("top-level %s is not allowed", k)
		}
	}
	var rawServices map[string]map[string]json.RawMessage
	_ = json.Unmarshal(rawTop["services"], &rawServices)

	for _, name := range sortedKeys(cf.Services) {
		s := cf.Services[name]
		// ALLOW-LIST: any service option not known to be safe is rejected, so a
		// compose feature added after this policy was written (use_api_socket,
		// device_cgroup_rules, provider, runtime, gpus, post_start …) fails closed.
		for _, k := range sortedKeys(rawServices[name]) {
			if serviceAllowed[k] || serviceChecked[k] || strings.HasPrefix(k, "x-") || !meaningful(rawServices[name][k]) {
				continue
			}
			add("%s: %s is not allowed (PulseNode only supports a safe subset of compose service options)", name, k)
		}
		if s.Privileged {
			add("%s: privileged: true", name)
		}
		if s.Logging != nil {
			switch s.Logging.Driver {
			case "", "json-file", "local", "none":
			default:
				add("%s: logging driver %s", name, s.Logging.Driver)
			}
		}
		if meaningful(s.ShmSize) {
			if n, ok := parseBytes(s.ShmSize); !ok || n > maxShmBytes {
				add("%s: shm_size above %d GiB or unreadable", name, maxShmBytes>>30)
			}
		}
		out = append(out, deployViolations(name, s.Deploy)...)
		if s.Image != "" && !imageAllowed(s.Image, project, s.Build != nil) {
			add("%s: image %s (pn-* and pulsenode* images belong to PulseNode and other projects)", name, s.Image)
		}
		// Sharing a namespace with the host or another container (e.g. go-api,
		// which holds the Docker socket) escapes the sandbox. Private namespaces
		// and ones shared with this project's own services are fine.
		for key, v := range map[string]string{"pid": s.Pid, "ipc": s.Ipc, "uts": s.Uts, "userns_mode": s.UsernsMode, "cgroup": s.Cgroup} {
			if v != "" && v != "private" && v != "shareable" && !strings.HasPrefix(v, "service:") {
				add("%s: %s: %s", name, key, v)
			}
		}
		// Only "no network" or sharing another service of THIS project. A bare
		// network name (pulsenode_default, vps-monitor_proxy, bridge) would put the
		// service on the panel's or another app's network.
		if m := s.NetworkMode; m != "" && m != "none" && !strings.HasPrefix(m, "service:") {
			add("%s: network_mode: %s (only none or service:<name> is allowed)", name, m)
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
			var rawBuild map[string]json.RawMessage
			_ = json.Unmarshal(rawServices[name]["build"], &rawBuild)
			for _, k := range sortedKeys(rawBuild) {
				if !buildAllowed[k] && meaningful(rawBuild[k]) {
					add("%s: build.%s is not allowed", name, k)
				}
			}
			for _, t := range b.Tags {
				if !imageAllowed(t, project, true) {
					add("%s: build tag %s must start with %s", name, t, project)
				}
			}
			for _, c := range b.CacheFrom {
				if strings.Contains(c, "src=") || strings.Contains(c, "type=local") {
					add("%s: build.cache_from %s", name, c)
				}
			}
			if d := b.Dockerfile; d != "" && !isRemoteContext(b.Context) && !strings.Contains(d, "://") {
				df := d
				if !filepath.IsAbs(df) {
					df = filepath.Join(b.Context, df)
					if !filepath.IsAbs(df) {
						df = filepath.Join(dir, df)
					}
				}
				if !resolvedWithin(dir, df) {
					add("%s: build.dockerfile outside the repository: %s", name, d)
				}
			}
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
		if v.Driver != "" && v.Driver != "local" {
			add("volume %s: driver %s", name, v.Driver)
		}
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
	// `environment:` sources read a variable of the compose CLI's own environment.
	for _, name := range sortedKeys(cf.Secrets) {
		s := cf.Secrets[name]
		if s.File != "" && !resolvedWithin(dir, s.File) {
			add("secret %s: file outside the repository: %s", name, s.File)
		}
		if s.Environment != "" {
			add("secret %s: environment source %s", name, s.Environment)
		}
	}
	for _, name := range sortedKeys(cf.Configs) {
		c := cf.Configs[name]
		if c.File != "" && !resolvedWithin(dir, c.File) {
			add("config %s: file outside the repository: %s", name, c.File)
		}
		if c.Environment != "" {
			add("config %s: environment source %s", name, c.Environment)
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

// Service/top-level/build options known to be safe. Everything else is rejected
// (see composeViolations); options with their own value checks are in serviceChecked.
var (
	topLevelAllowed = setOf("name", "version", "services", "networks", "volumes", "secrets", "configs")
	serviceAllowed  = setOf("name", "image", "build", "command", "entrypoint", "environment", "env_file",
		"expose", "volumes", "networks", "depends_on", "healthcheck", "restart", "user", "working_dir",
		"labels", "deploy", "stop_signal", "stop_grace_period", "tty", "stdin_open", "init", "hostname",
		"logging", "tmpfs", "read_only", "shm_size", "profiles", "pull_policy", "platform", "links",
		"cap_drop", "mem_limit", "mem_reservation", "cpus", "cpu_shares", "pids_limit", "secrets",
		"configs", "scale")
	serviceChecked = setOf("privileged", "pid", "cgroup", "ipc", "uts", "userns_mode", "network_mode",
		"cap_add", "devices", "security_opt", "cgroup_parent", "ports", "sysctls", "ulimits",
		"extra_hosts", "volumes_from")
	buildAllowed = setOf("context", "dockerfile", "dockerfile_inline", "args", "target", "labels", "tags",
		"platforms", "pull", "no_cache", "cache_from", "additional_contexts", "network", "privileged",
		"extra_hosts", "secrets", "shm_size")
)

const maxShmBytes = 2 << 30

func setOf(keys ...string) map[string]bool {
	m := make(map[string]bool, len(keys))
	for _, k := range keys {
		m[k] = true
	}
	return m
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// meaningful reports whether a JSON value sets anything (compose output carries
// null, false, 0, "", [] and {} for options the file never mentioned).
func meaningful(raw json.RawMessage) bool {
	switch strings.TrimSpace(string(raw)) {
	case "", "null", "false", "0", `""`, "{}", "[]":
		return false
	}
	return true
}

// parseBytes reads a compose size: a number of bytes or a string like 64m / 1g.
func parseBytes(raw json.RawMessage) (int64, bool) {
	s := strings.ToLower(strings.Trim(strings.TrimSpace(string(raw)), `"`))
	mult := int64(1)
	for suffix, m := range map[string]int64{"kb": 1 << 10, "mb": 1 << 20, "gb": 1 << 30, "k": 1 << 10, "m": 1 << 20, "g": 1 << 30, "b": 1} {
		if strings.HasSuffix(s, suffix) {
			s, mult = strings.TrimSuffix(s, suffix), m
			break
		}
	}
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil || n < 0 {
		return 0, false
	}
	return n * mult, true
}

// deployViolations allows only resource limits, replicas and the restart policy
// of the compose `deploy` block (never device reservations or placement).
func deployViolations(service string, raw json.RawMessage) []string {
	if !meaningful(raw) {
		return nil
	}
	var d map[string]json.RawMessage
	if json.Unmarshal(raw, &d) != nil {
		return []string{service + ": deploy is not readable"}
	}
	var out []string
	for _, k := range sortedKeys(d) {
		switch k {
		case "replicas", "restart_policy", "mode":
		case "resources":
			var r map[string]json.RawMessage
			_ = json.Unmarshal(d[k], &r)
			for _, rk := range sortedKeys(r) {
				switch rk {
				case "limits":
				case "reservations":
					var res map[string]json.RawMessage
					_ = json.Unmarshal(r[rk], &res)
					if meaningful(res["devices"]) {
						out = append(out, service+": deploy.resources.reservations.devices")
					}
				default:
					if meaningful(r[rk]) {
						out = append(out, fmt.Sprintf("%s: deploy.resources.%s is not allowed", service, rk))
					}
				}
			}
		default:
			if meaningful(d[k]) {
				out = append(out, fmt.Sprintf("%s: deploy.%s is not allowed", service, k))
			}
		}
	}
	return out
}

// imageAllowed keeps repos from running or overwriting images that belong to
// PulseNode (pulsenode-*) or to other projects (pn-<slug>:<sha> rollback images).
// An image built here (hasBuild) must be named after this project; one that is
// only pulled may be anything except those local names.
func imageAllowed(ref, project string, hasBuild bool) bool {
	r := strings.ToLower(strings.TrimSpace(ref))
	for _, p := range []string{"docker.io/library/", "index.docker.io/library/", "registry-1.docker.io/library/", "library/"} {
		r = strings.TrimPrefix(r, p)
	}
	owned := r == project
	for _, sep := range []string{"-", "/", ":", "@"} {
		owned = owned || strings.HasPrefix(r, project+sep)
	}
	if hasBuild {
		return owned
	}
	seg := r
	if i := strings.IndexAny(seg, "/:@"); i >= 0 {
		seg = seg[:i]
	}
	if strings.HasPrefix(seg, "pn-") || strings.HasPrefix(seg, "pulsenode") {
		return owned
	}
	return true
}
