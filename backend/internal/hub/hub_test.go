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
	for got < senders*each { // no OpenAlertCount set → no alert:count frame on connect
		var ev Event
		if err := c.ReadJSON(&ev); err != nil {
			t.Fatalf("read after %d frames: %v", got, err)
		}
		got++
	}
}

// A new websocket gets the REAL firing-alert count, never a hard-coded zero.
func TestConnectSendsRealAlertCount(t *testing.T) {
	h := New()
	h.OpenAlertCount = func() int { return 3 }
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWebSocket))
	defer srv.Close()
	c := dial(t, srv)
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	var ev struct {
		Type string
		Data float64
	}
	if err := c.ReadJSON(&ev); err != nil {
		t.Fatal(err)
	}
	if ev.Type != "alert:count" || ev.Data != 3 {
		t.Fatalf("first frame = %+v, want alert:count 3", ev)
	}
}

// Without a source for the count the hub says nothing rather than inventing one.
func TestConnectWithoutCountSourceSendsNoAlertCount(t *testing.T) {
	h := New()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWebSocket))
	defer srv.Close()
	c := dial(t, srv)
	defer c.Close()
	waitClients(t, h, 1)
	h.Broadcast("probe", 1)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	var ev Event
	if err := c.ReadJSON(&ev); err != nil {
		t.Fatal(err)
	}
	if ev.Type != "probe" {
		t.Fatalf("first frame = %q, want probe (no alert:count)", ev.Type)
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
