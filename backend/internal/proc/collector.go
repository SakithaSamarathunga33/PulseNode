package proc

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Snapshot struct {
	CPU       float64   `json:"cpu"`
	CPUCores  []float64 `json:"cpuCores"`
	RAM       float64   `json:"ram"`
	Disk      float64   `json:"disk"`
	DiskRead  float64   `json:"diskRead"`
	DiskWrite float64   `json:"diskWrite"`
	NetIn     float64   `json:"netIn"`
	NetOut    float64   `json:"netOut"`
	TS        int64     `json:"ts"`
}

type Process struct {
	PID    int     `json:"pid"`
	Name   string  `json:"name"`
	CPU    float64 `json:"cpu"`
	MemMB  float64 `json:"mem_mb"`
	Status string  `json:"status"`
	User   string  `json:"user"`
	Cmd    string  `json:"cmd"`
	Type   string  `json:"type"`
}

type Collector struct {
	mu       sync.RWMutex
	max      int
	interval time.Duration
	history  []Snapshot
	prevCPU  cpuTimes
	prevNet  counters
	prevDisk counters

	procMu     sync.Mutex
	prevProc   map[int]uint64 // pid -> utime+stime ticks, from the last Processes() call
	prevProcAt time.Time
}

// clockTicksPerSec is USER_HZ, the unit /proc/[pid]/stat's utime/stime fields
// are counted in. It's been 100 on virtually every Linux system for decades,
// so it's hardcoded rather than pulled in via cgo's sysconf(_SC_CLK_TCK).
const clockTicksPerSec = 100

type cpuTimes struct {
	total uint64
	idle  uint64
}

type counters struct {
	a  uint64
	b  uint64
	ts time.Time
}

func NewCollector(max int, interval time.Duration) *Collector {
	if max <= 0 {
		max = 60
	}
	return &Collector{max: max, interval: interval}
}

func (c *Collector) Start(ctx context.Context) {
	c.sample()
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.sample()
		}
	}
}

func (c *Collector) Live() Snapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if len(c.history) == 0 {
		return Snapshot{TS: time.Now().UnixMilli()}
	}
	return c.history[len(c.history)-1]
}

func (c *Collector) History() []Snapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]Snapshot, len(c.history))
	copy(out, c.history)
	return out
}

func (c *Collector) Host(apps int) map[string]any {
	mem := memoryPercent()
	disk := diskUsage("/")
	host, _ := os.Hostname()
	return map[string]any{
		"name":   host,
		"distro": distro(),
		"kernel": kernel(),
		"uptime": uptimeText(),
		"cpu": map[string]any{
			"cores": len(cpuCorePercents()),
			"model": cpuModel(),
			"usage": c.Live().CPU,
		},
		"memory": map[string]any{"used": round1(mem.usedGB), "total": round1(mem.totalGB), "unit": "GB", "pct": round1(mem.percent)},
		"disk":   map[string]any{"used": disk.usedGB, "total": disk.totalGB, "free": disk.freeGB, "unit": "GB", "pct": disk.percent},
		"swap":   swapUsage(),
		"network": map[string]any{
			"rx":   c.Live().NetIn,
			"tx":   c.Live().NetOut,
			"unit": "KB/s",
		},
		"load":   loadavg(),
		"apps":   apps,
		"ip":     primaryIP(),
		"region": getenv("VPS_REGION", "-"),
	}
}

func (c *Collector) sample() {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	cpu := readCPU()
	cpuPct := diffPercent(c.prevCPU, cpu)
	c.prevCPU = cpu

	net := readNet()
	netIn, netOut := rateKB(c.prevNet, net)
	net.ts = now
	c.prevNet = net

	diskCounters := readDiskIO()
	diskRead, diskWrite := rateMB(c.prevDisk, diskCounters)
	diskCounters.ts = now
	c.prevDisk = diskCounters

	disk := diskUsage("/")
	snap := Snapshot{
		CPU: round1(cpuPct), CPUCores: cpuCorePercents(), RAM: round1(memoryPercent().percent), Disk: float64(disk.percent),
		DiskRead: round2(diskRead), DiskWrite: round2(diskWrite), NetIn: round1(netIn), NetOut: round1(netOut), TS: now.UnixMilli(),
	}
	if len(c.history) >= c.max {
		c.history = c.history[1:]
	}
	c.history = append(c.history, snap)
}

