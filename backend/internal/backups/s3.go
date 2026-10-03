package backups

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"syscall"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"pulsenode/backend/internal/alerts"
)

// S3Config describes an S3-compatible destination (AWS S3, Backblaze B2,
// Cloudflare R2, MinIO, Wasabi, …).
type S3Config struct {
	Endpoint  string // host[:port], e.g. s3.eu-central-1.amazonaws.com or minio.lan:9000
	Region    string
	Bucket    string
	Prefix    string
	AccessKey string
	SecretKey string
	UseSSL    bool
	PathStyle bool
}

// allowPrivateEndpoints lifts the SSRF guard. MinIO or another S3 server on the
// LAN / the same Docker network is a common, legitimate target.
func allowPrivateEndpoints() bool { return os.Getenv("PULSENODE_BACKUPS_ALLOW_PRIVATE") == "true" }

var errBlockedEndpoint = errors.New("endpoint is a private or reserved address (set PULSENODE_BACKUPS_ALLOW_PRIVATE=true to allow, e.g. for MinIO on your network)")

// guardControl runs after DNS resolution with the concrete address about to be
// dialled, so it also stops DNS rebinding.
func guardControl(network, address string, _ syscall.RawConn) error {
	if allowPrivateEndpoints() {
		return nil
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	if alerts.IsBlockedIP(net.ParseIP(host)) {
		return errBlockedEndpoint
	}
	return nil
}

// newTransport is a proxy-less transport with the dial-time address guard. It has
// no overall timeout (uploads can be large); contexts bound each operation.
func newTransport() *http.Transport {
	return &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: 15 * time.Second, Control: guardControl}).DialContext,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 2 * time.Minute,
		IdleConnTimeout:       30 * time.Second,
		MaxIdleConns:          4,
	}
}

// NormalizeEndpoint turns what a user typed into host[:port]. A pasted
// https://host URL is accepted; credentials and paths are not.
func NormalizeEndpoint(raw string) (host string, useSSL *bool, err error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil, errors.New("endpoint is required")
	}
	if strings.Contains(raw, "://") {
		u, perr := url.Parse(raw)
		if perr != nil || u.Host == "" {
			return "", nil, errors.New("endpoint is not a valid URL")
		}
		if u.User != nil {
			return "", nil, errors.New("endpoint must not contain credentials")
		}
		if p := strings.Trim(u.Path, "/"); p != "" {
			return "", nil, errors.New("endpoint must be a host (no path)")
		}
		ssl := u.Scheme == "https"
		if u.Scheme != "https" && u.Scheme != "http" {
			return "", nil, errors.New("endpoint scheme must be http or https")
		}
		return u.Host, &ssl, nil
	}
	if strings.ContainsAny(raw, "/@?#\\ ") {
		return "", nil, errors.New("endpoint must be host[:port] only")
	}
	return raw, nil, nil
}

// S3Store implements Store on an S3-compatible bucket.
type S3Store struct {
	client *minio.Client
	bucket string
	prefix string
}

// NewS3 builds a client. It does not contact the server.
func NewS3(c S3Config) (*S3Store, error) {
	host, ssl, err := NormalizeEndpoint(c.Endpoint)
	if err != nil {
		return nil, err
	}
	useSSL := c.UseSSL
	if ssl != nil {
		useSSL = *ssl
	}
	if c.Bucket == "" {
		return nil, errors.New("bucket is required")
	}
	if c.AccessKey == "" || c.SecretKey == "" {
		return nil, errors.New("access key and secret key are required")
	}
	// Reject literal private IPs early for a clear message; the dial guard still
	// covers hostnames that resolve to private addresses.
	if !allowPrivateEndpoints() {
		h := host
		if hh, _, err := net.SplitHostPort(host); err == nil {
			h = hh
		}
		lower := strings.ToLower(h)
		if lower == "localhost" || strings.HasSuffix(lower, ".localhost") || strings.HasSuffix(lower, ".internal") {
			return nil, errBlockedEndpoint
		}
		if ip := net.ParseIP(strings.Trim(h, "[]")); ip != nil && alerts.IsBlockedIP(ip) {
			return nil, errBlockedEndpoint
		}
	}
	region := c.Region
	if region == "" {
		region = "us-east-1" // avoids a bucket-location lookup; most S3-compatible servers ignore it
	}
	lookup := minio.BucketLookupAuto
	if c.PathStyle {
		lookup = minio.BucketLookupPath
	}
	cl, err := minio.New(host, &minio.Options{
		Creds:        credentials.NewStaticV4(c.AccessKey, c.SecretKey, ""),
		Secure:       useSSL,
		Region:       region,
		BucketLookup: lookup,
		Transport:    newTransport(),
	})
	if err != nil {
		return nil, err
	}
	prefix := strings.Trim(c.Prefix, "/")
	if prefix != "" {
		if _, err := CleanName(prefix); err != nil {
			return nil, errors.New("prefix must not contain '..'")
		}
	}
	return &S3Store{client: cl, bucket: c.Bucket, prefix: prefix}, nil
}

func (s *S3Store) key(name string) (string, error) {
	c, err := CleanName(name)
	if err != nil {
		return "", err
	}
	if s.prefix == "" {
		return c, nil
	}
	return path.Join(s.prefix, c), nil
}

func (s *S3Store) Put(ctx context.Context, name string, r io.Reader, size int64) error {
	k, err := s.key(name)
	if err != nil {
		return err
	}
	_, err = s.client.PutObject(ctx, s.bucket, k, r, size, minio.PutObjectOptions{ContentType: "application/octet-stream"})
	return cleanS3Err(err)
}

func (s *S3Store) Open(ctx context.Context, name string) (io.ReadCloser, error) {
	k, err := s.key(name)
	if err != nil {
		return nil, err
	}
	obj, err := s.client.GetObject(ctx, s.bucket, k, minio.GetObjectOptions{})
	if err != nil {
		return nil, cleanS3Err(err)
	}
	// GetObject is lazy: surface "not found" / auth errors now.
	if _, err := obj.Stat(); err != nil {
		obj.Close()
		return nil, cleanS3Err(err)
	}
	return obj, nil
}

func (s *S3Store) Delete(ctx context.Context, name string) error {
	k, err := s.key(name)
	if err != nil {
		return err
	}
	return cleanS3Err(s.client.RemoveObject(ctx, s.bucket, k, minio.RemoveObjectOptions{}))
}

func (s *S3Store) Test(ctx context.Context) error { return testRoundTrip(ctx, s) }

// cleanS3Err turns minio's errors into short messages without echoing request
// details (which can include the endpoint and bucket, but never credentials).
func cleanS3Err(err error) error {
	if err == nil {
		return nil
	}
	var re minio.ErrorResponse
	if errors.As(err, &re) && re.Code != "" {
		msg := re.Code
		if re.Message != "" {
			msg += ": " + re.Message
		}
		return errors.New(msg)
	}
	return fmt.Errorf("%v", err)
}
