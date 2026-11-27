#include "paperboat/manager.hpp"

#include "paperboat/paths.hpp"

#include <algorithm>
#include <condition_variable>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>

#ifndef _WIN32
#include <unistd.h>
#endif

namespace paperboat {

namespace {

using json = nlohmann::json;
using Clock = std::chrono::steady_clock;

std::string sanitize(std::string s) {
  for (auto& c : s)
    if (!std::isalnum(static_cast<unsigned char>(c)) && c != '-') c = '-';
  return s;
}

std::string major_minor(const std::string& version) {
  const auto first = version.find('.');
  if (first == std::string::npos) return version;
  const auto second = version.find_first_of(".-+", first + 1);
  return version.substr(0, second);
}

double seconds_since(Clock::time_point t) { return std::chrono::duration<double>(Clock::now() - t).count(); }

}  // namespace

std::string project_hash(const fs::path& project) {
  if (project.empty()) return "none";
  std::error_code ec;
  const std::string s = fs::weakly_canonical(project, ec).string();
  std::uint64_t h = 1469598103934665603ull;  // FNV-1a: a folder name, not a secret
  for (unsigned char c : s) h = (h ^ c) * 1099511628211ull;
  std::ostringstream out;
  out << std::hex << std::setw(12) << std::setfill('0') << (h & 0xFFFFFFFFFFFFull);
  return out.str();
}

json to_json(const Lease& l) {
  return {{"id", l.id},
          {"runtime", l.runtime},
          {"mode", l.mode},
          {"owner", l.owner},
          {"backend", l.backend},
          {"state", l.state},
          {"error", l.error},
          {"instance", l.instance.name},
          {"project", l.project.string()},
          {"work", l.work.string()},
          {"deps", l.deps.string()},
          {"ipc", (l.dir / "ipc").string()},
          {"digest", l.digest},
          {"verified", l.verified},
          {"isolation", l.isolation},
          {"policy", to_json(l.policy)},
          {"weakened", l.policy.weakened()},
          {"holders", l.holders.size()},
          {"uptime_s", seconds_since(l.started)},
          {"idle_s", l.holders.empty() && l.state == "idle" ? seconds_since(l.idle_since) : 0.0}};
}

Manager::Manager(Catalog catalog, std::vector<std::unique_ptr<Backend>> backends, ManagerOptions options, EventSink events)
    : catalog_(std::move(catalog)), backends_(std::move(backends)), options_(std::move(options)), events_(std::move(events)) {
  for (auto& b : backends_) availability_[b->name()] = b->probe();
}

Manager::~Manager() = default;

void Manager::emit(Event e) {
  if (events_) events_(e);
}

Backend* Manager::backend_named(const std::string& name) {
  for (auto& b : backends_)
    if (b->name() == name) return b.get();
  return nullptr;
}

Backend* Manager::pick_backend(const Manifest& m, const std::string& want, std::string& why) {
  std::vector<std::string> order = want.empty() ? options_.backend_order : std::vector<std::string>{want};
  for (const auto& name : order) {
    Backend* b = backend_named(name);
    if (!b) {
      why += name + ": not configured; ";
      continue;
    }
    const auto& a = availability_[name];
    if (!a.ok) {
      why += name + ": " + a.detail + "; ";
      continue;
    }
    if (!b->can_run(m)) {
      why += name + ": " + m.id() + " has no recipe for it; ";
      continue;
    }
    if (name == "native" && !b->has_image(m)) {
      why += "native: " + m.native_requires + " is not on PATH; ";
      continue;
    }
    return b;
  }
  return nullptr;
}

json Manager::acquire(const AcquireRequest& req, int client) {
  std::unique_lock lock(mutex_);
  const Manifest* m = catalog_.resolve(req.runtime);
  if (!m) {
    std::string known;
    for (const auto& x : catalog_.all()) known += (known.empty() ? "" : ", ") + x.id();
    throw std::runtime_error("unknown runtime \"" + req.runtime + "\" (known: " + (known.empty() ? "none" : known) + ")");
  }
  if (!m->has_mode(req.mode)) throw std::runtime_error(m->id() + " has no " + req.mode + " mode");
  if (req.mode == "exec" && req.command.empty()) throw std::runtime_error("exec mode needs a command");
  if (req.mode != "exec" && !req.command.empty()) throw std::runtime_error("only exec mode takes a command");

  std::string why;
  Backend* backend = pick_backend(*m, req.backend, why);
  if (!backend) throw std::runtime_error("no backend can run " + m->id() + ": " + why);
  if (backend->name() != "native" && !m->pinned() && !req.allow_unpinned)
    throw std::runtime_error(m->id() + " is not pinned to an image digest (" + m->source.string() +
                             "); refusing to run a moving tag");

  fs::path project;
  if (!req.project.empty()) {
    std::error_code ec;
    project = fs::canonical(req.project, ec);
    if (ec || !fs::is_directory(project)) throw std::runtime_error("project folder not found: " + req.project.string());
  }

  std::ostringstream key;
  key << m->id() << '|' << req.mode << '|' << backend->name() << '|' << project.string() << '|' << to_json(req.policy).dump();

  // A warm station-mode instance for the same key is reused; one still starting is waited for.
  if (req.mode == "station") {
    for (auto it = leases_.begin(); it != leases_.end(); ++it) {
      auto& l = it->second;
      if (l->key != key.str() || (l->state != "running" && l->state != "idle" && l->state != "starting")) continue;
      if (l->state == "idle" && !instance_running(*l)) {  // ended since its release (a shutdown): never handed out
        std::unique_ptr<Lease> dead = std::move(l);
        leases_.erase(it);
        stop_lease(*dead, "exited");
        break;
      }
      Lease* lease = l.get();
      lease->holders.insert(client);
      if (lease->state == "starting") started_.wait(lock, [&] { return lease->state != "starting"; });
      if (lease->state == "failed") {  // the start it waited for failed; the last one out removes it
        lease->holders.erase(client);
        const std::string error = lease->error;
        if (lease->holders.empty()) leases_.erase(lease->id);
        throw std::runtime_error(error);
      }
      lease->state = "running";
      emit({{"event", "lease.acquired"}, {"lease", lease->id}, {"runtime", lease->runtime}, {"reused", true}});
      return to_json(*lease);
    }
  }

  auto lease = std::make_unique<Lease>();
  Lease& l = *lease;
  std::ostringstream id;
#ifndef _WIN32
  id << std::hex << getpid() << '-' << ++next_;
#else
  id << std::hex << ++next_;
#endif
  l.id = id.str();
  l.key = key.str();
  l.runtime = m->id();
  l.mode = req.mode;
  l.owner = req.owner.empty() ? "unknown" : req.owner;
  l.backend = backend->name();
  l.project = project;
  l.policy = req.policy;
  l.digest = m->image_digest;
  l.dir = options_.state / "leases" / l.id;
  l.work = req.work.empty() ? l.dir / "work" : req.work;
  l.deps = options_.state / "deps" / sanitize(m->name + "-" + major_minor(m->version)) / project_hash(project);
  l.started = Clock::now();
  l.holders.insert(client);
  fs::create_directories(l.dir / "ipc");
  fs::create_directories(l.work);
  fs::create_directories(l.deps);
  if (!project.empty()) std::ofstream(l.deps / "project.txt") << project.string() << "\n";

  LaunchSpec spec;
  spec.manifest = m;
  spec.mode = req.mode;
  spec.command = req.command;
  spec.name = "pb-" + sanitize(m->name) + "-" + sanitize(m->version) + "-" + project_hash(project) + "-" + sanitize(l.id);
  spec.project = project;
  spec.deps = l.deps;
  spec.work = l.work;
  spec.ipc = l.dir / "ipc";
  spec.policy = req.policy;
  spec.log = l.dir / "log.txt";
  if (fs::is_directory(m->lib_dir())) {
    // The daemon's own copy: relabelled for containers on SELinux, never the user's (or the
    // installation's) files, and unchanged under a running instance if paperboat is updated.
    spec.lib = options_.state / "lib" / sanitize(m->id());
    if (!libs_copied_.contains(m->id())) {
      std::error_code ec;
      fs::remove_all(spec.lib, ec);
      fs::create_directories(spec.lib);
      fs::copy(m->lib_dir(), spec.lib, fs::copy_options::recursive | fs::copy_options::overwrite_existing, ec);
      if (ec) throw std::runtime_error("cannot copy " + m->lib_dir().string() + ": " + ec.message());
      libs_copied_.insert(m->id());
    }
  }
  spec.labels = {{"paperboat.daemon", options_.daemon_id}, {"paperboat.lease", l.id}, {"paperboat.runtime", m->id()},
                 {"paperboat.mode", req.mode}, {"paperboat.owner", l.owner}, {"paperboat.digest", m->image_digest}};
  l.instance.name = spec.name;
  l.isolation = backend->name() == "native"
                    ? std::vector<std::string>{"native: environment cleaned, no sandbox"}
                    : isolation_flags(spec, backend->name(), availability_[backend->name()].selinux);
  for (const auto& w : req.policy.weakened()) emit({{"event", "policy.weakened"}, {"lease", l.id}, {"runtime", l.runtime}, {"what", w}});
  leases_[l.id] = std::move(lease);

  // Pull and start outside the lock: a pull can take minutes, a start about a second.
  lock.unlock();
  std::string error, verified;
  Instance instance;
  try {
    if (backend->name() == "native") {
      verified = "native";
    } else if (m->image_signer.empty()) {
      verified = "unsigned";
    } else {
      bool known;
      {
        std::lock_guard vlock(mutex_);
        known = verified_.contains(m->image_digest);
      }
      const std::string problem = known ? "" : (options_.verify ? options_.verify : verify_with_cosign)(*m);
      if (problem.empty()) {
        verified = "signature";
        std::lock_guard vlock(mutex_);
        if (!known) emit({{"event", "runtime.verified"}, {"runtime", m->id()}, {"digest", m->image_digest}});
        verified_.insert(m->image_digest);
      } else if (req.allow_unverified) {
        verified = "skipped";
        emit({{"event", "runtime.unverified"}, {"runtime", m->id()}, {"reason", problem}});
      } else {
        throw std::runtime_error("the signature of " + m->image() + " could not be verified: " + problem);
      }
    }
    if (!backend->has_image(*m)) {
      emit({{"event", "runtime.pulling"}, {"runtime", m->id()}, {"backend", backend->name()}});
      const auto r = backend->pull(*m);
      if (!r.ok()) throw std::runtime_error("pull of " + m->image() + " failed: " + r.stderr_text);
      emit({{"event", "runtime.pulled"}, {"runtime", m->id()}, {"backend", backend->name()}, {"digest", m->image_digest}});
    }
    instance = backend->start(spec);
    if (on_instance) on_instance(instance, *backend, true);
  } catch (const std::exception& e) {
    error = e.what();
  }
  lock.lock();
  Lease& done = *leases_.at(spec.labels["paperboat.lease"]);
  if (!error.empty()) {
    done.state = "failed";
    done.error = error;
    emit({{"event", "runtime.failed"}, {"lease", done.id}, {"runtime", done.runtime}, {"error", error}});
    std::error_code ec;
    fs::remove_all(done.dir, ec);
    done.holders.erase(client);
    if (done.holders.empty()) leases_.erase(done.id);  // else the last waiter removes it
    started_.notify_all();
    throw std::runtime_error(error);
  }
  done.instance = instance;
  done.verified = verified;
  done.state = "running";
  started_.notify_all();
  emit({{"event", "runtime.started"}, {"lease", done.id}, {"runtime", done.runtime}, {"backend", done.backend},
        {"instance", done.instance.name}, {"mode", done.mode}, {"owner", done.owner}});
  return to_json(done);
}

bool Manager::instance_running(const Lease& l) {
  Backend* b = backend_named(l.backend);
  if (!b) return false;
  for (const auto& i : b->list())
    if (i.name == l.instance.name) return i.state == "running";
  return false;
}

void Manager::stop_lease(Lease& l, const std::string& why) {
  Backend* b = backend_named(l.backend);
  if (b && !l.instance.name.empty()) {
    b->stop(l.instance.name);
    if (on_instance) on_instance(l.instance, *b, false);
  }
  std::error_code ec;
  fs::remove_all(l.dir, ec);
  emit({{"event", "runtime.stopped"}, {"lease", l.id}, {"runtime", l.runtime}, {"reason", why}});
}

void Manager::release(const std::string& id, int client, bool stop) {
  std::unique_ptr<Lease> gone;
  {
    std::lock_guard lock(mutex_);
    const auto it = leases_.find(id);
    if (it == leases_.end() || !it->second->holders.erase(client)) return;
    Lease& l = *it->second;
    emit({{"event", "lease.released"}, {"lease", l.id}, {"runtime", l.runtime}, {"holders", l.holders.size()}});
    if (!l.holders.empty()) return;
    if (!stop && l.mode == "station" && l.state == "running" && options_.idle_timeout.count() > 0) {
      l.state = "idle";
      l.idle_since = Clock::now();
      return;
    }
    gone = std::move(it->second);
    leases_.erase(it);
  }
  stop_lease(*gone, "released");
}

void Manager::drop_client(int client) {
  std::vector<std::string> held;
  {
    std::lock_guard lock(mutex_);
    for (const auto& [id, l] : leases_)
      if (l->holders.contains(client)) held.push_back(id);
  }
  for (const auto& id : held) release(id, client);
}

void Manager::tick() {
  std::vector<std::unique_ptr<Lease>> expired;
  std::set<std::string> used;
  {
    std::lock_guard lock(mutex_);
    for (auto it = leases_.begin(); it != leases_.end();) {
      Lease& l = *it->second;
      if (l.state == "idle" && seconds_since(l.idle_since) >= static_cast<double>(options_.idle_timeout.count())) {
        expired.push_back(std::move(it->second));
        it = leases_.erase(it);
        continue;
      }
      if (l.state == "running" || l.state == "idle") used.insert(l.backend);
      ++it;
    }
  }
  for (auto& l : expired) stop_lease(*l, "idle");

  // Instances that ended on their own: a crash, an OOM kill, a runtime that exited.
  std::map<std::string, Instance> seen;
  for (const auto& name : used)
    if (Backend* b = backend_named(name))
      for (auto& i : b->list()) seen[i.name] = std::move(i);
  struct Ended {
    std::string lease, backend;
    Instance instance;
    int code;
  };
  std::vector<Ended> ended;
  std::vector<std::unique_ptr<Lease>> dead;  // idle, nobody holds them: gone at once, never handed out again
  {
    std::lock_guard lock(mutex_);
    for (auto it = leases_.begin(); it != leases_.end();) {
      auto& l = it->second;
      const auto found = used.contains(l->backend) ? seen.find(l->instance.name) : seen.end();
      const bool alive = !used.contains(l->backend) || (found != seen.end() && found->second.state == "running");
      if (l->state == "idle" && !alive) {
        dead.push_back(std::move(l));
        it = leases_.erase(it);
        continue;
      }
      if (l->state == "running" && !alive)
        ended.push_back({l->id, l->backend, l->instance, found == seen.end() ? -1 : found->second.exit_code});
      ++it;
    }
  }
  for (auto& l : dead) stop_lease(*l, "exited");  // a station runtime that ended once released (a shutdown)
  // The instance was kept until here so its exit code and output could be read. The output is read
  // before the lease says it ended: a holder that sees "exited" asks for the logs next and must get them.
  // The lease stays for its holders to see until they release it.
  for (auto& e : ended) {
    Backend* b = backend_named(e.backend);
    const std::string log = b ? b->logs(e.instance.name, 200) : "";
    {
      std::lock_guard lock(mutex_);
      if (const auto it = leases_.find(e.lease); it != leases_.end() && it->second->state == "running") {
        auto& l = it->second;
        // An exec runtime that finished with 0 did its job; anything else ending on its own failed.
        l->state = e.code == 0 && l->mode == "exec" ? "exited" : "failed";
        l->error = l->state == "exited" ? "" : l->runtime + " exited" + (e.code >= 0 ? " with code " + std::to_string(e.code) : "") +
                   (e.code == 137 ? " (killed: out of memory or SIGKILL)" : "");
        l->last_log = log;
        emit({{"event", "runtime.exited"}, {"lease", e.lease}, {"runtime", l->runtime}, {"exit_code", e.code},
              {"state", l->state}, {"error", l->error}});
      }
    }
    if (b) {
      b->stop(e.instance.name);
      if (on_instance) on_instance(e.instance, *b, false);
    }
  }
}

std::vector<std::string> Manager::reap(const std::function<bool(const std::string&)>& daemon_alive) {
  std::vector<std::string> removed;
  for (auto& b : backends_) {
    if (!availability_[b->name()].ok) continue;
    for (const auto& i : b->list()) {
      const auto it = i.labels.find("paperboat.daemon");
      if (it == i.labels.end() || it->second == options_.daemon_id || daemon_alive(it->second)) continue;
      b->stop(i.name);
      removed.push_back(i.name);
      emit({{"event", "runtime.reaped"}, {"instance", i.name}, {"backend", b->name()}, {"daemon", it->second}});
    }
  }
  // Lease folders no live lease owns (a previous daemon's).
  std::error_code ec;
  for (const auto& e : fs::directory_iterator(options_.state / "leases", ec)) {
    const std::string id = e.path().filename().string();
    std::lock_guard lock(mutex_);
    if (!leases_.contains(id)) fs::remove_all(e.path(), ec);
  }
  return removed;
}

void Manager::stop_all() {
  std::map<std::string, std::unique_ptr<Lease>> all;
  {
    std::lock_guard lock(mutex_);
    all.swap(leases_);
  }
  for (auto& [id, l] : all) stop_lease(*l, "daemon stopping");
}

bool Manager::empty() const {
  std::lock_guard lock(mutex_);
  return leases_.empty();
}

json Manager::backends() {
  json out = json::array();
  for (auto& b : backends_) {
    const auto& a = availability_[b->name()];
    out.push_back({{"name", b->name()}, {"available", a.ok}, {"detail", a.detail}, {"rootless", a.rootless}, {"selinux", a.selinux}});
  }
  return out;
}

json Manager::runtimes() {
  json out = json::array();
  for (const auto& m : catalog_.all()) {
    json j = to_json(m);
    json on = json::object();
    for (auto& b : backends_) {
      const bool ok = availability_[b->name()].ok && b->can_run(m);
      on[b->name()] = {{"usable", ok}, {"ready", ok && b->has_image(m)}};
    }
    j["backends"] = on;
    out.push_back(std::move(j));
  }
  json errors = json::array();
  for (const auto& e : catalog_.errors()) errors.push_back(e);
  return {{"runtimes", out}, {"errors", errors}};
}

json Manager::ps() {
  std::lock_guard lock(mutex_);
  json out = json::array();
  for (const auto& [id, l] : leases_) out.push_back(to_json(*l));
  return out;
}

json Manager::stats(const std::string& id) {
  std::string backend, name;
  {
    std::lock_guard lock(mutex_);
    const auto it = leases_.find(id);
    if (it == leases_.end()) throw std::runtime_error("no lease " + id);
    backend = it->second->backend;
    name = it->second->instance.name;
  }
  Backend* b = backend_named(backend);
  return {{"lease", id}, {"stats", to_json(b ? b->stats(name) : Stats{})}};
}

std::string Manager::logs(const std::string& id, int tail) {
  std::string backend, name;
  {
    std::lock_guard lock(mutex_);
    const auto it = leases_.find(id);
    if (it == leases_.end()) throw std::runtime_error("no lease " + id);
    if (it->second->state == "exited" || it->second->state == "failed") return it->second->last_log;
    backend = it->second->backend;
    name = it->second->instance.name;
  }
  Backend* b = backend_named(backend);
  return b ? b->logs(name, tail) : "";
}

bool Manager::interrupt(const std::string& id) {
  std::string backend, name;
  {
    std::lock_guard lock(mutex_);
    const auto it = leases_.find(id);
    if (it == leases_.end()) throw std::runtime_error("no lease " + id);
    if (it->second->state != "running") return false;
    backend = it->second->backend;
    name = it->second->instance.name;
  }
  Backend* b = backend_named(backend);
  return b && b->signal(name, 2 /*SIGINT*/);
}

json Manager::pull(const std::string& runtime, const std::string& backend, ProcessOutputCallback progress) {
  const Manifest* m = catalog_.resolve(runtime);
  if (!m) throw std::runtime_error("unknown runtime \"" + runtime + "\"");
  std::string why;
  Backend* b = pick_backend(*m, backend, why);
  if (!b) throw std::runtime_error("no backend can run " + m->id() + ": " + why);
  emit({{"event", "runtime.pulling"}, {"runtime", m->id()}, {"backend", b->name()}});
  const auto r = b->pull(*m, progress);
  if (!r.ok()) {
    emit({{"event", "runtime.pull_failed"}, {"runtime", m->id()}, {"backend", b->name()}, {"error", r.stderr_text}});
    throw std::runtime_error("pull of " + m->image() + " failed: " + r.stderr_text);
  }
  emit({{"event", "runtime.pulled"}, {"runtime", m->id()}, {"backend", b->name()}, {"digest", m->image_digest}});
  return {{"runtime", m->id()}, {"backend", b->name()}, {"image", m->image()}};
}

json Manager::prune(bool dry_run) {
  json removed = json::array();
  std::set<fs::path> in_use;
  {
    std::lock_guard lock(mutex_);
    for (const auto& [id, l] : leases_) in_use.insert(l->deps);
  }
  // A dependency volume whose project is gone. The shared one ("none") and those in use stay.
  std::error_code ec;
  for (const auto& runtime : fs::directory_iterator(options_.state / "deps", ec))
    for (const auto& vol : fs::directory_iterator(runtime.path(), ec)) {
      if (in_use.contains(vol.path())) continue;
      std::ifstream f(vol.path() / "project.txt");
      std::string project;
      if (!std::getline(f, project) || fs::exists(project)) continue;
      removed.push_back({{"path", vol.path().string()}, {"project", project}});
      if (!dry_run) fs::remove_all(vol.path(), ec);
    }
  return {{"removed", removed}, {"dry_run", dry_run}};
}

std::string verify_with_cosign(const Manifest& m) {
  const std::string cosign = which("cosign");
  if (cosign.empty()) return "cosign is not installed (https://docs.sigstore.dev/cosign/system_config/installation/)";
  const auto r = ProcessRunner::run_sync({cosign, "verify", "--certificate-identity-regexp", m.image_signer,
                                          "--certificate-oidc-issuer", m.image_issuer, m.image()},
                                         {}, {}, std::chrono::seconds(120));
  if (r.ok()) return "";
  std::string why = r.stderr_text.empty() ? r.stdout_text : r.stderr_text;
  while (!why.empty() && std::isspace(static_cast<unsigned char>(why.back()))) why.pop_back();
  return why.empty() ? "cosign verify failed" : why;
}

}  // namespace paperboat
