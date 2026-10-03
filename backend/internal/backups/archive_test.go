package backups

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const testPass = "a long test passphrase"

func buildArchive(t *testing.T, pass string, items []Item) []byte {
	t.Helper()
	var buf bytes.Buffer
	if _, err := WriteArchive(&buf, pass, items, "v1.2.3", []string{"a note"}, time.Now()); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func sampleItems(t *testing.T) []Item {
	t.Helper()
	dbf := filepath.Join(t.TempDir(), "x.db")
	if err := os.WriteFile(dbf, bytes.Repeat([]byte("sqlite"), 50_000), 0o600); err != nil {
		t.Fatal(err)
	}
	return []Item{
		{Name: FileDB, Path: dbf},
		{Name: FileAESKey, Data: []byte("0123456789abcdef0123456789abcdef\n")},
		{Name: FileJWT, Data: []byte("jwt\n")},
	}
}

func TestArchiveRoundtripAndVerify(t *testing.T) {
	items := sampleItems(t)
	arc := buildArchive(t, testPass, items)

	m, err := VerifyArchive(bytes.NewReader(arc), testPass)
	if err != nil || len(m.Files) != 3 || m.PanelVersion != "v1.2.3" {
		t.Fatalf("verify: %v %+v", err, m)
	}
	out := filepath.Join(t.TempDir(), "out")
	if _, err := RestoreArchive(bytes.NewReader(arc), testPass, out, false); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(out, FileAESKey))
	if err != nil || string(got) != "0123456789abcdef0123456789abcdef\n" {
		t.Fatalf("aes-key: %q %v", got, err)
	}
	st, _ := os.Stat(filepath.Join(out, FileDB))
	if st.Size() != 300_000 || st.Mode().Perm() != 0o600 {
		t.Fatalf("db file: size %d mode %v", st.Size(), st.Mode())
	}
	if ents, _ := os.ReadDir(out); len(ents) != 3 {
		t.Fatalf("temp files left behind: %v", ents)
	}
}

func TestArchiveWrongPassphraseAndTamper(t *testing.T) {
	arc := buildArchive(t, testPass, sampleItems(t))
	if _, err := VerifyArchive(bytes.NewReader(arc), "wrong passphrase!!"); !errors.Is(err, ErrBadPassphrase) {
		t.Fatalf("wrong passphrase: %v", err)
	}
	bad := append([]byte{}, arc...)
	bad[len(bad)/2] ^= 0xff
	if _, err := VerifyArchive(bytes.NewReader(bad), testPass); err == nil {
		t.Fatal("tampered archive verified")
	}
	if _, err := VerifyArchive(bytes.NewReader(arc[:len(arc)/2]), testPass); err == nil {
		t.Fatal("truncated archive verified")
	}
}

// craft writes an archive with arbitrary tar entries (to test what restore rejects).
func craft(t *testing.T, entries []struct {
	name string
	data []byte
	typ  byte
}) []byte {
	t.Helper()
	var buf bytes.Buffer
	enc, _ := EncryptWithPassphrase(&buf, testPass)
	gz := gzip.NewWriter(enc)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		typ := e.typ
		if typ == 0 {
			typ = tar.TypeReg
		}
		if err := tw.WriteHeader(&tar.Header{Name: e.name, Mode: 0o600, Size: int64(len(e.data)), Typeflag: typ}); err != nil {
			t.Fatal(err)
		}
		_, _ = tw.Write(e.data)
	}
	_ = tw.Close()
	_ = gz.Close()
	_ = enc.Close()
	return buf.Bytes()
}

func manifestFor(files map[string][]byte, mutate func(*Manifest)) []byte {
	m := Manifest{Version: 1, CreatedAt: time.Now(), Files: []ManifestFile{}}
	for n, d := range files {
		h := sha256.Sum256(d)
		m.Files = append(m.Files, ManifestFile{Name: n, Size: int64(len(d)), SHA256: hex.EncodeToString(h[:])})
	}
	if mutate != nil {
		mutate(&m)
	}
	raw, _ := json.Marshal(m)
	return raw
}

