#include "paperboat/manager.hpp"
#include "paperboat/sandbox.hpp"

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_string.hpp>

#include <atomic>
#include <map>
#include <mutex>
#include <thread>

using namespace paperboat;
using Catch::Matchers::ContainsSubstring;
using json = nlohmann::json;

namespace {

// A backend that only records: what started, what stopped, what list() reports.
struct Fake final : Backend {
  explicit Fake(std::string n, bool ok = true, bool images = true) : name_(std::move(n)), ok_(ok), images_(images) {}
  std::string name() const override { return name_; }
  Availability probe() override { return {ok_, ok_ ? "fake" : "fake is down", true, false}; }
  bool can_run(const Manifest& m) const override { return name_ == "native" ? !m.native_requires.empty() : !m.image_ref.empty(); }
  bool has_image(const Manifest&) override { return images_; }
  ProcessResult pull(const Manifest&, ProcessOutputCallback) override {
    ++pulls;
    images_ = true;
    return {0, "", "", false};
  }
  std::vector<std::string> command(const LaunchSpec& s) const override { return {"fake", s.name}; }
  Instance start(const LaunchSpec& s) override {
    std::this_thread::sleep_for(std::chrono::milliseconds(20));  // long enough for a second acquire to race
    std::lock_guard lock(mu);
    if (fail_next) {
      fail_next = false;
      throw std::runtime_error("boom");
    }
    Instance i{name_, s.name, "running", -1, 1, s.labels};
    running[s.name] = i;
    readonly[s.name] = s.readonly;
    ++starts;
    return i;
  }
  bool stop(const std::string& n) override {
    std::lock_guard lock(mu);
    running.erase(n);
    stopped.push_back(n);
    return true;
  }
  std::vector<Instance> list() override {
    std::lock_guard lock(mu);
    std::vector<Instance> out;
    for (const auto& [k, v] : running) out.push_back(v);
    return out;
  }
  Stats stats(const std::string&) override { return {1.5, 1024, 2}; }
  std::string logs(const std::string& n, int) override { return "log of " + n + "\n"; }
  bool signal(const std::string& n, int sig) override {
    signals.emplace_back(n, sig);
    return true;
  }
  std::vector<std::pair<std::string, int>> signals;
  std::vector<std::string> remove_command(const Instance& i) const override { return {"rm", i.name}; }

  std::string name_;
  bool ok_, images_;
  std::mutex mu;
  std::map<std::string, Instance> running;
  std::map<std::string, bool> readonly;  // what each start was asked for
  std::vector<std::string> stopped;
  int starts = 0, pulls = 0;
  bool fail_next = false;
};

Manifest manifest(const std::string& name, bool pinned = true, std::vector<std::string> modes = {"station", "session", "exec"}) {
  Manifest m;
  m.name = name;
  m.version = "1.0.0";
  m.protocol = "paperboat-runtime/0";
  m.modes = modes;
  m.image_ref = "example.org/" + name + ":1.0.0";
  if (pinned) m.image_digest = "sha256:" + std::string(64, 'a');
  m.entry = {{"station", {"serve"}}, {"session", {"repl"}}};
  m.mounts = {{"project", "/work/project"}, {"deps", "/work/deps"}, {"work", "/work/out"}, {"ipc", "/run/pb"}};
  m.native_requires = "sh";
  m.native_entry = {{"station", {"sh"}}};
  return m;
}

struct Rig {
  Fake* podman = nullptr;
  Fake* native = nullptr;
  std::vector<json> events;
  std::mutex events_mutex;
  std::unique_ptr<Manager> manager;
  fs::path state = fs::temp_directory_path() / ("pb-manager-test-" + std::to_string(std::rand()));

