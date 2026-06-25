package ws

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

// timeout 默认超时
const defaultTimeout = 30 * time.Second

// send 发送命令到 daemon 并等待结果
func send(payload interface{}, timeout time.Duration) (interface{}, error) {
	// 先发送 HTTP 探测，唤醒可能的休眠 SW
	http.Get(fmt.Sprintf("http://127.0.0.1:%d", 18765))

	wsURL := fmt.Sprintf("ws://127.0.0.1:%d", 18765)

	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		return nil, fmt.Errorf("连接 daemon 失败: %w", err)
	}
	defer ws.Close()

	id := fmt.Sprintf("%d", time.Now().UnixNano())

	if err := ws.WriteJSON(map[string]interface{}{
		"id":   id,
		"code": payload,
	}); err != nil {
		return nil, fmt.Errorf("发送命令失败: %w", err)
	}

	type response struct {
		ID     string      `json:"id"`
		Type   string      `json:"type"`
		Result interface{} `json:"result"`
		Error  interface{} `json:"error"`
	}

	done := make(chan interface{}, 1)
	errCh := make(chan error, 1)

	go func() {
		defer func() { recover() }()
		for {
			ws.SetReadDeadline(time.Now().Add(timeout))
			_, msg, err := ws.ReadMessage()
			if err != nil {
				errCh <- fmt.Errorf("读取响应失败: %w", err)
				return
			}

			var resp response
			if err := json.Unmarshal(msg, &resp); err != nil {
				continue
			}

			if resp.ID != id {
				continue
			}
			if resp.Type == "ack" {
				continue
			}
			if resp.Type == "error" {
				// daemon 直接返回的错误（如"扩展未连接"）
				errMsg := fmt.Sprint(resp.Error)
				errCh <- fmt.Errorf(errMsg)
				return
			}
			// 扩展返回格式: {ok: true, data: 实际值} 或 {ok: false, error: "..."}
			if resultMap, ok := resp.Result.(map[string]interface{}); ok {
				if okVal, _ := resultMap["ok"].(bool); okVal {
					done <- resultMap["data"]
					return
				}
				if errStr, hasErr := resultMap["error"]; hasErr {
					errCh <- fmt.Errorf(fmt.Sprint(errStr))
					return
				}
			}
			done <- resp.Result
			return
		}
	}()

	select {
	case result := <-done:
		return result, nil
	case err := <-errCh:
		return nil, err
	case <-time.After(timeout):
		return nil, fmt.Errorf("命令超时 (%v)", timeout)
	}
}

// SendEval 执行 JS 并返回结果
func SendEval(code string, timeout time.Duration) (interface{}, error) {
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	return send(map[string]interface{}{
		"cmd":  "exec",
		"code": code,
	}, timeout)
}

// SendCDP 发送 CDP 协议命令
func SendCDP(method string, params map[string]interface{}, timeout ...time.Duration) (interface{}, error) {
	t := defaultTimeout
	if len(timeout) > 0 && timeout[0] > 0 {
		t = timeout[0]
	}
	return send(map[string]interface{}{
		"cmd":    "cdp",
		"method": method,
		"params": params,
	}, t)
}

// DecodeBase64 解码 base64 字符串
func DecodeBase64(s string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(s)
}
