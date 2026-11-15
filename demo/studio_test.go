package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStudioRoutes(t *testing.T) {
	rigs := t.TempDir()
	if err := os.WriteFile(filepath.Join(rigs, "rig.glb"), []byte("glTF-test"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rigs, "notes.txt"), []byte("secret"), 0644); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	registerStudio(mux, studioConfig{sampleRigs: rigs})
	get := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec
	}

	if rec := get("/studio"); rec.Code != http.StatusMovedPermanently {
		t.Fatalf("/studio: got %d, want redirect", rec.Code)
	}
	rec := get("/studio/")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "<title>Kimodo Studio</title>") {
		t.Fatalf("/studio/: got %d %q", rec.Code, rec.Body.String())
	}
	for _, asset := range []string{"/studio/studio.js", "/studio/studio.css", "/studio/viewer/viewport.js", "/studio/editor/inspector.js"} {
		if rec := get(asset); rec.Code != http.StatusOK {
			t.Fatalf("%s: got %d", asset, rec.Code)
		}
	}

	rec = get("/studio/samples/")
	var names []string
	if err := json.Unmarshal(rec.Body.Bytes(), &names); err != nil || len(names) != 1 || names[0] != "rig.glb" {
		t.Fatalf("sample list: %q (%v)", rec.Body.String(), err)
	}
	rec = get("/studio/samples/rig.glb")
	if rec.Code != http.StatusOK || rec.Body.String() != "glTF-test" || rec.Header().Get("Content-Type") != "model/gltf-binary" {
		t.Fatalf("sample rig: got %d %q %q", rec.Code, rec.Body.String(), rec.Header().Get("Content-Type"))
	}
	for _, bad := range []string{"/studio/samples/notes.txt", "/studio/samples/..%2Fmain.go", "/studio/samples/missing.glb"} {
		if rec := get(bad); rec.Code != http.StatusNotFound {
			t.Fatalf("%s: got %d, want 404", bad, rec.Code)
		}
	}
}
