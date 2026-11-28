// The CLI against its registry: the real binary, a home of its own, no daemon needed.

#include "paperboat/process.hpp"
#include "update.hpp"

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
TEST_CASE("examples: listed by app, opened where they are, copied when asked", "[cli]") {
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
  // the server notes what it was told: PAPERBOAT_EXAMPLE, by its port
  put(checkout / "bin" / "serve", "#!/bin/sh\nprintf %s \"$PAPERBOAT_EXAMPLE\" > " + (kHome / "told-").string() +
                                      "$3\nexec python3 -m http.server \"$3\" --bind 127.0.0.1 --directory \"$1\"\n");
  fs::permissions(checkout / "bin" / "serve", fs::perms::owner_all);
  const auto told = [](const json& session) {
    std::ifstream in(kHome / ("told-" + std::to_string(session["port"].get<int>())));
    return std::string(std::istreambuf_iterator<char>(in), {});
  };
  const std::pair<std::string, std::string> dir{"PAPERBOAT_EXAMPLES_DIR", repo.string()};
  auto run = [&](std::vector<std::string> args) { return cli(std::move(args), data, {dir}); };

  const auto all = json::parse(run({"example", "list", "--json"}).stdout_text);
  REQUIRE(all.size() == 2);  // the pending one is left out
  CHECK(all[0] == json{{"id", "hubs/lab"}, {"app", "malachite"}, {"kind", "hub"}, {"name", "Lab"}, {"description", "A study across the apps"},
                       {"path", (repo / "hubs" / "lab").string()}, {"root", repo.string()}});  // root: where examples are
  CHECK(all[1]["id"] == "simplicial/09-synth-cpp");
  const auto sx = json::parse(run({"examples", "--app", "simplicial", "--json"}).stdout_text);
  REQUIRE(sx.size() == 1);
  CHECK(sx[0]["name"] == "09 Synth");
  CHECK(json::parse(run({"example", "list", "--app", "julix", "--json"}).stdout_text).empty());
  CHECK(run({"example", "open", "nope/nothing"}).exit_code == 2);

   // its app not installed: said which to install
  CHECK_THAT(run({"example", "open", "simplicial/09-synth-cpp"}).stderr_text, ContainsSubstring("paperboat app install simplicial"));
  REQUIRE(run({"app", "install", "malachite", "--from", checkout.string()}).ok());
  const fs::path lab = repo / "hubs" / "lab", mine = kHome / "my hubs";
  // the folder opened as a folder first: not an example's session, so `example open` doesn't reuse it (pb#85)
  const auto plain = json::parse(run({"app", "open", "malachite", lab.string(), "--no-open", "--json"}).stdout_text);
  CHECK(plain["example"] == "");
  CHECK(told(plain).empty());
  const auto o = run({"example", "open", "hubs/lab", "--no-open"});
  REQUIRE(o.ok());
  CHECK(o.stdout_text == lab.string() + "\n");  // a hub opens in Malachite, where it is: nothing copied
  CHECK_FALSE(fs::exists(kHome / "examples"));
  fs::create_directories(mine);
  CHECK(run({"example", "open", "hubs/lab", "--no-open", "--to", (kHome / "nowhere").string()}).exit_code == 2);
  const auto j = json::parse(run({"example", "open", "hubs/lab", "--no-open", "--to", mine.string(), "--json"}).stdout_text);
  CHECK(j["session"]["project"] == lab.string());  // the session it has
  CHECK(j["session"]["app"] == "malachite");
  CHECK(j["session"]["example"] == "hubs/lab");  // opened as the example, and its server was told so
  CHECK(j["session"]["port"] != plain["port"]);
  CHECK(told(j["session"]) == "hubs/lab");
  CHECK(j["root"] == repo.string());
  // and the folder's own session is still the one `app open` finds
  CHECK(json::parse(run({"app", "open", "malachite", lab.string(), "--no-open", "--json"}).stdout_text)["port"] == plain["port"]);
  // a restart keeps it an example
  const std::string ex_id = j["session"]["id"];
  const auto re = json::parse(run({"session", "restart", ex_id, "--json"}).stdout_text);
  CHECK(re["example"] == "hubs/lab");
  CHECK(told(re) == "hubs/lab");
  CHECK(j["cache"] == false);
  // the page is told it is an example, its name, and where its Copy goes
  CHECK(j["url"] == j["session"]["url"].get<std::string>() + "?example=hubs/lab&name=Lab&to=" + (kHome / "my%20hubs").string());

  // copied into a folder of the user's, without what a build left; never over a folder there
  const auto c = run({"example", "copy", "simplicial/09-synth-cpp", "--to", mine.string()});
  REQUIRE(c.ok());
  CHECK(c.stdout_text == (mine / "09-synth-cpp").string() + "\n");
  CHECK(fs::exists(mine / "09-synth-cpp" / "src" / "synth.cpp"));
  CHECK_FALSE(fs::exists(mine / "09-synth-cpp" / "build"));
  CHECK(fs::exists(repo / "simplicial" / "09-synth-cpp" / "build"));  // the original as it was
  CHECK_THAT(run({"example", "copy", "simplicial/09-synth-cpp", "--to", mine.string()}).stderr_text, ContainsSubstring("is there already"));
  CHECK(run({"example", "copy", "simplicial/09-synth-cpp"}).exit_code == 2);  // no --to
  const auto co = json::parse(run({"example", "copy", "hubs/lab", "--to", mine.string(), "--open", "--no-open", "--json"}).stdout_text);
  CHECK(co["path"] == (mine / "lab").string());
  CHECK(co["session"]["project"] == (mine / "lab").string());  // --open: the copy in its app
  CHECK(co["session"]["example"] == "");  // a copy is the user's: no longer an example
  CHECK(told(co["session"]).empty());
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
  const std::vector<std::pair<std::string, std::string>> offline = {{"PAPERBOAT_GITHUB_API", "file:///nowhere"}};
  const auto oc = json::parse(cli({"example", "open", "hubs/lab", "--no-open", "--json"}, data, offline).stdout_text);
  CHECK(oc["cache"] == true);  // changes there aren't kept: the page says so
  CHECK(oc["url"].get<std::string>().ends_with("&cache=1"));
  CHECK(cli({"app", "stop", "malachite"}, data, offline).ok());
  fs::remove_all(kHome / "cache");
  CHECK_THAT(cli({"example", "list"}, data, {{"PAPERBOAT_GITHUB_API", "file:///nowhere"}}).stderr_text, ContainsSubstring("PAPERBOAT_EXAMPLES_DIR"));
  fs::remove_all(kHome);
}

