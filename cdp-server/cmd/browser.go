package cmd

import (
	"encoding/json"
	"fmt"
	"net/url"
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
			// 走扩展端 newTab action（chrome.tabs.create + getTargets），
			// 不碰 sharedTab/attachedTab 单例，支持并发 new-tab
			data, err := ws.SendExt("newTab", map[string]interface{}{"url": targetURL}, 15*time.Second)
			if err != nil {
				return nil, err
			}
			m, _ := data.(map[string]interface{})
			tid := ""
			if m != nil {
				tid, _ = m["targetId"].(string)
			}
			return "NEW-TAB: " + tid, nil
		},
	})

	def(browserCmdDef{
		use: "goto-target <targetId> <url>", short: "在指定 target 上导航",
		argsMin: 2, argsMax: 2,
		run: func(args []string) (interface{}, error) {
			targetID, url := args[0], args[1]
			_, err := ws.SendExt("cdpOnTarget", map[string]interface{}{
				"targetId": targetID,
				"method":   "Page.navigate",
				"params":   map[string]interface{}{"url": url},
			}, 30*time.Second)
			if err != nil {
				return nil, err
			}
			// 轮询页面标题，最多等 10 秒
			titleStr := ""
			for i := 0; i < 20; i++ {
				time.Sleep(500 * time.Millisecond)
				t, err := ws.SendExt("evalOnTarget", map[string]interface{}{
					"targetId":   targetID,
					"expression": "document.title",
				}, 5*time.Second)
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
		use: "eval-target <targetId> <code> [文件]", short: "在指定 target 上执行 JS",
		argsMin: 2, argsMax: 3,
		run: func(args []string) (interface{}, error) {
			targetID, code := args[0], args[1]
			result, err := ws.SendExt("evalOnTarget", map[string]interface{}{
				"targetId":   targetID,
				"expression": code,
			}, 30*time.Second)
			if err != nil {
				return nil, err
			}
			if len(args) == 3 {
				out := resolvePath(args[2])
				b, _ := json.MarshalIndent(result, "", "  ")
				os.WriteFile(out, b, 0644)
				return "FILE: " + out, nil
			}
			return formatResult(result), nil
		},
	})

	def(browserCmdDef{
		use: "waitfor-target <targetId> <选择器> [超时ms]", short: "在指定 target 上等待元素出现",
		argsMin: 2, argsMax: 3,
		run: func(args []string) (interface{}, error) {
			targetID, sel := args[0], escapeJSStr(args[1])
			timeoutMs := 10000
			if len(args) == 3 {
				if t, err := strconv.Atoi(args[2]); err == nil && t > 0 {
					timeoutMs = t
				}
			}
			code := fmt.Sprintf(`(function(){return new Promise((resolve,reject)=>{const el=document.querySelector('%[1]s');if(el)return resolve(true);const timer=setTimeout(()=>reject(new Error('timeout')),%[2]d);new MutationObserver((m,obs)=>{if(document.querySelector('%[1]s')){clearTimeout(timer);obs.disconnect();resolve(true)}}).observe(document.body,{childList:true,subtree:true})})})()`, sel, timeoutMs)
			_, err := ws.SendExt("evalOnTarget", map[string]interface{}{
				"targetId":   targetID,
				"expression": code,
			}, time.Duration(timeoutMs+2000)*time.Millisecond)
			if err != nil {
				return "TIMEOUT: " + args[1], nil
			}
			return "FOUND: " + args[1], nil
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
		use: "close-tab [targetId]", short: "关闭标签页（默认活动标签页，可指定 targetId 精确关闭）",
		argsMin: 0, argsMax: 1,
		run: func(args []string) (interface{}, error) {
			if len(args) >= 1 {
				// 按 targetId 精确关闭（并发安全，扩展端通过 getTargets 反查 tabId）
				_, err := ws.SendExt("closeTab", map[string]interface{}{"targetId": args[0]}, 15*time.Second)
				if err != nil {
					return nil, err
				}
				return "CLOSE-TAB: " + args[0], nil
			}
			// 兼容旧行为：关闭当前活动标签页
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

	// ---- frame 子命令 ----
	registerFrameCommands()
}

func registerFrameCommands() {
	// 内存缓存：在同一个 cdp-server 进程生命周期内缓存 targetId
	// 不同 frame 命令之间共享（因为 OOPIF targetId 在页面不变时不变化）
	var cachedTargetId struct {
		src  string
		id   string
	}

	// 从 URL 中提取 host+path 用于匹配（忽略 query/hash 差异）
	urlHostPath := func(rawURL string) string {
		u, err := url.Parse(rawURL)
		if err != nil || u.Host == "" {
			return rawURL
		}
		return u.Host + u.Path
	}

	// 内部辅助：获取 iframe 的 src → 滚动触发加载 → 找到 OOPIF targetId
	resolveTargetId := func(iframeSel string) (string, error) {
		// 1. 获取 iframe src
		srcCode := fmt.Sprintf("document.querySelector('%s')?.src||''", escapeJSStr(iframeSel))
		srcRaw, err := ws.SendEval(srcCode, 10*time.Second)
		if err != nil {
			return "", fmt.Errorf("获取 iframe src 失败: %w", err)
		}
		iframeSrc := fmt.Sprint(srcRaw)
		if iframeSrc == "" {
			return "", fmt.Errorf("未找到 iframe（选择器: %s）", iframeSel)
		}

		// 检查缓存
		if cachedTargetId.src == iframeSrc && cachedTargetId.id != "" {
			return cachedTargetId.id, nil
		}

		// 2. 先尝试同域路径：父页面直接访问 contentDocument
		// 同域 iframe 没有 OOPIF，但父页可直接操作其 DOM
		checkCode := fmt.Sprintf(`(function(){try{var d=document.querySelector('%s').contentDocument;return d?'SAME_ORIGIN':'NO_DOC'}catch(e){return 'CROSS_ORIGIN'}})()`, escapeJSStr(iframeSel))
		originCheck, _ := ws.SendEval(checkCode, 5*time.Second)
		if fmt.Sprint(originCheck) == "SAME_ORIGIN" {
			// 同域：用 "SAME_ORIGIN:" + iframeSel 作为标记
			return "SAME_ORIGIN:" + iframeSel, nil
		}

		// 3. 跨域路径：滚动触发 + 轮询 OOPIF target
		loadCode := fmt.Sprintf(`(function(){var f=document.querySelector('%s');if(!f)return;f.scrollIntoView({block:'center'});f.removeAttribute('loading');})()`, escapeJSStr(iframeSel))
		ws.SendEval(loadCode, 5*time.Second)

		// 提取 host+path 用于匹配
		targetHostPath := urlHostPath(iframeSrc)

		// 3. 轮询 OOPIF target（最多等 15 秒）
		for i := 0; i < 30; i++ {
			time.Sleep(500 * time.Millisecond)
			targetsRaw, err := ws.SendExt("getTargets", nil, 10*time.Second)
			if err != nil {
				continue
			}
			targetsList, ok := targetsRaw.([]interface{})
			if !ok {
				continue
			}
			for _, t := range targetsList {
				tmap, ok := t.(map[string]interface{})
				if !ok {
					continue
				}
				urlRaw, _ := tmap["url"].(string)
				if urlRaw == "" {
					continue
				}
				// 用 host+path 匹配（忽略 query string 差异）
				if urlHostPath(urlRaw) == targetHostPath ||
					strings.Contains(urlHostPath(urlRaw), urlHostPath(iframeSrc)) {
					if tid, ok := tmap["id"].(string); ok && tid != "" {
						cachedTargetId.src = iframeSrc
						cachedTargetId.id = tid
						return tid, nil
					}
				}
			}
		}
		return "", fmt.Errorf("OOPIF target 未找到（iframe: %s）", iframeSrc)
	}

	// 构造 frame 子命令
	frameCmd := &cobra.Command{
		Use:   "frame <iframe选择器> <子命令> [args...]",
		Short: "在 iframe 中执行操作（支持跨域 OOPIF）",
		Long: `子命令:
  eval <code>             执行 JS 表达式
  text <选择器>            获取元素文本
  html <选择器>            获取元素 HTML
  click <选择器>           点击元素
  fill <选择器> <文本>     输入文本
  css <选择器> [@属性|html] 批量获取元素`,
		Run: func(cmd *cobra.Command, args []string) {
			if len(args) < 2 {
				cmd.Help()
				return
			}
			iframeSel := args[0]
			subCmd := args[1]
			subArgs := args[2:]

			targetId, err := resolveTargetId(iframeSel)
			if err != nil {
				fmt.Fprintln(os.Stderr, "ERROR:", err)
				os.Exit(1)
			}

			// 判断是同域还是跨域
			isSameOrigin := strings.HasPrefix(targetId, "SAME_ORIGIN:")
			var iframeDocPrefix string
			if isSameOrigin {
				// 同域：用 contentDocument 访问
				iframeDocPrefix = fmt.Sprintf("document.querySelector('%s').contentDocument.", escapeJSStr(iframeSel))
			}

			// 执行 frame 内 JS，统一封装
			// 同域用 SendEval（父页面上下文），跨域用 SendExt（OOPIF 上下文）
			frameEval := func(expression string, timeout time.Duration) (interface{}, error) {
				if isSameOrigin {
					// 替换 expression 中的 "document." 为 contentDocument 前缀
					// 例如: document.querySelector('.a') → contentDocument.querySelector('.a')
					wrapped := strings.Replace(expression, "document.", iframeDocPrefix, 1)
					return ws.SendEval(wrapped, timeout)
				}
				return ws.SendExt("evalOnTarget", map[string]interface{}{
					"targetId":   targetId,
					"expression": expression,
				}, timeout)
			}

			// 根据子命令分发
			var result interface{}
			switch subCmd {
			case "eval":
				if len(subArgs) < 1 {
					fmt.Fprintln(os.Stderr, "ERROR: frame eval 需要 JS 代码参数")
					os.Exit(1)
				}
				result, err = frameEval(subArgs[0], 30*time.Second)

			case "text":
				if len(subArgs) < 1 {
					fmt.Fprintln(os.Stderr, "ERROR: frame text 需要选择器参数")
					os.Exit(1)
				}
				sel := escapeJSStr(subArgs[0])
				if isSameOrigin {
					result, err = frameEval(fmt.Sprintf("document.querySelector('%s')?.textContent?.trim()||''", sel), 15*time.Second)
				} else {
					result, err = frameEval(fmt.Sprintf("document.querySelector('%s')?.textContent?.trim()||''", sel), 15*time.Second)
				}

			case "html":
				if len(subArgs) < 1 {
					fmt.Fprintln(os.Stderr, "ERROR: frame html 需要选择器参数")
					os.Exit(1)
				}
				sel := escapeJSStr(subArgs[0])
				result, err = frameEval(fmt.Sprintf("document.querySelector('%s')?.outerHTML||''", sel), 15*time.Second)

			case "click":
				if len(subArgs) < 1 {
					fmt.Fprintln(os.Stderr, "ERROR: frame click 需要选择器参数")
					os.Exit(1)
				}
				sel := escapeJSStr(subArgs[0])
				expression := fmt.Sprintf("(function(){var e=document.querySelector('%s');if(!e)return 'NOT_FOUND';e.click();return 'OK'})()", sel)
				clickResult, clickErr := frameEval(expression, 15*time.Second)
				err = clickErr
				if err == nil && fmt.Sprint(clickResult) == "NOT_FOUND" {
					err = fmt.Errorf("元素未找到: %s", subArgs[0])
				} else {
					result = "CLICK: " + subArgs[0]
				}

			case "fill":
				if len(subArgs) < 2 {
					fmt.Fprintln(os.Stderr, "ERROR: frame fill 需要选择器和文本参数")
					os.Exit(1)
				}
				sel := escapeJSStr(subArgs[0])
				text := subArgs[1]
				if isSameOrigin {
					// 同域 fill：直接用 exec 操作
					frameEval(fmt.Sprintf(`(function(){var e=document.querySelector('%s');if(!e)return;e.focus();e.value='%s';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`, sel, escapeJSStr(text)), 15*time.Second)
				} else {
					// 跨域 fill：focus + CDP insertText
					frameEval(fmt.Sprintf(`(function(){var e=document.querySelector('%s');if(!e)return;e.focus();e.select();})()`, sel), 10*time.Second)
					_, err = ws.SendExt("cdpOnTarget", map[string]interface{}{
						"targetId": targetId,
						"method":   "Input.insertText",
						"params":   map[string]interface{}{"text": text},
					}, 15*time.Second)
				}
				result = "FILL: " + subArgs[0] + " = " + subArgs[1]

			case "css":
				if len(subArgs) < 1 {
					fmt.Fprintln(os.Stderr, "ERROR: frame css 需要选择器参数")
					os.Exit(1)
				}
				sel := escapeJSStr(subArgs[0])
				var expression string
				if len(subArgs) == 2 {
					if strings.HasPrefix(subArgs[1], "@") {
						attr := escapeJSStr(subArgs[1][1:])
						expression = fmt.Sprintf("JSON.stringify(Array.from(document.querySelectorAll('%s'),e=>e.getAttribute('%s')||''))", sel, attr)
					} else if subArgs[1] == "html" {
						expression = fmt.Sprintf("JSON.stringify(Array.from(document.querySelectorAll('%s'),e=>e.outerHTML))", sel)
					} else {
						expression = fmt.Sprintf("JSON.stringify(Array.from(document.querySelectorAll('%s'),e=>e.textContent?.trim()||''))", sel)
					}
				} else {
					expression = fmt.Sprintf("JSON.stringify(Array.from(document.querySelectorAll('%s'),e=>e.textContent?.trim()||''))", sel)
				}
				result, err = frameEval(expression, 15*time.Second)
				if err == nil {
					var parsed []interface{}
					if s, ok := result.(string); ok && s != "" {
						json.Unmarshal([]byte(s), &parsed)
					}
					if parsed == nil {
						parsed = []interface{}{}
					}
					result = parsed
				}

			default:
				err = fmt.Errorf("未知的 frame 子命令: %s（支持: eval/text/html/click/fill/css）", subCmd)
			}

			if err != nil {
				fmt.Fprintln(os.Stderr, "ERROR:", err)
				os.Exit(1)
			}
			if result != nil {
				switch v := result.(type) {
				case string:
					if v == "" {
						fmt.Println("(empty)")
					} else {
						fmt.Println(v)
					}
				default:
					b, _ := json.MarshalIndent(v, "", "  ")
					fmt.Println(string(b))
				}
			}
		},
	}
	browserCmd.AddCommand(frameCmd)
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
