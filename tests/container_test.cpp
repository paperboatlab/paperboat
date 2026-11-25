// Against real podman: a paperboatd per test case (its own socket and state), real images. Each case
// is skipped with a message when podman is not available.

#include "daemon.hpp"
#include "paperboat/runtime.hpp"

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_string.hpp>

#include <csignal>
#include <fstream>
#include <functional>
#include <sstream>
#include <thread>

#include <sys/wait.h>
#include <unistd.h>

using namespace paperboat;
using Catch::Matchers::ContainsSubstring;
using json = nlohmann::json;
using namespace std::chrono_literals;

using namespace test;

namespace {

// Run a command in exec mode and wait for it: {exit code, output}.
std::pair<int, std::string> exec(ControlClient& c, json args) {
  args["mode"] = "exec";
  c.call("subscribe");
  std::string lease;
  int code = -999;
  c.on_event = [&](const json& e) {
    if (e["event"] == "runtime.exited" && e["lease"] == lease) {
      code = e["exit_code"].get<int>();
      return false;
    }
    return true;
  };
  lease = c.call("acquire", args)["id"].get<std::string>();
  c.listen();
  const std::string text = c.call("logs", {{"lease", lease}})["text"].get<std::string>();
  c.call("release", {{"lease", lease}});
  return {code, text};
}

const char* kProbe = R"(
import os, socket
def attempt(name, f):
    try:
        f(); print(name, "allowed")
    except Exception as e:
        print(name, "denied", type(e).__name__)
attempt("network", lambda: socket.create_connection(("1.1.1.1", 53), timeout=2))
attempt("rootfs", lambda: open("/etc/pb-probe", "w"))
attempt("project-write", lambda: open("/work/project/new.txt", "w"))
attempt("ipc-write", lambda: open("/run/pb/ok", "w").write("x"))
attempt("work-write", lambda: open("/work/out/ok", "w").write("x"))
attempt("tmp-write", lambda: open("/tmp/ok", "w").write("x"))
print("project-read", open("/work/project/data.txt").read().strip())
print("uid", os.getuid(), "caps", open("/proc/self/status").read().split("CapEff:")[1].split()[0])
)";

}  // namespace

TEST_CASE("isolation defaults hold inside a real container", "[podman]") {
  NEED_PODMAN();
  Daemon d;
  d.start();
  const fs::path project = d.root / "project";
  fs::create_directories(project);
  std::ofstream(project / "data.txt") << "42\n";
  auto c = d.client();
  const auto [code, out] = exec(*c, {{"runtime", "python"}, {"project", project.string()}, {"command", {"python3", "-c", kProbe}}});
  INFO(out << d.log());
  CHECK(code == 0);
  CHECK_THAT(out, ContainsSubstring("network denied"));
  CHECK_THAT(out, ContainsSubstring("rootfs denied"));
  CHECK_THAT(out, ContainsSubstring("project-write denied"));
  CHECK_THAT(out, ContainsSubstring("ipc-write allowed"));
  CHECK_THAT(out, ContainsSubstring("work-write allowed"));
  CHECK_THAT(out, ContainsSubstring("tmp-write allowed"));
  CHECK_THAT(out, ContainsSubstring("project-read 42"));
  CHECK_THAT(out, ContainsSubstring("uid " + std::to_string(::getuid())));  // files it writes are the user's
  CHECK_THAT(out, ContainsSubstring("caps 0000000000000000"));
  CHECK_FALSE(fs::exists(project / "new.txt"));
}

TEST_CASE("julia, python and omc run from their pinned images", "[podman]") {
  NEED_PODMAN();
  Daemon d;
  d.start();
  auto c = d.client();
  CHECK_THAT(exec(*c, {{"runtime", "julia@1.11"}, {"command", {"julia", "--startup-file=no", "-e", "println(VERSION)"}}}).second,
             ContainsSubstring("1.11.9"));
  CHECK_THAT(exec(*c, {{"runtime", "python@3.12"}, {"command", {"python3", "-V"}}}).second, ContainsSubstring("3.12"));
  CHECK_THAT(exec(*c, {{"runtime", "omc"}, {"command", {"omc", "--version"}}}).second, ContainsSubstring("1.27.1"));
}

TEST_CASE("omc serves a session through its bridge, network off", "[podman]") {
  NEED_PODMAN();
  Daemon d;
  d.start();
  auto c = d.client();
  const json lease = c->call("acquire", {{"runtime", "omc"}, {"mode", "session"}, {"owner", "test"}});
  RuntimeClient rt(lease["ipc"].get<std::string>(), 5min);  // the first start may pull the image
  CHECK(rt.hello()["runtime"]["name"] == "omc");
  CHECK(rt.request("eval", {{"code", "1+1"}})["data"]["text/plain"] == "2");
  CHECK(rt.request("eval", {{"code", "loadString(\"model M Real x(start=1); equation der(x) = -x; end M;\")"}})["data"]["text/plain"] == "true");
  CHECK(rt.request("eval", {{"code", "getClassNames()"}})["data"]["text/plain"] == "{M}");
  CHECK_THROWS_AS(rt.request("nope"), RuntimeError);
  c->call("release", {{"lease", lease["id"]}});
}

TEST_CASE("a crashing runtime fails its lease with its exit code", "[podman]") {
  NEED_PODMAN();
  Daemon d;
  d.start();
  auto c = d.client();
  const auto [code, out] = exec(*c, {{"runtime", "python"}, {"command", {"python3", "-c", "import os; print('bye', flush=True); os._exit(3)"}}});
  CHECK(code == 3);
  CHECK_THAT(out, ContainsSubstring("bye"));
}

