package security

import (
	"context"
	"errors"
	"testing"
)

func newTestService(t *testing.T, installed map[string]bool, run Runner) *Service {
	t.Helper()
	return &Service{
		dir: t.TempDir(),
		lookPath: func(name string) (string, error) {
			if installed[name] {
				return "/usr/bin/" + name, nil
			}
			return "", errors.New("not found")
		},
		run: run,
	}
}

func failRunner(t *testing.T) Runner {
	return func(context.Context, string, ...string) ([]byte, string, error) {
		t.Fatal("scanner must not run when it is not installed")
		return nil, "", nil
	}
}

func TestScanUnavailableNeverFabricates(t *testing.T) {
	s := newTestService(t, nil, failRunner(t))
	res, err := s.Scan(context.Background(), "nginx:alpine")
	if err != nil {
		t.Fatal(err)
	}
	if res["status"] != StatusUnavailable || res["message"] == "" {
		t.Fatalf("want unavailable + message, got %v", res)
	}
	for _, k := range []string{"crit", "high", "med", "low"} {
		if res[k] != 0 {
			t.Fatalf("%s must be 0 when unavailable, got %v", k, res[k])
		}
	}
	if got := s.Scans(); len(got) != 0 {
		t.Fatalf("unavailable result must not be persisted, got %v", got)
	}
}

func TestSBOMUnavailable(t *testing.T) {
	s := newTestService(t, nil, failRunner(t))
	res, err := s.SBOM(context.Background(), "nginx:alpine", "")
	if err != nil || res["status"] != StatusUnavailable {
		t.Fatalf("want unavailable, got %v %v", res, err)
	}
	if _, ok := res["packages"]; ok {
		t.Fatal("no package count may be reported without Syft")
	}
	if got := s.SBOMs(); len(got) != 0 {
		t.Fatalf("must not persist, got %v", got)
	}
}

func TestListsEmptyNotNil(t *testing.T) {
	s := newTestService(t, nil, nil)
	if s.Scans() == nil || s.SBOMs() == nil {
		t.Fatal("lists must be non-nil so they marshal to []")
	}
}

func TestInvalidImageRef(t *testing.T) {
	s := newTestService(t, map[string]bool{"trivy": true, "syft": true}, failRunner(t))
	for _, ref := range []string{"", "--help", "-o evil", "a b", "x;rm -rf /", "$(id)"} {
		if _, err := s.Scan(context.Background(), ref); !errors.Is(err, ErrInvalidRef) {
			t.Errorf("Scan(%q) err = %v, want ErrInvalidRef", ref, err)
		}
		if _, err := s.SBOM(context.Background(), ref, ""); !errors.Is(err, ErrInvalidRef) {
			t.Errorf("SBOM(%q) err = %v, want ErrInvalidRef", ref, err)
		}
	}
}

func TestScanParsesTrivy(t *testing.T) {
	out := []byte(`{"Results":[{"Vulnerabilities":[{"Severity":"CRITICAL"},{"Severity":"HIGH"},{"Severity":"HIGH"},{"Severity":"MEDIUM"},{"Severity":"LOW"},{"Severity":"UNKNOWN"}]},{"Vulnerabilities":null}]}`)
	s := newTestService(t, map[string]bool{"trivy": true}, func(_ context.Context, name string, args ...string) ([]byte, string, error) {
		if name != "trivy" || args[len(args)-1] != "nginx:alpine" {
			t.Fatalf("unexpected command %s %v", name, args)
		}
		return out, "", nil
	})
	res, err := s.Scan(context.Background(), "nginx:alpine")
	if err != nil {
		t.Fatal(err)
	}
	if res["status"] != StatusDone || res["crit"] != 1 || res["high"] != 2 || res["med"] != 1 || res["low"] != 1 {
		t.Fatalf("bad counts: %v", res)
	}
	if got := s.Scans(); len(got) != 1 {
		t.Fatalf("scan should be persisted, got %d", len(got))
	}
}

func TestScanFailureIsReportedNotFaked(t *testing.T) {
	s := newTestService(t, map[string]bool{"trivy": true}, func(context.Context, string, ...string) ([]byte, string, error) {
		return nil, "image not found", errors.New("exit status 1")
	})
	res, _ := s.Scan(context.Background(), "ghost:1")
	if res["status"] != StatusFailed || res["message"] != "image not found" {
		t.Fatalf("got %v", res)
	}
}

func TestParseSPDX(t *testing.T) {
	doc := []byte(`{"spdxVersion":"SPDX-2.3","packages":[
	 {"SPDXID":"SPDXRef-DocumentRoot-Image-x","licenseConcluded":"NOASSERTION"},
	 {"SPDXID":"SPDXRef-1","licenseConcluded":"MIT","externalRefs":[{"referenceType":"purl","referenceLocator":"pkg:golang/a/b@1"}]},
	 {"SPDXID":"SPDXRef-2","licenseConcluded":"NOASSERTION","licenseDeclared":"Apache-2.0","externalRefs":[{"referenceType":"purl","referenceLocator":"pkg:deb/debian/curl@7"}]},
	 {"SPDXID":"SPDXRef-3","licenseConcluded":"MIT","externalRefs":[{"referenceType":"purl","referenceLocator":"pkg:npm/left-pad@1"}]},
	 {"SPDXID":"SPDXRef-4","licenseConcluded":"NONE"}]}`)
	sum, err := ParseSPDX(doc)
	if err != nil {
		t.Fatal(err)
	}
	if sum.Format != "SPDX 2.3" || sum.Packages != 4 || sum.Licenses != 2 {
		t.Fatalf("got %+v", sum)
	}
	if sum.Ecosystem["go"] != 1 || sum.Ecosystem["deb"] != 1 || sum.Ecosystem["npm"] != 1 || sum.Ecosystem["other"] != 1 {
		t.Fatalf("ecosystems: %v", sum.Ecosystem)
	}
	if _, err := ParseSPDX([]byte(`{}`)); err == nil {
		t.Fatal("non-SPDX document must be rejected")
	}
}

func TestParseCycloneDX(t *testing.T) {
	doc := []byte(`{"bomFormat":"CycloneDX","specVersion":"1.5","components":[
	 {"purl":"pkg:npm/a@1","licenses":[{"license":{"id":"MIT"}}]},
	 {"purl":"pkg:golang/b@2","licenses":[{"expression":"MIT OR Apache-2.0"}]},
	 {"purl":"pkg:apk/alpine/c@3"}]}`)
	sum, err := ParseCycloneDX(doc)
	if err != nil {
		t.Fatal(err)
	}
	if sum.Format != "CycloneDX 1.5" || sum.Packages != 3 || sum.Licenses != 2 || sum.Ecosystem["other"] != 1 {
		t.Fatalf("got %+v", sum)
	}
}