  explicit Rig(std::chrono::seconds idle = std::chrono::seconds(300), bool podman_ok = true, bool images = true) {
    Catalog c;
    c.add(manifest("julia"));
    c.add(manifest("loose", false));
    c.add(manifest("only-session", true, {"session"}));
    std::vector<std::unique_ptr<Backend>> b;
    auto p = std::make_unique<Fake>("podman", podman_ok, images);
    auto n = std::make_unique<Fake>("native");
    podman = p.get();
    native = n.get();
    b.push_back(std::move(p));
    b.push_back(std::move(n));
    ManagerOptions o;
    o.daemon_id = "boot:42";
    o.state = state;
    o.idle_timeout = idle;
    o.backend_order = {"podman", "native"};
    manager = std::make_unique<Manager>(std::move(c), std::move(b), o, [this](const json& e) {
      std::lock_guard lock(events_mutex);
      events.push_back(e);
    });
  }
  ~Rig() {
    manager.reset();
    fs::remove_all(state);
  }
  bool saw(const std::string& event) {
    std::lock_guard lock(events_mutex);
    return std::ranges::any_of(events, [&](const json& e) { return e["event"] == event; });
  }
  AcquireRequest req(const std::string& runtime = "julia", const std::string& mode = "station") {
    AcquireRequest r;
    r.runtime = runtime;
    r.mode = mode;
    return r;
  }
};

}  // namespace

TEST_CASE("a lease carries the daemon's labels and the isolation in effect", "[manager]") {
  Rig rig;
  const json l = rig.manager->acquire(rig.req(), 1);
  CHECK(l["state"] == "running");
  CHECK(l["backend"] == "podman");
  CHECK(l["digest"] == "sha256:" + std::string(64, 'a'));
  REQUIRE(rig.podman->running.size() == 1);
  const auto& labels = rig.podman->running.begin()->second.labels;
  CHECK(labels.at("paperboat.daemon") == "boot:42");
  CHECK(labels.at("paperboat.runtime") == "julia@1.0.0");
  CHECK(l["isolation"].dump().find("--network=none") != std::string::npos);
  CHECK(fs::is_directory(l["ipc"].get<std::string>()));
  CHECK(rig.saw("runtime.started"));
}

TEST_CASE("a released station runtime stays warm and is reused", "[manager]") {
  Rig rig(std::chrono::seconds(1));
  const std::string id = rig.manager->acquire(rig.req(), 1)["id"];
  rig.manager->release(id, 1);
  CHECK(rig.manager->ps()[0]["state"] == "idle");
  const json again = rig.manager->acquire(rig.req(), 2);
  CHECK(again["id"] == id);
  CHECK(rig.podman->starts == 1);
  rig.manager->release(id, 2);
  std::this_thread::sleep_for(std::chrono::milliseconds(1100));
  rig.manager->tick();
  CHECK(rig.manager->empty());
  CHECK(rig.podman->stopped.size() == 1);
  CHECK(rig.saw("runtime.stopped"));
}

TEST_CASE("a station runtime released with stop ends at once", "[manager]") {
  Rig rig;
  const std::string id = rig.manager->acquire(rig.req(), 1)["id"];
  rig.manager->acquire(rig.req(), 2);
  rig.manager->release(id, 1, true);  // another still holds it: it stays
  CHECK(rig.podman->stopped.empty());
  rig.manager->release(id, 2, true);
  CHECK(rig.manager->empty());
  CHECK(rig.podman->stopped.size() == 1);
}

TEST_CASE("a warm station runtime that exits is removed at once, never reused", "[manager]") {
  Rig rig;
  const std::string id = rig.manager->acquire(rig.req(), 1)["id"];
  rig.manager->release(id, 1);
  REQUIRE(rig.manager->ps()[0]["state"] == "idle");
  rig.podman->running.begin()->second.state = "exited";  // its holder asked it to shut down
  SECTION("at the next tick") {
    rig.manager->tick();
    CHECK(rig.manager->empty());
    CHECK(rig.podman->stopped.size() == 1);  // the container is removed, not left exited
  }
  SECTION("or when acquired again before it") {
    CHECK(rig.manager->acquire(rig.req(), 2)["id"] != id);
    CHECK(rig.podman->stopped.size() == 1);
    CHECK(rig.podman->starts == 2);
  }
}

TEST_CASE("session and exec runtimes stop when released, and are never shared", "[manager]") {
  Rig rig;
  const std::string a = rig.manager->acquire(rig.req("julia", "session"), 1)["id"];
  const std::string b = rig.manager->acquire(rig.req("julia", "session"), 2)["id"];
  CHECK(a != b);
  rig.manager->release(a, 1);
  CHECK(rig.podman->stopped.size() == 1);
  rig.manager->drop_client(2);  // a client that goes away releases what it held
  CHECK(rig.manager->empty());
}

