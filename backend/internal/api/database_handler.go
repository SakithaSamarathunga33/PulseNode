package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	dbpkg "pulsenode/backend/internal/db"
)

// ── Engine metadata ────────────────────────────────────────────────────────────

type engineMeta struct {
	Image      string
	InternPort int
	DataPath   string
	EnvUser    string
	EnvPass    string
	EnvDB      string
}

var engines = map[string]engineMeta{
	"postgres": {
		Image: "postgres:16-alpine", InternPort: 5432, DataPath: "/var/lib/postgresql/data",
		EnvUser: "POSTGRES_USER", EnvPass: "POSTGRES_PASSWORD", EnvDB: "POSTGRES_DB",
	},
	"mysql": {
		Image: "mysql:8.0", InternPort: 3306, DataPath: "/var/lib/mysql",
		EnvUser: "MYSQL_USER", EnvPass: "MYSQL_PASSWORD", EnvDB: "MYSQL_DATABASE",
	},
	"mongodb": {
		Image: "mongo:7", InternPort: 27017, DataPath: "/data/db",
		EnvUser: "MONGO_INITDB_ROOT_USERNAME", EnvPass: "MONGO_INITDB_ROOT_PASSWORD", EnvDB: "MONGO_INITDB_DATABASE",
	},
	"redis": {
		Image: "redis:7-alpine", InternPort: 6379, DataPath: "/data",
		EnvUser: "", EnvPass: "", EnvDB: "",
	},
}

// ── Handlers ───────────────────────────────────────────────────────────────────

func (s *Server) listManagedDatabases(w http.ResponseWriter, r *http.Request) {
	list, err := s.db.ListManagedDatabases()
	if err != nil {
		writeError(w, err)
		return
	}
	if list == nil {
		list = []dbpkg.ManagedDatabase{}
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) provisionDatabase(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name   string `json:"name"`
		Engine string `json:"engine"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	req.Engine = strings.ToLower(req.Engine)
	meta, ok := engines[req.Engine]
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported engine: " + req.Engine})
		return
	}
	req.Name = sanitizeDBName(req.Name)
	if req.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required — use letters, numbers, dots, dashes or underscores"})
		return
	}
	if existing, err := s.db.GetManagedDatabaseByContainerName(req.Engine, req.Name); err == nil && existing != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": fmt.Sprintf("a %s database named %q already exists", req.Engine, req.Name)})
		return
	}

	id := dbpkg.NewID("db")
	password := randHex(16)
	username := "pulsenode"
	dbName := req.Name

	hostPort, err := freePort()
	if err != nil {
		writeError(w, fmt.Errorf("find free port: %w", err))
		return
	}

	volumeName := fmt.Sprintf("pulsenode_%s_%s_data", req.Engine, req.Name)
	containerName := fmt.Sprintf("pn-db-%s-%s", req.Engine, req.Name)

	record := &dbpkg.ManagedDatabase{
		ID:         id,
		Name:       req.Name,
		Engine:     req.Engine,
		VolumeName: volumeName,
		HostPort:   hostPort,
		Username:   username,
		Password:   password,
		DBName:     dbName,
		Status:     "creating",
	}
	if err := s.db.CreateManagedDatabase(record); err != nil {
		writeError(w, err)
		return
	}

	// Provision asynchronously, stream progress via SSE event
	go s.runProvision(id, containerName, volumeName, password, username, dbName, hostPort, meta, req.Engine)

	writeJSON(w, http.StatusAccepted, map[string]any{
		"id":        id,
		"name":      req.Name,
		"engine":    req.Engine,
		"status":    "creating",
		"host_port": hostPort,
		"username":  username,
		"db_name":   dbName,
	})
}

func (s *Server) runProvision(id, containerName, volumeName, password, username, dbName string, hostPort int, meta engineMeta, engine string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	emit := func(msg string) {
		s.hub.Broadcast("db:provision", map[string]string{"id": id, "msg": msg})
	}

	emit("Creating volume " + volumeName + "…")
	if err := s.docker.CreateVolume(ctx, volumeName); err != nil {
		emit("ERROR: " + err.Error())
		_ = s.db.UpdateManagedDatabaseStatus(id, "error", "")
		return
	}

	emit("Pulling image " + meta.Image + "…")
	if err := s.docker.PullImage(ctx, meta.Image); err != nil {
		emit("WARNING: pull failed, using cached image if available")
	}

	envVars := map[string]string{}
	if meta.EnvUser != "" {
		envVars[meta.EnvUser] = username
	}
	if meta.EnvPass != "" {
		envVars[meta.EnvPass] = password
	}
	if meta.EnvDB != "" {
		envVars[meta.EnvDB] = dbName
	}
	// mysql:8.0 refuses to start unless a root password strategy is set
	if engine == "mysql" {
		envVars["MYSQL_ROOT_PASSWORD"] = password
	}

	emit("Creating container " + containerName + "…")
	cid, err := s.docker.CreateDBContainer(ctx, meta.Image, containerName, volumeName, meta.DataPath, hostPort, meta.InternPort, envVars)
	if err != nil {
		emit("ERROR: " + err.Error())
		_ = s.db.UpdateManagedDatabaseStatus(id, "error", "")
		return
	}

	emit("Starting container…")
	if err := s.docker.StartContainer(ctx, cid); err != nil {
		emit("ERROR: " + err.Error())
		_ = s.db.UpdateManagedDatabaseStatus(id, "error", cid)
		return
	}

	emit("Waiting for health check…")
	time.Sleep(3 * time.Second) // give the container a moment to initialize

	// Verify the container actually stayed up (a bad env/config makes it exit or
	// restart-loop immediately, which a blind "running" would mask).
	if state, err := s.docker.ContainerState(ctx, cid); err == nil && state != "running" {
		logs, _ := s.docker.Logs(ctx, cid, 5)
		emit("ERROR: container is " + state + " — " + strings.TrimSpace(logs))
		_ = s.db.UpdateManagedDatabaseStatus(id, "error", cid)
		return
	}

	_ = s.db.UpdateManagedDatabaseStatus(id, "running", cid)
	emit("✓ Database ready on host port " + fmt.Sprintf("%d", hostPort))
}

func (s *Server) getManagedDatabase(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	m, err := s.db.GetManagedDatabase(id)
	if err != nil {
		writeError(w, err)
		return
	}
	if m == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	// Return connection string (password exposed only here)
	m.Password = "***" // mask in detail view too; use /credentials endpoint
	writeJSON(w, http.StatusOK, m)
}

func (s *Server) getManagedDBCredentials(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	m, err := s.db.GetManagedDatabase(id)
	if err != nil {
		writeError(w, err)
		return
	}
	if m == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"username":          m.Username,
		"password":          m.Password,
		"db_name":           m.DBName,
		"host_port":         m.HostPort,
		"connection_string": buildConnString(m, ""),
	})
}

func (s *Server) deleteManagedDatabase(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	m, err := s.db.GetManagedDatabase(id)
	if err != nil {
		writeError(w, err)
		return
	}
	if m == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}

	ctx := r.Context()
	if m.ContainerID != "" {
		_ = s.docker.Action(ctx, m.ContainerID, "remove")
	}

	if err := s.db.DeleteManagedDatabase(id); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ── Connected databases ────────────────────────────────────────────────────────

func (s *Server) listConnectedDatabases(w http.ResponseWriter, r *http.Request) {
	list, err := s.db.ListConnectedDatabases()
	if err != nil {
		writeError(w, err)
		return
	}
	if list == nil {
		list = []dbpkg.ConnectedDatabase{}
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) connectDatabase(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name     string `json:"name"`
		Engine   string `json:"engine"`
		Host     string `json:"host"`
		Port     int    `json:"port"`
		Username string `json:"username"`
		Password string `json:"password"`
		DBName   string `json:"dbName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	c := &dbpkg.ConnectedDatabase{
		ID:       dbpkg.NewID("con"),
		Name:     req.Name,
		Engine:   req.Engine,
		Host:     req.Host,
		Port:     req.Port,
		Username: req.Username,
		Password: req.Password,
		DBName:   req.DBName,
	}
	if err := s.db.CreateConnectedDatabase(c); err != nil {
		writeError(w, err)
		return
	}
	c.Password = "" // don't return password
	writeJSON(w, http.StatusCreated, c)
}

