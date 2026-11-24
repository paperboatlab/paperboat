cmake_minimum_required(VERSION 3.25)
project(paperboat VERSION 0.2.0 LANGUAGES CXX)
set(PAPERBOAT_PRERELEASE "dev")
set(PAPERBOAT_VERSION "${PROJECT_VERSION}")
if(PAPERBOAT_PRERELEASE)
  string(APPEND PAPERBOAT_VERSION "-${PAPERBOAT_PRERELEASE}")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
include(GNUInstallDirs)

option(PAPERBOAT_BUILD_TESTS "Build the Catch2 tests" ${PROJECT_IS_TOP_LEVEL})

include(FetchContent)
FetchContent_Declare(nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.12.0/json.tar.xz
  FIND_PACKAGE_ARGS 3.11)
FetchContent_Declare(tomlplusplus
  URL https://github.com/marzer/tomlplusplus/archive/refs/tags/v3.4.0.tar.gz
  FIND_PACKAGE_ARGS 3.4)
FetchContent_MakeAvailable(nlohmann_json tomlplusplus)

add_library(paperboat_warnings INTERFACE)
if(MSVC)
  target_compile_options(paperboat_warnings INTERFACE /W4 /permissive-)
else()
  target_compile_options(paperboat_warnings INTERFACE -Wall -Wextra -Wpedantic -Wshadow -Wconversion)
endif()

# The runtime manager: manifests, catalog, policy, backends, leases, the control protocol's client.
if(WIN32)
  set(PAPERBOAT_PROCESS_SOURCE src/lib/process_win.cpp)
else()
  set(PAPERBOAT_PROCESS_SOURCE src/lib/process.cpp)
endif()
add_library(paperboat_runtime STATIC
  src/lib/manifest.cpp
  src/lib/catalog.cpp
  src/lib/policy.cpp
  src/lib/paths.cpp
  src/lib/backend_oci.cpp
  src/lib/backend_native.cpp
  src/lib/manager.cpp
  src/lib/control.cpp
  src/lib/runtime_client.cpp
  ${PAPERBOAT_PROCESS_SOURCE})
add_library(paperboat::runtime ALIAS paperboat_runtime)
target_include_directories(paperboat_runtime PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include> $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>)
target_link_libraries(paperboat_runtime
  PUBLIC nlohmann_json::nlohmann_json
  PRIVATE $<BUILD_INTERFACE:tomlplusplus::tomlplusplus> paperboat_warnings)

add_executable(paperboatd src/daemon/main.cpp)
target_compile_definitions(paperboatd PRIVATE PAPERBOAT_VERSION="${PAPERBOAT_VERSION}")
target_link_libraries(paperboatd PRIVATE paperboat::runtime paperboat_warnings)

add_executable(paperboat src/cli/main.cpp)
target_compile_definitions(paperboat PRIVATE PAPERBOAT_VERSION="${PAPERBOAT_VERSION}")
target_link_libraries(paperboat PRIVATE paperboat::runtime paperboat_warnings)

# A build tree finds the shipped manifests beside its binaries (catalog_dirs: <exe>/runtimes).
add_custom_target(paperboat_runtimes ALL
  COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_CURRENT_SOURCE_DIR}/runtimes ${CMAKE_CURRENT_BINARY_DIR}/runtimes)

install(TARGETS paperboat paperboatd RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
install(DIRECTORY runtimes/ DESTINATION ${CMAKE_INSTALL_DATADIR}/paperboat/runtimes)

if(PAPERBOAT_BUILD_TESTS)
  FetchContent_Declare(Catch2
    URL https://github.com/catchorg/Catch2/archive/refs/tags/v3.16.1.tar.gz
    FIND_PACKAGE_ARGS 3)
  FetchContent_MakeAvailable(Catch2)
  enable_testing()
  add_subdirectory(tests)
endif()
