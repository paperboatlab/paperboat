add_executable(paperboat_tests
  process_test.cpp
  manifest_test.cpp
  manager_test.cpp)
target_link_libraries(paperboat_tests PRIVATE paperboat::runtime Catch2::Catch2WithMain paperboat_warnings)
target_include_directories(paperboat_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
target_compile_definitions(paperboat_tests PRIVATE PAPERBOAT_SOURCE_RUNTIMES="${PROJECT_SOURCE_DIR}/runtimes")

# Against a real engine: tagged [podman], skipped (and reported) when podman is missing.
add_executable(paperboat_container_tests container_test.cpp runtime_test.cpp)
target_link_libraries(paperboat_container_tests PRIVATE paperboat::runtime Catch2::Catch2WithMain paperboat_warnings)
target_compile_definitions(paperboat_container_tests PRIVATE
  PAPERBOAT_BIN_DIR="$<TARGET_FILE_DIR:paperboatd>"
  PAPERBOAT_RUNTIMES_DIR="${PROJECT_SOURCE_DIR}/runtimes")
add_dependencies(paperboat_container_tests paperboatd paperboat)

include(Catch)
catch_discover_tests(paperboat_tests)
catch_discover_tests(paperboat_container_tests PROPERTIES LABELS container)
