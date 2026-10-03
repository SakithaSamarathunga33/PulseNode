package builder

import (
	"bytes"
	"encoding/json"
	"testing"
)

type hardeningOut struct {
	Services map[string]map[string]json.RawMessage `json:"services"`
}

// compact strips the indentation MarshalIndent leaves inside nested values.
func compact(raw json.RawMessage) string {
	var b bytes.Buffer
	if err := json.Compact(&b, raw); err != nil {
		return string(raw)
	}
	return b.String()
}

func genHardening(t *testing.T, config string) hardeningOut {
	t.Helper()
	raw, err := composeHardeningOverlay([]byte(config))
	if err != nil {
		t.Fatal(err)
	}
	var out hardeningOut
	if raw == nil {
		return out
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("overlay is not valid JSON/YAML: %v\n%s", err, raw)
	}
	return out
}

func clearAppLimitEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{"PULSENODE_APP_MEMORY", "PULSENODE_APP_PIDS", "PULSENODE_APP_CPUS"} {
		t.Setenv(k, "")
	}
}

func TestHardeningFillsEverythingForBareService(t *testing.T) {
	clearAppLimitEnv(t)
	out := genHardening(t, `{"services":{"web":{"image":"nginx","mem_limit":"0","cap_drop":null,"logging":null}}}`)
	web := out.Services["web"]
	for _, key := range []string{"cap_drop", "cap_add", "security_opt", "mem_limit", "pids_limit", "logging"} {
		if len(web[key]) == 0 {
			t.Errorf("missing %s in %v", key, web)
		}
	}
	if compact(web["mem_limit"]) != `"1g"` || compact(web["pids_limit"]) != `1024` {
		t.Errorf("defaults wrong: mem=%s pids=%s", web["mem_limit"], web["pids_limit"])
	}
	if _, ok := web["cpus"]; ok {
		t.Error("cpus must stay unset by default (docker rejects values above the host core count)")
	}
	var caps []string
	if err := json.Unmarshal(web["cap_add"], &caps); err != nil || len(caps) != len(appCaps) {
		t.Errorf("cap_add = %s", web["cap_add"])
	}
	if compact(web["cap_drop"]) != `["ALL"]` || compact(web["security_opt"]) != `["no-new-privileges:true"]` {
		t.Errorf("cap_drop=%s security_opt=%s", web["cap_drop"], web["security_opt"])
	}
}

func TestHardeningNeverOverridesUserChoices(t *testing.T) {
	clearAppLimitEnv(t)
	out := genHardening(t, `{"services":{
	  "a":{"cap_drop":["NET_RAW"],"security_opt":["no-new-privileges:true"],"mem_limit":"536870912","pids_limit":64,"cpus":0.5,"logging":{"driver":"local"}},
	  "b":{"deploy":{"resources":{"limits":{"memory":"268435456","cpus":"0.25","pids":100}}}}
	}}`)
	if len(out.Services["a"]) != 0 {
		t.Errorf("service a defines everything itself, overlay must not touch it: %v", out.Services["a"])
	}
	b := out.Services["b"]
	for _, key := range []string{"mem_limit", "pids_limit", "cpus"} {
		if _, ok := b[key]; ok {
			t.Errorf("b sets deploy.resources.limits; adding %s would conflict (compose rejects disagreeing values)", key)
		}
	}
	if len(b["cap_drop"]) == 0 || len(b["logging"]) == 0 {
		t.Errorf("b should still get caps and logging: %v", b)
	}
}

func TestHardeningUserNoNewPrivilegesFalseIsNotAccepted(t *testing.T) {
	clearAppLimitEnv(t)
	out := genHardening(t, `{"services":{"a":{"security_opt":["no-new-privileges:false"],"cap_drop":["ALL"],"mem_limit":"1","pids_limit":1,"logging":{"driver":"local"}}}}`)
	if compact(out.Services["a"]["security_opt"]) != `["no-new-privileges:true"]` {
		t.Errorf("no-new-privileges:false must not count as set: %v", out.Services["a"])
	}
}

func TestHardeningEnvKnobs(t *testing.T) {
	clearAppLimitEnv(t)
	t.Setenv("PULSENODE_APP_MEMORY", "2g")
	t.Setenv("PULSENODE_APP_PIDS", "0") // disabled
	t.Setenv("PULSENODE_APP_CPUS", "1.5")
	web := genHardening(t, `{"services":{"web":{"image":"x"}}}`).Services["web"]
	if compact(web["mem_limit"]) != `"2g"` {
		t.Errorf("mem_limit = %s", web["mem_limit"])
	}
	if _, ok := web["pids_limit"]; ok {
		t.Error("pids limit was disabled with 0")
	}
	if compact(web["cpus"]) != `1.5` {
		t.Errorf("cpus = %s", web["cpus"])
	}
}

func TestHardeningIgnoresMalformedKnobs(t *testing.T) {
	clearAppLimitEnv(t)
	t.Setenv("PULSENODE_APP_MEMORY", "lots")
	t.Setenv("PULSENODE_APP_PIDS", "-1")
	t.Setenv("PULSENODE_APP_CPUS", "$(id)")
	web := genHardening(t, `{"services":{"web":{"image":"x"}}}`).Services["web"]
	for _, key := range []string{"mem_limit", "pids_limit", "cpus"} {
		if _, ok := web[key]; ok {
			t.Errorf("malformed knob must not be written to the override (%s)", key)
		}
	}
}

func TestHardeningSkipsUnsafeServiceNamesAndEmpty(t *testing.T) {
	clearAppLimitEnv(t)
	out := genHardening(t, `{"services":{"ok":{"image":"x"},"bad name\n  evil: x":{"image":"y"},"-lead":{"image":"z"}}}`)
	if len(out.Services) != 1 || out.Services["ok"] == nil {
		t.Errorf("only valid service names may appear: %v", out.Services)
	}
	if raw, err := composeHardeningOverlay([]byte(`{"services":{}}`)); err != nil || raw != nil {
		t.Errorf("no services => no overlay, got %q %v", raw, err)
	}
	if _, err := composeHardeningOverlay([]byte(`not json`)); err == nil {
		t.Error("unreadable config must be an error")
	}
}

func TestHardeningOverlayStaysPolicyClean(t *testing.T) {
	clearAppLimitEnv(t)
	raw, _ := composeHardeningOverlay([]byte(`{"services":{"web":{"image":"x"}}}`))
	// The overlay is merged output of OUR generator; make sure the keys it uses are
	// ones the allow-list accepts for user files too (so a future "check the merged
	// config" step would not reject its own output).
	var o hardeningOut
	if err := json.Unmarshal(raw, &o); err != nil {
		t.Fatal(err)
	}
	for key := range o.Services["web"] {
		if key == "cap_add" {
			continue // generated by PulseNode only; users may not set it
		}
		if !serviceAllowed[key] && !serviceChecked[key] {
			t.Errorf("generated key %q is not on the user allow-list", key)
		}
	}
}
