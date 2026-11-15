# Regression guard for the unmodified generation path (opt-in: -DKIMODO_BASELINE_PARITY=ON).
# Runs kmd-generate with the recorded prompt/frames/steps/seed and compares SHA-256 of the
# outputs with tests/data/baseline/<case>/SHA256SUMS. Bit-identity holds for the backend and
# GPU/driver the baseline was captured on; other machines should recapture it first.
#   cmake -DGENERATOR=... -DMOTION=... -DTEXT=... -DCASE_DIR=... -DOUT_DIR=... -P baseline_parity.cmake
foreach(var GENERATOR MOTION TEXT CASE_DIR OUT_DIR)
  if(NOT DEFINED ${var})
    message(FATAL_ERROR "baseline_parity.cmake: ${var} is required")
  endif()
endforeach()
file(REMOVE_RECURSE "${OUT_DIR}")
execute_process(
  COMMAND "${GENERATOR}" "${MOTION}" "${TEXT}" "${CASE_DIR}/prompt.txt" 90 100 42 "${OUT_DIR}"
  RESULT_VARIABLE rc OUTPUT_VARIABLE out ERROR_VARIABLE err)
if(NOT rc EQUAL 0)
  message(FATAL_ERROR "kmd-generate failed (${rc}):\n${out}\n${err}")
endif()
file(STRINGS "${CASE_DIR}/SHA256SUMS" lines)
foreach(line IN LISTS lines)
  string(STRIP "${line}" line) # tolerate CRLF checkouts
  if(line MATCHES "^([0-9a-f]+) [ *]?(.+)$")
    set(expected "${CMAKE_MATCH_1}")
    set(name "${CMAKE_MATCH_2}")
    file(SHA256 "${OUT_DIR}/${name}" actual)
    if(NOT actual STREQUAL expected)
      message(FATAL_ERROR "${name}: ${actual} != baseline ${expected}")
    endif()
    message(STATUS "${name}: bit-identical to the baseline")
  endif()
endforeach()
