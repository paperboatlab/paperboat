// The CLI against its registry: the real binary, a home of its own, no daemon needed.

#include "paperboat/process.hpp"

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_string.hpp>
#include <nlohmann/json.hpp>
#include <toml++/toml.hpp>

#include <filesystem>
#include <fstream>
#include <random>

using namespace paperboat;
using Catch::Matchers::ContainsSubstring;
using json = nlohmann::json;
namespace fs = std::filesystem;

namespace {

const fs::path kHome = fs::temp_directory_path() / ("pb-cli-test-" + std::to_string(std::random_device{}()));

ProcessResult cli(std::vector<std::string> args, const fs::path& data = {}) {
  args.insert(args.begin(), std::string(PAPERBOAT_BIN_DIR) + "/paperboat");
  std::vector<std::pair<std::string, std::string>> env = {{"PAPERBOAT_HOME", kHome.string()}, {"PAPERBOAT_RUNTIME_DIR", (kHome / "run").string()}};
  if (!data.empty()) env.emplace_back("PAPERBOAT_DATA_DIR", data.string());
  return ProcessRunner::run_sync(args, {}, env, std::chrono::seconds(30));
}

}  // namespace

TEST_CASE("help lists every command of the registry", "[cli]") {
  const auto r = cli({"help"});
  REQUIRE(r.ok());
  const toml::table reg = toml::parse_file(std::string(PAPERBOAT_SOURCE_DIR) + "/src/cli/commands.toml");
  int n = 0;
  for (const auto& node : *reg["command"].as_array()) {
    const auto& c = *node.as_table();
    if (c["tui"].value_or(false)) continue;
    CHECK_THAT(r.stdout_text, ContainsSubstring(c["name"].value_or(std::string())));
    ++n;
  }
  CHECK(n > 20);
  const auto j = json::parse(cli({"help", "--json"}).stdout_text);
  CHECK(j.size() == reg["command"].as_array()->size());  // the TUI's own commands too
}

TEST_CASE("aliases are the same command", "[cli]") {
  CHECK(cli({"apps", "--json"}).stdout_text == cli({"app", "list", "--json"}).stdout_text);
  CHECK(cli({"toolkits", "--json"}).stdout_text == cli({"toolkit", "list", "--json"}).stdout_text);
}

TEST_CASE("the platform names no app: an installed app brings its commands", "[cli]") {
  CHECK(cli({"run", "pendulum"}).exit_code == 2);  // nobody offers `run` yet
  const fs::path app = kHome / "apps" / "demo";
  fs::create_directories(app / "bin");
  std::ofstream(app / "commands.toml") << "cli = \"bin/demo\"\n[[command]]\nid = \"demo.run\"\nname = \"run\"\n"
                                          "args = \"<station>\"\ndesc = \"Run a station\"\ngroup = \"Stations\"\n";
  std::ofstream(app / "bin" / "demo") << "#!/bin/sh\necho \"demo got: $*\"\n";
  fs::permissions(app / "bin" / "demo", fs::perms::owner_all);
  const auto r = cli({"run", "pendulum", "--port", "7400"});
  CHECK(r.ok());
  CHECK(r.stdout_text == "demo got: run pendulum --port 7400\n");
  CHECK_THAT(cli({"help"}).stdout_text, ContainsSubstring("run <station>"));
  CHECK(json::parse(cli({"help", "run", "--json"}).stdout_text)["app"] == "demo");
  fs::remove_all(app);
}

TEST_CASE("unknown commands and apps fail cleanly", "[cli]") {
  const auto r = cli({"frobnicate"});
  CHECK(r.exit_code == 2);
  CHECK_THAT(r.stderr_text, ContainsSubstring("paperboat help lists them"));
  CHECK_THAT(cli({"app", "install", "frobnicator"}).stderr_text, ContainsSubstring("no app named frobnicator"));
  CHECK_THAT(cli({"app", "open", "malachite"}).stderr_text, ContainsSubstring("paperboat app install malachite"));
}

TEST_CASE("the registries: the apps, the five toolkits", "[cli]") {
  const auto apps = json::parse(cli({"apps", "--json"}).stdout_text);
  REQUIRE(apps.size() >= 3);
  CHECK(apps[0]["name"] == "malachite");
  CHECK(apps[1]["name"] == "julix");
  CHECK(apps[2]["name"] == "articula");
  for (const auto& a : apps) {
    CHECK(a["installed"].is_null());
    CHECK(a["label"].is_string());
  }
  const auto t = json::parse(cli({"toolkits", "--json"}).stdout_text);
  REQUIRE(t.size() == 5);
  for (const auto& k : t) CHECK_THAT(k["repo"].get<std::string>(), ContainsSubstring("/simplicial-toolkit-"));
}

