package main

// Kimodo Extended studio: a Three.js character viewer served next to the original demo.
// It is additive: the original routes and generation worker are untouched.

import (
	"embed"
	"encoding/json"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

//go:embed studio
var studioFiles embed.FS

type studioConfig struct {
	sampleRigs    string                // *.glb characters offered under /studio/samples/
	sampleMotions string                // kmd-generate output directories offered as motion sources
	output        string                // demo output directory (root-motion results go below it)
	anim          string                // kmd-anim executable
	blender       string                // Blender executable for FBX import / export ("" = unavailable)
	animations    func() []studioMotion // ready gallery animations, may be nil
	// deleteAnimation removes a generated animation (gallery entry and files), may be nil.
	deleteAnimation func(id string) error
}

// registerStudio serves the viewer under /studio/, the sample rigs (read-only, *.glb only)
// under /studio/samples/, and the step 2 motion and root-motion endpoints.
func registerStudio(mux *http.ServeMux, c studioConfig) {
	sampleRigs := c.sampleRigs
	setToolVersion(c.anim)
	registerRootMotion(mux, c)
	registerRetarget(mux, c)
	registerLayers(mux, c)
	registerExport(mux, c)
	registerFBX(mux, c)
	registerTakesExport(mux, c)
	registerLibrary(mux, c)
	sub, err := fs.Sub(studioFiles, "studio")
	if err != nil {
		panic(err)
	}
	static := http.StripPrefix("/studio/", http.FileServer(http.FS(sub)))
	mux.HandleFunc("/studio", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/studio/", http.StatusMovedPermanently)
	})
	mux.HandleFunc("/studio/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		static.ServeHTTP(w, r)
	})
	mux.HandleFunc("/studio/samples/", func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/studio/samples/")
		if name == "" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(sampleList(sampleRigs))
			return
		}
		if !safePathPart(name) || !strings.EqualFold(filepath.Ext(name), ".glb") {
			http.NotFound(w, r)
			return
		}
		path := filepath.Join(sampleRigs, name)
		if info, err := os.Stat(path); err != nil || !info.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "model/gltf-binary")
		w.Header().Set("Cache-Control", "no-store")
		http.ServeFile(w, r, path)
	})
}

func sampleList(dir string) []byte {
	entries, _ := os.ReadDir(dir)
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.Type().IsRegular() && strings.EqualFold(filepath.Ext(entry.Name()), ".glb") && safePathPart(entry.Name()) {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	b, _ := json.Marshal(names)
	return b
}
