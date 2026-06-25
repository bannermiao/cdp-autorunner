package ws

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/gorilla/websocket"
)

// RunDaemon 启动 WS 中继服务
func RunDaemon(port int) {
	var extSocket *websocket.Conn
	var curClient *websocket.Conn

	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return true },
	}

	// 关闭信号，让外部可以优雅停止
	shutdownCh := make(chan struct{})

	mux := http.NewServeMux()
	mux.HandleFunc("/shutdown", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("shutting down"))
		go func() { shutdownCh <- struct{}{} }()
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// 扩展连接的是 ws://127.0.0.1:18765（根路径），需要检测 WS 升级请求
		if strings.ToLower(r.Header.Get("Upgrade")) == "websocket" {
			conn, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer conn.Close()

			for {
				_, msg, err := conn.ReadMessage()
				if err != nil {
					if conn == extSocket {
						extSocket = nil
					} else if conn == curClient {
						curClient = nil
					}
					return
				}

				var parsed struct {
					Type string `json:"type"`
				}
				if err := json.Unmarshal(msg, &parsed); err != nil {
					continue
				}

				if parsed.Type == "ping" {
					conn.WriteJSON(map[string]string{"type": "pong"})
					continue
				}

				if parsed.Type == "ext_ready" {
					extSocket = conn
					continue
				}

				if conn == extSocket {
					if curClient != nil {
						curClient.WriteMessage(websocket.TextMessage, msg)
					}
					continue
				}

				curClient = conn
				if extSocket != nil {
					extSocket.WriteMessage(websocket.TextMessage, msg)
				} else {
					conn.WriteJSON(map[string]interface{}{
						"type":  "error",
						"error": "扩展未连接",
					})
				}
			}
		}

		// 普通 HTTP 请求（探活用）
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	server := &http.Server{
		Addr:    fmt.Sprintf("127.0.0.1:%d", port),
		Handler: mux,
	}

	go func() {
		server.ListenAndServe()
	}()

	fmt.Printf("CDP Bridge daemon (PID: %d)\n", os.Getpid())
	fmt.Printf("  WS: ws://127.0.0.1:%d\n", port)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, os.Signal(syscall.SIGTERM))

	select {
	case <-sig:
	case <-shutdownCh:
	}

	server.Close()
	os.Exit(0)
}
