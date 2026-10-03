package github

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var apiBase = "https://api.github.com"

type Client struct {
	token string
	http  *http.Client
}

func NewClient(token string) *Client {
	return &Client{token: token, http: &http.Client{Timeout: 10 * time.Second}}
}

// doGet issues an authenticated GET request and returns the raw response.
// Callers must close resp.Body.
func (c *Client) doGet(path string) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodGet, apiBase+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	return c.http.Do(req)
}

func (c *Client) get(path string, out any) error {
	resp, err := c.doGet(path)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("github api %s: %d", path, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (c *Client) post(path string, in any) error {
	data, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, apiBase+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("github api %s: %d %s", path, resp.StatusCode, strings.TrimSpace(string(b)))
	}
	return nil
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

type Hook struct {
	ID     int64 `json:"id"`
	Active bool  `json:"active"`
	Config struct {
		URL string `json:"url"`
	} `json:"config"`
}

func (c *Client) listHooks(owner, repo string) ([]Hook, error) {
	var hooks []Hook
	err := c.get(fmt.Sprintf("%s/hooks?per_page=100", repoPath(owner, repo)), &hooks)
	return hooks, err
}

// HasWebhook reports whether a hook delivering to hookURL already exists on the repo.
func (c *Client) HasWebhook(owner, repo, hookURL string) (bool, error) {
	hooks, err := c.listHooks(owner, repo)
	if err != nil {
		return false, err
	}
	for _, h := range hooks {
		if strings.EqualFold(h.Config.URL, hookURL) {
			return true, nil
		}
	}
	return false, nil
}

// EnsureWebhook creates a push webhook delivering to hookURL if one isn't already
// present. Returns created=true only when a new hook was added (idempotent).
// Requires the token to have admin rights on the repo (the `repo` OAuth scope or
// a PAT with `admin:repo_hook`).
func (c *Client) EnsureWebhook(owner, repo, hookURL, secret string) (created bool, err error) {
	exists, err := c.HasWebhook(owner, repo, hookURL)
	if err != nil {
		return false, err
	}
	if exists {
		return false, nil
	}
	body := map[string]any{
		"name":   "web",
		"active": true,
		"events": []string{"push"},
		"config": map[string]string{
			"url":          hookURL,
			"content_type": "json",
			"secret":       secret,
			"insecure_ssl": "0",
		},
	}
	if err := c.post(fmt.Sprintf("%s/hooks", repoPath(owner, repo)), body); err != nil {
		return false, err
	}
	return true, nil
}

// ── User ──────────────────────────────────────────────────────────────────────

type User struct {
	Login     string `json:"login"`
	AvatarURL string `json:"avatar_url"`
	Name      string `json:"name"`
}

func (c *Client) CurrentUser() (*User, error) {
	var u User
	return &u, c.get("/user", &u)
}

// ── Repos ─────────────────────────────────────────────────────────────────────

type Repo struct {
	ID            int64  `json:"id"`
	Name          string `json:"name"`
	FullName      string `json:"full_name"`
	Private       bool   `json:"private"`
	DefaultBranch string `json:"default_branch"`
	HTMLURL       string `json:"html_url"`
	CloneURL      string `json:"clone_url"`
	Description   string `json:"description"`
	Language      string `json:"language"`
}

func (c *Client) ListRepos() ([]Repo, error) {
	var repos []Repo
	page := 1
	for {
		var page_repos []Repo
		path := fmt.Sprintf("/user/repos?per_page=100&page=%d&sort=updated&type=all", page)
		if err := c.get(path, &page_repos); err != nil {
			return nil, err
		}
		repos = append(repos, page_repos...)
		if len(page_repos) < 100 {
			break
		}
		page++
		if page > 5 { // cap at 500 repos
			break
		}
	}
	return repos, nil
}

func (c *Client) ListBranches(owner, repo string) ([]string, error) {
	var raw []struct {
		Name string `json:"name"`
	}
	if err := c.get(fmt.Sprintf("%s/branches?per_page=100", repoPath(owner, repo)), &raw); err != nil {
		return nil, err
	}
	branches := make([]string, len(raw))
	for i, b := range raw {
		branches[i] = b.Name
	}
	return branches, nil
}

// Content is one entry from the repo contents API.
type Content struct {
	Name string `json:"name"`
	Type string `json:"type"` // "dir" | "file"
}

// ListContents lists the entries at path (use "" for the repo root) on ref
// (a branch, tag, or SHA; "" for the default branch).
func (c *Client) ListContents(owner, repo, path, ref string) ([]Content, error) {
	p := fmt.Sprintf("%s/contents", repoPath(owner, repo))
	if path != "" {
		p += "/" + path
	}
	if ref != "" {
		p += "?ref=" + url.QueryEscape(ref)
	}
	var out []Content
	if err := c.get(p, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetBranchHead returns the latest commit SHA and message for a branch.
func (c *Client) GetBranchHead(owner, repo, branch string) (sha, msg string, err error) {
	var raw struct {
		Commit struct {
			SHA    string `json:"sha"`
			Commit struct {
				Message string `json:"message"`
			} `json:"commit"`
		} `json:"commit"`
	}
	path := fmt.Sprintf("%s/branches/%s", repoPath(owner, repo), url.PathEscape(branch))
	if err = c.get(path, &raw); err != nil {
		return "", "", err
	}
	msg = raw.Commit.Commit.Message
	if i := strings.IndexByte(msg, '\n'); i >= 0 {
		msg = msg[:i] // first line only
	}
	return raw.Commit.SHA, strings.TrimSpace(msg), nil
}

// ParseOwnerRepo extracts "owner" and "repo" from a GitHub clone/HTML URL.
// The host must be exactly github.com (or www.github.com) — no substring match, so
// https://github.com.evil.org/o/r and https://evil.example/github.com/o/r are rejected.
// Supports https://github.com/owner/repo(.git), http://…, ssh://git@github.com/o/r
// and the scp form git@github.com:owner/repo(.git).
func ParseOwnerRepo(repoURL string) (owner, repo string, ok bool) {
	s := strings.TrimSpace(repoURL)
	var host, path string
	if i := strings.Index(s, "://"); i >= 0 {
		switch strings.ToLower(s[:i]) {
		case "https", "http", "ssh", "git":
		default:
			return "", "", false
		}
		u, err := url.Parse(s)
		if err != nil {
			return "", "", false
		}
		// Embedded credentials (https://user:pw@…) are never accepted: the token is
		// passed separately, and this keeps look-alike userinfo tricks out.
		if u.User != nil && u.Scheme != "ssh" && u.Scheme != "git" {
			return "", "", false
		}
		host, path = u.Hostname(), u.EscapedPath()
		if u.RawQuery != "" || u.Fragment != "" {
			return "", "", false
		}
	} else {
		colon := strings.Index(s, ":")
		switch slash := strings.Index(s, "/"); {
		case colon >= 0 && (slash < 0 || colon < slash):
			// scp-style: [user@]host:owner/repo
			hostPart := s[:colon]
			if at := strings.LastIndex(hostPart, "@"); at >= 0 {
				hostPart = hostPart[at+1:]
			}
			host, path = hostPart, s[colon+1:]
		case slash > 0 && colon < 0:
			// scheme-less: github.com/owner/repo
			host, path = s[:slash], s[slash+1:]
		default:
			return "", "", false
		}
	}
	host = strings.ToLower(host)
	if host != "github.com" && host != "www.github.com" {
		return "", "", false
	}
	path = strings.TrimSuffix(strings.Trim(path, "/"), ".git")
	parts := strings.Split(path, "/")
	// Extra segments are tolerated for pasted HTML URLs (…/o/r/tree/main); the
	// owner and repo themselves are always charset-validated.
	if len(parts) < 2 || !ValidOwnerRepo(parts[0], parts[1]) {
		return "", "", false
	}
	return parts[0], parts[1], true
}

// ownerRepoRe is what GitHub allows in an owner or repo name. Anything else
// (/, ?, #, %, ..) could redirect an authenticated API call to another endpoint.
var ownerRepoRe = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

// ValidOwnerRepo reports whether owner and repo are safe to put in an API path.
func ValidOwnerRepo(owner, repo string) bool {
	for _, v := range []string{owner, repo} {
		if v == "." || v == ".." || !ownerRepoRe.MatchString(v) {
			return false
		}
	}
	return true
}

// repoPath is "/repos/<owner>/<repo>" for validated names. Invalid ones map to a
// path that cannot exist, so the request 404s instead of reaching another endpoint.
func repoPath(owner, repo string) string {
	if !ValidOwnerRepo(owner, repo) {
		return "/repos/_invalid_/_invalid_"
	}
	return "/repos/" + owner + "/" + repo
}

// ── OAuth ─────────────────────────────────────────────────────────────────────

func AuthURL(callbackURL, state string) string {
	clientID := os.Getenv("GITHUB_CLIENT_ID")
	params := url.Values{}
	params.Set("client_id", clientID)
	params.Set("redirect_uri", callbackURL)
	params.Set("scope", "repo read:user")
	params.Set("state", state)
	return "https://github.com/login/oauth/authorize?" + params.Encode()
}

func ExchangeCode(code, callbackURL string) (string, error) {
	clientID := os.Getenv("GITHUB_CLIENT_ID")
	clientSecret := os.Getenv("GITHUB_CLIENT_SECRET")
	if clientID == "" || clientSecret == "" {
		return "", fmt.Errorf("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set")
	}

	params := url.Values{}
	params.Set("client_id", clientID)
	params.Set("client_secret", clientSecret)
	params.Set("code", code)
	params.Set("redirect_uri", callbackURL)

	req, err := http.NewRequest(http.MethodPost,
		"https://github.com/login/oauth/access_token",
		strings.NewReader(params.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var result struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
		ErrorDesc   string `json:"error_description"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	if result.Error != "" {
		return "", fmt.Errorf("github oauth: %s — %s", result.Error, result.ErrorDesc)
	}
	return result.AccessToken, nil
}

// ── Pull requests, issues, commits, workflow runs ──────────────────────────────

type PullRequest struct {
	ExternalID string `json:"external_id"`
	Number     int    `json:"number"`
	Title      string `json:"title"`
	State      string `json:"state"`
	Author     string `json:"author"`
	URL        string `json:"url"`
}

type Issue struct {
	ExternalID string `json:"external_id"`
	Number     int    `json:"number"`
	Title      string `json:"title"`
	State      string `json:"state"`
	URL        string `json:"url"`
}

type Commit struct {
	SHA     string `json:"sha"`
	Message string `json:"message"`
}

type WorkflowRun struct {
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
}

// ListOpenPullRequests lists open pull requests for a repo.
func (c *Client) ListOpenPullRequests(owner, repo string) ([]PullRequest, error) {
	var raw []struct {
		ID     int64  `json:"id"`
		Number int    `json:"number"`
		Title  string `json:"title"`
		State  string `json:"state"`
		User   struct {
			Login string `json:"login"`
		} `json:"user"`
		HTMLURL string `json:"html_url"`
	}
	if err := c.get(fmt.Sprintf("%s/pulls?state=open", repoPath(owner, repo)), &raw); err != nil {
		return nil, err
	}
	prs := make([]PullRequest, len(raw))
	for i, p := range raw {
		prs[i] = PullRequest{
			ExternalID: strconv.FormatInt(p.ID, 10),
			Number:     p.Number,
			Title:      p.Title,
			State:      p.State,
			Author:     p.User.Login,
			URL:        p.HTMLURL,
		}
	}
	return prs, nil
}

// ListOpenIssues lists open issues for a repo, excluding pull requests
// (GitHub's issues API returns PRs alongside real issues).
func (c *Client) ListOpenIssues(owner, repo string) ([]Issue, error) {
	var raw []struct {
		ID          int64           `json:"id"`
		Number      int             `json:"number"`
		Title       string          `json:"title"`
		State       string          `json:"state"`
		HTMLURL     string          `json:"html_url"`
		PullRequest json.RawMessage `json:"pull_request,omitempty"`
	}
	if err := c.get(fmt.Sprintf("%s/issues?state=open", repoPath(owner, repo)), &raw); err != nil {
		return nil, err
	}
	issues := make([]Issue, 0, len(raw))
	for _, it := range raw {
		if len(it.PullRequest) > 0 {
			continue
		}
		issues = append(issues, Issue{
			ExternalID: strconv.FormatInt(it.ID, 10),
			Number:     it.Number,
			Title:      it.Title,
			State:      it.State,
			URL:        it.HTMLURL,
		})
	}
	return issues, nil
}

// GetLatestCommit returns the most recent commit on a repo's default branch,
// or nil if the repo has no commits yet (GitHub returns 409 for an empty repo).
func (c *Client) GetLatestCommit(owner, repo string) (*Commit, error) {
	resp, err := c.doGet(fmt.Sprintf("%s/commits?per_page=1", repoPath(owner, repo)))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusConflict {
		return nil, nil
	}
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("github api /repos/%s/%s/commits: %d", owner, repo, resp.StatusCode)
	}
	var commits []struct {
		SHA    string `json:"sha"`
		Commit struct {
			Message string `json:"message"`
		} `json:"commit"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&commits); err != nil {
		return nil, err
	}
	if len(commits) == 0 {
		return nil, nil
	}
	msg := commits[0].Commit.Message
	if i := strings.IndexByte(msg, '\n'); i >= 0 {
		msg = msg[:i]
	}
	return &Commit{SHA: commits[0].SHA, Message: strings.TrimSpace(msg)}, nil
}

// GetLatestWorkflowRun returns the most recent GitHub Actions run for a repo,
// or nil if there are none.
func (c *Client) GetLatestWorkflowRun(owner, repo string) (*WorkflowRun, error) {
	var raw struct {
		WorkflowRuns []struct {
			Status     string `json:"status"`
			Conclusion string `json:"conclusion"`
		} `json:"workflow_runs"`
	}
	if err := c.get(fmt.Sprintf("%s/actions/runs?per_page=1", repoPath(owner, repo)), &raw); err != nil {
		return nil, err
	}
	if len(raw.WorkflowRuns) == 0 {
		return nil, nil
	}
	return &WorkflowRun{Status: raw.WorkflowRuns[0].Status, Conclusion: raw.WorkflowRuns[0].Conclusion}, nil
}

// ── Repo contents & history ───────────────────────────────────────────────────

// APIStatusError carries the GitHub HTTP status to handlers so 409 (stale
// blob sha) and 403 (missing Contents write permission) survive the trip
// instead of collapsing into a generic error.
type APIStatusError struct {
	StatusCode int
	Msg        string
}

func (e *APIStatusError) Error() string {
	return fmt.Sprintf("github api: %d %s", e.StatusCode, e.Msg)
}

type CommitDetail struct {
	SHA         string `json:"sha"`
	Message     string `json:"message"`
	AuthorName  string `json:"author_name"`
	AuthorLogin string `json:"author_login"`
	Date        string `json:"date"`
	URL         string `json:"url"`
}

type TreeEntry struct {
	Path string `json:"path"`
	Type string `json:"type"` // "blob" | "tree"
	Size int64  `json:"size"`
}

type FileContent struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	SHA      string `json:"sha"`
	Size     int64  `json:"size"`
	Encoding string `json:"encoding"` // "text" | "binary" | "too_large"
}

type FileUpdateResult struct {
	SHA       string `json:"sha"`
	CommitURL string `json:"commit_url"`
}

const maxEditableFileSize = 1 << 20 // 1 MB

// escapeRepoPath escapes each path segment but keeps the "/" separators.
func escapeRepoPath(p string) string {
	parts := strings.Split(p, "/")
	for i, seg := range parts {
		parts[i] = url.PathEscape(seg)
	}
	return strings.Join(parts, "/")
}

func statusError(resp *http.Response, context string) *APIStatusError {
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	msg := strings.TrimSpace(string(b))
	if msg == "" {
		msg = context
	}
	return &APIStatusError{StatusCode: resp.StatusCode, Msg: msg}
}

// ListRecentCommits returns up to limit commits from the default branch,
// newest first. limit outside 1..100 falls back to 50. An empty repo
// (GitHub 409) yields an empty slice, matching GetLatestCommit.
func (c *Client) ListRecentCommits(owner, repo string, limit int) ([]CommitDetail, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	resp, err := c.doGet(fmt.Sprintf("%s/commits?per_page=%d", repoPath(owner, repo), limit))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusConflict {
		return []CommitDetail{}, nil
	}
	if resp.StatusCode >= 300 {
		return nil, statusError(resp, fmt.Sprintf("%s/commits", repoPath(owner, repo)))
	}
	var raw []struct {
		SHA    string `json:"sha"`
		Commit struct {
			Message string `json:"message"`
			Author  struct {
				Name string `json:"name"`
				Date string `json:"date"`
			} `json:"author"`
		} `json:"commit"`
		Author *struct {
			Login string `json:"login"`
		} `json:"author"`
		HTMLURL string `json:"html_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}
	out := make([]CommitDetail, len(raw))
	for i, item := range raw {
		msg := item.Commit.Message
		if idx := strings.IndexByte(msg, '\n'); idx >= 0 {
			msg = msg[:idx]
		}
		login := ""
		if item.Author != nil {
			login = item.Author.Login
		}
		out[i] = CommitDetail{
			SHA:         item.SHA,
			Message:     strings.TrimSpace(msg),
			AuthorName:  item.Commit.Author.Name,
			AuthorLogin: login,
			Date:        item.Commit.Author.Date,
			URL:         item.HTMLURL,
		}
	}
	return out, nil
}

// GetTree returns the full recursive tree of ref ("" means HEAD, i.e. the
// default branch).
func (c *Client) GetTree(owner, repo, ref string) ([]TreeEntry, error) {
	if ref == "" {
		ref = "HEAD"
	}
	resp, err := c.doGet(fmt.Sprintf("%s/git/trees/%s?recursive=1", repoPath(owner, repo), url.PathEscape(ref)))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return nil, statusError(resp, fmt.Sprintf("%s/git/trees/%s", repoPath(owner, repo), ref))
	}
	var raw struct {
		Tree []TreeEntry `json:"tree"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}
	if raw.Tree == nil {
		raw.Tree = []TreeEntry{}
	}
	return raw.Tree, nil
}

// GetFile returns one file's decoded content and blob sha. Files over 1 MB
// come back with Encoding "too_large" and no content (GitHub omits inline
// content for them too); non-UTF-8 content comes back as "binary".
func (c *Client) GetFile(owner, repo, path, ref string) (*FileContent, error) {
	p := fmt.Sprintf("%s/contents/%s", repoPath(owner, repo), escapeRepoPath(path))
	if ref != "" {
		p += "?ref=" + url.QueryEscape(ref)
	}
	resp, err := c.doGet(p)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return nil, statusError(resp, p)
	}
	var raw struct {
		Path     string `json:"path"`
		SHA      string `json:"sha"`
		Size     int64  `json:"size"`
		Content  string `json:"content"`
		Encoding string `json:"encoding"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}
	out := &FileContent{Path: raw.Path, SHA: raw.SHA, Size: raw.Size}
	if raw.Size > maxEditableFileSize || raw.Encoding == "none" {
		out.Encoding = "too_large"
		return out, nil
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(raw.Content, "\n", ""))
	if err != nil {
		return nil, err
	}
	if !utf8.Valid(decoded) || strings.ContainsRune(string(decoded), 0) {
		out.Encoding = "binary"
		return out, nil
	}
	out.Content = string(decoded)
	out.Encoding = "text"
	return out, nil
}

// UpdateFile commits new content to path on branch. sha must be the file's
// current blob sha; a stale sha surfaces as *APIStatusError with 409 (GitHub
// answers 409 or 422 for that case — both are normalized to 409).
func (c *Client) UpdateFile(owner, repo, path, branch, message, content, sha string) (*FileUpdateResult, error) {
	body := map[string]any{
		"message": message,
		"content": base64.StdEncoding.EncodeToString([]byte(content)),
		"sha":     sha,
	}
	if branch != "" {
		body["branch"] = branch
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPut,
		apiBase+fmt.Sprintf("%s/contents/%s", repoPath(owner, repo), escapeRepoPath(path)),
		bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusConflict || resp.StatusCode == http.StatusUnprocessableEntity {
		e := statusError(resp, "stale file sha")
		e.StatusCode = http.StatusConflict
		return nil, e
	}
	if resp.StatusCode >= 300 {
		return nil, statusError(resp, fmt.Sprintf("%s/contents/%s", repoPath(owner, repo), path))
	}
	var raw struct {
		Content struct {
			SHA string `json:"sha"`
		} `json:"content"`
		Commit struct {
			HTMLURL string `json:"html_url"`
		} `json:"commit"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}
	return &FileUpdateResult{SHA: raw.Content.SHA, CommitURL: raw.Commit.HTMLURL}, nil
}
