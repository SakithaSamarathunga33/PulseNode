package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"pulsenode/backend/internal/proxy"
)

type domainSettingsResponse struct {
	RootDomain string   `json:"rootDomain"`
	ExpectedIP string   `json:"expectedIp"`
	Aliases    []string `json:"aliases"`
}

type domainCheckResponse struct {
	Domain     string   `json:"domain"`
	ExpectedIP string   `json:"expectedIp"`
	Records    []string `json:"records"`
	Pointed    bool     `json:"pointed"`
	Proxied    bool     `json:"proxied"`
	Provider   string   `json:"provider,omitempty"`
	Message    string   `json:"message,omitempty"`
	Error      string   `json:"error,omitempty"`
	CheckedAt  string   `json:"checkedAt"`
}

// rootDomain returns the primary saved domain if set, else the env/host fallback.
func (s *Server) rootDomain() string {
	if s.db != nil {
		if primary, err := s.db.PrimaryDomain(); err == nil && primary != "" {
			return primary
		}
	}
	return currentDomainSettings().RootDomain
}

// effectiveDomainSettings is currentDomainSettings() with RootDomain/Aliases
// overridden by the DB primary (so projects/new and the DNS-records section
// reflect the saved primary domain).
func (s *Server) effectiveDomainSettings() domainSettingsResponse {
	base := currentDomainSettings()
	root := s.rootDomain()
	base.RootDomain = root
	if root != "" {
		base.Aliases = []string{"@" + root, "*." + root}
	} else {
		base.Aliases = []string{}
	}
	return base
}

func (s *Server) domainSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.effectiveDomainSettings())
}

// hostResolver is the part of net.Resolver the DNS checks use; tests swap it.
type hostResolver interface {
	LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error)
}

var dnsResolver hostResolver = net.DefaultResolver

// resolveDomain runs the DNS lookup + Cloudflare-proxy detection for host and
// returns a populated response. Records is always a non-nil slice.
func resolveDomain(ctx context.Context, host, expected string) domainCheckResponse {
	res := domainCheckResponse{
		Domain:     host,
		ExpectedIP: expected,
		Records:    []string{},
		CheckedAt:  time.Now().UTC().Format(time.RFC3339),
	}
	if expected == "" {
		res.Error = "Could not determine this VPS public IP"
		return res
	}
	records, err := dnsResolver.LookupIPAddr(ctx, host)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	for _, record := range records {
		ip := record.IP.String()
		res.Records = append(res.Records, ip)
		if ip == expected {
			res.Pointed = true
		}
	}
	if !res.Pointed && len(res.Records) > 0 && allCloudflareIPs(res.Records) {
		res.Pointed = true
		res.Proxied = true
		res.Provider = "Cloudflare"
		res.Message = "DNS is proxied through Cloudflare, so public DNS returns Cloudflare edge IPs instead of the VPS origin IP."
	}
	return res
}

func (s *Server) checkDomain(w http.ResponseWriter, r *http.Request) {
	domain := cleanDomain(r.URL.Query().Get("domain"))
	if domain == "" {
		domain = s.rootDomain()
	}
	if domain == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "domain is required"})
		return
	}
	res := resolveDomain(r.Context(), domain, expectedVPSIP())
	writeJSON(w, http.StatusOK, res)
}

func allCloudflareIPs(records []string) bool {
	if len(records) == 0 {
		return false
	}
	for _, record := range records {
		ip := net.ParseIP(record)
		if ip == nil || !isCloudflareIP(ip) {
			return false
		}
	}
	return true
}

func isCloudflareIP(ip net.IP) bool {
	for _, cidr := range cloudflareCIDRs {
		_, network, err := net.ParseCIDR(cidr)
		if err == nil && network.Contains(ip) {
			return true
		}
	}
	return false
}

