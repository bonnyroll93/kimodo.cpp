package main

// Kimodo Extended step 3: characters, joint mappings and retargeting through kmd-anim.
//   POST /api/characters                 raw GLB upload -> {"id":"upload:<hash>"}
//   GET  /api/retarget/map?character=&skeleton=   automatic mapping + diagnostics
//   POST /api/retarget/check             {character, skeleton, mapping} -> diagnostics
//   POST /api/retarget                   {root_motion, character, mapping?, align_rest?, root_scale?, yaw?}
//   GET  /api/retarget/<id>/{retarget.json,rotations.f32,translations.f32}

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const maxCharacterBytes = 128 << 20

// characterPath resolves "sample:<file>.glb" (sample rigs) and "upload:<hash>" (uploads).
func (c studioConfig) characterPath(id string) (string, bool) {
	switch {
	case strings.HasPrefix(id, "sample:"):
		name := strings.TrimPrefix(id, "sample:")
		if !safePathPart(name) || !strings.EqualFold(filepath.Ext(name), ".glb") {
			return "", false
		}
		path := filepath.Join(c.sampleRigs, name)
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			return path, true
		}
	case strings.HasPrefix(id, "upload:"):
		hash := strings.TrimPrefix(id, "upload:")
		if !safePathPart(hash) {
			return "", false
		}
		path := filepath.Join(c.output, "characters", hash+".glb")
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			return path, true
		}
	}
	return "", false
}

// runJSON runs kmd-anim and returns its stdout when it is JSON (map exits 1 on mapping errors
// but still prints the diagnostics).
func (c studioConfig) runJSON(ctx context.Context, args ...string) (json.RawMessage, *httpError) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, c.anim, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	if out := bytes.TrimSpace(stdout.Bytes()); len(out) > 0 && json.Valid(out) {
		return out, nil
	}
	message := strings.TrimSpace(stderr.String())
	if message == "" && err != nil {
		message = err.Error()
	}
	return nil, &httpError{http.StatusUnprocessableEntity, "kmd-anim: " + message}
}

// storeJSON writes client JSON (validated, compacted) under <output>/<kind>/<hash>.json and
// returns its path; identical content is stored once.
func (c studioConfig) storeJSON(kind string, raw json.RawMessage) (string, *httpError) {
	if len(raw) == 0 || !json.Valid(raw) {
		return "", &httpError{http.StatusBadRequest, kind + " must be valid JSON"}
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return "", &httpError{http.StatusBadRequest, err.Error()}
	}
	dir := filepath.Join(c.output, filepath.FromSlash(kind))
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", &httpError{http.StatusInternalServerError, err.Error()}
	}
	path := filepath.Join(dir, hashID(compact.String())+".json")
	if _, err := os.Stat(path); err != nil {
		if err := os.WriteFile(path, compact.Bytes(), 0644); err != nil {
			return "", &httpError{http.StatusInternalServerError, err.Error()}
		}
	}
	return path, nil
}

func (c studioConfig) storeMapping(mapping json.RawMessage) (string, *httpError) {
	return c.storeJSON("retarget/mappings", mapping)
}

type retargetResult struct {
	ID           string           `json:"id"`
	Meta         json.RawMessage  `json:"meta"`
	RootMotion   rootMotionResult `json:"root_motion"`
	Rotations    string           `json:"rotations"`
	Translations string           `json:"translations"`
	dir          string
}

