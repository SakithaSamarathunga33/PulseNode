package api

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	dbpkg "pulsenode/backend/internal/db"
)

// resolveManagedDB resolves a PulseNode-provisioned container (pn-db-{engine}-{name}) to its DB record.
func (s *Server) resolveManagedDB(containerName string) (*dbpkg.ManagedDatabase, error) {
	stripped := strings.TrimPrefix(containerName, "pn-db-")
	var engine, name string
	for _, eng := range []string{"postgres", "mysql", "mongodb", "redis"} {
		if strings.HasPrefix(stripped, eng+"-") {
			engine = eng
			name = strings.TrimPrefix(stripped, eng+"-")
			break
		}
	}
	if engine == "" || name == "" {
		return nil, fmt.Errorf("container %q is not a PulseNode-managed database", containerName)
	}
	m, err := s.db.GetManagedDatabaseByContainerName(engine, name)
	if err != nil {
		return nil, err
	}
	if m == nil {
		return nil, fmt.Errorf("no managed database record found for container %q", containerName)
	}
	return m, nil
}

// resolveAnyDB resolves credentials for any database container — PulseNode-managed or external
// (Coolify-provisioned, manually installed, etc.). For external containers it reads standard
// engine env vars (POSTGRES_USER, MYSQL_ROOT_PASSWORD, etc.) via Docker inspect.
func (s *Server) resolveAnyDB(ctx context.Context, containerName string) (*dbpkg.ManagedDatabase, error) {
	if m, err := s.resolveManagedDB(containerName); err == nil {
		return m, nil
	}
	if s.docker == nil {
		return nil, fmt.Errorf("docker not available")
	}
	image, env, err := s.docker.ContainerInfo(ctx, containerName)
	if err != nil {
		return nil, fmt.Errorf("container %q not found", containerName)
	}
	engine := engineFromImage(image)
	m := &dbpkg.ManagedDatabase{Name: containerName, Engine: engine}
	switch engine {
	case "postgres":
		m.Username = firstEnv(env, "POSTGRES_USER", "POSTGRESQL_USERNAME", "DB_USER", "DB_USERNAME")
		if m.Username == "" {
			m.Username = "postgres"
		}
		m.Password = firstEnv(env, "POSTGRES_PASSWORD", "POSTGRESQL_PASSWORD", "DB_PASSWORD")
		m.DBName = firstEnv(env, "POSTGRES_DB", "POSTGRESQL_DATABASE", "DB_DATABASE", "DB_NAME")
		if m.DBName == "" {
			m.DBName = m.Username
		}
	case "mysql":
		m.Username = firstEnv(env, "MYSQL_USER", "DB_USER", "DB_USERNAME")
		if m.Username == "" {
			m.Username = "root"
		}
		if m.Username == "root" {
			m.Password = firstEnv(env, "MYSQL_ROOT_PASSWORD", "MYSQL_PASSWORD", "DB_PASSWORD")
		} else {
			m.Password = firstEnv(env, "MYSQL_PASSWORD", "MYSQL_ROOT_PASSWORD", "DB_PASSWORD")
		}
		m.DBName = firstEnv(env, "MYSQL_DATABASE", "DB_DATABASE", "DB_NAME")
	case "mongodb":
		m.Username = firstEnv(env, "MONGO_INITDB_ROOT_USERNAME", "MONGODB_USERNAME", "DB_USER")
		m.Password = firstEnv(env, "MONGO_INITDB_ROOT_PASSWORD", "MONGODB_PASSWORD", "DB_PASSWORD")
		m.DBName = firstEnv(env, "MONGO_INITDB_DATABASE", "MONGODB_DATABASE", "DB_NAME")
		if m.DBName == "" {
			m.DBName = "admin"
		}
	case "redis":
		m.Password = firstEnv(env, "REDIS_PASSWORD", "REDIS_PASS", "REQUIREPASS")
		m.DBName = "0"
	}
	return m, nil
}

