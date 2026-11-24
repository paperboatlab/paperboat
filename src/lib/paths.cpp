#include "paperboat/paths.hpp"

#include <cstdlib>
#include <fstream>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace paperboat::paths {

namespace {
std::string env(const char* key) {
  const char* v = std::getenv(key);
  return v ? v : "";
}
}  // namespace

fs::path home() {
  if (const auto v = env("PAPERBOAT_HOME"); !v.empty()) return v;
#ifdef _WIN32
  if (const auto v = env("LOCALAPPDATA"); !v.empty()) return fs::path(v) / "paperboat";
#endif
  if (const auto v = env("XDG_DATA_HOME"); !v.empty()) return fs::path(v) / "paperboat";
  return fs::path(env("HOME")) / ".local" / "share" / "paperboat";
}

fs::path runtime_dir() {
  if (const auto v = env("PAPERBOAT_RUNTIME_DIR"); !v.empty()) return v;
#ifdef _WIN32
  return home() / "run";
#else
  if (const auto v = env("XDG_RUNTIME_DIR"); !v.empty()) return fs::path(v) / "paperboat";
  return fs::temp_directory_path() / ("paperboat-" + std::to_string(getuid()));
#endif
}

fs::path control_socket() { return runtime_dir() / "control.sock"; }

fs::path exe_dir() {
#ifdef _WIN32
  wchar_t buf[MAX_PATH];
  const DWORD n = GetModuleFileNameW(nullptr, buf, MAX_PATH);
  return fs::path(std::wstring(buf, n)).parent_path();
#else
  std::error_code ec;
  const auto p = fs::read_symlink("/proc/self/exe", ec);
  return ec ? fs::current_path() : p.parent_path();
#endif
}

std::string boot_id() {
  std::ifstream f("/proc/sys/kernel/random/boot_id");
  std::string id;
  std::getline(f, id);
  return id;
}

}  // namespace paperboat::paths