TEST_CASE("the channel is kept", "[cli]") {
  CHECK(cli({"channel"}).stdout_text == "release\n");
  CHECK(cli({"channel", "beta"}).ok());
  CHECK(cli({"channel"}).stdout_text == "beta\n");
  CHECK(cli({"channel", "nightly"}).exit_code == 2);
  fs::remove_all(kHome);
}

// An app from a registry of the test's own: a launcher that serves its folder over HTTP.
TEST_CASE("an app's lifecycle: install a checkout, open folders, sessions, stop, uninstall", "[cli]") {
  const fs::path data = kHome / "data", checkout = kHome / "demo-src", p1 = kHome / "p1", p2 = kHome / "p2";
  fs::create_directories(data);
  fs::create_directories(checkout / "bin");
  fs::create_directories(p1);
  fs::create_directories(p2);
  std::ofstream(data / "apps.toml") << "[[apps]]\nname = \"demo\"\nrepo = \"x/demo\"\ndescription = \"A demo\"\n"
                                       "launch = \"bin/serve\"\nport = 47210\n"
                                       "[[apps]]\nname = \"broken\"\nlaunch = \"bin/fail\"\nport = 47300\n";
  std::ofstream(checkout / "bin" / "serve") << "#!/bin/sh\nexec python3 -m http.server \"$3\" --bind 127.0.0.1 --directory \"$1\"\n";
  std::ofstream(checkout / "bin" / "fail") << "#!/bin/sh\necho cannot start: no hub here\nexit 3\n";
  fs::permissions(checkout / "bin" / "serve", fs::perms::owner_all);
  fs::permissions(checkout / "bin" / "fail", fs::perms::owner_all);
  auto run = [&](std::vector<std::string> args) { return cli(std::move(args), data); };

  CHECK(run({"app", "open", "demo", p1.string(), "--no-open"}).exit_code == 2);  // not installed
  CHECK(run({"app", "install", "demo", "--from", p1.string()}).exit_code == 2);  // not a checkout of demo
  REQUIRE(run({"app", "install", "demo", "--from", checkout.string()}).ok());
  CHECK(json::parse(run({"apps", "--json"}).stdout_text)[0]["installed"]["from"] == fs::canonical(checkout).string());

  const auto s1 = json::parse(run({"app", "open", "demo", p1.string(), "--no-open", "--json"}).stdout_text);
  CHECK(s1["id"] == "demo-47210");
  CHECK(json::parse(run({"app", "open", "demo", p1.string(), "--no-open", "--json"}).stdout_text)["id"] == "demo-47210");  // reused
  const auto s2 = json::parse(run({"app", "open", "demo", p2.string(), "--no-open", "--json"}).stdout_text);
  CHECK(s2["port"] == 47211);
  CHECK(json::parse(run({"sessions", "--json"}).stdout_text).size() == 2);
  CHECK(ProcessRunner::run_sync({"curl", "-fsS", s1["url"].get<std::string>()}).ok());  // it serves

  const auto r = json::parse(run({"session", "restart", "demo-47210", "--json"}).stdout_text);
  CHECK(r["port"] == 47210);
  CHECK(r["pid"] != s1["pid"]);
  CHECK(run({"session", "logs", "demo-47210", "--json"}).ok());
  CHECK(run({"session", "stop", "demo-47211"}).ok());
  CHECK(json::parse(run({"sessions", "--json"}).stdout_text).size() == 1);
  CHECK(run({"app", "stop", "demo"}).ok());
  CHECK(json::parse(run({"sessions", "--json"}).stdout_text).empty());
  CHECK_FALSE(ProcessRunner::is_alive(r["pid"].get<int>()));

  REQUIRE(run({"app", "install", "broken", "--from", checkout.string()}).ok());
  const auto f = run({"app", "open", "broken", p1.string(), "--no-open"});
  CHECK(f.exit_code == 1);
  CHECK_THAT(f.stderr_text, ContainsSubstring("cannot start: no hub here"));  // why, from its log

  CHECK(run({"app", "uninstall", "demo"}).ok());
  CHECK(json::parse(run({"apps", "--json"}).stdout_text)[0]["installed"].is_null());
  CHECK(fs::exists(checkout / "bin" / "serve"));  // a checkout is only unlinked
  fs::remove_all(kHome);
}
