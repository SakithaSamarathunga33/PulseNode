package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"pulsenode/backend/internal/builder"
	"pulsenode/backend/internal/db"
)

func (s *Server) freePort(w http.ResponseWriter, r *http.Request) {
	projects, err := s.db.ListProjects()
	if err != nil {
		writeError(w, err)
		return
	}
	used := map[int]bool{}
	for _, p := range projects {
		used[p.Port] = true
	}
	port := 3000
	for used[port] {
		port++
	}
	writeJSON(w, http.StatusOK, map[string]int{"port": port})
}

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request) {
	projects, err := s.db.ListProjects()
	if err != nil {
		writeError(w, err)
		return
	}
	// Merge in apps already hosted on the VPS behind a domain but not deployed
	// through PulseNode, so the projects list reflects everything actually
	// live on the box, not just what this app built.
	items := make([]any, 0, len(projects)+4)
	for _, p := range projects {
		items = append(items, p)
	}
	for _, ext := range s.discoverExternalProjects(r.Context()) {
		items = append(items, ext)
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) createProject(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name         string `json:"name"`
		RepoURL      string `json:"repoUrl"`
		Branch       string `json:"branch"`
		BuildMethod  string `json:"buildMethod"`
		BuildCommand string `json:"buildCommand"`
		Port           int    `json:"port"`
		Domain         string `json:"domain"`
		EnvVars        string `json:"envVars"`
		BackendEnvVars string `json:"backendEnvVars"`
		BaseDir        string `json:"baseDir"`
		AutoDeploy     *bool  `json:"autoDeploy"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.Name == "" || body.RepoURL == "" || body.Domain == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name, repoUrl, and domain are required"})
		return
	}
	body.Domain = cleanDomain(body.Domain)
	if !validHostname(body.Domain) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "domain must be a plain hostname like app.example.com"})
		return
	}
	if body.BaseDir != "" && body.BaseDir != "frontend" && body.BaseDir != "backend" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "baseDir must be \"frontend\" or \"backend\""})
		return
	}
	if body.Branch == "" {
		body.Branch = "main"
	}
	if body.BuildMethod == "" {
		body.BuildMethod = "auto"
	}
	if body.Port == 0 {
		body.Port = 3000
	}
	if body.EnvVars == "" {
		body.EnvVars = "{}"
	}
	if body.BackendEnvVars == "" {
		body.BackendEnvVars = "{}"
	}

	autoDeploy := true
	if body.AutoDeploy != nil {
		autoDeploy = *body.AutoDeploy
	}

	proj := &db.Project{
		ID:             db.NewID("proj"),
		Name:           body.Name,
		RepoURL:        body.RepoURL,
		Branch:         body.Branch,
		BuildMethod:    body.BuildMethod,
		BuildCommand:   body.BuildCommand,
		Port:           body.Port,
		Domain:         body.Domain,
		EnvVars:        body.EnvVars,
		BackendEnvVars: body.BackendEnvVars,
		BaseDir:        body.BaseDir,
		Status:         "idle",
		AutoDeploy:     autoDeploy,
	}
	if err := s.db.CreateProject(proj); err != nil {
		writeError(w, err)
		return
	}
	// Auto-install the push webhook on the repo (best-effort) so auto-deploy is
	// instant without the user adding it by hand. Surfaced via GET …/webhook.
	_, _ = s.installProjectWebhook(proj)
	writeJSON(w, http.StatusCreated, proj)
}

func (s *Server) getProject(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if strings.HasPrefix(id, externalIDPrefix) {
		ext, ok := s.getExternalProject(r.Context(), id)
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		writeJSON(w, http.StatusOK, ext)
		return
	}
	proj, err := s.db.GetProject(id)
	if err != nil {
		writeError(w, err)
		return
	}
	if proj == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	writeJSON(w, http.StatusOK, proj)
}

func (s *Server) updateProject(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Name         string `json:"name"`
		Branch       string `json:"branch"`
		BuildMethod  string `json:"buildMethod"`
		BuildCommand string `json:"buildCommand"`
		Port           int    `json:"port"`
		Domain         string `json:"domain"`
		EnvVars        string `json:"envVars"`
		BackendEnvVars string `json:"backendEnvVars"`
		AutoDeploy     *bool  `json:"autoDeploy"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.BackendEnvVars == "" {
		body.BackendEnvVars = "{}"
	}
	if body.Domain != "" {
		body.Domain = cleanDomain(body.Domain)
		if !validHostname(body.Domain) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "domain must be a plain hostname like app.example.com"})
			return
		}
	}
	// Preserve the current auto-deploy setting when the field is omitted.
	autoDeploy := true
	if body.AutoDeploy != nil {
		autoDeploy = *body.AutoDeploy
	} else if cur, _ := s.db.GetProject(id); cur != nil {
		autoDeploy = cur.AutoDeploy
	}
	if err := s.db.UpdateProject(id, body.Name, body.Branch, body.BuildMethod, body.BuildCommand, body.Port, body.Domain, body.EnvVars, body.BackendEnvVars, autoDeploy); err != nil {
		writeError(w, err)
		return
	}
	proj, _ := s.db.GetProject(id)
	writeJSON(w, http.StatusOK, proj)
}

