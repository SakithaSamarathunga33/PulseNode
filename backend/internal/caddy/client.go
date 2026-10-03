// Package caddy wraps Caddy's Admin API (localhost:2019).
// The Admin API is never publicly exposed — it is bound to 127.0.0.1 only.
package caddy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client talks to the Caddy Admin API.
type Client struct {
	base string
	http *http.Client
}

// New returns a Client pointing at the Caddy Admin API.
// addr should be "localhost:2019" (default) or overridden via env.
func New(addr string) *Client {
	if addr == "" {
		addr = "localhost:2019"
	}
	return &Client{
		base: "http://" + addr,
		http: &http.Client{Timeout: 10 * time.Second},
	}
}

// ── Config ────────────────────────────────────────────────────────────────────

// Config returns the full running Caddy configuration as a raw JSON map.
func (c *Client) Config(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	if err := c.get(ctx, "/config/", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Route is a minimal Caddy HTTP route definition.
type Route struct {
	ID       string    `json:"@id,omitempty"`
	Match    []Match   `json:"match"`
	Handle   []Handler `json:"handle"`
	Terminal bool      `json:"terminal"`
}

type Match struct {
	Host []string `json:"host,omitempty"`
	Path []string `json:"path,omitempty"`
}

type Handler struct {
	Handler   string     `json:"handler"`
	Upstreams []Upstream `json:"upstreams,omitempty"`
	Root      string     `json:"root,omitempty"`
}

type Upstream struct {
	Dial string `json:"dial"`
}

// ListRoutes returns all routes in the first HTTP server's router.
func (c *Client) ListRoutes(ctx context.Context) ([]Route, error) {
	var routes []Route
	if err := c.get(ctx, "/config/apps/http/servers/srv0/routes", &routes); err != nil {
		return nil, err
	}
	return routes, nil
}

// AddRoute appends a reverse-proxy route for the given domain pointing at upstream.
// upstream should be "host:port" (e.g. "localhost:3000").
func (c *Client) AddRoute(ctx context.Context, id, domain, upstream string) error {
	route := Route{
		ID:       id,
		Match:    []Match{{Host: []string{domain}}},
		Handle:   []Handler{{Handler: "reverse_proxy", Upstreams: []Upstream{{Dial: upstream}}}},
		Terminal: true,
	}
	return c.post(ctx, "/config/apps/http/servers/srv0/routes/...", route)
}

// RemoveRoute deletes the route with the given @id.
func (c *Client) RemoveRoute(ctx context.Context, id string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete,
		c.base+"/id/"+id, nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("caddy %s: %s", resp.Status, b)
	}
	return nil
}

// UpsertRoute adds a route if it doesn't exist, replaces it if it does.
func (c *Client) UpsertRoute(ctx context.Context, id, domain, upstream string) error {
	// Try to remove first (idempotent)
	_ = c.RemoveRoute(ctx, id)
	return c.AddRoute(ctx, id, domain, upstream)
}

// ── TLS ───────────────────────────────────────────────────────────────────────

// EnableTLS ensures the HTTPS listener and Let's Encrypt are configured.
// This is a no-op if Caddy is already configured via Caddyfile — use only
// when managing Caddy config entirely via the Admin API.
func (c *Client) EnableTLS(ctx context.Context, email string) error {
	payload := map[string]any{
		"email": email,
	}
	return c.patch(ctx, "/config/apps/tls/automation/policies/0/issuers/0", payload)
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

func (c *Client) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("caddy GET %s: %s %s", path, resp.Status, b)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (c *Client) post(ctx context.Context, path string, body any) error {
	return c.send(ctx, http.MethodPost, path, body)
}

func (c *Client) patch(ctx context.Context, path string, body any) error {
	return c.send(ctx, http.MethodPatch, path, body)
}

func (c *Client) send(ctx context.Context, method, path string, body any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		rb, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("caddy %s %s: %s %s", method, path, resp.Status, rb)
	}
	return nil
}
