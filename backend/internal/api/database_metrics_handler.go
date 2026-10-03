package api

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"
)

type metricItem struct {
	Label string `json:"label"`
	Value string `json:"value"`
	Tone  string `json:"tone,omitempty"`
}

type metricsResponse struct {
	Engine  string       `json:"engine"`
	Metrics []metricItem `json:"metrics"`
}

func (s *Server) databaseMetrics(w http.ResponseWriter, r *http.Request) {
	if !s.requireDocker(w) {
		return
	}
	containerName := chi.URLParam(r, "name")
	ctx := r.Context()

	mdb, err := s.resolveAnyDB(ctx, containerName)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}

	items := []metricItem{} // never nil: a nil slice would serialize as "metrics": null

	// ── Container-level stats (CPU + RAM) via Docker stats API ────────────────
	stat, statErr := s.docker.FetchOneStat(ctx, containerName)
	if statErr == nil {
		cpuTone := "ok"
		if stat.CPU > 80 {
			cpuTone = "bad"
		} else if stat.CPU > 50 {
			cpuTone = "warn"
		}
		ramTone := "ok"
		if stat.RAM > 80 {
			ramTone = "bad"
		} else if stat.RAM > 60 {
			ramTone = "warn"
		}
		items = append(items,
			metricItem{Label: "CPU", Value: fmt.Sprintf("%.1f%%", stat.CPU), Tone: cpuTone},
			metricItem{Label: "RAM", Value: fmt.Sprintf("%.1f%%", stat.RAM), Tone: ramTone},
		)
	}

	pgEnv := []string{"PGPASSWORD=" + mdb.Password}

	// ── Engine-specific metrics ────────────────────────────────────────────────
	switch mdb.Engine {
	case "postgres":
		// Active connections
		if out, err := s.docker.ExecSliceEnv(ctx, containerName, pgEnv, []string{
			"psql", "-U", mdb.Username, "-d", mdb.DBName, "-At", "-c",
			"SELECT count(*) FROM pg_stat_activity WHERE state = 'active';",
		}); err == nil {
			items = append(items, metricItem{Label: "Active Connections", Value: strings.TrimSpace(out), Tone: "info"})
		}
		// Total connections
		if out, err := s.docker.ExecSliceEnv(ctx, containerName, pgEnv, []string{
			"psql", "-U", mdb.Username, "-d", mdb.DBName, "-At", "-c",
			"SELECT count(*) FROM pg_stat_activity;",
		}); err == nil {
			items = append(items, metricItem{Label: "Total Connections", Value: strings.TrimSpace(out), Tone: "info"})
		}
		// Database size
		if out, err := s.docker.ExecSliceEnv(ctx, containerName, pgEnv, []string{
			"psql", "-U", mdb.Username, "-d", mdb.DBName, "-At", "-c",
			fmt.Sprintf("SELECT pg_size_pretty(pg_database_size('%s'));", mdb.DBName),
		}); err == nil {
			items = append(items, metricItem{Label: "DB Size", Value: strings.TrimSpace(out), Tone: "info"})
		}
		// Cache hit ratio
		if out, err := s.docker.ExecSliceEnv(ctx, containerName, pgEnv, []string{
			"psql", "-U", mdb.Username, "-d", mdb.DBName, "-At", "-c",
			"SELECT round(100*sum(blks_hit)::numeric/nullif(sum(blks_hit)+sum(blks_read),0),1)||'%' FROM pg_stat_database;",
		}); err == nil {
			v := strings.TrimSpace(out)
			tone := "ok"
			if pct, err := strconv.ParseFloat(strings.TrimSuffix(v, "%"), 64); err == nil && pct < 90 {
				tone = "warn"
			}
			items = append(items, metricItem{Label: "Cache Hit", Value: v, Tone: tone})
		}
		// Uptime
		if out, err := s.docker.ExecSliceEnv(ctx, containerName, pgEnv, []string{
			"psql", "-U", mdb.Username, "-d", mdb.DBName, "-At", "-c",
			"SELECT date_trunc('second', now() - pg_postmaster_start_time())::text;",
		}); err == nil {
			items = append(items, metricItem{Label: "Uptime", Value: strings.TrimSpace(out), Tone: "ok"})
		}

	case "mysql":
		auth := []string{"-u" + mdb.Username, "-p" + mdb.Password}
		// Connections
		if out, err := s.docker.ExecSlice(ctx, containerName, append(
			[]string{"mysql"}, append(auth, "-N", "-e", "SHOW STATUS LIKE 'Threads_connected';")...,
		)); err == nil {
			parts := strings.Fields(strings.TrimSpace(out))
			if len(parts) >= 2 {
				items = append(items, metricItem{Label: "Connections", Value: parts[len(parts)-1], Tone: "info"})
			}
		}
		// QPS (questions per second approximation via uptime)
		if out, err := s.docker.ExecSlice(ctx, containerName, append(
			[]string{"mysql"}, append(auth, "-N", "-e", "SHOW GLOBAL STATUS WHERE Variable_name IN ('Questions','Uptime');")...,
		)); err == nil {
			vals := map[string]int64{}
			for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
				p := strings.Fields(line)
				if len(p) == 2 {
					n, _ := strconv.ParseInt(p[1], 10, 64)
					vals[p[0]] = n
				}
			}
			if vals["Uptime"] > 0 {
				qps := vals["Questions"] / vals["Uptime"]
				items = append(items, metricItem{Label: "QPS (avg)", Value: fmt.Sprintf("%d", qps), Tone: "info"})
			}
		}
		// DB size
		if out, err := s.docker.ExecSlice(ctx, containerName, append(
			[]string{"mysql"}, append(auth, "-N", "-e",
				fmt.Sprintf("SELECT ROUND(SUM(data_length+index_length)/1024/1024,1) FROM information_schema.tables WHERE table_schema='%s';", mdb.DBName),
			)...,
		)); err == nil {
			v := strings.TrimSpace(out)
			if v != "" && v != "NULL" {
				items = append(items, metricItem{Label: "DB Size", Value: v + " MB", Tone: "info"})
			}
		}
		// Uptime
		if out, err := s.docker.ExecSlice(ctx, containerName, append(
			[]string{"mysql"}, append(auth, "-N", "-e", "SHOW STATUS LIKE 'Uptime_since_flush_status';")...,
		)); err == nil {
			parts := strings.Fields(strings.TrimSpace(out))
			if len(parts) >= 2 {
				secs, _ := strconv.ParseInt(parts[len(parts)-1], 10, 64)
				items = append(items, metricItem{Label: "Uptime", Value: formatSeconds(secs), Tone: "ok"})
			}
		}

	case "mongodb":
		// serverStatus via mongosh
		if out, err := s.docker.ExecSlice(ctx, containerName, []string{
			"mongosh", "--quiet", "--eval",
			`const s=db.adminCommand({serverStatus:1}); print(s.connections.current+"|"+s.connections.available+"|"+Math.round(s.mem.resident)+"MB|"+s.uptime)`,
		}); err == nil {
			parts := strings.Split(strings.TrimSpace(out), "|")
			if len(parts) >= 4 {
				items = append(items,
					metricItem{Label: "Connections", Value: parts[0], Tone: "info"},
					metricItem{Label: "Avail Conns", Value: parts[1], Tone: "info"},
					metricItem{Label: "Resident Mem", Value: parts[2], Tone: "info"},
					metricItem{Label: "Uptime", Value: formatSeconds(parseInt64(parts[3])), Tone: "ok"},
				)
			}
		}

	case "redis":
		redisCmd := []string{"redis-cli"}
		if mdb.Password != "" {
			redisCmd = append(redisCmd, "-a", mdb.Password, "--no-auth-warning")
		}
		if out, err := s.docker.ExecSlice(ctx, containerName, append(redisCmd, "INFO", "all")); err == nil {
			info := parseRedisInfo(out)
			if v, ok := info["connected_clients"]; ok {
				items = append(items, metricItem{Label: "Clients", Value: v, Tone: "info"})
			}
			if v, ok := info["used_memory_human"]; ok {
				items = append(items, metricItem{Label: "Used Memory", Value: v, Tone: "info"})
			}
			if v, ok := info["keyspace_hits"]; ok {
				hits, _ := strconv.ParseInt(v, 10, 64)
				misses, _ := strconv.ParseInt(info["keyspace_misses"], 10, 64)
				total := hits + misses
				if total > 0 {
					pct := float64(hits) * 100 / float64(total)
					tone := "ok"
					if pct < 80 {
						tone = "warn"
					}
					items = append(items, metricItem{Label: "Hit Rate", Value: fmt.Sprintf("%.1f%%", pct), Tone: tone})
				}
			}
			if v, ok := info["uptime_in_seconds"]; ok {
				secs, _ := strconv.ParseInt(v, 10, 64)
				items = append(items, metricItem{Label: "Uptime", Value: formatSeconds(secs), Tone: "ok"})
			}
			if v, ok := info["total_commands_processed"]; ok {
				items = append(items, metricItem{Label: "Commands", Value: v, Tone: "info"})
			}
		}
	}

	writeJSON(w, http.StatusOK, metricsResponse{Engine: mdb.Engine, Metrics: items})
}

