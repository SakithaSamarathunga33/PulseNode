package db

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMain(m *testing.M) {
	// Encrypt refuses to run without a key; give the package's tests one.
	os.Setenv("AES_KEY", "0123456789abcdef0123456789abcdef")
	os.Exit(m.Run())
}

func TestLoadOrCreateSecretPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "secret")
	first, err := LoadOrCreateSecret(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 64 {
		t.Fatalf("want 64 hex chars, got %d", len(first))
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("want 0600, got %o", perm)
	}
	second, err := LoadOrCreateSecret(path)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatal("secret changed between calls")
	}
}

func TestWeakSecret(t *testing.T) {
	for _, s := range []string{"", "short", "change-me", "change-me-generate-with-openssl-rand-hex-32", "pulsenode-dev-secret"} {
		if !WeakSecret(s) {
			t.Errorf("WeakSecret(%q) = false, want true", s)
		}
	}
	if WeakSecret("0123456789abcdef0123456789abcdef") {
		t.Error("strong secret reported weak")
	}
}

func TestEncryptWithoutKeyFails(t *testing.T) {
	t.Setenv("AES_KEY", "")
	t.Setenv("MASTER_ENCRYPTION_KEY", "")
	if _, err := Encrypt("secret"); err == nil {
		t.Fatal("Encrypt without a key must fail, not store plaintext")
	}
}

func TestEnsureEncryptionKeyGeneratesWhenMissing(t *testing.T) {
	t.Setenv("AES_KEY", "")
	t.Setenv("MASTER_ENCRYPTION_KEY", "")
	dir := t.TempDir()
	generated, err := EnsureEncryptionKey(dir)
	if err != nil || !generated {
		t.Fatalf("generated=%v err=%v", generated, err)
	}
	enc, err := Encrypt("hello")
	if err != nil {
		t.Fatal(err)
	}
	if dec, _ := Decrypt(enc); dec != "hello" {
		t.Fatalf("round trip got %q", dec)
	}
	// Legacy plaintext rows (written when no key existed) still read back as-is.
	if dec, _ := Decrypt("KEY=value"); dec != "KEY=value" {
		t.Fatalf("legacy plaintext got %q", dec)
	}
}
