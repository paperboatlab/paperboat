// paperboat: the CLI. Every command is an entry in the registry (commands.toml, embedded at build
// time): dispatch, usage and `help` all read it, and so do the Launcher and the TUI (through
// @paperboat/client). Runtime commands are paperboat-control/0 requests to paperboatd (started on
// demand); with --json the CLI prints the daemon's objects unchanged, for scripts and the front ends.

#include <cerrno>
#include <cstring>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#include "paperboat/backend.hpp"
#include "paperboat/control.hpp"
#include "paperboat/manifest.hpp"
#include "paperboat/paths.hpp"
#include "paperboat/process.hpp"

#include <nlohmann/json.hpp>
#include <toml++/toml.hpp>

#include <algorithm>
#include <csignal>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iomanip>
#include <iostream>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <thread>
#include <tuple>
#include <vector>

#ifndef PAPERBOAT_VERSION
#define PAPERBOAT_VERSION "0.0.0-dev"
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;
using namespace paperboat;

extern const char* const kCommandsToml;  // commands.toml, generated into the build

namespace {

// ── the registry ──

struct Command {
  std::string id, name, args, desc, group;
  std::string app;  // the installed app it came with ("" for the platform's own)
  fs::path exec;    // that app's CLI, run with the words as typed
  std::vector<std::string> alias;
  bool tui = false;
};

std::vector<std::string> words(const std::string& s) {
  std::vector<std::string> out;
  std::istringstream in(s);
  for (std::string w; in >> w;) out.push_back(w);
  return out;
}

void add_commands(std::vector<Command>& out, const toml::table& t, const std::string& app = {}, const fs::path& exec = {}) {
  const auto* list = t["command"].as_array();
  if (!list) return;
  for (const auto& node : *list) {
    const auto& c = *node.as_table();
    Command cmd;
    cmd.id = c["id"].value_or(std::string());
    cmd.name = c["name"].value_or(std::string());
    cmd.args = c["args"].value_or(std::string());
    cmd.desc = c["desc"].value_or(std::string());
    cmd.group = c["group"].value_or(std::string());
    cmd.tui = c["tui"].value_or(false);
    cmd.app = app;
    cmd.exec = exec;
    if (const auto* a = c["alias"].as_array())
      for (const auto& x : *a) cmd.alias.push_back(*x.value<std::string>());
    out.push_back(std::move(cmd));
  }
}

// The platform's commands, then each installed app's (<home>/apps/<app>/commands.toml, its `cli` the
// program that runs them). The platform's code names no app: an app brings its own commands.
const std::vector<Command>& registry() {
  static const std::vector<Command> reg = [] {
    std::vector<Command> out;
    add_commands(out, toml::parse(kCommandsToml));
    std::error_code ec;
    for (const auto& app : fs::directory_iterator(paths::home() / "apps", ec)) {
      const fs::path file = app.path() / "commands.toml";
      if (!fs::exists(file)) continue;
      try {
        const toml::table t = toml::parse_file(file.string());
        add_commands(out, t, app.path().filename().string(), app.path() / t["cli"].value_or(std::string()));
      } catch (const std::exception& e) {
        std::cerr << "paperboat: skipping " << file.string() << ": " << e.what() << "\n";
      }
    }
    return out;
  }();
  return reg;
}

const Command* find_id(const std::string& id) {
  for (const auto& c : registry())
    if (c.id == id) return &c;
  return nullptr;
}

// ── arguments ──

struct Args {
  const Command* cmd = nullptr;
  std::vector<std::string> raw;              // every word as typed (an app's command gets them all)
  std::vector<std::string> pos;              // after the command's words
  std::map<std::string, std::string> opt;    // --flag value, or "1"
  bool json_out = false;
  fs::path socket = paths::control_socket();
  bool has(const std::string& k) const { return opt.contains(k); }
  std::string get(const std::string& k, const std::string& d = "") const {
    const auto it = opt.find(k);
    return it == opt.end() ? d : it->second;
  }
  std::string arg(std::size_t i) const { return i < pos.size() ? pos[i] : ""; }
};

const std::vector<std::string> kValued = {"--project", "--from", "--backend", "--socket", "--tail", "--source", "--kind", "--port", "--time", "--var"};

// The longest registered name (or alias) the words start with; the rest are its arguments.
Args parse(int argc, char** argv) {
  Args a;
  std::vector<std::string> plain;
  a.raw.assign(argv + 1, argv + argc);
  for (int i = 1; i < argc; ++i) {
    const std::string s = argv[i];
    if (s == "--json") a.json_out = true;
    else if (std::ranges::find(kValued, s) != kValued.end() && i + 1 < argc) a.opt[s] = argv[++i];
    else if (s.starts_with("--") && s.size() > 2) a.opt[s] = "1";
    else plain.push_back(s);
  }
  if (a.has("--socket")) a.socket = a.get("--socket");
  std::size_t best = 0;
  for (const auto& c : registry()) {
    if (c.tui) continue;
    std::vector<std::vector<std::string>> names = {words(c.name)};
    for (const auto& al : c.alias) names.push_back(words(al));
    for (const auto& n : names)
      if (n.size() > best && n.size() <= plain.size() && std::equal(n.begin(), n.end(), plain.begin())) {
        best = n.size();
        a.cmd = &c;
      }
  }
  a.pos.assign(plain.begin() + static_cast<long>(best), plain.end());
  return a;
}

// ── output ──

struct Failure : std::runtime_error {
  Failure(const std::string& m, int c = 1, json x = json::object()) : std::runtime_error(m), code(c), extra(std::move(x)) {}
  int code;
  json extra;
};

void print_json(const json& j) { std::cout << j.dump(2) << "\n"; }

// A plain table: columns padded to their widest cell.
void print_table(const std::vector<std::string>& head, const std::vector<std::vector<std::string>>& rows) {
  std::vector<std::size_t> w(head.size());
  for (std::size_t i = 0; i < head.size(); ++i) w[i] = head[i].size();
  for (const auto& r : rows)
    for (std::size_t i = 0; i < r.size() && i < w.size(); ++i) w[i] = std::max(w[i], r[i].size());
  auto line = [&](const std::vector<std::string>& r) {
    for (std::size_t i = 0; i < r.size(); ++i)
      std::cout << (i ? "  " : "") << (i + 1 < r.size() ? std::string(r[i]).append(w[i] - r[i].size(), ' ') : r[i]);
    std::cout << "\n";
  };
  line(head);
  for (const auto& r : rows) line(r);
}

std::string fmt_bytes(long long b) {
  if (b < 0) return "-";
  const char* units[] = {"B", "KiB", "MiB", "GiB", "TiB"};
  double v = static_cast<double>(b);
  int u = 0;
  while (v >= 1024 && u < 4) v /= 1024, ++u;
  std::ostringstream o;
  o << std::fixed << std::setprecision(u ? 1 : 0) << v << " " << units[u];
  return o.str();
}

std::string fmt_secs(double s) {
  std::ostringstream o;
  if (s < 60) o << static_cast<int>(s) << "s";
  else if (s < 3600) o << static_cast<int>(s / 60) << "m";
  else o << static_cast<int>(s / 3600) << "h" << static_cast<int>(s / 60) % 60 << "m";
  return o.str();
}

// ── shipped data: the registries beside the binary (installed: share/paperboat; a build: the build dir) ──

// $PAPERBOAT_DATA_DIR first: tests (and a private registry) put their own apps.toml there.
fs::path data_file(const std::string& name) {
  std::vector<fs::path> dirs = {paths::exe_dir().parent_path() / "share" / "paperboat", paths::exe_dir()};
  if (const char* d = std::getenv("PAPERBOAT_DATA_DIR"); d && *d) dirs.insert(dirs.begin(), d);
  for (const fs::path& d : dirs)
    if (fs::exists(d / name)) return d / name;
  throw Failure(name + " is missing from this installation");
}

toml::table load_toml(const std::string& name) { return toml::parse_file(data_file(name).string()); }

std::vector<toml::table> entries(const toml::table& t, const char* key) {
  std::vector<toml::table> out;
  if (const auto* a = t[key].as_array())
    for (const auto& n : *a) out.push_back(*n.as_table());
  return out;
}

// ── installed apps: <home>/apps/<app> (the release, or a link to a checkout) and <home>/apps/<app>.toml ──

fs::path app_dir(const std::string& app) { return paths::home() / "apps" / app; }
fs::path app_marker(const std::string& app) { return paths::home() / "apps" / (app + ".toml"); }

// {version, from} of an installed app, or null.
json installed(const std::string& app) {
  std::error_code ec;
  if (!fs::exists(app_marker(app), ec)) return nullptr;
  const toml::table t = toml::parse_file(app_marker(app).string());
  return {{"version", t["version"].value_or(std::string())}, {"from", t["from"].value_or(std::string())}};
}

std::string app_of(const Command& c) { return c.app; }

// An app's command runs its own CLI with every word as typed (`paperboat run x` → `<app>/bin/… run x`).
int run_app_command(const Command& c, const std::vector<std::string>& raw) {
  std::vector<std::string> argv{c.exec.string()};
  argv.insert(argv.end(), raw.begin(), raw.end());
  std::vector<char*> p;
  for (auto& s : argv) p.push_back(s.data());
  p.push_back(nullptr);
  ::execv(p[0], p.data());
  throw Failure(app_of(c) + "'s command line " + c.exec.string() + " could not start: " + std::strerror(errno), 1);
}

// A word no command has: if an app in the registry adds it (apps.toml `commands`), say which to install.
Failure unknown_command(const std::vector<std::string>& pos) {
  const std::string w = pos.empty() ? "" : pos[0];
  try {
    for (const auto& e : entries(load_toml("apps.toml"), "apps")) {
        if (const auto* cmds = e["commands"].as_array())
          for (const auto& c : *cmds)
            if (c.value_or(std::string()) == w) {
              const std::string app = e["name"].value_or(std::string());
              return Failure("no command '" + w + "' · `paperboat app install " + app + "` adds it", 2, {{"app", app}});
            }
    }
  } catch (const std::exception&) {  // no registry beside this build: just the plain answer
  }
  return Failure("no command '" + w + "' · paperboat help lists them", 2);
}

// ── the daemon ──

ControlClient& daemon(Args& a) {
  static std::unique_ptr<ControlClient> c;
  if (!c) c = std::make_unique<ControlClient>(a.socket);
  return *c;
}

// Run a command in a short-lived exec runtime and wait for it: {exit code, output}.
std::pair<int, std::string> run_in(Args& a, const json& args) {
  ControlClient& c = daemon(a);
  c.call("subscribe");
  std::string lease;
  int code = -1;
  bool ended = false;
  c.on_event = [&](const json& e) {
    if (e["event"] == "runtime.pulling" && !a.json_out) std::cerr << "pulling " << e["runtime"].get<std::string>() << "…\n";
    if (e["event"] == "runtime.exited" && e["lease"] == lease) {
      code = e["exit_code"].get<int>();
      ended = true;
      return false;
    }
    return true;
  };
  json req = args;
  req["mode"] = "exec";
  req["owner"] = "cli";
  lease = c.call("acquire", req)["id"].get<std::string>();
  c.listen();
  if (!ended) throw Failure("paperboatd went away");
  const std::string out = c.call("logs", {{"lease", lease}, {"tail", 2000}})["text"].get<std::string>();
  c.call("release", {{"lease", lease}});
  return {code, out};
}

// ── handlers ──

using Handler = std::function<int(Args&)>;

fs::path config_file() { return paths::home() / "config.toml"; }

std::string channel() {
  std::error_code ec;
  if (!fs::exists(config_file(), ec)) return "release";
  try {
    return toml::parse_file(config_file().string())["channel"].value_or(std::string("release"));
  } catch (...) {
    return "release";
  }
}

// ── apps and sessions ──

toml::table registry_entry(const std::string& app) {
  for (auto& e : entries(load_toml("apps.toml"), "apps"))
    if (e["name"].value_or(std::string()) == app) return e;
  throw Failure("no app named " + app + " in the registry; paperboat app list shows them", 2);
}

std::string need_arg(Args& a, const char* what) {
  if (a.arg(0).empty()) throw Failure(std::string("which ") + what + "? paperboat " + a.cmd->name + " " + a.cmd->args, 2);
  return a.arg(0);
}

// The last n lines of a file.
std::string tail(const fs::path& file, std::size_t n) {
  std::ifstream in(file);
  std::vector<std::string> lines;
  for (std::string l; std::getline(in, l);) lines.push_back(std::move(l));
  std::string out;
  for (std::size_t i = lines.size() > n ? lines.size() - n : 0; i < lines.size(); ++i) out += lines[i] + "\n";
  return out;
}

// GitHub's releases of `repo` (a GitHub URL or owner/name), kept in <home>/cache/releases: `app list` asks on every
// Launcher poll, so it takes what is younger than `max_age` (0: always ask). GitHub out of reach: what was kept,
// else null; a miss is kept too ("null"), so an offline list doesn't wait on GitHub each time.
json releases_of(std::string repo, std::chrono::seconds max_age) {
  for (const std::string p : {"https://github.com/", "http://github.com/"})
    if (repo.starts_with(p)) repo.erase(0, p.size());
  if (repo.ends_with(".git")) repo.resize(repo.size() - 4);
  std::string key = repo;
  std::ranges::replace(key, '/', '_');
  const fs::path kept = paths::home() / "cache" / "releases" / (key + ".json");
  const auto read_kept = [&]() -> json { try { return json::parse(std::ifstream(kept)); } catch (...) { return nullptr; } };
  std::error_code ec;
  const auto at = fs::last_write_time(kept, ec);
  if (!ec && max_age.count() > 0 && fs::file_time_type::clock::now() - at < max_age) return read_kept();
  std::vector<std::string> curl{"curl", "-fsSL", "--max-time", "15", "-H", "Accept: application/vnd.github+json"};
  // GitHub allows 60 anonymous asks an hour per address; a token (CI's, or the user's) lifts it
  for (const char* v : {"GITHUB_TOKEN", "GH_TOKEN"})
    if (const char* t = std::getenv(v); t && *t) { curl.insert(curl.end(), {"-H", std::string("Authorization: Bearer ") + t}); break; }
  curl.push_back("https://api.github.com/repos/" + repo + "/releases?per_page=30");
  const auto r = ProcessRunner::run_sync(curl, {}, {}, std::chrono::seconds(20));
  json out = nullptr;
  if (r.ok()) try { out = json::parse(r.stdout_text); } catch (...) {}
  if (out.is_null() && !ec) out = read_kept();  // stale beats nothing
  fs::create_directories(kept.parent_path(), ec);
  std::ofstream(kept) << out.dump();
  return out;
}

// GitHub's newest release of `repo` on the channel, or the one tagged v<want>: {version, url, assets: {name: download
// url}}, or null; throws when GitHub can't be reached.
json newest_release(const std::string& repo, const std::string& want = "", std::chrono::seconds max_age = {}) {
  const json all = releases_of(repo, max_age);
  if (!all.is_array()) throw Failure("could not reach GitHub for the releases of " + repo);
  const std::string ch = channel();
  json newest = nullptr;
  for (const auto& rel : all) {
    std::string tag = rel.value("tag_name", std::string());
    if (tag.starts_with('v')) tag.erase(0, 1);
    if (rel.value("draft", false)) continue;
    if (want.empty() ? (ch == "release" && rel.value("prerelease", false)) : tag != want) continue;
    if (!newest.is_null() && compare_versions(tag, newest["version"].get<std::string>()) <= 0) continue;
    json assets = json::object();
    for (const auto& x : rel.value("assets", json::array())) assets[x.value("name", "")] = x.value("browser_download_url", "");
    newest = {{"version", tag}, {"url", rel.value("html_url", std::string())}, {"assets", assets}};
  }
  return newest;
}

// A session: an app server paperboat started, one record in <runtime dir>/sessions.
fs::path sessions_dir() { return paths::runtime_dir() / "sessions"; }

// The sessions still running; the record of one that ended is dropped (its log stays).
std::vector<json> sessions() {
  std::vector<json> out;
  std::error_code ec;
  for (const auto& f : fs::directory_iterator(sessions_dir(), ec)) {
    if (f.path().extension() != ".json") continue;
    json s;
    try {
      s = json::parse(std::ifstream(f.path()));
    } catch (const std::exception&) {
      continue;
    }
    if (ProcessRunner::is_alive(s["pid"].get<int>())) out.push_back(std::move(s));
    else fs::remove(f.path(), ec);
  }
  std::ranges::sort(out, {}, [](const json& s) { return s["id"].get<std::string>(); });
  return out;
}

json find_session(const std::string& id) {
  for (auto& s : sessions())
    if (s["id"] == id) return s;
  throw Failure("no session named " + id + "; paperboat session list shows them", 2);
}

sockaddr_in loopback(int port) {
  sockaddr_in sa{};
  sa.sin_family = AF_INET;
  sa.sin_port = htons(static_cast<uint16_t>(port));
  sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  return sa;
}

bool listening(int port) {
  const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  const sockaddr_in sa = loopback(port);
  const bool ok = ::connect(fd, reinterpret_cast<const sockaddr*>(&sa), sizeof sa) == 0;
  ::close(fd);
  return ok;
}

bool port_free(int port) {
  const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  const int one = 1;
  ::setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  const sockaddr_in sa = loopback(port);
  const bool ok = ::bind(fd, reinterpret_cast<const sockaddr*>(&sa), sizeof sa) == 0;
  ::close(fd);
  return ok;
}

// Every app has a home port in the registry (30471 up; 30470 is Paperboat's); further folders of any
// app share the overflow range.
constexpr int kOverflowFirst = 30500, kOverflowLast = 30599;

// Start <app>'s server on a folder: `<launch> <folder> --port <port>`, detached, its output in a log.
// Its home port (or the one asked for, waited on for up to 5 s), else the first free one in the overflow range;
// ready once it listens.
json start_session(const std::string& app, const fs::path& project, int port = 0) {
  const toml::table e = registry_entry(app);
  const int home = port ? port : e["port"].value_or(0);
  if (home <= 0) throw Failure(app + " has no port in the registry");
  std::vector<int> taken;
  for (const auto& s : sessions()) taken.push_back(s["port"].get<int>());
  auto free = [&](int p) { return std::ranges::find(taken, p) == taken.end() && port_free(p); };
  int p = home;
  // the port asked for (a restart's own): the old server may still be letting go of it (macOS: a moment after exit)
  for (int i = 0; port && i < 50 && !free(p); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
  if (!free(p))
    for (p = kOverflowFirst; !free(p); )
      if (++p > kOverflowLast)
        throw Failure("port " + std::to_string(home) + " is taken and no port from " + std::to_string(kOverflowFirst) + " to " +
                      std::to_string(kOverflowLast) + " is free");
  const std::string id = app + "-" + std::to_string(p);
  const fs::path log = sessions_dir() / (id + ".log");
  std::error_code ec;
  fs::create_directories(sessions_dir());
  fs::remove(log, ec);
  const fs::path exe = app_dir(app) / e["launch"].value_or(std::string());
  std::vector<std::string> argv{exe.string(), "--port", std::to_string(p)};
  if (!project.empty()) argv.insert(argv.begin() + 1, project.string());  // none: the app's Start page
  const char* h = std::getenv("HOME");
  const int pid = ProcessRunner::run_detached(argv, project.empty() ? fs::path(h ? h : "/") : project, {}, log);
  if (pid < 0) throw Failure("could not start " + exe.string());
  for (int i = 0; i < 300 && !listening(p); ++i) {
    int st = 0;
    if (::waitpid(pid, &st, WNOHANG) == pid) throw Failure(app + " ended while starting:\n" + tail(log, 20));
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  if (!listening(p)) {
    ProcessRunner::kill_pgid(pid);
    throw Failure(app + " did not listen on port " + std::to_string(p) + " within 30 s:\n" + tail(log, 20));
  }
  const json s = {{"id", id},   {"app", app}, {"project", project.string()}, {"port", p}, {"pid", pid},
                  {"url", "http://127.0.0.1:" + std::to_string(p) + "/"}, {"log", log.string()}, {"started", std::time(nullptr)}};
  std::ofstream(sessions_dir() / (id + ".json")) << s.dump(2);
  return s;
}

// A session's whole process group, then its record.
void stop_session(const json& s) {
  ProcessRunner::kill_pgid(s["pid"].get<int>(), SIGTERM, 3000);
  std::error_code ec;
  fs::remove(sessions_dir() / (s["id"].get<std::string>() + ".json"), ec);
}

std::vector<json> sessions_of(const std::string& app) {
  std::vector<json> out;
  for (auto& s : sessions())
    if (s["app"] == app) out.push_back(s);
  return out;
}

// The Launcher that opens an app's page in a Paperboat window (plans/2026-11-26_11-05_one_file_workflow.md):
// $PAPERBOAT_LAUNCHER (a program; "browser" for none), paperboat-launcher on PATH, or the dev checkout's
// apps/launcher beside build/ with its Electron. Empty: the browser.
std::vector<std::string> launcher() {
  if (const char* v = std::getenv("PAPERBOAT_LAUNCHER"); v && *v)
    return std::string(v) == "browser" ? std::vector<std::string>{} : std::vector<std::string>{v};
  if (const auto w = which("paperboat-launcher"); !w.empty()) return {w};
  const fs::path repo = paths::exe_dir().parent_path(), electron = repo / "node_modules" / ".bin" / "electron";
  if (fs::exists(repo / "apps" / "launcher" / "dist" / "main.cjs") && fs::exists(electron)) return {electron.string(), (repo / "apps" / "launcher").string()};
  return {};
}

// An app's page: a Paperboat window when the Launcher is here (a running one opens it), else the browser.
void open_url(const std::string& url, const std::string& title = "") {
  if (auto cmd = launcher(); !cmd.empty()) {
    cmd.insert(cmd.end(), {"--open", url});
    if (!title.empty()) cmd.insert(cmd.end(), {"--title", title});
    ProcessRunner::run_detached(cmd);
    return;
  }
#ifdef __APPLE__
  ProcessRunner::run_detached({"open", url});
#else
  ProcessRunner::run_detached({"xdg-open", url});
#endif
}

// The runtimes an app uses, pulled now so its first cell doesn't wait; they would be pulled when needed anyway.
void pull_runtimes(Args& a, const toml::table& e) {
  if (const auto* rts = e["runtimes"].as_array())
    for (const auto& r : *rts) {
      const std::string rt = r.value_or(std::string());
      try {
        if (!a.json_out) std::cerr << "pulling " << rt << "…\n";
        daemon(a).call("pull", {{"runtime", rt}});
      } catch (const std::exception& ex) {
        std::cerr << "paperboat: " << rt << " not pulled (" << ex.what() << "); it is pulled when first used\n";
      }
    }
}

// Unpack a release's `<app>-<version>.tar.gz` (one top folder) over <home>/apps/<app>.
void install_release(const std::string& app, const json& rel) {
  const std::string asset = app + "-" + rel["version"].get<std::string>() + ".tar.gz";
  if (!rel["assets"].contains(asset)) throw Failure(app + " " + rel["version"].get<std::string>() + " has no " + asset + " (" + rel["url"].get<std::string>() + ")");
  const fs::path tgz = paths::home() / "apps" / ("." + asset), fresh = paths::home() / "apps" / ("." + app + ".new");
  std::error_code ec;
  fs::remove_all(fresh, ec);
  fs::create_directories(fresh);
  if (!ProcessRunner::run_sync({"curl", "-fsSL", "-o", tgz.string(), rel["assets"][asset].get<std::string>()}, {}, {}, std::chrono::minutes(10)).ok())
    throw Failure("could not download " + asset);
  const auto x = ProcessRunner::run_sync({"tar", "-xzf", tgz.string(), "-C", fresh.string(), "--strip-components=1"});
  fs::remove(tgz, ec);
  if (!x.ok()) throw Failure("could not unpack " + asset + ": " + x.stderr_text);
  fs::remove_all(app_dir(app), ec);  // a link to a checkout: only the link goes
  fs::rename(fresh, app_dir(app));
}

void write_marker(const std::string& app, const std::string& version, const std::string& from) {
  toml::table t{{"version", version}};
  if (!from.empty()) t.insert("from", from);
  std::ofstream(app_marker(app)) << t << "\n";
}

int app_list(Args& a) {
  json out = json::array();
  const auto running = sessions();
  for (const auto& e : entries(load_toml("apps.toml"), "apps")) {
    const std::string name = e["name"].value_or(std::string());
    // the newest version on the channel; false: none there yet (planned, or only on beta); null: GitHub out of reach
    json available = nullptr;
    try {
      const json rel = newest_release(e["repo"].value_or(std::string()), "", std::chrono::hours(1));
      available = rel.is_null() ? json(false) : rel["version"];
    } catch (const Failure&) {
    }
    json rts = json::array();
    if (const auto* r = e["runtimes"].as_array())
      for (const auto& x : *r) rts.push_back(x.value_or(std::string()));
    out.push_back({{"name", name}, {"label", e["label"].value_or(std::string())},
                   {"description", e["description"].value_or(std::string())}, {"installed", installed(name)},
                   {"sessions", std::ranges::count_if(running, [&](const json& s) { return s["app"] == name; })},
                   {"runtimes", rts}, {"repo", e["repo"].value_or(std::string())}, {"available", available}});
  }
  if (a.json_out) return print_json(out), 0;
  if (out.empty()) return std::cout << "No apps in the registry yet.\n", 0;
  std::vector<std::vector<std::string>> rows;
  for (const auto& x : out) {
    const json& i = x["installed"];
    const std::string state = x["sessions"].get<int>() ? "running" : !i.is_null() ? "installed" : x["available"] == false ? "not on " + channel() : "available";
    const std::string ver = i.is_null() ? "" : !i["from"].get<std::string>().empty() ? "checkout" : i["version"].get<std::string>();
    rows.push_back({x["name"], state, ver, x["description"]});
  }
  print_table({"APP", "STATE", "VERSION", "DESCRIPTION"}, rows);
  return 0;
}

// Linux: each installed app is an app of the desktop (user, 2026-11-26): `paperboat-<app>.desktop` in the user's
// applications folder, so it is found, pinned and shown with its own icon; it opens with `app open <app> --start`
// (its window in the one Launcher). The icon is the app's own file: no icon cache to refresh.
fs::path desktop_entry(const std::string& app) {
  const char* x = std::getenv("XDG_DATA_HOME");
  const char* h = std::getenv("HOME");
  const fs::path data = x && *x ? fs::path(x) : fs::path(h ? h : "") / ".local" / "share";
  return data / "applications" / ("paperboat-" + app + ".desktop");
}

void write_desktop_entry(const std::string& app, const toml::table& e, bool checkout) {
#ifdef __linux__
  std::string icon = "paperboat-launcher";
  for (const fs::path& f : {app_dir(app) / "icon.png", app_dir(app) / "node_modules/@paperboatlab/ui/src/marks" / app / "icon.png"})
    if (fs::exists(f)) { icon = fs::canonical(f).string(); break; }
  const std::string label = e["label"].value_or(app);
  std::error_code ec;
  fs::create_directories(desktop_entry(app).parent_path(), ec);
  std::ofstream(desktop_entry(app)) << "[Desktop Entry]\nType=Application\nName=" << label << (checkout ? " (checkout)" : "")
      << "\nComment=" << e["description"].value_or(std::string()) << "\nExec=\"" << (paths::exe_dir() / "paperboat").string()
      << "\" app open " << app << " --start\nIcon=" << icon << "\nTerminal=false\nCategories=Development;\nStartupWMClass=paperboat-" << app << "\n";
#else
  (void)app, (void)e, (void)checkout;
#endif
}

int app_install(Args& a) {
  const std::string spec = need_arg(a, "app");
  const std::string app = spec.substr(0, spec.find('@'));
  const std::string want = spec.find('@') == std::string::npos ? "" : spec.substr(spec.find('@') + 1);
  const toml::table e = registry_entry(app);
  if (!sessions_of(app).empty()) throw Failure(app + " is running; paperboat app stop " + app + " first", 2);
  fs::create_directories(paths::home() / "apps");
  std::string version, from;
  if (a.has("--from")) {  // a checkout, linked: what you build there is what runs
    std::error_code ec;
    const fs::path dir = fs::canonical(a.get("--from"), ec);
    const std::string launch = e["launch"].value_or(std::string());
    if (ec || !fs::exists(dir / launch)) throw Failure(a.get("--from") + " has no " + launch + ": is it a checkout of " + app + "?", 2);
    fs::remove_all(app_dir(app), ec);
    fs::create_directory_symlink(dir, app_dir(app));
    from = dir.string();
  } else {
    const json rel = newest_release(e["repo"].value_or(std::string()), want);
    if (rel.is_null())
      throw Failure(want.empty() ? app + " has no release on the " + channel() + " channel yet; --from <folder> installs a checkout"
                                 : "no release " + want + " of " + app, 2);
    install_release(app, rel);
    version = rel["version"].get<std::string>();
  }
  write_marker(app, version, from);
  write_desktop_entry(app, e, !from.empty());
  pull_runtimes(a, e);
  if (a.json_out) return print_json({{"name", app}, {"installed", installed(app)}}), 0;
  std::cout << "installed " << app << (from.empty() ? " " + version : " from " + from) << " · paperboat app open " << app << "\n";
  return 0;
}

int app_update(Args& a) {
  const std::string app = need_arg(a, "app");
  const toml::table e = registry_entry(app);
  const json i = installed(app);
  if (i.is_null()) throw Failure(app + " is not installed · paperboat app install " + app, 2);
  if (!i["from"].get<std::string>().empty()) {
    if (a.json_out) return print_json({{"name", app}, {"installed", i}, {"updated", false}}), 0;
    return std::cout << app << " runs your checkout " << i["from"].get<std::string>() << ": update it there\n", 0;
  }
  const json rel = newest_release(e["repo"].value_or(std::string()));
  const bool newer = !rel.is_null() && compare_versions(rel["version"].get<std::string>(), i["version"].get<std::string>()) > 0;
  if (newer) {
    if (!sessions_of(app).empty()) throw Failure(app + " is running; paperboat app stop " + app + " first", 2);
    install_release(app, rel);
    write_marker(app, rel["version"].get<std::string>(), "");
    write_desktop_entry(app, e, false);
  }
  if (a.json_out) return print_json({{"name", app}, {"installed", installed(app)}, {"updated", newer}}), 0;
  std::cout << app << " " << installed(app)["version"].get<std::string>() << (newer ? " installed\n" : " is the newest on " + channel() + "\n");
  return 0;
}

void remove_app(const std::string& app) {
  for (const auto& s : sessions_of(app)) stop_session(s);
  std::error_code ec;
  fs::remove_all(app_dir(app), ec);  // a link to a checkout: only the link goes
  fs::remove(app_marker(app), ec);
  fs::remove(desktop_entry(app), ec);
}

// `--all`: every installed app (what removing the paperboat-cli package runs for each user)
int app_uninstall(Args& a) {
  std::vector<std::string> apps;
  std::error_code ec;
  if (a.has("--all")) {
    for (const auto& f : fs::directory_iterator(paths::home() / "apps", ec))
      if (f.path().extension() == ".toml") apps.push_back(f.path().stem().string());
  } else {
    apps.push_back(need_arg(a, "app"));
    if (installed(apps[0]).is_null()) throw Failure(apps[0] + " is not installed", 2);
  }
  for (const auto& app : apps) remove_app(app);
  if (a.json_out) return print_json({{"removed", apps}}), 0;
  if (apps.empty()) std::cout << "No apps are installed.\n";
  for (const auto& app : apps) std::cout << "removed " << app << "; your projects stay\n";
  return 0;
}

// Open an app on a folder (the current one by default): its running session, or a new one.
int app_open(Args& a) {
  const std::string app = need_arg(a, "app");
  registry_entry(app);
  if (installed(app).is_null()) throw Failure(app + " is not installed · paperboat app install " + app, 2);
  // --start (the desktop's entry): the window it has, else its Start page, on no folder
  const bool start = a.has("--start");
  const fs::path project = start ? fs::path() : fs::absolute(a.arg(1).empty() ? fs::current_path() : fs::path(a.arg(1))).lexically_normal();
  if (!start && !fs::is_directory(project)) throw Failure(project.string() + " is not a folder", 2);
  json s = nullptr;
  for (const auto& x : sessions_of(app))
    if (start || x["project"] == project.string()) s = x;
  const bool fresh = s.is_null();
  if (fresh) s = start_session(app, project, a.has("--port") ? std::stoi(a.get("--port")) : 0);
  if (!a.has("--no-open")) open_url(s["url"], registry_entry(app)["label"].value_or(app));
  if (a.json_out) return print_json(s), 0;
  std::cout << (fresh ? "started " : "running ") << s["id"].get<std::string>() << " on " << (s["project"].get<std::string>().empty() ? "its Start page" : s["project"].get<std::string>()) << " · "
            << s["url"].get<std::string>() << "\n";
  return 0;
}

int app_stop(Args& a) {
  const std::string app = need_arg(a, "app");
  const auto ss = sessions_of(app);
  for (const auto& s : ss) stop_session(s);
  if (a.json_out) return print_json({{"stopped", ss}}), 0;
  std::cout << (ss.empty() ? app + " is not running\n" : "stopped " + app + "\n");
  return 0;
}

int session_list(Args& a) {
  const auto ss = sessions();
  if (a.json_out) return print_json(ss), 0;
  if (ss.empty()) return std::cout << "Nothing is running.\n", 0;
  std::vector<std::vector<std::string>> rows;
  for (const auto& s : ss)
    rows.push_back({s["id"], s["app"], s["url"], fmt_secs(static_cast<double>(std::time(nullptr) - s["started"].get<std::time_t>())),
                    s["project"]});
  print_table({"SESSION", "APP", "URL", "UP", "FOLDER"}, rows);
  return 0;
}

// The last lines, then follows (tail -F); --json: the last lines only.
int session_logs(Args& a) {
  const std::string id = need_arg(a, "session");
  const fs::path log = sessions_dir() / (id + ".log");
  if (!fs::exists(log)) throw Failure("no session named " + id + "; paperboat session list shows them", 2);
  const std::string n = a.get("--tail", "200");
  if (a.json_out) return print_json({{"id", id}, {"text", tail(log, std::stoul(n))}}), 0;
  ::execlp("tail", "tail", "-n", n.c_str(), "-F", log.c_str(), static_cast<char*>(nullptr));
  throw Failure(std::string("tail could not start: ") + std::strerror(errno));
}

int session_restart(Args& a) {
  const json old = find_session(need_arg(a, "session"));
  stop_session(old);
  const json s = start_session(old["app"], old["project"].get<std::string>(), old["port"].get<int>());
  if (a.json_out) return print_json(s), 0;
  std::cout << "restarted " << s["id"].get<std::string>() << " · " << s["url"].get<std::string>() << "\n";
  return 0;
}

int session_stop(Args& a) {
  std::vector<json> ss;
  if (a.has("--all")) ss = sessions();
  else ss.push_back(find_session(need_arg(a, "session")));
  for (const auto& s : ss) stop_session(s);
  if (a.json_out) return print_json({{"stopped", ss}}), 0;
  if (ss.empty()) std::cout << "Nothing is running.\n";
  for (const auto& s : ss) std::cout << "stopped " << s["id"].get<std::string>() << "\n";
  return 0;
}

int toolkit_list(Args& a) {
  // base is built into Simplicial; the others are plugins Simplicial's `toolkit install` puts in <home>/toolkits/<name>
  const bool simplicial = !installed("simplicial").is_null();
  json out = json::array();
  for (const auto& e : entries(load_toml("toolkits.toml"), "toolkits")) {
    const std::string name = e["name"].value_or(std::string()), kind = e["kind"].value_or(std::string());
    std::error_code ec;
    out.push_back({{"name", name}, {"kind", kind}, {"repo", e["repo"].value_or(std::string())}, {"description", e["description"].value_or(std::string())},
                   {"installed", simplicial && (kind == "base" || fs::is_directory(paths::home() / "toolkits" / name, ec))}});
  }
  if (a.json_out) return print_json(out), 0;
  std::vector<std::vector<std::string>> rows;
  for (const auto& x : out) rows.push_back({x["name"], x["kind"], x["installed"].get<bool>() ? "installed" : "available", x["description"]});
  print_table({"TOOLKIT", "KIND", "STATE", "DESCRIPTION"}, rows);
  if (!simplicial) std::cout << "\nToolkits install into Simplicial, which isn't installed yet.\n";
  return 0;
}

int runtime_list(Args& a) {
  ControlClient& c = daemon(a);
  const json r = c.call("runtimes.list");
  if (a.json_out) return print_json(r), 0;
  const json ps = c.call("ps");
  std::vector<std::vector<std::string>> rows;
  for (const auto& rt : r["runtimes"]) {
    std::string modes, where;
    for (const auto& m : rt["modes"]) modes += (modes.empty() ? "" : ",") + m.get<std::string>();
    for (const auto& [b, s] : rt["backends"].items())
      if (!s["usable"].get<bool>()) continue;
      else if (s["ready"].get<bool>()) where += (where.empty() ? "" : " ") + b;
      else if (b != "native") where += (where.empty() ? "" : " ") + b + " (pulls when needed)";  // natively: its tool isn't on PATH
    const auto running = std::ranges::count_if(ps, [&](const json& l) { return l["runtime"] == rt["id"]; });
    rows.push_back({rt["id"], modes, where.empty() ? "-" : where, running ? std::to_string(running) + " running" : ""});
  }
  print_table({"RUNTIME", "MODES", "WHERE", "RUNNING"}, rows);
  std::cout << "\n";
  for (const auto& b : r["backends"])
    std::cout << (b["available"].get<bool>() ? "✓ " : "  ") << b["name"].get<std::string>() << "  " << b["detail"].get<std::string>()
              << (b["rootless"].get<bool>() ? ", rootless" : "") << (b["selinux"].get<bool>() ? ", SELinux" : "") << "\n";
  for (const auto& e : r["errors"]) std::cerr << "skipped: " << e.get<std::string>() << "\n";
  return 0;
}

int runtime_pull(Args& a) {
  if (a.arg(0).empty()) throw Failure("which runtime? paperboat runtime pull <runtime>", 2);
  ControlClient& c = daemon(a);
  if (!a.json_out) c.on_event = [](const json& e) {
    if (e["event"] == "pull.progress") std::cerr << e["line"].get<std::string>() << "\n";
    return true;
  };
  json args = {{"runtime", a.arg(0)}};
  if (a.has("--backend")) args["backend"] = a.get("--backend");
  const json r = c.call("pull", args);
  if (a.json_out) return print_json(r), 0;
  std::cout << "pulled " << r["runtime"].get<std::string>() << " (" << r["image"].get<std::string>() << ")\n";
  return 0;
}

int runtime_ps(Args& a) {
  const json r = daemon(a).call("ps");
  if (a.json_out) return print_json(r), 0;
  if (r.empty()) return std::cout << "Nothing is running.\n", 0;
  std::vector<std::vector<std::string>> rows;
  for (const auto& l : r)
    rows.push_back({l["id"], l["runtime"], l["mode"] == "session" ? "kernel" : l["mode"].get<std::string>(), l["backend"], l["state"],
                    l["owner"], fmt_secs(l["uptime_s"].get<double>())});
  print_table({"INSTANCE", "RUNTIME", "KIND", "BACKEND", "STATE", "HELD BY", "UP"}, rows);
  return 0;
}

int runtime_stats(Args& a) {
  const json r = daemon(a).call("stats", {{"lease", a.arg(0)}});
  if (a.json_out) return print_json(r), 0;
  const auto& s = r["stats"];
  std::printf("cpu %.1f%%  memory %s  processes %lld\n", s["cpu_percent"].get<double>(), fmt_bytes(s["memory_bytes"].get<long long>()).c_str(),
              s["pids"].get<long long>());
  return 0;
}

int runtime_logs(Args& a) {
  const json r = daemon(a).call("logs", {{"lease", a.arg(0)}, {"tail", std::stoi(a.get("--tail", "200"))}});
  if (a.json_out) return print_json(r), 0;
  std::cout << r["text"].get<std::string>();
  return 0;
}

int runtime_interrupt(Args& a) {
  if (a.arg(0).empty()) throw Failure("which kernel? paperboat runtime interrupt <kernel> (runtime ps shows them)", 2);
  const json r = daemon(a).call("interrupt", {{"lease", a.arg(0)}});
  if (a.json_out) return print_json(r), 0;
  if (!r.value("delivered", false)) throw Failure(a.arg(0) + " is not running");
  std::cout << "interrupted " << a.arg(0) << "\n";
  return 0;
}

int runtime_prune(Args& a) {
  const json r = daemon(a).call("prune", {{"dry_run", a.has("--dry-run")}});
  if (a.json_out) return print_json(r), 0;
  for (const auto& x : r["removed"])
    std::cout << (a.has("--dry-run") ? "would remove " : "removed ") << x["path"].get<std::string>() << " (" << x["project"].get<std::string>()
              << " is gone)\n";
  if (r["removed"].empty()) std::cout << "Nothing to remove.\n";
  return 0;
}

int runtime_events(Args& a) {
  ControlClient& c = daemon(a);
  c.call("subscribe");
  c.on_event = [&](const json& e) {
    if (a.json_out) std::cout << e.dump() << std::endl;
    else std::cout << e["event"].get<std::string>() << "  " << e.dump() << std::endl;
    return true;
  };
  c.listen();
  return 0;
}

// ── packages: Julia's Pkg in the project, a venv or omc's libraries in the project's package volume ──

std::string language(const std::string& runtime) {
  const std::string name = runtime.substr(0, runtime.find('@'));
  if (name == "julia" || name == "python" || name == "omc") return name;
  throw Failure("packages are for the julia, python and omc runtimes, not " + name, 2);
}

// "Plots@1.40" -> ("Plots", "1.40")
std::pair<std::string, std::string> spec(const std::string& s) {
  const auto at = s.find('@');
  return at == std::string::npos ? std::pair{s, std::string()} : std::pair{s.substr(0, at), s.substr(at + 1)};
}

// Package names and versions go into a script: allow only what package names use.
bool safe_name(const std::string& s) {
  return !s.empty() && std::ranges::all_of(s, [](char ch) {
    return std::isalnum(static_cast<unsigned char>(ch)) || std::string("._-+").find(ch) != std::string::npos;
  });
}

int packages(Args& a, const std::string& op) {
  const std::string runtime = a.arg(0);
  if (runtime.empty() || !a.has("--project")) throw Failure("usage: paperboat " + a.cmd->name + " " + a.cmd->args, 2);
  const fs::path project = fs::absolute(a.get("--project"));
  if (!fs::is_directory(project)) throw Failure("no project folder " + project.string(), 2);
  const std::string lang = language(runtime);
  std::string name, version;
  if (op != "list") {
    std::tie(name, version) = spec(a.arg(1));
    if (!safe_name(name) || (!version.empty() && !safe_name(version))) throw Failure("which package? paperboat " + a.cmd->name + " " + a.cmd->args, 2);
  }
  json policy = json::object();
  std::vector<std::string> cmd;
  if (lang == "julia") {
    // the project's Project.toml/Manifest.toml change, so the project is writable for add and remove
    std::string body = "import Pkg; Pkg.activate(ENV[\"PAPERBOAT_PROJECT\"]; io=devnull); ";
    if (op == "add") {
      body += "Pkg.add(Pkg.PackageSpec(name=\"" + name + "\"" + (version.empty() ? "" : ", version=\"" + version + "\"") + ")); ";
      policy = {{"network", true}, {"writable_project", true}};
    } else if (op == "remove") {
      body += "Pkg.offline(true); Pkg.rm(\"" + name + "\"); ";
      policy = {{"writable_project", true}};
    }
    body += "for p in values(Pkg.dependencies()); p.is_direct_dep && println(\"PKG \", p.name, \" \", something(p.version, \"\")); end";
    cmd = {"julia", "--startup-file=no", "-e", body};
  } else if (lang == "omc") {
    // Modelica libraries: omc's package manager into ~/.openmodelica/libraries (HOME is the package
    // volume in the image; natively the user's own). omc can't uninstall: remove deletes the folders.
    std::string body = "L=\"$HOME/.openmodelica/libraries\"; ";
    if (op == "add") {
      body += "printf '%s\\n' 'if not installPackage(" + name + ", \"" + version + "\", exactMatch=" + (version.empty() ? "false" : "true") +
              ") then print(getErrorString()); exit(1); end if;' > /tmp/pb-add.mos && omc /tmp/pb-add.mos || exit 1; ";
      policy = {{"network", true}};
    } else if (op == "remove") {
      const std::string glob = "\"$L/" + name + " " + version + "\"*";
      body += "ls -d " + glob + " >/dev/null 2>&1 || { echo 'no " + name + (version.empty() ? "" : " " + version) + " installed'; exit 1; }; rm -rf " + glob + " || exit 1; ";
    }
    body += "[ -d \"$L\" ] && for d in \"$L\"/*/; do d=${d%/}; d=${d##*/}; echo \"PKG ${d%% *} ${d#* }\"; done; exit 0";
    cmd = {"sh", "-c", body};
  } else {
    // a venv in the project's package volume, made inside the image so wheels match its libc
    std::string body = "V=\"$PAPERBOAT_DEPS/venv\"; ";
    if (op == "add") {
      body += "[ -x \"$V/bin/python\" ] || python3 -m venv \"$V\" || exit 1; \"$V/bin/python\" -m pip install --disable-pip-version-check -q \"" +
              name + (version.empty() ? "" : "==" + version) + "\" || exit 1; ";
      policy = {{"network", true}};
    } else if (op == "remove") {
      body += "\"$V/bin/python\" -m pip uninstall -y -q \"" + name + "\" || exit 1; ";
    }
    body += "[ -x \"$V/bin/python\" ] && \"$V/bin/python\" -m pip list --not-required --format freeze --disable-pip-version-check | grep -v -i -E '^(pip|setuptools|wheel)==' | sed 's/^/PKG /;s/==/ /'; exit 0";
    cmd = {"sh", "-c", body};
  }
  if (!a.json_out && op != "list")
    std::cerr << (op == "add" ? "adding " : "removing ") << a.arg(1) << (op == "add" ? " to " : " from ") << project.string() << " (" << runtime
              << (op == "add" ? ", network allowed for this step" : "") << ")…\n";
  json args = {{"runtime", runtime}, {"project", project.string()}, {"command", cmd}, {"policy", policy}};
  if (a.has("--backend")) args["backend"] = a.get("--backend");
  const auto [code, out] = run_in(a, args);
  if (code != 0) throw Failure("paperboat " + a.cmd->name + " failed (exit " + std::to_string(code) + "):\n" + (out.size() > 1500 ? out.substr(out.size() - 1500) : out));
  json pkgs = json::array();
  std::istringstream in(out);
  for (std::string line; std::getline(in, line);)
    if (line.starts_with("PKG ")) {
      std::istringstream l(line.substr(4));
      std::string n, v;
      l >> n >> v;
      pkgs.push_back({{"name", n}, {"version", v}});
    }
  if (a.json_out) return print_json({{"runtime", runtime}, {"project", project.string()}, {"packages", pkgs}}), 0;
  if (pkgs.empty()) return std::cout << "No packages in " << project.string() << ".\n", 0;
  std::vector<std::vector<std::string>> rows;
  for (const auto& p : pkgs) rows.push_back({p["name"], p["version"]});
  print_table({"PACKAGE", "VERSION"}, rows);
  return 0;
}

// ── Paperboat ──

int paperboat_channel(Args& a) {
  const std::string want = a.arg(0);
  if (!want.empty()) {
    if (want != "release" && want != "beta" && want != "dev") throw Failure("a channel is release, beta or dev", 2);
    fs::create_directories(config_file().parent_path());
    std::ofstream(config_file()) << "channel = \"" << want << "\"\n";
  }
  if (a.json_out) return print_json({{"channel", channel()}}), 0;
  std::cout << channel() << "\n";
  return 0;
}

int paperboat_update(Args& a) {
  // Releases are packages (rpm, pkg): the package manager installs them; this finds the newest.
  const std::string ch = channel();
  const json newest = ch == "dev" ? json(nullptr) : newest_release("paperboatlab/paperboat");
  const bool behind = !newest.is_null() && compare_versions(newest["version"].get<std::string>(), PAPERBOAT_VERSION) > 0;
  if (a.json_out) return print_json({{"channel", ch}, {"current", PAPERBOAT_VERSION}, {"newest", newest}, {"update", behind}}), 0;
  if (ch == "dev") return std::cout << "The dev channel builds from main: update your checkout.\n", 0;
  if (newest.is_null()) return std::cout << "No releases on the " << ch << " channel yet.\n", 0;
  if (!behind) return std::cout << "Paperboat " << PAPERBOAT_VERSION << " is the newest on " << ch << ".\n", 0;
  std::cout << "Paperboat " << newest["version"].get<std::string>() << " is out (you have " << PAPERBOAT_VERSION << "): "
            << newest["url"].get<std::string>() << "\n";
  if (!a.has("--check")) std::cout << "Install it with your package manager (dnf install ./paperboat-cli-….rpm) or the macOS installer.\n";
  return 0;
}

int paperboat_about(Args& a) {
  json about = {{"paperboat", PAPERBOAT_VERSION}, {"channel", channel()}, {"daemon", nullptr}, {"home", paths::home().string()}, {"apps", json::array()}, {"toolkits", json::array()}};
  try {
    ControlClient c(a.socket, false);
    const json h = c.call("hello");
    about["daemon"] = {{"version", h["version"]}, {"pid", h["pid"]}, {"runtimes", c.call("runtimes.list")["runtimes"].size()}};
  } catch (const ControlError&) {
  }
  for (const auto& e : entries(load_toml("apps.toml"), "apps"))
    if (json i = installed(e["name"].value_or(std::string())); !i.is_null()) about["apps"].push_back({{"name", e["name"].value_or(std::string())}, {"version", i["version"]}, {"from", i["from"]}});
  if (a.json_out) return print_json(about), 0;
  std::cout << "paperboat " << PAPERBOAT_VERSION << " (" << channel() << ")\n";
  if (about["daemon"].is_null()) std::cout << "paperboatd not running (it starts when needed)\n";
  else std::cout << "paperboatd " << about["daemon"]["version"].get<std::string>() << ", " << about["daemon"]["runtimes"].get<std::size_t>() << " runtimes\n";
  std::cout << "apps:";
  for (const auto& x : about["apps"]) std::cout << " " << x["name"].get<std::string>() << " " << (x["from"].get<std::string>().empty() ? x["version"].get<std::string>() : "(checkout)");
  std::cout << (about["apps"].empty() ? " none installed\n" : "\n") << "toolkits: none installed\n";
  return 0;
}

int paperboat_daemon(Args& a) {
  const std::string sub = a.arg(0).empty() ? "status" : a.arg(0);
  if (sub == "status") {
    try {
      ControlClient c(a.socket, false);
      const json r = c.call("hello");
      if (a.json_out) return print_json(r), 0;
      std::cout << "paperboatd " << r["version"].get<std::string>() << " (pid " << r["pid"] << ") on " << a.socket.string() << "\n";
      return 0;
    } catch (const ControlError&) {
      if (a.json_out) return print_json({{"running", false}}), 1;
      std::cout << "paperboatd is not running (it starts when needed)\n";
      return 1;
    }
  }
  if (sub == "stop") {
    try {
      ControlClient c(a.socket, false);
      c.call("shutdown");
    } catch (const ControlError&) {
    }
    return 0;
  }
  throw Failure("paperboat daemon status|stop", 2);
}

int paperboat_help(Args& a) {
  const auto& reg = registry();
  if (!a.pos.empty()) {   // help <command words>
    std::string q;
    for (const auto& w : a.pos) q += (q.empty() ? "" : " ") + w;
    for (const auto& c : reg)
      if (c.name == q || std::ranges::find(c.alias, q) != c.alias.end()) {
        if (a.json_out) return print_json({{"id", c.id}, {"name", c.name}, {"args", c.args}, {"desc", c.desc}, {"app", app_of(c)}, {"alias", c.alias}}), 0;
        std::cout << "paperboat " << c.name << (c.args.empty() ? "" : " " + c.args) << "\n  " << c.desc << "\n";
        if (!c.alias.empty()) std::cout << "  also: paperboat " << c.alias[0] << "\n";
        if (!c.exec.empty()) std::cout << "  from " << app_of(c) << "\n";
        return 0;
      }
    throw Failure("no command '" + q + "' · paperboat help lists them", 2);
  }
  if (a.json_out) {
    json out = json::array();
    for (const auto& c : reg)
      out.push_back({{"id", c.id}, {"name", c.name}, {"args", c.args}, {"desc", c.desc}, {"group", c.group}, {"app", app_of(c)},
                     {"alias", c.alias}, {"tui", c.tui}});
    return print_json(out), 0;
  }
  std::cout << "usage: paperboat <command> [--json]\n";
  std::string group;
  for (const auto& c : reg) {
    if (c.tui) continue;
    if (c.group != group) std::cout << "\n" << (group = c.group) << "\n";
    const std::string usage = c.name + (c.args.empty() ? "" : " " + c.args);
    if (usage.size() < 56) std::cout << "  " << usage << std::string(56 - usage.size(), ' ') << c.desc << "\n";
    else std::cout << "  " << usage << "\n  " << std::string(56, ' ') << c.desc << "\n";
  }
  return 0;
}

// The terminal UI (apps/cli, bundled to share/paperboat/cli/main.js; dist/main.js in a checkout's
// build): exec node on it with PAPERBOAT_BIN set. Returns only when it can't run: then the help.
void launch_tui() {
  if (!::isatty(0) || !::isatty(1) || std::getenv("PAPERBOAT_NO_TUI")) return;
  fs::path script;
  if (const char* env = std::getenv("PAPERBOAT_TUI"); env && *env) script = env;
  else
    for (const fs::path& p : {paths::exe_dir().parent_path() / "share" / "paperboat" / "cli" / "main.js",
                              paths::exe_dir().parent_path() / "apps" / "cli" / "dist" / "main.js"})
      if (fs::is_regular_file(p)) {
        script = p;
        break;
      }
  if (script.empty() || !fs::is_regular_file(script)) return;
  const std::string self = (paths::exe_dir() / "paperboat").string();
  ::setenv("PAPERBOAT_BIN", self.c_str(), 1);
  std::string node = "node", path = script.string();
  char* argv[] = {node.data(), path.data(), nullptr};
  ::execvp("node", argv);
  std::cerr << "paperboat: the terminal UI needs node (22 or newer) on PATH; the commands:\n\n";
}

const std::map<std::string, Handler>& handlers() {
  static const std::map<std::string, Handler> h = {
      {"app.list", app_list}, {"app.open", app_open}, {"app.install", app_install}, {"app.update", app_update},
      {"app.uninstall", app_uninstall}, {"app.stop", app_stop}, {"session.list", session_list}, {"session.logs", session_logs},
      {"session.restart", session_restart}, {"session.stop", session_stop}, {"toolkit.list", toolkit_list},
      {"runtime.list", runtime_list}, {"runtime.pull", runtime_pull}, {"runtime.ps", runtime_ps}, {"runtime.stats", runtime_stats},
      {"runtime.logs", runtime_logs}, {"runtime.interrupt", runtime_interrupt}, {"runtime.prune", runtime_prune},
      {"runtime.events", runtime_events}, {"package.list", [](Args& a) { return packages(a, "list"); }},
      {"package.add", [](Args& a) { return packages(a, "add"); }}, {"package.remove", [](Args& a) { return packages(a, "remove"); }},
      {"paperboat.update", paperboat_update}, {"paperboat.channel", paperboat_channel}, {"paperboat.daemon", paperboat_daemon},
      {"paperboat.about", paperboat_about}, {"paperboat.help", paperboat_help}};
  return h;
}

}  // namespace

int main(int argc, char** argv) {
  Args a = parse(argc, argv);
  try {
    if (a.has("--version")) {
      std::cout << "paperboat " << PAPERBOAT_VERSION << "\n";
      return 0;
    }
    if (!a.cmd) {
      if (a.pos.empty() && !a.json_out) {  // no command: the TUI on a terminal, else the help
        launch_tui();
        a.cmd = find_id("paperboat.help");
        return paperboat_help(a);
      }
      throw unknown_command(a.pos);
    }
    if (a.has("--help")) {
      a.pos = words(a.cmd->name);
      return paperboat_help(a);
    }
    if (!a.cmd->exec.empty()) return run_app_command(*a.cmd, a.raw);
    const auto it = handlers().find(a.cmd->id);
    if (it == handlers().end()) throw Failure("paperboat " + a.cmd->name + " is not in this build", 2);
    return it->second(a);
  } catch (const Failure& f) {
    if (a.json_out) {
      json e = f.extra;
      e["error"] = f.what();
      print_json(e);
    } else {
      std::cerr << "paperboat: " << f.what() << "\n";
    }
    return f.code;
  } catch (const std::exception& e) {
    if (a.json_out) print_json({{"error", e.what()}});
    else std::cerr << "paperboat: " << e.what() << "\n";
    return 1;
  }
}
