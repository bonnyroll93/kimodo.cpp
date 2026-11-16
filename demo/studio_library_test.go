package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestCleanFolder(t *testing.T) {
	for in, want := range map[string]string{"Walks": "Walks", " Walks / Fast ": "Walks/Fast", "/A/B/": "A/B"} {
		if got, ok := cleanFolder(in); !ok || got != want {
			t.Fatalf("%q: got %q %v", in, got, ok)
		}
	}
	for _, bad := range []string{"", "..", "A/../B", "A//B", "a:b", "A/B/C/D/E"} {
		if _, ok := cleanFolder(bad); ok {
			t.Fatalf("%q accepted", bad)
		}
	}
}

func TestLibraryFolders(t *testing.T) {
	out := t.TempDir()
	c := studioConfig{output: out, sampleMotions: filepath.Join("..", "tests", "data", "baseline")}
	// A published motion (files of a sample) in the default folder.
	dir := filepath.Join(out, "library", "abc123")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(c.sampleMotions, "soma30-walk-s42")
	for _, f := range []string{"root_positions.f32", "local_rotations_xyzw.f32"} {
		if err := copyFile(filepath.Join(src, f), filepath.Join(dir, f)); err != nil {
			t.Fatal(err)
		}
	}
	meta, _ := json.Marshal(libraryMeta{Name: "My take", SkeletonKey: "soma30"})
	_ = os.WriteFile(filepath.Join(dir, "meta.json"), meta, 0644)
	folderOf := func(id string) string {
		for _, m := range c.motions() {
			if m.ID == id {
				return m.Folder
			}
		}
		return "?"
	}
	if f := folderOf("library:abc123"); f != folderPublished {
		t.Fatalf("published default: %q", f)
	}
	if f := folderOf("sample:soma30-walk-s42"); f != folderSamples {
		t.Fatalf("sample default: %q", f)
	}
	mux := http.NewServeMux()
	registerLibrary(mux, c)
	post := func(path string, body any) *httptest.ResponseRecorder {
		data, _ := json.Marshal(body)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, bytes.NewReader(data)))
		return rec
	}
	if rec := post("/api/library/folders", map[string]string{"name": "Walks/Fast"}); rec.Code != 200 {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	if rec := post("/api/library/move", map[string]string{"id": "sample:soma30-walk-s42", "folder": "Walks/Fast"}); rec.Code != 200 {
		t.Fatalf("move: %d %s", rec.Code, rec.Body)
	}
	if f := folderOf("sample:soma30-walk-s42"); f != "Walks/Fast" {
		t.Fatalf("moved: %q", f)
	}
	if rec := post("/api/library/rename", map[string]string{"id": "library:abc123", "name": "Renamed"}); rec.Code != 200 {
		t.Fatalf("rename: %d %s", rec.Code, rec.Body)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/library", nil))
	var lib struct{ Folders []string }
	_ = json.Unmarshal(rec.Body.Bytes(), &lib)
	want := map[string]bool{"Walks": true, "Walks/Fast": true, folderSamples: true, folderPublished: true}
	for _, f := range lib.Folders {
		delete(want, f)
	}
	if len(want) != 0 {
		t.Fatalf("folders %v missing %v", lib.Folders, want)
	}
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/library/folders/Walks", nil))
	if rec.Code != http.StatusNoContent || folderOf("sample:soma30-walk-s42") != folderSamples {
		t.Fatalf("delete folder: %d, sample now in %q", rec.Code, folderOf("sample:soma30-walk-s42"))
	}
	if rec := post("/api/library/move", map[string]string{"id": "sample:nope", "folder": "X"}); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown motion: %d", rec.Code)
	}
}
