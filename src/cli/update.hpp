// `paperboat update --install` (pb#94): which of a release's packages this system takes, their SHA-256, the
// command that installs them behind the system's own privilege prompt, and what its exit means. No network and
// no process here, so each part is tested on its own (tests/update_test.cpp); main.cpp runs them.
#pragma once

#include <nlohmann/json.hpp>

#include <cstdint>
#include <filesystem>
#include <map>
#include <string>
#include <string_view>
#include <vector>

namespace paperboat::update {

// How Paperboat is installed here: the package kind (rpm, deb, pkg), the machine (uname -m) and the packages
// of ours that are installed (cli, devel, launcher). An empty kind: not from a package (a build from source).
struct System {
  std::string kind;
  std::string arch;
  std::vector<std::string> parts;
};

// "rpm x86_64 cli devel launcher": $PAPERBOAT_UPDATE_SYSTEM, so the tests need no package installed.
System parse_system(std::string_view text);

// One file of a release, as GitHub lists it: `digest` is "sha256:<hex>" (GitHub's own, since 2025), or empty.
struct Asset {
  std::string name;
  std::string url;
  std::string digest;
  std::int64_t size = 0;
};

// The release's files this system installs, one per installed part (the macOS .pkg holds them all). Throws
// std::runtime_error saying what is missing: a release without a package for this system installs nothing.
std::vector<Asset> choose(const std::vector<Asset>& files, const System& sys);

// A SHA256SUMS file (`sha256sum` output: "<hex>  <name>", or "<hex> *<name>") as name → hex.
std::map<std::string, std::string> parse_sums(std::string_view text);

// The hex SHA-256 the release publishes for `a`: GitHub's digest, else the SHA256SUMS line; "" when neither.
std::string expected_sha256(const Asset& a, const std::map<std::string, std::string>& sums);

// FIPS 180-4 SHA-256, as lowercase hex.
std::string sha256_hex(std::string_view data);
std::string sha256_file(const std::filesystem::path& file);

// The command that installs `files` as root, asking for the password the system's way: pkexec (polkit's
// dialog) for dnf and apt-get, the administrator authorization (osascript … with administrator privileges)
// for macOS's installer. Paths go as arguments, never through a shell.
std::vector<std::string> install_argv(const System& sys, const std::vector<std::filesystem::path>& files);

enum class Outcome { installed, cancelled, failed };
// pkexec exits 126 when the dialog is dismissed and 127 when the password is refused: nothing ran. osascript
// says "User canceled. (-128)".
Outcome outcome(const System& sys, int exit_code, std::string_view err);

}  // namespace paperboat::update
