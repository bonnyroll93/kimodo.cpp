package main

// Kimodo Extended step 4: animation layer stacks baked by `kmd-anim layers`.
//   POST /api/layers   {character?, mapping?, align_rest?, layers:[{name, root_motion, mode, weight,
//                       mask: "full"|"upper"|"lower"|{custom mask JSON}, enabled, muted, reference, wrap}]}
//   GET  /api/layers/<id>/{clip.json,rotations.f32,translations.f32,root.f32}
// Every layer goes through the root-motion step and, with a character, the retarget step
// (both cached); the stack is then baked on the character's skeleton or, without a
// character, on the native skeleton of the motions.

import (
	"context"
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
	Mode       string            `json:"mode"`              // override (default) | additive
	Weight     *float64          `json:"weight,omitempty"`  // default 1
	Mask       json.RawMessage   `json:"mask,omitempty"`    // preset name or custom mask object
	Enabled    *bool             `json:"enabled,omitempty"` // default true
	Muted      bool              `json:"muted,omitempty"`
	Reference  string            `json:"reference,omitempty"` // first (default) | rest | frame index
	Wrap       string            `json:"wrap,omitempty"`      // clamp (default) | loop
	Keys       json.RawMessage   `json:"keys,omitempty"`      // keyframe layer: offset curves instead of a motion
	Timing     *clipTiming       `json:"timing,omitempty"`    // where/how the clip plays on the timeline
}

type clipTiming struct {
	Start     float64 `json:"start"`
	TrimIn    float64 `json:"trim_in"`
	TrimOut   float64 `json:"trim_out"`
	Speed     float64 `json:"speed"`
	Repeat    int     `json:"repeat"`
	Extend    string  `json:"extend"` // hold (default) | none
	FadeIn    float64 `json:"fade_in"`
	FadeOut   float64 `json:"fade_out"`
	AlignRoot bool    `json:"align_root"`
}

func timingArgs(t *clipTiming) ([]string, string) {
	if t == nil {
		return nil, ""
	}
	if !finite(t.Start, t.TrimIn, t.TrimOut, t.Speed, t.FadeIn, t.FadeOut) || t.Start < -3600 || t.Start > 3600 ||
		t.TrimIn < 0 || t.TrimOut < 0 || t.FadeIn < 0 || t.FadeOut < 0 || t.FadeIn > 3600 || t.FadeOut > 3600 {
		return nil, "timing values out of range"
	}
	var args []string
	add := func(flag string, v float64, def float64) {
		if v != def {
			args = append(args, flag, num(v))
		}
	}
	add("--start", t.Start, 0)
	add("--trim-in", t.TrimIn, 0)
	add("--trim-out", t.TrimOut, 0)
	if t.Speed != 0 {
		if t.Speed < 0.05 || t.Speed > 20 {
			return nil, "speed must be 0.05..20"
		}
		add("--speed", t.Speed, 1)
	}
	if t.Repeat != 0 {
		if t.Repeat < 1 || t.Repeat > 100 {
			return nil, "repeat must be 1..100"
		}
		add("--repeat", float64(t.Repeat), 1)
	}
	switch t.Extend {
	case "", "hold":
	case "none":
		args = append(args, "--extend", "none")
	default:
		return nil, "extend must be hold or none"
	}
	add("--fade-in", t.FadeIn, 0)
	add("--fade-out", t.FadeOut, 0)
	if t.AlignRoot {
		args = append(args, "--align-root")
	}
	return args, ""
}

type footLockRequest struct {
	Enabled    bool    `json:"enabled"`
	Height     float64 `json:"height,omitempty"`      // contact height threshold, m (0 = auto)
	Speed      float64 `json:"speed,omitempty"`       // contact speed threshold, m/s (0 = auto)
	Blend      *int    `json:"blend,omitempty"`       // blend frames (default 4)
	AdjustHips *bool   `json:"adjust_hips,omitempty"` // default true
}

type layersRequest struct {
	Character string           `json:"character,omitempty"`
	Mapping   json.RawMessage  `json:"mapping,omitempty"`
	AlignRest bool             `json:"align_rest,omitempty"`
	Layers    []layerRequest   `json:"layers"`
	FootLock  *footLockRequest `json:"foot_lock,omitempty"`
}

// footLockArgs validates the foot-lock options and returns kmd-anim layers flags.
func footLockArgs(f *footLockRequest) ([]string, *httpError) {
	if f == nil || !f.Enabled {
		return nil, nil
	}
	if !finite(f.Height, f.Speed) || f.Height < 0 || f.Height > 1 || f.Speed < 0 || f.Speed > 20 {
		return nil, &httpError{http.StatusBadRequest, "foot lock: height must be 0..1 m and speed 0..20 m/s"}
	}
	args := []string{"--foot-lock"}
	if f.Height > 0 {
		args = append(args, "--foot-height", num(f.Height))
	}
	if f.Speed > 0 {
		args = append(args, "--foot-speed", num(f.Speed))
	}
	if f.Blend != nil {
		if *f.Blend < 0 || *f.Blend > 30 {
			return nil, &httpError{http.StatusBadRequest, "foot lock: blend must be 0..30 frames"}
		}
		args = append(args, "--foot-blend", num(float64(*f.Blend)))
	}
	if f.AdjustHips != nil && !*f.AdjustHips {
		args = append(args, "--no-hip-adjust")
	}
	return args, nil
}

type layerResult struct {
	RootMotion rootMotionResult `json:"root_motion"`
	Retarget   json.RawMessage  `json:"retarget,omitempty"` // retarget.json of this layer (with a character)
}

var frameIndex = regexp.MustCompile(`^[0-9]{1,6}$`)

