package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var errInvalidEnvValue = errors.New("value must be a single line without control characters")
var envKeyRe = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, err error) {
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
}

func decodeJSON(r *http.Request, dst any) error {
	defer r.Body.Close()
	return json.NewDecoder(r.Body).Decode(dst)
}

// upsertEnvLocal writes or replaces KEY=VALUE in .env.local. A newline in the
// value would inject further KEY=VALUE lines (e.g. PULSENODE_COMPOSE_BIN, which
// the self-updater executes), so control characters are rejected.
func upsertEnvLocal(key, value string) error {
	if !envKeyRe.MatchString(key) {
		return fmt.Errorf("invalid env key %q", key)
	}
	if strings.ContainsAny(value, "\r\n\x00") {
		return errInvalidEnvValue
	}
	envFile := filepath.Join(workspaceDir(), ".env.local")
	existing := ""
	if data, err := os.ReadFile(envFile); err == nil {
		existing = string(data)
	}

	lines := strings.Split(existing, "\n")
	found := false
	for i, line := range lines {
		if strings.HasPrefix(line, key+"=") {
			lines[i] = fmt.Sprintf("%s=%s", key, value)
			found = true
			break
		}
	}
	if !found {
		lines = append(lines, fmt.Sprintf("%s=%s", key, value))
	}

	content := strings.Join(lines, "\n")
	if !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	return os.WriteFile(envFile, []byte(content), 0o600)
}
