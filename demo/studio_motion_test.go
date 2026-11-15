package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestRootMotionArgs(t *testing.T) {
	no := false
	ok := []struct {
		req  rootMotionRequest
		want string
	}{
		{rootMotionRequest{Mode: "full"}, "--mode full"},
		{rootMotionRequest{Mode: "inplace", Lock: "forward"}, "--mode inplace --lock forward"},
		{rootMotionRequest{Mode: "path", Path: &rootMotionPath{Points: [][3]float64{{0, 0, 0}, {1.5, 0, -2}}, Interpolation: "polyline", Loop: true}, Timing: "speed", Speed: 1.2, Orient: &no},
			"--mode path --points 0,0,0;1.5,0,-2 --interp polyline --loop --timing speed --speed 1.2 --no-orient"},
	}
	for _, c := range ok {
		args, err := rootMotionArgs(c.req)
		if err != nil || strings.Join(args, " ") != c.want {
			t.Fatalf("%+v: got %q %v, want %q", c.req, strings.Join(args, " "), err, c.want)
		}
	}
	bad := []rootMotionRequest{
		{Mode: "teleport"},
		{Mode: "inplace", Path: &rootMotionPath{Points: [][3]float64{{0, 0, 0}}}}, // mutually exclusive
		{Mode: "full", Path: &rootMotionPath{Points: [][3]float64{{0, 0, 0}}}},
		{Mode: "path"},
		{Mode: "path", Path: &rootMotionPath{}},
		{Mode: "path", Path: &rootMotionPath{Points: [][3]float64{{math.NaN(), 0, 0}}}},
		{Mode: "path", Path: &rootMotionPath{Points: [][3]float64{{0, 0, 0}}, Interpolation: "bezier"}},
		{Mode: "path", Path: &rootMotionPath{Points: [][3]float64{{0, 0, 0}}}, Timing: "speed", Speed: -1},
		{Mode: "inplace", Lock: "up"},
	}
	for _, req := range bad {
		if _, err := rootMotionArgs(req); err == nil {
			t.Fatalf("%+v: expected an error", req)
		}
	}
}

func decodeF32(t *testing.T, body []byte) []float32 {
	t.Helper()
	values := make([]float32, len(body)/4)
	if err := binary.Read(bytes.NewReader(body), binary.LittleEndian, values); err != nil {
		t.Fatal(err)
	}
	return values
}

