#include "paperboat/manifest.hpp"

#include <toml++/toml.hpp>

#include <algorithm>
#include <cctype>
#include <fstream>
#include <regex>
#include <sstream>

namespace paperboat {

namespace {

const std::vector<std::string> kModes = {"station", "session", "exec"};
const std::vector<std::string> kMounts = {"project", "deps", "work", "ipc", "lib"};

[[noreturn]] void fail(const fs::path& source, const std::string& key, const std::string& what) {
  throw ManifestError(source.string() + ": " + key + ": " + what);
}

std::string str(const toml::table& t, const std::string& key, const fs::path& src, bool required, std::string fallback = "") {
  const auto* node = t.get(key);
  if (!node) {
    if (required) fail(src, key, "missing");
    return fallback;
  }
  if (!node->is_string()) fail(src, key, "must be a string");
  return std::string(*node->value<std::string>());
}

std::vector<std::string> strings(const toml::node* node, const fs::path& src, const std::string& key) {
  std::vector<std::string> out;
  if (!node) return out;
  const auto* arr = node->as_array();
  if (!arr) fail(src, key, "must be an array of strings");
  for (const auto& v : *arr) {
    if (!v.is_string()) fail(src, key, "must be an array of strings");
    out.emplace_back(*v.value<std::string>());
  }
  return out;
}

std::map<std::string, std::vector<std::string>> entries(const toml::table* t, const fs::path& src, const std::string& key) {
  std::map<std::string, std::vector<std::string>> out;
  if (!t) return out;
  for (const auto& [k, v] : *t) {
    const std::string mode(k.str());
    if (std::ranges::find(kModes, mode) == kModes.end()) fail(src, key + "." + mode, "unknown mode (station, session, exec)");
    out[mode] = strings(&v, src, key + "." + mode);
  }
  return out;
}

std::chrono::seconds duration(const std::string& text, const fs::path& src, const std::string& key) {
  static const std::regex re(R"(^\s*(\d+)\s*(ms|s|m|h)?\s*$)");
  std::smatch m;
  if (!std::regex_match(text, m, re)) fail(src, key, "a duration like \"30s\" or \"2m\"");
  const long long n = std::stoll(m[1]);
  const std::string unit = m[2].matched ? m[2].str() : "s";
  if (unit == "ms") return std::chrono::seconds(std::max<long long>(1, n / 1000));
  if (unit == "m") return std::chrono::seconds(n * 60);
  if (unit == "h") return std::chrono::seconds(n * 3600);
  return std::chrono::seconds(n);
}

std::vector<long long> numbers(std::string_view v) {
  std::vector<long long> out;
  std::size_t i = 0;
  while (i < v.size() && std::isdigit(static_cast<unsigned char>(v[i]))) {
    long long n = 0;
    while (i < v.size() && std::isdigit(static_cast<unsigned char>(v[i]))) n = n * 10 + (v[i++] - '0');
    out.push_back(n);
    if (i < v.size() && v[i] == '.') ++i;
    else break;
  }
  return out;
}

}  // namespace

std::string Manifest::image() const {
  if (image_digest.empty()) return image_ref;
  // ref@digest: the tag is dropped, the digest decides (a registry ignores a tag beside a digest anyway)
  std::string repo = image_ref;
  const auto slash = repo.rfind('/');
  const auto colon = repo.rfind(':');
  if (colon != std::string::npos && (slash == std::string::npos || colon > slash)) repo.erase(colon);
  return repo + "@" + image_digest;
}

bool Manifest::has_mode(std::string_view mode) const { return std::ranges::find(modes, mode) != modes.end(); }

Manifest parse_manifest(std::string_view text, const fs::path& source) {
  toml::table t;
  try {
    t = toml::parse(text, source.string());
  } catch (const toml::parse_error& e) {
    std::ostringstream msg;
    msg << e.description() << " (line " << e.source().begin.line << ")";
    fail(source, "toml", msg.str());
  }
  for (const auto& [k, v] : t) {
    static const std::vector<std::string> known = {"name", "version", "protocol", "modes", "image", "entry", "mounts",
                                                   "env", "limits", "capabilities", "native", "healthcheck"};
    if (std::ranges::find(known, std::string(k.str())) == known.end()) fail(source, std::string(k.str()), "unknown key");
  }

  Manifest m;
  m.source = source;
  m.name = str(t, "name", source, true);
  static const std::regex name_re("^[a-z][a-z0-9-]*$");
  if (!std::regex_match(m.name, name_re)) fail(source, "name", "lowercase letters, digits and '-', starting with a letter");
  m.version = str(t, "version", source, true);
  if (numbers(m.version).empty()) fail(source, "version", "must start with a number (\"1.11.6\")");
  m.protocol = str(t, "protocol", source, true);
  m.modes = strings(t.get("modes"), source, "modes");
  if (m.modes.empty()) fail(source, "modes", "at least one of station, session, exec");
  for (const auto& mode : m.modes)
    if (std::ranges::find(kModes, mode) == kModes.end()) fail(source, "modes", "unknown mode \"" + mode + "\"");

  if (const auto* image = t["image"].as_table()) {
    m.image_ref = str(*image, "ref", source, true);
    m.image_digest = str(*image, "digest", source, false);
    static const std::regex digest_re("^sha256:[0-9a-f]{64}$");
    if (!m.image_digest.empty() && !std::regex_match(m.image_digest, digest_re))
      fail(source, "image.digest", "must be sha256:<64 lowercase hex>");
    m.arch = strings(image->get("arch"), source, "image.arch");
    m.image_signer = str(*image, "signer", source, false);
    m.image_issuer = str(*image, "issuer", source, false, m.image_issuer);
    if (!m.image_signer.empty() && m.image_digest.empty()) fail(source, "image.signer", "a signed image must be pinned (image.digest)");
  }

  m.entry = entries(t["entry"].as_table(), source, "entry");
  for (const auto& mode : m.modes)
    if (mode != "exec" && !m.image_ref.empty() && !m.entry.contains(mode))
      fail(source, "entry." + mode, "missing: the command for mode " + mode);

  m.mounts = {{"project", "/work/project"}, {"deps", "/work/deps"}, {"work", "/work/out"}, {"ipc", "/run/pb"}, {"lib", "/opt/pb"}};
  if (const auto* mounts = t["mounts"].as_table())
    for (const auto& [k, v] : *mounts) {
      const std::string key(k.str());
      if (std::ranges::find(kMounts, key) == kMounts.end()) fail(source, "mounts." + key, "unknown mount (project, deps, work, ipc, lib)");
      if (!v.is_string() || !v.value<std::string>()->starts_with("/")) fail(source, "mounts." + key, "an absolute path");
      m.mounts[key] = *v.value<std::string>();
    }

  if (const auto* env = t["env"].as_table())
    for (const auto& [k, v] : *env) {
      if (!v.is_string()) fail(source, "env." + std::string(k.str()), "must be a string");
      m.env.emplace_back(std::string(k.str()), *v.value<std::string>());
    }

  if (const auto* limits = t["limits"].as_table()) {
    m.limits.memory = str(*limits, "memory", source, false);
    if (const auto c = (*limits)["cpus"].value<double>()) m.limits.cpus = *c;
    if (const auto p = (*limits)["pids"].value<int64_t>()) m.limits.pids = static_cast<int>(*p);
  }
  if (const auto* caps = t["capabilities"].as_table()) {
    m.transports = strings(caps->get("transports"), source, "capabilities.transports");
    m.granularities = strings(caps->get("granularities"), source, "capabilities.granularities");
  }
  if (const auto* native = t["native"].as_table()) {
    m.native_requires = str(*native, "requires", source, true);
    m.native_entry = entries((*native)["entry"].as_table(), source, "native.entry");
  }
  if (m.image_ref.empty() && m.native_requires.empty()) fail(source, "image", "a runtime needs an [image] or a [native] recipe");
  if (const auto* hc = t["healthcheck"].as_table())
    m.hello_timeout = duration(str(*hc, "hello_timeout", source, false, "30s"), source, "healthcheck.hello_timeout");
  return m;
}

Manifest load_manifest(const fs::path& file) {
  std::ifstream in(file);
  if (!in) throw ManifestError(file.string() + ": cannot read");
  std::stringstream ss;
  ss << in.rdbuf();
  return parse_manifest(ss.str(), file);
}

nlohmann::json to_json(const Manifest& m) {
  return {{"id", m.id()},
          {"name", m.name},
          {"version", m.version},
          {"protocol", m.protocol},
          {"modes", m.modes},
          {"image", {{"ref", m.image_ref}, {"digest", m.image_digest}, {"arch", m.arch}, {"run", m.image()}, {"signer", m.image_signer}}},
          {"pinned", m.pinned()},
          {"native", {{"requires", m.native_requires}, {"modes", [&] {
                        std::vector<std::string> modes;
                        for (const auto& [k, v] : m.native_entry) modes.push_back(k);
                        return modes;
                      }()}}},
          {"limits", {{"memory", m.limits.memory}, {"cpus", m.limits.cpus}, {"pids", m.limits.pids}}},
          {"transports", m.transports},
          {"granularities", m.granularities},
          {"source", m.source.string()}};
}

int compare_versions(std::string_view a, std::string_view b) {
  const auto x = numbers(a), y = numbers(b);
  for (std::size_t i = 0; i < std::max(x.size(), y.size()); ++i) {
    const long long p = i < x.size() ? x[i] : -1, q = i < y.size() ? y[i] : -1;
    if (p != q) return p < q ? -1 : 1;
  }
  // the same numbers: what follows the - (semver's prerelease) orders them; none comes after any
  const auto pre = [](std::string_view v) { const auto at = v.find('-'); return at == v.npos ? std::string_view{} : v.substr(at + 1); };
  std::string_view p = pre(a), q = pre(b);
  if (p.empty() || q.empty()) return p.empty() == q.empty() ? 0 : p.empty() ? 1 : -1;
  // dot-separated: numbers numerically, before words; words as text; fewer parts first
  const auto num = [](std::string_view s) { return !s.empty() && std::ranges::all_of(s, [](char c) { return std::isdigit(static_cast<unsigned char>(c)); }); };
  while (!p.empty() || !q.empty()) {
    if (p.empty() || q.empty()) return p.empty() ? -1 : 1;
    const auto i = p.find('.'), j = q.find('.');
    const std::string_view s = p.substr(0, i), t = q.substr(0, j);
    p = i == p.npos ? std::string_view{} : p.substr(i + 1);
    q = j == q.npos ? std::string_view{} : q.substr(j + 1);
    if (num(s) && num(t)) {
      if (s.size() != t.size()) return s.size() < t.size() ? -1 : 1;  // no leading zeros: longer is larger
      if (s != t) return s < t ? -1 : 1;
    } else if (num(s) != num(t)) {
      return num(s) ? -1 : 1;
    } else if (s != t) {
      return s < t ? -1 : 1;
    }
  }
  return 0;
}

bool version_matches(std::string_view want, std::string_view have) {
  if (want.empty()) return true;
  const auto w = numbers(want), h = numbers(have);
  if (w.size() > h.size()) return false;
  return std::equal(w.begin(), w.end(), h.begin());
}

std::vector<std::string> expand(const std::vector<std::string>& argv, const std::map<std::string, std::string>& vars) {
  std::vector<std::string> out;
  out.reserve(argv.size());
  for (std::string a : argv) {
    for (const auto& [k, v] : vars) {
      const std::string key = "{" + k + "}";
      for (std::size_t at = a.find(key); at != std::string::npos; at = a.find(key, at + v.size())) a.replace(at, key.size(), v);
    }
    out.push_back(std::move(a));
  }
  return out;
}

}  // namespace paperboat