TEST_CASE("concurrent acquires of one station key start it once", "[manager]") {
  Rig rig;
  std::vector<std::thread> threads;
  std::vector<std::string> ids(4);
  for (int i = 0; i < 4; ++i)
    threads.emplace_back([&, i] { ids[static_cast<std::size_t>(i)] = rig.manager->acquire(rig.req(), i + 1)["id"]; });
  for (auto& t : threads) t.join();
  CHECK(rig.podman->starts == 1);
  CHECK(std::ranges::all_of(ids, [&](const std::string& s) { return s == ids[0]; }));
  CHECK(rig.manager->ps()[0]["holders"] == 4);
}

TEST_CASE("a failed start is reported and leaves nothing behind", "[manager]") {
  Rig rig;
  rig.podman->fail_next = true;
  CHECK_THROWS_WITH(rig.manager->acquire(rig.req(), 1), ContainsSubstring("boom"));
  CHECK(rig.manager->empty());
  CHECK(rig.saw("runtime.failed"));
  CHECK(rig.manager->acquire(rig.req(), 1)["state"] == "running");  // and the next one works
}

TEST_CASE("errors a user can act on", "[manager]") {
  Rig rig;
  CHECK_THROWS_WITH(rig.manager->acquire(rig.req("nope"), 1), ContainsSubstring("known: julia@1.0.0"));
  CHECK_THROWS_WITH(rig.manager->acquire(rig.req("only-session", "station"), 1), ContainsSubstring("no station mode"));
  CHECK_THROWS_WITH(rig.manager->acquire(rig.req("loose"), 1), ContainsSubstring("not pinned"));
  auto r = rig.req("loose");
  r.allow_unpinned = true;
  CHECK(rig.manager->acquire(r, 1)["state"] == "running");
  auto e = rig.req("julia", "exec");
  CHECK_THROWS_WITH(rig.manager->acquire(e, 1), ContainsSubstring("needs a command"));
  auto p = rig.req();
  p.project = "/definitely/not/here";
  CHECK_THROWS_WITH(rig.manager->acquire(p, 1), ContainsSubstring("project folder not found"));
}

TEST_CASE("container first, native when no container backend works", "[manager]") {
  Rig rig(std::chrono::seconds(300), /*podman_ok=*/false);
  const json l = rig.manager->acquire(rig.req(), 1);
  CHECK(l["backend"] == "native");
  CHECK(rig.native->starts == 1);
  auto only = rig.req();
  only.backend = "podman";
  CHECK_THROWS_WITH(rig.manager->acquire(only, 1), ContainsSubstring("fake is down"));
}

TEST_CASE("a missing image is pulled before the start", "[manager]") {
  Rig rig(std::chrono::seconds(300), true, /*images=*/false);
  rig.manager->acquire(rig.req(), 1);
  CHECK(rig.podman->pulls == 1);
  CHECK(rig.saw("runtime.pulled"));
}

TEST_CASE("an instance that exits on its own fails its lease, with its exit code and log", "[manager]") {
  Rig rig;
  const std::string id = rig.manager->acquire(rig.req(), 1)["id"];
  {
    std::lock_guard lock(rig.podman->mu);
    auto& i = rig.podman->running.begin()->second;
    i.state = "exited";
    i.exit_code = 137;
  }
  rig.manager->tick();
  const json l = rig.manager->ps()[0];
  CHECK(l["state"] == "failed");
  CHECK_THAT(l["error"].get<std::string>(), ContainsSubstring("out of memory"));
  CHECK(rig.podman->stopped.size() == 1);
  CHECK_THAT(rig.manager->logs(id, 10), ContainsSubstring("log of pb-julia"));
  CHECK(rig.saw("runtime.exited"));
  rig.manager->release(id, 1);
  CHECK(rig.manager->empty());
}

