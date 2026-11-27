// The CLI against its registry: the real binary, a home of its own, no daemon needed.

#include "paperboat/process.hpp"

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_string.hpp>
#include <nlohmann/json.hpp>
#include <toml++/toml.hpp>

#include <filesystem>
#include <fstream>
#include <sstream>
#include <random>
#include <thread>

using namespace paperboat;
using Catch::Matchers::ContainsSubstring;
using json = nlohmann::json;
namespace fs = std::filesystem;

namespace {

const fs::path kHome = fs::temp_directory_path() / ("pb-cli-test-" + std::to_string(std::random_device{}()));

ProcessResult cli(std::vector<std::string> args, const fs::path& data = {}, std::vector<std::pair<std::string, std::string>> env = {}) {
  args.insert(args.begin(), std::string(PAPERBOAT_BIN_DIR) + "/paperboat");
  env.insert(env.end(), {{"PAPERBOAT_HOME", kHome.string()}, {"PAPERBOAT_RUNTIME_DIR", (kHome / "run").string()}, {"XDG_DATA_HOME", (kHome / "xdg").string()}});
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
  for (const auto& k : t)  // the base toolkit is built into Simplicial; the optional ones are their own repositories
    CHECK_THAT(k["repo"].get<std::string>(), ContainsSubstring(k["kind"] == "base" ? "/simplicial.git" : "/simplicial-toolkit-"));
}

// GitHub is a folder here: curl reads file:// URLs and drops their query.
TEST_CASE("toolkit info reads the repository, caches it, and says when it can't", "[cli]") {
  const fs::path gh = kHome / "github", r = gh / "repos" / "paperboatlab" / "simplicial-toolkit-control";
  const auto put = [](const fs::path& f, const std::string& text) { fs::create_directories(f.parent_path()), std::ofstream(f) << text; };
  const std::string src = "engine/toolkit/control/src/";
  put(r / "git" / "trees" / "HEAD", json{{"tree", {{{"path", src + "control/pid/pid.cpp"}, {"type", "blob"}}, {{"path", src + "control/pid"}, {"type", "tree"}},
                                                   {{"path", src + "control/common.hpp"}, {"type", "blob"}}, {{"path", src + "register.cpp"}, {"type", "blob"}},
                                                   {{"path", src + "control/blocks.toml"}, {"type", "blob"}}, {{"path", src + "control/lqr/lqr.cpp"}, {"type", "blob"}}}}}.dump());
  put(r / "contents" / src / "control" / "blocks.toml", "[[blocks]]\nuse = \"control/pid\"\ntype = \"pi\"\n");
  put(r / "contents" / "engine/toolkit/control/toolkit.toml", "name = \"control\"\nversion = \"0.3.0\"\n");
  put(r / "license", R"({"license": {"spdx_id": "GPL-3.0"}})");
  put(r / "readme", "<h1>control</h1>");
  put(r / "releases", R"([{"tag_name": "v0.2.0", "html_url": "u"}, {"tag_name": "v0.3.0-beta.1", "prerelease": true}])");
  const std::pair<std::string, std::string> api{"PAPERBOAT_GITHUB_API", "file://" + gh.string()}, gone{"PAPERBOAT_GITHUB_API", "file:///nowhere"};

  const auto t = json::parse(cli({"toolkit", "info", "control", "--json"}, {}, {api}).stdout_text);
  CHECK(t["version"] == "0.3.0");
  CHECK(t["licence"] == "GPL-3.0");
  CHECK(t["blocks"] == json{"control/lqr", "control/pi", "control/pid"});
  CHECK(t["release"]["version"] == "0.2.0");  // the release channel skips the beta
  CHECK(t["readme"] == "<h1>control</h1>");
  CHECK(t["url"] == "https://github.com/paperboatlab/simplicial-toolkit-control");
  CHECK(t["stale"] == false);
  CHECK(json::parse(cli({"toolkit", "info", "control", "--json"}, {}, {gone}).stdout_text) == t);  // fresh in the cache
  CHECK(json::parse(cli({"toolkit", "info", "control", "--refresh", "--json"}, {}, {gone}).stdout_text)["stale"] == true);
  put(r / "git" / "trees" / "HEAD", json{{"tree", json::array()}}.dump());  // no blocks: a bad read, the last copy stays
  CHECK(json::parse(cli({"toolkit", "info", "control", "--refresh", "--json"}, {}, {api}).stdout_text)["blocks"].size() == 3);
  fs::remove_all(kHome / "cache");
  const auto off = cli({"toolkit", "info", "control"}, {}, {gone});
  CHECK(off.exit_code == 1);
  CHECK_THAT(off.stderr_text, ContainsSubstring("toolkit list has its description"));
  CHECK(cli({"toolkit", "info", "frobnicate"}).exit_code == 2);
  fs::remove_all(gh);
}

// General is a folder too: Registry.toml, a package's folder, its repository on GitHub.
TEST_CASE("package search and info read Julia's General registry, cache it, and say when they can't", "[cli]") {
  const fs::path gh = kHome / "github", g = gh / "repos" / "JuliaRegistries" / "General" / "contents";
  const auto put = [](const fs::path& f, const std::string& text) { fs::create_directories(f.parent_path()), std::ofstream(f) << text; };
  put(g / "Registry.toml", "name = \"General\"\n[packages]\n"
                           "a93c6f00-e57d-5684-b7b6-d8193f3e46c0 = { name = \"DataFrames\", path = \"D/DataFrames\" }\n"
                           "864edb3b-99cc-5e75-8d2d-829cb0a9cfe8 = { name = \"DataStructures\", path = \"D/DataStructures\" }\n"
                           "11111111-1111-1111-1111-111111111111 = { name = \"MyData\", path = \"M/MyData\" }\n"
                           "91a5bcdd-55d7-5caf-9e0b-520d859cae80 = { name = \"Plots\", path = \"P/Plots\" }\n");
  put(g / "D" / "DataFrames" / "Package.toml", "name = \"DataFrames\"\nuuid = \"a93c6f00-e57d-5684-b7b6-d8193f3e46c0\"\nrepo = \"https://github.com/JuliaData/DataFrames.jl.git\"\n");
  put(g / "D" / "DataFrames" / "Versions.toml", "[\"1.9.0\"]\ngit-tree-sha1 = \"a\"\n[\"1.10.0\"]\ngit-tree-sha1 = \"b\"\n[\"2.0.0\"]\ngit-tree-sha1 = \"c\"\nyanked = true\n");
  put(gh / "repos" / "JuliaData" / "DataFrames.jl", R"({"description": "In-memory tabular data", "stargazers_count": 1845, "topics": ["data", "julia"], "html_url": "u"})");
  const std::pair<std::string, std::string> api{"PAPERBOAT_GITHUB_API", "file://" + gh.string()}, gone{"PAPERBOAT_GITHUB_API", "file:///nowhere"};

  const auto s = json::parse(cli({"package", "search", "julia", "data", "--json"}, {}, {api}).stdout_text);
  CHECK(s["total"] == 3);
  CHECK(s["results"][0]["name"] == "DataFrames");  // names that start with it first, the shorter first
  CHECK(s["results"][1]["name"] == "DataStructures");
  CHECK(s["results"][2]["name"] == "MyData");
  CHECK(s["stale"] == false);
  const auto p = json::parse(cli({"package", "info", "julia", "dataframes", "--json"}, {}, {api}).stdout_text);
  CHECK(p["name"] == "DataFrames");
  CHECK(p["latest"] == "1.10.0");  // numeric order; a yanked version never counts
  CHECK(p["versions"] == json{"1.10.0", "1.9.0"});
  CHECK(p["url"] == "https://github.com/JuliaData/DataFrames.jl");
  CHECK(p["description"] == "In-memory tabular data");
  CHECK(p["stars"] == 1845);
  CHECK(p["topics"] == json{"data", "julia"});
  CHECK(p["stale"] == false);
  CHECK(json::parse(cli({"package", "info", "julia", "DataFrames", "--json"}, {}, {gone}).stdout_text) == p);  // a day in the cache
  CHECK(json::parse(cli({"package", "search", "julia", "plot", "--refresh", "--json"}, {}, {gone}).stdout_text)["stale"] == true);
  CHECK(cli({"package", "info", "julia", "Frobnicate"}, {}, {api}).exit_code == 2);
  CHECK(cli({"package", "search", "python", "numpy"}).exit_code == 2);  // the others add by name
  fs::remove_all(kHome / "cache");
  const auto off = cli({"package", "search", "julia", "data", "--json"}, {}, {gone});
  CHECK(off.exit_code == 1);
  CHECK(json::parse(off.stdout_text)["offline"] == true);
  CHECK_THAT(json::parse(off.stdout_text)["error"].get<std::string>(), ContainsSubstring("still adds by name"));
  fs::remove_all(gh);
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
#ifdef __linux__
  const fs::path entry = kHome / "xdg" / "applications" / "paperboat-demo.desktop";  // an app of the desktop
  std::stringstream text;
  text << std::ifstream(entry).rdbuf();
  CHECK_THAT(text.str(), ContainsSubstring("app open demo --start"));
  CHECK_THAT(text.str(), ContainsSubstring("Name=demo (checkout)"));
  CHECK_THAT(text.str(), ContainsSubstring("StartupWMClass=paperboat-demo"));
#endif

  const auto s1 = json::parse(run({"app", "open", "demo", p1.string(), "--no-open", "--json"}).stdout_text);
  CHECK(s1["id"] == "demo-47210");
  CHECK(json::parse(run({"app", "open", "demo", p1.string(), "--no-open", "--json"}).stdout_text)["id"] == "demo-47210");  // reused
  CHECK(json::parse(run({"app", "open", "demo", "--start", "--no-open", "--json"}).stdout_text)["id"] == "demo-47210");  // the desktop's: the one it has
  // opened: in a Paperboat window through the Launcher ($PAPERBOAT_LAUNCHER, here one that writes down its args)
  const fs::path seen = kHome / "launcher-args";
  std::ofstream(checkout / "bin" / "launcher") << "#!/bin/sh\necho \"$*\" > " << seen.string() << "\n";
  fs::permissions(checkout / "bin" / "launcher", fs::perms::owner_all);
  REQUIRE(cli({"app", "open", "demo", p1.string()}, data, {{"PAPERBOAT_LAUNCHER", (checkout / "bin" / "launcher").string()}}).ok());
  for (int i = 0; i < 50 && !(fs::exists(seen) && fs::file_size(seen) > 0); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
  std::string args;
  std::getline(std::ifstream(seen), args);
  CHECK(args == "--open " + s1["url"].get<std::string>() + " --title demo");
  const auto s2 = json::parse(run({"app", "open", "demo", p2.string(), "--no-open", "--json"}).stdout_text);
  const int p2port = s2["port"].get<int>();  // the home port is taken: the overflow range
  CHECK((p2port >= 30500 && p2port <= 30599));
  CHECK(json::parse(run({"sessions", "--json"}).stdout_text).size() == 2);
  CHECK(ProcessRunner::run_sync({"curl", "-fsS", s1["url"].get<std::string>()}).ok());  // it serves

  const auto r = json::parse(run({"session", "restart", "demo-47210", "--json"}).stdout_text);
  CHECK(r["port"] == 47210);
  CHECK(r["pid"] != s1["pid"]);
  CHECK(run({"session", "logs", "demo-47210", "--json"}).ok());
  CHECK(run({"session", "stop", "demo-" + std::to_string(p2port)}).ok());
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
#ifdef __linux__
  CHECK_FALSE(fs::exists(entry));
#endif
  CHECK(fs::exists(checkout / "bin" / "serve"));  // a checkout is only unlinked
  fs::remove_all(kHome);
}

TEST_CASE("launcher: the Launcher on a page and a runtime (an app's Manage runtimes…)", "[cli]") {
  const fs::path stand_in = kHome / "launcher", seen = kHome / "launcher-page-args";
  fs::create_directories(kHome);
  std::ofstream(stand_in) << "#!/bin/sh\necho \"$*\" > " << seen.string() << "\n";
  fs::permissions(stand_in, fs::perms::owner_all);
  const std::vector<std::pair<std::string, std::string>> env = {{"PAPERBOAT_LAUNCHER", stand_in.string()}};
  REQUIRE(cli({"launcher", "--page", "runtimes", "--runtime", "julia"}, {}, env).ok());
  for (int i = 0; i < 50 && !(fs::exists(seen) && fs::file_size(seen) > 0); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
  std::string args;
  std::getline(std::ifstream(seen), args);
  CHECK(args == "--page runtimes --runtime julia");
  CHECK(cli({"launcher", "--page", "nowhere"}, {}, env).exit_code == 2);
  CHECK(cli({"launcher"}, {}, {{"PAPERBOAT_LAUNCHER", "browser"}}).exit_code == 2);  // no Launcher, no page to open
  fs::remove_all(kHome);
}

// paperboat-examples of the test's own: a ready example, a pending one, a hub; its apps from a registry of the test's own.
TEST_CASE("examples: listed by app, copied on first open, opened in their app", "[cli]") {
  const fs::path data = kHome / "data", repo = kHome / "examples-src", checkout = kHome / "app-src";
  const auto put = [](const fs::path& f, const std::string& text) { fs::create_directories(f.parent_path()), std::ofstream(f) << text; };
  put(repo / "golden.py", "");
  put(repo / "simplicial" / "09-synth-cpp" / "example.toml", "kind = \"simplicial\"\napp = \"simplicial\"\nname = \"09 Synth\"\ndescription = \"Six voices\"\n");
  put(repo / "simplicial" / "09-synth-cpp" / "src" / "synth.cpp", "int main() {}\n");
  put(repo / "simplicial" / "09-synth-cpp" / "build" / "CMakeCache.txt", "left by a build\n");
  put(repo / "simplicial" / "01-thermostat" / "example.toml", "kind = \"simplicial\"\napp = \"simplicial\"\nname = \"01 Thermostat\"\ndescription = \"d\"\npending = \"ex#44\"\n");
  put(repo / "hubs" / "lab" / "example.toml", "kind = \"hub\"\napp = \"malachite\"\nname = \"Lab\"\ndescription = \"A study across the apps\"\n");
  put(repo / "hubs" / "lab" / "notes" / "index.md", "# Lab\n");
  put(repo / "legacy" / "README.md", "old\n");
  put(data / "apps.toml", "[[apps]]\nname = \"malachite\"\nlaunch = \"bin/serve\"\nport = 47220\n[[apps]]\nname = \"simplicial\"\nlaunch = \"bin/serve\"\nport = 47221\n");
  put(checkout / "bin" / "serve", "#!/bin/sh\nexec python3 -m http.server \"$3\" --bind 127.0.0.1 --directory \"$1\"\n");
  fs::permissions(checkout / "bin" / "serve", fs::perms::owner_all);
  const std::pair<std::string, std::string> dir{"PAPERBOAT_EXAMPLES_DIR", repo.string()};
  auto run = [&](std::vector<std::string> args) { return cli(std::move(args), data, {dir}); };

  const auto all = json::parse(run({"example", "list", "--json"}).stdout_text);
  REQUIRE(all.size() == 2);  // the pending one is left out
  CHECK(all[0] == json{{"id", "hubs/lab"}, {"app", "malachite"}, {"kind", "hub"}, {"name", "Lab"}, {"description", "A study across the apps"},
                       {"path", (repo / "hubs" / "lab").string()}});
  CHECK(all[1]["id"] == "simplicial/09-synth-cpp");
  const auto sx = json::parse(run({"examples", "--app", "simplicial", "--json"}).stdout_text);
  REQUIRE(sx.size() == 1);
  CHECK(sx[0]["name"] == "09 Synth");
  CHECK(json::parse(run({"example", "list", "--app", "julix", "--json"}).stdout_text).empty());
  CHECK(run({"example", "open", "nope/nothing"}).exit_code == 2);

  // its app not installed: copied all the same, and said which to install
  const fs::path copy = kHome / "examples" / "simplicial" / "09-synth-cpp";
  CHECK_THAT(run({"example", "open", "simplicial/09-synth-cpp"}).stderr_text, ContainsSubstring("paperboat app install simplicial"));
  CHECK(fs::exists(copy / "src" / "synth.cpp"));
  CHECK_FALSE(fs::exists(copy / "build"));  // what a build left stays behind
  REQUIRE(run({"app", "install", "malachite", "--from", checkout.string()}).ok());
  const auto o = run({"example", "open", "hubs/lab", "--no-open"});
  REQUIRE(o.ok());
  CHECK(o.stdout_text == (kHome / "examples" / "hubs" / "lab").string() + "\n");  // a hub opens in Malachite
  put(kHome / "examples" / "hubs" / "lab" / "notes" / "index.md", "# Mine\n");
  const auto j = json::parse(run({"example", "open", "hubs/lab", "--no-open", "--json"}).stdout_text);
  CHECK(j["session"]["project"] == (kHome / "examples" / "hubs" / "lab").string());  // the session it has
  CHECK(j["session"]["app"] == "malachite");
  std::stringstream kept;
  kept << std::ifstream(kHome / "examples" / "hubs" / "lab" / "notes" / "index.md").rdbuf();
  CHECK(kept.str() == "# Mine\n");  // the copy as the user left it; the original stays clean
  CHECK(run({"app", "stop", "malachite"}).ok());

  // no checkout: GitHub's copy (a folder here, its tarball one top folder), kept a day
  if (fs::exists(fs::path(PAPERBOAT_BIN_DIR).parent_path().parent_path() / "paperboat-examples" / "golden.py")) SKIP("a paperboat-examples checkout is beside this one");
  const fs::path gh = kHome / "github", tgz = gh / "repos" / "paperboatlab" / "paperboat-examples" / "tarball";
  fs::create_directories(tgz.parent_path());
  fs::rename(repo, kHome / "paperboatlab-paperboat-examples-abc123");
  REQUIRE(ProcessRunner::run_sync({"tar", "-czf", tgz.string(), "-C", kHome.string(), "paperboatlab-paperboat-examples-abc123"}).ok());
  const auto fetched = cli({"example", "list", "--json"}, data, {{"PAPERBOAT_GITHUB_API", "file://" + gh.string()}});
  REQUIRE(fetched.ok());
  const auto f = json::parse(fetched.stdout_text);
  REQUIRE(f.size() == 2);
  CHECK(f[1]["path"] == (kHome / "cache" / "examples" / "simplicial" / "09-synth-cpp").string());
  CHECK(json::parse(cli({"example", "list", "--json"}, data, {{"PAPERBOAT_GITHUB_API", "file:///nowhere"}}).stdout_text) == f);  // kept
  fs::remove_all(kHome / "cache");
  CHECK_THAT(cli({"example", "list"}, data, {{"PAPERBOAT_GITHUB_API", "file:///nowhere"}}).stderr_text, ContainsSubstring("PAPERBOAT_EXAMPLES_DIR"));
  fs::remove_all(kHome);
}