func (c *Collector) Processes() ([]Process, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}

	c.procMu.Lock()
	defer c.procMu.Unlock()
	now := time.Now()
	elapsed := now.Sub(c.prevProcAt).Seconds()
	prev := c.prevProc
	next := make(map[int]uint64, len(entries))
	cores := len(cpuCorePercents())
	if cores == 0 {
		cores = 1
	}

	out := []Process{}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		stat, err := readProcStat(pid)
		if err != nil {
			continue
		}
		status := readStatus(pid)
		memMB := float64(status.rssKB) / 1024

		ticks := stat.utime + stat.stime
		next[pid] = ticks

		// CPU% normalized against total capacity (all cores), matching how
		// the system-wide CPU number is already framed elsewhere in this app.
		cpu := 0.0
		if prevTicks, ok := prev[pid]; ok && elapsed > 0 && ticks >= prevTicks {
			cpu = float64(ticks-prevTicks) / clockTicksPerSec / elapsed / float64(cores) * 100
		}

		out = append(out, Process{PID: pid, Name: stat.name, CPU: round1(cpu), MemMB: round1(memMB), Status: status.state, User: status.user, Cmd: readCmdline(pid, stat.name), Type: "system"})
	}
	c.prevProc = next
	c.prevProcAt = now
	sort.Slice(out, func(i, j int) bool {
		if out[i].CPU == out[j].CPU {
			return out[i].MemMB > out[j].MemMB
		}
		return out[i].CPU > out[j].CPU
	})
	if len(out) > 30 {
		out = out[:30]
	}
	return out, nil
}

func Signal(pid int, sig os.Signal) error {
	sys, ok := sig.(syscall.Signal)
	if !ok {
		return errors.New("unsupported signal")
	}
	return syscall.Kill(pid, sys)
}

func readCPU() cpuTimes {
	line := firstLine("/proc/stat")
	fields := strings.Fields(line)
	var total uint64
	for _, f := range fields[1:] {
		v, _ := strconv.ParseUint(f, 10, 64)
		total += v
	}
	idle, _ := strconv.ParseUint(fields[4], 10, 64)
	return cpuTimes{total: total, idle: idle}
}

func cpuCorePercents() []float64 {
	file, err := os.Open("/proc/stat")
	if err != nil {
		return []float64{}
	}
	defer file.Close()
	out := []float64{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "cpu") || strings.HasPrefix(line, "cpu ") {
			continue
		}
		out = append(out, 0)
	}
	return out
}

func diffPercent(prev, next cpuTimes) float64 {
	total := next.total - prev.total
	idle := next.idle - prev.idle
	if prev.total == 0 || total == 0 {
		return 0
	}
	return (1 - float64(idle)/float64(total)) * 100
}

// hostNetDev returns the path to net/dev that reflects the host's physical
// interfaces. When running inside Docker with pid:host, /proc/1/net/dev
// is in the host network namespace; /proc/net/dev only shows the veth.
func hostNetDev() string {
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return "/proc/1/net/dev"
	}
	return "/proc/net/dev"
}

func readNet() counters {
	data, err := os.ReadFile(hostNetDev())
	if err != nil {
		return counters{ts: time.Now()}
	}
	var rx, tx uint64
	for _, line := range strings.Split(string(data), "\n")[2:] {
		parts := strings.Fields(strings.ReplaceAll(line, ":", " "))
		if len(parts) < 17 || parts[0] == "lo" {
			continue
		}
		a, _ := strconv.ParseUint(parts[1], 10, 64)
		b, _ := strconv.ParseUint(parts[9], 10, 64)
		rx += a
		tx += b
	}
	return counters{a: rx, b: tx, ts: time.Now()}
}

func readDiskIO() counters {
	data, err := os.ReadFile("/proc/diskstats")
	if err != nil {
		return counters{ts: time.Now()}
	}
	var read, write uint64
	for _, line := range strings.Split(string(data), "\n") {
		parts := strings.Fields(line)
		if len(parts) < 14 {
			continue
		}
		r, _ := strconv.ParseUint(parts[5], 10, 64)
		w, _ := strconv.ParseUint(parts[9], 10, 64)
		read += r * 512
		write += w * 512
	}
	return counters{a: read, b: write, ts: time.Now()}
}

func rateKB(prev, next counters) (float64, float64) {
	if prev.ts.IsZero() {
		return 0, 0
	}
	dt := next.ts.Sub(prev.ts).Seconds()
	if dt <= 0 {
		return 0, 0
	}
	return float64(next.a-prev.a) / dt / 1024, float64(next.b-prev.b) / dt / 1024
}

func rateMB(prev, next counters) (float64, float64) {
	a, b := rateKB(prev, next)
	return a / 1024, b / 1024
}

type memInfo struct {
	usedGB  float64
	totalGB float64
	percent float64
}

func memoryPercent() memInfo {
	total := memoryTotalKB()
	available := readMemValue("MemAvailable")
	if total == 0 {
		return memInfo{}
	}
	used := total - available
	return memInfo{usedGB: float64(used) / 1024 / 1024, totalGB: float64(total) / 1024 / 1024, percent: float64(used) / float64(total) * 100}
}

func memoryTotalKB() uint64 { return readMemValue("MemTotal") }

