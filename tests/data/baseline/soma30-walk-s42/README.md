# Baseline: soma30 walk, seed 42

Reference output of the unmodified generation path, captured at upstream commit
75ed52d. Kimodo Extended changes must keep `kmd-generate` bit-identical to these
files when the new options are not used.

| Field | Value |
|---|---|
| Motion model | `models/kimodo-soma-rp-v1.1-f32.gguf` |
| Text bundle | `Llama-3-Kimodo-Q8_0.gguf` (+ `tokenizer.gguf` alongside) |
| Prompt | `prompt.txt` |
| Frames / steps / seed | 90 / 100 / 42 |
| Backend | Vulkan, RTX 4070 Laptop (`KIMODO_TEXT_LAYER_CHUNK=8`, `KIMODO_TEXT_RESIDENT_LIMIT_MIB=4096`) |
| Output | 90 frames x 30 joints; `root_positions.f32` [90,3], `local_rotations_xyzw.f32` [90,30,4] |

Two consecutive runs produced byte-identical files (see `SHA256SUMS`).
Bit-identity is only expected on the same backend and driver; CPU or other GPUs
need their own capture or a tolerance-based comparison.

Regenerate:

```sh
kmd-generate models/kimodo-soma-rp-v1.1-f32.gguf Llama-3-Kimodo-Q8_0.gguf \
  tests/data/baseline/soma30-walk-s42/prompt.txt 90 100 42 OUT_DIR
sha256sum -c tests/data/baseline/soma30-walk-s42/SHA256SUMS  # run from OUT_DIR copy
```
