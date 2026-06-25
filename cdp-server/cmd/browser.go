package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"cdp-server/ws"

	"github.com/spf13/cobra"
)

var browserCmd = &cobra.Command{
	Use:   "browser <command> [args...]",
	Short: "浏览器控制命令",
	Run: func(cmd *cobra.Command, args []string) {
		cmd.Help()
	},
}

func init() {
	registerAllBrowserCommands()
}

type browserCmdDef struct {
	use     string
	short   string
	argsMin int
	argsMax int
	run     func(args []string) (interface{}, error)
}

func def(cmd browserCmdDef) {
	c := &cobra.Command{
		Use:   cmd.use,
		Short: cmd.short,
		Args:  cobra.RangeArgs(cmd.argsMin, cmd.argsMax),
		Run:   makeBrowserRunner(cmd.run),
	}
	browserCmd.AddCommand(c)
}

func makeBrowserRunner(fn func([]string) (interface{}, error)) func(*cobra.Command, []string) {
	return func(cmd *cobra.Command, args []string) {
		result, err := fn(args)
		if err != nil {
			fmt.Fprintln(os.Stderr, "ERROR:", err)
			os.Exit(1)
		}
		if result != nil {
			switch v := result.(type) {
			case string:
				fmt.Println(v)
			default:
				b, _ := json.MarshalIndent(v, "", "  ")
				fmt.Println(string(b))
			}
		}
	}
}

