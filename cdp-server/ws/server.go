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
	// 多客户端支持：每个客户端连接有独立 id，响应按 id 路由回对应客户端
	clients := make(map[string]*websocket.Conn)

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
					}
					// 清理已断开的客户端
					for id, c := range clients {
						if c == conn {
							delete(clients, id)
						}
					}
					return
				}

				var parsed struct {
					Type string `json:"type"`
					ID   string `json:"id"`
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
					// 扩展返回的响应，按 id 路由回对应客户端
					if parsed.ID != "" {
						if c, ok := clients[parsed.ID]; ok {
							c.WriteMessage(websocket.TextMessage, msg)
						}
					}
					continue
				}

				// 客户端连接：注册到 map（用请求 id 作为 key），转发给扩展
				if parsed.ID != "" {
					clients[parsed.ID] = conn
				}
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
