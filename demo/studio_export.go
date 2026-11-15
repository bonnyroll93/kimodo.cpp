package main

// Kimodo Extended step 5: export the character with the final clip as one GLB.
//   POST /api/export   {name?, character, mapping?, align_rest?, layers:[...]}   (same stack as /api/layers)
//   GET  /api/export/<id>/<file>.glb[?download=1]
// The stack is baked (cached), then `kmd-anim export` copies the character GLB unchanged
// and appends the clip as an animation.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type exportRequest struct {
	layersRequest
	Name string `json:"name,omitempty"`
}

var exportName = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func registerExport(mux *http.ServeMux, c studioConfig) {
	mux.HandleFunc("/api/export", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req exportRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<21)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		if req.Character == "" {
			writeError(w, http.StatusBadRequest, "export needs a character (retarget onto a loaded GLB first)")
			return
		}
		name := strings.Trim(exportName.ReplaceAllString(req.Name, "_"), "._")
		if name == "" {
			name = "Kimodo"
		}
		if len(name) > 60 {
			name = name[:60]
		}
		stack, herr := c.layers(r.Context(), req.layersRequest)
		if herr != nil {
			writeError(w, herr.status, herr.message)
			return
		}
		id := hashID("export", stack.id, stack.characterPath, name)
		dir := filepath.Join(c.output, "exports", id)
		file := name + ".glb"
		if herr := c.runCached(r.Context(), dir, file, func(out string) []string {
			return []string{"export", stack.characterPath, stack.dir, filepath.Join(out, file), "--name", name}
		}); herr != nil {
			writeError(w, herr.status, herr.message)
			return
		}
		info, err := os.Stat(filepath.Join(dir, file))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "export missing")
			return
		}
		url := "/api/export/" + id + "/" + file
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": id, "name": name, "bytes": info.Size(), "url": url, "download": url + "?download=1",
			"meta": stack.body["meta"],
		})
	})

	mux.HandleFunc("/api/export/", func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/export/"), "/")
		if len(parts) != 2 || !safePathPart(parts[0]) || !safePathPart(parts[1]) || !strings.HasSuffix(parts[1], ".glb") {
			http.NotFound(w, r)
			return
		}
		path := filepath.Join(c.output, "exports", parts[0], parts[1])
		if info, err := os.Stat(path); err != nil || !info.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "model/gltf-binary")
		w.Header().Set("Cache-Control", "no-store")
		if r.URL.Query().Get("download") == "1" {
			w.Header().Set("Content-Disposition", `attachment; filename="`+parts[1]+`"`)
		}
		http.ServeFile(w, r, path)
	})
}