var cloudflareCIDRs = []string{
	"173.245.48.0/20",
	"103.21.244.0/22",
	"103.22.200.0/22",
	"103.31.4.0/22",
	"141.101.64.0/18",
	"108.162.192.0/18",
	"190.93.240.0/20",
	"188.114.96.0/20",
	"197.234.240.0/22",
	"198.41.128.0/17",
	"162.158.0.0/15",
	"104.16.0.0/13",
	"104.24.0.0/14",
	"172.64.0.0/13",
	"131.0.72.0/22",
	"2400:cb00::/32",
	"2606:4700::/32",
	"2803:f800::/32",
	"2405:b500::/32",
	"2405:8100::/32",
	"2a06:98c0::/29",
	"2c0f:f248::/32",
}

func currentDomainSettings() domainSettingsResponse {
	root := cleanDomain(firstNonEmpty(os.Getenv("PULSENODE_ROOT_DOMAIN"), os.Getenv("TRAEFIK_ROOT_DOMAIN")))
	if root == "" {
		root = rootFromHost(os.Getenv("TRAEFIK_HOST"))
	}
	if root == "" {
		root = rootFromURL(os.Getenv("NEXT_PUBLIC_ORIGIN"))
	}
	return domainSettingsResponse{
		RootDomain: root,
		ExpectedIP: expectedVPSIP(),
		Aliases:    []string{"@" + root, "*." + root},
	}
}

func expectedVPSIP() string {
	if ip := strings.TrimSpace(os.Getenv("VPS_IP")); ip != "" {
		return ip
	}
	if ip := strings.TrimSpace(os.Getenv("PULSENODE_VPS_IP")); ip != "" {
		return ip
	}
	host := hostFromURL(os.Getenv("NEXT_PUBLIC_ORIGIN"))
	if host == "" {
		host = os.Getenv("TRAEFIK_HOST")
	}
	if parsed := net.ParseIP(host); parsed != nil {
		return parsed.String()
	}
	if ip := lookupPublicIP(); ip != "" {
		return ip
	}
	ips, err := net.LookupIP(host)
	if err != nil {
		return ""
	}
	for _, ip := range ips {
		if v4 := ip.To4(); v4 != nil {
			return v4.String()
		}
	}
	if len(ips) > 0 {
		return ips[0].String()
	}
	return ""
}

func lookupPublicIP() string {
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get("https://api.ipify.org")
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64))
	if err != nil {
		return ""
	}
	ip := strings.TrimSpace(string(data))
	if parsed := net.ParseIP(ip); parsed != nil {
		return parsed.String()
	}
	return ""
}

func rootFromURL(raw string) string {
	return rootFromHost(hostFromURL(raw))
}

func hostFromURL(raw string) string {
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return cleanDomain(raw)
	}
	return cleanDomain(u.Hostname())
}

func rootFromHost(host string) string {
	host = cleanDomain(host)
	parts := strings.Split(host, ".")
	if len(parts) < 2 {
		return host
	}
	return strings.Join(parts[len(parts)-2:], ".")
}

// hostnameRe matches a DNS hostname (letters, digits, hyphens; dot-separated).
var hostnameRe = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// validHostname reports whether d is safe to embed in a Traefik Host(`...`)
// rule or a compose label. Anything else (backticks, quotes, spaces, `||`)
// could rewrite the routing rule and hijack another app's or the panel's traffic.
func validHostname(d string) bool {
	return len(d) <= 253 && hostnameRe.MatchString(d)
}

func cleanDomain(domain string) string {
	domain = strings.TrimSpace(strings.ToLower(domain))
	domain = strings.TrimPrefix(domain, "http://")
	domain = strings.TrimPrefix(domain, "https://")
	domain = strings.TrimPrefix(domain, "*.")
	domain = strings.TrimPrefix(domain, "@.")
	domain = strings.Trim(domain, "/.")
	if h, _, err := net.SplitHostPort(domain); err == nil {
		domain = h
	}
	return domain
}

