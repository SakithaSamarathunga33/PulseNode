package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// updateRecord is what go-api persists about the update in progress, so the
// Settings page can still say what happened after the container restarted
// (the in-memory update state does not survive the swap).
type updateRecord struct {
	ID           string    `json:"id"`
	StartedAt    time.Time `json:"startedAt"`
	Phase        string    `json:"phase"` // preflight | snapshot | pulling | building | switching | failed
	Error        string    `json:"error,omitempty"`
	FromVersion  string    `json:"fromVersion"`
	ToVersion    string    `json:"toVersion"`
	SnapshotPath string    `json:"snapshotPath,omitempty"`
	SchemaBefore string    `json:"schemaBefore,omitempty"`
	PrevCommit   string    `json:"prevCommit,omitempty"`
	PostCommit   string    `json:"postCommit,omitempty"`
	PrevBoot     int64     `json:"prevBoot"`
	ImageTag     string    `json:"imageTag,omitempty"` // pinned release tag; empty = :latest / source build
	Pinned       bool      `json:"pinned"`
}

// updateResult is written by the detached updater (a different container) once
// it has verified the new version or rolled back.
type updateResult struct {
	ID              string    `json:"id"`
	OK              bool      `json:"ok"`
	RolledBack      bool      `json:"rolledBack"`
	RollbackHealthy bool      `json:"rollbackHealthy"`
	Error           string    `json:"error,omitempty"`
	FinishedAt      time.Time `json:"finishedAt"`
	Log             []string  `json:"log"`
}

func newUpdateID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return time.Now().UTC().Format("20060102T150405Z") + "-" + hex.EncodeToString(b)
}

func updateDataDir() string {
	return firstNonEmpty(os.Getenv("PULSENODE_DATA_DIR"), "/var/lib/pulsenode")
}

func updateRecordPath() string { return filepath.Join(updateDataDir(), "update-record.json") }

// updateResultPath is inside the workspace (a host bind mount), because the
// updater runs in a separate container that cannot see go-api's data volume.
func updateResultPath() string {
	return filepath.Join(workspaceDir(), ".pulsenode", "update-result.json")
}

func writeJSONFile(path string, v any, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func readJSONFile(path string, v any) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return json.Unmarshal(data, v) == nil
}

// updateView is the status shape sent to the dashboard.
type updateView struct {
	Phase           string
	Error           string
	RolledBack      bool
	RollbackHealthy bool
	FinishedAt      *time.Time
	Log             []string
}

// mergeUpdateResult combines the persisted record with the updater's result.
// A result only counts when it belongs to the same update (matching id).
// Pure, so the precedence rules are unit-tested.
func mergeUpdateResult(rec *updateRecord, res *updateResult) updateView {
	if rec == nil {
		return updateView{Phase: "idle"}
	}
	v := updateView{Phase: rec.Phase, Error: rec.Error}
	if res != nil && res.ID == rec.ID {
		fin := res.FinishedAt
		v.FinishedAt = &fin
		v.Log = res.Log
		switch {
		case res.OK:
			v.Phase, v.Error = "done", ""
		case res.RolledBack:
			v.Phase, v.RolledBack, v.RollbackHealthy, v.Error = "rolled_back", true, res.RollbackHealthy, res.Error
		default:
			v.Phase, v.Error = "failed", res.Error
		}
	}
	return v
}

// ---- release pinning --------------------------------------------------------

var (
	githubAPIBase    = "https://api.github.com"
	ghcrRegistryBase = "https://ghcr.io"
	releaseRepo      = "SakithaSamarathunga33/PulseNode"
	ghcrImageRe      = regexp.MustCompile(`image:\s*ghcr\.io/([A-Za-z0-9._/-]+)`)
)

// ghcrRepos lists the repositories (owner/name) named in the ghcr overlay.
func ghcrRepos(overlay string) []string {
	var repos []string
	seen := map[string]bool{}
	for _, m := range ghcrImageRe.FindAllStringSubmatch(overlay, -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			repos = append(repos, m[1])
		}
	}
	return repos
}

type tagCheck struct {
	Exists bool
	Err    error
}

type pinDecision struct {
	Action  string // pin | refuse | fallback
	Tag     string
	Message string
}

// decidePin turns the registry facts into an action. Pure.
//   - the images for the release are all published      → pin to that tag
//   - the registry says one is definitely missing       → refuse (release is still building)
//   - we could not find out (offline, API error)        → fall back to :latest, loudly
func decidePin(tag string, tagErr error, checks map[string]tagCheck) pinDecision {
	if tagErr != nil || tag == "" {
		return pinDecision{Action: "fallback", Message: fmt.Sprintf("could not determine the latest release (%v)", tagErr)}
	}
	var missing []string
	var unknown error
	for repo, c := range checks {
		switch {
		case c.Err != nil:
			unknown = c.Err
		case !c.Exists:
			missing = append(missing, repo)
		}
	}
	if len(missing) > 0 {
		return pinDecision{Action: "refuse", Tag: tag, Message: fmt.Sprintf("release %s is still building — its images are not published yet (%s). Try again in a few minutes.", tag, strings.Join(missing, ", "))}
	}
	if unknown != nil {
		return pinDecision{Action: "fallback", Tag: tag, Message: fmt.Sprintf("could not verify the release images (%v)", unknown)}
	}
	return pinDecision{Action: "pin", Tag: tag}
}

