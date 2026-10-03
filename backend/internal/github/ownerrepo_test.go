package github

import "testing"

func TestValidOwnerRepoRejectsPathTricks(t *testing.T) {
	for _, bad := range [][2]string{
		{"a/b", "r"}, {"a", "r?x=1"}, {"a#", "r"}, {"%2e%2e", "r"}, {"..", "r"}, {"a", "."}, {"", "r"}, {"a", ""}, {"a b", "r"},
	} {
		if ValidOwnerRepo(bad[0], bad[1]) {
			t.Errorf("%q/%q should be invalid", bad[0], bad[1])
		}
		if got := repoPath(bad[0], bad[1]); got != "/repos/_invalid_/_invalid_" {
			t.Errorf("repoPath(%q,%q) = %q, want the dead-end path", bad[0], bad[1], got)
		}
	}
	if !ValidOwnerRepo("Graphify-Labs", "graphify.js_2") {
		t.Error("normal names must be valid")
	}
	if got := repoPath("o", "r"); got != "/repos/o/r" {
		t.Errorf("repoPath = %q", got)
	}
}

func TestParseOwnerRepoRejectsInvalid(t *testing.T) {
	if _, _, ok := ParseOwnerRepo("https://github.com/a/b%2Fc"); ok {
		t.Error("percent-encoded repo must be rejected")
	}
	if o, r, ok := ParseOwnerRepo("https://github.com/acme/app.git"); !ok || o != "acme" || r != "app" {
		t.Errorf("got %q %q %v", o, r, ok)
	}
}

func TestParseOwnerRepoRequiresExactGitHubHost(t *testing.T) {
	good := map[string][2]string{
		"https://github.com/acme/app":            {"acme", "app"},
		"https://github.com/acme/app.git":        {"acme", "app"},
		"https://github.com/acme/app/":           {"acme", "app"},
		"http://github.com/acme/app":             {"acme", "app"},
		"https://www.github.com/acme/app":        {"acme", "app"},
		"https://GitHub.com/acme/app":            {"acme", "app"},
		"git@github.com:acme/app.git":            {"acme", "app"},
		"ssh://git@github.com/acme/app.git":      {"acme", "app"},
		"github.com/acme/app":                    {"acme", "app"},
		"https://github.com/acme/app/tree/main":  {"acme", "app"},
		"  https://github.com/Graphify-Labs/x  ": {"Graphify-Labs", "x"},
	}
	for in, want := range good {
		if o, r, ok := ParseOwnerRepo(in); !ok || o != want[0] || r != want[1] {
			t.Errorf("ParseOwnerRepo(%q) = %q %q %v, want %v", in, o, r, ok, want)
		}
	}
	for _, bad := range []string{
		"https://github.com.evil.org/acme/app",
		"https://evil.example/github.com/acme/app",
		"https://evil.example/x?u=github.com/acme/app",
		"https://notgithub.com/acme/app",
		"https://github.com@evil.org/acme/app",
		"https://user:pw@github.com/acme/app",
		"git@github.com.evil.org:acme/app.git",
		"git@evil.org:github.com/acme/app",
		"evil.org/github.com/acme/app",
		"ftp://github.com/acme/app",
		"file:///github.com/acme/app",
		"https://github.com/acme",
		"https://github.com/acme/app?x=1",
		"https://github.com/acme/app#frag",
		"acme/app",
		"",
	} {
		if o, r, ok := ParseOwnerRepo(bad); ok {
			t.Errorf("ParseOwnerRepo(%q) = %q %q, must be rejected", bad, o, r)
		}
	}
}
