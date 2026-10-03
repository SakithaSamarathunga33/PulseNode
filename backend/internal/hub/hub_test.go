package hub

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func dial(t *testing.T, srv *httptest.Server) *websocket.Conn {
	t.Helper()
	u := "ws" + strings.TrimPrefix(srv.URL, "http")
	c, _, err := websocket.DefaultDialer.Dial(u, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return c
}

func waitClients(t *testing.T, h *Hub, n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		h.mu.RLock()
		got := len(h.ws)
		h.mu.RUnlock()
		if got == n {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("expected %d ws clients", n)
}

// Run with -race: concurrent Broadcast calls used to write to the same
// websocket from several goroutines.
func TestConcurrentBroadcastDeliversToClients(t *testing.T) {
	h := New()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWebSocket))
	defer srv.Close()
	c := dial(t, srv)
	defer c.Close()
	waitClients(t, h, 1)

	const senders, each = 8, 5
	var wg sync.WaitGroup
	for i := 0; i < senders; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < each; j++ {
				h.Broadcast("test", map[string]int{"n": j})
			}
		}()
	}
	wg.Wait()

	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	got := 0
	for got < senders*each+1 { // +1 for the initial alert:count frame
		var ev Event
		if err := c.ReadJSON(&ev); err != nil {
			t.Fatalf("read after %d frames: %v", got, err)
		}
		got++
	}
}

// A client that never reads must not block Broadcast, and gets dropped.
func TestSlowClientDoesNotBlockBroadcast(t *testing.T) {
	h := New()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWebSocket))
	defer srv.Close()
	c := dial(t, srv) // never read from c
	defer c.Close()
	waitClients(t, h, 1)

	done := make(chan struct{})
	go func() {
		payload := strings.Repeat("x", 32*1024)
		for i := 0; i < 2000; i++ {
			h.Broadcast("big", payload)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Broadcast blocked on a stalled client")
	}
	waitClients(t, h, 0) // slow client was dropped
}

func TestCloseEndsClients(t *testing.T) {
	h := New()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWebSocket))
	defer srv.Close()
	c := dial(t, srv)
	defer c.Close()
	waitClients(t, h, 1)
	h.Close()
	waitClients(t, h, 0)
	// Broadcast after Close must not panic.
	h.Broadcast("x", 1)
}
