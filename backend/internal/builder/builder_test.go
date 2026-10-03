package builder

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDetectMonorepo(t *testing.T) {
	write := func(dir, name string) {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("frontend+backend → monorepo", func(t *testing.T) {
		root := t.TempDir()
		write(filepath.Join(root, "frontend"), "package.json")
		write(filepath.Join(root, "backend"), "go.mod")
		fe, be, ok := DetectMonorepo(root)
		if !ok || fe != filepath.Join(root, "frontend") || be != filepath.Join(root, "backend") {
			t.Fatalf("got fe=%q be=%q ok=%v", fe, be, ok)
		}
	})

	t.Run("backend missing build marker → not monorepo", func(t *testing.T) {
		root := t.TempDir()
		write(filepath.Join(root, "frontend"), "package.json")
		if err := os.MkdirAll(filepath.Join(root, "backend"), 0o755); err != nil {
			t.Fatal(err) // dir exists but no buildable marker
		}
		if _, _, ok := DetectMonorepo(root); ok {
			t.Fatal("expected not a monorepo when backend/ has no build marker")
		}
	})

	t.Run("only frontend → not monorepo", func(t *testing.T) {
		root := t.TempDir()
		write(filepath.Join(root, "frontend"), "Dockerfile")
		if _, _, ok := DetectMonorepo(root); ok {
			t.Fatal("expected not a monorepo with only frontend/")
		}
	})
}

func TestShortID(t *testing.T) {
	cases := []struct{ in, want string }{
		{"dep_0123456789abcdef", "89abcdef"}, // trailing 8 of the hex part
		{"dep_abc", "abc"},                   // shorter than 8 → as-is
		{"plain12345", "ain12345"},           // no prefix, len 10 → trailing 8
		{"", ""},
	}
	for _, c := range cases {
		if got := shortID(c.in); got != c.want {
			t.Errorf("shortID(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestSanitizeName(t *testing.T) {
	cases := map[string]string{
		"My App":        "my-app",
		"weird@@name!!": "weird--name",
		"---":           "app",
		"Good-Name123":  "good-name123",
	}
	for in, want := range cases {
		if got := sanitizeName(in); got != want {
			t.Errorf("sanitizeName(%q) = %q, want %q", in, got, want)
		}
	}
}
