cmake_minimum_required(VERSION 3.21)
project(SharkBrowser LANGUAGES C CXX)

set(CMAKE_CONFIGURATION_TYPES Debug Release)
set(CEF_VERSION "154.0.34+g14c5a08+chromium-154.0.8037.98")
set(CEF_CHANNEL "")

if(CMAKE_SYSTEM_NAME STREQUAL "Darwin")
  if(DEFINED PROJECT_ARCH AND PROJECT_ARCH STREQUAL "x86_64")
    set(CEF_PLATFORM "macosx64")
  else()
    set(PROJECT_ARCH "arm64" CACHE STRING "Target macOS architecture" FORCE)
    set(CEF_PLATFORM "macosarm64")
  endif()
elseif(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  if(CMAKE_SIZEOF_VOID_P EQUAL 8)
    set(CEF_PLATFORM "linux64")
  else()
    message(FATAL_ERROR "Shark currently supports 64-bit Linux only.")
  endif()
elseif(CMAKE_SYSTEM_NAME STREQUAL "Windows")
  if(CMAKE_SIZEOF_VOID_P EQUAL 8)
    set(CEF_PLATFORM "windows64")
  else()
    message(FATAL_ERROR "Shark currently supports 64-bit Windows only.")
  endif()
else()
  message(FATAL_ERROR "Unsupported platform: \${CMAKE_SYSTEM_NAME}")
endif()

list(APPEND CMAKE_MODULE_PATH "\${CMAKE_CURRENT_SOURCE_DIR}/cmake")
include(DownloadCEF)
DownloadCEF("\${CEF_PLATFORM}" "\${CEF_CHANNEL}" "\${CEF_VERSION}" "\${CMAKE_SOURCE_DIR}/third_party/cef")
list(APPEND CMAKE_MODULE_PATH "\${CEF_ROOT}/cmake")
find_package(CEF REQUIRED)

add_subdirectory("\${CEF_LIBCEF_DLL_WRAPPER_PATH}" libcef_dll_wrapper)

# CEF's standard distribution provides platform entry points, helper
# executables and packaging rules. Replace only the sample's app/handler.
foreach(file simple_app.h simple_app.cc simple_handler.h simple_handler.cc)
  configure_file(
    "\${CMAKE_CURRENT_SOURCE_DIR}/src/cef/\${file}"
    "\${CEF_ROOT}/tests/cefsimple/\${file}"
    COPYONLY
  )
endforeach()

add_subdirectory("\${CEF_ROOT}/tests/cefsimple" shark_cefsimple)
set_target_properties(cefsimple PROPERTIES OUTPUT_NAME "SharkBrowser")

add_custom_command(TARGET cefsimple POST_BUILD
  COMMAND "\${CMAKE_COMMAND}" -E make_directory "$<TARGET_FILE_DIR:cefsimple>/filters"
  COMMAND "\${CMAKE_COMMAND}" -E copy_directory
          "\${CMAKE_CURRENT_SOURCE_DIR}/resources/filters"
          "$<TARGET_FILE_DIR:cefsimple>/filters"
  VERBATIM
)

message(STATUS "Shark uses CEF \${CEF_VERSION} (\${CEF_PLATFORM})")
