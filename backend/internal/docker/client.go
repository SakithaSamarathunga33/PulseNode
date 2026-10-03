package docker

import (
	"strconv"
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type Client struct{ http *http.Client }

type portBinding struct { PrivatePort int `json:"PrivatePort"`; PublicPort int `json:"PublicPort"`; Type string `json:"Type"` }

type Container struct { ID string `json:"id"`; Name string `json:"name"`; Image string `json:"image"`; State string `json:"state"`; Uptime string `json:"uptime"`; CPU int `json:"cpu"`; RAM int `json:"ram"`; Ports string `json:"ports"`; Created string `json:"created"`; Node string `json:"node"`; ExitCode int `json:"-"`; OneOff bool `json:"-"` }
type Image struct { Repo string `json:"repo"`; Tag string `json:"tag"`; ID string `json:"id"`; Size string `json:"size"`; Created string `json:"created"`; Used int `json:"used"`; Layers int `json:"layers"`; Vulns map[string]int `json:"vulns"` }
type Network struct { Name string `json:"name"`; Driver string `json:"driver"`; Scope string `json:"scope"`; Subnet string `json:"subnet"`; Gateway string `json:"gateway"`; Containers int `json:"containers"`; Attachable bool `json:"attachable"`; Internal bool `json:"internal"` }
type Database struct { Name string `json:"name"`; ContainerID string `json:"containerId"`; Engine string `json:"engine"`; Version string `json:"version"`; Host string `json:"host"`; Port int `json:"port"`; Size string `json:"size"`; Conns int `json:"conns"`; MaxConns int `json:"maxConns"`; QPS int `json:"qps"`; Slow int `json:"slow"`; State string `json:"state"` }
type Stat struct { ContainerID string `json:"containerId"`; CPU float64 `json:"cpu"`; RAM float64 `json:"ram"` }
type ContainerStat struct { ID string `json:"id"`; Name string `json:"name"`; Image string `json:"image"`; State string `json:"state"`; CPU float64 `json:"cpu"`; RAMPct float64 `json:"ramPct"`; RAMMb float64 `json:"ramMb"`; RAMLimitMb float64 `json:"ramLimitMb"` }
type ContainerLabels struct { ID string; Name string; State string; Labels map[string]string }

func New() (*Client, error) {
	transport := &http.Transport{DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) { return (&net.Dialer{}).DialContext(ctx, "unix", "/var/run/docker.sock") }}
	c := &Client{http: &http.Client{Transport: transport, Timeout: 30 * time.Second}}
	var ping bytes.Buffer
	if err := c.doRaw(context.Background(), http.MethodGet, "/_ping", nil, &ping); err != nil { return nil, err }
	return c, nil
}

func (c *Client) Containers(ctx context.Context) ([]Container, error) {
	var raw []struct { ID string `json:"Id"`; Names []string `json:"Names"`; Image string `json:"Image"`; State string `json:"State"`; Status string `json:"Status"`; Created int64 `json:"Created"`; Ports []portBinding `json:"Ports"`; Labels map[string]string `json:"Labels"` }
	if err := c.do(ctx, http.MethodGet, "/containers/json?all=true", nil, &raw); err != nil { return nil, err }
	out := make([]Container, 0, len(raw))
	for _, item := range raw { name := ""; if len(item.Names)>0 { name = strings.TrimPrefix(item.Names[0], "/") }; out = append(out, Container{ID: shortID(item.ID), Name: name, Image: item.Image, State: item.State, Uptime: item.Status, Ports: formatPorts(item.Ports), Created: time.Unix(item.Created,0).Format("Jan 2"), Node: "primary", ExitCode: exitCodeOf(item.State, item.Status), OneOff: strings.EqualFold(item.Labels["com.docker.compose.oneoff"], "true")}) }
	return out, nil
}

// exitCodeOf reads the exit code from a stopped container's Status ("Exited (0) 3 hours ago"); -1 when unknown or not exited.
var exitedRe = regexp.MustCompile(`^Exited \((-?\d+)\)`)

