module github.com/codemodify/commander-web

go 1.26.2

require github.com/codemodify/commanderd v0.0.0

require (
	connectrpc.com/connect v1.19.1 // indirect
	golang.org/x/net v0.53.0 // indirect
	golang.org/x/text v0.36.0 // indirect
	google.golang.org/protobuf v1.36.11 // indirect
)

replace github.com/codemodify/commanderd => ../commanderd