// retarget applies the root motion step, then retargets onto the character (both cached).
func (c studioConfig) retarget(ctx context.Context, req retargetRequest) (retargetResult, *httpError) {
	character, ok := c.characterPath(req.Character)
	if !ok {
		return retargetResult{}, &httpError{http.StatusNotFound, "unknown character"}
	}
	if !finite(req.RootScale, req.Yaw) || req.RootScale < 0 || req.RootScale > 100 || math.Abs(req.Yaw) > 360 {
		return retargetResult{}, &httpError{http.StatusBadRequest, "root_scale must be 0..100 and yaw -360..360"}
	}
	motion, herr := c.rootMotion(ctx, req.RootMotion)
	if herr != nil {
		return retargetResult{}, herr
	}
	var extra []string
	if len(req.Mapping) > 0 && string(req.Mapping) != "null" {
		mappingPath, herr := c.storeMapping(req.Mapping)
		if herr != nil {
			return retargetResult{}, herr
		}
		extra = append(extra, "--mapping", mappingPath)
	}
	if req.AlignRest {
		extra = append(extra, "--align-rest")
	}
	if req.RootScale > 0 {
		extra = append(extra, "--root-scale", num(req.RootScale))
	}
	if req.Yaw != 0 {
		extra = append(extra, "--yaw", num(req.Yaw))
	}
	id := hashID(append([]string{motion.ID, req.Character}, extra...)...)
	dir := filepath.Join(c.output, "retarget", id)
	if herr := c.runCached(ctx, dir, "retarget.json", func(out string) []string {
		return append([]string{"retarget", motion.dir, character, out}, extra...)
	}); herr != nil {
		return retargetResult{}, herr
	}
	meta, err := os.ReadFile(filepath.Join(dir, "retarget.json"))
	if err != nil || !json.Valid(meta) {
		return retargetResult{}, &httpError{http.StatusInternalServerError, "invalid retarget result"}
	}
	return retargetResult{ID: id, Meta: meta, RootMotion: motion, dir: dir,
		Rotations: "/api/retarget/" + id + "/rotations.f32", Translations: "/api/retarget/" + id + "/translations.f32"}, nil
}

type retargetRequest struct {
	RootMotion rootMotionRequest `json:"root_motion"`
	Character  string            `json:"character"`
	Mapping    json.RawMessage   `json:"mapping,omitempty"`
	AlignRest  bool              `json:"align_rest,omitempty"`
	RootScale  float64           `json:"root_scale,omitempty"`
	Yaw        float64           `json:"yaw,omitempty"`
}