func exitCodeOf(state, status string) int {
	if state != "exited" { return -1 }
	if m := exitedRe.FindStringSubmatch(status); m != nil { if n, err := strconv.Atoi(m[1]); err == nil { return n } }
	return -1
}

// ContainersWithLabels lists all containers with their raw labels, used for
// discovering Traefik/Caddy domain routing labels.
func (c *Client) ContainersWithLabels(ctx context.Context) ([]ContainerLabels, error) {
	var raw []struct { ID string `json:"Id"`; Names []string `json:"Names"`; State string `json:"State"`; Labels map[string]string `json:"Labels"` }
	if err := c.do(ctx, http.MethodGet, "/containers/json?all=true", nil, &raw); err != nil { return nil, err }
	out := []ContainerLabels{}
	for _, item := range raw { name := ""; if len(item.Names)>0 { name = strings.TrimPrefix(item.Names[0], "/") }; out = append(out, ContainerLabels{ID: shortID(item.ID), Name: name, State: item.State, Labels: item.Labels}) }
	return out, nil
}

func (c *Client) Images(ctx context.Context) ([]Image, error) {
	var raw []struct { ID string `json:"Id"`; RepoTags []string `json:"RepoTags"`; Size int64 `json:"Size"`; Created int64 `json:"Created"` }
	if err := c.do(ctx, http.MethodGet, "/images/json", nil, &raw); err != nil { return nil, err }
	out := make([]Image, 0, len(raw))
	for _, item := range raw { repo, tag := "<none>", "latest"; if len(item.RepoTags)>0 { parts := strings.SplitN(item.RepoTags[0], ":", 2); repo = parts[0]; if len(parts)==2 { tag = parts[1] } }; out = append(out, Image{Repo: repo, Tag: tag, ID: shortID(strings.TrimPrefix(item.ID,"sha256:")), Size: fmt.Sprintf("%d MB", item.Size/1024/1024), Created: time.Unix(item.Created,0).Format("Jan 2"), Vulns: map[string]int{"crit":0,"high":0,"med":0,"low":0}}) }
	return out, nil
}

func (c *Client) Networks(ctx context.Context) ([]Network, error) {
	var raw []struct { Name string `json:"Name"`; Driver string `json:"Driver"`; Scope string `json:"Scope"`; Attachable bool `json:"Attachable"`; Internal bool `json:"Internal"`; Containers map[string]any `json:"Containers"`; IPAM struct{ Config []struct{ Subnet string `json:"Subnet"`; Gateway string `json:"Gateway"` } `json:"Config"` } `json:"IPAM"` }
	if err := c.do(ctx, http.MethodGet, "/networks", nil, &raw); err != nil { return nil, err }
	out := make([]Network, 0, len(raw))
	for _, item := range raw { subnet, gateway := "-", "-"; if len(item.IPAM.Config)>0 { subnet = item.IPAM.Config[0].Subnet; gateway = item.IPAM.Config[0].Gateway }; out = append(out, Network{Name:item.Name, Driver:item.Driver, Scope:item.Scope, Subnet:subnet, Gateway:gateway, Containers:len(item.Containers), Attachable:item.Attachable, Internal:item.Internal}) }
	return out, nil
}

