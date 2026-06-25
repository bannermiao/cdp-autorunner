package cmd

import (
	"fmt"
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
		pid := readPid()
		if pid > 0 && isRunning(pid) {
			fmt.Printf("daemon 已在运行 (PID: %d)\n", pid)
			return
		}
		cleanPid()

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
			p := readPid()
			if p > 0 && isRunning(p) {
				fmt.Printf("CDP Bridge daemon 已启动 (PID: %d)\n", p)
				fmt.Printf("  WS: ws://127.0.0.1:%d\n", Port)
				return
			}
			if waited > 5000 {
				fmt.Println("启动失败，端口 18765 可能被占用")
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
		if pid <= 0 {
			fmt.Println("daemon 未在运行")
			return
		}
		// 先尝试 HTTP 优雅关闭
		resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/shutdown", Port))
		if err == nil {
			resp.Body.Close()
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
		pid := readPid()
		if pid > 0 && isRunning(pid) {
			fmt.Printf("daemon 正在运行 (PID: %d)\n", pid)
			return
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
