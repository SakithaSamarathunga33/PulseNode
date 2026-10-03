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
func (cfg Config) checkComposePolicy(ctx context.Context, dir string) error {
	out, err := runOutput(ctx, dir, "docker", "compose", "-f", "docker-compose.yml",
		"config", "--format", "json", "--no-env-resolution")
	if err != nil {
		return fmt.Errorf("docker-compose.yml could not be parsed: %w", err)
	}
	if problems := composeViolations([]byte(out), dir); len(problems) > 0 {
		return fmt.Errorf("docker-compose.yml uses settings PulseNode does not allow:\n  - %s",
			strings.Join(problems, "\n  - "))
	}
	return nil
}

type composeFile struct {
	Services map[string]composeService `json:"services"`
	Volumes  map[string]struct {
		DriverOpts map[string]string `json:"driver_opts"`
	} `json:"volumes"`
	Secrets map[string]struct {
		File string `json:"file"`
	} `json:"secrets"`
	Configs map[string]struct {
		File string `json:"file"`
	} `json:"configs"`
}

type composeService struct {
	Privileged  bool              `json:"privileged"`
	Pid         string            `json:"pid"`
	Ipc         string            `json:"ipc"`
	Uts         string            `json:"uts"`
	UsernsMode  string            `json:"userns_mode"`
	NetworkMode string            `json:"network_mode"`
	CapAdd      []string          `json:"cap_add"`
	Devices     []json.RawMessage `json:"devices"`
	SecurityOpt []string          `json:"security_opt"`
	VolumesFrom []string          `json:"volumes_from"`
	Labels      map[string]string `json:"labels"`
	Volumes     []struct {
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
	} `json:"build"`
}

// composeViolations returns a human-readable list of disallowed settings in the
// JSON output of `docker compose config`. dir is the cloned repo root.
func composeViolations(raw []byte, dir string) []string {
	var cf composeFile
	if err := json.Unmarshal(raw, &cf); err != nil {
		return []string{"unreadable compose config: " + err.Error()}
	}
	var out []string
	add := func(format string, a ...any) { out = append(out, fmt.Sprintf(format, a...)) }

	for name, s := range cf.Services {
		if s.Privileged {
			add("%s: privileged: true", name)
		}
		for key, v := range map[string]string{"pid": s.Pid, "ipc": s.Ipc, "uts": s.Uts, "userns_mode": s.UsernsMode} {
			if v == "host" {
				add("%s: %s: host", name, key)
			}
		}
		if s.NetworkMode == "host" || strings.HasPrefix(s.NetworkMode, "container:") {
			add("%s: network_mode: %s", name, s.NetworkMode)
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
		for k := range s.Labels {
			if strings.HasPrefix(strings.ToLower(k), "traefik.") {
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
