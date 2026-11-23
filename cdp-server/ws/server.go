package ws

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// clientConn 包一层写锁：gorilla/websocket 明确禁止并发写同一个连接
// （conn.go:617 panic: concurrent write to websocket connection）。
// 多个客户端 goroutine 会同时写扩展连接 extSocket，客户端侧也会同时写自己的连接，必须串行化。
type clientConn struct {
	mu   sync.Mutex
	conn *websocket.Conn
}

func (c *clientConn) writeText(b []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteMessage(websocket.TextMessage, b)
}

func (c *clientConn) writeJSON(v interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteJSON(v)
}

// daemonLog 崩溃与异常落盘。`start` 用 DETACHED_PROCESS 起进程，stdout 无人接管，
// 崩溃信息会直接丢失 —— 之前只能看到「daemon 突然没了」，看不到原因。
func daemonLog(format string, a ...interface{}) {
	line := fmt.Sprintf("[%s] %s\n", time.Now().Format("2006-01-02 15:04:05"), fmt.Sprintf(format, a...))
	os.Stderr.WriteString(line)
	name := "cdp-daemon.log"
	if exe, err := os.Executable(); err == nil {
		name = filepath.Join(filepath.Dir(exe), "cdp-daemon.log")
	}
	if f, err := os.OpenFile(name, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644); err == nil {
		f.WriteString(line)
		f.Close()
	}
}

// RunDaemon 启动 WS 中继服务
func RunDaemon(port int) {
	// extSocket 与 clients 都只由 clientsMu 保护。
	// 修复点 1：原版两者都是裸变量，每个 WS 连接跑独立 goroutine，并发 5 时
	// 同时写 map → Go runtime `fatal error: concurrent map writes`，进程立即退出。
	var (
		clientsMu sync.Mutex
		extSocket *clientConn
		clients   = make(map[string]*clientConn)
	)

	getExt := func() *clientConn {
		clientsMu.Lock()
		defer clientsMu.Unlock()
		return extSocket
	}
	setExt := func(c *clientConn) {
		clientsMu.Lock()
		defer clientsMu.Unlock()
		extSocket = c
	}
	clearExtIf := func(c *clientConn) {
		clientsMu.Lock()
		defer clientsMu.Unlock()
		if extSocket == c {
			extSocket = nil
		}
	}
	registerClient := func(id string, c *clientConn) {
		clientsMu.Lock()
		defer clientsMu.Unlock()
		clients[id] = c
	}
	lookupClient := func(id string) *clientConn {
		clientsMu.Lock()
		defer clientsMu.Unlock()
		return clients[id]
	}
	unregisterClient := func(c *clientConn) {
		clientsMu.Lock()
		defer clientsMu.Unlock()
		for id, cc := range clients {
			if cc == c {
				delete(clients, id)
			}
		}
	}
	countClients := func() int {
		clientsMu.Lock()
		defer clientsMu.Unlock()
		return len(clients)
	}

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
			self := &clientConn{conn: conn}
			defer func() {
				// 修复点 3：任何 handler 级 panic 都要兜住，否则一条连接的错误会带走整个 daemon
				if e := recover(); e != nil {
					daemonLog("PANIC in ws handler: %v\n%s", e, debug.Stack())
				}
				clearExtIf(self)
				unregisterClient(self)
				conn.Close()
			}()

			for {
				_, msg, err := conn.ReadMessage()
				if err != nil {
					// 连接断开：defer 里统一清 ext / clients
					daemonLog("conn closed: err=%v clients=%d", err, countClients())
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
					self.writeJSON(map[string]string{"type": "pong"})
					continue
				}

				if parsed.Type == "ext_ready" {
					setExt(self)
					daemonLog("ext_ready: clients=%d", countClients())
					continue
				}

				ext := getExt()
				if ext == self {
					// 扩展返回的响应，按 id 路由回对应客户端
					if parsed.ID != "" {
						if c := lookupClient(parsed.ID); c != nil {
							// 修复点 2：写目标连接也要加锁
							if err := c.writeText(msg); err != nil {
								daemonLog("route to client %s failed: %v", parsed.ID, err)
							}
						}
					}
					continue
				}

				// 客户端连接：注册到 map（用请求 id 作为 key），转发给扩展
				if parsed.ID != "" {
					registerClient(parsed.ID, self)
				}
				if ext != nil {
					// 修复点 2 核心：多个客户端 goroutine 同时写扩展这一条连接，
					// 原版裸 WriteMessage 会 panic（gorilla conn.go:617）
					if err := ext.writeText(msg); err != nil {
						daemonLog("forward to ext failed: %v", err)
					}
				} else {
					// 必须回带 id：客户端按 id 匹配响应，不回 id 的话这条错误会被丢弃，
					// 调用方只能干等到 timeout，最后报一个误导性的「命令超时」。
					self.writeJSON(map[string]interface{}{
						"id":    parsed.ID,
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
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			daemonLog("FATAL listen: %v", err)
		}
	}()

	fmt.Printf("CDP Bridge daemon (PID: %d)\n", os.Getpid())
	fmt.Printf("  WS: ws://127.0.0.1:%d\n", port)
	daemonLog("daemon started pid=%d port=%d", os.Getpid(), port)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, os.Signal(syscall.SIGTERM))

	select {
	case <-sig:
		daemonLog("daemon stopping: signal")
	case <-shutdownCh:
		daemonLog("daemon stopping: shutdown request")
	}

	server.Close()
	os.Exit(0)
}