// End to end through the real kmd-anim when it has been built (skipped otherwise).
func TestRootMotionEndpoint(t *testing.T) {
	exe := ""
	for _, candidate := range []string{"../build/Release/kmd-anim", "../build/release/kmd-anim", "../build/debug/kmd-anim", "../build/kmd-anim"} {
		if runtime.GOOS == "windows" {
			candidate += ".exe"
		}
		if _, err := os.Stat(candidate); err == nil {
			exe, _ = filepath.Abs(candidate)
			break
		}
	}
	if exe == "" {
		t.Skip("kmd-anim not built")
	}
	mux := http.NewServeMux()
	registerStudio(mux, studioConfig{sampleMotions: "../tests/data/baseline", output: t.TempDir(), anim: exe})
	do := func(method, path, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
		return rec
	}

	var motions []studioMotion
	if err := json.Unmarshal(do(http.MethodGet, "/studio/motions", "").Body.Bytes(), &motions); err != nil || len(motions) == 0 {
		t.Fatalf("motions: %v %v", motions, err)
	}
	m := motions[0]
	if m.ID != "sample:soma30-walk-s42" || m.SkeletonKey != "soma30" || m.Frames != 90 {
		t.Fatalf("unexpected sample motion %+v", m)
	}
	if rec := do(http.MethodGet, "/api/skeletons/soma30", ""); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"Hips"`) {
		t.Fatalf("skeleton: %d %s", rec.Code, rec.Body.String())
	}
	original := do(http.MethodGet, "/studio/motions/"+m.ID+"/root.f32", "").Body.Bytes()

	// Full is bit-identical to the source.
	rec := do(http.MethodPost, "/api/root-motion", `{"source":"sample:soma30-walk-s42","mode":"full"}`)
	var result map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("full: %d %s", rec.Code, rec.Body.String())
	}
	if !bytes.Equal(do(http.MethodGet, result["root"].(string), "").Body.Bytes(), original) {
		t.Fatal("full root motion changed the root trajectory")
	}

	// InPlace removes horizontal travel.
	rec = do(http.MethodPost, "/api/root-motion", `{"source":"sample:soma30-walk-s42","mode":"inplace"}`)
	_ = json.Unmarshal(rec.Body.Bytes(), &result)
	root := decodeF32(t, do(http.MethodGet, result["root"].(string), "").Body.Bytes())
	last := len(root) - 3
	if math.Abs(float64(root[last]-root[0])) > 1e-5 || math.Abs(float64(root[last+2]-root[2])) > 1e-5 {
		t.Fatalf("in-place root drifted: start %v end %v", root[:3], root[last:])
	}

	// Path mode returns the evaluated curve; exclusivity errors reach the client.
	rec = do(http.MethodPost, "/api/root-motion", `{"source":"sample:soma30-walk-s42","mode":"path","path":{"points":[[0,0,0],[2,0,0]],"interpolation":"polyline"},"timing":"duration"}`)
	_ = json.Unmarshal(rec.Body.Bytes(), &result)
	if rec.Code != http.StatusOK || result["path"] == nil {
		t.Fatalf("path: %d %s", rec.Code, rec.Body.String())
	}
	root = decodeF32(t, do(http.MethodGet, result["root"].(string), "").Body.Bytes())
	if math.Abs(float64(root[len(root)-3])-2) > 1e-3 {
		t.Fatalf("path end x = %v, want 2", root[len(root)-3])
	}
	if samples := do(http.MethodGet, result["path"].(string), "").Body.Len(); samples != 256*12 {
		t.Fatalf("path samples: %d bytes", samples)
	}
	if rec := do(http.MethodPost, "/api/root-motion", `{"source":"sample:soma30-walk-s42","mode":"inplace","path":{"points":[[0,0,0]]}}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("exclusive: got %d", rec.Code)
	}
	if rec := do(http.MethodPost, "/api/root-motion", `{"source":"sample:nope","mode":"full"}`); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown source: got %d", rec.Code)
	}
	if rec := do(http.MethodGet, "/api/root-motion/..%2F..%2Fx/root.f32", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("traversal: got %d", rec.Code)
	}
}

func TestDeleteGeneratedMotion(t *testing.T) {
	out := t.TempDir()
	dir := filepath.Join(out, "abc123")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	root := make([]byte, 90*12)
	rot := make([]byte, 90*30*16)
	_ = os.WriteFile(filepath.Join(dir, "root_positions.f32"), root, 0644)
	_ = os.WriteFile(filepath.Join(dir, "local_rotations_xyzw.f32"), rot, 0644)
	_ = os.WriteFile(filepath.Join(out, "abc123.json"), []byte("{}"), 0644)
	g := &gallery{items: map[string]*animation{
		"abc123":  {ID: "abc123", Prompt: "wave", Status: "ready", CreatedAt: "2026-11-15T10:00:00Z"},
		"running": {ID: "running", Prompt: "busy", Status: "running"},
	}, output: out}
	mux := http.NewServeMux()
	registerStudio(mux, studioConfig{sampleMotions: t.TempDir(), output: out, animations: g.studioMotions, deleteAnimation: g.deleteAnimation})
	do := func(method, path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
		return rec
	}
	var list []studioMotion
	if err := json.Unmarshal(do(http.MethodGet, "/studio/motions").Body.Bytes(), &list); err != nil || len(list) != 1 ||
		!list[0].Deletable || list[0].Created == "" || list[0].SkeletonKey != "soma30" {
		t.Fatalf("listing: %+v %v", list, err)
	}
	if rec := do(http.MethodDelete, "/studio/motions/sample:soma30-walk-s42"); rec.Code != http.StatusForbidden {
		t.Fatalf("sample delete: %d", rec.Code)
	}
	if rec := do(http.MethodDelete, "/studio/motions/animation:running"); rec.Code != http.StatusConflict {
		t.Fatalf("running delete: %d", rec.Code)
	}
	if rec := do(http.MethodDelete, "/studio/motions/animation:abc123"); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("animation files were not removed")
	}
	if _, ok := g.items["abc123"]; ok {
		t.Fatal("gallery entry was not removed")
	}
	if rec := do(http.MethodDelete, "/studio/motions/animation:abc123"); rec.Code != http.StatusNotFound {
		t.Fatalf("second delete: %d", rec.Code)
	}
}
