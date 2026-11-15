// Single translation unit holding the vendored cgltf implementation (third_party/cgltf, v1.14).
#if defined(_MSC_VER)
#pragma warning(push, 0)
#pragma warning(disable : 4996)
#endif
// cgltf_write.h includes cgltf.h itself; including both would emit the parser twice.
#define CGLTF_IMPLEMENTATION
#define CGLTF_WRITE_IMPLEMENTATION
#include <cgltf_write.h>
#if defined(_MSC_VER)
#pragma warning(pop)
#endif
