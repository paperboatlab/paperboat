#pragma once

// A runtime is data, not code: one runtime.toml says which image to run, how to start it in each mode,
// where the daemon mounts the project, dependencies, work and IPC folders, and what it may use. Adding a
// runtime is adding a file; nothing here knows a runtime by name.

#include <nlohmann/json.hpp>

#include <chrono>
#include <filesystem>
#include <map>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace paperboat {

namespace fs = std::filesystem;

struct ManifestError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

struct Limits {
  std::string memory;  // "4g"; "" = backend default
  double cpus = 0;     // 0 = no limit
  int pids = 0;        // 0 = backend default
};

struct Manifest {
  std::string name, version, protocol;
  std::vector<std::string> modes;  // station | session | exec (exec: the caller supplies the command)

  std::string image_ref;     // "ghcr.io/paperboatlab/paperboat-runtime-julia:1.11.6-r1"
  std::string image_digest;  // "sha256:<64 hex>": what runs; the tag is for humans
  std::vector<std::string> arch;

  // mode -> argv inside the image; {ipc} {project} {deps} {work} {lease} are filled in at start
  std::map<std::string, std::vector<std::string>> entry;
  // project | deps | work | ipc -> path inside the container
  std::map<std::string, std::string> mounts;
  std::vector<std::pair<std::string, std::string>> env;
  Limits limits;
  std::vector<std::string> transports, granularities;

  // The native backend's recipe: a tool on PATH ("julia"), and argv per mode ({runtime} = this file's folder)
  std::string native_requires;
  std::map<std::string, std::vector<std::string>> native_entry;

  std::chrono::seconds hello_timeout{30};
  fs::path source;  // the file it was read from

  std::string id() const { return name + "@" + version; }
  // What a container backend runs: ref@digest when pinned, else the ref (refused unless allowed).
  std::string image() const;
  bool pinned() const { return !image_digest.empty(); }
  bool has_mode(std::string_view mode) const;
};

// Parse a runtime.toml. Every error names the file and the key.
Manifest parse_manifest(std::string_view toml, const fs::path& source = "<memory>");
Manifest load_manifest(const fs::path& file);

nlohmann::json to_json(const Manifest& m);

// "1.11.6" vs "1.11": numeric, component by component; a missing component sorts first.
int compare_versions(std::string_view a, std::string_view b);
// "1.11" matches "1.11", "1.11.6", "1.11.6-r2"; "" matches everything.
bool version_matches(std::string_view want, std::string_view have);

// Replace {key} in each argument from vars; unknown keys stay as written.
std::vector<std::string> expand(const std::vector<std::string>& argv, const std::map<std::string, std::string>& vars);

}  // namespace paperboat