func registerRetarget(mux *http.ServeMux, c studioConfig) {
	mux.HandleFunc("/api/characters", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxCharacterBytes))
		if err != nil {
			writeError(w, http.StatusRequestEntityTooLarge, "character too large (max 128 MiB)")
			return
		}
		if len(data) < 12 || string(data[:4]) != "glTF" {
			writeError(w, http.StatusBadRequest, "only binary .glb characters can be uploaded")
			return
		}
		hash := hashID(string(data))
		dir := filepath.Join(c.output, "characters")
		path := filepath.Join(dir, hash+".glb")
		if _, err := os.Stat(path); err != nil {
			if err := os.MkdirAll(dir, 0755); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			tmp := path + ".tmp"
			if err := os.WriteFile(tmp, data, 0644); err != nil || os.Rename(tmp, path) != nil {
				_ = os.Remove(tmp)
				writeError(w, http.StatusInternalServerError, "cannot store character")
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "upload:" + hash})
	})

	// Uploaded characters, so a saved scene can reload them: /api/characters/<hash>.glb
	mux.HandleFunc("/api/characters/", func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/api/characters/")
		path, ok := c.characterPath("upload:" + strings.TrimSuffix(name, ".glb"))
		if !ok || !strings.HasSuffix(name, ".glb") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "model/gltf-binary")
		http.ServeFile(w, r, path)
	})

	mux.HandleFunc("/api/retarget/map", func(w http.ResponseWriter, r *http.Request) {
		path, ok := c.characterPath(r.URL.Query().Get("character"))
		key := r.URL.Query().Get("skeleton")
		if _, known := skeletonDefinitions[key]; !ok || !known {
			writeError(w, http.StatusNotFound, "unknown character or skeleton")
			return
		}
		out, herr := c.runJSON(r.Context(), "map", key, path)
		if herr != nil {
			writeError(w, herr.status, herr.message)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(out)
	})

	mux.HandleFunc("/api/retarget/check", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Character string          `json:"character"`
			Skeleton  string          `json:"skeleton"`
			Mapping   json.RawMessage `json:"mapping"`
		}
		if r.Method != http.MethodPost || json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req) != nil {
			writeError(w, http.StatusBadRequest, "POST {character, skeleton, mapping}")
			return
		}
		path, ok := c.characterPath(req.Character)
		if _, known := skeletonDefinitions[req.Skeleton]; !ok || !known {
			writeError(w, http.StatusNotFound, "unknown character or skeleton")
			return
		}
		mappingPath, herr := c.storeMapping(req.Mapping)
		if herr == nil {
			var out json.RawMessage
			if out, herr = c.runJSON(r.Context(), "map", req.Skeleton, path, "--mapping", mappingPath); herr == nil {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write(out)
				return
			}
		}
		writeError(w, herr.status, herr.message)
	})

	mux.HandleFunc("/api/retarget", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req retargetRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		res, herr := c.retarget(r.Context(), req)
		if herr != nil {
			writeError(w, herr.status, herr.message)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(res)
	})

	// The character in the T-pose the retargeting works from: the source skeleton's rest pose
	// (a T-pose for the native skeletons) retargeted with rest alignment.
	//   POST /api/retarget/tpose {character, skeleton, mapping?} -> {id, meta, rotations, translations}
	mux.HandleFunc("/api/retarget/tpose", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req struct {
			Character string          `json:"character"`
			Skeleton  string          `json:"skeleton"`
			Mapping   json.RawMessage `json:"mapping,omitempty"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		character, ok := c.characterPath(req.Character)
		if !ok {
			writeError(w, http.StatusNotFound, "unknown character")
			return
		}
		var source *studioMotion
		for _, m := range c.motions() {
			if m.SkeletonKey == req.Skeleton {
				source = &m
				break
			}
		}
		if source == nil {
			writeError(w, http.StatusNotFound, "no motion of skeleton "+req.Skeleton+" to take its rest pose from")
			return
		}
		extra := []string{"--rest-pose", "--align-rest"}
		key := []string{"tpose", req.Character, req.Skeleton}
		if len(req.Mapping) > 0 && string(req.Mapping) != "null" {
			mappingPath, herr := c.storeMapping(req.Mapping)
			if herr != nil {
				writeError(w, herr.status, herr.message)
				return
			}
			extra = append(extra, "--mapping", mappingPath)
			key = append(key, mappingPath)
		}
		id := hashID(key...)
		dir := filepath.Join(c.output, "retarget", id)
		if herr := c.runCached(r.Context(), dir, "retarget.json", func(out string) []string {
			return append([]string{"retarget", source.dir, character, out}, extra...)
		}); herr != nil {
			writeError(w, herr.status, herr.message)
			return
		}
		meta, err := os.ReadFile(filepath.Join(dir, "retarget.json"))
		if err != nil || !json.Valid(meta) {
			writeError(w, http.StatusInternalServerError, "invalid retarget result")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": id, "meta": json.RawMessage(meta),
			"rotations": "/api/retarget/" + id + "/rotations.f32", "translations": "/api/retarget/" + id + "/translations.f32"})
	})

	mux.HandleFunc("/api/retarget/", func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/retarget/"), "/")
		files := map[string]string{"retarget.json": "retarget.json", "rotations.f32": "local_rotations_xyzw.f32", "translations.f32": "local_translations.f32"}
		file, ok := "", false
		if len(parts) == 2 && safePathPart(parts[0]) && parts[0] != "mappings" {
			file, ok = files[parts[1]]
		}
		if !ok {
			http.NotFound(w, r)
			return
		}
		path := filepath.Join(c.output, "retarget", parts[0], file)
		if info, err := os.Stat(path); err != nil || !info.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		if strings.HasSuffix(file, ".f32") {
			w.Header().Set("Content-Type", "application/octet-stream")
		}
		http.ServeFile(w, r, path)
	})
}
