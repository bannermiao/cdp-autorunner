//go:build !windows

package cmd

import (
	"os"
	"os/exec"
	"syscall"
)

func startDaemon() *exec.Cmd {
	self, _ := os.Executable()
	proc := exec.Command(self, "daemon")
	proc.SysProcAttr = &syscall.SysProcAttr{
		Setpgid: true,
	}
	return proc
}

func isRunning(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = p.Signal(syscall.Signal(0))
	return err == nil
}
