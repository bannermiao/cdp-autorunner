package cmd

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"
)

const (
	Port  = 18765
	WsURL = "ws://127.0.0.1:18765"
)

var daemonCmd = &cobra.Command{
	Use:   "daemon",
	Short: "后台 WS 中继服务（内部命令）",
}

var startCmd = &cobra.Command{
	Use:   "start",
	Short: "启动 daemon",
	Run: func(cmd *cobra.Command, args []string) {
		// 以端口探活为准，而不是 pid 文件。进程被强杀（或被杀毒/沙箱回收）时
		// pid 文件会残留，而 PID 又可能被系统回收给别的进程 —— 只信 pid 文件
		// 会让 start 误判「已在运行」并直接返回，后续所有命令全部失败。
		if daemonAlive() {
			printRunning("daemon 已在运行")
			return
		}
		cleanPid() // 清掉上一次被强杀留下的脏 pid

		proc := startDaemon()
		if err := proc.Start(); err != nil {
			fmt.Fprintln(os.Stderr, "启动 daemon 失败:", err)
			os.Exit(1)
		}
		if err := proc.Process.Release(); err != nil {
			fmt.Fprintln(os.Stderr, "释放进程句柄失败:", err)
			os.Exit(1)
		}

		waited := 0
		for {
			time.Sleep(200 * time.Millisecond)
			waited += 200
			if daemonAlive() {
				fmt.Printf("CDP Bridge daemon 已启动 (PID: %d)\n", readPid())
				fmt.Printf("  WS: ws://127.0.0.1:%d\n", Port)
				return
			}
			if waited > 5000 {
				fmt.Printf("启动失败：端口 %d 无响应（可能被占用）\n", Port)
				os.Exit(1)
			}
		}
	},
}

var stopCmd = &cobra.Command{
	Use:   "stop",
	Short: "停止 daemon",
	Run: func(cmd *cobra.Command, args []string) {
		pid := readPid()
		if pid <= 0 && !daemonAlive() {
			fmt.Println("daemon 未在运行")
			return
		}
		// 先尝试 HTTP 优雅关闭
		resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/shutdown", Port))
		if err == nil {
			resp.Body.Close()
		}
		if pid <= 0 {
			cleanPid()
			fmt.Println("daemon 已停止")
			return
		}
		p, err := os.FindProcess(pid)
		if err != nil {
			cleanPid()
			fmt.Printf("daemon 已停止 (PID: %d)\n", pid)
			return
		}
		p.Signal(os.Signal(syscall.SIGTERM))
		cleanPid()
		fmt.Printf("daemon 已停止 (PID: %d)\n", pid)
	},
}

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "查询 daemon 运行状态",
	Run: func(cmd *cobra.Command, args []string) {
		if daemonAlive() {
			printRunning("daemon 正在运行")
			return
		}
		if pid := readPid(); pid > 0 && isRunning(pid) {
			fmt.Printf("daemon 进程还在 (PID: %d)，但端口 %d 无响应 —— 建议 restart\n", pid, Port)
			os.Exit(1)
		}
		fmt.Println("daemon 未在运行")
		os.Exit(1)
	},
}

var restartCmd = &cobra.Command{
	Use:   "restart",
	Short: "重启 daemon",
	Run: func(cmd *cobra.Command, args []string) {
		stopCmd.Run(cmd, args)
		time.Sleep(500 * time.Millisecond)
		startCmd.Run(cmd, args)
	},
}

// daemonAlive 用端口探活判断 daemon 是否真的在服务（daemon 自己会在该端口回 "ok"）。
func daemonAlive() bool {
	c := &http.Client{Timeout: 800 * time.Millisecond}
	resp, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d", Port))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 32))
	return resp.StatusCode == http.StatusOK && strings.Contains(string(body), "ok")
}

func printRunning(prefix string) {
	if pid := readPid(); pid > 0 {
		fmt.Printf("%s (PID: %d)\n", prefix, pid)
		return
	}
	fmt.Println(prefix)
}

func pidFilePath() string {
	exe, err := os.Executable()
	if err != nil {
		return ".cdp-server.pid"
	}
	return filepath.Join(filepath.Dir(exe), ".cdp-server.pid")
}

func writePid() {
	os.WriteFile(pidFilePath(), []byte(strconv.Itoa(os.Getpid())), 0644)
}

func readPid() int {
	data, err := os.ReadFile(pidFilePath())
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return 0
	}
	return pid
}

func cleanPid() {
	os.Remove(pidFilePath())
}