func (s *Server) deleteConnectedDatabase(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.db.DeleteConnectedDatabase(id); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// sanitizeDBName makes a user-supplied name safe for Docker container/volume
// names ([a-zA-Z0-9][a-zA-Z0-9_.-]*): whitespace becomes "-", other invalid
// characters are stripped, and leading non-alphanumerics are trimmed.
func sanitizeDBName(raw string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(raw) {
		switch {
		case r == ' ' || r == '\t':
			b.WriteRune('-')
		case (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '.' || r == '-':
			b.WriteRune(r)
		}
	}
	return strings.TrimLeft(b.String(), "_.-")
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", ":0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// buildConnString builds a connection URI for m. If dbName is non-empty it
// overrides the default database/schema in the URI (so the string follows the
// database the user selected in the cluster); redis ignores it.
func buildConnString(m *dbpkg.ManagedDatabase, dbName string) string {
	if dbName == "" {
		dbName = m.DBName
	}
	switch m.Engine {
	case "postgres":
		return fmt.Sprintf("postgresql://%s:%s@localhost:%d/%s", m.Username, m.Password, m.HostPort, dbName)
	case "mysql":
		return fmt.Sprintf("mysql://%s:%s@localhost:%d/%s", m.Username, m.Password, m.HostPort, dbName)
	case "mongodb":
		return fmt.Sprintf("mongodb://%s:%s@localhost:%d/%s", m.Username, m.Password, m.HostPort, dbName)
	case "redis":
		return fmt.Sprintf("redis://localhost:%d", m.HostPort)
	default:
		return ""
	}
}
