// paperboat-runtime/0 conformance: the same checks against every runtime library (Julia, Python) on
// every backend this host has (podman, native). Each combination is skipped with a message when its
// backend or interpreter is missing.

#include "daemon.hpp"
#include "paperboat/runtime.hpp"

#include <catch2/catch_test_macros.hpp>
#include <catch2/generators/catch_generators.hpp>
#include <catch2/matchers/catch_matchers_string.hpp>

#include <algorithm>
#include <chrono>
#include <future>
#include <mutex>
#include <numeric>

using namespace test;
using namespace paperboat;
using Catch::Matchers::ContainsSubstring;
using json = nlohmann::json;

namespace {

bool usable(const std::string& runtime, const std::string& backend) {
  if (backend == "podman") return podman_ok();
  return !which(runtime == "julia" ? "julia" : "python3").empty();
}

// A lease and a client for one (runtime, backend, mode).
struct Rig {
  Daemon d;
  std::unique_ptr<ControlClient> control;
  json lease;
  std::unique_ptr<RuntimeClient> rt;
  fs::path project = d.root / "project";

  Rig(const std::string& runtime, const std::string& backend, const std::string& mode) {
    fs::create_directories(project);
    std::ofstream(project / "blocks.jl") << R"jl(
struct Gain
    k::Float64
end
Gain(; k = 1.0) = Gain(k)
step(g::Gain, u) = g.k .* u
fail(g::Gain, u) = error("fast boom")
describe(g::Gain, prefix) = "$(prefix) k=$(g.k)"
shout(g::Gain, text) = (PaperboatRuntime.log(text; level = "warn"); g.k)
PaperboatRuntime.register("gain", Gain; definition = Dict("inputs" => ["u"], "outputs" => ["y"]))
)jl";
    std::ofstream(project / "helper.py") << "TWO = 2\n";
    std::ofstream(project / "blocks.py") << R"py(
import paperboat_runtime as pb
import helper  # the station's folder is on sys.path

class Gain:
    def __init__(self, k=1.0):
        self.k = k
    def step(self, u):
        return [self.k * x for x in u]
    def fail(self, u):
        raise ValueError("fast boom")
    def describe(self, prefix):
        return f"{prefix} k={self.k}"
    def shout(self, text):
        pb.log(text, "warn")
        return self.k * helper.TWO / 2

pb.register("gain", Gain, definition={"inputs": ["u"], "outputs": ["y"]})
)py";
    d.start();
    control = d.client();
    lease = control->call("acquire", {{"runtime", runtime}, {"mode", mode}, {"backend", backend}, {"project", project.string()}});
    rt = std::make_unique<RuntimeClient>(lease["ipc"].get<std::string>(), std::chrono::seconds(180));
  }
  std::string file(const std::string& runtime) { return runtime == "julia" ? "blocks.jl" : "blocks.py"; }
};

std::string text(const json& r) { return r["data"].is_object() ? r["data"].value("text/plain", "") : ""; }

}  // namespace

