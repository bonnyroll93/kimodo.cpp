package main

// Kimodo Extended step 2: motion sources for the studio and root-motion post-processing
// (Full / InPlace / CustomPath) through `kmd-anim root-motion`. Results are cached per
// request under <output>/root-motion/<hash>/ and never modify the source motion.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type studioMotion struct {
	ID          string `json:"id"` // "sample:<dir>" or "animation:<id>"
	Label       string `json:"label"`
	Kind        string `json:"kind"`
	SkeletonKey string `json:"skeleton_key"`
	Frames      int    `json:"frames"`
	dir         string
}

type rootMotionPath struct {
	Points        [][3]float64 `json:"points"`
	Interpolation string       `json:"interpolation"` // catmull | polyline
	Loop          bool         `json:"loop"`
}

type rootMotionRequest struct {
	Source   string          `json:"source"`
	Mode     string          `json:"mode"` // full | inplace | path
	Lock     string          `json:"lock,omitempty"`
	Path     *rootMotionPath `json:"path,omitempty"`
	Timing   string          `json:"timing,omitempty"` // distance | duration | speed
	Duration float64         `json:"duration,omitempty"`
	Speed    float64         `json:"speed,omitempty"`
	Orient   *bool           `json:"orient,omitempty"`
}

// skeletonKeyForJoints maps a joint count to the native skeleton (22, 30, 34 are unique).
func skeletonKeyForJoints(joints int) string {
	for key, def := range skeletonDefinitions {
		if len(def.parents) == joints {
			return key
		}
	}
	return ""
}

// motionShape reads frames and joints from the sizes of a kmd-generate output directory.
func motionShape(dir string) (frames, joints int, err error) {
	root, err := os.Stat(filepath.Join(dir, "root_positions.f32"))
	if err != nil {
		return 0, 0, err
	}
	rot, err := os.Stat(filepath.Join(dir, "local_rotations_xyzw.f32"))
	if err != nil {
		return 0, 0, err
	}
	if root.Size() == 0 || root.Size()%12 != 0 {
		return 0, 0, errors.New("root_positions.f32 is not [frames,3]")
	}
	frames = int(root.Size() / 12)
	if rot.Size()%int64(frames*16) != 0 {
		return 0, 0, errors.New("local_rotations_xyzw.f32 is not [frames,joints,4]")
	}
	return frames, int(rot.Size() / int64(frames*16)), nil
}

func (c studioConfig) motions() []studioMotion {
	var list []studioMotion
	entries, _ := os.ReadDir(c.sampleMotions)
	for _, e := range entries {
		if !e.IsDir() || !safePathPart(e.Name()) {
			continue
		}
		dir := filepath.Join(c.sampleMotions, e.Name())
		frames, joints, err := motionShape(dir)
		if err != nil {
			continue
		}
		label := e.Name()
		if prompt, err := os.ReadFile(filepath.Join(dir, "prompt.txt")); err == nil {
			label = strings.TrimSpace(string(prompt)) + " (" + e.Name() + ")"
		}
		list = append(list, studioMotion{ID: "sample:" + e.Name(), Label: label, Kind: "sample", SkeletonKey: skeletonKeyForJoints(joints), Frames: frames, dir: dir})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	if c.animations != nil {
		list = append(list, c.animations()...)
	}
	return list
}

func (c studioConfig) findMotion(id string) (studioMotion, bool) {
	for _, m := range c.motions() {
		if m.ID == id {
			return m, true
		}
	}
	return studioMotion{}, false
}

func finite(values ...float64) bool {
	for _, v := range values {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return false
		}
	}
	return true
}

func num(v float64) string { return strconv.FormatFloat(v, 'g', -1, 32) }

