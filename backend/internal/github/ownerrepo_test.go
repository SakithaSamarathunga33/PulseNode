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
