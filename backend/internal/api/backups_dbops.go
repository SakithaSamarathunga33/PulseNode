package api

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"

	dbpkg "pulsenode/backend/internal/db"
)

// Engine-specific dump and restore of managed databases. The manual backup and
// restore handlers and the scheduled-backup service (internal/backups) both go
// through these, so there is one implementation of how each engine is dumped.

// dumpEngine streams a dump of database (and optionally one table/collection) to w.
func (s *Server) dumpEngine(ctx context.Context, containerName string, mdb *dbpkg.ManagedDatabase, dbName, table string, w io.Writer) error {
	if s.docker == nil {
		return fmt.Errorf("docker not available")
	}
	if dbName == "" {
		dbName = mdb.DBName
	}
	switch mdb.Engine {
	case "postgres":
		cmd := []string{"pg_dump", "-U", mdb.Username, "-d", dbName}
		if table != "" {
			cmd = append(cmd, "-t", table)
		}
		return s.docker.ExecStreamEnv(ctx, containerName, []string{"PGPASSWORD=" + mdb.Password}, cmd, w)

	case "mysql":
		cmd := []string{"mysqldump", "-u" + mdb.Username, dbName}
		if table != "" {
			cmd = append(cmd, table)
		}
		return s.docker.ExecStreamEnv(ctx, containerName, mysqlAuthEnv(mdb.Password), cmd, w)

	case "mongodb":
		args := []string{"--archive", "--db", dbName}
		if table != "" {
			args = append(args, "--collection", table)
		}
		cmd, env := mongoToolCmd("mongodump", args, mdb.Username, mdb.Password)
		return s.docker.ExecStreamEnv(ctx, containerName, env, cmd, w)

	case "redis":
		_, _ = s.docker.ExecSliceEnv(ctx, containerName, redisAuthEnv(mdb.Password), []string{"redis-cli", "SAVE"})
		return s.docker.ExecStreamEnv(ctx, containerName, nil, []string{"cat", "/data/dump.rdb"}, w)
	}
	return fmt.Errorf("unsupported engine %q", mdb.Engine)
}

// restoreEngine loads the dump file at tmpPath (a plain, server-side file) into
// the database. status is the HTTP status the manual restore endpoint answers
// with: 200 on success, 422 when the database tool failed (output has its
// message), 500 otherwise; err.Error() is the message for the "error" field.
func (s *Server) restoreEngine(ctx context.Context, containerName string, mdb *dbpkg.ManagedDatabase, database, tmpPath string) (output string, status int, err error) {
	if s.docker == nil {
		return "", http.StatusInternalServerError, fmt.Errorf("docker not available")
	}
	if database == "" {
		database = mdb.DBName
	}
	tmpID := dbpkg.NewID("rst")
	remoteName := tmpID + ".dump"
	remotePath := "/tmp/" + remoteName

	// Redis restore requires stop/replace/start — handle separately
	if mdb.Engine == "redis" {
		if err := s.docker.Action(ctx, containerName, "stop"); err != nil {
			return "", http.StatusInternalServerError, fmt.Errorf("stop redis: %w", err)
		}
		info, _ := os.Stat(tmpPath)
		rf, _ := os.Open(tmpPath)
		cpErr := s.docker.CopyToContainer(ctx, containerName, "/data", "dump.rdb", rf, info.Size())
		rf.Close()
		_ = s.docker.Action(ctx, containerName, "start")
		if cpErr != nil {
			return "", http.StatusInternalServerError, fmt.Errorf("replace rdb: %w", cpErr)
		}
		return "RDB replaced. Redis restarted.", http.StatusOK, nil
	}

	// Copy backup file into container
	info, err := os.Stat(tmpPath)
	if err != nil {
		return "", http.StatusInternalServerError, err
	}
	rf, err := os.Open(tmpPath)
	if err != nil {
		return "", http.StatusInternalServerError, err
	}
	defer rf.Close()
	if err := s.docker.CopyToContainer(ctx, containerName, "/tmp", remoteName, rf, info.Size()); err != nil {
		return "", http.StatusInternalServerError, fmt.Errorf("copy to container: %w", err)
	}

	var execErr error
	switch mdb.Engine {
	case "postgres":
		cmd := []string{"psql", "-U", mdb.Username, "-d", database, "-f", remotePath}
		output, execErr = s.docker.ExecSliceEnv(ctx, containerName, []string{"PGPASSWORD=" + mdb.Password}, cmd)

	case "mysql":
		// No shell: the password goes via MYSQL_PWD and the file via `source`.
		cmd := []string{"mysql", "-u", mdb.Username, "-D", database, "-e", "source " + remotePath}
		output, execErr = s.docker.ExecSliceEnv(ctx, containerName, []string{"MYSQL_PWD=" + mdb.Password}, cmd)

	case "mongodb":
		cmd, env := mongoToolCmd("mongorestore", []string{"--archive=" + remotePath, "--db", database}, mdb.Username, mdb.Password)
		output, execErr = s.docker.ExecSliceEnv(ctx, containerName, env, cmd)
	}

	// Clean up temp file in container (best-effort)
	_, _ = s.docker.ExecSlice(ctx, containerName, []string{"rm", "-f", remotePath})

	if execErr != nil {
		return output, http.StatusUnprocessableEntity, execErr
	}
	return output, http.StatusOK, nil
}

// backupOps adapts the Server to the scheduled-backup service.
type backupOps struct{ s *Server }

func (o backupOps) ResolveManaged(id string) (*dbpkg.ManagedDatabase, string, error) {
	m, err := o.s.db.GetManagedDatabase(id)
	if err != nil {
		return nil, "", err
	}
	if m == nil {
		return nil, "", fmt.Errorf("managed database %q no longer exists", id)
	}
	return m, fmt.Sprintf("pn-db-%s-%s", m.Engine, m.Name), nil
}

func (o backupOps) Dump(ctx context.Context, m *dbpkg.ManagedDatabase, container string, w io.Writer) error {
	return o.s.dumpEngine(ctx, container, m, m.DBName, "", w)
}

func (o backupOps) Restore(ctx context.Context, m *dbpkg.ManagedDatabase, container, dumpPath string) (string, error) {
	out, _, err := o.s.restoreEngine(ctx, container, m, m.DBName, dumpPath)
	return out, err
}
