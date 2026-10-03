// Package backups implements scheduled backups: encrypted archives, storage
// destinations (local directory, S3-compatible), the scheduler and restore.
package backups

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"

	"golang.org/x/crypto/scrypt"
)

// Encrypted file format (all integers big endian):
//
//	"PNBAK1" | mode(1) | [salt(16) | logN(1)  — passphrase mode only] | noncePrefix(8) | chunkSize(4)
//	then chunks:  length(4, high bit = final chunk) | AES-256-GCM ciphertext(length bytes, tag included)
//
// A chunk's nonce is noncePrefix || chunkIndex(4); its additional data is the whole
// header plus one byte (1 = final). The stream is therefore authenticated chunk by
// chunk (it can be written and read with constant memory), chunks cannot be
// reordered or dropped from the middle, and a stream cut short is detected
// because the final-chunk flag never arrives.
const (
	magic            = "PNBAK1"
	ModeKey          = 1 // key supplied by the caller (panel-derived key)
	ModePassphrase   = 2 // key derived from a passphrase with scrypt
	defaultChunkSize = 64 * 1024
	finalBit         = 1 << 31
	maxChunkSize     = 1 << 20
)

// kdfLogN is scrypt's cost for new passphrase-encrypted files (N = 2^kdfLogN). It
// is a variable only so tests can lower it; the value used is written into each
// file's header, so readers never depend on it.
var kdfLogN = 15

var (
	// ErrBadPassphrase is returned when authentication of the first chunk fails: the
	// passphrase/key is wrong or the file is damaged.
	ErrBadPassphrase = errors.New("cannot decrypt: wrong passphrase or key, or the file is damaged")
	// ErrTruncated means the encrypted stream ended before its final chunk.
	ErrTruncated = errors.New("encrypted backup is truncated")
	// ErrNotEncrypted means the data does not start with the backup header.
	ErrNotEncrypted = errors.New("not a PulseNode encrypted backup")
)

func deriveKey(pass string, salt []byte, logN int) ([]byte, error) {
	return scrypt.Key([]byte(pass), salt, 1<<logN, 8, 1, 32)
}

type encWriter struct {
	dst    io.Writer
	aead   cipher.AEAD
	header []byte
	prefix []byte
	buf    []byte
	chunk  int
	index  uint32
	closed bool
	err    error
}

func newEncWriter(dst io.Writer, mode byte, key, salt []byte, logN int) (*encWriter, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	prefix := make([]byte, 8)
	if _, err := rand.Read(prefix); err != nil {
		return nil, err
	}
	var hdr bytes.Buffer
	hdr.WriteString(magic)
	hdr.WriteByte(mode)
	if mode == ModePassphrase {
		hdr.Write(salt)
		hdr.WriteByte(byte(logN))
	}
	hdr.Write(prefix)
	var cs [4]byte
	binary.BigEndian.PutUint32(cs[:], defaultChunkSize)
	hdr.Write(cs[:])
	w := &encWriter{dst: dst, aead: aead, header: hdr.Bytes(), prefix: prefix, chunk: defaultChunkSize}
	if _, err := dst.Write(w.header); err != nil {
		return nil, err
	}
	return w, nil
}

// EncryptWithKey returns a writer that encrypts into dst with a 32-byte key. Close
// it to write the final chunk; closing does not close dst.
func EncryptWithKey(dst io.Writer, key []byte) (io.WriteCloser, error) {
	if len(key) != 32 {
		return nil, errors.New("key must be 32 bytes")
	}
	return newEncWriter(dst, ModeKey, key, nil, 0)
}