// wildcardResponse is the result of probing whether *.root points at this server.
type wildcardResponse struct {
	Domain      string              `json:"domain"`
	Root        string              `json:"root"`
	ProbeHost   string              `json:"probeHost"`
	Resolves    bool                `json:"resolves"`
	Proxied     bool                `json:"proxied"`
	IPs         []string            `json:"ips"`
	ExpectedIP  string              `json:"expectedIp"`
	Status      string              `json:"status"` // ok | proxied | missing | wrong | error
	Message     string              `json:"message"`
	DomainCheck domainCheckResponse `json:"domainCheck"` // the specific domain's own resolution
}

// probeLabel returns a random hostname label that no real record can match, so
// only a wildcard (or a catch-all) can answer for it and resolver caches don't lie.
func probeLabel() string {
	b := make([]byte, 5)
	if _, err := rand.Read(b); err != nil {
		return "pn-probe-" + strings.ReplaceAll(time.Now().Format("150405.000"), ".", "")
	}
	return "pn-probe-" + hex.EncodeToString(b)
}

// checkWildcard resolves a random label under root and classifies the answer.
// A wildcard that resolves to Cloudflare's edge ("proxied") counts as OK.
func checkWildcard(ctx context.Context, root, probeHost, expected string) wildcardResponse {
	res := wildcardResponse{Root: root, ProbeHost: probeHost, IPs: []string{}, ExpectedIP: expected}
	wild := "*." + root
	addrs, err := dnsResolver.LookupIPAddr(ctx, probeHost)
	if err != nil {
		var dnsErr *net.DNSError
		if errors.As(err, &dnsErr) && dnsErr.IsNotFound {
			res.Status = "missing"
			res.Message = "No wildcard record found for " + wild + ". Add an A record with the name * (i.e. " + wild + ") pointing to " +
				firstNonEmpty(expected, "this server's IP") + " at your DNS provider; proxying it through Cloudflare is fine."
			return res
		}
		res.Status = "error"
		res.Message = "Could not check " + wild + ": " + err.Error()
		return res
	}
	for _, a := range addrs {
		res.IPs = append(res.IPs, a.IP.String())
	}
	res.Resolves = len(res.IPs) > 0
	switch {
	case !res.Resolves:
		res.Status = "missing"
		res.Message = "No wildcard record found for " + wild + "."
	case expected != "" && containsString(res.IPs, expected):
		res.Status = "ok"
		res.Message = wild + " points at this server (" + expected + ")."
	case allCloudflareIPs(res.IPs):
		res.Status, res.Proxied = "proxied", true
		res.Message = wild + " is proxied through Cloudflare, so public DNS shows Cloudflare edge IPs instead of the server IP. That works."
	case expected == "":
		res.Status = "error"
		res.Message = wild + " resolves to " + strings.Join(res.IPs, ", ") + ", but this server's public IP could not be determined to compare."
	default:
		res.Status = "wrong"
		res.Message = wild + " resolves to " + strings.Join(res.IPs, ", ") + ", not this server (" + expected + "). Point it at " + expected + "."
	}
	return res
}

func containsString(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

// wildcardCheck handles GET /api/domains/wildcard?domain=app.example.com.
func (s *Server) wildcardCheck(w http.ResponseWriter, r *http.Request) {
	domain := cleanDomain(r.URL.Query().Get("domain"))
	if domain == "" {
		domain = s.rootDomain()
	}
	if domain == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "domain is required"})
		return
	}
	if !validHostname(domain) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "domain is not a valid hostname"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	expected := expectedVPSIP()
	root := proxy.RegistrableRoot(domain)
	res := checkWildcard(ctx, root, probeLabel()+"."+root, expected)
	res.Domain = domain
	res.DomainCheck = resolveDomain(ctx, domain, expected)
	if res.Status == "missing" && res.DomainCheck.Pointed {
		res.Message += " " + domain + " itself resolves, so this project works, but new projects on other subdomains need the wildcard."
	}
	writeJSON(w, http.StatusOK, res)
}
