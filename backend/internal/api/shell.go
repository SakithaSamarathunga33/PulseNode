package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"github.com/rs/zerolog/log"
)

// originAllowed reports whether a WebSocket Origin header is acceptable.
// An empty Origin (non-browser clients, e.g. a CLI using a Bearer token) is
// allowed because cross-site WebSocket hijacking requires a browser, which
// always sends Origin. A present Origin must match one of the configured app
// origins — this blocks a malicious page from opening an authenticated socket
// (e.g. a container shell) using the victim's ambient credentials.
func originAllowed(origin string, allowed []string) bool {
	if origin == "" {
		return true
	}
	o := strings.TrimRight(origin, "/")
	for _, a := range allowed {
		if strings.EqualFold(strings.TrimRight(a, "/"), o) {
			return true
		}
	}
	return false
}

const (
	shellReadLimit   = 64 << 10 // largest single paste/keystroke frame accepted from the browser
	shellWriteWait   = 10 * time.Second
	shellPongWait    = 60 * time.Second
	shellPingEvery   = 30 * time.Second
	shellIdleTimeout = 30 * time.Minute // no keystrokes for this long → session is closed
)

// shellActor names the session owner for the audit log (same cookie lookup the
// audit middleware uses; WebSocket upgrades are GETs, which it does not record).
func (s *Server) shellActor(r *http.Request) string {
	if c, err := r.Cookie(sessionCookieName); err == nil {
		if claims, ok := s.auth.ParseToken(c.Value); ok {
			if sub, _ := claims["sub"].(string); sub != "" {
				return sub
			}
		}
	}
	return "anonymous"
}

// containerShell upgrades to WebSocket then proxies a TTY shell inside the container
// via Docker exec hijacking. The PTY is allocated by Docker inside the container —
// no CGO/creack/pty needed on the host.
//
// Lifecycle: one goroutine reads the browser, one writes the browser (the only
// data writer — gorilla allows a single), and a pinger sends control frames
// (safe concurrently). When any of them ends, or the session is idle too long,
// both connections are closed; closing the exec's TTY hangs up the shell inside
// the container so the process does not outlive the browser tab.
func (s *Server) containerShell(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if s.docker == nil {
		http.Error(w, "docker unavailable", http.StatusServiceUnavailable)
		return
	}

	wsUpgrader := websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin:     func(r *http.Request) bool { return originAllowed(r.Header.Get("Origin"), s.origins) },
	}

	// 1. Create exec with TTY
	execID, err := s.docker.CreateTTYExec(r.Context(), id)
	if err != nil {
		http.Error(w, "exec create: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// 2. Upgrade client connection to WebSocket
	ws, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Warn().Err(err).Str("container", id).Msg("ws upgrade failed")
		return
	}
	defer ws.Close()

	// 3. Hijack the Docker exec stream (raw TCP, TTY-mode, no multiplexing)
	dockerConn, err := hijackDockerExec(execID)
	if err != nil {
		_ = ws.WriteMessage(websocket.TextMessage, []byte("\r\n[pulsenode] shell error: "+err.Error()+"\r\n"))
		return
	}
	defer dockerConn.Close()

	// Container shells are the most sensitive thing the panel exposes and the
	// upgrade is a GET (not covered by the audit middleware), so log them here.
	actor, started := s.shellActor(r), time.Now()
	resource := "/api/docker/containers/" + id + "/shell"
	s.db.InsertAuditLog(actor, "SHELL open", resource, clientIP(r), http.StatusSwitchingProtocols)
	defer func() {
		s.db.InsertAuditLog(actor, "SHELL close ("+time.Since(started).Round(time.Second).String()+")", resource, clientIP(r), http.StatusOK)
	}()

	ws.SetReadLimit(shellReadLimit)
	_ = ws.SetReadDeadline(time.Now().Add(shellPongWait))
	ws.SetPongHandler(func(string) error { return ws.SetReadDeadline(time.Now().Add(shellPongWait)) })

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	var lastInput atomic.Int64
	lastInput.Store(time.Now().UnixNano())
	var wg sync.WaitGroup

	// Docker → WebSocket (container output → browser). The only data writer.
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer cancel()
		buf := make([]byte, 4096)
		for {
			n, err := dockerConn.Read(buf)
			if n > 0 {
				_ = ws.SetWriteDeadline(time.Now().Add(shellWriteWait))
				if err2 := ws.WriteMessage(websocket.BinaryMessage, buf[:n]); err2 != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	// WebSocket → Docker (browser keystrokes → container stdin)
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer cancel()
		for {
			_, msg, err := ws.ReadMessage()
			if err != nil {
				return
			}
			lastInput.Store(time.Now().UnixNano())
			if _, err := dockerConn.Write(msg); err != nil {
				return
			}
		}
	}()

	// Keepalive + idle timeout. WriteControl may run alongside the data writer.
	wg.Add(1)
	go func() {
		defer wg.Done()
		t := time.NewTicker(shellPingEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if time.Since(time.Unix(0, lastInput.Load())) > shellIdleTimeout {
					_ = ws.WriteControl(websocket.CloseMessage,
						websocket.FormatCloseMessage(websocket.CloseGoingAway, "idle timeout"), time.Now().Add(shellWriteWait))
					cancel()
					return
				}
				if err := ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(shellWriteWait)); err != nil {
					cancel()
					return
				}
			}
		}
	}()

	<-ctx.Done()
	// Closing both ends unblocks the reader goroutines; the Docker side hangs up
	// the exec's TTY, which ends the shell inside the container.
	_ = dockerConn.Close()
	_ = ws.Close()
	wg.Wait()
}

