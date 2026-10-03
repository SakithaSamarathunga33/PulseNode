package github

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func withTestServer(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	old := apiBase
	apiBase = srv.URL
	t.Cleanup(func() { apiBase = old })
	return NewClient("test-token")
}

func TestListOpenPullRequests(t *testing.T) {
	client := withTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/acme/widgets/pulls" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if got := r.URL.Query().Get("state"); got != "open" {
			t.Fatalf("state = %q, want open", got)
		}
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{
				"id":       1,
				"number":   7,
				"title":    "Add feature",
				"state":    "open",
				"user":     map[string]any{"login": "octocat"},
				"html_url": "https://github.com/acme/widgets/pull/7",
			},
		})
	})

	prs, err := client.ListOpenPullRequests("acme", "widgets")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(prs) != 1 {
		t.Fatalf("len(prs) = %d, want 1", len(prs))
	}
	want := PullRequest{ExternalID: "1", Number: 7, Title: "Add feature", State: "open", Author: "octocat", URL: "https://github.com/acme/widgets/pull/7"}
	if prs[0] != want {
		t.Fatalf("prs[0] = %+v, want %+v", prs[0], want)
	}
}

func TestListOpenIssuesSkipsPullRequests(t *testing.T) {
	client := withTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"id": 2, "number": 3, "title": "Bug", "state": "open", "html_url": "https://github.com/acme/widgets/issues/3"},
			{"id": 4, "number": 5, "title": "A PR, not an issue", "state": "open", "html_url": "https://github.com/acme/widgets/pull/5", "pull_request": map[string]any{}},
		})
	})

	issues, err := client.ListOpenIssues("acme", "widgets")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(issues) != 1 {
		t.Fatalf("len(issues) = %d, want 1 (PR entry should be filtered out)", len(issues))
	}
	want := Issue{ExternalID: "2", Number: 3, Title: "Bug", State: "open", URL: "https://github.com/acme/widgets/issues/3"}
	if issues[0] != want {
		t.Fatalf("issues[0] = %+v, want %+v", issues[0], want)
	}
}

func TestGetLatestCommit(t *testing.T) {
	client := withTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"sha": "abc123def456", "commit": map[string]any{"message": "Fix bug\n\nLonger body"}},
		})
	})

	commit, err := client.GetLatestCommit("acme", "widgets")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if commit == nil {
		t.Fatal("commit = nil, want non-nil")
	}
	if commit.SHA != "abc123def456" || commit.Message != "Fix bug" {
		t.Fatalf("commit = %+v", commit)
	}
}

func TestGetLatestCommitReturnsNilForEmptyRepository(t *testing.T) {
	client := withTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]string{"message": "Git Repository is empty."})
	})

	commit, err := client.GetLatestCommit("acme", "empty-repo")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if commit != nil {
		t.Fatalf("commit = %+v, want nil", commit)
	}
}

func TestListOpenPullRequestsEmptyResult(t *testing.T) {
	client := withTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/acme/widgets/pulls" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if got := r.URL.Query().Get("state"); got != "open" {
			t.Fatalf("state = %q, want open", got)
		}
		_ = json.NewEncoder(w).Encode([]any{})
	})

	prs, err := client.ListOpenPullRequests("acme", "widgets")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if prs == nil {
		t.Fatal("prs = nil, want non-nil empty slice")
	}
	if len(prs) != 0 {
		t.Fatalf("len(prs) = %d, want 0", len(prs))
	}
}

func TestListOpenIssuesEmptyResult(t *testing.T) {
	client := withTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]any{})
	})

	issues, err := client.ListOpenIssues("acme", "widgets")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if issues == nil {
		t.Fatal("issues = nil, want non-nil empty slice")
	}
	if len(issues) != 0 {
		t.Fatalf("len(issues) = %d, want 0", len(issues))
	}
}

func TestGetLatestWorkflowRun(t *testing.T) {
	client := withTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"workflow_runs": []map[string]any{
				{"status": "completed", "conclusion": "success"},
			},
		})
	})

	run, err := client.GetLatestWorkflowRun("acme", "widgets")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if run == nil || run.Status != "completed" || run.Conclusion != "success" {
		t.Fatalf("run = %+v", run)
	}
}

