package backups

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Panel archive = tar.gz of a fixed set of files plus manifest.json (written last,
// listing the SHA-256 of every file), encrypted with a user passphrase. Restoring
// verifies every hash before a single file is written to the destination.

// Names an archive may contain. Anything else is rejected on restore, so a
// crafted archive cannot write outside the target directory or drop extra files.
const (
	FileDB       = "pulsenode.db"
	FileAESKey   = "aes-key"
	FileJWT      = "jwt-secret"
	FileEnvLocal = ".env.local"
	FileScans    = "scans.json"
	FileSBOMs    = "sboms.json"
	FileManifest = "manifest.json"
)

var allowedNames = map[string]bool{
	FileDB: true, FileAESKey: true, FileJWT: true, FileEnvLocal: true, FileScans: true, FileSBOMs: true,
}

const maxArchiveFile = 8 << 30 // per-file sanity cap while extracting

// ManifestFile is one entry of manifest.json.
type ManifestFile struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// Manifest describes an archive.
type Manifest struct {
	Version      int            `json:"version"`
	CreatedAt    time.Time      `json:"createdAt"`
	PanelVersion string         `json:"panelVersion"`
	Files        []ManifestFile `json:"files"`
	Notes        []string       `json:"notes,omitempty"`
}

// Item is one file to put into an archive: either Path (read from disk) or Data.
type Item struct {
	Name string
	Path string
	Data []byte
	Mode int64
}

// WriteArchive writes the encrypted archive to dst.
func WriteArchive(dst io.Writer, passphrase string, items []Item, panelVersion string, notes []string, now time.Time) (*Manifest, error) {
	enc, err := EncryptWithPassphrase(dst, passphrase)
	if err != nil {
		return nil, err
	}
	gz := gzip.NewWriter(enc)
	tw := tar.NewWriter(gz)
	man := &Manifest{Version: 1, CreatedAt: now.UTC(), PanelVersion: panelVersion, Files: []ManifestFile{}, Notes: notes}

	for _, it := range items {
		if !allowedNames[it.Name] {
			return nil, fmt.Errorf("file %q is not allowed in a panel archive", it.Name)
		}
		mf, err := writeItem(tw, it, now)
		if err != nil {
			return nil, fmt.Errorf("archive %s: %w", it.Name, err)
		}
		man.Files = append(man.Files, *mf)
	}
	raw, err := json.MarshalIndent(man, "", "  ")
	if err != nil {
		return nil, err
	}
	if _, err := writeItem(tw, Item{Name: FileManifest, Data: raw, Mode: 0o600}, now); err != nil {
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return man, nil
}

func writeItem(tw *tar.Writer, it Item, now time.Time) (*ManifestFile, error) {
	mode := it.Mode
	if mode == 0 {
		mode = 0o600
	}
	h := sha256.New()
	var size int64
	if it.Path != "" {
		f, err := os.Open(it.Path)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil {
			return nil, err
		}
		size = st.Size()
		if err := tw.WriteHeader(&tar.Header{Name: it.Name, Mode: mode, Size: size, ModTime: now, Typeflag: tar.TypeReg}); err != nil {
			return nil, err
		}
		n, err := io.Copy(io.MultiWriter(tw, h), io.LimitReader(f, size))
		if err != nil {
			return nil, err
		}
		if n != size {
			return nil, fmt.Errorf("file changed while it was being archived (%d of %d bytes)", n, size)
		}
	} else {
		size = int64(len(it.Data))
		if err := tw.WriteHeader(&tar.Header{Name: it.Name, Mode: mode, Size: size, ModTime: now, Typeflag: tar.TypeReg}); err != nil {
			return nil, err
		}
		if _, err := tw.Write(it.Data); err != nil {
			return nil, err
		}
		h.Write(it.Data)
	}
	return &ManifestFile{Name: it.Name, Size: size, SHA256: hex.EncodeToString(h.Sum(nil))}, nil
}

// ErrExists is wrapped by RestoreArchive when it would overwrite a file.
var ErrExists = errors.New("refusing to overwrite existing file (use --force)")

// VerifyArchive decrypts and checks every hash without writing anything.
func VerifyArchive(src io.Reader, passphrase string) (*Manifest, error) {
	return readArchive(src, passphrase, "", false, true)
}

// RestoreArchive verifies the archive, then writes its files into outDir. Existing
// files are never overwritten unless force is set; the check happens after
// verification and before anything is moved into place.
func RestoreArchive(src io.Reader, passphrase, outDir string, force bool) (*Manifest, error) {
	if outDir == "" {
		return nil, errors.New("output directory is required")
	}
	return readArchive(src, passphrase, outDir, force, false)
}

func readArchive(src io.Reader, passphrase, outDir string, force, verifyOnly bool) (*Manifest, error) {
	dec, err := NewDecryptReader(src, nil, passphrase)
	if err != nil {
		return nil, err
	}
	gz, err := gzip.NewReader(dec)
	if err != nil {
		if errors.Is(err, ErrBadPassphrase) || errors.Is(err, ErrTruncated) {
			return nil, err
		}
		return nil, fmt.Errorf("archive is damaged: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)

	var tmp string
	if !verifyOnly {
		if err := os.MkdirAll(outDir, 0o700); err != nil {
			return nil, err
		}
		if tmp, err = os.MkdirTemp(outDir, ".restore-tmp-"); err != nil {
			return nil, err
		}
		defer os.RemoveAll(tmp)
	}

	got := map[string]ManifestFile{}
	var manifest *Manifest
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, wrapReadErr(err)
		}
		if hdr.Typeflag != tar.TypeReg {
			return nil, fmt.Errorf("archive contains a non-file entry %q", hdr.Name)
		}
		if manifest != nil {
			return nil, errors.New("archive has entries after its manifest")
		}
		if hdr.Name == FileManifest {
			raw, err := io.ReadAll(io.LimitReader(tr, 1<<20))
			if err != nil {
				return nil, wrapReadErr(err)
			}
			var m Manifest
			if err := json.Unmarshal(raw, &m); err != nil {
				return nil, fmt.Errorf("manifest is unreadable: %w", err)
			}
			manifest = &m
			continue
		}
		if !allowedNames[hdr.Name] || filepath.Base(hdr.Name) != hdr.Name {
			return nil, fmt.Errorf("archive contains an unexpected file %q", hdr.Name)
		}
		if _, dup := got[hdr.Name]; dup {
			return nil, fmt.Errorf("archive contains %q twice", hdr.Name)
		}
		if hdr.Size < 0 || hdr.Size > maxArchiveFile {
			return nil, fmt.Errorf("file %q has an unreasonable size", hdr.Name)
		}
		h := sha256.New()
		var w io.Writer = h
		var out *os.File
		if !verifyOnly {
			out, err = os.OpenFile(filepath.Join(tmp, hdr.Name), os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
			if err != nil {
				return nil, err
			}
			w = io.MultiWriter(out, h)
		}
		n, err := io.Copy(w, tr)
		if out != nil {
			if cerr := out.Close(); err == nil {
				err = cerr
			}
		}
		if err != nil {
			return nil, wrapReadErr(err)
		}
		got[hdr.Name] = ManifestFile{Name: hdr.Name, Size: n, SHA256: hex.EncodeToString(h.Sum(nil))}
	}
	if manifest == nil {
		return nil, errors.New("archive has no manifest (incomplete or not a panel backup)")
	}
	if manifest.Version != 1 {
		return nil, fmt.Errorf("unsupported backup version %d", manifest.Version)
	}
	listed := map[string]bool{}
	for _, mf := range manifest.Files {
		listed[mf.Name] = true
		g, ok := got[mf.Name]
		if !ok {
			return nil, fmt.Errorf("manifest lists %s but the archive does not contain it", mf.Name)
		}
		if g.SHA256 != mf.SHA256 || g.Size != mf.Size {
			return nil, fmt.Errorf("manifest hash mismatch for %s: the file is damaged or was modified", mf.Name)
		}
	}
	for name := range got {
		if !listed[name] {
			return nil, fmt.Errorf("archive contains %s which the manifest does not list", name)
		}
	}
	if verifyOnly {
		return manifest, nil
	}

	names := make([]string, 0, len(got))
	for n := range got {
		names = append(names, n)
	}
	sort.Strings(names)
	if !force {
		var exist []string
		for _, n := range names {
			if _, err := os.Lstat(filepath.Join(outDir, n)); err == nil {
				exist = append(exist, n)
			}
		}
		if len(exist) > 0 {
			return nil, fmt.Errorf("%w: %s", ErrExists, strings.Join(exist, ", "))
		}
	}
	for _, n := range names {
		if err := os.Rename(filepath.Join(tmp, n), filepath.Join(outDir, n)); err != nil {
			return nil, fmt.Errorf("write %s: %w", n, err)
		}
	}
	return manifest, nil
}

func wrapReadErr(err error) error {
	if errors.Is(err, ErrBadPassphrase) || errors.Is(err, ErrTruncated) {
		return err
	}
	if errors.Is(err, io.ErrUnexpectedEOF) {
		return ErrTruncated
	}
	return fmt.Errorf("archive is damaged: %w", err)
}
