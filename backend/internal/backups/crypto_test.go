package backups

import (
	"bytes"
	"crypto/rand"
	"errors"
	"io"
	"testing"
)

func randBytes(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b
}

func encryptKey(t *testing.T, key, plain []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	w, err := EncryptWithKey(&buf, key)
	if err != nil {
		t.Fatal(err)
	}
	// Write in odd-sized pieces to exercise the chunk buffering.
	for off := 0; off < len(plain); {
		n := 7919
		if off+n > len(plain) {
			n = len(plain) - off
		}
		if _, err := w.Write(plain[off : off+n]); err != nil {
			t.Fatal(err)
		}
		off += n
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestEncryptRoundtripSizes(t *testing.T) {
	key := randBytes(32)
	for _, n := range []int{0, 1, 100, defaultChunkSize - 1, defaultChunkSize, defaultChunkSize + 1, 3*defaultChunkSize + 17} {
		plain := randBytes(n)
		enc := encryptKey(t, key, plain)
		r, err := NewDecryptReader(bytes.NewReader(enc), key, "")
		if err != nil {
			t.Fatalf("size %d: %v", n, err)
		}
		got, err := io.ReadAll(r)
		if err != nil {
			t.Fatalf("size %d: %v", n, err)
		}
		if !bytes.Equal(got, plain) {
			t.Fatalf("size %d: plaintext differs", n)
		}
	}
}

func TestEncryptWrongKeyTamperTruncateReorder(t *testing.T) {
	key := randBytes(32)
	plain := randBytes(3*defaultChunkSize + 5)
	enc := encryptKey(t, key, plain)

	read := func(b, k []byte) error {
		r, err := NewDecryptReader(bytes.NewReader(b), k, "")
		if err != nil {
			return err
		}
		_, err = io.ReadAll(r)
		return err
	}

	if err := read(enc, randBytes(32)); !errors.Is(err, ErrBadPassphrase) {
		t.Fatalf("wrong key: %v", err)
	}

	tampered := append([]byte{}, enc...)
	tampered[len(tampered)/2] ^= 0x01
	if err := read(tampered, key); err == nil {
		t.Fatal("tampered ciphertext was accepted")
	}

	// Cutting the stream after a whole chunk must be noticed (final flag never arrives).
	hdr := len(magic) + 1 + 12
	chunk := 4 + defaultChunkSize + 16
	if err := read(enc[:hdr+chunk], key); !errors.Is(err, ErrTruncated) {
		t.Fatalf("truncation: %v", err)
	}
	if err := read(enc[:len(enc)-3], key); err == nil {
		t.Fatal("short final chunk accepted")
	}

	// Trailing garbage after the final chunk is rejected.
	if err := read(append(append([]byte{}, enc...), 0x42), key); err == nil {
		t.Fatal("trailing data accepted")
	}

	// Swapping two chunks breaks their nonces.
	swapped := append([]byte{}, enc...)
	a, b := hdr, hdr+chunk
	copy(swapped[a:a+chunk], enc[b:b+chunk])
	copy(swapped[b:b+chunk], enc[a:a+chunk])
	if err := read(swapped, key); err == nil {
		t.Fatal("reordered chunks accepted")
	}

	if err := read([]byte("not an encrypted backup at all"), key); !errors.Is(err, ErrNotEncrypted) {
		t.Fatalf("plain data: %v", err)
	}
}

func TestPassphraseMode(t *testing.T) {
	var buf bytes.Buffer
	w, err := EncryptWithPassphrase(&buf, "correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	plain := randBytes(200_000)
	_, _ = w.Write(plain)
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	r, err := NewDecryptReader(bytes.NewReader(buf.Bytes()), nil, "correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(r)
	if err != nil || !bytes.Equal(got, plain) {
		t.Fatalf("roundtrip: %v", err)
	}
	r, err = NewDecryptReader(bytes.NewReader(buf.Bytes()), nil, "wrong passphrase!")
	if err == nil {
		_, err = io.ReadAll(r)
	}
	if !errors.Is(err, ErrBadPassphrase) {
		t.Fatalf("wrong passphrase: %v", err)
	}
	if _, err := NewDecryptReader(bytes.NewReader(buf.Bytes()), nil, ""); err == nil {
		t.Fatal("missing passphrase accepted")
	}
}

func TestProductionKDFCost(t *testing.T) {
	// The shipped default must stay at scrypt N=2^15; tests lower it via kdfLogN.
	old := kdfLogN
	kdfLogN = 15
	defer func() { kdfLogN = old }()
	var buf bytes.Buffer
	w, err := EncryptWithPassphrase(&buf, "production cost check")
	if err != nil {
		t.Fatal(err)
	}
	_ = w.Close()
	// header: magic(6) mode(1) salt(16) logN(1)
	if got := buf.Bytes()[len(magic)+1+16]; got != 15 {
		t.Fatalf("header logN = %d, want 15", got)
	}
}