func TestListRecentCommits(t *testing.T) {
	client := withTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/acme/widgets/commits" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if got := r.URL.Query().Get("per_page"); got != "50" {
			t.Fatalf("per_page = %q, want 50", got)
		}
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{
				"sha": "abc123def",
				"commit": map[string]any{
					"message": "Fix parser\n\nlong body",
					"author":  map[string]any{"name": "Sakitha", "date": "2026-07-24T10:00:00Z"},
				},
				"author":   map[string]any{"login": "SakithaSamarathunga33"},
				"html_url": "https://github.com/acme/widgets/commit/abc123def",
			},
		})
	})
	commits, err := client.ListRecentCommits("acme", "widgets", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := CommitDetail{SHA: "abc123def", Message: "Fix parser", AuthorName: "Sakitha", AuthorLogin: "SakithaSamarathunga33", Date: "2026-07-24T10:00:00Z", URL: "https://github.com/acme/widgets/commit/abc123def"}
	if len(commits) != 1 || commits[0] != want {
		t.Fatalf("commits = %+v, want [%+v]", commits, want)
	}
}

func TestListRecentCommitsEmptyRepo(t *testing.T) {
	client := withTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
	})
	commits, err := client.ListRecentCommits("acme", "empty", 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(commits) != 0 {
		t.Fatalf("commits = %+v, want empty", commits)
	}
}

func TestGetTree(t *testing.T) {
	client := withTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/acme/widgets/git/trees/HEAD" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if got := r.URL.Query().Get("recursive"); got != "1" {
			t.Fatalf("recursive = %q, want 1", got)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"tree": []map[string]any{
			{"path": "README.md", "type": "blob", "size": 120},
			{"path": "src", "type": "tree"},
		}})
	})
	entries, err := client.GetTree("acme", "widgets", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(entries) != 2 || entries[0].Path != "README.md" || entries[0].Type != "blob" || entries[0].Size != 120 || entries[1].Type != "tree" {
		t.Fatalf("entries = %+v", entries)
	}
}

func TestGetFileDecodesText(t *testing.T) {
	client := withTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/acme/widgets/contents/docs/guide.md" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"path": "docs/guide.md", "sha": "blob1", "size": 12,
			"content": base64.StdEncoding.EncodeToString([]byte("# Hello world")), "encoding": "base64",
		})
	})
	f, err := client.GetFile("acme", "widgets", "docs/guide.md", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if f.Content != "# Hello world" || f.SHA != "blob1" || f.Encoding != "text" {
		t.Fatalf("file = %+v", f)
	}
}

func TestGetFileMarksBinary(t *testing.T) {
	client := withTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"path": "logo.png", "sha": "blob2", "size": 4,
			"content": base64.StdEncoding.EncodeToString([]byte{0x89, 0x50, 0x00, 0x47}), "encoding": "base64",
		})
	})
	f, err := client.GetFile("acme", "widgets", "logo.png", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if f.Encoding != "binary" || f.Content != "" {
		t.Fatalf("file = %+v, want binary with empty content", f)
	}
}

func TestGetFileMarksTooLarge(t *testing.T) {
	client := withTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"path": "big.bin", "sha": "blob3", "size": 5 << 20, "content": "", "encoding": "none",
		})
	})
	f, err := client.GetFile("acme", "widgets", "big.bin", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if f.Encoding != "too_large" {
		t.Fatalf("encoding = %q, want too_large", f.Encoding)
	}
}

func TestUpdateFileSuccess(t *testing.T) {
	client := withTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/repos/acme/widgets/contents/README.md" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var body struct {
			Message string `json:"message"`
			Content string `json:"content"`
			SHA     string `json:"sha"`
			Branch  string `json:"branch"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.SHA != "oldsha" || body.Branch != "main" || body.Message != "Update README.md via Corevia" {
			t.Fatalf("body = %+v", body)
		}
		decoded, _ := base64.StdEncoding.DecodeString(body.Content)
		if string(decoded) != "# New" {
			t.Fatalf("content = %q", decoded)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"content": map[string]any{"sha": "newsha"},
			"commit":  map[string]any{"html_url": "https://github.com/acme/widgets/commit/ffff"},
		})
	})
	res, err := client.UpdateFile("acme", "widgets", "README.md", "main", "Update README.md via Corevia", "# New", "oldsha")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.SHA != "newsha" || res.CommitURL != "https://github.com/acme/widgets/commit/ffff" {
		t.Fatalf("res = %+v", res)
	}
}

func TestUpdateFileStaleShaIsConflict(t *testing.T) {
	client := withTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"message":"is at x but expected y"}`))
	})
	_, err := client.UpdateFile("acme", "widgets", "README.md", "main", "msg", "content", "stale")
	var apiErr *APIStatusError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != http.StatusConflict {
		t.Fatalf("err = %v, want APIStatusError 409", err)
	}
}
