package api

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
)

var hostRuleRe = regexp.MustCompile("Host\\(`([^`]+)`\\)")

// parseTraefikHosts extracts every hostname from a container's Traefik router
// rule labels (traefik.http.routers.<name>.rule = Host(`a`) || Host(`b`)).
func parseTraefikHosts(labels map[string]string) []string {
	seen := map[string]bool{}
	var out []string
	for k, v := range labels {
		if !strings.HasPrefix(k, "traefik.http.routers.") || !strings.HasSuffix(k, ".rule") {
			continue
		}
		for _, m := range hostRuleRe.FindAllStringSubmatch(v, -1) {
			h := strings.ToLower(strings.TrimSpace(m[1]))
			if h != "" && !seen[h] {
				seen[h] = true
				out = append(out, h)
			}
		}
	}
	sort.Strings(out)
	return out
}

type savedDomain struct {
	Host      string   `json:"host"`
	IsPrimary bool     `json:"isPrimary"`
	Pointed   *bool    `json:"pointed"`
	Proxied   bool     `json:"proxied"`
	Records   []string `json:"records"`
	Message   string   `json:"message,omitempty"`
	Error     string   `json:"error,omitempty"`
	CheckedAt string   `json:"checkedAt,omitempty"`
}

type domainsResponse struct {
	Domains    []savedDomain `json:"domains"`
	ExpectedIP string        `json:"expectedIp"`
	Aliases    []string      `json:"aliases"`
}

func (s *Server) buildDomainsResponse() (domainsResponse, error) {
	settings := s.effectiveDomainSettings()
	resp := domainsResponse{
		Domains:    []savedDomain{},
		ExpectedIP: settings.ExpectedIP,
		Aliases:    settings.Aliases,
	}
	rows, err := s.db.ListDomains()
	if err != nil {
		return resp, err
	}
	for _, dm := range rows {
		var records []string
		_ = json.Unmarshal([]byte(dm.LastRecords), &records)
		if records == nil {
			records = []string{}
		}
		item := savedDomain{
			Host:      dm.Host,
			IsPrimary: dm.IsPrimary,
			Pointed:   dm.LastPointed,
			Proxied:   dm.LastProxied,
			Records:   records,
			Message:   dm.LastMessage,
			Error:     dm.LastError,
		}
		if dm.LastCheckedAt != nil {
			item.CheckedAt = dm.LastCheckedAt.UTC().Format("2006-01-02T15:04:05Z07:00")
		}
		resp.Domains = append(resp.Domains, item)
	}
	return resp, nil
}