func (c *Client) DatabaseContainers(ctx context.Context) ([]Database, error) { containers, err := c.Containers(ctx); if err != nil { return nil, err }; re := regexp.MustCompile(`(?i)postgres|mysql|mariadb|redis|mongo|clickhouse|cassandra|elasticsearch`); out := []Database{}; for _, ctr := range containers { if !re.MatchString(ctr.Image) { continue }; engine, port, max := dbMeta(ctr.Image); state := "error"; if ctr.State=="running" { state="ok" }; out = append(out, Database{Name:ctr.Name, ContainerID:ctr.ID, Engine:engine, Version:imageVersion(ctr.Image), Host:ctr.Name, Port:port, Size:"-", MaxConns:max, State:state}) }; return out, nil }
func (c *Client) Logs(ctx context.Context, id string, tail int) (string, error) { var buf bytes.Buffer; err := c.doRaw(ctx, http.MethodGet, fmt.Sprintf("/containers/%s/logs?stdout=true&stderr=true&timestamps=true&tail=%d", id, tail), nil, &buf); return cleanDockerStream(buf.Bytes()), err }
func (c *Client) Action(ctx context.Context, id string, action string) error { switch action { case "restart": return c.do(ctx, http.MethodPost, "/containers/"+id+"/restart", nil, nil); case "start": return c.do(ctx, http.MethodPost, "/containers/"+id+"/start", nil, nil); case "stop": return c.do(ctx, http.MethodPost, "/containers/"+id+"/stop", nil, nil); case "remove": return c.do(ctx, http.MethodDelete, "/containers/"+id+"?force=true", nil, nil); default: return fmt.Errorf("unknown docker action %q", action) } }
func (c *Client) Exec(ctx context.Context, id string, cmd string) (string, error) { var created struct{ ID string `json:"Id"` }; if err := c.do(ctx, http.MethodPost, "/containers/"+id+"/exec", map[string]any{"Cmd":[]string{"sh","-c",cmd},"AttachStdout":true,"AttachStderr":true}, &created); err != nil { return "", err }; var buf bytes.Buffer; err := c.doRaw(ctx, http.MethodPost, "/exec/"+created.ID+"/start", map[string]any{"Detach":false,"Tty":false}, &buf); return cleanDockerStream(buf.Bytes()), err }
func (c *Client) PruneBuildCache(ctx context.Context) (uint64, error) { var raw struct{ SpaceReclaimed uint64 `json:"SpaceReclaimed"` }; err := c.do(ctx, http.MethodPost, "/build/prune", map[string]any{}, &raw); return raw.SpaceReclaimed, err }

// ExecSlice runs cmd inside a container by name or ID and returns combined stdout+stderr.
func (c *Client) ExecSlice(ctx context.Context, containerNameOrID string, cmd []string) (string, error) {
	return c.ExecSliceEnv(ctx, containerNameOrID, nil, cmd)
}

// ExecSliceEnv is like ExecSlice but injects additional env vars into the exec (e.g. PGPASSWORD).
func (c *Client) ExecSliceEnv(ctx context.Context, containerNameOrID string, env []string, cmd []string) (string, error) {
	body := map[string]any{"Cmd": cmd, "AttachStdout": true, "AttachStderr": true}
	if len(env) > 0 {
		body["Env"] = env
	}
	var created struct{ ID string `json:"Id"` }
	if err := c.do(ctx, http.MethodPost, "/containers/"+containerNameOrID+"/exec", body, &created); err != nil {
		return "", err
	}
	var buf bytes.Buffer
	err := c.doRaw(ctx, http.MethodPost, "/exec/"+created.ID+"/start", map[string]any{"Detach": false, "Tty": false}, &buf)
	return cleanDockerStream(buf.Bytes()), err
}
// ExecStreamEnv runs cmd in the container (with optional extra env) and copies
// only stdout to dst, stripping Docker's 8-byte multiplexed-stream framing.
// Use this for large dumps (pg_dump, mysqldump, mongodump, redis RDB) where
// buffering the entire output in memory is not acceptable.
func (c *Client) ExecStreamEnv(ctx context.Context, containerNameOrID string, env []string, cmd []string, dst io.Writer) error {
	body := map[string]any{"Cmd": cmd, "AttachStdout": true, "AttachStderr": true}
	if len(env) > 0 {
		body["Env"] = env
	}
	var created struct{ ID string `json:"Id"` }
	if err := c.do(ctx, http.MethodPost, "/containers/"+containerNameOrID+"/exec", body, &created); err != nil {
		return err
	}
	pr, pw := io.Pipe()
	done := make(chan error, 1)
	go func() {
		err := c.doRaw(ctx, http.MethodPost, "/exec/"+created.ID+"/start",
			map[string]any{"Detach": false, "Tty": false}, pw)
		pw.CloseWithError(err)
		done <- err
	}()
	hdr := make([]byte, 8)
	for {
		if _, err := io.ReadFull(pr, hdr); err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				break
			}
			return err
		}
		size := int64(hdr[4])<<24 | int64(hdr[5])<<16 | int64(hdr[6])<<8 | int64(hdr[7])
		out := dst
		if hdr[0] != 1 { // discard stderr (type=2), keep only stdout (type=1)
			out = io.Discard
		}
		if _, err := io.CopyN(out, pr, size); err != nil {
			return err
		}
	}
	return <-done
}