func registerAllBrowserCommands() {
	def(browserCmdDef{
		use: "goto <url>", short: "导航到页面",
		argsMin: 1, argsMax: 1,
		run: func(args []string) (interface{}, error) {
			url := args[0]
			ws.SendCDP("Page.enable", nil)
			ws.SendCDP("Page.navigate", map[string]interface{}{"url": url})
			// 轮询页面标题，最多等 10 秒（比固定 1.5s 更可靠）
			titleStr := ""
			for i := 0; i < 20; i++ {
				time.Sleep(500 * time.Millisecond)
				t, err := ws.SendEval("document.title", 5*time.Second)
				if err != nil {
					continue
				}
				s := fmt.Sprint(t)
				if s != "" && !strings.Contains(s, "Electronics, Cars") {
					titleStr = s
					break
				}
			}
			return "TITLE: " + titleStr, nil
		},
	})

	def(browserCmdDef{
		use: "eval <code> [文件]", short: "执行 JS 表达式",
		argsMin: 1, argsMax: 2,
		run: func(args []string) (interface{}, error) {
			result, err := ws.SendEval(args[0], 30*time.Second)
			if err != nil {
				return nil, err
			}
			if len(args) == 2 {
				out := resolvePath(args[1])
				b, _ := json.MarshalIndent(result, "", "  ")
				os.WriteFile(out, b, 0644)
				return "FILE: " + out, nil
			}
			return formatResult(result), nil
		},
	})

	def(browserCmdDef{
		use: "exec <文件>", short: "从文件执行 JS",
		argsMin: 1, argsMax: 1,
		run: func(args []string) (interface{}, error) {
			path := resolvePath(args[0])
			b, err := os.ReadFile(path)
			if err != nil {
				return nil, fmt.Errorf("读取文件失败: %w", err)
			}
			code := string(b)
			result, err := ws.SendEval(code, 30*time.Second)
			if err != nil {
				return nil, err
			}
			return formatResult(result), nil
		},
	})

	def(browserCmdDef{
		use: "screenshot [文件]", short: "截图",
		argsMin: 0, argsMax: 1,
		run: func(args []string) (interface{}, error) {
			result, err := ws.SendCDP("Page.captureScreenshot", map[string]interface{}{"format": "png"})
			if err != nil {
				return nil, err
			}
			m, _ := result.(map[string]interface{})
			if m == nil || m["data"] == nil {
				return nil, fmt.Errorf("截图失败")
			}
			dataStr, _ := m["data"].(string)
			if dataStr == "" {
				return nil, fmt.Errorf("截图数据为空")
			}
			out := fmt.Sprintf("screenshot-%d.png", time.Now().UnixMilli())
			if len(args) == 1 {
				out = args[0]
			}
			decoded, err := ws.DecodeBase64(dataStr)
			if err != nil {
				return nil, fmt.Errorf("解码失败: %w", err)
			}
			fullPath := resolvePath(out)
			os.WriteFile(fullPath, decoded, 0644)
			return "FILE: " + fullPath, nil
		},
	})

	def(browserCmdDef{
		use: "click <选择器>", short: "点击元素",
		argsMin: 1, argsMax: 1,
		run: func(args []string) (interface{}, error) {
			ws.SendEval(fmt.Sprintf("document.querySelector('%s')?.click()", escapeJSStr(args[0])), 10*time.Second)
			return "CLICK: " + args[0], nil
		},
	})

	def(browserCmdDef{
		use: "fill <选择器> <文本>", short: "输入文本（先 focus 再 CDP insertText）",
		argsMin: 2, argsMax: 2,
		run: func(args []string) (interface{}, error) {
			sel := escapeJSStr(args[0])
			text := args[1]
			// 先 focus 元素，清空原有内容
			ws.SendEval(fmt.Sprintf(`(function(){const e=document.querySelector('%s');if(!e)return;e.focus();e.select();})()`, sel), 5*time.Second)
			// 用 CDP Input.insertText 插入真实文本（触发原生 input 事件）
			ws.SendCDP("Input.insertText", map[string]interface{}{"text": text}, 10*time.Second)
			return "FILL: " + args[0] + " = " + args[1], nil
		},
	})

	def(browserCmdDef{
		use: "wait <毫秒>", short: "等待指定时间",
		argsMin: 1, argsMax: 1,
		run: func(args []string) (interface{}, error) {
			ms, _ := strconv.Atoi(args[0])
			if ms <= 0 {
				ms = 1000
			}
			time.Sleep(time.Duration(ms) * time.Millisecond)
			return nil, nil
		},
	})

	def(browserCmdDef{
		use: "waitfor <选择器> [超时ms]", short: "等待元素出现",
		argsMin: 1, argsMax: 2,
		run: func(args []string) (interface{}, error) {
			sel := escapeJSStr(args[0])
			timeoutMs := 10000
			if len(args) == 2 {
				if t, err := strconv.Atoi(args[1]); err == nil && t > 0 {
					timeoutMs = t
				}
			}
			code := fmt.Sprintf(`(function(){return new Promise((resolve,reject)=>{const el=document.querySelector('%[1]s');if(el)return resolve(true);const timer=setTimeout(()=>reject(new Error('timeout')),%[2]d);new MutationObserver((m,obs)=>{if(document.querySelector('%[1]s')){clearTimeout(timer);obs.disconnect();resolve(true)}}).observe(document.body,{childList:true,subtree:true})})})()`, sel, timeoutMs)
			_, err := ws.SendEval(code, time.Duration(timeoutMs+2000)*time.Millisecond)
			if err != nil {
				return "TIMEOUT: " + args[0], nil
			}
			return "FOUND: " + args[0], nil
		},
	})

	def(browserCmdDef{
		use: "scroll <像素>", short: "滚动页面",
		argsMin: 1, argsMax: 1,
		run: func(args []string) (interface{}, error) {
			ws.SendEval(fmt.Sprintf("window.scrollBy(0, %s)", args[0]), 5*time.Second)
			return "SCROLL: " + args[0], nil
		},
	})

	def(browserCmdDef{
		use: "reload", short: "刷新页面",
		argsMin: 0, argsMax: 0,
		run: func(args []string) (interface{}, error) {
			ws.SendCDP("Page.reload", nil)
			time.Sleep(1500 * time.Millisecond)
			return "RELOAD: ok", nil
		},
	})

	def(browserCmdDef{
		use: "text <选择器>", short: "获取元素文本",
		argsMin: 1, argsMax: 1,
		run: func(args []string) (interface{}, error) {
			return ws.SendEval(fmt.Sprintf("document.querySelector('%s')?.textContent?.trim()||''", escapeJSStr(args[0])), 10*time.Second)
		},
	})

	def(browserCmdDef{
		use: "html <选择器>", short: "获取元素 HTML",
		argsMin: 1, argsMax: 1,
		run: func(args []string) (interface{}, error) {
			return ws.SendEval(fmt.Sprintf("document.querySelector('%s')?.outerHTML||''", escapeJSStr(args[0])), 10*time.Second)
		},
	})

	def(browserCmdDef{
		use: "attr <选择器> <属性>", short: "取元素属性值",
		argsMin: 2, argsMax: 2,
		run: func(args []string) (interface{}, error) {
			return ws.SendEval(fmt.Sprintf("document.querySelector('%s')?.getAttribute('%s')||''", escapeJSStr(args[0]), escapeJSStr(args[1])), 10*time.Second)
		},
	})

	def(browserCmdDef{
		use: "count <选择器>", short: "统计匹配元素数量",
		argsMin: 1, argsMax: 1,
		run: func(args []string) (interface{}, error) {
			return ws.SendEval(fmt.Sprintf("document.querySelectorAll('%s').length", escapeJSStr(args[0])), 10*time.Second)
		},
	})

	def(browserCmdDef{
		use: "css <选择器> [@属性|html]", short: "批量取元素（默认 textContent）",
		argsMin: 1, argsMax: 2,
		run: func(args []string) (interface{}, error) {
			sel := escapeJSStr(args[0])
			var code string
			if len(args) == 2 {
				if strings.HasPrefix(args[1], "@") {
					attr := escapeJSStr(args[1][1:])
					code = fmt.Sprintf("JSON.stringify(Array.from(document.querySelectorAll('%s'),e=>e.getAttribute('%s')||''))", sel, attr)
				} else if args[1] == "html" {
					code = fmt.Sprintf("JSON.stringify(Array.from(document.querySelectorAll('%s'),e=>e.outerHTML))", sel)
				} else {
					code = fmt.Sprintf("JSON.stringify(Array.from(document.querySelectorAll('%s'),e=>e.textContent?.trim()||''))", sel)
				}
			} else {
				code = fmt.Sprintf("JSON.stringify(Array.from(document.querySelectorAll('%s'),e=>e.textContent?.trim()||''))", sel)
			}
			raw, err := ws.SendEval(code, 15*time.Second)
			if err != nil {
				return nil, err
			}
			var result []interface{}
			if s, ok := raw.(string); ok && s != "" {
				json.Unmarshal([]byte(s), &result)
			}
			if result == nil {
				result = []interface{}{}
			}
			return result, nil
		},
	})

	def(browserCmdDef{
		use: "hover <选择器>", short: "鼠标悬停",
		argsMin: 1, argsMax: 1,
		run: func(args []string) (interface{}, error) {
			sel := escapeJSStr(args[0])
			code := fmt.Sprintf(`(function(){const e=document.querySelector('%s');if(!e)return;const rect=e.getBoundingClientRect();['mouseenter','mouseover','mousemove'].forEach(t=>e.dispatchEvent(new MouseEvent(t,{bubbles:true,clientX:rect.x+rect.width/2,clientY:rect.y+rect.height/2})));})()`, sel)
			ws.SendEval(code, 10*time.Second)
			return "HOVER: " + args[0], nil
		},
	})

	def(browserCmdDef{
		use: "select <选择器> <值>", short: "选择下拉框的值",
		argsMin: 2, argsMax: 2,
		run: func(args []string) (interface{}, error) {
			sel := escapeJSStr(args[0])
			val := escapeJSStr(args[1])
			code := fmt.Sprintf(`(function(){const e=document.querySelector('%s');if(!e)return;e.value='%s';e.dispatchEvent(new Event('change',{bubbles:true}));})()`, sel, val)
			ws.SendEval(code, 10*time.Second)
			return "SELECT: " + args[0] + " = " + args[1], nil
		},
	})

	def(browserCmdDef{
		use: "key <按键>", short: "模拟键盘按键（Enter/Escape/Tab/方向键等）",
		argsMin: 1, argsMax: 1,
		run: func(args []string) (interface{}, error) {
			key := args[0]
			vk := keyCodeVK(key)
			codeName := keyCodeName(key)
			p := map[string]interface{}{
				"type":                  "rawKeyDown",
				"windowsVirtualKeyCode": vk,
				"key":                   key,
				"code":                  codeName,
			}
			ws.SendCDP("Input.dispatchKeyEvent", p, 5*time.Second)

			// 文本类按键发送 char 事件
			if text, ok := keyCharMap[key]; ok {
				ws.SendCDP("Input.dispatchKeyEvent", map[string]interface{}{
					"type": "char",
					"text": text,
					"key":  key,
					"code": codeName,
				}, 5*time.Second)
			}

			ws.SendCDP("Input.dispatchKeyEvent", map[string]interface{}{
				"type":                  "keyUp",
				"windowsVirtualKeyCode": vk,
				"key":                   key,
				"code":                  codeName,
			}, 5*time.Second)
			return "KEY: " + args[0], nil
		},
	})

	def(browserCmdDef{
		use: "new-tab [url]", short: "新建标签页",
		argsMin: 0, argsMax: 1,
		run: func(args []string) (interface{}, error) {
			targetURL := "about:blank"
			if len(args) == 1 {
				targetURL = args[0]
			}
			result, err := ws.SendCDP("Target.createTarget", map[string]interface{}{"url": targetURL})
			if err != nil {
				return nil, err
			}
			m, _ := result.(map[string]interface{})
			tid := ""
			if m != nil {
				tid, _ = m["targetId"].(string)
			}
			return "NEW-TAB: " + tid, nil
		},
	})

	def(browserCmdDef{
		use: "switch-tab <索引>", short: "切换标签页（从 0 开始）",
		argsMin: 1, argsMax: 1,
		run: func(args []string) (interface{}, error) {
			idx, _ := strconv.Atoi(args[0])
			code := fmt.Sprintf(`(async()=>{const tabs=await chrome.tabs.query({});if(tabs[%d])await chrome.tabs.update(tabs[%d].id,{active:true});return 'ok'})()`, idx, idx)
			result, err := ws.SendEval(code, 10*time.Second)
			if err != nil {
				return nil, err
			}
			return "SWITCH-TAB: " + fmt.Sprint(result), nil
		},
	})

	def(browserCmdDef{
		use: "close-tab", short: "关闭当前标签页",
		argsMin: 0, argsMax: 0,
		run: func(args []string) (interface{}, error) {
			ws.SendEval("(async()=>{const tab=await chrome.tabs.query({active:true,currentWindow:true});if(tab[0])await chrome.tabs.remove(tab[0].id);return 'ok'})()", 10*time.Second)
			return "CLOSE-TAB: ok", nil
		},
	})

	def(browserCmdDef{
		use: "wait-response <pattern> [超时ms]", short: "等待匹配的网络请求完成",
		argsMin: 1, argsMax: 2,
		run: func(args []string) (interface{}, error) {
			pattern := args[0]
			timeoutMs := 15000
			if len(args) == 2 {
				if t, err := strconv.Atoi(args[1]); err == nil && t > 0 {
					timeoutMs = t
				}
			}
			code := fmt.Sprintf(`(async()=>{return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('timeout')),%d);chrome.debugger.onEvent.addListener(function listener(src,method,params){if(method==='Network.responseReceived'&&params.response.url.includes('%s')){clearTimeout(timer);chrome.debugger.onEvent.removeListener(listener);resolve(params.response.url)}});})})()`, timeoutMs, pattern)
			result, err := ws.SendEval(code, time.Duration(timeoutMs+5000)*time.Millisecond)
			if err != nil {
				return nil, fmt.Errorf("wait-response 超时 (%s)", pattern)
			}
			return "RESPONSE: " + fmt.Sprint(result), nil
		},
	})
}