// layerArgs validates one layer and returns its kmd-anim options (after --layer DIR).
func (c studioConfig) layerArgs(l layerRequest, index int) ([]string, *httpError) {
	bad := func(msg string) *httpError {
		return &httpError{http.StatusBadRequest, "layer " + num(float64(index+1)) + ": " + msg}
	}
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
	timing, msg := timingArgs(l.Timing)
	if msg != "" {
		return nil, bad(msg)
	}
	args = append(args, timing...)
	return args, nil
}

type layersResult struct {
	id, dir, characterPath string
	body                   map[string]any
}

// layers runs every layer through root motion (+ retarget with a character) and bakes the
// stack with kmd-anim layers (all steps cached by request hash).
func (c studioConfig) layers(ctx context.Context, req layersRequest) (layersResult, *httpError) {
	if len(req.Layers) == 0 || len(req.Layers) > 16 {
		return layersResult{}, &httpError{http.StatusBadRequest, "a stack needs 1 to 16 layers"}
	}
	args := []string{}
	key := []string{req.Character}
	var characterPath, skeleton string
	if req.Character != "" {
		path, ok := c.characterPath(req.Character)
		if !ok {
			return layersResult{}, &httpError{http.StatusNotFound, "unknown character"}
		}
		characterPath = path
	}
	results := make([]layerResult, len(req.Layers))
	layerArgs := []string{}
	for i, l := range req.Layers {
		prefix := "layer " + num(float64(i+1)) + ": "
		var dir string
		if len(l.Keys) > 0 && string(l.Keys) != "null" {
			// Keyframe layer: curves stored by content hash, sampled by kmd-anim on the stack skeleton.
			path, herr := c.storeJSON("keys", l.Keys)
			if herr != nil {
				return layersResult{}, &httpError{herr.status, prefix + herr.message}
			}
			opts, herr := c.layerArgs(l, i)
			if herr != nil {
				return layersResult{}, herr
			}
			layerArgs = append(append(layerArgs, "--key-layer", path), opts...)
			key = append(append(key, path), opts...)
			continue
		}
		if req.Character != "" {
			rt, herr := c.retarget(ctx, retargetRequest{RootMotion: l.RootMotion, Character: req.Character, Mapping: req.Mapping, AlignRest: req.AlignRest})
			if herr != nil {
				return layersResult{}, &httpError{herr.status, prefix + herr.message}
			}
			dir, results[i] = rt.dir, layerResult{RootMotion: rt.RootMotion, Retarget: rt.Meta}
		} else {
			rm, herr := c.rootMotion(ctx, l.RootMotion)
			if herr != nil {
				return layersResult{}, &httpError{herr.status, prefix + herr.message}
			}
			if skeleton == "" {
				skeleton = rm.SkeletonKey
			} else if rm.SkeletonKey != skeleton {
				return layersResult{}, &httpError{http.StatusBadRequest, "without a character all layers must use the same skeleton"}
			}
			dir, results[i] = rm.dir, layerResult{RootMotion: rm}
		}
		opts, herr := c.layerArgs(l, i)
		if herr != nil {
			return layersResult{}, herr
		}
		layerArgs = append(append(layerArgs, "--layer", dir), opts...)
		key = append(append(key, dir), opts...)
	}
	if characterPath != "" {
		args = append(args, "--character", characterPath)
	} else if skeleton == "" {
		return layersResult{}, &httpError{http.StatusBadRequest, "without a character the stack needs at least one motion layer"}
	} else {
		args = append(args, "--native", skeleton)
	}
	args = append(args, layerArgs...)
	footArgs, herr := footLockArgs(req.FootLock)
	if herr != nil {
		return layersResult{}, herr
	}
	args = append(args, footArgs...)
	id := hashID(append(key, args...)...)
	dir := filepath.Join(c.output, "layers", id)
	if herr := c.runCached(ctx, dir, "clip.json", func(out string) []string {
		return append([]string{"layers", out}, args...)
	}); herr != nil {
		return layersResult{}, herr
	}
	meta, err := os.ReadFile(filepath.Join(dir, "clip.json"))
	if err != nil || !json.Valid(meta) {
		return layersResult{}, &httpError{http.StatusInternalServerError, "invalid layer stack result"}
	}
	body := map[string]any{
		"id": id, "meta": json.RawMessage(meta), "layers": results, "native": characterPath == "",
		"rotations":    "/api/layers/" + id + "/rotations.f32",
		"translations": "/api/layers/" + id + "/translations.f32",
	}
	if characterPath == "" {
		body["root"] = "/api/layers/" + id + "/root.f32"
	}
	return layersResult{id: id, dir: dir, characterPath: characterPath, body: body}, nil
}

func registerLayers(mux *http.ServeMux, c studioConfig) {
	// Preset masks (full / upper / lower) for a character or a native skeleton.
	mux.HandleFunc("/api/masks", func(w http.ResponseWriter, r *http.Request) {
		var args []string
		if id := r.URL.Query().Get("character"); id != "" {
			path, ok := c.characterPath(id)
			if !ok {
				writeError(w, http.StatusNotFound, "unknown character")
				return
			}
			args = []string{"masks", "--character", path}
		} else if key := r.URL.Query().Get("skeleton"); key != "" {
			if _, ok := skeletonDefinitions[key]; !ok {
				writeError(w, http.StatusNotFound, "unknown skeleton")
				return
			}
			args = []string{"masks", "--native", key}
		} else {
			writeError(w, http.StatusBadRequest, "character or skeleton is required")
			return
		}
		out, herr := c.runJSON(r.Context(), args...)
		if herr != nil {
			writeError(w, herr.status, herr.message)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(out)
	})

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
		res, herr := c.layers(r.Context(), req)
		if herr != nil {
			writeError(w, herr.status, herr.message)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(res.body)
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
