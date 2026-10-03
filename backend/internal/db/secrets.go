package db

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// LoadOrCreateSecret returns the secret stored at path, generating a random
// 64-hex-char value (and writing it with 0600 perms) when the file is missing.
// Used so a stack started without .env.local never falls back to a public
// default like "change-me".
func LoadOrCreateSecret(path string) (string, error) {
	if b, err := os.ReadFile(path); err == nil {
		if s := strings.TrimSpace(string(b)); len(s) >= 32 {
			return s, nil
		}
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	secret := hex.EncodeToString(buf)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(secret+"\n"), 0o600); err != nil {
		return "", err
	}
	return secret, nil
}

// WeakSecret reports whether s is missing, too short, or a known placeholder.
func WeakSecret(s string) bool {
	return len(s) < 32 || strings.HasPrefix(s, "change-me") || s == "pulsenode-dev-secret"
}

// EnsureEncryptionKey makes sure AES_KEY is set before any Encrypt/Decrypt call.
// When neither AES_KEY nor MASTER_ENCRYPTION_KEY holds a usable key, a random one
// is generated and persisted under dataDir. Values previously stored without a
// key were written as plaintext, which Decrypt still returns unchanged, so this
// is safe for existing installs.
func EnsureEncryptionKey(dataDir string) (generated bool, err error) {
	if len(os.Getenv("AES_KEY")) >= 32 || len(os.Getenv("MASTER_ENCRYPTION_KEY")) >= 32 {
		return false, nil
	}
	key, err := LoadOrCreateSecret(filepath.Join(dataDir, "aes-key"))
	if err != nil {
		return false, fmt.Errorf("create encryption key: %w", err)
	}
	return true, os.Setenv("AES_KEY", key)
}