// databaseConnections returns [{name, conns}] for all DB containers in parallel.
// Used by the frontend sparkline poller (replaces the Python /database/connections endpoint).
func (s *Server) databaseConnections(w http.ResponseWriter, r *http.Request) {
	if !s.requireDocker(w) {
		return
	}
	ctx := r.Context()
	containers, err := s.docker.DatabaseContainers(ctx)
	if err != nil {
		writeError(w, err)
		return
	}

	type connResult struct {
		Name  string `json:"name"`
		Conns int    `json:"conns"`
	}

	results := make([]connResult, len(containers))
	var wg sync.WaitGroup
	for i, ctr := range containers {
		wg.Add(1)
		go func(i int, name, engine string) {
			defer wg.Done()
			results[i] = connResult{Name: name}
			mdb, err := s.resolveAnyDB(ctx, name)
			if err != nil {
				return
			}
			var out string
			switch engine {
			case "postgres":
				out, _ = s.docker.ExecSliceEnv(ctx, name,
					[]string{"PGPASSWORD=" + mdb.Password},
					[]string{"psql", "-U", mdb.Username, "-d", mdb.DBName, "-At", "-c",
						"SELECT count(*) FROM pg_stat_activity;"})
				n, _ := strconv.Atoi(strings.TrimSpace(out))
				results[i].Conns = n
			case "mysql":
				out, _ = s.docker.ExecSlice(ctx, name,
					[]string{"mysql", "-u" + mdb.Username, "-p" + mdb.Password, "-N", "-e",
						"SHOW STATUS LIKE 'Threads_connected';"})
				parts := strings.Fields(strings.TrimSpace(out))
				if len(parts) >= 2 {
					n, _ := strconv.Atoi(parts[len(parts)-1])
					results[i].Conns = n
				}
			case "mongodb":
				out, _ = s.docker.ExecSlice(ctx, name,
					[]string{"mongosh", "--quiet", "--eval",
						`print(db.adminCommand({serverStatus:1}).connections.current)`})
				n, _ := strconv.Atoi(strings.TrimSpace(out))
				results[i].Conns = n
			case "redis":
				redisCmd := []string{"redis-cli"}
				if mdb.Password != "" {
					redisCmd = append(redisCmd, "-a", mdb.Password, "--no-auth-warning")
				}
				out, _ = s.docker.ExecSlice(ctx, name, append(redisCmd, "CLIENT", "LIST"))
				results[i].Conns = len(strings.Split(strings.TrimSpace(out), "\n"))
			}
		}(i, ctr.Name, ctr.Engine)
	}
	wg.Wait()

	writeJSON(w, http.StatusOK, results)
}

func parseRedisInfo(raw string) map[string]string {
	m := map[string]string{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "#") || line == "" {
			continue
		}
		if i := strings.IndexByte(line, ':'); i >= 0 {
			m[strings.TrimSpace(line[:i])] = strings.TrimSpace(line[i+1:])
		}
	}
	return m
}

func formatSeconds(secs int64) string {
	if secs < 60 {
		return fmt.Sprintf("%ds", secs)
	}
	if secs < 3600 {
		return fmt.Sprintf("%dm %ds", secs/60, secs%60)
	}
	if secs < 86400 {
		return fmt.Sprintf("%dh %dm", secs/3600, (secs%3600)/60)
	}
	return fmt.Sprintf("%dd %dh", secs/86400, (secs%86400)/3600)
}

func parseInt64(s string) int64 {
	n, _ := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	return n
}
