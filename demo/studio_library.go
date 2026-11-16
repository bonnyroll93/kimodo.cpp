package main

// Kimodo Extended: the motion library's folders and published takes.
//   GET    /api/library                  {folders:[...]}                      (the motions: /studio/motions)
//   POST   /api/library/folders          {name}                               create a folder ("A/B" nests)
//   DELETE /api/library/folders/<name>   its motions go back to their default folder
//   POST   /api/library/move             {id, folder}                         put any motion in a folder
//   POST   /api/library/rename           {id, name}                           a published motion's name
//   POST   /api/library/publish          {name, folder, stack}                a take as a library motion
//   DELETE /studio/motions/library:<id>  remove a published motion
// Default folders: Kimodo (generated animations), Samples (sample motions), Published (takes).
// A take baked on a character is brought back onto the native skeleton of its clips
// (kmd-anim unretarget, the inverse of its retargeting), so it can be a clip source again.
// State: <output>/library/<id>/ (motion files + meta.json) and <output>/library/index.json
// (folders and folder assignments).

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	folderKimodo    = "Kimodo"
	folderSamples   = "Samples"
	folderPublished = "Published"
)

type libraryIndex struct {
	Folders []string          `json:"folders"`
	Assign  map[string]string `json:"assign"` // motion id -> folder
}

type libraryMeta struct {
	Name        string `json:"name"`
	SkeletonKey string `json:"skeleton_key"`
	Created     string `json:"created"`
	Folder      string `json:"folder"`
	Take        string `json:"take,omitempty"`
}

var libraryMu sync.Mutex
var folderName = regexp.MustCompile(`^[^/\\<>:"|?*\x00-\x1f]{1,40}(/[^/\\<>:"|?*\x00-\x1f]{1,40}){0,3}$`)

func cleanFolder(s string) (string, bool) {
	parts := strings.Split(strings.Trim(strings.TrimSpace(s), "/"), "/")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
		if parts[i] == "" || parts[i] == "." || parts[i] == ".." {
			return "", false
		}
	}
	f := strings.Join(parts, "/")
	return f, folderName.MatchString(f)
}

func (c studioConfig) libraryDir() string { return filepath.Join(c.output, "library") }

func (c studioConfig) loadIndex() libraryIndex {
	var idx libraryIndex
	if data, err := os.ReadFile(filepath.Join(c.libraryDir(), "index.json")); err == nil {
		_ = json.Unmarshal(data, &idx)
	}
	if idx.Assign == nil {
		idx.Assign = map[string]string{}
	}
	return idx
}

func (c studioConfig) saveIndex(idx libraryIndex) error {
	if err := os.MkdirAll(c.libraryDir(), 0755); err != nil {
		return err
	}
	sort.Strings(idx.Folders)
	data, _ := json.MarshalIndent(idx, "", "  ")
	tmp := filepath.Join(c.libraryDir(), "index.json.tmp")
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(c.libraryDir(), "index.json"))
}

// libraryMotions: the published takes (library:<id>).
func (c studioConfig) libraryMotions() []studioMotion {
	var list []studioMotion
	entries, _ := os.ReadDir(c.libraryDir())
	for _, e := range entries {
		if !e.IsDir() || !safePathPart(e.Name()) {
			continue
		}
		dir := filepath.Join(c.libraryDir(), e.Name())
		var meta libraryMeta
		data, err := os.ReadFile(filepath.Join(dir, "meta.json"))
		if err != nil || json.Unmarshal(data, &meta) != nil {
			continue
		}
		frames, joints, err := motionShape(dir)
		if err != nil {
			continue
		}
		key := meta.SkeletonKey
		if key == "" {
			key = skeletonKeyForJoints(joints)
		}
		list = append(list, studioMotion{ID: "library:" + e.Name(), Label: meta.Name, Kind: "library", SkeletonKey: key,
			Frames: frames, Created: meta.Created, Deletable: true, Folder: meta.Folder, dir: dir})
	}
	return list
}

// withFolders sets every motion's folder: its assignment, else the default for its kind.
func (c studioConfig) withFolders(list []studioMotion) []studioMotion {
	idx := c.loadIndex()
	for i := range list {
		m := &list[i]
		if f, ok := idx.Assign[m.ID]; ok {
			m.Folder = f
			continue
		}
		switch m.Kind {
		case "sample":
			m.Folder = folderSamples
		case "library":
			if m.Folder == "" {
				m.Folder = folderPublished
			}
		default:
			m.Folder = folderKimodo
		}
	}
	return list
}