func TestArchiveManifestMismatchAndBadEntries(t *testing.T) {
	type ent = struct {
		name string
		data []byte
		typ  byte
	}
	files := map[string][]byte{FileAESKey: []byte("secret-key-value-0123456789abcdef")}

	good := craft(t, []ent{{FileAESKey, files[FileAESKey], 0}, {FileManifest, manifestFor(files, nil), 0}})
	if _, err := VerifyArchive(bytes.NewReader(good), testPass); err != nil {
		t.Fatalf("control archive should verify: %v", err)
	}

	cases := map[string][]ent{
		"hash mismatch":  {{FileAESKey, files[FileAESKey], 0}, {FileManifest, manifestFor(files, func(m *Manifest) { m.Files[0].SHA256 = "00" + m.Files[0].SHA256[2:] }), 0}},
		"size mismatch":  {{FileAESKey, files[FileAESKey], 0}, {FileManifest, manifestFor(files, func(m *Manifest) { m.Files[0].Size++ }), 0}},
		"no manifest":    {{FileAESKey, files[FileAESKey], 0}},
		"unlisted file":  {{FileAESKey, files[FileAESKey], 0}, {FileJWT, []byte("x"), 0}, {FileManifest, manifestFor(files, nil), 0}},
		"listed missing": {{FileManifest, manifestFor(files, nil), 0}},
		"path traversal": {{"../evil", []byte("x"), 0}, {FileManifest, manifestFor(map[string][]byte{"../evil": []byte("x")}, nil), 0}},
		"unknown name":   {{"authorized_keys", []byte("x"), 0}, {FileManifest, manifestFor(map[string][]byte{"authorized_keys": []byte("x")}, nil), 0}},
		"symlink entry":  {{FileAESKey, nil, tar.TypeSymlink}, {FileManifest, manifestFor(files, nil), 0}},
		"after manifest": {{FileManifest, manifestFor(files, nil), 0}, {FileAESKey, files[FileAESKey], 0}},
		"duplicate":      {{FileAESKey, files[FileAESKey], 0}, {FileAESKey, files[FileAESKey], 0}, {FileManifest, manifestFor(files, nil), 0}},
	}
	for name, entries := range cases {
		out := filepath.Join(t.TempDir(), "out")
		if _, err := RestoreArchive(bytes.NewReader(craft(t, entries)), testPass, out, false); err == nil {
			t.Errorf("%s: accepted", name)
		}
		// A rejected archive must leave nothing behind.
		if ents, _ := os.ReadDir(out); len(ents) != 0 {
			t.Errorf("%s: left files behind: %v", name, ents)
		}
	}
}

func TestRestoreRefusesToOverwrite(t *testing.T) {
	arc := buildArchive(t, testPass, sampleItems(t))
	out := t.TempDir()
	keep := filepath.Join(out, FileAESKey)
	if err := os.WriteFile(keep, []byte("do not touch"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := RestoreArchive(bytes.NewReader(arc), testPass, out, false)
	if !errors.Is(err, ErrExists) {
		t.Fatalf("want ErrExists, got %v", err)
	}
	if b, _ := os.ReadFile(keep); string(b) != "do not touch" {
		t.Fatal("existing file was modified")
	}
	if _, err := os.Stat(filepath.Join(out, FileDB)); err == nil {
		t.Fatal("restore wrote some files before refusing")
	}
	if _, err := RestoreArchive(bytes.NewReader(arc), testPass, out, true); err != nil {
		t.Fatalf("--force: %v", err)
	}
	if b, _ := os.ReadFile(keep); string(b) == "do not touch" {
		t.Fatal("--force did not overwrite")
	}
}

func TestCLI(t *testing.T) {
	dir := t.TempDir()
	arc := filepath.Join(dir, "b.pnbak")
	if err := os.WriteFile(arc, buildArchive(t, testPass, sampleItems(t)), 0o600); err != nil {
		t.Fatal(err)
	}
	pf := filepath.Join(dir, "pass")
	if err := os.WriteFile(pf, []byte(testPass+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errb bytes.Buffer
	if code := RunVerifyCLI([]string{"--file", arc, "--passphrase-file", pf}, &out, &errb); code != 0 {
		t.Fatalf("verify exit %d: %s", code, errb.String())
	}
	dest := filepath.Join(dir, "restore")
	if code := RunRestoreCLI([]string{"--file", arc, "--passphrase-file", pf, "--out", dest}, &out, &errb); code != 0 {
		t.Fatalf("restore exit %d: %s", code, errb.String())
	}
	errb.Reset()
	if code := RunRestoreCLI([]string{"--file", arc, "--passphrase-file", pf, "--out", dest}, &out, &errb); code == 0 {
		t.Fatal("second restore into the same dir must refuse without --force")
	}
	if code := RunRestoreCLI([]string{"--file", arc, "--passphrase-file", pf, "--out", dest, "--force"}, &out, &errb); code != 0 {
		t.Fatalf("forced restore exit %d: %s", code, errb.String())
	}
	_ = os.WriteFile(pf, []byte("not the passphrase\n"), 0o600)
	if code := RunVerifyCLI([]string{"--file", arc, "--passphrase-file", pf}, &out, &errb); code == 0 {
		t.Fatal("wrong passphrase verified")
	}
}