func engineFromImage(image string) string {
	lower := strings.ToLower(image)
	switch {
	case strings.Contains(lower, "mysql"), strings.Contains(lower, "mariadb"):
		return "mysql"
	case strings.Contains(lower, "redis"):
		return "redis"
	case strings.Contains(lower, "mongo"):
		return "mongodb"
	default:
		return "postgres"
	}
}

func firstEnv(env map[string]string, keys ...string) string {
	for _, k := range keys {
		if v := env[k]; v != "" {
			return v
		}
	}
	return ""
}

type dbSchemaResult struct {
	Databases []string      `json:"databases"`
	Tables    []dbTableInfo `json:"tables"`
}

type dbTableInfo struct {
	Name string `json:"name"`
	Rows int    `json:"rows"`
}

type dbQueryResult struct {
	Columns    []string        `json:"columns"`
	Rows       [][]interface{} `json:"rows"`
	RowCount   int             `json:"rowCount"`
	DurationMs int64           `json:"durationMs"`
}

func (s *Server) databaseConnectionString(w http.ResponseWriter, r *http.Request) {
	containerName := chi.URLParam(r, "name")
	mdb, err := s.resolveAnyDB(r.Context(), containerName)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	dbParam := r.URL.Query().Get("database")
	writeJSON(w, http.StatusOK, map[string]string{"connectionString": buildConnString(mdb, dbParam)})
}

func (s *Server) databaseSchema(w http.ResponseWriter, r *http.Request) {
	if !s.requireDocker(w) {
		return
	}
	containerName := chi.URLParam(r, "name")
	mdb, err := s.resolveAnyDB(r.Context(), containerName)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}

	dbParam := r.URL.Query().Get("database")
	if dbParam == "" {
		dbParam = mdb.DBName
	}

	ctx := r.Context()
	result := dbSchemaResult{Databases: []string{mdb.DBName}, Tables: []dbTableInfo{}}

	pgEnv := []string{"PGPASSWORD=" + mdb.Password}

	switch mdb.Engine {
	case "postgres":
		if out, err := s.docker.ExecSliceEnv(ctx, containerName, pgEnv, []string{
			"psql", "-U", mdb.Username, "-d", mdb.DBName, "-At", "-c",
			"SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname;",
		}); err == nil {
			dbs := []string{}
			seen := map[string]bool{}
			for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
				if line = strings.TrimSpace(line); line != "" && !seen[line] {
					seen[line] = true
					dbs = append(dbs, line)
				}
			}
			if len(dbs) > 0 {
				result.Databases = dbs
			}
		}
		// Fetch table names + estimated row counts in one query via pg_stat_user_tables.
		// n_live_tup is a planner estimate (updated by autovacuum) — fast and accurate enough for display.
		if out, err := s.docker.ExecSliceEnv(ctx, containerName, pgEnv, []string{
			"psql", "-U", mdb.Username, "-d", dbParam, "-At", "-F", "|", "-c",
			"SELECT t.tablename, COALESCE(s.n_live_tup, 0) FROM pg_tables t LEFT JOIN pg_stat_user_tables s ON s.relname=t.tablename WHERE t.schemaname='public' ORDER BY t.tablename;",
		}); err == nil {
			for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
				if line = strings.TrimSpace(line); line != "" {
					parts := strings.SplitN(line, "|", 2)
					name := parts[0]
					rows := 0
					if len(parts) == 2 {
						fmt.Sscanf(parts[1], "%d", &rows)
					}
					result.Tables = append(result.Tables, dbTableInfo{Name: name, Rows: rows})
				}
			}
		}

	case "mysql":
		if out, err := s.docker.ExecSlice(ctx, containerName, []string{
			"mysql", "-u" + mdb.Username, "-p" + mdb.Password, "-N", "-e", "SHOW DATABASES;",
		}); err == nil {
			skip := map[string]bool{"information_schema": true, "performance_schema": true, "mysql": true, "sys": true}
			for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
				if line = strings.TrimSpace(line); line != "" && !skip[line] {
					result.Databases = append(result.Databases, line)
				}
			}
		}
		if out, err := s.docker.ExecSlice(ctx, containerName, []string{
			"mysql", "-u" + mdb.Username, "-p" + mdb.Password, "-N", "-e", "SHOW TABLES;", dbParam,
		}); err == nil {
			for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
				if line = strings.TrimSpace(line); line != "" {
					result.Tables = append(result.Tables, dbTableInfo{Name: line})
				}
			}
		}

	case "mongodb":
		if out, err := s.docker.ExecSlice(ctx, containerName, []string{
			"mongosh", "--quiet", "--eval",
			`db.adminCommand({listDatabases:1}).databases.map(d=>d.name).join("\n")`,
		}); err == nil {
			for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
				if line = strings.TrimSpace(line); line != "" {
					result.Databases = append(result.Databases, line)
				}
			}
		}
		if out, err := s.docker.ExecSlice(ctx, containerName, []string{
			"mongosh", dbParam, "--quiet", "--eval",
			`db.getCollectionNames().join("\n")`,
		}); err == nil {
			for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
				if line = strings.TrimSpace(line); line != "" {
					result.Tables = append(result.Tables, dbTableInfo{Name: line})
				}
			}
		}

		// Redis has no schema
	}

	writeJSON(w, http.StatusOK, result)
}

