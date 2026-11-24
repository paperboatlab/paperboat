#include "paperboat/catalog.hpp"

#include "paperboat/paths.hpp"

#include <algorithm>
#include <cstdlib>

namespace paperboat {

void Catalog::add(Manifest m) {
  std::erase_if(manifests_, [&](const Manifest& x) { return x.id() == m.id(); });
  manifests_.push_back(std::move(m));
}

void Catalog::add_dir(const fs::path& dir) {
  std::error_code ec;
  if (!fs::is_directory(dir, ec)) return;
  std::vector<fs::path> files;
  for (auto it = fs::recursive_directory_iterator(dir, fs::directory_options::skip_permission_denied, ec);
       !ec && it != fs::recursive_directory_iterator(); it.increment(ec)) {
    const std::string name = it->path().filename().string();
    if (it->is_regular_file(ec) && (name == "runtime.toml" || name.ends_with(".runtime.toml"))) files.push_back(it->path());
  }
  std::ranges::sort(files);  // a stable order, so "a later one replaces" means something
  for (const auto& f : files) {
    try {
      add(load_manifest(f));
    } catch (const ManifestError& e) {
      errors_.emplace_back(e.what());
    }
  }
}

std::pair<std::string, std::string> split_spec(std::string_view spec) {
  const auto at = spec.find('@');
  if (at == std::string_view::npos) return {std::string(spec), ""};
  return {std::string(spec.substr(0, at)), std::string(spec.substr(at + 1))};
}

const Manifest* Catalog::resolve(std::string_view spec) const {
  const auto [name, version] = split_spec(spec);
  const Manifest* best = nullptr;
  for (const auto& m : manifests_)
    if (m.name == name && version_matches(version, m.version) && (!best || compare_versions(m.version, best->version) > 0))
      best = &m;
  return best;
}

std::vector<fs::path> catalog_dirs() {
  std::vector<fs::path> dirs;
  dirs.push_back(paths::exe_dir().parent_path() / "share" / "paperboat" / "runtimes");  // installed
  dirs.push_back(paths::exe_dir() / "runtimes");                                        // a build tree
  dirs.push_back(paths::home() / "runtimes");
  if (const char* extra = std::getenv("PAPERBOAT_RUNTIMES_PATH")) {
    std::string_view rest = extra;
    while (!rest.empty()) {
      const auto colon = rest.find(':');
      if (const auto part = rest.substr(0, colon); !part.empty()) dirs.emplace_back(part);
      if (colon == std::string_view::npos) break;
      rest.remove_prefix(colon + 1);
    }
  }
  return dirs;
}

Catalog default_catalog() {
  Catalog c;
  for (const auto& d : catalog_dirs()) c.add_dir(d);
  return c;
}

}  // namespace paperboat
