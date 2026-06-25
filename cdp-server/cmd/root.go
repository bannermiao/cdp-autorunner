package cmd

import (
	"fmt"
	"os"

	"cdp-server/ws"

	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "cdp-server",
	Short: "CDP Bridge — 浏览器自动化 CLI",
	Long: `通过 Chrome 扩展 WebSocket 桥接，直接控制真实浏览器。
复用已有登录态，绕过反爬检测。

命令分类:
  daemon    管理 WS 中继服务（start/stop/status/restart/daemon）
  browser   浏览器控制命令（goto/eval/click/fill/...）`,
	Run: func(cmd *cobra.Command, args []string) {
		cmd.Help()
	},
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func init() {
	// daemon 命令连接到 ws 包
	daemonCmd.Run = func(cmd *cobra.Command, args []string) {
		writePid()
		ws.RunDaemon(Port)
	}

	rootCmd.AddCommand(daemonCmd)
	rootCmd.AddCommand(startCmd)
	rootCmd.AddCommand(stopCmd)
	rootCmd.AddCommand(statusCmd)
	rootCmd.AddCommand(restartCmd)
	rootCmd.AddCommand(browserCmd)

	rootCmd.AddCommand(&cobra.Command{
		Use:   "version",
		Short: "版本信息",
		Run: func(cmd *cobra.Command, args []string) {
			fmt.Println("cdp-server v1.0.0")
		},
	})
}