TEST_CASE("an exec runtime that ends with 0 has exited, not failed", "[manager]") {
  Rig rig;
  auto r = rig.req("julia", "exec");
  r.command = {"true"};
  rig.manager->acquire(r, 1);
  {
    std::lock_guard lock(rig.podman->mu);
    auto& i = rig.podman->running.begin()->second;
    i.state = "exited";
    i.exit_code = 0;
  }
  rig.manager->tick();
  CHECK(rig.manager->ps()[0]["state"] == "exited");
  CHECK(rig.manager->ps()[0]["error"] == "");
}

TEST_CASE("the reaper removes instances of daemons that are gone, and only those", "[manager]") {
  Rig rig;
  rig.podman->running["old"] = Instance{"podman", "old", "running", -1, 1, {{"paperboat.daemon", "boot:7"}}};
  rig.podman->running["alive"] = Instance{"podman", "alive", "running", -1, 1, {{"paperboat.daemon", "boot:8"}}};
  rig.podman->running["mine"] = Instance{"podman", "mine", "running", -1, 1, {{"paperboat.daemon", "boot:42"}}};
  rig.podman->running["foreign"] = Instance{"podman", "foreign", "running", -1, 1, {}};
  const auto removed = rig.manager->reap([](const std::string& id) { return id == "boot:8"; });
  CHECK(removed == std::vector<std::string>{"old"});
  CHECK(rig.podman->running.size() == 3);
  CHECK(rig.saw("runtime.reaped"));
}

TEST_CASE("weakened isolation is announced", "[manager]") {
  Rig rig;
  auto r = rig.req();
  r.policy.network = true;
  const json l = rig.manager->acquire(r, 1);
  CHECK(l["weakened"] == json::array({"network"}));
  CHECK(rig.saw("policy.weakened"));
  CHECK(l["isolation"].dump().find("--network=none") == std::string::npos);
}

TEST_CASE("leases of different projects or policies are different instances", "[manager]") {
  Rig rig;
  const fs::path a = rig.state / "a", b = rig.state / "b";
  fs::create_directories(a);
  fs::create_directories(b);
  auto ra = rig.req(), rb = rig.req();
  ra.project = a;
  rb.project = b;
  const json la = rig.manager->acquire(ra, 1), lb = rig.manager->acquire(rb, 1);
  CHECK(la["id"] != lb["id"]);
  CHECK(la["deps"] != lb["deps"]);  // separate dependency volumes per project
  CHECK(rig.podman->starts == 2);
}

TEST_CASE("volumes lists the package volumes; prune removes those of projects that are gone", "[manager]") {
  Rig rig;
  const fs::path p = rig.state / "proj";
  fs::create_directories(p);
  auto r = rig.req("julia", "session");
  r.project = p;
  const json l = rig.manager->acquire(r, 1);
  rig.manager->release(l["id"], 1);
  const json v = rig.manager->volumes();  // what Packages offers as folders
  REQUIRE(v.size() == 1);
  CHECK(v[0]["project"] == fs::canonical(p).string());  // macOS: /var is /private/var
  CHECK(v[0]["path"] == l["deps"]);
  CHECK(v[0]["exists"] == true);
  fs::remove_all(p);
  CHECK(rig.manager->volumes()[0]["exists"] == false);
  CHECK(rig.manager->prune(true)["removed"].size() == 1);
  CHECK(fs::exists(l["deps"].get<std::string>()));
  rig.manager->prune(false);
  CHECK_FALSE(fs::exists(l["deps"].get<std::string>()));
}

TEST_CASE("a signed runtime is verified once per digest, and refused when it cannot be", "[manager]") {
  Catalog c;
  Manifest m = manifest("signed");
  m.image_signer = "^https://github.com/paperboatlab/";
  c.add(m);
  std::vector<std::unique_ptr<Backend>> b;
  b.push_back(std::make_unique<Fake>("podman"));
  ManagerOptions o;
  o.daemon_id = "boot:1";
  o.state = fs::temp_directory_path() / "pb-verify-test";
  int checks = 0;
  std::string answer = "no matching signatures";
  o.verify = [&](const Manifest&) { ++checks; return answer; };
  Manager mgr(std::move(c), std::move(b), o);
  AcquireRequest r;
  r.runtime = "signed";
  r.mode = "session";
  CHECK_THROWS_WITH(mgr.acquire(r, 1), ContainsSubstring("could not be verified: no matching signatures"));
  r.allow_unverified = true;
  CHECK(mgr.acquire(r, 1)["verified"] == "skipped");
  r.allow_unverified = false;
  answer = "";
  CHECK(mgr.acquire(r, 2)["verified"] == "signature");
  CHECK(mgr.acquire(r, 3)["verified"] == "signature");
  CHECK(checks == 3);  // the last acquire did not check again
  fs::remove_all(o.state);
}