// CopyToContainer copies a single file into the container at destDir using the
// Docker archive PUT endpoint. Creates an in-memory tar on the fly, so the
// caller only needs an io.Reader + known size (stat the file before calling).
func (c *Client) CopyToContainer(ctx context.Context, containerID, destDir, filename string, r io.Reader, size int64) error {
	pr, pw := io.Pipe()
	go func() {
		tw := tar.NewWriter(pw)
		_ = tw.WriteHeader(&tar.Header{Name: filename, Mode: 0644, Size: size, Typeflag: tar.TypeReg})
		_, _ = io.Copy(tw, r)
		_ = tw.Close()
		pw.Close()
	}()
	req, err := http.NewRequestWithContext(ctx, http.MethodPut,
		"http://docker/containers/"+containerID+"/archive?path="+url.QueryEscape(destDir), pr)
	if err != nil {
		pr.CloseWithError(err)
		return err
	}
	req.Header.Set("Content-Type", "application/x-tar")
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	io.Copy(io.Discard, res.Body)
	if res.StatusCode >= 400 {
		return fmt.Errorf("docker cp: HTTP %d", res.StatusCode)
	}
	return nil
}

func (c *Client) PruneImages(ctx context.Context) (uint64, error) { var raw struct{ SpaceReclaimed uint64 `json:"SpaceReclaimed"` }; err := c.do(ctx, http.MethodPost, "/images/prune?filters=%7B%22dangling%22%3A%5B%22false%22%5D%7D", map[string]any{}, &raw); return raw.SpaceReclaimed, err }
func (c *Client) ContainerStats(ctx context.Context) ([]Stat, error) {
	containers, err := c.Containers(ctx)
	if err != nil {
		return nil, err
	}
	type result struct {
		stat Stat
		err  error
	}
	ch := make(chan result, len(containers))
	for _, ctr := range containers {
		if ctr.State != "running" {
			continue
		}
		go func(id string) {
			s, e := c.fetchOneStat(ctx, id)
			ch <- result{stat: s, err: e}
		}(ctr.ID)
	}
	running := 0
	for _, ctr := range containers {
		if ctr.State == "running" {
			running++
		}
	}
	out := make([]Stat, 0, running)
	for i := 0; i < running; i++ {
		r := <-ch
		if r.err == nil {
			out = append(out, r.stat)
		}
	}
	return out, nil
}

type detailedStat struct {
	cpu        float64
	ramPct     float64
	ramMb      float64
	ramLimitMb float64
}

func (c *Client) ContainerStatsNamed(ctx context.Context) ([]ContainerStat, error) {
	containers, err := c.Containers(ctx)
	if err != nil {
		return nil, err
	}

	type result struct {
		stat ContainerStat
		err  error
	}
	running := 0
	for _, ctr := range containers {
		if ctr.State == "running" {
			running++
		}
	}
	ch := make(chan result, running)
	for _, ctr := range containers {
		if ctr.State != "running" {
			continue
		}
		go func(ctr Container) {
			ds, e := c.fetchDetailedStat(ctx, ctr.ID)
			if e != nil {
				ch <- result{err: e}
				return
			}
			ch <- result{stat: ContainerStat{
				ID: ctr.ID, Name: ctr.Name, Image: ctr.Image, State: ctr.State,
				CPU: ds.cpu, RAMPct: ds.ramPct, RAMMb: ds.ramMb, RAMLimitMb: ds.ramLimitMb,
			}}
		}(ctr)
	}
	out := make([]ContainerStat, 0, running)
	for i := 0; i < running; i++ {
		r := <-ch
		if r.err == nil {
			out = append(out, r.stat)
		}
	}
	return out, nil
}

// FetchOneStat returns CPU% and RAM% for a single container by name or ID.
func (c *Client) FetchOneStat(ctx context.Context, id string) (Stat, error) {
	return c.fetchOneStat(ctx, id)
}

