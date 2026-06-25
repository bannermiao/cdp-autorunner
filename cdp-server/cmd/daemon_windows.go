//go:build windows

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
		HideWindow:    true,
		CreationFlags: 0x00000008, // DETACHED_PROCESS
	}
	return proc
}

func isRunning(pid int) bool {
	handle, err := syscall.OpenProcess(syscall.PROCESS_QUERY_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	syscall.CloseHandle(handle)
	return true
}