// pb#94: `update --install` against a release of the test's own (file://), the install command run by a stand-in
// that records it: nothing here asks for a password or installs anything.
TEST_CASE("update --install: asks first, checks the SHA-256, installs the system's packages, a cancel changes nothing", "[cli]") {
  const fs::path gh = kHome / "github", rel = kHome / "release", stub = kHome / "pkexec-stub", said = kHome / "stub-said";
  const auto put = [](const fs::path& f, const std::string& text) { fs::create_directories(f.parent_path()), std::ofstream(f) << text; };
  const std::string cli_rpm = "paperboat-cli-99.0.0-1.x86_64.rpm", devel_rpm = "paperboat-devel-99.0.0-1.x86_64.rpm";
  put(rel / cli_rpm, std::string(300000, 'c'));
  put(rel / devel_rpm, "devel");
  put(rel / "paperboat-launcher-99.0.0.x86_64.rpm", "launcher");
  const auto release = [&](const std::string& cli_digest, bool sums) {
    json assets = {{{"name", cli_rpm}, {"browser_download_url", "file://" + (rel / cli_rpm).string()}, {"digest", cli_digest}, {"size", 300000}},
                   {{"name", devel_rpm}, {"browser_download_url", "file://" + (rel / devel_rpm).string()}, {"digest", sums ? json(nullptr) : json("sha256:" + paperboat::update::sha256_hex("devel"))}, {"size", 5}},
                   {{"name", "paperboat-launcher-99.0.0.x86_64.rpm"}, {"browser_download_url", "file:///nowhere"}, {"digest", ""}, {"size", 8}}};
    if (sums) {
      put(rel / "SHA256SUMS", paperboat::update::sha256_hex("devel") + "  " + devel_rpm + "\n");
      assets.push_back({{"name", "SHA256SUMS"}, {"browser_download_url", "file://" + (rel / "SHA256SUMS").string()}});
    }
    put(gh / "repos" / "paperboatlab" / "paperboat" / "releases", json{{{"tag_name", "v99.0.0"}, {"html_url", "https://example.org/v99"}, {"assets", assets}}}.dump());
  };
  put(stub, "#!/bin/sh\necho \"$@\" >> " + said.string() + "\necho 'Not authorized' >&2\nexit ${STUB_EXIT:-0}\n");
  fs::permissions(stub, fs::perms::owner_all);
  const std::string good = "sha256:" + paperboat::update::sha256_hex(std::string(300000, 'c'));
  const fs::path cache = kHome / "cache" / "updates" / "99.0.0";
  const auto update = [&](std::vector<std::string> args, std::string exit = "0", std::string sys = "rpm x86_64 cli devel") {
    args.insert(args.begin(), "update");
    return cli(args, {}, {{"PAPERBOAT_GITHUB_API", "file://" + gh.string()}, {"PAPERBOAT_UPDATE_SYSTEM", sys},
                          {"PAPERBOAT_UPDATE_RUNNER", stub.string()}, {"STUB_EXIT", exit}});
  };
  const auto stub_said = [&] { std::ifstream in(said); std::string l; std::getline(in, l); return l; };
  release(good, false);

  // the check says how to install; nothing downloads before the user agrees
  CHECK_THAT(update({}).stdout_text, ContainsSubstring("paperboat update --install"));
  CHECK(json::parse(update({"--check", "--json"}).stdout_text)["installable"] == true);
  CHECK(json::parse(cli({"update", "--check", "--json"}, {}, {{"PAPERBOAT_GITHUB_API", "file://" + gh.string()}}).stdout_text)["installable"] == false);
  const auto no = update({"--install", "--json"});
  CHECK(no.exit_code == 2);
  CHECK_THAT(json::parse(no.stdout_text)["error"].get<std::string>(), ContainsSubstring("--yes"));
  CHECK(!fs::exists(cache));
  CHECK(!fs::exists(said));

  // a refused password: the packages were checked, the install ran once and nothing changed
  const auto refused = update({"--install", "--yes", "--json"}, "126");
  CHECK(refused.exit_code == 1);
  CHECK(json::parse(refused.stdout_text)["cancelled"] == true);
  CHECK_THAT(json::parse(refused.stdout_text)["error"].get<std::string>(), ContainsSubstring("nothing was installed"));
  CHECK_THAT(refused.stderr_text, ContainsSubstring("checked " + cli_rpm + ": SHA-256 matches the release"));
  CHECK_THAT(refused.stderr_text, ContainsSubstring("downloading " + cli_rpm + ": 0.3 of 0.3 MB"));
  CHECK(stub_said() == "pkexec dnf install -y " + (cache / cli_rpm).string() + " " + (cache / devel_rpm).string());  // not the Launcher: not installed here
  fs::remove(said);

  // installed: the files go, the result names them; no paperboatd runs for this home
  const auto ok = update({"--install", "--yes", "--json"});
  REQUIRE(ok.ok());
  const auto j = json::parse(ok.stdout_text);
  CHECK(j["installed"] == "99.0.0");
  CHECK(j["files"] == json{cli_rpm, devel_rpm});
  CHECK(j["daemon"].is_null());
  CHECK(!fs::exists(cache));
  CHECK_THAT(update({"--install", "--yes"}).stdout_text, ContainsSubstring("Paperboat 99.0.0 is installed. Restart the Launcher to use it."));
  fs::remove(said);

  // a file that isn't what the release published is never installed
  release("sha256:" + std::string(64, '0'), false);
  const auto bad = update({"--install", "--yes", "--json"});
  CHECK(bad.exit_code == 1);
  CHECK_THAT(json::parse(bad.stdout_text)["error"].get<std::string>(), ContainsSubstring("doesn't match the release's SHA-256"));
  CHECK(!fs::exists(said));
  CHECK(!fs::exists(cache / cli_rpm));

  // without GitHub's digest, the release's SHA256SUMS; with neither, refused
  release(good, true);
  CHECK(update({"--install", "--yes", "--json"}).ok());
  CHECK(fs::exists(said));
  fs::remove(said);
  release("", false);
  CHECK_THAT(json::parse(update({"--install", "--yes", "--json"}).stdout_text)["error"].get<std::string>(), ContainsSubstring("publishes no SHA-256 for " + cli_rpm));
  CHECK(!fs::exists(said));

  // the Launcher's package comes too when it is installed, and a missing one stops it all; a dnf failure is a failure
  release(good, false);
  CHECK_THAT(update({"--install", "--yes", "--json"}, "0", "rpm aarch64 cli devel").stdout_text, ContainsSubstring("no rpm of paperboat-cli for aarch64"));
  const auto failed = update({"--install", "--yes", "--json"}, "1");
  CHECK(failed.exit_code == 1);
  CHECK(!json::parse(failed.stdout_text).contains("cancelled"));
  CHECK_THAT(json::parse(failed.stdout_text)["error"].get<std::string>(), ContainsSubstring("the install failed (pkexec dnf exited 1)"));
  fs::remove(said);
  // a build from source updates its checkout
  const auto src = cli({"update", "--install", "--yes"}, {}, {{"PAPERBOAT_GITHUB_API", "file://" + gh.string()}});
  CHECK(src.exit_code == 1);
  CHECK_THAT(src.stderr_text, ContainsSubstring("isn't installed from a package"));
  fs::remove_all(kHome);
}