func (c *Client) fetchOneStat(ctx context.Context, id string) (Stat, error) {
	var raw struct {
		ID     string `json:"id"`
		CPUSt  struct {
			Usage struct {
				Total  uint64 `json:"total_usage"`
			} `json:"cpu_usage"`
			SystemUsage uint64 `json:"system_cpu_usage"`
			OnlineCPUs  int    `json:"online_cpus"`
		} `json:"cpu_stats"`
		PreCPUSt struct {
			Usage struct {
				Total  uint64 `json:"total_usage"`
			} `json:"cpu_usage"`
			SystemUsage uint64 `json:"system_cpu_usage"`
			OnlineCPUs  int    `json:"online_cpus"`
		} `json:"precpu_stats"`
		MemSt struct {
			Usage uint64 `json:"usage"`
			Limit uint64 `json:"limit"`
			Cache uint64 `json:"cache"`
			Stats struct {
				Cache uint64 `json:"cache"`
			} `json:"stats"`
		} `json:"memory_stats"`
	}
	statCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	if err := c.do(statCtx, http.MethodGet, "/containers/"+id+"/stats?stream=false&one-shot=true", nil, &raw); err != nil {
		return Stat{}, err
	}
	// CPU %
	cpuDelta := float64(raw.CPUSt.Usage.Total) - float64(raw.PreCPUSt.Usage.Total)
	sysDelta  := float64(raw.CPUSt.SystemUsage) - float64(raw.PreCPUSt.SystemUsage)
	numCPU := raw.CPUSt.OnlineCPUs
	if numCPU == 0 {
		numCPU = 1
	}
	cpuPct := 0.0
	if sysDelta > 0 {
		cpuPct = (cpuDelta / sysDelta) * float64(numCPU) * 100.0
	}
	// RAM %
	cache := raw.MemSt.Stats.Cache
	if cache == 0 {
		cache = raw.MemSt.Cache
	}
	used := raw.MemSt.Usage - cache
	ramPct := 0.0
	if raw.MemSt.Limit > 0 {
		ramPct = float64(used) / float64(raw.MemSt.Limit) * 100.0
	}
	shortid := id
	if len(shortid) > 12 {
		shortid = shortid[:12]
	}
	return Stat{ContainerID: shortid, CPU: cpuPct, RAM: ramPct}, nil
}

func (c *Client) fetchDetailedStat(ctx context.Context, id string) (detailedStat, error) {
	var raw struct {
		CPUSt  struct {
			Usage       struct{ Total uint64 `json:"total_usage"` } `json:"cpu_usage"`
			SystemUsage uint64 `json:"system_cpu_usage"`
			OnlineCPUs  int    `json:"online_cpus"`
		} `json:"cpu_stats"`
		PreCPUSt struct {
			Usage       struct{ Total uint64 `json:"total_usage"` } `json:"cpu_usage"`
			SystemUsage uint64 `json:"system_cpu_usage"`
		} `json:"precpu_stats"`
		MemSt struct {
			Usage uint64 `json:"usage"`
			Limit uint64 `json:"limit"`
			Cache uint64 `json:"cache"`
			Stats struct{ Cache uint64 `json:"cache"` } `json:"stats"`
		} `json:"memory_stats"`
	}
	statCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	if err := c.do(statCtx, http.MethodGet, "/containers/"+id+"/stats?stream=false&one-shot=true", nil, &raw); err != nil {
		return detailedStat{}, err
	}
	cpuDelta := float64(raw.CPUSt.Usage.Total) - float64(raw.PreCPUSt.Usage.Total)
	sysDelta  := float64(raw.CPUSt.SystemUsage) - float64(raw.PreCPUSt.SystemUsage)
	numCPU := raw.CPUSt.OnlineCPUs
	if numCPU == 0 {
		numCPU = 1
	}
	cpuPct := 0.0
	if sysDelta > 0 {
		cpuPct = (cpuDelta / sysDelta) * float64(numCPU) * 100.0
	}
	cache := raw.MemSt.Stats.Cache
	if cache == 0 {
		cache = raw.MemSt.Cache
	}
	used := raw.MemSt.Usage
	if used > cache {
		used -= cache
	}
	ramPct := 0.0
	if raw.MemSt.Limit > 0 {
		ramPct = float64(used) / float64(raw.MemSt.Limit) * 100.0
	}
	return detailedStat{
		cpu:        cpuPct,
		ramPct:     ramPct,
		ramMb:      float64(used) / 1024 / 1024,
		ramLimitMb: float64(raw.MemSt.Limit) / 1024 / 1024,
	}, nil
}

