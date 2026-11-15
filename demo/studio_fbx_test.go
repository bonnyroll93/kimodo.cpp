package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFindBlenderAndHelpers(t *testing.T) {
	if got := findBlender("C:/x/blender.exe"); got != "C:/x/blender.exe" {
		t.Fatalf("flag value not used: %q", got)
	}
	if versionKey(filepath.Join("a", "Blender 5.2", "blender.exe")) <= versionKey(filepath.Join("a", "Blender 4.5", "blender.exe")) {
		t.Fatal("version order")
	}
	if got := lastLines("a\n\nb\nc\nd\n", 2); got != "c | d" {
		t.Fatalf("lastLines: %q", got)
	}
}

func TestFBXEndpointsWithoutBlender(t *testing.T) {
	c := studioConfig{output: t.TempDir()} // no Blender
	mux := http.NewServeMux()
	registerFBX(mux, c)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/fbx", nil))
	var info struct{ Available bool }
	if err := json.Unmarshal(rec.Body.Bytes(), &info); err != nil || info.Available {
		t.Fatalf("/api/fbx: %s", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/convert/fbx", strings.NewReader("this is not an FBX file at all, really")))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("non-FBX body: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	body := append([]byte("Kaydara FBX Binary  \x00"), bytes.Repeat([]byte{0}, 64)...)
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/convert/fbx", bytes.NewReader(body)))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("no Blender: %d %s", rec.Code, rec.Body.String())
	}
}

// Real conversions; slow (Blender starts twice): KIMODO_TEST_BLENDER=1 go test -run Blender.
func TestBlenderRoundTrip(t *testing.T) {
	if os.Getenv("KIMODO_TEST_BLENDER") == "" {
		t.Skip("set KIMODO_TEST_BLENDER=1 to run Blender conversions")
	}
	c := studioConfig{output: t.TempDir(), blender: findBlender("")}
	if c.blender == "" {
		t.Skip("Blender not found")
	}
	dir := t.TempDir()
	glb := filepath.Join("..", "tests", "data", "rigs", "test_rig.glb")
	fbx := filepath.Join(dir, "rig.fbx")
	if herr := c.blenderConvert(t.Context(), "glb2fbx", glb, fbx); herr != nil {
		t.Fatal(herr.message)
	}
	data, err := os.ReadFile(fbx)
	if err != nil || !bytes.HasPrefix(data, []byte("Kaydara FBX Binary")) {
		t.Fatalf("not a binary FBX: %v", err)
	}
	back := filepath.Join(dir, "rig.glb")
	if herr := c.blenderConvert(t.Context(), "fbx2glb", fbx, back); herr != nil {
		t.Fatal(herr.message)
	}
	if data, err := os.ReadFile(back); err != nil || !bytes.HasPrefix(data, []byte("glTF")) {
		t.Fatalf("not a GLB: %v", err)
	}
}