func (c studioConfig) folders(list []studioMotion) []string {
	set := map[string]bool{folderKimodo: true, folderSamples: true, folderPublished: true} // always there
	for _, f := range c.loadIndex().Folders {
		set[f] = true
	}
	for _, m := range list {
		if m.Folder != "" {
			for f := m.Folder; f != "" && f != "."; f = filepath.ToSlash(filepath.Dir(f)) {
				set[f] = true
			}
		}
	}
	out := make([]string, 0, len(set))
	for f := range set {
		out = append(out, f)
	}
	sort.Strings(out)
	return out
}

type publishRequest struct {
	Name   string        `json:"name"`
	Folder string        `json:"folder,omitempty"`
	Take   string        `json:"take,omitempty"`
	Stack  layersRequest `json:"stack"`
}

func registerLibrary(mux *http.ServeMux, c studioConfig) {
	readJSON := func(w http.ResponseWriter, r *http.Request, v any) bool {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return false
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<20)).Decode(v); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return false
		}
		return true
	}
	ok := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}

	mux.HandleFunc("/api/library", func(w http.ResponseWriter, r *http.Request) {
		ok(w, map[string]any{"folders": c.folders(c.motions())})
	})

	mux.HandleFunc("/api/library/folders", func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Name string }
		if !readJSON(w, r, &req) {
			return
		}
		f, valid := cleanFolder(req.Name)
		if !valid {
			writeError(w, http.StatusBadRequest, "folder names: up to 4 levels of 1-40 characters, no \\ < > : \" | ? *")
			return
		}
		libraryMu.Lock()
		defer libraryMu.Unlock()
		idx := c.loadIndex()
		for _, x := range idx.Folders {
			if x == f {
				ok(w, map[string]any{"folder": f})
				return
			}
		}
		idx.Folders = append(idx.Folders, f)
		if err := c.saveIndex(idx); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		ok(w, map[string]any{"folder": f})
	})

	mux.HandleFunc("/api/library/folders/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			w.Header().Set("Allow", http.MethodDelete)
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		name, err := url.PathUnescape(strings.TrimPrefix(r.URL.EscapedPath(), "/api/library/folders/"))
		f, valid := cleanFolder(name)
		if err != nil || !valid {
			writeError(w, http.StatusBadRequest, "invalid folder")
			return
		}
		libraryMu.Lock()
		defer libraryMu.Unlock()
		idx := c.loadIndex()
		inside := func(x string) bool { return x == f || strings.HasPrefix(x, f+"/") }
		keep := idx.Folders[:0]
		for _, x := range idx.Folders {
			if !inside(x) {
				keep = append(keep, x)
			}
		}
		idx.Folders = keep
		for id, x := range idx.Assign {
			if inside(x) {
				delete(idx.Assign, id) // back to its default folder
			}
		}
		// Published motions stored in it go back to Published.
		for _, m := range c.libraryMotions() {
			if inside(m.Folder) {
				_ = c.updateLibraryMeta(m.dir, func(meta *libraryMeta) { meta.Folder = folderPublished })
			}
		}
		if err := c.saveIndex(idx); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	mux.HandleFunc("/api/library/move", func(w http.ResponseWriter, r *http.Request) {
		var req struct{ ID, Folder string }
		if !readJSON(w, r, &req) {
			return
		}
		f, valid := cleanFolder(req.Folder)
		if !valid {
			writeError(w, http.StatusBadRequest, "invalid folder")
			return
		}
		if _, found := c.findMotion(req.ID); !found {
			writeError(w, http.StatusNotFound, "unknown motion")
			return
		}
		libraryMu.Lock()
		defer libraryMu.Unlock()
		idx := c.loadIndex()
		idx.Assign[req.ID] = f
		if err := c.saveIndex(idx); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		ok(w, map[string]any{"id": req.ID, "folder": f})
	})

	mux.HandleFunc("/api/library/rename", func(w http.ResponseWriter, r *http.Request) {
		var req struct{ ID, Name string }
		if !readJSON(w, r, &req) {
			return
		}
		name := strings.TrimSpace(req.Name)
		lid, isLib := strings.CutPrefix(req.ID, "library:")
		if !isLib || !safePathPart(lid) || name == "" || len(name) > 80 {
			writeError(w, http.StatusBadRequest, "only published motions can be renamed (1-80 characters)")
			return
		}
		dir := filepath.Join(c.libraryDir(), lid)
		if err := c.updateLibraryMeta(dir, func(m *libraryMeta) { m.Name = name }); err != nil {
			writeError(w, http.StatusNotFound, "unknown motion")
			return
		}
		ok(w, map[string]any{"id": req.ID, "name": name})
	})

	mux.HandleFunc("/api/library/publish", func(w http.ResponseWriter, r *http.Request) {
		var req publishRequest
		if !readJSON(w, r, &req) {
			return
		}
		name := strings.TrimSpace(req.Name)
		if name == "" || len(name) > 80 {
			writeError(w, http.StatusBadRequest, "a name of 1-80 characters is needed")
			return
		}
		folder := folderPublished
		if req.Folder != "" {
			f, valid := cleanFolder(req.Folder)
			if !valid {
				writeError(w, http.StatusBadRequest, "invalid folder")
				return
			}
			folder = f
		}
		// The native skeleton of the take's clips.
		key := ""
		for _, l := range req.Stack.Layers {
			if len(l.Keys) > 0 && string(l.Keys) != "null" {
				continue
			}
			if m, found := c.findMotion(l.RootMotion.Source); found {
				key = m.SkeletonKey
				break
			}
		}
		if key == "" {
			writeError(w, http.StatusBadRequest, "the take has no clip with a motion source")
			return
		}
		stack, herr := c.layers(r.Context(), req.Stack)
		if herr != nil {
			writeError(w, herr.status, herr.message)
			return
		}
		id := hashID("publish", stack.id, key, strconv64(time.Now().UnixNano()))
		dir := filepath.Join(c.libraryDir(), id)
		if stack.characterPath == "" { // a native stack: its motion files as they are
			if err := os.MkdirAll(dir, 0755); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			for _, f := range []string{"root_positions.f32", "local_rotations_xyzw.f32"} {
				if err := copyFile(filepath.Join(stack.dir, f), filepath.Join(dir, f)); err != nil {
					_ = os.RemoveAll(dir)
					writeError(w, http.StatusInternalServerError, "publish: "+err.Error())
					return
				}
			}
		} else { // baked on the character: back onto the native skeleton
			args := []string{"--native", key}
			if len(req.Stack.Mapping) > 0 && string(req.Stack.Mapping) != "null" {
				path, herr := c.storeMapping(req.Stack.Mapping)
				if herr != nil {
					writeError(w, herr.status, herr.message)
					return
				}
				args = append(args, "--mapping", path)
			}
			if len(req.Stack.ReferencePose) > 0 && string(req.Stack.ReferencePose) != "null" {
				path, herr := c.storeJSON("retarget/poses", req.Stack.ReferencePose)
				if herr != nil {
					writeError(w, herr.status, herr.message)
					return
				}
				args = append(args, "--reference-pose", path)
			} else if req.Stack.AlignRest {
				args = append(args, "--align-rest")
			}
			if herr := c.runCached(r.Context(), dir, "local_rotations_xyzw.f32", func(out string) []string {
				return append([]string{"unretarget", stack.dir, stack.characterPath, out}, args...)
			}); herr != nil {
				writeError(w, herr.status, herr.message)
				return
			}
		}
		meta := libraryMeta{Name: name, SkeletonKey: key, Created: time.Now().UTC().Format(time.RFC3339), Folder: folder, Take: req.Take}
		data, _ := json.MarshalIndent(meta, "", "  ")
		if err := os.WriteFile(filepath.Join(dir, "meta.json"), data, 0644); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		frames, _, _ := motionShape(dir)
		ok(w, map[string]any{"id": "library:" + id, "name": name, "folder": folder, "frames": frames, "skeleton_key": key})
	})
}

func (c studioConfig) updateLibraryMeta(dir string, edit func(*libraryMeta)) error {
	data, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		return err
	}
	var meta libraryMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return err
	}
	edit(&meta)
	out, _ := json.MarshalIndent(meta, "", "  ")
	return os.WriteFile(filepath.Join(dir, "meta.json"), out, 0644)
}

func strconv64(v int64) string {
	return strings.TrimLeft(time.Unix(0, v).UTC().Format("20060102150405.000000000"), " ")
}
