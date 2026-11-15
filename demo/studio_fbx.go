package main

// Kimodo Extended: FBX import / export through Blender (optional).
//   GET  /api/fbx            {"available":bool,"blender":"<version line>"}
//   POST /api/convert/fbx    raw FBX body -> the rigged character as GLB bytes (cached)
//   POST /api/export         {..., "format":"fbx"} -> the export as FBX (studio_export.go)
// The studio imports FBX in the browser first (three.js FBXLoader); this endpoint is its
// fallback. Exports are always baked to GLB by kmd-anim, then converted by Blender in
// background mode with blender_fbx.py (embedded, written next to the results). Blender is
// found with -blender, on PATH, or in the usual install folders.

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed blender_fbx.py
var blenderScript []byte

// scriptVersion tags cached conversions: a changed script redoes them.
var scriptVersion = hashID(string(blenderScript))

// converted reports whether out exists and was made by this script version (out + ".v").
func converted(out string) bool {
	v, err := os.ReadFile(out + ".v")
	if err != nil || string(v) != scriptVersion {
		return false
	}
	_, err = os.Stat(out)
	return err == nil
}

// findBlender: the flag's value, else blender on PATH, else the newest standard install.
func findBlender(flagValue string) string {
	if flagValue != "" {
		return flagValue
	}
	if p, err := exec.LookPath("blender"); err == nil {
		return p
	}
	var candidates []string
	switch runtime.GOOS {
	case "windows":
		for _, base := range []string{os.Getenv("ProgramFiles"), `C:\Program Files`} {
			if base == "" {
				continue
			}
			m, _ := filepath.Glob(filepath.Join(base, "Blender Foundation", "Blender*", "blender.exe"))
			candidates = append(candidates, m...)
		}
	case "darwin":
		candidates = []string{"/Applications/Blender.app/Contents/MacOS/Blender"}
	default:
		m, _ := filepath.Glob("/opt/blender*/blender")
		candidates = append(candidates, m...)
		candidates = append(candidates, "/snap/bin/blender")
	}
	// Newest version first ("Blender 5.2" > "Blender 4.5"; compares the numbers).
	sort.SliceStable(candidates, func(i, j int) bool { return versionKey(candidates[i]) > versionKey(candidates[j]) })
	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil && !info.IsDir() {
			return c
		}
	}
	return ""
}

func versionKey(path string) float64 {
	dir := filepath.Base(filepath.Dir(path))
	v, _ := strconv.ParseFloat(strings.TrimSpace(strings.TrimPrefix(dir, "Blender")), 64)
	return v
}

var blenderVersion struct {
	sync.Once
	line string
}

func (c studioConfig) blenderInfo() (bool, string) {
	if c.blender == "" {
		return false, ""
	}
	blenderVersion.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, c.blender, "--version").Output()
		if err == nil {
			blenderVersion.line = strings.TrimSpace(strings.SplitN(string(out), "\n", 2)[0])
		}
	})
	return blenderVersion.line != "", blenderVersion.line
}

// blenderConvert runs blender_fbx.py (mode glb2fbx | fbx2glb) from in to out.
func (c studioConfig) blenderConvert(ctx context.Context, mode, in, out string) *httpError {
	if ok, _ := c.blenderInfo(); !ok {
		return &httpError{http.StatusServiceUnavailable, "FBX needs Blender (not found: install it or start the demo with -blender PATH)"}
	}
	script := filepath.Join(c.output, "tools", "blender_fbx.py")
	if old, err := os.ReadFile(script); err != nil || !bytes.Equal(old, blenderScript) {
		if err := os.MkdirAll(filepath.Dir(script), 0755); err != nil {
			return &httpError{http.StatusInternalServerError, err.Error()}
		}
		if err := os.WriteFile(script, blenderScript, 0644); err != nil {
			return &httpError{http.StatusInternalServerError, err.Error()}
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	tmp := out + ".tmp-" + strconv.FormatInt(time.Now().UnixNano(), 36) + filepath.Ext(out)
	cmd := exec.CommandContext(ctx, c.blender, "-b", "--factory-startup", "--python", script, "--", mode, in, tmp)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	if err != nil || !strings.Contains(stdout.String(), `"ok": true`) {
		_ = os.Remove(tmp)
		msg := lastLines(stderr.String()+"\n"+stdout.String(), 3)
		if msg == "" && err != nil {
			msg = err.Error()
		}
		return &httpError{http.StatusUnprocessableEntity, "Blender " + mode + " failed: " + msg}
	}
	_ = os.Remove(out) // an older script's result
	if err := os.Rename(tmp, out); err != nil {
		_ = os.Remove(tmp)
		if _, statErr := os.Stat(out); statErr != nil {
			return &httpError{http.StatusInternalServerError, "cannot store the conversion: " + err.Error()}
		}
	}
	_ = os.WriteFile(out+".v", []byte(scriptVersion), 0644)
	return nil
}

// lastLines keeps the useful end of a tool's output (errors, tracebacks).
func lastLines(s string, n int) string {
	var keep []string
	for _, l := range strings.Split(strings.TrimSpace(s), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			keep = append(keep, l)
		}
	}
	if len(keep) > n {
		keep = keep[len(keep)-n:]
	}
	return strings.Join(keep, " | ")
}

func registerFBX(mux *http.ServeMux, c studioConfig) {
	mux.HandleFunc("/api/fbx", func(w http.ResponseWriter, r *http.Request) {
		ok, version := c.blenderInfo()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"available": ok, "blender": version})
	})
	mux.HandleFunc("/api/convert/fbx", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 512<<20))
		if err != nil {
			writeError(w, http.StatusRequestEntityTooLarge, "FBX too large (512 MiB max)")
			return
		}
		if len(data) < 32 || (!bytes.HasPrefix(data, []byte("Kaydara FBX Binary")) && !bytes.Contains(data[:min(len(data), 4096)], []byte("FBXHeaderExtension"))) {
			writeError(w, http.StatusBadRequest, "not an FBX file")
			return
		}
		dir := filepath.Join(c.output, "fbx-import")
		if err := os.MkdirAll(dir, 0755); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		id := hashID(string(data))
		in, out := filepath.Join(dir, id+".fbx"), filepath.Join(dir, id+".glb")
		if !converted(out) {
			if err := os.WriteFile(in, data, 0644); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			if herr := c.blenderConvert(r.Context(), "fbx2glb", in, out); herr != nil {
				writeError(w, herr.status, herr.message)
				return
			}
		}
		w.Header().Set("Content-Type", "model/gltf-binary")
		http.ServeFile(w, r, out)
	})
}