TEST_CASE("a client that goes away releases its runtime", "[podman]") {
  NEED_PODMAN();
  Daemon d;
  d.start();
  std::string lease;
  {
    auto c = d.client();
    lease = c->call("acquire", {{"runtime", "python"}, {"mode", "exec"}, {"command", {"sleep", "300"}}})["id"].get<std::string>();
    REQUIRE(containers("paperboat.lease=" + lease).size() == 1);
  }  // the connection closes here
  CHECK(eventually([&] { return containers("paperboat.lease=" + lease).empty(); }));
}

TEST_CASE("no orphan after kill -9 of the daemon", "[podman]") {
  NEED_PODMAN();
  Daemon d;
  d.start();
  auto c = d.client();
  const std::string lease =
      c->call("acquire", {{"runtime", "python"}, {"mode", "exec"}, {"command", {"sleep", "300"}}})["id"].get<std::string>();
  REQUIRE(containers("paperboat.lease=" + lease).size() == 1);
  d.kill9();
  INFO(d.log());
  CHECK(eventually([&] { return containers("paperboat.lease=" + lease).empty(); }));  // the cleaner
}

TEST_CASE("a new daemon reaps instances of a daemon that is gone", "[podman]") {
  NEED_PODMAN();
  Daemon d;
  // As if the cleaner never ran: an instance labelled with a daemon pid that is not running.
  const std::string tag = "paperboat.test=" + d.root.filename().string();
  const std::string stale = paths::boot_id() + ":999999999";
  const auto r = ProcessRunner::run_sync({"podman", "run", "-d", "--label", "paperboat.daemon=" + stale, "--label", tag,
                                          "--network=none", "docker.io/library/python:3.12-slim", "sleep", "300"},
                                         {}, {}, 60s);
  REQUIRE(r.ok());
  REQUIRE(containers(tag).size() == 1);
  d.start();
  INFO(d.log());
  CHECK(eventually([&] { return containers(tag).empty(); }));
  CHECK_THAT(d.log(), ContainsSubstring("reaped"));
}

TEST_CASE("a runtime added by file alone runs, with no daemon change", "[podman]") {
  NEED_PODMAN();
  Daemon d;
  // Same image as python, a new name, a station mode with its own entry.
  std::ofstream(d.extra / "echo.runtime.toml") << R"toml(
name = "echo"
version = "0.1"
protocol = "paperboat-runtime/0"
modes = ["station"]
[image]
ref = "docker.io/library/python:3.12-slim"
digest = "sha256:191083cdf6c7bda8c76158983163ead5d5cf7b77cf3033e805bb0f5296f51b4b"
[entry]
station = ["python3", "-c", "open('{ipc}/hello', 'w').write('{lease}'); import time; time.sleep(300)"]
)toml";
  d.start();
  auto c = d.client();
  const json l = c->call("acquire", {{"runtime", "echo"}});
  const fs::path hello = fs::path(l["ipc"].get<std::string>()) / "hello";
  CHECK(eventually([&] { return fs::exists(hello) && fs::file_size(hello) > 0; }));
  std::ifstream in(hello);
  std::string name;
  std::getline(in, name);
  CHECK(name == l["instance"].get<std::string>());
  // a second holder shares the warm instance
  auto c2 = d.client();
  CHECK(c2->call("acquire", {{"runtime", "echo"}})["id"] == l["id"]);
  CHECK(containers("paperboat.lease=" + l["id"].get<std::string>()).size() == 1);
}

TEST_CASE("stats come from the backend", "[podman]") {
  NEED_PODMAN();
  Daemon d;
  d.start();
  auto c = d.client();
  const std::string lease =
      c->call("acquire", {{"runtime", "python"}, {"mode", "exec"}, {"command", {"sleep", "300"}}})["id"].get<std::string>();
  const json s = c->call("stats", {{"lease", lease}})["stats"];
  INFO(s.dump());
  CHECK(s["memory_bytes"].get<long long>() > 0);
  CHECK(s["pids"].get<long long>() >= 1);
}

TEST_CASE("a runtime's image is pulled automatically the first time it is needed", "[podman]") {
  NEED_PODMAN();
  const std::string image = "docker.io/library/busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec";
  ProcessRunner::run_sync({"podman", "rmi", "-f", image}, {}, {}, 60s);  // not on this machine
  REQUIRE_FALSE(ProcessRunner::run_sync({"podman", "image", "exists", image}, {}, {}, 20s).ok());
  Daemon d;
  std::ofstream(d.extra / "tiny.runtime.toml") << R"toml(
name = "tiny"
version = "1.37"
protocol = "exec-only"
modes = ["exec"]
[image]
ref = "docker.io/library/busybox:1.37"
digest = "sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec"
)toml";
  d.start();
  auto c = d.client();
  bool pulled = false;
  c->on_event = [&](const json& e) { pulled |= e["event"] == "runtime.pulled"; return true; };
  const auto [code, out] = exec(*c, {{"runtime", "tiny"}, {"command", {"echo", "pulled and ran"}}});
  CHECK(code == 0);
  CHECK_THAT(out, ContainsSubstring("pulled and ran"));
  CHECK(ProcessRunner::run_sync({"podman", "image", "exists", image}, {}, {}, 20s).ok());
  ProcessRunner::run_sync({"podman", "rmi", "-f", image}, {}, {}, 60s);  // leave the machine as it was
}
