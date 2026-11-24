#pragma once

// The runtimes this host knows: every runtime.toml (or <name>.runtime.toml) in the catalog folders.
// Folders, in order: the ones shipped with paperboat (share/paperboat/runtimes), the user's
// ($PAPERBOAT_HOME/runtimes), $PAPERBOAT_RUNTIMES_PATH (':'-separated), and any an app or toolkit adds.

#include "paperboat/manifest.hpp"

#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace paperboat {

class Catalog {
 public:
  // Load every manifest under dir (recursively). A bad file is kept in errors(), never fatal.
  void add_dir(const fs::path& dir);
  void add(Manifest m);  // a later manifest with the same id replaces the earlier one

  const std::vector<Manifest>& all() const { return manifests_; }
  const std::vector<std::string>& errors() const { return errors_; }

  // "julia", "julia@1.11", "julia@1.11.6": the newest match, or nullptr.
  const Manifest* resolve(std::string_view spec) const;

 private:
  std::vector<Manifest> manifests_;
  std::vector<std::string> errors_;
};

// The default folders, in order (missing ones skipped by add_dir).
std::vector<fs::path> catalog_dirs();
Catalog default_catalog();

// "julia@1.11" -> {"julia", "1.11"}
std::pair<std::string, std::string> split_spec(std::string_view spec);

}  // namespace paperboat
