package security

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	StatusDone        = "done"
	StatusFailed      = "failed"
	StatusUnavailable = "unavailable"

	scanTimeout = 5 * time.Minute
	maxKept     = 50
)

// ErrUnavailable is returned when the scanner binary is not installed. Callers
// surface it as status "unavailable" — scan numbers are never made up.
var ErrUnavailable = errors.New("scanner not installed")

// ErrBusy is returned when another scan or SBOM is already running. Scanners
// are memory hungry, so only one runs at a time.
var ErrBusy = errors.New("another scan or SBOM is already running; try again when it finishes")

// ErrInvalidRef is returned for an image reference that is empty or not a valid ref.
var ErrInvalidRef = errors.New("invalid image reference")

// imageRef is deliberately strict: it must start with an alphanumeric (so it can
// never be parsed as a CLI flag) and only contain characters valid in an image
// reference.
var imageRef = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,254}$`)

// pathSchemes are scanner source transports that read a local path or archive
// (syft/trivy accept them in the same position as an image name): `dir:/workspace`
// would produce a package list of the panel's own files. Never allowed.
var pathSchemes = map[string]bool{
	"dir": true, "directory": true, "file": true, "docker-archive": true, "oci-archive": true,
	"oci-dir": true, "oci": true, "singularity": true, "sbom": true, "k8s": true, "kubernetes": true,
	"http": true, "https": true, "ftp": true, "git": true, "github": true, "ssh": true,
}

// daemonSchemes pick where an image is pulled from. They are only legitimate here
// as the official image of the same name with a plain tag (docker:dind, docker:24),
// never as a transport prefix in front of a full reference (docker:registry.x/app).
var daemonSchemes = map[string]bool{"docker": true, "podman": true, "registry": true, "containerd": true, "daemon": true, "remote": true}

var plainTag = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]*$`)

// validImageRef accepts a plain image reference (name[:tag][@digest], optionally
// with a registry host[:port]) and rejects flags, paths and source-scheme prefixes.
func validImageRef(target string) bool {
	if !imageRef.MatchString(target) || strings.Contains(target, "..") {
		return false
	}
	i := strings.Index(target, ":")
	if i < 0 {
		return true
	}
	prefix, rest := strings.ToLower(target[:i]), target[i+1:]
	if strings.HasPrefix(rest, "/") { // dir:/x, http://host — image refs never have ':/'
		return false
	}
	if pathSchemes[prefix] {
		return false
	}
	if daemonSchemes[prefix] && !plainTag.MatchString(rest) {
		return false
	}
	return true
}

// Runner executes a command and returns stdout plus the tail of stderr.
type Runner func(ctx context.Context, name string, args ...string) (stdout []byte, stderrTail string, err error)

type Service struct {
	dir      string
	mu       sync.Mutex
	lookPath func(string) (string, error)
	run      Runner
	running  atomic.Bool // single-flight guard shared by Scan and SBOM
}

// acquire claims the single scanner slot; the caller must release() it.
func (s *Service) acquire() bool { return s.running.CompareAndSwap(false, true) }
func (s *Service) release()      { s.running.Store(false) }

func New() *Service {
	dir := os.Getenv("PULSENODE_DATA_DIR")
	if dir == "" {
		dir = "/var/lib/pulsenode"
	}
	_ = os.MkdirAll(dir, 0o755)
	s := &Service{dir: dir, lookPath: exec.LookPath, run: execRunner}
	s.purgeFakeHistory()
	// The Trivy cache used to live in the data volume next to the secrets; it now
	// has its own volume (TRIVY_CACHE_DIR). Reclaim the old copy in the background.
	go os.RemoveAll(filepath.Join(dir, "trivy-cache"))
	return s
}

// scannerMemLimit is the soft Go memory limit applied to trivy/syft child
// processes so their garbage collector works harder instead of growing past the
// container limit. Override with PULSENODE_SCANNER_MEMLIMIT (e.g. "1GiB").
func scannerMemLimit() string {
	if v := strings.TrimSpace(os.Getenv("PULSENODE_SCANNER_MEMLIMIT")); v != "" {
		return v
	}
	return "400MiB"
}

func execRunner(ctx context.Context, name string, args ...string) ([]byte, string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(), "GOMEMLIMIT="+scannerMemLimit())
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	tail := strings.TrimSpace(stderr.String())
	if len(tail) > 600 {
		tail = "…" + tail[len(tail)-600:]
	}
	return stdout.Bytes(), tail, err
}

// Status reports which scanner binaries are installed.
func (s *Service) Status() map[string]any {
	_, trivyErr := s.lookPath("trivy")
	_, syftErr := s.lookPath("syft")
	return map[string]any{"trivy": trivyErr == nil, "syft": syftErr == nil}
}

func (s *Service) Scans() []map[string]any {
	return s.readList("scans.json")
}

func (s *Service) SBOMs() []map[string]any {
	return s.readList("sboms.json")
}

