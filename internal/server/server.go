// Package server hosts the commander web renderer's backend. It serves the
// embedded SPA and reverse-proxies Connect RPC calls to the daemon.
package server

import (
	"embed"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync/atomic"

	"github.com/codemodify/commanderd/pkg/columns"
	"github.com/codemodify/commanderd/pkg/icons"
)

// Handler builds the web renderer's HTTP handler.
//
// spa is the embedded SPA filesystem (must contain index.html). daemonAddr
// is the initial commanderd address, e.g. "127.0.0.1:50000"; the SPA can
// retarget the proxy at runtime via POST /api/daemon.
func Handler(spa embed.FS, daemonAddr string) (http.Handler, error) {
	target, err := parseDaemon(daemonAddr)
	if err != nil {
		return nil, err
	}
	var current atomic.Pointer[url.URL]
	current.Store(target)

	proxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			u := current.Load()
			req.URL.Scheme = u.Scheme
			req.URL.Host = u.Host
			req.Host = u.Host
		},
	}

	staticFS, err := fs.Sub(spa, "frontend")
	if err != nil {
		return nil, err
	}

	mux := http.NewServeMux()
	mux.Handle("/commander.v1.Commander/", proxy)
	// Terminal WebSocket: httputil.ReverseProxy transparently upgrades
	// HTTP/1.1 Upgrade requests (Go >= 1.12), so the browser's native
	// WebSocket talks straight to the daemon through this proxy.
	mux.Handle("/ws/", proxy)
	mux.HandleFunc("/api/daemon", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{"addr": current.Load().Host})
		case http.MethodPost:
			var body struct{ Addr string }
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			next, err := parseDaemon(body.Addr)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			current.Store(next)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{"addr": next.Host})
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/columns.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(columns.Default)
	})
	// Serve the shared icon sprite. Renderers pull the exact same glyphs the
	// Fyne side consumes through `icons.<Name>`.
	spriteBytes := []byte(icons.Sprite())
	mux.HandleFunc("/icons.sprite.svg", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/svg+xml")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(spriteBytes)
	})
	mux.Handle("/", spaHandler(staticFS))
	return mux, nil
}

func parseDaemon(addr string) (*url.URL, error) {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return nil, &url.Error{Op: "parse", URL: addr, Err: errEmptyAddr}
	}
	if !strings.Contains(addr, "://") {
		addr = "http://" + addr
	}
	u, err := url.Parse(addr)
	if err != nil {
		return nil, err
	}
	if u.Host == "" {
		return nil, &url.Error{Op: "parse", URL: addr, Err: errEmptyAddr}
	}
	if u.Scheme == "" {
		u.Scheme = "http"
	}
	return u, nil
}

var errEmptyAddr = &simpleErr{"empty daemon address"}

type simpleErr struct{ s string }

func (e *simpleErr) Error() string { return e.s }

// spaHandler serves static assets, falling back to index.html for unknown
// paths — the minimal SPA routing.
func spaHandler(f fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(f))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// If the requested path exists in the fs, serve it; otherwise fall back.
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			p = "index.html"
		}
		if _, err := fs.Stat(f, p); err == nil {
			fileServer.ServeHTTP(w, r)
			return
		}
		// Fallback to index.
		http.ServeFileFS(w, r, f, "index.html")
	})
}