TEST_CASE("session mode", "[runtime]") {
  const auto runtime = GENERATE(std::string("python"), std::string("julia"));
  const auto backend = GENERATE(std::string("podman"), std::string("native"));
  if (!usable(runtime, backend)) SKIP(runtime + " on " + backend + " is not available here");
  INFO(runtime << " on " << backend);
  Rig rig(runtime, backend, "session");
  RuntimeClient& rt = *rig.rt;
  CHECK(rt.hello()["mode"] == "session");
  CHECK(rt.hello()["runtime"]["name"] == runtime);
  const bool jl = runtime == "julia";

  SECTION("values, output, errors") {
    rt.request("eval", {{"code", jl ? "x = [1.0, 2.0, 3.0];" : "x = [1.0, 2.0, 3.0]"}});
    std::string out;
    const json r = rt.request("eval", {{"code", jl ? "println(\"hi\"); sum(x)" : "print('hi'); sum(x)"}},
                              [&](const json& m) { if (m["type"] == "stream") out += m["text"].get<std::string>(); });
    CHECK(text(r) == "6.0");
    CHECK_THAT(out, ContainsSubstring("hi"));
    try {
      rt.request("eval", {{"code", jl ? "error(\"boom\")" : "raise ValueError('boom')"}});
      FAIL("no error");
    } catch (const RuntimeError& e) {
      CHECK(e.type == (jl ? "ErrorException" : "ValueError"));
      CHECK_THAT(e.what(), ContainsSubstring("boom"));
    }
    CHECK(text(rt.request("eval", {{"code", "x"}})).find("2.0") != std::string::npos);  // the error left the namespace alone
  }

  SECTION("display, variables, completion, reset") {
    std::vector<json> shown;
    rt.request("eval", {{"code", jl ? "display(42); nothing" : "display(42)"}},
               [&](const json& m) { if (m["type"] == "display") shown.push_back(m["data"]); });
    REQUIRE(shown.size() == 1);
    CHECK(shown[0]["text/plain"] == "42");
    if (jl) {  // a figure goes as itself, with no images rendered beside it
      const json r = rt.request("eval", {{"code",
        "struct Fig end; Base.show(io::IO, ::MIME\"application/vnd.paperboat.figure+json\", ::Fig) = print(io, \"{\\\"scene\\\":{}}\"); "
        "Base.show(io::IO, ::MIME\"image/svg+xml\", ::Fig) = error(\"rendered\"); Fig()"}});
      CHECK(r["data"]["application/vnd.paperboat.figure+json"] == "{\"scene\":{}}");
      CHECK_FALSE(r["data"].contains("image/svg+xml"));
      CHECK(text(rt.request("eval", {{"code", "Base.active_project() == joinpath(ENV[\"PAPERBOAT_PROJECT\"], \"Project.toml\")"}})) == "true");
    }
    rt.request("eval", {{"code", jl ? "answer_value = 41 + 1;" : "answer_value = 41 + 1"}});
    const json vars = rt.request("variables");
    CHECK(std::ranges::any_of(vars, [](const json& v) { return v["name"] == "answer_value"; }));
    const json c = rt.request("complete", {{"code", "answer_v"}, {"pos", 8}});
    CHECK(std::ranges::find(c["matches"], json("answer_value")) != c["matches"].end());
    CHECK(c["start"] == 0);
    rt.request("reset");
    CHECK(std::ranges::none_of(rt.request("variables"), [](const json& v) { return v["name"] == "answer_value"; }));
  }

  SECTION("lint: the language's own parser, answered at once even while a cell runs") {
    const json ok = rt.request("lint", {{"code", "x = 1"}});
    CHECK(ok["problems"].empty());
    const json bad = rt.request("lint", {{"code", jl ? "a = 1\nb = (a +\n" : "a = 1\nb = (a +\n"}});
    REQUIRE(bad["problems"].size() >= 1);
    CHECK(bad["problems"][0]["severity"] == "error");
    CHECK(bad["problems"][0]["from"].get<int>() >= 6);  // on the second line (byte offsets)
    auto busy = std::async(std::launch::async, [&] { return rt.request("eval", {{"code", jl ? "sleep(4)" : "import time; time.sleep(4)"}}); });
    std::this_thread::sleep_for(500ms);
    RuntimeClient other(rig.lease["ipc"].get<std::string>());
    const auto t0 = std::chrono::steady_clock::now();
    CHECK(other.request("lint", {{"code", "y = ("}})["problems"].size() >= 1);
    CHECK(std::chrono::steady_clock::now() - t0 < 2s);  // not queued behind the sleeping cell
    busy.get();
  }

  SECTION("the daemon's interrupt stops a busy cell and the session lives on") {
    auto busy = std::async(std::launch::async, [&] {
      try {
        // Julia: a loop that allocates (a GC safepoint); one that never allocates or yields cannot be
        // interrupted by any signal in Julia 1.11, and the client restarts the session instead.
        rt.request("eval", {{"code", jl ? "let v = Float64[]; while true; v = rand(8); end; end" : "while True: pass"}});
        return std::string("finished");
      } catch (const RuntimeError& e) {
        return e.type;
      }
    });
    std::this_thread::sleep_for(1500ms);
    CHECK(rig.control->call("interrupt", {{"lease", rig.lease["id"]}})["delivered"] == true);  // SIGINT via the daemon
    if (busy.wait_for(20s) != std::future_status::ready) {
      rig.control->call("release", {{"lease", rig.lease["id"]}});  // ends the runtime, so `busy` returns
      FAIL("the interrupt did not stop the cell");
    }
    CHECK(busy.get() == "InterruptException");
    CHECK(text(rt.request("eval", {{"code", "1 + 1"}})) == "2");
  }

  SECTION("the daemon's interrupt stops a cell that waits (sleep), and the connection lives on") {
    // Julia throws the interrupt in whatever task thread 1 is in: while the cell sleeps that is an I/O
    // task, which must pass it on to the cell instead of ending the connection (malachite#29).
    auto busy = std::async(std::launch::async, [&] {
      try {
        rt.request("eval", {{"code", jl ? "sleep(900)" : "import time\ntime.sleep(900)"}});
        return std::string("finished");
      } catch (const RuntimeError& e) {
        return e.type;
      }
    });
    std::this_thread::sleep_for(1500ms);
    CHECK(rig.control->call("interrupt", {{"lease", rig.lease["id"]}})["delivered"] == true);
    if (busy.wait_for(20s) != std::future_status::ready) {
      rig.control->call("release", {{"lease", rig.lease["id"]}});
      FAIL("the interrupt did not stop the sleeping cell");
    }
    CHECK(busy.get() == "InterruptException");
    CHECK(text(rt.request("eval", {{"code", "1 + 1"}})) == "2");
  }

  SECTION("debug: a breakpoint, locals, step over, eval in the frame, continue; stop") {
    if (!jl) SKIP("no debugger for " + runtime + " yet");
    std::mutex m;
    std::vector<json> events;
    auto debug_run = [&](const std::string& code, json breakpoints) {
      return std::async(std::launch::async, [&, code, breakpoints] {
        return rt.request("eval", {{"code", code}, {"cell", "dbg.jl"}, {"debug", true}, {"breakpoints", breakpoints}},
                          [&](const json& msg) { if (msg["type"] == "debug") { std::lock_guard l(m); events.push_back(msg); } });
      });
    };
    auto stopped = [&](size_t n) {  // waits for the n-th "stopped"
      for (int i = 0; i < 300; i++) {
        {
          std::lock_guard l(m);
          std::vector<json> s;
          for (const auto& e : events) if (e["event"] == "stopped") s.push_back(e);
          if (s.size() >= n) return s[n - 1];
        }
        std::this_thread::sleep_for(100ms);
      }
      FAIL("no stop");
      return json();
    };
    RuntimeClient other(rig.lease["ipc"].get<std::string>());
    auto run = debug_run("a = 1\nfunction f(x)\n    y = x * 2\n    y + 1\nend\nb = f(a)\nc = b + 1", json::array({{{"line", 3}}}));
    const json s1 = stopped(1);
    CHECK(s1["reason"] == "breakpoint");
    CHECK(s1["line"] == 3);
    REQUIRE(s1["frames"].size() == 2);  // f, then top-level
    CHECK(s1["frames"][0]["name"] == "f");
    CHECK(s1["frames"][1]["line"] == 6);  // the top-level frame is at the call, b = f(a)
    CHECK(std::ranges::any_of(s1["locals"], [](const json& v) { return v["name"] == "x" && v["summary"] == "1"; }));
    other.request("debug", {{"command", "over"}});
    const json s2 = stopped(2);
    CHECK(s2["line"] == 4);
    CHECK(std::ranges::any_of(s2["locals"], [](const json& v) { return v["name"] == "y" && v["summary"] == "2"; }));
    CHECK(other.request("debug", {{"command", "eval"}, {"frame", s2["frames"][0]["id"]}, {"code", "y + 10"}})["summary"] == "12");
    other.request("debug", {{"command", "continue"}});
    REQUIRE(run.wait_for(20s) == std::future_status::ready);
    CHECK(text(run.get()) == "4");
    CHECK(text(rt.request("eval", {{"code", "c"}})) == "4");

    auto halted = debug_run("p = 1\nq = 2", json::array({{{"line", 1}}}));
    stopped(3);
    other.request("debug", {{"command", "stop"}});
    REQUIRE(halted.wait_for(20s) == std::future_status::ready);
    CHECK(halted.get()["stopped"] == true);
    CHECK(text(rt.request("eval", {{"code", "isdefined(@__MODULE__, :q)"}})) == "false");  // stopped before line 2
  }

  SECTION("a reconnecting client finds its namespace") {
    rt.request("eval", {{"code", jl ? "kept = 7;" : "kept = 7"}});
    rig.rt.reset();
    RuntimeClient again(rig.lease["ipc"].get<std::string>());
    CHECK(text(again.request("eval", {{"code", "kept"}})) == "7");
  }
}

