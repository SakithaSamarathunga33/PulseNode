package db

import (
	"fmt"
	"time"
)

// Session revocations survive restarts (a self-update restarts go-api, which used
// to resurrect logged-out tokens). Each row names either a session id (jti claim)
// or, for tokens issued before jti existed, "t:<auth_time>". Rows are only needed
// until the session would have expired anyway, and the daily prune removes them.

func (d *DB) ensureSessionSchema() {
	d.sessOnce.Do(func() {
		if _, err := d.Exec(`CREATE TABLE IF NOT EXISTS session_revocations (
  id         TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
)`); err != nil {
			fmt.Printf("[db] session_revocations schema: %v\n", err)
		}
	})
}

// RevokeSession marks id revoked until expiresAt (unix seconds).
func (d *DB) RevokeSession(id string, expiresAt int64) error {
	d.ensureSessionSchema()
	_, err := d.Exec(`INSERT INTO session_revocations (id, expires_at) VALUES (?, ?)
ON CONFLICT(id) DO UPDATE SET expires_at = MAX(expires_at, excluded.expires_at)`, id, expiresAt)
	return err
}

// IsSessionRevoked reports whether id was revoked and is still within its window.
func (d *DB) IsSessionRevoked(id string) (bool, error) {
	d.ensureSessionSchema()
	var n int
	err := d.QueryRow(`SELECT COUNT(1) FROM session_revocations WHERE id = ? AND expires_at > ?`, id, time.Now().Unix()).Scan(&n)
	return n > 0, err
}

// PruneSessionRevocations drops rows whose sessions have expired anyway.
func (d *DB) PruneSessionRevocations() error {
	d.ensureSessionSchema()
	_, err := d.Exec(`DELETE FROM session_revocations WHERE expires_at <= ?`, time.Now().Unix())
	return err
}