// Scan runs Trivy against an image. If Trivy is not installed it returns a result
// with status "unavailable" (and a message) rather than inventing counts; that
// result is not persisted to the history.
func (s *Service) Scan(ctx context.Context, target string) (map[string]any, error) {
	target = strings.TrimSpace(target)
	if !validImageRef(target) {
		return nil, ErrInvalidRef
	}
	start := time.Now()
	result := map[string]any{
		"id":       fmt.Sprintf("scan_%x", start.UnixNano()%0xfffffff),
		"image":    target,
		"scanner":  "Trivy",
		"started":  start.Format("Jan 2, 3:04 PM"),
		"ts":       start.Unix(),
		"duration": "0s",
		"status":   StatusDone,
		"crit":     0, "high": 0, "med": 0, "low": 0,
	}
	if _, err := s.lookPath("trivy"); err != nil {
		result["status"] = StatusUnavailable
		result["message"] = "Trivy is not installed in this PulseNode image. Update PulseNode to get the built-in scanner."
		return result, nil
	}

	if !s.acquire() {
		return nil, ErrBusy
	}
	defer s.release()

	ctx, cancel := context.WithTimeout(ctx, scanTimeout)
	defer cancel()
	out, stderr, err := s.run(ctx, "trivy", "image", "--format", "json", "--quiet", "--no-progress", "--skip-version-check", "--scanners", "vuln", target)
	result["duration"] = fmt.Sprintf("%.1fs", time.Since(start).Seconds())
	if err != nil {
		result["status"] = StatusFailed
		msg := stderr
		if msg == "" {
			msg = err.Error()
		}
		result["message"] = msg
	} else {
		counts, perr := ParseTrivy(out)
		if perr != nil {
			result["status"] = StatusFailed
			result["message"] = "could not parse Trivy output: " + perr.Error()
		} else {
			result["crit"], result["high"], result["med"], result["low"] = counts[0], counts[1], counts[2], counts[3]
		}
	}
	s.prepend("scans.json", result)
	return result, nil
}

// ParseTrivy counts vulnerabilities by severity (crit, high, med, low) from
// `trivy image --format json` output.
func ParseTrivy(out []byte) ([4]int, error) {
	var counts [4]int
	var payload struct {
		Results []struct {
			Vulnerabilities []struct {
				Severity string `json:"Severity"`
			} `json:"Vulnerabilities"`
		} `json:"Results"`
	}
	if err := json.Unmarshal(out, &payload); err != nil {
		return counts, err
	}
	for _, res := range payload.Results {
		for _, v := range res.Vulnerabilities {
			switch strings.ToLower(v.Severity) {
			case "critical":
				counts[0]++
			case "high":
				counts[1]++
			case "medium":
				counts[2]++
			case "low":
				counts[3]++
			}
		}
	}
	return counts, nil
}

// SBOM generates a software bill of materials with Syft. Without Syft it returns
// status "unavailable"; nothing is fabricated or persisted.
func (s *Service) SBOM(ctx context.Context, target string, format string) (map[string]any, error) {
	target = strings.TrimSpace(target)
	if !validImageRef(target) {
		return nil, ErrInvalidRef
	}
	syftFormat := "spdx-json"
	if strings.Contains(format, "cyclone") {
		syftFormat = "cyclonedx-json"
	}
	result := map[string]any{"image": target, "status": StatusDone, "generated": time.Now().Format("Jan 2, 3:04 PM"), "ts": time.Now().Unix()}
	if _, err := s.lookPath("syft"); err != nil {
		result["status"] = StatusUnavailable
		result["message"] = "Syft is not installed in this PulseNode image. Update PulseNode to get the built-in SBOM generator."
		return result, nil
	}

	if !s.acquire() {
		return nil, ErrBusy
	}
	defer s.release()

	ctx, cancel := context.WithTimeout(ctx, scanTimeout)
	defer cancel()
	out, stderr, err := s.run(ctx, "syft", target, "-o", syftFormat, "-q")
	if err != nil {
		msg := stderr
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("syft failed: %s", msg)
	}
	var sum Summary
	if syftFormat == "spdx-json" {
		sum, err = ParseSPDX(out)
	} else {
		sum, err = ParseCycloneDX(out)
	}
	if err != nil {
		return nil, fmt.Errorf("could not parse Syft output: %w", err)
	}
	result["format"] = sum.Format
	result["packages"] = sum.Packages
	result["licenses"] = sum.Licenses
	result["ecosystem"] = sum.Ecosystem
	s.prepend("sboms.json", result)
	return result, nil
}

// Summary is the part of an SBOM the UI shows.
type Summary struct {
	Format    string
	Packages  int
	Licenses  int
	Ecosystem map[string]int
}

func ecoOf(purl string) string {
	switch {
	case strings.HasPrefix(purl, "pkg:golang/"):
		return "go"
	case strings.HasPrefix(purl, "pkg:npm/"):
		return "npm"
	case strings.HasPrefix(purl, "pkg:deb/"):
		return "deb"
	}
	return "other"
}

func newSummary(format string) Summary {
	return Summary{Format: format, Ecosystem: map[string]int{"go": 0, "npm": 0, "deb": 0, "other": 0}}
}

