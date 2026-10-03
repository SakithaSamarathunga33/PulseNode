package alerts

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"syscall"
	"time"
)

// Outbound notification traffic is user-configured (webhook URLs, SMTP hosts), so
// it must not become an SSRF primitive against the panel, other containers, or
// the cloud metadata service. The block is enforced at dial time on the address
// actually being connected to, which also defeats DNS rebinding.
//
// Set PULSENODE_ALERTS_ALLOW_PRIVATE=true to deliberately allow private targets
// (e.g. a self-hosted ntfy/Gotify on the same network).

var blockedNets = mustCIDRs(
	"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
	"172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15",
	"224.0.0.0/4", "240.0.0.0/4",
	"::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8",
)

func mustCIDRs(cidrs ...string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			panic(err)
		}
		out = append(out, n)
	}
	return out
}

func allowPrivate() bool { return os.Getenv("PULSENODE_ALERTS_ALLOW_PRIVATE") == "true" }

// IsBlockedIP reports whether ip is loopback, private, link-local, multicast,
// unspecified or otherwise not a public unicast address.
func IsBlockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	for _, n := range blockedNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

var errBlocked = errors.New("destination is a private or reserved address (set PULSENODE_ALERTS_ALLOW_PRIVATE=true to allow)")

// guardControl runs after DNS resolution with the concrete IP about to be dialled.
func guardControl(network, address string, _ syscall.RawConn) error {
	if allowPrivate() {
		return nil
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	if IsBlockedIP(net.ParseIP(host)) {
		return errBlocked
	}
	return nil
}

func safeDialer() *net.Dialer {
	return &net.Dialer{Timeout: 10 * time.Second, Control: guardControl}
}

// NewHTTPClient returns a client that never uses proxies, never follows
// redirects, enforces the dial-time address guard and has a hard timeout.
func NewHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 15 * time.Second,
		Transport: &http.Transport{
			Proxy:               nil,
			DialContext:         safeDialer().DialContext,
			TLSHandshakeTimeout: 10 * time.Second,
			DisableKeepAlives:   true,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// CheckURL validates a user-supplied webhook URL up front (scheme, host, and a
// literal-IP / localhost check). The dial-time guard remains the authority for
// hostnames that resolve to private addresses.
func CheckURL(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, fmt.Errorf("invalid URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("URL must start with http:// or https://")
	}
	host := u.Hostname()
	if host == "" {
		return nil, fmt.Errorf("URL has no host")
	}
	if u.User != nil {
		return nil, fmt.Errorf("URL must not contain credentials")
	}
	if allowPrivate() {
		return u, nil
	}
	lower := strings.ToLower(host)
	if lower == "localhost" || strings.HasSuffix(lower, ".localhost") || strings.HasSuffix(lower, ".internal") {
		return nil, errBlocked
	}
	if ip := net.ParseIP(host); ip != nil && IsBlockedIP(ip) {
		return nil, errBlocked
	}
	return u, nil
}
