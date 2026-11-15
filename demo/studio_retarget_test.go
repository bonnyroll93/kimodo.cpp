package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func builtAnimTool(t *testing.T) string {
	t.Helper()
	for _, candidate := range []string{"../build/Release/kmd-anim", "../build/release/kmd-anim", "../build/debug/kmd-anim", "../build/kmd-anim"} {
		if runtime.GOOS == "windows" {
			candidate += ".exe"
		}
		if _, err := os.Stat(candidate); err == nil {
			abs, _ := filepath.Abs(candidate)
			return abs
		}
	}
	t.Skip("kmd-anim not built")
	return ""
}

func TestRetargetEndpoints(t *testing.T) {
	exe := builtAnimTool(t)
	mux := http.NewServeMux()
	registerStudio(mux, studioConfig{sampleRigs: "../tests/data/rigs", sampleMotions: "../tests/data/baseline", output: t.TempDir(), anim: exe})
	do := func(method, path string, body []byte) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(method, path, bytes.NewReader(body)))
		return rec
	}

	// Automatic mapping for the sample rig.
	rec := do(http.MethodGet, "/api/retarget/map?character=sample:test_rig.glb&skeleton=soma30", nil)
	var mapped struct {
		Mapping  json.RawMessage `json:"mapping"`
		Errors   []string        `json:"errors"`
		Warnings []string        `json:"warnings"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &mapped); err != nil || rec.Code != http.StatusOK || len(mapped.Errors) != 0 {
		t.Fatalf("map: %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(string(mapped.Mapping), `"source": "LeftShin"`) {
		t.Fatalf("auto mapping misses LeftLeg<-LeftShin: %s", mapped.Mapping)
	}

	// T-pose preview of the A-pose rig: one frame, joints in the character's order.
	rec = do(http.MethodPost, "/api/retarget/tpose", []byte(`{"character":"sample:test_rig_mixamo_apose.glb","skeleton":"soma30"}`))
	var tpose struct {
		Meta struct {
			Frames int `json:"frames"`
		} `json:"meta"`
		Rotations string `json:"rotations"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &tpose); err != nil || rec.Code != http.StatusOK || tpose.Meta.Frames != 1 {
		t.Fatalf("tpose: %d %s", rec.Code, rec.Body.String())
	}
	if rec = do(http.MethodGet, tpose.Rotations, nil); rec.Code != http.StatusOK || rec.Body.Len() == 0 {
		t.Fatalf("tpose rotations: %d", rec.Code)
	}
	// A hand-edited reference pose is used as is (here: the left upper arm at identity).
	pose := `{"format":"kimodo-reference-pose","version":1,"joints":{"mixamorig:LeftArm":[0,0,0,1]}}`
	rec = do(http.MethodPost, "/api/retarget/tpose", []byte(`{"character":"sample:test_rig_mixamo_apose.glb","skeleton":"soma30","reference_pose":`+pose+`}`))
	var edited struct {
		Rotations string `json:"rotations"`
	}
	if json.Unmarshal(rec.Body.Bytes(), &edited) != nil || rec.Code != http.StatusOK || edited.Rotations == tpose.Rotations {
		t.Fatalf("tpose with reference pose: %d %s", rec.Code, rec.Body.String())
	}
	if rec = do(http.MethodPost, "/api/retarget/tpose", []byte(`{"character":"sample:test_rig_mixamo_apose.glb","skeleton":"soma30","reference_pose":{"joints":{"x":[1,2]}}}`)); rec.Code == http.StatusOK {
		t.Fatal("invalid reference pose accepted")
	}

	// Upload the same rig and retarget with the explicit mapping.
	glb, err := os.ReadFile("../tests/data/rigs/test_rig.glb")
	if err != nil {
		t.Fatal(err)
	}
	rec = do(http.MethodPost, "/api/characters", glb)
	var uploaded map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &uploaded); err != nil || !strings.HasPrefix(uploaded["id"], "upload:") {
		t.Fatalf("upload: %d %s", rec.Code, rec.Body.String())
	}
	if got := do(http.MethodGet, "/api/characters/"+strings.TrimPrefix(uploaded["id"], "upload:")+".glb", nil); got.Code != http.StatusOK || !bytes.Equal(got.Body.Bytes(), glb) {
		t.Fatalf("uploaded character not served back: %d", got.Code)
	}
	if got := do(http.MethodGet, "/api/characters/nope.glb", nil); got.Code != http.StatusNotFound {
		t.Fatalf("unknown upload: %d", got.Code)
	}
	if rec := do(http.MethodPost, "/api/characters", []byte("not a glb file")); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad upload accepted: %d", rec.Code)
	}
	body, _ := json.Marshal(map[string]any{
		"root_motion": map[string]any{"source": "sample:soma30-walk-s42", "mode": "inplace"},
		"character":   uploaded["id"], "mapping": mapped.Mapping,
	})
	rec = do(http.MethodPost, "/api/retarget", body)
	var result struct {
		ID   string `json:"id"`
		Meta struct {
			Frames           int     `json:"frames"`
			TranslationJoint int     `json:"translation_joint"`
			RootScale        float64 `json:"root_scale"`
			Joints           []struct {
				Name       string `json:"name"`
				SourceNode int    `json:"source_node"`
			} `json:"joints"`
		} `json:"meta"`
		Rotations    string `json:"rotations"`
		Translations string `json:"translations"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("retarget: %d %s", rec.Code, rec.Body.String())
	}
	if result.Meta.Frames != 90 || len(result.Meta.Joints) != 20 || result.Meta.Joints[0].Name != "Hips" || result.Meta.RootScale <= 0 {
		t.Fatalf("unexpected retarget meta: %+v", result.Meta)
	}
	if n := do(http.MethodGet, result.Rotations, nil).Body.Len(); n != 90*20*16 {
		t.Fatalf("rotations: %d bytes", n)
	}
	if n := do(http.MethodGet, result.Translations, nil).Body.Len(); n != 90*20*12 {
		t.Fatalf("translations: %d bytes", n)
	}

	// Diagnostics for a broken mapping, and a retarget refused with a readable error.
	broken := []byte(`{"version":1,"joints":[{"target":"LeftArm","source":"LeftArm"}]}`)
	check, _ := json.Marshal(map[string]any{"character": "sample:test_rig.glb", "skeleton": "soma30", "mapping": json.RawMessage(broken)})
	rec = do(http.MethodPost, "/api/retarget/check", check)
	if !strings.Contains(rec.Body.String(), "is not mapped") {
		t.Fatalf("check: %d %s", rec.Code, rec.Body.String())
	}
	body, _ = json.Marshal(map[string]any{
		"root_motion": map[string]any{"source": "sample:soma30-walk-s42", "mode": "full"},
		"character":   "sample:test_rig.glb", "mapping": json.RawMessage(broken),
	})
	if rec := do(http.MethodPost, "/api/retarget", body); rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "invalid mapping") {
		t.Fatalf("broken mapping: %d %s", rec.Code, rec.Body.String())
	}
	for _, bad := range []string{"sample:../main.go", "upload:..", "sample:test_rig.txt", "other:x"} {
		if _, ok := (studioConfig{sampleRigs: "../tests/data/rigs"}).characterPath(bad); ok {
			t.Fatalf("characterPath accepted %q", bad)
		}
	}
	if rec := do(http.MethodGet, "/api/retarget/mappings/x.json", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("mappings dir exposed: %d", rec.Code)
	}
}