// ContainerInfo returns the image name and a flat env-var map for any container.
func (c *Client) ContainerInfo(ctx context.Context, nameOrID string) (image string, env map[string]string, err error) {
	var raw struct {
		Config struct {
			Image string   `json:"Image"`
			Env   []string `json:"Env"`
		} `json:"Config"`
	}
	if err = c.do(ctx, http.MethodGet, "/containers/"+nameOrID+"/json", nil, &raw); err != nil {
		return
	}
	image = raw.Config.Image
	env = make(map[string]string, len(raw.Config.Env))
	for _, kv := range raw.Config.Env {
		if i := strings.IndexByte(kv, '='); i >= 0 {
			env[kv[:i]] = kv[i+1:]
		}
	}
	return
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error { var buf io.Reader; if body != nil { data, _ := json.Marshal(body); buf = bytes.NewReader(data) }; req, err := http.NewRequestWithContext(ctx, method, "http://docker"+path, buf); if err != nil { return err }; if body != nil { req.Header.Set("Content-Type", "application/json") }; res, err := c.http.Do(req); if err != nil { return err }; defer res.Body.Close(); if res.StatusCode >= 400 { data, _ := io.ReadAll(res.Body); return fmt.Errorf("docker %s %s: %s", method, path, strings.TrimSpace(string(data))) }; if out == nil { io.Copy(io.Discard, res.Body); return nil }; return json.NewDecoder(res.Body).Decode(out) }
func (c *Client) doRaw(ctx context.Context, method, path string, body any, out io.Writer) error { var buf io.Reader; if body != nil { data, _ := json.Marshal(body); buf = bytes.NewReader(data) }; req, err := http.NewRequestWithContext(ctx, method, "http://docker"+path, buf); if err != nil { return err }; if body != nil { req.Header.Set("Content-Type", "application/json") }; res, err := c.http.Do(req); if err != nil { return err }; defer res.Body.Close(); if res.StatusCode >= 400 { data, _ := io.ReadAll(res.Body); return fmt.Errorf("docker %s %s: %s", method, path, strings.TrimSpace(string(data))) }; _, err = io.Copy(out, res.Body); return err }

func formatPorts(ports []portBinding) string {
	seen := map[string]bool{}
	values := []string{}
	for _, p := range ports {
		var s string
		if p.PublicPort > 0 {
			s = fmt.Sprintf("%d→%d/%s", p.PublicPort, p.PrivatePort, p.Type)
		} else if p.PrivatePort > 0 {
			s = fmt.Sprintf("%d/%s", p.PrivatePort, p.Type)
		}
		if s != "" && !seen[s] {
			seen[s] = true
			values = append(values, s)
		}
	}
	if len(values) == 0 {
		return "-"
	}
	return strings.Join(values, ", ")
}
func shortID(id string) string { if len(id)<=12 { return id }; return id[:12] }
func cleanDockerStream(buf []byte) string { var out bytes.Buffer; for len(buf)>8 && (buf[0]==1 || buf[0]==2) { size := int(buf[4])<<24|int(buf[5])<<16|int(buf[6])<<8|int(buf[7]); if len(buf)<8+size { break }; out.Write(buf[8:8+size]); buf=buf[8+size:] }; if out.Len()==0 { out.Write(buf) }; return strings.Map(func(r rune) rune { if r<32 && r!=10 && r!=9 && r!=13 { return -1 }; return r }, out.String()) }
func dbMeta(image string) (string,int,int) { lower := strings.ToLower(image); switch { case strings.Contains(lower,"mysql"), strings.Contains(lower,"mariadb"): return "mysql",3306,100; case strings.Contains(lower,"redis"): return "redis",6379,200; case strings.Contains(lower,"mongo"): return "mongodb",27017,100; case strings.Contains(lower,"clickhouse"): return "clickhouse",8123,50; case strings.Contains(lower,"cassandra"): return "cassandra",9042,100; case strings.Contains(lower,"elasticsearch"): return "elasticsearch",9200,100; default: return "postgres",5432,100 } }
func imageVersion(image string) string { parts := strings.Split(image, ":"); if len(parts)<2 || parts[1]=="" { return "latest" }; return strings.Split(parts[1], "-")[0] }

// ── Database provisioning ─────────────────────────────────────────────────────

func (c *Client) CreateVolume(ctx context.Context, name string) error {
	return c.do(ctx, http.MethodPost, "/volumes/create", map[string]any{"Name": name}, nil)
}

func (c *Client) PullImage(ctx context.Context, image string) error {
	tag := "latest"
	parts := strings.SplitN(image, ":", 2)
	ref := parts[0]
	if len(parts) == 2 {
		tag = parts[1]
	}
	path := fmt.Sprintf("/images/create?fromImage=%s&tag=%s", ref, tag)
	var buf bytes.Buffer
	return c.doRaw(ctx, http.MethodPost, path, nil, &buf)
}

func (c *Client) CreateDBContainer(ctx context.Context, image, name, volumeName, dataPath string, hostPort, containerPort int, envVars map[string]string) (string, error) {
	env := []string{}
	for k, v := range envVars {
		env = append(env, k+"="+v)
	}
	body := map[string]any{
		"Image":   image,
		"Env":     env,
		"Labels":  map[string]string{"pulsenode.managed": "true", "pulsenode.type": "database"},
		"Volumes": map[string]any{dataPath: map[string]any{}},
		"HostConfig": map[string]any{
			"Binds":         []string{volumeName + ":" + dataPath},
			"RestartPolicy": map[string]string{"Name": "unless-stopped"},
			"PortBindings": map[string]any{
				fmt.Sprintf("%d/tcp", containerPort): []map[string]string{
					{"HostIp": "127.0.0.1", "HostPort": fmt.Sprintf("%d", hostPort)},
				},
			},
		},
		"ExposedPorts": map[string]any{fmt.Sprintf("%d/tcp", containerPort): map[string]any{}},
	}
	// Memory/pids ceilings, log rotation and no-new-privileges (new containers only).
	hc := body["HostConfig"].(map[string]any)
	for k, v := range dbHostConfigHardening(image) {
		hc[k] = v
	}
	var created struct {
		ID string `json:"Id"`
	}
	if err := c.do(ctx, http.MethodPost, "/containers/create?name="+url.QueryEscape(name), body, &created); err != nil {
		return "", err
	}
	return created.ID, nil
}

func (c *Client) StartContainer(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodPost, "/containers/"+id+"/start", nil, nil)
}

// ContainerState returns the inspect-level state (running, exited, restarting, …).
func (c *Client) ContainerState(ctx context.Context, nameOrID string) (string, error) {
	var raw struct {
		State struct {
			Status string `json:"Status"`
		} `json:"State"`
	}
	if err := c.do(ctx, http.MethodGet, "/containers/"+nameOrID+"/json", nil, &raw); err != nil {
		return "", err
	}
	return raw.State.Status, nil
}

func (c *Client) CreateTTYExec(ctx context.Context, containerID string) (string, error) {
	var created struct{ ID string `json:"Id"` }
	err := c.do(ctx, http.MethodPost, "/containers/"+containerID+"/exec",
		map[string]any{
			"Cmd":          []string{"sh"},
			"AttachStdin":  true,
			"AttachStdout": true,
			"AttachStderr": true,
			"Tty":          true,
		}, &created)
	return created.ID, err
}

func (c *Client) ResizeExecTTY(ctx context.Context, execID string, h, w int) error {
	return c.do(ctx, http.MethodPost,
		fmt.Sprintf("/exec/%s/resize?h=%d&w=%d", execID, h, w), nil, nil)
}
