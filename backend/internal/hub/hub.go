package hub

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type Event struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

const (
	wsWriteWait  = 10 * time.Second
	wsPongWait   = 60 * time.Second
	wsPingEvery  = 30 * time.Second
	wsReadLimit  = 4096
	wsSendBuffer = 64
)

// wsClient owns one websocket. gorilla/websocket allows a single concurrent
// writer, so every outgoing frame goes through send and is written by one
// goroutine (writePump); Broadcast never touches the connection directly.
type wsClient struct {
	conn *websocket.Conn
	send chan Event
	quit chan struct{}
	once sync.Once
}

func (c *wsClient) close() { c.once.Do(func() { close(c.quit) }) }

type Hub struct {
	mu      sync.RWMutex
	clients map[chan Event]struct{}
	ws      map[*wsClient]struct{}
	closed  chan struct{}
	closeMu sync.Once
	// AllowedOrigins gates cross-site WebSocket handshakes. Empty = same-origin
	// browsers only (any present Origin is rejected). Set from the app's
	// configured origins at startup.
	AllowedOrigins []string
}

func New() *Hub {
	return &Hub{clients: map[chan Event]struct{}{}, ws: map[*wsClient]struct{}{}, closed: make(chan struct{})}
}

// Subscribers returns how many SSE streams and websockets are connected, so
// producers can skip expensive collection when nobody is watching.
func (h *Hub) Subscribers() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients) + len(h.ws)
}

// Close ends all SSE streams and websockets (called on server shutdown, since
// http.Server.Shutdown does not wait for hijacked/streaming connections to end
// on its own).
func (h *Hub) Close() {
	h.closeMu.Do(func() { close(h.closed) })
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.ws {
		c.close()
	}
}

// originAllowed reports whether a WebSocket Origin is acceptable. An empty Origin
// (non-browser clients) is allowed; a present Origin must match a configured one.
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

// Broadcast fans an event out to every SSE subscriber and websocket client
// without ever blocking: a client whose buffer is full is slow or stalled, so an
// SSE event is skipped for it and a websocket client is dropped (it reconnects).
func (h *Hub) Broadcast(kind string, data any) {
	event := Event{Type: kind, Data: data}
	var slow []*wsClient
	h.mu.RLock()
	for client := range h.clients {
		select {
		case client <- event:
		default:
		}
	}
	for c := range h.ws {
		select {
		case c.send <- event:
		default:
			slow = append(slow, c)
		}
	}
	h.mu.RUnlock()
	for _, c := range slow {
		c.close()
	}
}

func (h *Hub) Subscribe() chan Event {
	ch := make(chan Event, 32)
	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *Hub) Unsubscribe(ch chan Event) {
	h.mu.Lock()
	delete(h.clients, ch)
	h.mu.Unlock()
	close(ch)
}

func (h *Hub) ServeSSE(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	ch := make(chan Event, 16)
	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.clients, ch)
		h.mu.Unlock()
		close(ch)
	}()

	_, _ = fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-h.closed:
			return
		case <-heartbeat.C:
			_, _ = fmt.Fprint(w, ": heartbeat\n\n")
			flusher.Flush()
		case event := <-ch:
			payload, _ := json.Marshal(event.Data)
			_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Type, payload)
			flusher.Flush()
		}
	}
}

func (h *Hub) ServeWebSocket(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return originAllowed(r.Header.Get("Origin"), h.AllowedOrigins) },
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &wsClient{conn: conn, send: make(chan Event, wsSendBuffer), quit: make(chan struct{})}
	h.mu.Lock()
	select {
	case <-h.closed: // shutting down
		h.mu.Unlock()
		_ = conn.Close()
		return
	default:
	}
	h.ws[c] = struct{}{}
	h.mu.Unlock()

	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		h.writePump(c)
	}()
	defer func() {
		h.mu.Lock()
		delete(h.ws, c)
		h.mu.Unlock()
		c.close()
		<-writerDone
		_ = conn.Close()
	}()

	c.send <- Event{Type: "alert:count", Data: 0}

	// Clients only listen; reading exists to process control frames, enforce the
	// pong deadline (dead peers are detected) and bound anything a client sends.
	conn.SetReadLimit(wsReadLimit)
	_ = conn.SetReadDeadline(time.Now().Add(wsPongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(wsPongWait))
	})
	go func() { // unblock ReadMessage when the writer or Close() ends the client
		<-c.quit
		_ = conn.Close()
	}()
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}

// writePump is the only goroutine that writes to c.conn.
func (h *Hub) writePump(c *wsClient) {
	ping := time.NewTicker(wsPingEvery)
	defer ping.Stop()
	defer c.close()
	for {
		select {
		case ev := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
			if err := c.conn.WriteJSON(ev); err != nil {
				return
			}
		case <-ping.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-c.quit:
			return
		}
	}
}