func (s *Server) deleteProject(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.db.DeleteProject(id); err != nil {
		writeError(w, err)
		return
	}
	// Stop+remove the project's live container(s) (both components, for a
	// separate-mode/monorepo deploy) so a deleted project doesn't keep serving
	// traffic or squatting its Traefik routes.
	builder.RemoveProjectContainers(r.Context(), id)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) deployProject(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	proj, err := s.db.GetProject(id)
	if err != nil || proj == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "project not found"})
		return
	}

	dep := &db.Deployment{
		ID:        db.NewID("dep"),
		ProjectID: id,
		Status:    "queued",
		Trigger:   "manual",
	}
	if err := s.db.CreateDeployment(dep); err != nil {
		writeError(w, err)
		return
	}

	_ = s.db.UpdateProjectStatus(id, "building", "")
	s.queue.Enqueue(dep.ID)

	writeJSON(w, http.StatusAccepted, map[string]string{"deploymentId": dep.ID})
}

// rollbackDeployment redeploys the image a previous successful deployment
// produced, without rebuilding. Only deployments that recorded an image tag
// (Dockerfile/Nixpacks builds) can be rolled back to.
func (s *Server) rollbackDeployment(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	depID := chi.URLParam(r, "depID")

	proj, err := s.db.GetProject(id)
	if err != nil || proj == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "project not found"})
		return
	}
	target, err := s.db.GetDeploymentByID(depID)
	if err != nil || target == nil || target.ProjectID != id {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "deployment not found"})
		return
	}
	if target.ImageTag == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "this deployment has no rollback image (only Dockerfile/Nixpacks builds can be rolled back)"})
		return
	}

	dep := &db.Deployment{
		ID:        db.NewID("dep"),
		ProjectID: id,
		Status:    "queued",
		Trigger:   "rollback",
		ImageTag:  target.ImageTag,
		CommitSHA: target.CommitSHA,
		CommitMsg: target.CommitMsg,
	}
	if err := s.db.CreateDeployment(dep); err != nil {
		writeError(w, err)
		return
	}
	_ = s.db.UpdateDeploymentCommit(dep.ID, target.CommitSHA, target.CommitMsg)
	_ = s.db.UpdateProjectStatus(id, "building", "")
	s.queue.Enqueue(dep.ID)

	writeJSON(w, http.StatusAccepted, map[string]string{"deploymentId": dep.ID})
}

func (s *Server) listDeployments(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	deps, err := s.db.ListDeployments(id)
	if err != nil {
		writeError(w, err)
		return
	}
	if deps == nil {
		deps = []db.Deployment{}
	}
	writeJSON(w, http.StatusOK, deps)
}

func (s *Server) getDeploymentLogs(w http.ResponseWriter, r *http.Request) {
	depID := chi.URLParam(r, "depID")

	if r.Header.Get("Accept") == "text/event-stream" {
		s.streamDeploymentLogs(w, r, depID)
		return
	}

	logs, err := s.db.GetLogs(depID)
	if err != nil {
		writeError(w, err)
		return
	}
	if logs == nil {
		logs = []map[string]string{}
	}
	writeJSON(w, http.StatusOK, logs)
}

func (s *Server) streamDeploymentLogs(w http.ResponseWriter, r *http.Request, depID string) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	sendJSON := func(data any) {
		b, _ := json.Marshal(data)
		_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
		if ok {
			flusher.Flush()
		}
	}

	// Send historical logs first
	logs, _ := s.db.GetLogs(depID)
	for _, entry := range logs {
		sendJSON(entry)
	}

	// Subscribe for live events
	ch := s.hub.Subscribe()
	defer s.hub.Unsubscribe(ch)

	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			_, _ = fmt.Fprint(w, ": ping\n\n")
			if ok {
				flusher.Flush()
			}
		case event, open := <-ch:
			if !open {
				return
			}
			if event.Type != "deploy:log" {
				continue
			}
			payload, isMap := event.Data.(map[string]any)
			if !isMap {
				continue
			}
			if payload["deploymentId"] != depID {
				continue
			}
			sendJSON(payload)
		}
	}
}

