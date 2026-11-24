#pragma once

// A paperboatd of a test's own (socket, state, runtimes), against real podman.

#include "paperboat/backend.hpp"
#include "paperboat/control.hpp"
#include "paperboat/paths.hpp"
#include "paperboat/process.hpp"

#include <catch2/catch_test_macros.hpp>

#include <csignal>
#include <fstream>
#include <functional>
#include <sstream>
#include <thread>

#include <sys/wait.h>
#include <unistd.h>

namespace test {

using namespace paperboat;
using namespace std::chrono_literals;


inline bool podman_ok() {
  static const bool ok = !which("podman").empty() && ProcessRunner::run_sync({"podman", "info"}, {}, {}, 20s).ok();
  return ok;
}

#define NEED_PODMAN() \
  if (!podman_ok()) SKIP("podman is not available")

// A daemon of our own: its socket, state and runtimes (the shipped ones plus a test folder).
struct Daemon {
  fs::path root = fs::temp_directory_path() / ("pb-ct-" + std::to_string(::getpid()) + "-" + std::to_string(std::rand()));
  fs::path socket = root / "run" / "control.sock";
  fs::path extra = root / "runtimes";
  pid_t pid = -1;

  Daemon() { fs::create_directories(extra); }
  ~Daemon() {
    stop();
    for (const auto& name : names("paperboat.test=" + root.filename().string()))
      ProcessRunner::run_sync({"podman", "rm", "-f", "-t", "0", name}, {}, {}, 30s);
    std::error_code ec;
    fs::remove_all(root, ec);
  }

  static std::vector<std::string> names(const std::string& label) {
    const auto r = ProcessRunner::run_sync({"podman", "ps", "-a", "--filter", "label=" + label, "--format", "{{.Names}}"}, {}, {}, 20s);
    std::vector<std::string> out;
    std::istringstream in(r.stdout_text);
    for (std::string line; std::getline(in, line);)
      if (!line.empty()) out.push_back(line);
    return out;
  }

  void start() {
    fs::create_directories(socket.parent_path());
    const std::vector<std::string> argv = {std::string(PAPERBOAT_BIN_DIR) + "/paperboatd", "--socket", socket.string(), "--state",
                                           (root / "state").string(), "--runtimes", PAPERBOAT_RUNTIMES_DIR, "--runtimes",
                                           extra.string(), "--idle-exit", "0"};
    pid = ProcessRunner::run_detached(argv, {}, {}, root / "daemon.log");
    REQUIRE(pid > 0);
    for (int i = 0; i < 100 && !fs::exists(socket); ++i) std::this_thread::sleep_for(100ms);
    REQUIRE(fs::exists(socket));
  }

  void kill9() {
    ::kill(pid, SIGKILL);
    ::waitpid(pid, nullptr, 0);
    pid = -1;
  }

  void stop() {
    if (pid <= 0) return;
    ::kill(pid, SIGTERM);
    for (int i = 0; i < 150 && ::waitpid(pid, nullptr, WNOHANG) == 0; ++i) std::this_thread::sleep_for(100ms);
    pid = -1;
  }

  std::unique_ptr<ControlClient> client() { return std::make_unique<ControlClient>(socket, false); }

  std::string log() {
    std::ifstream in(root / "daemon.log");
    return std::string(std::istreambuf_iterator<char>(in), {});
  }
};

inline std::vector<std::string> containers(const std::string& label) { return Daemon::names(label); }

inline bool eventually(const std::function<bool()>& f, std::chrono::milliseconds limit = 15s) {
  for (auto t0 = std::chrono::steady_clock::now(); std::chrono::steady_clock::now() - t0 < limit;) {
    if (f()) return true;
    std::this_thread::sleep_for(200ms);
  }
  return f();
}

}  // namespace test
