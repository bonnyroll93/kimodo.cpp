package main

// Kimodo Extended: takes export (MotionBuilder-style takes, each its own timeline).
//   POST /api/export/takes  {name, format: glb|fbx, mode, takes:[{name, stack:{...layersRequest}}]}
//   mode "per_take": one file per take (and a .zip of them all);
//        "single":   one file with every take as its own animation (FBX: one take each);
//        "sequence": one file with the takes baked one after the other on a single timeline.
// Each take's stack is baked like /api/export (cached). "single" chains kmd-anim export (the
// first take replaces the character's own animations, the others are appended); "sequence"
// stacks the baked takes as consecutive clips (kmd-anim layers, each held only over its own
// range) and exports that. Files are served by GET /api/export/<id>/<file>.

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type takeRequest struct {
	Name  string        `json:"name"`
	Stack layersRequest `json:"stack"`
}

type takesExportRequest struct {
	Name   string        `json:"name,omitempty"`
	Format string        `json:"format,omitempty"` // glb | fbx
	Mode   string        `json:"mode"`             // per_take | single | sequence
	Takes  []takeRequest `json:"takes"`
}

type exportedFile struct {
	Take  string `json:"take,omitempty"`
	File  string `json:"file"`
	URL   string `json:"url"`
	Bytes int64  `json:"bytes"`
}

// safeName: a file-name-safe version of a user name (letters, digits, . _ -).
func safeName(s, fallback string) string {
	n := strings.Trim(exportName.ReplaceAllString(s, "_"), "._")
	if n == "" {
		n = fallback
	}
	if len(n) > 60 {
		n = n[:60]
	}
	return n
}

// clipFrames reads frames and fps of a baked stack (clip.json).
func clipFrames(dir string) (int, float64, error) {
	var meta struct {
		Frames int     `json:"frames"`
		FPS    float64 `json:"fps"`
	}
	data, err := os.ReadFile(filepath.Join(dir, "clip.json"))
	if err != nil {
		return 0, 0, err
	}
	if err := json.Unmarshal(data, &meta); err != nil || meta.Frames <= 0 {
		return 0, 0, fmt.Errorf("invalid clip.json")
	}
	if meta.FPS <= 0 {
		meta.FPS = 30
	}
	return meta.Frames, meta.FPS, nil
}

func (c studioConfig) fileInfo(id, file, take string) (exportedFile, *httpError) {
	info, err := os.Stat(filepath.Join(c.output, "exports", id, file))
	if err != nil {
		return exportedFile{}, &httpError{http.StatusInternalServerError, "export missing: " + file}
	}
	return exportedFile{Take: take, File: file, URL: "/api/export/" + id + "/" + file, Bytes: info.Size()}, nil
}

// maybeFBX converts dir/base.glb to dir/base.fbx when the format asks for it; returns the file.
func (c studioConfig) maybeFBX(r *http.Request, dir, base, format string) (string, *httpError) {
	if format != "fbx" {
		return base + ".glb", nil
	}
	fbx := filepath.Join(dir, base+".fbx")
	if !converted(fbx) {
		if herr := c.blenderConvert(r.Context(), "glb2fbx", filepath.Join(dir, base+".glb"), fbx); herr != nil {
			return "", herr
		}
	}
	return base + ".fbx", nil
}

