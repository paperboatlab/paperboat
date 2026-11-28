#pragma once

// Where a runtime runs. Backends are plugins behind one interface: podman and docker (one OCI CLI
// backend, two engines) and native (a process on the host). A remote host or Kubernetes is another
// implementation, and callers do not change.

#include "paperboat/manifest.hpp"
#include "paperboat/policy.hpp"
#include "paperboat/process.hpp"

#include <nlohmann/json.hpp>

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace paperboat {

struct Availability {
  bool ok = false;
  std::string detail;   // why not, or the engine's version
  bool rootless = false;
  bool selinux = false;
};

// Everything a backend needs to start one runtime instance.
struct LaunchSpec {
  const Manifest* manifest = nullptr;
  std::string mode;                     // a mode the manifest has
  std::vector<std::string> command;     // exec mode: the command to run
  std::string name;                     // the instance name: pb-<runtime>-<ver>-<projecthash>-<n>
  fs::path project, deps, work, ipc;    // host folders (project may be empty)
  fs::path lib;                         // the runtime library (empty: none)
  Policy policy;
  bool readonly = false;                // the project can't be written (pb#85): :ro, or a sandbox natively
  std::map<std::string, std::string> labels;
  fs::path log;                         // native: where output goes
};

struct Instance {
  std::string backend, name;
  std::string state;                    // running | exited | created | unknown
  int exit_code = -1;
  int pid = -1;                         // native: the process group leader
  std::map<std::string, std::string> labels;
};

struct Stats {
  double cpu_percent = -1;              // -1: unavailable
  long long memory_bytes = -1;
  long long pids = -1;
};

class Backend {
 public:
  virtual ~Backend() = default;
  virtual std::string name() const = 0;           // podman | docker | native
  virtual Availability probe() = 0;
  virtual bool can_run(const Manifest& m) const = 0;
  virtual bool has_image(const Manifest& m) = 0;  // native: true when `requires` is on PATH
  virtual ProcessResult pull(const Manifest& m, ProcessOutputCallback progress = nullptr) = 0;
  // The exact command start() runs: shown by the Launcher, asserted by tests.
  virtual std::vector<std::string> command(const LaunchSpec& spec) const = 0;
  virtual Instance start(const LaunchSpec& spec) = 0;  // throws std::runtime_error
  virtual bool stop(const std::string& name) = 0;      // stop and remove; true if gone
  virtual std::vector<Instance> list() = 0;            // every instance with a paperboat.daemon label
  virtual Stats stats(const std::string& name) = 0;
  virtual std::string logs(const std::string& name, int tail = 200) = 0;
  // Deliver a signal to the runtime process (SIGINT interrupts a session's running cell).
  virtual bool signal(const std::string& name, int sig) = 0;
  // The command a cleaner runs to remove an instance after the daemon is gone.
  virtual std::vector<std::string> remove_command(const Instance& i) const = 0;
};

// engine = "podman" or "docker"; exe = its path ("" = found on PATH).
std::unique_ptr<Backend> make_oci_backend(const std::string& engine, const std::string& exe = "");
// state = where native instances keep their pid records.
std::unique_ptr<Backend> make_native_backend(const fs::path& state);

// The isolation flags a spec turns into for an OCI engine (also in the run record).
std::vector<std::string> isolation_flags(const LaunchSpec& spec, const std::string& engine, bool selinux);

std::string which(const std::string& program);  // "" when not on PATH

nlohmann::json to_json(const Instance& i);
nlohmann::json to_json(const Stats& s);

}  // namespace paperboat
