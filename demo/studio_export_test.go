package main

import (
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestExportEndpoint(t *testing.T) {
	exe := builtAnimTool(t)
	mux := http.NewServeMux()
	registerStudio(mux, studioConfig{sampleRigs: "../tests/data/rigs", sampleMotions: "../tests/data/baseline", output: t.TempDir(), anim: exe})
	do := func(method, path, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
		return rec
	}
	rec := do(http.MethodPost, "/api/export", `{"name":"My walk!","character":"sample:test_rig.glb",
		"layers":[{"root_motion":{"source":"sample:soma30-walk-s42","mode":"inplace"}}]}`)
	var res struct {
		Name     string `json:"name"`
		URL      string `json:"url"`
		Download string `json:"download"`
		Bytes    int64  `json:"bytes"`
	}
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &res) != nil {
		t.Fatalf("export: %d %s", rec.Code, rec.Body.String())
	}
	if res.Name != "My_walk" || !strings.HasSuffix(res.URL, "/My_walk.glb") {
		t.Fatalf("unexpected export name: %+v", res)
	}
	glb := do(http.MethodGet, res.URL, "")
	body := glb.Body.Bytes()
	if glb.Code != http.StatusOK || len(body) < 20 || string(body[:4]) != "glTF" || int64(len(body)) != res.Bytes {
		t.Fatalf("exported file: %d, %d bytes", glb.Code, len(body))
	}
	jsonLen := binary.LittleEndian.Uint32(body[12:16])
	var doc struct {
		Animations []struct {
			Name     string `json:"name"`
			Channels []any  `json:"channels"`
		} `json:"animations"`
		Skins  []any `json:"skins"`
		Meshes []any `json:"meshes"`
	}
	if err := json.Unmarshal(body[20:20+jsonLen], &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Animations) != 1 || doc.Animations[0].Name != "My_walk" || len(doc.Animations[0].Channels) != 40 || len(doc.Skins) != 1 || len(doc.Meshes) != 1 {
		t.Fatalf("exported GLB content: %+v", doc)
	}
	if d := do(http.MethodGet, res.Download, ""); !strings.Contains(d.Header().Get("Content-Disposition"), "My_walk.glb") {
		t.Fatalf("download header: %q", d.Header().Get("Content-Disposition"))
	}
	if rec := do(http.MethodPost, "/api/export", `{"layers":[{"root_motion":{"source":"sample:soma30-walk-s42","mode":"full"}}]}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("export without character: %d", rec.Code)
	}
	for _, bad := range []string{"/api/export/../x.glb", "/api/export/abc/../../main.go", "/api/export/abc/x.txt"} {
		// ".." paths are redirected to their cleaned form by the mux; nothing may be served.
		if rec := do(http.MethodGet, bad, ""); rec.Code == http.StatusOK {
			t.Fatalf("%s: %d", bad, rec.Code)
		}
	}
}