TEST_CASE("unsigned upstream images and native runtimes say so", "[manager]") {
  Rig rig;
  CHECK(rig.manager->acquire(rig.req(), 1)["verified"] == "unsigned");
}

TEST_CASE("a read-only project is asked of the backend, kept apart, and never writable", "[manager]") {
  Rig rig;
  const fs::path ex = rig.state / "example";
  fs::create_directories(ex);
  auto ro = rig.req(), rw = rig.req();
  ro.project = rw.project = ex;
  ro.readonly = true;
  const json l = rig.manager->acquire(ro, 1), plain = rig.manager->acquire(rw, 1);
  CHECK(l["readonly"] == true);
  CHECK(plain["readonly"] == false);
  CHECK(l["id"] != plain["id"]);  // a station on the folder is not the example's
  CHECK(rig.podman->readonly.at(l["instance"].get<std::string>()));
  CHECK_FALSE(rig.podman->readonly.at(plain["instance"].get<std::string>()));
  CHECK(rig.manager->acquire(ro, 2)["id"] == l["id"]);  // the example's station is shared as usual

  auto both = ro;
  both.policy.writable_project = true;
  CHECK_THROWS_WITH(rig.manager->acquire(both, 1), ContainsSubstring("can't also be writable"));
  auto over = ro;
  over.work = rig.state;  // holds the example
  CHECK_THROWS_WITH(rig.manager->acquire(over, 1), ContainsSubstring("holds the read-only project"));
  auto none = rig.req();
  none.readonly = true;
  CHECK_THROWS_WITH(rig.manager->acquire(none, 1), ContainsSubstring("needs a project"));
}

TEST_CASE("natively, a read-only project is sandboxed, or refused where it can't be", "[manager]") {
  Rig rig(std::chrono::seconds(300), /*podman_ok=*/false);
  const fs::path ex = rig.state / "example";
  fs::create_directories(ex);
  auto r = rig.req("julia", "session");
  r.project = ex;
  r.readonly = true;
  std::string why;
  const std::string how = ReadOnlyProject::mechanism(&why);
  if (how.empty()) {
    CHECK_THROWS_WITH(rig.manager->acquire(r, 1), ContainsSubstring("read-only") && ContainsSubstring("podman or docker"));
    return;
  }
  const json l = rig.manager->acquire(r, 1);
  CHECK(l["backend"] == "native");
  CHECK(l["isolation"] == json::array({"native: environment cleaned, project read-only (" + how + ")"}));
  CHECK(rig.native->readonly.at(l["instance"].get<std::string>()));
}

TEST_CASE("a read-only project's container: the project :ro, the work folder the working directory", "[manager]") {
  Manifest m = manifest("julia");
  m.mounts["lib"] = "/opt/pb";
  LaunchSpec s;
  s.manifest = &m;
  s.mode = "session";
  s.name = "pb-x";
  s.project = "/home/u/example";
  s.work = "/state/leases/1/work";
  s.readonly = true;
  const auto f = isolation_flags(s, "podman", false);
  CHECK(std::ranges::find(f, "/home/u/example:/work/project:ro") != f.end());
  const auto wd = std::ranges::find(f, "--workdir");
  REQUIRE(wd != f.end());
  CHECK(*(wd + 1) == "/work/out");
  const auto cmd = make_oci_backend("podman", "/usr/bin/podman")->command(s);
  CHECK(std::ranges::find(cmd, "PAPERBOAT_READONLY=1") != cmd.end());
  s.readonly = false;
  const auto plain = isolation_flags(s, "podman", false);
  CHECK(std::ranges::find(plain, "--workdir") == plain.end());
}