func (s *Server) writeDomainsResponse(w http.ResponseWriter) {
	resp, err := s.buildDomainsResponse()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// domainSaved reports whether host is in the saved domains table.
func (s *Server) domainSaved(host string) bool {
	rows, err := s.db.ListDomains()
	if err != nil {
		return false
	}
	for _, dm := range rows {
		if dm.Host == host {
			return true
		}
	}
	return false
}

func (s *Server) listDomains(w http.ResponseWriter, r *http.Request) {
	s.writeDomainsResponse(w)
}

func (s *Server) saveDomain(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Host string `json:"host"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	host := cleanDomain(body.Host)
	if host == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "host is required"})
		return
	}
	if !validHostname(host) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid hostname"})
		return
	}
	if _, err := s.db.UpsertDomain(host); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	res := resolveDomain(r.Context(), host, expectedVPSIP())
	_ = s.db.UpdateDomainCheck(host, res.Pointed, res.Proxied, res.Records, res.Message, res.Error)
	if primary, _ := s.db.PrimaryDomain(); primary == "" {
		_ = s.db.SetPrimaryDomain(host)
		// Best-effort mirror to .env.local; DB primary is the source of truth.
		_ = upsertEnvLocal("PULSENODE_ROOT_DOMAIN", host)
		_ = os.Setenv("PULSENODE_ROOT_DOMAIN", host)
	}
	s.writeDomainsResponse(w)
}

func (s *Server) recheckDomain(w http.ResponseWriter, r *http.Request) {
	host := cleanDomain(chi.URLParam(r, "host"))
	if host == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "host is required"})
		return
	}
	if !s.domainSaved(host) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "domain not found"})
		return
	}
	res := resolveDomain(r.Context(), host, expectedVPSIP())
	_ = s.db.UpdateDomainCheck(host, res.Pointed, res.Proxied, res.Records, res.Message, res.Error)
	s.writeDomainsResponse(w)
}

func (s *Server) setPrimaryDomain(w http.ResponseWriter, r *http.Request) {
	host := cleanDomain(chi.URLParam(r, "host"))
	if host == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "host is required"})
		return
	}
	if !s.domainSaved(host) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "domain not found"})
		return
	}
	if err := s.db.SetPrimaryDomain(host); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// Best-effort mirror to .env.local; DB primary is the source of truth.
	_ = upsertEnvLocal("PULSENODE_ROOT_DOMAIN", host)
	_ = os.Setenv("PULSENODE_ROOT_DOMAIN", host)
	s.writeDomainsResponse(w)
}

func (s *Server) deleteDomain(w http.ResponseWriter, r *http.Request) {
	host := cleanDomain(chi.URLParam(r, "host"))
	if host == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "host is required"})
		return
	}
	if err := s.db.DeleteDomain(host); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	s.writeDomainsResponse(w)
}

type inUseRef struct {
	Source string `json:"source"` // project | container | caddy
	Ref    string `json:"ref"`
	Status string `json:"status,omitempty"`
}

type inUseHost struct {
	Host   string     `json:"host"`
	UsedBy []inUseRef `json:"usedBy"`
}

// discoverInUseHosts merges domains from PulseNode projects, all containers'
// Traefik labels, and Caddy routes, deduped by hostname.
func (s *Server) discoverInUseHosts(ctx context.Context) []inUseHost {
	agg := map[string]*inUseHost{}
	add := func(host, source, ref, status string) {
		host = cleanDomain(host)
		if host == "" {
			return
		}
		e := agg[host]
		if e == nil {
			e = &inUseHost{Host: host}
			agg[host] = e
		}
		e.UsedBy = append(e.UsedBy, inUseRef{Source: source, Ref: ref, Status: status})
	}

	if s.db != nil {
		if projects, err := s.db.ListProjects(); err == nil {
			for _, p := range projects {
				if p.Domain != "" {
					add(p.Domain, "project", p.Name, p.Status)
				}
			}
		}
	}
	if s.docker != nil {
		if cs, err := s.docker.ContainersWithLabels(ctx); err == nil {
			for _, c := range cs {
				for _, h := range parseTraefikHosts(c.Labels) {
					add(h, "container", c.Name, c.State)
				}
			}
		}
	}
	if routes, err := s.caddy.ListRoutes(ctx); err == nil {
		for _, rt := range routes {
			for _, m := range rt.Match {
				for _, h := range m.Host {
					add(h, "caddy", rt.ID, "")
				}
			}
		}
	}

	out := make([]inUseHost, 0, len(agg))
	for _, e := range agg {
		out = append(out, *e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Host < out[j].Host })
	return out
}

func (s *Server) inUseDomains(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"hosts": s.discoverInUseHosts(r.Context())})
}

// SeedDomainsIfEmpty imports discovered in-use hosts as saved (non-primary)
// rows the first time the domains table is empty. Best-effort.
func (s *Server) SeedDomainsIfEmpty(ctx context.Context) {
	if s.db == nil {
		return
	}
	existing, err := s.db.ListDomains()
	if err != nil || len(existing) > 0 {
		return
	}
	for _, h := range s.discoverInUseHosts(ctx) {
		_, _ = s.db.UpsertDomain(h.Host)
	}
}
