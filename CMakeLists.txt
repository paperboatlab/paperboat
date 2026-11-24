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
set_target_properties(paperboat_runtime PROPERTIES EXPORT_NAME runtime)
if(APPLE)  # Apple's libc++ keeps std::jthread and std::stop_token (process.hpp) behind this flag
  target_compile_options(paperboat_runtime PUBLIC -fexperimental-library)
  target_link_options(paperboat_runtime PUBLIC -fexperimental-library)
endif()
target_include_directories(paperboat_runtime PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include> $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>)
target_link_libraries(paperboat_runtime
  PUBLIC $<BUILD_INTERFACE:nlohmann_json::nlohmann_json>  # installed: paperboatConfig.cmake adds it
  PRIVATE $<BUILD_INTERFACE:tomlplusplus::tomlplusplus> $<BUILD_INTERFACE:paperboat_warnings>)

add_executable(paperboatd src/daemon/main.cpp)
target_compile_definitions(paperboatd PRIVATE PAPERBOAT_VERSION="${PAPERBOAT_VERSION}")
target_link_libraries(paperboatd PRIVATE paperboat::runtime paperboat_warnings)

# The command registry (src/cli/commands.toml) is embedded: the CLI's dispatch, usage and help read it.
file(READ src/cli/commands.toml PAPERBOAT_COMMANDS)
configure_file(src/cli/commands.cpp.in ${CMAKE_CURRENT_BINARY_DIR}/commands.cpp @ONLY)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS src/cli/commands.toml)
add_executable(paperboat src/cli/main.cpp ${CMAKE_CURRENT_BINARY_DIR}/commands.cpp)
target_compile_definitions(paperboat PRIVATE PAPERBOAT_VERSION="${PAPERBOAT_VERSION}")
target_link_libraries(paperboat PRIVATE paperboat::runtime tomlplusplus::tomlplusplus paperboat_warnings)

# A build tree finds the shipped manifests beside its binaries (catalog_dirs: <exe>/runtimes).
add_custom_target(paperboat_runtimes ALL
  COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_CURRENT_SOURCE_DIR}/runtimes ${CMAKE_CURRENT_BINARY_DIR}/runtimes
  COMMAND ${CMAKE_COMMAND} -E copy ${CMAKE_CURRENT_SOURCE_DIR}/apps.toml ${CMAKE_CURRENT_SOURCE_DIR}/toolkits.toml ${CMAKE_CURRENT_BINARY_DIR}/)

# ── install: two components, two packages (cli Requires devel; the Launcher's package Requires cli) ──
install(TARGETS paperboat paperboatd RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR} COMPONENT cli)
install(DIRECTORY runtimes/ DESTINATION ${CMAKE_INSTALL_DATADIR}/paperboat/runtimes COMPONENT cli)
install(FILES apps.toml toolkits.toml DESTINATION ${CMAKE_INSTALL_DATADIR}/paperboat COMPONENT cli)

include(CMakePackageConfigHelpers)
set(PAPERBOAT_CMAKE_DIR ${CMAKE_INSTALL_LIBDIR}/cmake/paperboat)
install(TARGETS paperboat_runtime EXPORT paperboatTargets ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR} COMPONENT devel)
install(DIRECTORY include/paperboat DESTINATION ${CMAKE_INSTALL_INCLUDEDIR} COMPONENT devel)
install(EXPORT paperboatTargets NAMESPACE paperboat:: DESTINATION ${PAPERBOAT_CMAKE_DIR} COMPONENT devel)
configure_package_config_file(cmake/paperboatConfig.cmake.in ${CMAKE_CURRENT_BINARY_DIR}/paperboatConfig.cmake
  INSTALL_DESTINATION ${PAPERBOAT_CMAKE_DIR} PATH_VARS CMAKE_INSTALL_INCLUDEDIR)