// ---- 辅助函数 ----

// keyCodeVK 返回按键的 Windows 虚拟键码
func keyCodeVK(key string) int {
	m := map[string]int{
		"Enter": 13, "Escape": 27, "Tab": 9, "Backspace": 8,
		"Delete": 46, "Home": 36, "End": 35,
		" ": 32, "ArrowUp": 38, "ArrowDown": 40,
		"ArrowLeft": 37, "ArrowRight": 39,
	}
	if v, ok := m[key]; ok {
		return v
	}
	if len(key) == 1 {
		return int(key[0])
	}
	return 0
}

// keyCodeName 返回按键的 code 名称
func keyCodeName(key string) string {
	m := map[string]string{
		"Enter": "Enter", "Escape": "Escape", "Tab": "Tab",
		"Backspace": "Backspace", "Delete": "Delete",
		"Home": "Home", "End": "End",
		" ": "Space",
		"ArrowUp": "ArrowUp", "ArrowDown": "ArrowDown",
		"ArrowLeft": "ArrowLeft", "ArrowRight": "ArrowRight",
	}
	if v, ok := m[key]; ok {
		return v
	}
	return "Key" + key
}

// keyCharMap 需要额外发送 char 事件的按键
var keyCharMap = map[string]string{
	"Enter": "\r",
	" ":     " ",
}

func escapeJSStr(s string) string {
	s = strings.ReplaceAll(s, "\\", "\\\\")
	s = strings.ReplaceAll(s, "'", "\\'")
	s = strings.ReplaceAll(s, "\n", "\\n")
	s = strings.ReplaceAll(s, "\r", "\\r")
	return s
}

func resolvePath(p string) string {
	if filepath.IsAbs(p) {
		return p
	}
	cwd, _ := os.Getwd()
	return filepath.Join(cwd, p)
}

func formatResult(v interface{}) string {
	if v == nil {
		return "(empty)"
	}
	switch val := v.(type) {
	case string:
		if val == "" {
			return "(empty)"
		}
		return val
	case float64:
		return strconv.FormatFloat(val, 'f', -1, 64)
	default:
		b, _ := json.MarshalIndent(v, "", "  ")
		return string(b)
	}
}