// rootMotionArgs validates a request and turns it into kmd-anim arguments (no shell involved).
func rootMotionArgs(req rootMotionRequest) ([]string, error) {
	args := []string{"--mode"}
	switch req.Mode {
	case "full", "inplace", "path":
		args = append(args, req.Mode)
	default:
		return nil, fmt.Errorf("mode must be full, inplace or path")
	}
	if req.Mode == "inplace" && req.Lock != "" {
		if req.Lock != "both" && req.Lock != "forward" && req.Lock != "lateral" {
			return nil, fmt.Errorf("lock must be both, forward or lateral")
		}
		args = append(args, "--lock", req.Lock)
	}
	if req.Mode != "path" {
		if req.Path != nil {
			return nil, fmt.Errorf("%s root motion and a custom path are mutually exclusive", req.Mode)
		}
		return args, nil
	}
	if req.Path == nil || len(req.Path.Points) == 0 {
		return nil, fmt.Errorf("path mode needs at least one point")
	}
	if len(req.Path.Points) > 256 {
		return nil, fmt.Errorf("path has more than 256 points")
	}
	points := make([]string, len(req.Path.Points))
	for i, p := range req.Path.Points {
		if !finite(p[0], p[1], p[2]) || math.Abs(p[0]) > 1e4 || math.Abs(p[1]) > 1e4 || math.Abs(p[2]) > 1e4 {
			return nil, fmt.Errorf("path point %d is invalid", i)
		}
		points[i] = num(p[0]) + "," + num(p[1]) + "," + num(p[2])
	}
	args = append(args, "--points", strings.Join(points, ";"))
	switch req.Path.Interpolation {
	case "", "catmull", "polyline":
		if req.Path.Interpolation != "" {
			args = append(args, "--interp", req.Path.Interpolation)
		}
	default:
		return nil, fmt.Errorf("interpolation must be catmull or polyline")
	}
	if req.Path.Loop {
		args = append(args, "--loop")
	}
	switch req.Timing {
	case "", "distance":
	case "duration":
		if !finite(req.Duration) || req.Duration < 0 || req.Duration > 3600 {
			return nil, fmt.Errorf("duration must be between 0 and 3600 seconds")
		}
		args = append(args, "--timing", "duration", "--duration", num(req.Duration))
	case "speed":
		if !finite(req.Speed) || req.Speed < 0 || req.Speed > 100 {
			return nil, fmt.Errorf("speed must be between 0 and 100 m/s")
		}
		args = append(args, "--timing", "speed", "--speed", num(req.Speed))
	default:
		return nil, fmt.Errorf("timing must be distance, duration or speed")
	}
	if req.Orient != nil && !*req.Orient {
		args = append(args, "--no-orient")
	}
	return args, nil
}

func registerRootMotion(mux *http.ServeMux, c studioConfig) {
	mux.HandleFunc("/api/skeletons/", func(w http.ResponseWriter, r *http.Request) {
		def, ok := skeletonDefinitions[strings.TrimPrefix(r.URL.Path, "/api/skeletons/")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"key": def.key, "names": def.names, "parents": def.parents, "offsets": def.offsets})
	})
	mux.HandleFunc("/studio/motions", func(w http.ResponseWriter, r *http.Request) {
		list := c.motions()
		if list == nil {
			list = []studioMotion{}
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(list)
	})
	serveMotionFile := func(w http.ResponseWriter, r *http.Request, dir, name string) {
		files := map[string]string{"root.f32": "root_positions.f32", "rotations.f32": "local_rotations_xyzw.f32", "path.f32": "path_samples.f32"}
		file, ok := files[name]
		if !ok {
			http.NotFound(w, r)
			return
		}
		path := filepath.Join(dir, file)
		if info, err := os.Stat(path); err != nil || !info.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Cache-Control", "no-store")
		http.ServeFile(w, r, path)
	}
	// /studio/motions/<id>/<file>; ids contain ':' so they are path-escaped by the client.
	mux.HandleFunc("/studio/motions/", func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/studio/motions/"), "/")
		if len(parts) != 2 {
			http.NotFound(w, r)
			return
		}
		m, ok := c.findMotion(parts[0])
		if !ok {
			http.NotFound(w, r)
			return
		}
		serveMotionFile(w, r, m.dir, parts[1])
	})
	mux.HandleFunc("/api/root-motion/", func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/root-motion/"), "/")
		if len(parts) != 2 || !safePathPart(parts[0]) {
			http.NotFound(w, r)
			return
		}
		serveMotionFile(w, r, filepath.Join(c.output, "root-motion", parts[0]), parts[1])
	})
	mux.HandleFunc("/api/root-motion", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req rootMotionRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		res, err := c.rootMotion(r.Context(), req)
		if err != nil {
			writeError(w, err.status, err.message)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(res)
	})
}

