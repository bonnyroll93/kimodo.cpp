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
	"strings"
	"testing"
)

func TestLayersEndpoint(t *testing.T) {
	exe := builtAnimTool(t)
	mux := http.NewServeMux()
	registerStudio(mux, studioConfig{sampleRigs: "../tests/data/rigs", sampleMotions: "../tests/data/baseline", output: t.TempDir(), anim: exe})
	post := func(body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/layers", strings.NewReader(body)))
		return rec
	}
	get := func(path string) []byte {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: %d", path, rec.Code)
		}
		return rec.Body.Bytes()
	}
	type result struct {
		Meta struct {
			Frames   int                     `json:"frames"`
			Joints   []struct{ Name string } `json:"joints"`
			Duration float64                 `json:"duration"`
			Layers   []struct {
				Name  string `json:"name"`
				Mask  string `json:"mask"`
				Muted bool   `json:"muted"`
			} `json:"layers"`
		} `json:"meta"`
		Native       bool   `json:"native"`
		Root         string `json:"root"`
		Rotations    string `json:"rotations"`
		Translations string `json:"translations"`
		Layers       []struct {
			Retarget json.RawMessage `json:"retarget"`
		} `json:"layers"`
	}
	decode := func(rec *httptest.ResponseRecorder) result {
		var r result
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &r) != nil {
			t.Fatalf("layers: %d %s", rec.Code, rec.Body.String())
		}
		return r
	}

	// Native stack: base walk + muted in-place upper-body layer. A base-only result equals the walk.
	walk := `{"source":"sample:soma30-walk-s42","mode":"full"}`
	r := decode(post(`{"layers":[{"name":"base","root_motion":` + walk + `},
		{"name":"arms","root_motion":{"source":"sample:soma30-walk-s42","mode":"inplace"},"mode":"additive","weight":0.5,"mask":"upper","muted":true}]}`))
	if !r.Native || r.Meta.Frames != 90 || len(r.Meta.Layers) != 2 || r.Meta.Layers[1].Mask != "upper" || !r.Meta.Layers[1].Muted {
		t.Fatalf("native stack meta: %+v", r)
	}
	original, _ := os.ReadFile(filepath.Join("..", "tests", "data", "baseline", "soma30-walk-s42", "local_rotations_xyzw.f32"))
	if !bytes.Equal(get(r.Rotations), original) {
		t.Fatal("base + muted layer differs from the walk")
	}
	if len(get(r.Root)) != 90*12 {
		t.Fatal("native stack root size")
	}

	// Scene root motion: two walks in sequence made in place as a whole (the second root
	// aligned), then an override keyframe layer bound to [1, 2] s.
	srec := post(`{"scene_root":{"mode":"inplace"},"layers":[{"name":"a","root_motion":` + walk + `,"timing":{"extend":"none"}},
		{"name":"b","root_motion":` + walk + `,"timing":{"start":2.9,"empty_before":true,"fade_in":0.067,"align_root":true}},
		{"name":"k","mode":"override","keys":{"version":1,"fps":30,"tracks":{"LeftForeArm":{"rx":[{"f":0,"v":30}]}}},"timing":{"start":1,"end":2,"empty_before":true}}]}`)
	var scene struct {
		Meta struct {
			Frames int `json:"frames"`
			Layers []struct {
				Name string `json:"name"`
			} `json:"layers"`
		} `json:"meta"`
		Root  string `json:"root"`
		Scene struct {
			Root string `json:"root"`
			Meta struct {
				Layers []struct {
					Duration float64 `json:"duration"`
				} `json:"layers"`
			} `json:"meta"`
		} `json:"scene"`
	}
	if srec.Code != http.StatusOK || json.Unmarshal(srec.Body.Bytes(), &scene) != nil {
		t.Fatalf("scene root: %d %s", srec.Code, srec.Body.String())
	}
	if len(scene.Meta.Layers) != 2 || scene.Meta.Layers[0].Name != "Scene" || len(scene.Scene.Meta.Layers) != 2 || scene.Meta.Frames < 170 {
		t.Fatalf("scene root meta: %+v", scene)
	}
	root := get(scene.Root)
	f32 := func(b []byte, i int) float32 {
		return math.Float32frombits(binary.LittleEndian.Uint32(b[i*4:]))
	}
	last := len(root)/12 - 1
	if dx, dz := f32(root, last*3)-f32(root, 0), f32(root, last*3+2)-f32(root, 2); dx*dx+dz*dz > 1e-6 {
		t.Fatalf("scene in place still travels: %v %v", dx, dz)
	}
	if len(get(scene.Scene.Root)) != len(root) {
		t.Fatal("scene source root size")
	}

	// Character stack with a custom mask object.
	r = decode(post(`{"character":"sample:test_rig.glb","layers":[{"root_motion":` + walk + `},
		{"name":"left arm","root_motion":{"source":"sample:soma30-walk-s42","mode":"inplace"},"mask":{"version":1,"name":"left arm","default":0,"weights":{"LeftArm":1,"LeftForeArm":0.5}}}]}`))
	if r.Native || r.Meta.Frames != 90 || len(r.Meta.Joints) != 20 || r.Meta.Layers[1].Mask != "left arm" || len(r.Layers[0].Retarget) == 0 {
		t.Fatalf("character stack meta: %+v", r)
	}
	if len(get(r.Rotations)) != 90*20*16 || len(get(r.Translations)) != 90*20*12 {
		t.Fatal("character stack arrays")
	}

	// Foot locking on the character stack: contacts and slide statistics in the metadata.
	rec := post(`{"character":"sample:test_rig.glb","foot_lock":{"enabled":true},"layers":[{"root_motion":` + walk + `}]}`)
	var locked struct {
		Meta struct {
			FootLock struct {
				Contacts    []struct{ Foot string } `json:"contacts"`
				SlideBefore float64                 `json:"slide_before"`
				SlideAfter  float64                 `json:"slide_after"`
			} `json:"foot_lock"`
		} `json:"meta"`
	}
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &locked) != nil || len(locked.Meta.FootLock.Contacts) == 0 ||
		locked.Meta.FootLock.SlideAfter >= locked.Meta.FootLock.SlideBefore || locked.Meta.FootLock.SlideAfter > 1e-3 {
		t.Fatalf("foot lock: %d %s", rec.Code, rec.Body.String())
	}

	// Preset masks match the C++ definitions (legs out of the upper body).
	maskRec := httptest.NewRecorder()
	mux.ServeHTTP(maskRec, httptest.NewRequest(http.MethodGet, "/api/masks?character=sample:test_rig.glb", nil))
	var presets struct {
		Upper struct {
			Weights map[string]float64 `json:"weights"`
		} `json:"upper"`
	}
	if maskRec.Code != http.StatusOK || json.Unmarshal(maskRec.Body.Bytes(), &presets) != nil ||
		presets.Upper.Weights["LeftUpLeg"] != 0 || presets.Upper.Weights["LeftHand"] != 1 {
		t.Fatalf("masks: %d %s", maskRec.Code, maskRec.Body.String())
	}

	// Keyframe layer on top of the character stack: a 45 degree forearm offset.
	keyed := post(`{"character":"sample:test_rig.glb","layers":[{"root_motion":` + walk + `},
		{"name":"pose fix","keys":{"version":1,"fps":30,"tracks":{"LeftForeArm":{"rx":[{"f":0,"v":45}]}}}}]}`)
	var keyedRes struct {
		Meta struct {
			Layers []struct {
				Keys bool   `json:"keys"`
				Mode string `json:"mode"`
			} `json:"layers"`
		} `json:"meta"`
	}
	if keyed.Code != http.StatusOK || json.Unmarshal(keyed.Body.Bytes(), &keyedRes) != nil || len(keyedRes.Meta.Layers) != 2 ||
		!keyedRes.Meta.Layers[1].Keys || keyedRes.Meta.Layers[1].Mode != "additive" {
		t.Fatalf("keyframe layer: %d %s", keyed.Code, keyed.Body.String())
	}
	// Clip timing: a walk sequenced after itself (2x speed, root aligned) doubles... the timeline length.
	seq := post(`{"layers":[{"root_motion":` + walk + `,"timing":{"extend":"none"}},
		{"root_motion":` + walk + `,"timing":{"start":2.9666667,"speed":2,"align_root":true}}]}`)
	var seqRes struct {
		Meta struct {
			Frames   int     `json:"frames"`
			Duration float64 `json:"duration"`
		} `json:"meta"`
	}
	if seq.Code != http.StatusOK || json.Unmarshal(seq.Body.Bytes(), &seqRes) != nil || seqRes.Meta.Frames != 135 {
		t.Fatalf("clip timing: %d %s", seq.Code, seq.Body.String())
	}
	if rec := post(`{"layers":[{"root_motion":` + walk + `,"timing":{"speed":-1}}]}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("negative speed accepted: %d", rec.Code)
	}
	if rec := post(`{"layers":[{"keys":{"version":1,"tracks":{}}}]}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("native stack of keys only: %d", rec.Code)
	}
	if rec := post(`{"character":"sample:test_rig.glb","layers":[{"keys":{"version":1,"tracks":{"Hips":{"rx":[{"f":0,"v":1,"i":"cubic"}]}}}}]}`); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid keys: %d %s", rec.Code, rec.Body.String())
	}

	for _, bad := range []string{
		`{"foot_lock":{"enabled":true,"height":-1},"layers":[{"root_motion":` + walk + `}]}`,
		`{"layers":[]}`,
		`{"layers":[{"root_motion":` + walk + `,"weight":1.5}]}`,
		`{"layers":[{"root_motion":` + walk + `,"mode":"multiply"}]}`,
		`{"layers":[{"root_motion":` + walk + `,"mask":"head"}]}`,
		`{"layers":[{"root_motion":` + walk + `,"reference":"../x"}]}`,
		`{"character":"sample:nope.glb","layers":[{"root_motion":` + walk + `}]}`,
	} {
		if rec := post(bad); rec.Code == http.StatusOK {
			t.Fatalf("accepted invalid stack %s", bad)
		}
	}
	// A mask that kmd-anim rejects reaches the client as an error.
	if rec := post(`{"layers":[{"root_motion":` + walk + `,"mask":{"weights":{"Hips":3}}}]}`); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid mask weights: %d %s", rec.Code, rec.Body.String())
	}
}
