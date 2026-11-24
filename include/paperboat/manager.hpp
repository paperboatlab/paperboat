#pragma once

// The daemon's core, without sockets: leases over runtime instances. A lease is ref-counted by the
// clients that hold it; a station-mode instance whose last holder leaves stays warm for the idle
// timeout and is reused by the next acquire with the same key; session and exec instances stop when
// released. Instances carry the daemon's identity as a label, and a daemon that finds instances of a
// daemon that is gone removes them (reap). Thread-safe: every public call takes the manager's lock,
// except that starting or pulling an image happens outside it.

#include "paperboat/backend.hpp"
#include "paperboat/catalog.hpp"
#include "paperboat/policy.hpp"

#include <nlohmann/json.hpp>

#include <chrono>
#include <condition_variable>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <vector>

namespace paperboat {

using Event = nlohmann::json;  // {"event": "runtime.started", ...}
using EventSink = std::function<void(const Event&)>;

struct AcquireRequest {
  std::string runtime;                  // "julia@1.11"
  std::string mode = "station";
  std::vector<std::string> command;     // exec mode only
  fs::path project;                     // optional; mounted read-only unless policy says otherwise
  fs::path work;                        // optional; default: the lease's own work folder
  Policy policy;
  std::string backend;                  // "" = the manager's preference
  std::string owner;                    // "simplicial", "articula", "cli": shown in ps
  bool allow_unpinned = false;
};

struct Lease {
  std::string id, key, runtime, mode, owner, backend;
  fs::path dir, project, work, deps;
  Policy policy;
  Instance instance;
  std::set<int> holders;                // client ids
  std::chrono::steady_clock::time_point started, idle_since;
  std::string digest;
  std::vector<std::string> isolation;   // the flags in effect
  std::string state = "starting";       // starting | running | idle | exited | failed
  std::string error;
  std::string last_log;                 // the tail of its output once it has ended
};

nlohmann::json to_json(const Lease& l);

struct ManagerOptions {
  std::chrono::seconds idle_timeout{300};
  std::vector<std::string> backend_order{"podman", "docker", "native"};  // container first
  std::string daemon_id;                // "<boot id>:<pid>"; the label every instance carries
  fs::path state;                       // lease folders, deps volumes
};

class Manager {
 public:
  Manager(Catalog catalog, std::vector<std::unique_ptr<Backend>> backends, ManagerOptions options,
          EventSink events = nullptr);
  ~Manager();

  // Throws std::runtime_error with a message a user can act on.
  nlohmann::json acquire(const AcquireRequest& request, int client);
  void release(const std::string& lease, int client);
  void drop_client(int client);         // a client went away: release everything it held

  // Housekeeping, called every few seconds: idle expiry, instances that exited on their own.
  void tick();
  // Remove instances labelled with a daemon that is no longer running. Returns their names.
  std::vector<std::string> reap(const std::function<bool(const std::string& daemon_id)>& daemon_alive);
  void stop_all();

  nlohmann::json runtimes();            // catalog + image state per backend
  nlohmann::json backends();
  nlohmann::json ps();
  nlohmann::json stats(const std::string& lease);
  std::string logs(const std::string& lease, int tail);
  nlohmann::json pull(const std::string& runtime, const std::string& backend, ProcessOutputCallback progress);
  nlohmann::json prune(bool dry_run);   // unused deps volumes, lease folders of dead leases
  bool empty() const;

  // Called with every instance the manager starts or stops: the cleaner keeps this list.
  std::function<void(const Instance&, const Backend&, bool started)> on_instance;

  const Catalog& catalog() const { return catalog_; }

 private:
  Backend* pick_backend(const Manifest& m, const std::string& want, std::string& why);
  Backend* backend_named(const std::string& name);
  void stop_lease(Lease& l, const std::string& why);
  void emit(Event e);

  Catalog catalog_;
  std::vector<std::unique_ptr<Backend>> backends_;
  std::map<std::string, Availability> availability_;
  ManagerOptions options_;
  EventSink events_;
  mutable std::mutex mutex_;
  std::condition_variable started_;  // a lease left "starting"
  std::map<std::string, std::unique_ptr<Lease>> leases_;
  unsigned long long next_ = 0;
};

std::string project_hash(const fs::path& project);  // 12 hex digits of the canonical path

}  // namespace paperboat
