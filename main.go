// commander-web is the browser renderer for commander. It dials commanderd
// at --daemon and serves a tiny SPA plus a reverse proxy to the daemon.
package main

import (
	"context"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	web "github.com/codemodify/commander-web/internal"
	webserver "github.com/codemodify/commander-web/internal/server"
	"github.com/codemodify/commanderd/pkg/client"
)

func main() {
	var (
		bind   string
		daemon string
	)
	flag.StringVar(&bind, "bind", "127.0.0.1:50001", "host:port to serve the web UI on")
	flag.StringVar(&daemon, "daemon", "127.0.0.1:50000", "commanderd address (host:port)")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	c, err := client.Dial(ctx, client.Config{Addr: daemon})
	if err != nil {
		log.Fatalf("commander-web: dial %s: %v", daemon, err)
	}

	h, err := webserver.Handler(web.SPA, c.Addr)
	if err != nil {
		log.Fatal(err)
	}

	ln, err := net.Listen("tcp", bind)
	if err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("commander-web: http://%s (daemon=%s)", ln.Addr(), c.Addr)

	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(ln) }()
	select {
	case <-ctx.Done():
		shutCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	case err := <-errCh:
		if err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}
}