func (s *Server) databaseQuery(w http.ResponseWriter, r *http.Request) {
	if !s.requireDocker(w) {
		return
	}
	containerName := chi.URLParam(r, "name")
	mdb, err := s.resolveAnyDB(r.Context(), containerName)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}

	var body struct {
		Query    string `json:"query"`
		Database string `json:"database"`
		Force    bool   `json:"force"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Query) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "query is required"})
		return
	}

	dbParam := body.Database
	if dbParam == "" {
		dbParam = mdb.DBName
	}

	// Warn on destructive queries unless force=true
	if !body.Force && isDestructiveQuery(body.Query) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "destructive query — confirm to proceed"})
		return
	}

	ctx := r.Context()
	start := time.Now()
	var qResult *dbQueryResult
	var qErr error

	switch mdb.Engine {
	case "postgres":
		qResult, qErr = s.runPostgresQuery(ctx, containerName, mdb, dbParam, body.Query)
	case "mysql":
		qResult, qErr = s.runMysqlQuery(ctx, containerName, mdb, dbParam, body.Query)
	case "redis":
		qResult, qErr = s.runRedisCommand(ctx, containerName, mdb, body.Query)
	case "mongodb":
		qResult, qErr = s.runMongoQuery(ctx, containerName, dbParam, body.Query)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("query not supported for engine %q", mdb.Engine)})
		return
	}

	if qErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": qErr.Error()})
		return
	}
	qResult.DurationMs = time.Since(start).Milliseconds()
	writeJSON(w, http.StatusOK, qResult)
}

// isDestructiveQuery is a UX nicety, NOT a security control: a substring match
// that asks the user to confirm before an obviously destructive statement. It is
// trivially bypassed (DROP\ttable, a comment or newline after the keyword, other
// engines' syntax) and must never be relied on to stop a query — the query
// endpoint runs with the database's own credentials, behind the admin login.
func isDestructiveQuery(query string) bool {
	upper := strings.ToUpper(strings.TrimSpace(query))
	for _, kw := range []string{"DROP ", "TRUNCATE ", "DELETE ", "UPDATE "} {
		if strings.Contains(upper, kw) {
			return true
		}
	}
	return false
}

func (s *Server) runPostgresQuery(ctx context.Context, container string, mdb *dbpkg.ManagedDatabase, dbName, query string) (*dbQueryResult, error) {
	out, err := s.docker.ExecSliceEnv(ctx, container, []string{"PGPASSWORD=" + mdb.Password}, []string{
		"psql", "-U", mdb.Username, "-d", dbName, "--csv", "-c", query,
	})
	if err != nil {
		return nil, fmt.Errorf("exec: %w", err)
	}
	trimmed := strings.TrimSpace(out)
	if strings.HasPrefix(trimmed, "ERROR:") || strings.HasPrefix(trimmed, "FATAL:") {
		return nil, fmt.Errorf("%s", trimmed)
	}
	// DDL/DML: single-word response like "CREATE TABLE" or "INSERT 0 1"
	if !strings.Contains(trimmed, "\n") {
		return &dbQueryResult{Columns: []string{}, Rows: [][]interface{}{}, RowCount: 0}, nil
	}
	return parseCSVResult(trimmed)
}

func (s *Server) runMysqlQuery(ctx context.Context, container string, mdb *dbpkg.ManagedDatabase, dbName, query string) (*dbQueryResult, error) {
	out, err := s.docker.ExecSlice(ctx, container, []string{
		"mysql", "-u" + mdb.Username, "-p" + mdb.Password, "--batch", "--silent", "-e", query, dbName,
	})
	if err != nil {
		return nil, fmt.Errorf("exec: %w", err)
	}
	trimmed := strings.TrimSpace(out)
	if trimmed == "" {
		return &dbQueryResult{Columns: []string{}, Rows: [][]interface{}{}, RowCount: 0}, nil
	}
	if strings.HasPrefix(trimmed, "ERROR") {
		return nil, fmt.Errorf("%s", trimmed)
	}
	return parseTSVResult(trimmed)
}

func (s *Server) runRedisCommand(ctx context.Context, container string, mdb *dbpkg.ManagedDatabase, command string) (*dbQueryResult, error) {
	parts := strings.Fields(strings.TrimSpace(command))
	if len(parts) == 0 {
		return nil, fmt.Errorf("empty command")
	}
	cmd := []string{"redis-cli"}
	if mdb.Password != "" {
		cmd = append(cmd, "-a", mdb.Password, "--no-auth-warning")
	}
	cmd = append(cmd, parts...)
	out, err := s.docker.ExecSlice(ctx, container, cmd)
	if err != nil {
		return nil, fmt.Errorf("exec: %w", err)
	}
	return &dbQueryResult{
		Columns:  []string{"result"},
		Rows:     [][]interface{}{{strings.TrimSpace(out)}},
		RowCount: 1,
	}, nil
}

func (s *Server) runMongoQuery(ctx context.Context, container, dbName, query string) (*dbQueryResult, error) {
	out, err := s.docker.ExecSlice(ctx, container, []string{
		"mongosh", dbName, "--quiet", "--eval", query,
	})
	if err != nil {
		return nil, fmt.Errorf("exec: %w", err)
	}
	return &dbQueryResult{
		Columns:  []string{"output"},
		Rows:     [][]interface{}{{strings.TrimSpace(out)}},
		RowCount: 1,
	}, nil
}

func parseCSVResult(raw string) (*dbQueryResult, error) {
	r := csv.NewReader(strings.NewReader(raw))
	records, err := r.ReadAll()
	if err != nil || len(records) == 0 {
		return &dbQueryResult{Columns: []string{}, Rows: [][]interface{}{}, RowCount: 0}, nil
	}
	columns := records[0]
	rows := make([][]interface{}, 0, len(records)-1)
	for _, rec := range records[1:] {
		row := make([]interface{}, len(rec))
		for i, v := range rec {
			if v == "" {
				row[i] = nil
			} else {
				row[i] = v
			}
		}
		rows = append(rows, row)
	}
	return &dbQueryResult{Columns: columns, Rows: rows, RowCount: len(rows)}, nil
}

func parseTSVResult(raw string) (*dbQueryResult, error) {
	lines := strings.Split(raw, "\n")
	if len(lines) == 0 {
		return &dbQueryResult{Columns: []string{}, Rows: [][]interface{}{}, RowCount: 0}, nil
	}
	columns := strings.Split(lines[0], "\t")
	rows := make([][]interface{}, 0, len(lines)-1)
	for _, line := range lines[1:] {
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		row := make([]interface{}, len(parts))
		for i, v := range parts {
			if v == "NULL" {
				row[i] = nil
			} else {
				row[i] = v
			}
		}
		rows = append(rows, row)
	}
	return &dbQueryResult{Columns: columns, Rows: rows, RowCount: len(rows)}, nil
}
