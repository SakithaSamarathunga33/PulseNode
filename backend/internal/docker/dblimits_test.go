package docker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func clearDBEnv(t *testing.T) {
	t.Helper()
	t.Setenv("PULSENODE_DB_MEMORY", "")
	t.Setenv("PULSENODE_DB_PIDS", "")
}

func TestDBMemoryDefaultsPerEngine(t *testing.T) {
	clearDBEnv(t)
	want := map[string]int64{
		"postgres:16":                  1 << 30,
		"mysql:8":                      1 << 30,
		"mariadb:11":                   1 << 30,
		"mongo:7.0":                    1 << 30,
		"redis:7.4-alpine":             512 << 20,
		"clickhouse/clickhouse-server": 2 << 30,
		"cassandra:5":                  2 << 30,
		"elasticsearch:8.15.0":         2 << 30,
	}
	for image, bytes := range want {
		hc := dbHostConfigHardening(image)
		if hc["Memory"] != bytes {
			t.Errorf("%s: Memory = %v, want %d", image, hc["Memory"], bytes)
		}
		if hc["PidsLimit"] != int64(4096) {
			t.Errorf("%s: PidsLimit = %v", image, hc["PidsLimit"])
		}
		if so, _ := hc["SecurityOpt"].([]string); len(so) != 1 || so[0] != "no-new-privileges" {
			t.Errorf("%s: SecurityOpt = %v", image, hc["SecurityOpt"])
		}
		lc := hc["LogConfig"].(map[string]any)
		cfg := lc["Config"].(map[string]string)
		if lc["Type"] != "json-file" || cfg["max-size"] != "10m" || cfg["max-file"] != "3" {
			t.Errorf("%s: LogConfig = %v", image, lc)
		}
	}
}

func TestDBLimitKnobs(t *testing.T) {
	clearDBEnv(t)
	t.Setenv("PULSENODE_DB_MEMORY", "3g")
	t.Setenv("PULSENODE_DB_PIDS", "200")
	hc := dbHostConfigHardening("redis:7")
	if hc["Memory"] != int64(3<<30) || hc["PidsLimit"] != int64(200) {
		t.Errorf("overrides ignored: %v %v", hc["Memory"], hc["PidsLimit"])
	}
	t.Setenv("PULSENODE_DB_MEMORY", "unlimited")
	t.Setenv("PULSENODE_DB_PIDS", "0")
	hc = dbHostConfigHardening("postgres:16")
	if _, ok := hc["Memory"]; ok {
		t.Error("memory limit must be removable")
	}
	if _, ok := hc["PidsLimit"]; ok {
		t.Error("pids limit must be removable")
	}
	if _, ok := hc["SecurityOpt"]; !ok {
		t.Error("no-new-privileges is not optional")
	}
	t.Setenv("PULSENODE_DB_MEMORY", "garbage")
	t.Setenv("PULSENODE_DB_PIDS", "-5")
	hc = dbHostConfigHardening("postgres:16")
	if _, ok := hc["Memory"]; ok {
		t.Error("an unparseable memory value must not become a limit")
	}
	if _, ok := hc["PidsLimit"]; ok {
		t.Error("a negative pids value must not become a limit")
	}
}

func TestParseMemBytes(t *testing.T) {
	for in, want := range map[string]int64{"512m": 512 << 20, "1g": 1 << 30, "1.5g": 3 << 29, "256MB": 256 << 20, "8388608": 8 << 20, "64M": 64 << 20} {
		if got, ok := parseMemBytes(in); !ok || got != want {
			t.Errorf("parseMemBytes(%q) = %d %v, want %d", in, got, ok, want)
		}
	}
	for _, in := range []string{"", "x", "-1g", "0", "1 tb", "1m", "$(id)"} {
		if _, ok := parseMemBytes(in); ok {
			t.Errorf("parseMemBytes(%q) must fail", in)
		}
	}
}

type captureRT struct{ body []byte }

func (c *captureRT) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.Body != nil {
		c.body, _ = io.ReadAll(r.Body)
	}
	return &http.Response{StatusCode: 201, Body: io.NopCloser(strings.NewReader(`{"Id":"abc123"}`)), Header: http.Header{}}, nil
}

func TestCreateDBContainerSendsHardening(t *testing.T) {
	clearDBEnv(t)
	rt := &captureRT{}
	c := &Client{http: &http.Client{Transport: rt}}
	id, err := c.CreateDBContainer(context.Background(), "postgres:16", "pn-db", "vol", "/var/lib/postgresql/data", 15432, 5432, map[string]string{"POSTGRES_PASSWORD": "x"})
	if err != nil || id != "abc123" {
		t.Fatalf("%q %v", id, err)
	}
	var sent struct {
		HostConfig struct {
			Memory       int64                          `json:"Memory"`
			PidsLimit    int64                          `json:"PidsLimit"`
			SecurityOpt  []string                       `json:"SecurityOpt"`
			LogConfig    struct{ Type string }          `json:"LogConfig"`
			PortBindings map[string][]map[string]string `json:"PortBindings"`
			Binds        []string                       `json:"Binds"`
			Restart      map[string]string              `json:"RestartPolicy"`
		}
	}
	if err := json.Unmarshal(rt.body, &sent); err != nil {
		t.Fatal(err)
	}
	h := sent.HostConfig
	if h.Memory != 1<<30 || h.PidsLimit != 4096 || len(h.SecurityOpt) != 1 || h.LogConfig.Type != "json-file" {
		t.Errorf("hardening missing from the create request: %+v", h)
	}
	if b := h.PortBindings["5432/tcp"]; len(b) != 1 || b[0]["HostIp"] != "127.0.0.1" || b[0]["HostPort"] != "15432" {
		t.Errorf("database port must stay bound to loopback only: %v", h.PortBindings)
	}
	if len(h.Binds) != 1 || h.Restart["Name"] != "unless-stopped" {
		t.Errorf("existing behaviour changed: binds=%v restart=%v", h.Binds, h.Restart)
	}
}