func registerTakesExport(mux *http.ServeMux, c studioConfig) {
	mux.HandleFunc("/api/export/takes", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req takesExportRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<20)).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		if req.Format == "" {
			req.Format = "glb"
		}
		if req.Format != "glb" && req.Format != "fbx" {
			writeError(w, http.StatusBadRequest, "format must be glb or fbx")
			return
		}
		if req.Mode != "per_take" && req.Mode != "single" && req.Mode != "sequence" {
			writeError(w, http.StatusBadRequest, "mode must be per_take, single or sequence")
			return
		}
		if len(req.Takes) == 0 || len(req.Takes) > 32 {
			writeError(w, http.StatusBadRequest, "export 1 to 32 takes")
			return
		}
		name := safeName(req.Name, "Kimodo")
		// Bake every take (cached), all on the same character.
		stacks := make([]layersResult, len(req.Takes))
		names := make([]string, len(req.Takes))
		seen := map[string]int{}
		var character string
		for i, t := range req.Takes {
			if t.Stack.Character == "" {
				writeError(w, http.StatusBadRequest, "export needs a character (retarget onto a loaded model first)")
				return
			}
			st, herr := c.layers(r.Context(), t.Stack)
			if herr != nil {
				writeError(w, herr.status, "take "+strconv.Itoa(i+1)+": "+herr.message)
				return
			}
			if character == "" {
				character = st.characterPath
			} else if st.characterPath != character {
				writeError(w, http.StatusBadRequest, "all takes must use the same character")
				return
			}
			stacks[i] = st
			n := safeName(t.Name, "Take"+strconv.Itoa(i+1))
			if seen[n]++; seen[n] > 1 {
				n += "_" + strconv.Itoa(seen[n])
			}
			names[i] = n
		}
		key := []string{"takes", req.Mode, name, character}
		for i, st := range stacks {
			key = append(key, st.id, names[i])
		}
		id := hashID(key...)
		dir := filepath.Join(c.output, "exports", id)
		if err := os.MkdirAll(dir, 0755); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		var files []exportedFile
		switch req.Mode {
		case "per_take":
			for i, st := range stacks {
				base := name + "_" + names[i]
				if herr := c.runCachedFile(r, dir, base+".glb", []string{"export", character, st.dir, "", "--name", names[i]}); herr != nil {
					writeError(w, herr.status, herr.message)
					return
				}
				file, herr := c.maybeFBX(r, dir, base, req.Format)
				if herr != nil {
					writeError(w, herr.status, herr.message)
					return
				}
				f, herr := c.fileInfo(id, file, names[i])
				if herr != nil {
					writeError(w, herr.status, herr.message)
					return
				}
				files = append(files, f)
			}
		case "single": // every take as an animation of one file: chained exports
			prev := character
			for i, st := range stacks {
				step := name + ".take" + strconv.Itoa(i) + ".glb"
				args := []string{"export", prev, st.dir, "", "--name", names[i]}
				if i == 0 {
					args = append(args, "--replace-animations")
				}
				if herr := c.runCachedFile(r, dir, step, args); herr != nil {
					writeError(w, herr.status, herr.message)
					return
				}
				prev = filepath.Join(dir, step)
			}
			if err := copyFile(prev, filepath.Join(dir, name+".glb")); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			file, herr := c.maybeFBX(r, dir, name, req.Format)
			if herr != nil {
				writeError(w, herr.status, herr.message)
				return
			}
			f, herr := c.fileInfo(id, file, "")
			if herr != nil {
				writeError(w, herr.status, herr.message)
				return
			}
			files = append(files, f)
		case "sequence": // the takes one after the other on one timeline
			args := []string{"--character", character}
			start := 0.0
			total := 0
			var fps float64
			for i, st := range stacks {
				frames, f, err := clipFrames(st.dir)
				if err != nil {
					writeError(w, http.StatusInternalServerError, "take "+names[i]+": "+err.Error())
					return
				}
				fps = f
				args = append(args, "--layer", st.dir, "--name", names[i], "--start", num(start), "--extend", "none")
				if i > 0 {
					args = append(args, "--empty-before")
				}
				start += float64(frames) / f
				total += frames
			}
			args = append(args, "--length", num(float64(total-1)/fps))
			seqDir := filepath.Join(c.output, "layers", hashID(append([]string{"sequence"}, args...)...))
			if herr := c.runCached(r.Context(), seqDir, "clip.json", func(out string) []string {
				return append([]string{"layers", out}, args...)
			}); herr != nil {
				writeError(w, herr.status, herr.message)
				return
			}
			if herr := c.runCachedFile(r, dir, name+".glb", []string{"export", character, seqDir, "", "--name", name}); herr != nil {
				writeError(w, herr.status, herr.message)
				return
			}
			file, herr := c.maybeFBX(r, dir, name, req.Format)
			if herr != nil {
				writeError(w, herr.status, herr.message)
				return
			}
			f, herr := c.fileInfo(id, file, "")
			if herr != nil {
				writeError(w, herr.status, herr.message)
				return
			}
			files = append(files, f)
		}
		res := map[string]any{"id": id, "name": name, "mode": req.Mode, "format": req.Format, "files": files}
		if len(files) > 1 { // everything in one download
			zipName := name + "_takes.zip"
			if err := zipFiles(filepath.Join(dir, zipName), dir, files); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			z, herr := c.fileInfo(id, zipName, "")
			if herr == nil {
				res["zip"] = z
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(res)
	})
}

// runCachedFile runs a kmd-anim export into dir/file once (args[3] is replaced by the output path).
func (c studioConfig) runCachedFile(r *http.Request, dir, file string, args []string) *httpError {
	if _, err := os.Stat(filepath.Join(dir, file)); err == nil {
		return nil
	}
	tmp := filepath.Join(dir, file+".tmp")
	_ = os.RemoveAll(tmp)
	herr := c.runCached(r.Context(), tmp, file, func(out string) []string {
		a := append([]string{}, args...)
		a[3] = filepath.Join(out, file)
		_ = os.MkdirAll(out, 0755)
		return a
	})
	if herr != nil {
		return herr
	}
	defer os.RemoveAll(tmp)
	if err := os.Rename(filepath.Join(tmp, file), filepath.Join(dir, file)); err != nil {
		if _, statErr := os.Stat(filepath.Join(dir, file)); statErr != nil {
			return &httpError{http.StatusInternalServerError, "cannot store " + file + ": " + err.Error()}
		}
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

func zipFiles(path, dir string, files []exportedFile) error {
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	z := zip.NewWriter(f)
	for _, e := range files {
		src, err := os.Open(filepath.Join(dir, e.File))
		if err != nil {
			z.Close()
			f.Close()
			return err
		}
		w, err := z.Create(e.File)
		if err == nil {
			_, err = io.Copy(w, src)
		}
		src.Close()
		if err != nil {
			z.Close()
			f.Close()
			return err
		}
	}
	if err := z.Close(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