write_basic_package_version_file(${CMAKE_CURRENT_BINARY_DIR}/paperboatConfigVersion.cmake COMPATIBILITY SameMinorVersion)
install(FILES ${CMAKE_CURRENT_BINARY_DIR}/paperboatConfig.cmake ${CMAKE_CURRENT_BINARY_DIR}/paperboatConfigVersion.cmake
  DESTINATION ${PAPERBOAT_CMAKE_DIR} COMPONENT devel)
if(APPLE)  # no system nlohmann_json to depend on: the devel package carries its header
  install(DIRECTORY ${nlohmann_json_SOURCE_DIR}/include/nlohmann DESTINATION ${CMAKE_INSTALL_INCLUDEDIR} COMPONENT devel)
endif()

# ── packages: rpm (x86_64) and a macOS .pkg (arm64); deb and Windows are pb issues ──
set(CPACK_PACKAGE_NAME paperboat)
set(CPACK_PACKAGE_VENDOR "Paperboat Lab")
set(CPACK_PACKAGE_VERSION ${PROJECT_VERSION})
set(CPACK_PACKAGE_DESCRIPTION_SUMMARY "Paperboat: the paperboat CLI and the runtime daemon paperboatd")
set(CPACK_PACKAGE_HOMEPAGE_URL "https://github.com/paperboatlab/paperboat")
configure_file(LICENSE ${CMAKE_CURRENT_BINARY_DIR}/LICENSE.txt COPYONLY)  # productbuild takes .txt/.rtf/.html only
set(CPACK_RESOURCE_FILE_LICENSE ${CMAKE_CURRENT_BINARY_DIR}/LICENSE.txt)
set(CPACK_COMPONENTS_ALL cli devel)
set(CPACK_COMPONENT_CLI_DISPLAY_NAME "Paperboat CLI")
set(CPACK_COMPONENT_CLI_DESCRIPTION "paperboat and paperboatd, the runtimes and the registries")
set(CPACK_COMPONENT_CLI_DEPENDS devel)
set(CPACK_COMPONENT_DEVEL_DISPLAY_NAME "Paperboat development files")
set(CPACK_COMPONENT_DEVEL_DESCRIPTION "Headers, library and CMake package for paperboat::runtime")
# rpm: paperboat-cli and paperboat-devel; installing the CLI brings devel
set(CPACK_RPM_COMPONENT_INSTALL ON)
set(CPACK_RPM_FILE_NAME RPM-DEFAULT)
list(APPEND CPACK_RPM_EXCLUDE_FROM_AUTO_FILELIST_ADDITION ${CMAKE_INSTALL_PREFIX}/${CMAKE_INSTALL_LIBDIR}/cmake)
set(CPACK_RPM_PACKAGE_LICENSE "GPL-3.0-only")
set(CPACK_RPM_PACKAGE_RELEASE 1)
if(PAPERBOAT_PRERELEASE)
  set(CPACK_RPM_PACKAGE_RELEASE "0.${PAPERBOAT_PRERELEASE}")
endif()
set(CPACK_RPM_CLI_PACKAGE_REQUIRES "paperboat-devel = ${PROJECT_VERSION}-${CPACK_RPM_PACKAGE_RELEASE}")
set(CPACK_RPM_CLI_PACKAGE_SUGGESTS "podman")
set(CPACK_RPM_DEVEL_PACKAGE_REQUIRES "json-devel >= 3.11")
# macOS: one .pkg with both components
set(CPACK_PRODUCTBUILD_IDENTIFIER "org.paperboatlab.paperboat")
set(CPACK_PACKAGING_INSTALL_PREFIX /usr/local)  # productbuild's own default is not on PATH
include(CPack)

if(PAPERBOAT_BUILD_TESTS)
  FetchContent_Declare(Catch2
    URL https://github.com/catchorg/Catch2/archive/refs/tags/v3.16.1.tar.gz
    FIND_PACKAGE_ARGS 3)
  FetchContent_MakeAvailable(Catch2)
  enable_testing()
  add_subdirectory(tests)
endif()
