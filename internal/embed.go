// Package web bundles the commander SPA assets as an embed.FS.
package web

import "embed"

//go:embed all:frontend
var SPA embed.FS
