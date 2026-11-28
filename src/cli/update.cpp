#include "update.hpp"

#include <array>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <stdexcept>

namespace paperboat::update {

namespace {

std::vector<std::string> words(std::string_view s) {
  std::vector<std::string> out;
  std::istringstream in{std::string(s)};
  for (std::string w; in >> w;) out.push_back(w);
  return out;
}

bool has_part(const System& sys, std::string_view p) {
  for (const auto& x : sys.parts)
    if (x == p) return true;
  return false;
}

std::string deb_arch(const std::string& arch) { return arch == "x86_64" ? "amd64" : arch == "aarch64" ? "arm64" : arch; }

// The release's package of `part` for this system, or nullptr.
const Asset* package_of(const std::vector<Asset>& files, const System& sys, const std::string& part) {
  const std::string stem = "paperboat-" + part;
  for (const auto& f : files) {
    const std::string& n = f.name;
    if (!n.starts_with(stem) || n.size() <= stem.size() || (n[stem.size()] != '-' && n[stem.size()] != '_')) continue;
    if (sys.kind == "rpm" && n.ends_with("." + sys.arch + ".rpm")) return &f;
    if (sys.kind == "deb" && n.ends_with(".deb") && (n.ends_with("_" + deb_arch(sys.arch) + ".deb") || n.ends_with("." + deb_arch(sys.arch) + ".deb")))
      return &f;
  }
  return nullptr;
}

// ── SHA-256 (FIPS 180-4) ──

constexpr std::array<std::uint32_t, 64> kK = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
    0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
    0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
    0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
    0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

constexpr std::uint32_t rotr(std::uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

class Sha256 {
 public:
  void add(std::string_view data) {
    for (const char c : data) {
      block_[used_++] = static_cast<unsigned char>(c);
      if (used_ == 64) compress(), used_ = 0;
    }
    bits_ += static_cast<std::uint64_t>(data.size()) * 8;
  }
  std::string hex() {
    const std::uint64_t bits = bits_;
    block_[used_++] = 0x80;
    if (used_ > 56) {
      while (used_ < 64) block_[used_++] = 0;
      compress(), used_ = 0;
    }
    while (used_ < 56) block_[used_++] = 0;
    for (int i = 7; i >= 0; --i) block_[used_++] = static_cast<unsigned char>(bits >> (8 * i));
    compress();
    std::string out;
    char b[9];
    for (const auto v : h_) std::snprintf(b, sizeof b, "%08x", v), out += b;
    return out;
  }

 private:
  void compress() {
    std::array<std::uint32_t, 64> w{};
    for (std::size_t i = 0; i < 16; ++i)
      w[i] = std::uint32_t{block_[4 * i]} << 24 | std::uint32_t{block_[4 * i + 1]} << 16 | std::uint32_t{block_[4 * i + 2]} << 8 | block_[4 * i + 3];
    for (std::size_t i = 16; i < 64; ++i) {
      const std::uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
      const std::uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    auto [a, b, c, d, e, f, g, h] = h_;
    for (std::size_t i = 0; i < 64; ++i) {
      const std::uint32_t t1 = h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + kK[i] + w[i];
      const std::uint32_t t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      h = g, g = f, f = e, e = d + t1, d = c, c = b, b = a, a = t1 + t2;
    }
    const std::array<std::uint32_t, 8> add{a, b, c, d, e, f, g, h};
    for (std::size_t i = 0; i < 8; ++i) h_[i] += add[i];
  }
  std::array<std::uint32_t, 8> h_{0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  std::array<unsigned char, 64> block_{};
  std::size_t used_ = 0;
  std::uint64_t bits_ = 0;
};

bool is_hex64(std::string_view s) {
  if (s.size() != 64) return false;
  for (const char c : s)
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  return true;
}

std::string lower(std::string s) {
  for (auto& c : s)
    if (c >= 'A' && c <= 'F') c = static_cast<char>(c - 'A' + 'a');
  return s;
}

}  // namespace

System parse_system(std::string_view text) {
  auto w = words(text);
  System s;
  if (!w.empty()) s.kind = w[0];
  if (w.size() > 1) s.arch = w[1];
  for (std::size_t i = 2; i < w.size(); ++i) s.parts.push_back(w[i]);
  return s;
}

std::vector<Asset> choose(const std::vector<Asset>& files, const System& sys) {
  if (sys.kind.empty() || sys.parts.empty()) throw std::runtime_error("Paperboat isn't installed from a package here");
  std::vector<Asset> out;
  if (sys.kind == "pkg") {
    // one .pkg holds cli and devel; it is built for Apple silicon (package.yml's macos-arm)
    for (const auto& f : files)
      if (f.name.starts_with("paperboat-") && f.name.ends_with(".pkg")) {
        const bool for_this = sys.arch == "arm64" || f.name.find(sys.arch) != std::string::npos || f.name.find("universal") != std::string::npos;
        if (!for_this) throw std::runtime_error("the release's macOS package is for Apple silicon, not " + sys.arch);
        out.push_back(f);
        return out;
      }
    throw std::runtime_error("the release has no macOS package");
  }
  if (sys.kind != "rpm" && sys.kind != "deb") throw std::runtime_error("no packages of kind " + sys.kind);
  for (const std::string part : {"cli", "devel", "launcher"}) {
    if (!has_part(sys, part)) continue;
    const Asset* a = package_of(files, sys, part);
    if (!a) throw std::runtime_error("the release has no " + sys.kind + " of paperboat-" + part + " for " + sys.arch);
    out.push_back(*a);
  }
  if (out.empty()) throw std::runtime_error("none of Paperboat's packages is installed here");
  return out;
}

std::map<std::string, std::string> parse_sums(std::string_view text) {
  std::map<std::string, std::string> out;
  std::istringstream in{std::string(text)};
  for (std::string line; std::getline(in, line);) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    const auto sp = line.find(' ');
    if (sp == std::string::npos) continue;
    std::string hex = lower(line.substr(0, sp));
    std::string name = line.substr(sp + 1);
    if (name.starts_with(' ') || name.starts_with('*')) name.erase(0, 1);  // "  name" (text) or " *name" (binary)
    if (is_hex64(hex) && !name.empty()) out[name] = std::move(hex);
  }
  return out;
}

std::string expected_sha256(const Asset& a, const std::map<std::string, std::string>& sums) {
  if (a.digest.starts_with("sha256:") && is_hex64(lower(a.digest.substr(7)))) return lower(a.digest.substr(7));
  const auto it = sums.find(a.name);
  return it == sums.end() ? "" : it->second;
}

std::string sha256_hex(std::string_view data) {
  Sha256 h;
  h.add(data);
  return h.hex();
}

std::string sha256_file(const std::filesystem::path& file) {
  std::ifstream in(file, std::ios::binary);
  if (!in) throw std::runtime_error("can't read " + file.string());
  Sha256 h;
  std::array<char, 1 << 16> buf{};
  while (in.read(buf.data(), buf.size()) || in.gcount() > 0) h.add({buf.data(), static_cast<std::size_t>(in.gcount())});
  return h.hex();
}

std::vector<std::string> install_argv(const System& sys, const std::vector<std::filesystem::path>& files) {
  std::vector<std::string> argv;
  if (sys.kind == "rpm") argv = {"pkexec", "dnf", "install", "-y"};
  else if (sys.kind == "deb") argv = {"pkexec", "apt-get", "install", "-y"};
  else if (sys.kind == "pkg") {
    if (files.size() != 1) throw std::runtime_error("macOS installs one .pkg");
    // `quoted form of` the path, an argument of the script: nothing of it reaches the shell unquoted
    return {"osascript", "-e", "on run argv", "-e",
            "do shell script \"/usr/sbin/installer -pkg \" & quoted form of (item 1 of argv) & \" -target /\" with administrator privileges",
            "-e", "end run", std::filesystem::absolute(files[0]).string()};
  } else throw std::runtime_error("no installer for packages of kind " + sys.kind);
  for (const auto& f : files) argv.push_back(std::filesystem::absolute(f).string());  // dnf and apt take a path, not a name
  return argv;
}

Outcome outcome(const System& sys, int exit_code, std::string_view err) {
  if (exit_code == 0) return Outcome::installed;
  if (sys.kind == "pkg") return err.find("-128") != std::string_view::npos ? Outcome::cancelled : Outcome::failed;
  return exit_code == 126 || exit_code == 127 ? Outcome::cancelled : Outcome::failed;
}

}  // namespace paperboat::update