type httpError struct {
	status  int
	message string
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

// runCached runs `kmd-anim args... <dir>`-style commands into a temporary directory and
// renames it to dir, unless dir already holds marker (results are keyed by request hash).
// build receives the temporary output directory and returns the full argument list.
func (c studioConfig) runCached(ctx context.Context, dir, marker string, build func(out string) []string) *httpError {
	if _, err := os.Stat(filepath.Join(dir, marker)); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0755); err != nil {
		return &httpError{http.StatusInternalServerError, err.Error()}
	}
	tmp := dir + ".tmp-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, c.anim, build(tmp)...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		_ = os.RemoveAll(tmp)
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return &httpError{http.StatusUnprocessableEntity, "kmd-anim: " + message}
	}
	if err := os.Rename(tmp, dir); err != nil {
		_ = os.RemoveAll(tmp)
		// Fine if a concurrent identical request produced the result first.
		if _, statErr := os.Stat(filepath.Join(dir, marker)); statErr != nil {
			return &httpError{http.StatusInternalServerError, "cannot store result: " + err.Error()}
		}
	}
	return nil
}

// toolVersion identifies the kmd-anim binary (size and modification time). It is part of
// every cache key, so results computed by an older build are never reused after a rebuild.
var toolVersion string

func setToolVersion(anim string) {
	if info, err := os.Stat(anim); err == nil {
		toolVersion = fmt.Sprintf("%d-%d", info.Size(), info.ModTime().UnixNano())
	}
}

func hashID(parts ...string) string {
	key := sha256.Sum256([]byte(toolVersion + "\x00" + strings.Join(parts, "\x00")))
	return hex.EncodeToString(key[:12])
}

type rootMotionResult struct {
	ID          string `json:"id"`
	Source      string `json:"source"`
	SkeletonKey string `json:"skeleton_key"`
	Frames      int    `json:"frames"`
	Root        string `json:"root"`
	Rotations   string `json:"rotations"`
	Path        string `json:"path,omitempty"`
	dir         string
}

func (c studioConfig) rootMotion(ctx context.Context, req rootMotionRequest) (rootMotionResult, *httpError) {
	source, ok := c.findMotion(req.Source)
	if !ok {
		return rootMotionResult{}, &httpError{http.StatusNotFound, "unknown motion source"}
	}
	args, err := rootMotionArgs(req)
	if err != nil {
		return rootMotionResult{}, &httpError{http.StatusBadRequest, err.Error()}
	}
	id := hashID(append([]string{source.ID}, args...)...)
	dir := filepath.Join(c.output, "root-motion", id)
	if herr := c.runCached(ctx, dir, "local_rotations_xyzw.f32", func(out string) []string {
		return append([]string{"root-motion", source.dir, out}, args...)
	}); herr != nil {
		return rootMotionResult{}, herr
	}
	res := rootMotionResult{ID: id, Source: source.ID, SkeletonKey: source.SkeletonKey, Frames: source.Frames,
		Root: "/api/root-motion/" + id + "/root.f32", Rotations: "/api/root-motion/" + id + "/rotations.f32", dir: dir}
	if req.Mode == "path" {
		res.Path = "/api/root-motion/" + id + "/path.f32"
	}
	return res, nil
}

// defaultAnimTool places kmd-anim next to the generator binary (same build directory).
func defaultAnimTool(generator string) string {
	return filepath.Join(filepath.Dir(generator), "kmd-anim"+filepath.Ext(generator))
}

// studioMotions lists ready gallery animations as studio motion sources.
func (g *gallery) studioMotions() []studioMotion {
	g.mu.RLock()
	defer g.mu.RUnlock()
	list := make([]studioMotion, 0, len(g.items))
	for id, a := range g.items {
		if a.Status != "ready" || !safePathPart(id) {
			continue
		}
		dir := filepath.Join(g.output, id)
		frames, joints, err := motionShape(dir)
		if err != nil {
			continue
		}
		list = append(list, studioMotion{ID: "animation:" + id, Label: a.Prompt, Kind: "animation", SkeletonKey: skeletonKeyForJoints(joints), Frames: frames, dir: dir})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	return list
}
