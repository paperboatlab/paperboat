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

ProcessResult cli(std::vector<std::string> args) {
  args.insert(args.begin(), std::string(PAPERBOAT_BIN_DIR) + "/paperboat");
  return ProcessRunner::run_sync(args, {}, {{"PAPERBOAT_HOME", kHome.string()}, {"PAPERBOAT_RUNTIME_DIR", (kHome / "run").string()}},
                                 std::chrono::seconds(30));
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
  CHECK_THAT(cli({"app", "install", "malachite"}).stderr_text, ContainsSubstring("no app named malachite"));
}

TEST_CASE("the registries: no apps yet, the five toolkits", "[cli]") {
  CHECK(json::parse(cli({"apps", "--json"}).stdout_text).empty());
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