type releaseResolver struct{ client *http.Client }

func newReleaseResolver() releaseResolver {
	return releaseResolver{client: &http.Client{Timeout: 10 * time.Second}}
}

func (r releaseResolver) latestTag(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, githubAPIBase+"/repos/"+releaseRepo+"/releases/latest", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := r.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("github api %d", resp.StatusCode)
	}
	var rel struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return "", err
	}
	return rel.TagName, nil
}

// imageTagExists asks the registry (anonymous pull token) whether repo:tag has a manifest.
func (r releaseResolver) imageTagExists(ctx context.Context, repo, tag string) (bool, error) {
	tokenURL := ghcrRegistryBase + "/token?service=ghcr.io&scope=" + url.QueryEscape("repository:"+repo+":pull")
	treq, err := http.NewRequestWithContext(ctx, http.MethodGet, tokenURL, nil)
	if err != nil {
		return false, err
	}
	tresp, err := r.client.Do(treq)
	if err != nil {
		return false, err
	}
	defer tresp.Body.Close()
	if tresp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("registry token %d", tresp.StatusCode)
	}
	var tok struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(tresp.Body).Decode(&tok); err != nil || tok.Token == "" {
		return false, fmt.Errorf("registry token unreadable")
	}
	mreq, err := http.NewRequestWithContext(ctx, http.MethodHead, ghcrRegistryBase+"/v2/"+repo+"/manifests/"+url.PathEscape(tag), nil)
	if err != nil {
		return false, err
	}
	mreq.Header.Set("Authorization", "Bearer "+tok.Token)
	mreq.Header.Set("Accept", strings.Join([]string{
		"application/vnd.oci.image.index.v1+json",
		"application/vnd.oci.image.manifest.v1+json",
		"application/vnd.docker.distribution.manifest.list.v2+json",
		"application/vnd.docker.distribution.manifest.v2+json",
	}, ", "))
	mresp, err := r.client.Do(mreq)
	if err != nil {
		return false, err
	}
	defer mresp.Body.Close()
	switch mresp.StatusCode {
	case http.StatusOK:
		return true, nil
	case http.StatusNotFound:
		return false, nil
	default:
		return false, fmt.Errorf("registry answered %d for %s:%s", mresp.StatusCode, repo, tag)
	}
}

// resolvePin finds the latest release and checks every ghcr image for it.
func (r releaseResolver) resolvePin(ctx context.Context, overlay string) pinDecision {
	tag, err := r.latestTag(ctx)
	if err != nil {
		return decidePin("", err, nil)
	}
	checks := map[string]tagCheck{}
	for _, repo := range ghcrRepos(overlay) {
		ok, err := r.imageTagExists(ctx, repo, tag)
		checks[repo] = tagCheck{Exists: ok, Err: err}
	}
	return decidePin(tag, nil, checks)
}

// ---- recorded images / .env.local helpers ------------------------------------

// composeImage is one running service's image, recorded before the swap so a
// rollback can point the same reference back at the old image.
type composeImage struct {
	Service string
	Ref     string // image reference as compose runs it (tag or name)
	ID      string // immutable image id (sha256:…)
}

const imageSep = "@@"

func encodeImages(imgs []composeImage) string {
	parts := make([]string, 0, len(imgs))
	for _, i := range imgs {
		if i.Ref == "" || i.ID == "" {
			continue
		}
		parts = append(parts, i.Service+imageSep+i.Ref+imageSep+i.ID)
	}
	return strings.Join(parts, ",")
}

func parseImages(s string) []composeImage {
	var out []composeImage
	for _, p := range strings.Split(s, ",") {
		f := strings.Split(strings.TrimSpace(p), imageSep)
		if len(f) == 3 && f[1] != "" && f[2] != "" {
			out = append(out, composeImage{Service: f[0], Ref: f[1], ID: f[2]})
		}
	}
	return out
}

// gitRollbackAllowed decides whether the updater may `git reset --hard` back to
// the pre-update commit. It must never discard anyone's work, so it only does
// so when: the update really moved HEAD, the tree had no tracked local changes
// before the update, none now, and HEAD is still exactly the commit we pulled.
func gitRollbackAllowed(preDirty bool, prevCommit, postCommit, headNow string, cleanNow bool) bool {
	return prevCommit != "" && postCommit != "" && prevCommit != postCommit &&
		!preDirty && cleanNow && headNow == postCommit
}

// setEnvFileVar sets (or, with remove, deletes) KEY in an env file, refusing
// anything that could inject extra lines (same rules as upsertEnvLocal).
func setEnvFileVar(path, key, value string, remove bool) error {
	if !envKeyRe.MatchString(key) {
		return fmt.Errorf("invalid env key %q", key)
	}
	if strings.ContainsAny(value, "\r\n\x00") {
		return errInvalidEnvValue
	}
	var lines []string
	if data, err := os.ReadFile(path); err == nil {
		lines = strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	}
	out := make([]string, 0, len(lines)+1)
	found := false
	for _, l := range lines {
		if strings.HasPrefix(l, key+"=") {
			if found || remove {
				continue
			}
			l, found = key+"="+value, true
		}
		out = append(out, l)
	}
	if !found && !remove {
		out = append(out, key+"="+value)
	}
	content := strings.Join(out, "\n")
	if content != "" {
		content += "\n"
	}
	return os.WriteFile(path, []byte(content), 0o600)
}
