package backups

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

// The offline disaster-recovery commands. They need no running panel (and no
// database): `pulsenode restore-panel` and `pulsenode verify-backup` work from the
// backup file and the passphrase alone, e.g. on a brand-new server.

func readPassphrase(path string) (string, error) {
	if path == "" {
		return "", errors.New("--passphrase-file is required (use - to read it from standard input)")
	}
	var raw []byte
	var err error
	if path == "-" {
		raw, err = io.ReadAll(bufio.NewReader(os.Stdin))
	} else {
		raw, err = os.ReadFile(path)
	}
	if err != nil {
		return "", err
	}
	// Only the trailing newline an editor or `echo` adds is stripped.
	p := strings.TrimRight(string(raw), "\r\n")
	if p == "" {
		return "", errors.New("the passphrase file is empty")
	}
	return p, nil
}

func describe(out io.Writer, m *Manifest) {
	fmt.Fprintf(out, "Backup created %s by PulseNode %s\n", m.CreatedAt.Format("2006-01-02 15:04:05 MST"), orDash(m.PanelVersion))
	for _, f := range m.Files {
		fmt.Fprintf(out, "  %-14s %10d bytes  sha256 %s\n", f.Name, f.Size, f.SHA256[:12]+"…")
	}
	for _, n := range m.Notes {
		fmt.Fprintf(out, "  note: %s\n", n)
	}
}

func orDash(s string) string {
	if s == "" {
		return "unknown version"
	}
	return s
}

// RunRestoreCLI implements `pulsenode restore-panel`. It returns the exit code.
func RunRestoreCLI(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("restore-panel", flag.ContinueOnError)
	fs.SetOutput(stderr)
	file := fs.String("file", "", "encrypted panel backup (.pnbak)")
	passFile := fs.String("passphrase-file", "", "file holding the backup passphrase (- for stdin)")
	out := fs.String("out", "", "directory to write the restored files into")
	force := fs.Bool("force", false, "overwrite files that already exist in --out")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *file == "" || *out == "" {
		fmt.Fprintln(stderr, "usage: pulsenode restore-panel --file BACKUP.pnbak --passphrase-file FILE --out DIR [--force]")
		return 2
	}
	pass, err := readPassphrase(*passFile)
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}
	f, err := os.Open(*file)
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 1
	}
	defer f.Close()
	m, err := RestoreArchive(f, pass, *out, *force)
	if err != nil {
		fmt.Fprintln(stderr, "restore failed:", err)
		return 1
	}
	fmt.Fprintf(stdout, "Verified and restored %d files into %s\n", len(m.Files), *out)
	describe(stdout, m)
	fmt.Fprintln(stdout, "Next: see docs/backups.md — put aes-key/jwt-secret/.env.local and pulsenode.db where the panel expects them, then start the stack.")
	return 0
}

// RunVerifyCLI implements `pulsenode verify-backup`: decrypt and check every hash
// without writing anything.
func RunVerifyCLI(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("verify-backup", flag.ContinueOnError)
	fs.SetOutput(stderr)
	file := fs.String("file", "", "encrypted panel backup (.pnbak)")
	passFile := fs.String("passphrase-file", "", "file holding the backup passphrase (- for stdin)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *file == "" {
		fmt.Fprintln(stderr, "usage: pulsenode verify-backup --file BACKUP.pnbak --passphrase-file FILE")
		return 2
	}
	pass, err := readPassphrase(*passFile)
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}
	f, err := os.Open(*file)
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 1
	}
	defer f.Close()
	m, err := VerifyArchive(f, pass)
	if err != nil {
		fmt.Fprintln(stderr, "backup is NOT valid:", err)
		return 1
	}
	fmt.Fprintln(stdout, "Backup is valid: every file matches its checksum.")
	describe(stdout, m)
	return 0
}