TEST_CASE("station mode", "[runtime]") {
  const auto runtime = GENERATE(std::string("python"), std::string("julia"));
  const auto backend = GENERATE(std::string("podman"), std::string("native"));
  if (!usable(runtime, backend)) SKIP(runtime + " on " + backend + " is not available here");
  INFO(runtime << " on " << backend);
  Rig rig(runtime, backend, "station");
  RuntimeClient& rt = *rig.rt;

  const json types = rt.request("load", {{"path", rig.file(runtime)}});
  REQUIRE(types["types"].size() == 1);
  CHECK(types["types"][0]["name"] == "gain");
  CHECK(types["types"][0]["definition"]["outputs"] == json::array({"y"}));
  const int g = rt.request("new", {{"type", "gain"}, {"params", {{"k", 2.0}}}})["instance"];
  CHECK(rt.request("call", {{"instance", g}, {"method", "step"}, {"args", {{1.0, 2.5}}}}) == json::array({2.0, 5.0}));
  CHECK(rt.request("call", {{"instance", g}, {"method", "describe"}, {"args", {"gain"}}}) == "gain k=2.0");
  CHECK_THROWS_AS(rt.request("new", {{"type", "nope"}}), RuntimeError);
  std::vector<json> logs;  // log() from station code reaches the caller of that request
  CHECK(rt.request("call", {{"instance", g}, {"method", "shout"}, {"args", {"hi"}}},
                   [&](const json& m) { if (m["type"] == "log") logs.push_back(m); }) == 2.0);
  REQUIRE(logs.size() == 1);
  CHECK(logs[0]["text"] == "hi");
  CHECK(logs[0]["level"] == "warn");

  SECTION("the shared-memory fast path") {
    rt.open_fast(64);
    const int h = rt.bind(g, "step");
    const std::vector<double> in = {1, 2, 3, 4};
    CHECK(rt.call_fast(h, in) == std::vector<double>{2, 4, 6, 8});
    std::vector<double> out, us;
    for (int i = 0; i < 2000; ++i) {
      const auto t0 = std::chrono::steady_clock::now();
      rt.call_fast(h, in, out);
      us.push_back(std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t0).count());
    }
    std::ranges::sort(us);
    const double p50 = us[us.size() / 2];
    WARN(runtime << " on " << backend << ": fast call p50 " << p50 << " us, p99 " << us[us.size() * 99 / 100] << " us");
    CHECK(p50 < 200);  // generous for CI; the dev machine measures ~5-10 us
    const int bad = rt.bind(g, "fail");
    CHECK_THROWS_WITH(rt.call_fast(bad, in), ContainsSubstring("fast boom"));
    CHECK(rt.call_fast(h, in) == std::vector<double>{2, 4, 6, 8});  // the channel survives an error
  }

  SECTION("objects belong to their connection") {
    RuntimeClient other(rig.lease["ipc"].get<std::string>());
    CHECK_THROWS_AS(other.request("call", {{"instance", g}, {"method", "step"}, {"args", {{1.0}}}}), RuntimeError);
  }
}