// hijackDockerExec dials the Docker socket directly and performs an HTTP upgrade
// to get a raw TCP connection for exec stdin/stdout.
func hijackDockerExec(execID string) (net.Conn, error) {
	conn, err := net.Dial("unix", "/var/run/docker.sock")
	if err != nil {
		return nil, fmt.Errorf("dial docker socket: %w", err)
	}

	body := `{"Detach":false,"Tty":true}`
	req := fmt.Sprintf(
		"POST /exec/%s/start HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n%s",
		execID, len(body), body,
	)
	if _, err := conn.Write([]byte(req)); err != nil {
		conn.Close()
		return nil, fmt.Errorf("send exec start: %w", err)
	}

	// Read HTTP response headers only — leave the rest as raw stream
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("read exec response: %w", err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		conn.Close()
		return nil, fmt.Errorf("expected 101 Switching Protocols, got %d", resp.StatusCode)
	}

	// bufio.Reader may have buffered bytes ahead of the raw stream.
	// Wrap conn so buffered bytes are drained first.
	return &hijackedConn{Conn: conn, br: br}, nil
}

// hijackedConn uses buffered reader for reads (to drain any bytes the HTTP
// response parser buffered) and the raw conn for writes.
type hijackedConn struct {
	net.Conn
	br *bufio.Reader
}

func (h *hijackedConn) Read(p []byte) (int, error) { return h.br.Read(p) }

// ── Resize ────────────────────────────────────────────────────────────────────

// containerShellResize handles POST requests to resize the exec TTY.
func (s *Server) containerShellResize(w http.ResponseWriter, r *http.Request) {
	execID := r.URL.Query().Get("exec")
	if execID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "exec query param required"})
		return
	}
	var req struct {
		H int `json:"h"`
		W int `json:"w"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if err := s.docker.ResizeExecTTY(r.Context(), execID, req.H, req.W); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ── Docker helpers ────────────────────────────────────────────────────────────

// These live here so they stay close to the shell code that uses them.
// CreateTTYExec and ResizeExecTTY are also added to the docker client via a
// separate method file, but defined inline here for clarity.

// createTTYExecBody builds the exec create payload.
func createTTYExecBody() []byte {
	b, _ := json.Marshal(map[string]any{
		"Cmd":          []string{"sh"},
		"AttachStdin":  true,
		"AttachStdout": true,
		"AttachStderr": true,
		"Tty":          true,
	})
	return b
}

var _ = createTTYExecBody // referenced by docker client directly
