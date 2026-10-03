package builder

import (
	"strings"
	"testing"
)

func TestParseEnvVarsAcceptsNormalValues(t *testing.T) {
	m, err := parseEnvVars(`{"DATABASE_URL":"postgres://u:p@h:5432/db?sslmode=require","_X1":"a b=c","EMPTY":"","MULTI":"tab\tok"}`)
	if err != nil || len(m) != 4 || m["_X1"] != "a b=c" {
		t.Fatalf("got %v %v", m, err)
	}
	for _, empty := range []string{"", "{}"} {
		if m, err := parseEnvVars(empty); err != nil || len(m) != 0 {
			t.Errorf("parseEnvVars(%q) = %v %v", empty, m, err)
		}
	}
}

func TestParseEnvVarsRejectsBadKeys(t *testing.T) {
	for _, key := range []string{"1BAD", "A-B", "A B", "A=B", "A\nB", "", "ÄÖ", "A.B", "$(id)", "A;B"} {
		raw := `{` + jsonString(key) + `:"v"}`
		if _, err := parseEnvVars(raw); err == nil {
			t.Errorf("key %q must be rejected", key)
		}
	}
}

func TestParseEnvVarsRejectsInjectedLines(t *testing.T) {
	for name, v := range map[string]string{"LF": "a\nPULSENODE_X=1", "CR": "a\rb", "CRLF": "a\r\nb", "NUL": "a\x00b"} {
		raw := `{"K":` + jsonString(v) + `}`
		_, err := parseEnvVars(raw)
		if err == nil {
			t.Errorf("%s in a value must be rejected", name)
			continue
		}
		if strings.Contains(err.Error(), "PULSENODE_X") || !strings.Contains(err.Error(), "K") {
			t.Errorf("error should name the key and never echo the value: %v", err)
		}
	}
}

func TestParseEnvVarsRejectsInvalidJSON(t *testing.T) {
	for _, raw := range []string{`not json`, `{"A":1}`, `["A"]`, `{"A":null}x`} {
		if _, err := parseEnvVars(raw); err == nil {
			t.Errorf("%q must be an error, not a silently empty environment", raw)
		}
	}
}

func TestValidateEnvMapDefenceInDepth(t *testing.T) {
	// buildCompose and deployService re-check the map they are about to write, so a
	// value injected after parsing (e.g. PORT) can never reach the .env file.
	if err := validateEnvMap(map[string]string{"PORT": "3000\nEVIL=1"}); err == nil {
		t.Error("PORT with a newline must be rejected")
	}
	if err := validateEnvMap(map[string]string{"PORT": "3000", "NODE_ENV": "production"}); err != nil {
		t.Error(err)
	}
}

func jsonString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"' || r == '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case r < 0x20:
			b.WriteString(`\u00`)
			b.WriteString(string("0123456789abcdef"[r>>4]))
			b.WriteString(string("0123456789abcdef"[r&0xf]))
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}