func readMemValue(key string) uint64 {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, key+":") {
			fields := strings.Fields(line)
			v, _ := strconv.ParseUint(fields[1], 10, 64)
			return v
		}
	}
	return 0
}

type diskInfo struct {
	usedGB  int
	totalGB int
	freeGB  int
	percent int
}

func diskUsage(path string) diskInfo {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return diskInfo{}
	}
	total := stat.Blocks * uint64(stat.Bsize)
	free := stat.Bavail * uint64(stat.Bsize)
	used := total - free
	pct := 0
	if total > 0 {
		pct = int(float64(used) / float64(total) * 100)
	}
	return diskInfo{usedGB: int(used / 1024 / 1024 / 1024), totalGB: int(total / 1024 / 1024 / 1024), freeGB: int(free / 1024 / 1024 / 1024), percent: pct}
}

func swapUsage() map[string]any {
	total := readMemValue("SwapTotal")
	free := readMemValue("SwapFree")
	used := total - free
	pct := 0.0
	if total > 0 {
		pct = float64(used) / float64(total) * 100
	}
	return map[string]any{"used": round1(float64(used) / 1024 / 1024), "total": round1(float64(total) / 1024 / 1024), "pct": round1(pct)}
}

func distro() string {
	data, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return "Linux"
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
		}
	}
	return "Linux"
}

func kernel() string {
	data, err := os.ReadFile("/proc/sys/kernel/osrelease")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func uptimeText() string {
	fields := strings.Fields(firstLine("/proc/uptime"))
	if len(fields) == 0 {
		return "0m"
	}
	seconds, _ := strconv.ParseFloat(fields[0], 64)
	d := int(seconds) / 86400
	h := (int(seconds) % 86400) / 3600
	m := (int(seconds) % 3600) / 60
	parts := []string{}
	if d > 0 {
		parts = append(parts, fmt.Sprintf("%dd", d))
	}
	if h > 0 {
		parts = append(parts, fmt.Sprintf("%dh", h))
	}
	if m > 0 {
		parts = append(parts, fmt.Sprintf("%dm", m))
	}
	if len(parts) == 0 {
		return "0m"
	}
	return strings.Join(parts, " ")
}

func cpuModel() string {
	data, _ := os.ReadFile("/proc/cpuinfo")
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "model name") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				return strings.TrimSpace(parts[1])
			}
		}
	}
	return "Unknown"
}

func primaryIP() string {
	ifaces, _ := net.Interfaces()
	for _, iface := range ifaces {
		if iface.Flags&net.FlagLoopback != 0 || iface.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			if ipnet, ok := addr.(*net.IPNet); ok && ipnet.IP.To4() != nil {
				return ipnet.IP.String()
			}
		}
	}
	return "-"
}

func loadavg() []float64 {
	fields := strings.Fields(firstLine("/proc/loadavg"))
	out := []float64{}
	for i := 0; i < len(fields) && i < 3; i++ {
		v, _ := strconv.ParseFloat(fields[i], 64)
		out = append(out, round2(v))
	}
	return out
}

type procStat struct {
	name         string
	utime, stime uint64
}

func readProcStat(pid int) (procStat, error) {
	line := firstLine(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if line == "" {
		return procStat{}, errors.New("missing stat")
	}
	start := strings.Index(line, "(")
	end := strings.LastIndex(line, ")")
	if start < 0 || end < 0 {
		return procStat{}, errors.New("invalid stat")
	}
	rest := strings.Fields(line[end+2:])
	utime, _ := strconv.ParseUint(rest[11], 10, 64)
	stime, _ := strconv.ParseUint(rest[12], 10, 64)
	return procStat{name: line[start+1 : end], utime: utime, stime: stime}, nil
}

type procStatus struct {
	state string
	user  string
	rssKB uint64
}

func readStatus(pid int) procStatus {
	data, _ := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "status"))
	status := procStatus{state: "unknown"}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		switch fields[0] {
		case "State:":
			status.state = fields[1]
		case "Uid:":
			if u, err := user.LookupId(fields[1]); err == nil {
				status.user = u.Username
			} else {
				status.user = fields[1]
			}
		case "VmRSS:":
			status.rssKB, _ = strconv.ParseUint(fields[1], 10, 64)
		}
	}
	return status
}

func readCmdline(pid int, fallback string) string {
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "cmdline"))
	if err != nil || len(data) == 0 {
		return fallback
	}
	cmd := strings.TrimSpace(strings.ReplaceAll(string(data), "\x00", " "))
	if len(cmd) > 120 {
		return cmd[:120]
	}
	return cmd
}

func firstLine(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.SplitN(string(data), "\n", 2)[0]
}

func getenv(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func round1(v float64) float64 { return float64(int(v*10+0.5)) / 10 }
func round2(v float64) float64 { return float64(int(v*100+0.5)) / 100 }