// EncryptWithPassphrase is EncryptWithKey with the key derived by scrypt(N=2^15).
func EncryptWithPassphrase(dst io.Writer, passphrase string) (io.WriteCloser, error) {
	if passphrase == "" {
		return nil, errors.New("passphrase is empty")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	key, err := deriveKey(passphrase, salt, kdfLogN)
	if err != nil {
		return nil, err
	}
	return newEncWriter(dst, ModePassphrase, key, salt, kdfLogN)
}

func (w *encWriter) seal(plain []byte, final bool) error {
	nonce := make([]byte, 12)
	copy(nonce, w.prefix)
	binary.BigEndian.PutUint32(nonce[8:], w.index)
	flag := byte(0)
	if final {
		flag = 1
	}
	ad := append(append([]byte{}, w.header...), flag)
	ct := w.aead.Seal(nil, nonce, plain, ad)
	var ln [4]byte
	l := uint32(len(ct))
	if final {
		l |= finalBit
	}
	binary.BigEndian.PutUint32(ln[:], l)
	if _, err := w.dst.Write(ln[:]); err != nil {
		return err
	}
	if _, err := w.dst.Write(ct); err != nil {
		return err
	}
	w.index++
	return nil
}

func (w *encWriter) Write(p []byte) (int, error) {
	if w.closed {
		return 0, errors.New("write after close")
	}
	if w.err != nil {
		return 0, w.err
	}
	w.buf = append(w.buf, p...)
	// Only seal a chunk once MORE data than a chunk is buffered: the last chunk is
	// sealed by Close so it can carry the final flag.
	for len(w.buf) > w.chunk {
		if err := w.seal(w.buf[:w.chunk], false); err != nil {
			w.err = err
			return 0, err
		}
		w.buf = append(w.buf[:0], w.buf[w.chunk:]...)
	}
	return len(p), nil
}

func (w *encWriter) Close() error {
	if w.closed {
		return w.err
	}
	w.closed = true
	if w.err != nil {
		return w.err
	}
	w.err = w.seal(w.buf, true)
	w.buf = nil
	return w.err
}

type decReader struct {
	src      io.Reader
	aead     cipher.AEAD
	header   []byte
	prefix   []byte
	chunk    int
	index    uint32
	plain    []byte
	final    bool
	finished bool
	err      error
}

// NewDecryptReader parses the header from src and returns a reader of the
// plaintext. key is used for ModeKey streams, passphrase for ModePassphrase ones.
func NewDecryptReader(src io.Reader, key []byte, passphrase string) (io.Reader, error) {
	head := make([]byte, len(magic)+1)
	if _, err := io.ReadFull(src, head); err != nil {
		return nil, ErrNotEncrypted
	}
	if string(head[:len(magic)]) != magic {
		return nil, ErrNotEncrypted
	}
	mode := head[len(magic)]
	hdr := append([]byte{}, head...)
	var k []byte
	switch mode {
	case ModeKey:
		if len(key) != 32 {
			return nil, errors.New("this backup is encrypted with the panel key, which is not available")
		}
		k = key
	case ModePassphrase:
		rest := make([]byte, 17)
		if _, err := io.ReadFull(src, rest); err != nil {
			return nil, ErrNotEncrypted
		}
		hdr = append(hdr, rest...)
		logN := int(rest[16])
		if logN < 10 || logN > 20 {
			return nil, ErrNotEncrypted
		}
		if passphrase == "" {
			return nil, errors.New("a passphrase is required to decrypt this backup")
		}
		var err error
		if k, err = deriveKey(passphrase, rest[:16], logN); err != nil {
			return nil, err
		}
	default:
		return nil, ErrNotEncrypted
	}
	tail := make([]byte, 12)
	if _, err := io.ReadFull(src, tail); err != nil {
		return nil, ErrNotEncrypted
	}
	hdr = append(hdr, tail...)
	chunk := int(binary.BigEndian.Uint32(tail[8:]))
	if chunk <= 0 || chunk > maxChunkSize {
		return nil, ErrNotEncrypted
	}
	block, err := aes.NewCipher(k)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &decReader{src: src, aead: aead, header: hdr, prefix: tail[:8], chunk: chunk}, nil
}

func (r *decReader) next() error {
	var ln [4]byte
	if _, err := io.ReadFull(r.src, ln[:]); err != nil {
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			return ErrTruncated
		}
		return err
	}
	l := binary.BigEndian.Uint32(ln[:])
	final := l&finalBit != 0
	l &^= finalBit
	if int(l) > r.chunk+r.aead.Overhead() || int(l) < r.aead.Overhead() {
		return ErrBadPassphrase
	}
	ct := make([]byte, l)
	if _, err := io.ReadFull(r.src, ct); err != nil {
		return ErrTruncated
	}
	nonce := make([]byte, 12)
	copy(nonce, r.prefix)
	binary.BigEndian.PutUint32(nonce[8:], r.index)
	flag := byte(0)
	if final {
		flag = 1
	}
	plain, err := r.aead.Open(nil, nonce, ct, append(append([]byte{}, r.header...), flag))
	if err != nil {
		if r.index == 0 {
			return ErrBadPassphrase
		}
		return fmt.Errorf("encrypted backup is corrupted or tampered with (chunk %d)", r.index)
	}
	r.index++
	r.plain = plain
	r.final = final
	if final {
		// Nothing may follow the final chunk.
		var one [1]byte
		if n, _ := r.src.Read(one[:]); n > 0 {
			return errors.New("encrypted backup has trailing data")
		}
	}
	return nil
}

func (r *decReader) Read(p []byte) (int, error) {
	for len(r.plain) == 0 {
		if r.err != nil {
			return 0, r.err
		}
		if r.finished {
			return 0, io.EOF
		}
		if err := r.next(); err != nil {
			r.err = err
			return 0, err
		}
		if r.final {
			r.finished = true
		}
	}
	n := copy(p, r.plain)
	r.plain = r.plain[n:]
	return n, nil
}
