package builder

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// envKeyRe is the portable environment-variable name. Anything else would be
// misparsed by `docker run -e` or, worse, split a line of the compose .env file.
var envKeyRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// validateEnvMap rejects keys that aren't plain identifiers and values containing
// CR, LF or NUL. Those values are written verbatim into the compose .env file
// (K=V per line), so a newline would inject extra variables; NUL cannot be passed
// through argv at all. Errors name the key but never echo the value (it may be a secret).
func validateEnvMap(m map[string]string) error {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if !envKeyRe.MatchString(k) {
			return fmt.Errorf("invalid environment variable name %q: use letters, digits and underscores, not starting with a digit", k)
		}
		if strings.ContainsAny(m[k], "\r\n\x00") {
			return fmt.Errorf("environment variable %s contains a newline or NUL character, which is not allowed", k)
		}
	}
	return nil
}

// parseEnvVars decodes a project's stored {"KEY":"VALUE"} JSON and validates it.
// Empty input is an empty map.
func parseEnvVars(raw string) (map[string]string, error) {
	m := map[string]string{}
	if raw == "" || raw == "{}" {
		return m, nil
	}
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil, fmt.Errorf("environment variables are not valid JSON key/value strings: %w", err)
	}
	if err := validateEnvMap(m); err != nil {
		return nil, err
	}
	return m, nil
}
