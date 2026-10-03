package docker

import (
	"os"
	"regexp"
	"strconv"
	"strings"
)

// Managed-database containers are created by PulseNode, so — like deployed apps —
// they get ceilings so one runaway database cannot starve the host, rotated logs so
// a chatty one cannot fill the disk, and no-new-privileges. These apply when a
// container is CREATED; existing containers are not touched.
//
// Knobs (all optional): PULSENODE_DB_MEMORY overrides the per-engine memory
// default for every database ("0" or "unlimited" removes the limit) and
// PULSENODE_DB_PIDS overrides the 4096 process/thread limit (same off switch).

const dbDefaultPids = 4096

// dbMemoryDefault is generous on purpose: a limit that is too tight turns a busy
// database into an OOM-kill loop. The JVM/column stores need more headroom.
func dbMemoryDefault(kind string) string {
	switch kind {
	case "redis":
		return "512m"
	case "clickhouse", "cassandra", "elasticsearch":
		return "2g"
	default: // postgres, mysql, mongodb
		return "1g"
	}
}

var memRe = regexp.MustCompile(`(?i)^([0-9]+(?:\.[0-9]+)?)\s*(b|k|kb|m|mb|g|gb)?$`)

// parseMemBytes reads "512m", "1g", "1.5g" or a plain byte count.
func parseMemBytes(s string) (int64, bool) {
	m := memRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0, false
	}
	f, err := strconv.ParseFloat(m[1], 64)
	if err != nil || f <= 0 {
		return 0, false
	}
	mult := float64(1)
	switch strings.ToLower(m[2]) {
	case "k", "kb":
		mult = 1 << 10
	case "m", "mb":
		mult = 1 << 20
	case "g", "gb":
		mult = 1 << 30
	}
	n := int64(f * mult)
	if n < 4<<20 { // Docker refuses less than 4 MiB; treat as a typo, not a limit
		return 0, false
	}
	return n, true
}

func offValue(v string) bool { return v == "0" || strings.EqualFold(v, "unlimited") }

// dbHostConfigHardening returns the HostConfig fields added to a new database
// container for the given image.
func dbHostConfigHardening(image string) map[string]any {
	kind, _, _ := dbMeta(image)
	hc := map[string]any{
		"SecurityOpt": []string{"no-new-privileges"},
		"LogConfig": map[string]any{
			"Type":   "json-file",
			"Config": map[string]string{"max-size": "10m", "max-file": "3"},
		},
	}

	mem := strings.TrimSpace(os.Getenv("PULSENODE_DB_MEMORY"))
	if mem == "" {
		mem = dbMemoryDefault(kind)
	}
	if !offValue(mem) {
		if n, ok := parseMemBytes(mem); ok {
			hc["Memory"] = n
		}
	}

	pids := strings.TrimSpace(os.Getenv("PULSENODE_DB_PIDS"))
	if pids == "" {
		hc["PidsLimit"] = int64(dbDefaultPids)
	} else if !offValue(pids) {
		if n, err := strconv.ParseInt(pids, 10, 64); err == nil && n > 0 {
			hc["PidsLimit"] = n
		}
	}
	return hc
}
