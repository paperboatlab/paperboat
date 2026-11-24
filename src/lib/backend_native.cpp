// native: a runtime as a process group on the host, for Windows/macOS without a VM and for stations
// that need the host's GPU or camera. Same interface, weaker isolation: only the environment is
// cleaned (ARCHITECTURE invariant: no inherited PYTHON*/JULIA_*/CONDA_*/LD_LIBRARY_PATH).
// POSIX for now; the Windows half (job objects) follows with the Windows port.

#include "paperboat/backend.hpp"

#include <csignal>
#include <fstream>
#include <map>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <thread>

#ifndef _WIN32
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace paperboat {

namespace {

using json = nlohmann::json;

const std::vector<std::string> kScrubbed = {"PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "VIRTUAL_ENV", "CONDA_PREFIX",
                                            "JULIA_PROJECT", "JULIA_DEPOT_PATH", "JULIA_LOAD_PATH", "LD_LIBRARY_PATH",
                                            "LD_PRELOAD", "DYLD_LIBRARY_PATH"};

class NativeBackend final : public Backend {
 public:
  explicit NativeBackend(fs::path state) : state_(std::move(state)) {}

  std::string name() const override { return "native"; }

  Availability probe() override {
#ifdef _WIN32
    return {false, "the native backend is not ported to Windows yet", false, false};
#else
    return {true, "processes on this host (environment cleaned, no sandbox)", false, false};
#endif
  }

  bool can_run(const Manifest& m) const override { return !m.native_requires.empty(); }
  bool has_image(const Manifest& m) override { return can_run(m) && !which(m.native_requires).empty(); }

  ProcessResult pull(const Manifest& m, ProcessOutputCallback) override {
    ProcessResult r;
    r.exit_code = has_image(m) ? 0 : 1;
    if (r.exit_code) r.stderr_text = m.native_requires + " is not on PATH";
    return r;
  }

  std::vector<std::string> command(const LaunchSpec& spec) const override {
    const Manifest& m = *spec.manifest;
    std::vector<std::string> a = {"env"};
    for (const auto& k : kScrubbed) a.insert(a.end(), {"-u", k});
    const std::map<std::string, std::string> vars = {{"ipc", spec.ipc.string()}, {"project", spec.project.string()},
                                                     {"deps", spec.deps.string()}, {"work", spec.work.string()},
                                                     {"lease", spec.name}, {"runtime", m.source.parent_path().string()},
                                                     {"lib", spec.lib.string()}};
    // The image's env names container paths; natively the same variables point at host folders.
    for (const auto& [k, v] : m.env) {
      // The image's identity variables describe the container, not this host: a native runtime keeps
      // the user's (HOME=/tmp would send juliaup and pip to the wrong place).
      if (k == "HOME" || k == "USER" || k == "PATH") continue;
      std::string value = v;
      for (const auto& [mount, inside] : m.mounts) {
        const std::string host = mount == "ipc" ? spec.ipc.string() : mount == "project" ? spec.project.string()
                                 : mount == "deps" ? spec.deps.string() : mount == "lib" ? spec.lib.string() : spec.work.string();
        for (auto at = value.find(inside); at != std::string::npos; at = value.find(inside, at + host.size()))
          value.replace(at, inside.size(), host);
      }
      a.push_back(k + "=" + value);
    }
    a.push_back("PAPERBOAT_IPC=" + spec.ipc.string());
    a.push_back("PAPERBOAT_MODE=" + spec.mode);
    if (!spec.project.empty()) a.push_back("PAPERBOAT_PROJECT=" + spec.project.string());
    if (!spec.deps.empty()) a.push_back("PAPERBOAT_DEPS=" + spec.deps.string());
    std::vector<std::string> argv;
    if (spec.mode == "exec") argv = spec.command;
    else if (const auto it = m.native_entry.find(spec.mode); it != m.native_entry.end()) argv = expand(it->second, vars);
    a.insert(a.end(), argv.begin(), argv.end());
    return a;
  }

  Instance start(const LaunchSpec& spec) override {
#ifdef _WIN32
    throw std::runtime_error("the native backend is not ported to Windows yet");
#else
    const Manifest& m = *spec.manifest;
    if (!has_image(m)) throw std::runtime_error(m.id() + " natively needs " + m.native_requires + " on PATH");
    if (spec.mode == "exec" ? spec.command.empty() : !m.native_entry.contains(spec.mode))
      throw std::runtime_error(m.id() + " has no native " + spec.mode + " entry");
    const auto argv = command(spec);
    const int pid = ProcessRunner::run_detached(argv, spec.work.empty() ? fs::path() : spec.work, {}, spec.log);
    if (pid <= 0) throw std::runtime_error("could not start " + m.id() + " natively");
    Instance i{"native", spec.name, "running", -1, pid, spec.labels};
    {
      std::lock_guard lock(mutex_);
      fs::create_directories(state_);
      std::ofstream(state_ / (spec.name + ".json")) << to_json(i).dump() << "\n";
      logs_[spec.name] = spec.log;
    }
    return i;
#endif
  }

  bool stop(const std::string& name) override {
#ifndef _WIN32
    const auto rec = read(name);
    if (rec && rec->pid > 0) {
      ::kill(-rec->pid, SIGTERM);
      for (int i = 0; i < 30 && alive(rec->pid); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
      if (alive(rec->pid)) {
        ::kill(-rec->pid, SIGKILL);
        for (int i = 0; i < 20 && alive(rec->pid); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(50));
      }
    }
#endif
    std::lock_guard lock(mutex_);
    std::error_code ec;
    fs::remove(state_ / (name + ".json"), ec);
    exits_.erase(name);
    return true;
  }

  std::vector<Instance> list() override {
    std::vector<Instance> out;
    std::error_code ec;
    for (const auto& e : fs::directory_iterator(state_, ec)) {
      if (e.path().extension() != ".json") continue;
      if (auto i = read(e.path().stem().string())) {
        if (!alive(i->pid)) {
          i->state = "exited";
          std::lock_guard lock(mutex_);
          if (const auto it = exits_.find(i->name); it != exits_.end()) i->exit_code = it->second;
        }
        out.push_back(std::move(*i));
      }
    }
    return out;
  }

  Stats stats(const std::string& name) override {
    Stats s;
#ifdef __linux__
    const auto rec = read(name);
    if (!rec || !alive(rec->pid)) return s;
    std::ifstream statm("/proc/" + std::to_string(rec->pid) + "/statm");
    long long size = 0, resident = 0;
    if (statm >> size >> resident) s.memory_bytes = resident * sysconf(_SC_PAGESIZE);
    long long n = 0;
    std::error_code ec;
    for (const auto& e : fs::directory_iterator("/proc", ec)) {  // processes in its group
      std::ifstream stat(e.path() / "stat");
      std::string line;
      if (!std::getline(stat, line)) continue;
      const auto close = line.rfind(')');
      if (close == std::string::npos) continue;
      std::istringstream rest(line.substr(close + 2));
      std::string st;
      long long ppid = 0, pgrp = 0;
      if (rest >> st >> ppid >> pgrp && pgrp == rec->pid) ++n;
    }
    s.pids = n;
#else
    (void)name;
#endif
    return s;
  }

  std::string logs(const std::string& name, int tail) override {
    fs::path log;
    {
      std::lock_guard lock(mutex_);
      if (const auto it = logs_.find(name); it != logs_.end()) log = it->second;
    }
    std::ifstream in(log);
    std::vector<std::string> lines;
    for (std::string l; std::getline(in, l);) lines.push_back(l);
    std::string out;
    for (std::size_t i = lines.size() > static_cast<std::size_t>(tail) ? lines.size() - tail : 0; i < lines.size(); ++i)
      out += lines[i] + "\n";
    return out;
  }

  bool signal(const std::string& name, int sig) override {
#ifdef _WIN32
    (void)name;
    (void)sig;
    return false;
#else
    const auto rec = read(name);
    return rec && rec->pid > 0 && ::kill(rec->pid, sig) == 0;  // the runtime itself (env execs into it)
#endif
  }

  std::vector<std::string> remove_command(const Instance& i) const override {
    return {"kill", "-KILL", "--", "-" + std::to_string(i.pid)};
  }

 private:
  std::optional<Instance> read(const std::string& name) {
    std::ifstream in(state_ / (name + ".json"));
    if (!in) return std::nullopt;
    try {
      const json j = json::parse(in);
      Instance i{"native", j.value("name", name), "running", -1, j.value("pid", -1), {}};
      const json labels = j.value("labels", json::object());
      for (const auto& [k, v] : labels.items()) i.labels[k] = v.get<std::string>();
      return i;
    } catch (...) {
      return std::nullopt;
    }
  }

  bool alive(int pid) {
#ifdef _WIN32
    (void)pid;
    return false;
#else
    if (pid <= 0) return false;
    int status = 0;
    const pid_t r = waitpid(pid, &status, WNOHANG);  // our child: reap it and keep its exit code
    if (r == pid) {
      std::lock_guard lock(mutex_);
      for (const auto& e : fs::directory_iterator(state_)) {
        std::ifstream in(e.path());
        try {
          if (json::parse(in).value("pid", -1) == pid)
            exits_[e.path().stem().string()] = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
        } catch (...) {
        }
      }
      return false;
    }
    if (r < 0) return ::kill(pid, 0) == 0;  // not ours (a previous daemon's): it is alive if it answers
    return true;
#endif
  }

  fs::path state_;
  std::mutex mutex_;
  std::map<std::string, int> exits_;
  std::map<std::string, fs::path> logs_;
};

}  // namespace

std::unique_ptr<Backend> make_native_backend(const fs::path& state) { return std::make_unique<NativeBackend>(state); }

}  // namespace paperboat