func ParseSPDX(out []byte) (Summary, error) {
	var doc struct {
		SPDXVersion string `json:"spdxVersion"`
		Packages    []struct {
			SPDXID           string `json:"SPDXID"`
			LicenseConcluded string `json:"licenseConcluded"`
			LicenseDeclared  string `json:"licenseDeclared"`
			ExternalRefs     []struct {
				Type    string `json:"referenceType"`
				Locator string `json:"referenceLocator"`
			} `json:"externalRefs"`
		} `json:"packages"`
	}
	if err := json.Unmarshal(out, &doc); err != nil {
		return Summary{}, err
	}
	if doc.SPDXVersion == "" {
		return Summary{}, errors.New("not an SPDX document")
	}
	sum := newSummary(strings.Replace(doc.SPDXVersion, "SPDX-", "SPDX ", 1))
	licenses := map[string]bool{}
	for _, p := range doc.Packages {
		if strings.HasPrefix(p.SPDXID, "SPDXRef-DocumentRoot") {
			continue // the scanned image itself, not a package inside it
		}
		sum.Packages++
		purl := ""
		for _, r := range p.ExternalRefs {
			if r.Type == "purl" {
				purl = r.Locator
				break
			}
		}
		sum.Ecosystem[ecoOf(purl)]++
		lic := p.LicenseConcluded
		if lic == "" || lic == "NOASSERTION" || lic == "NONE" {
			lic = p.LicenseDeclared
		}
		if lic != "" && lic != "NOASSERTION" && lic != "NONE" {
			licenses[lic] = true
		}
	}
	sum.Licenses = len(licenses)
	return sum, nil
}

func ParseCycloneDX(out []byte) (Summary, error) {
	var doc struct {
		BOMFormat   string `json:"bomFormat"`
		SpecVersion string `json:"specVersion"`
		Components  []struct {
			PURL     string `json:"purl"`
			Licenses []struct {
				License struct {
					ID   string `json:"id"`
					Name string `json:"name"`
				} `json:"license"`
				Expression string `json:"expression"`
			} `json:"licenses"`
		} `json:"components"`
	}
	if err := json.Unmarshal(out, &doc); err != nil {
		return Summary{}, err
	}
	if doc.BOMFormat != "CycloneDX" {
		return Summary{}, errors.New("not a CycloneDX document")
	}
	sum := newSummary("CycloneDX " + doc.SpecVersion)
	licenses := map[string]bool{}
	for _, c := range doc.Components {
		sum.Packages++
		sum.Ecosystem[ecoOf(c.PURL)]++
		for _, l := range c.Licenses {
			for _, v := range []string{l.License.ID, l.License.Name, l.Expression} {
				if v != "" {
					licenses[v] = true
					break
				}
			}
		}
	}
	sum.Licenses = len(licenses)
	return sum, nil
}

func (s *Service) readList(name string) []map[string]any {
	items := []map[string]any{}
	data, err := os.ReadFile(filepath.Join(s.dir, name))
	if err != nil {
		return items
	}
	if json.Unmarshal(data, &items) != nil || items == nil {
		return []map[string]any{}
	}
	return items
}

func (s *Service) prepend(name string, item map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := append([]map[string]any{item}, s.readList(name)...)
	if len(items) > maxKept {
		items = items[:maxKept]
	}
	data, err := json.MarshalIndent(items, "", "  ")
	if err != nil {
		return
	}
	tmp := filepath.Join(s.dir, name+".tmp")
	if os.WriteFile(tmp, data, 0o644) == nil {
		_ = os.Rename(tmp, filepath.Join(s.dir, name))
	}
}

const purgeMarker = ".fake-history-purged"

var fakeDuration = regexp.MustCompile(`^\d+s$`)

// purgeFakeHistory removes entries written by the old scanner that made up its
// numbers, once (a marker file records it ran). They are distinguishable: the old
// fake scan reported a whole-second duration ("23s") while a real run always has
// a decimal ("23.4s") and every current entry carries "ts"; old SBOMs never had
// a "status" field, which current ones always do. The originals are kept as
// <name>.json.bak.
func (s *Service) purgeFakeHistory() {
	marker := filepath.Join(s.dir, purgeMarker)
	if _, err := os.Stat(marker); err == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.purgeList("scans.json", func(it map[string]any) bool {
		_, hasTS := it["ts"]
		d, _ := it["duration"].(string)
		return !hasTS && fakeDuration.MatchString(d)
	})
	s.purgeList("sboms.json", func(it map[string]any) bool {
		_, hasStatus := it["status"]
		return !hasStatus
	})
	_ = os.WriteFile(marker, []byte("1\n"), 0o600)
}

func (s *Service) purgeList(name string, fake func(map[string]any) bool) {
	path := filepath.Join(s.dir, name)
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var items []map[string]any
	if json.Unmarshal(data, &items) != nil {
		return
	}
	kept := make([]map[string]any, 0, len(items))
	for _, it := range items {
		if !fake(it) {
			kept = append(kept, it)
		}
	}
	if len(kept) == len(items) {
		return
	}
	_ = os.WriteFile(path+".bak", data, 0o600)
	out, _ := json.MarshalIndent(kept, "", "  ")
	_ = os.WriteFile(path, out, 0o600)
}
