package main

// Kimodo Extended step 4: animation layer stacks baked by `kmd-anim layers`.
//   POST /api/layers   {character?, mapping?, align_rest?, layers:[{name, root_motion, mode, weight,
//                       mask: "full"|"upper"|"lower"|{custom mask JSON}, enabled, muted, reference, wrap}]}
//   GET  /api/layers/<id>/{clip.json,rotations.f32,translations.f32,root.f32}
// Every layer goes through the root-motion step and, with a character, the retarget step
// (both cached); the stack is then baked on the character's skeleton or, without a
// character, on the native skeleton of the motions.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type layerRequest struct {
	Name       string            `json:"name"`
	RootMotion rootMotionRequest `json:"root_motion"`
	Mode       string            `json:"mode"`               // override (default) | additive
	Weight     *float64          `json:"weight,omitempty"`   // default 1
	Mask       json.RawMessage   `json:"mask,omitempty"`     // preset name or custom mask object
	Enabled    *bool             `json:"enabled,omitempty"`  // default true
	Muted      bool              `json:"muted,omitempty"`
	Reference  string            `json:"reference,omitempty"` // first (default) | rest | frame index
	Wrap       string            `json:"wrap,omitempty"`      // clamp (default) | loop
}

type layersRequest struct {
	Character string          `json:"character,omitempty"`
	Mapping   json.RawMessage `json:"mapping,omitempty"`
	AlignRest bool            `json:"align_rest,omitempty"`
	Layers    []layerRequest  `json:"layers"`
}

type layerResult struct {
	RootMotion rootMotionResult `json:"root_motion"`
	Retarget   json.RawMessage  `json:"retarget,omitempty"` // retarget.json of this layer (with a character)
}

var frameIndex = regexp.MustCompile(`^[0-9]{1,6}$`)

// layerArgs validates one layer and returns its kmd-anim options (after --layer DIR).
func (c studioConfig) layerArgs(l layerRequest, index int) ([]string, *httpError) {
	bad := func(msg string) *httpError { return &httpError{http.StatusBadRequest, "layer " + num(float64(index+1)) + ": " + msg} }
	name := strings.TrimSpace(l.Name)
	if name == "" {
		name = "Layer " + num(float64(index+1))
	}
	if len(name) > 80 {
		return nil, bad("name too long")
	}
	args := []string{"--name", name}
	switch l.Mode {
	case "", "override":
	case "additive":
		args = append(args, "--mode", "additive")
	default:
		return nil, bad("mode must be override or additive")
	}
	if l.Weight != nil {
		if !finite(*l.Weight) || *l.Weight < 0 || *l.Weight > 1 {
			return nil, bad("weight must be in [0, 1]")
		}
		args = append(args, "--weight", num(*l.Weight))
	}
	if len(l.Mask) > 0 && string(l.Mask) != "null" {
		var preset string
		if json.Unmarshal(l.Mask, &preset) == nil {
			if preset != "full" && preset != "upper" && preset != "lower" {
				return nil, bad("mask preset must be full, upper or lower")
			}
			args = append(args, "--mask", preset)
		} else {
			path, herr := c.storeJSON("masks", l.Mask)
			if herr != nil {
				return nil, herr
			}
			args = append(args, "--mask", path)
		}
	}
	if l.Enabled != nil && !*l.Enabled {
		args = append(args, "--disabled")
	}
	if l.Muted {
		args = append(args, "--muted")
	}
	switch {
	case l.Reference == "" || l.Reference == "first":
	case l.Reference == "rest" || frameIndex.MatchString(l.Reference):
		args = append(args, "--reference", l.Reference)
	default:
		return nil, bad("reference must be first, rest or a frame index")
	}
	switch l.Wrap {
	case "", "clamp":
	case "loop":
		args = append(args, "--wrap", "loop")
	default:
		return nil, bad("wrap must be clamp or loop")
	}
	return args, nil
}

func registerLayers(mux *http.ServeMux, c studioConfig) {
	mux.HandleFunc("/api/layers", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req layersRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<21)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		if len(req.Layers) == 0 || len(req.Layers) > 16 {
			writeError(w, http.StatusBadRequest, "a stack needs 1 to 16 layers")
			return
		}
		args := []string{}
		key := []string{req.Character}
		var characterPath, skeleton string
		if req.Character != "" {
			path, ok := c.characterPath(req.Character)
			if !ok {
				writeError(w, http.StatusNotFound, "unknown character")
				return
			}
			characterPath = path
		}
		results := make([]layerResult, len(req.Layers))
		layerArgs := []string{}
		for i, l := range req.Layers {
			var dir string
			if req.Character != "" {
				rt, herr := c.retarget(r.Context(), retargetRequest{RootMotion: l.RootMotion, Character: req.Character, Mapping: req.Mapping, AlignRest: req.AlignRest})
				if herr != nil {
					writeError(w, herr.status, "layer "+num(float64(i+1))+": "+herr.message)
					return
				}
				dir, results[i] = rt.dir, layerResult{RootMotion: rt.RootMotion, Retarget: rt.Meta}
			} else {
				rm, herr := c.rootMotion(r.Context(), l.RootMotion)
				if herr != nil {
					writeError(w, herr.status, "layer "+num(float64(i+1))+": "+herr.message)
					return
				}
				if skeleton == "" {
					skeleton = rm.SkeletonKey
				} else if rm.SkeletonKey != skeleton {
					writeError(w, http.StatusBadRequest, "without a character all layers must use the same skeleton")
					return
				}
				dir, results[i] = rm.dir, layerResult{RootMotion: rm}
			}
			opts, herr := c.layerArgs(l, i)
			if herr != nil {
				writeError(w, herr.status, herr.message)
				return
			}
			layerArgs = append(append(layerArgs, "--layer", dir), opts...)
			key = append(key, dir)
			key = append(key, opts...)
		}
		if characterPath != "" {
			args = append(args, "--character", characterPath)
		} else {
			args = append(args, "--native", skeleton)
		}
		args = append(args, layerArgs...)
		id := hashID(append(key, args...)...)
		dir := filepath.Join(c.output, "layers", id)
		if herr := c.runCached(r.Context(), dir, "clip.json", func(out string) []string {
			return append([]string{"layers", out}, args...)
		}); herr != nil {
			writeError(w, herr.status, herr.message)
			return
		}
		meta, err := os.ReadFile(filepath.Join(dir, "clip.json"))
		if err != nil || !json.Valid(meta) {
			writeError(w, http.StatusInternalServerError, "invalid layer stack result")
			return
		}
		res := map[string]any{
			"id": id, "meta": json.RawMessage(meta), "layers": results, "native": characterPath == "",
			"rotations":    "/api/layers/" + id + "/rotations.f32",
			"translations": "/api/layers/" + id + "/translations.f32",
		}
		if characterPath == "" {
			res["root"] = "/api/layers/" + id + "/root.f32"
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(res)
	})

	mux.HandleFunc("/api/layers/", func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/layers/"), "/")
		files := map[string]string{"clip.json": "clip.json", "rotations.f32": "local_rotations_xyzw.f32",
			"translations.f32": "local_translations.f32", "root.f32": "root_positions.f32"}
		file, ok := "", false
		if len(parts) == 2 && safePathPart(parts[0]) {
			file, ok = files[parts[1]]
		}
		if !ok {
			http.NotFound(w, r)
			return
		}
		path := filepath.Join(c.output, "layers", parts[0], file)
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

