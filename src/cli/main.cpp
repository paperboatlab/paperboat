// paperboat: the CLI. Every command is an entry in the registry (commands.toml, embedded at build
// time): dispatch, usage and `help` all read it, and so do the Launcher and the TUI (through
// @paperboat/client). Runtime commands are paperboat-control/0 requests to paperboatd (started on
// demand); with --json the CLI prints the daemon's objects unchanged, for scripts and the front ends.

#include "paperboat/control.hpp"
#include "paperboat/manifest.hpp"
#include "paperboat/paths.hpp"
#include "paperboat/process.hpp"

#include <nlohmann/json.hpp>
#include <toml++/toml.hpp>

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iomanip>
#include <iostream>
#include <map>
#include <memory>
#include <sstream>
#include <string>
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
  std::string id, name, args, desc, group, needs;
  std::vector<std::string> alias;
  bool tui = false;
};

std::vector<std::string> words(const std::string& s) {
  std::vector<std::string> out;
  std::istringstream in(s);
  for (std::string w; in >> w;) out.push_back(w);
  return out;
}

const std::vector<Command>& registry() {
  static const std::vector<Command> reg = [] {
    std::vector<Command> out;
    const toml::table t = toml::parse(kCommandsToml);
    for (const auto& node : *t["command"].as_array()) {
      const auto& c = *node.as_table();
      Command cmd;
      cmd.id = c["id"].value_or(std::string());
      cmd.name = c["name"].value_or(std::string());
      cmd.args = c["args"].value_or(std::string());
      cmd.desc = c["desc"].value_or(std::string());
      cmd.group = c["group"].value_or(std::string());
      cmd.needs = c["needs"].value_or(std::string());
      cmd.tui = c["tui"].value_or(false);
      if (const auto* a = c["alias"].as_array())
        for (const auto& x : *a) cmd.alias.push_back(*x.value<std::string>());
      out.push_back(std::move(cmd));
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

const std::vector<std::string> kValued = {"--project", "--backend", "--socket", "--tail", "--source", "--kind", "--port", "--time", "--var"};

// The longest registered name (or alias) the words start with; the rest are its arguments.
Args parse(int argc, char** argv) {
  Args a;
  std::vector<std::string> plain;
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

fs::path data_file(const std::string& name) {
  for (const fs::path& d : {paths::exe_dir().parent_path() / "share" / "paperboat", paths::exe_dir()})
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

// What `needs` names, when it is installed: an app's install marker. None is installable yet, so a
// command that needs one says so.
bool installed(const std::string& what) { return fs::exists(paths::home() / "apps" / what / ".installed"); }

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

int app_list(Args& a) {
  json out = json::array();
  for (const auto& e : entries(load_toml("apps.toml"), "apps"))
    out.push_back({{"name", e["name"].value_or(std::string())}, {"label", e["label"].value_or(std::string())},
                   {"description", e["description"].value_or(std::string())},
                   {"installed", installed(e["name"].value_or(std::string()))}});
  if (a.json_out) return print_json(out), 0;
  if (out.empty()) return std::cout << "No apps in the registry yet.\n", 0;
  std::vector<std::vector<std::string>> rows;
  for (const auto& x : out) rows.push_back({x["name"], x["installed"].get<bool>() ? "installed" : "available", x["description"]});
  print_table({"APP", "STATE", "DESCRIPTION"}, rows);
  return 0;
}

int app_one(Args& a) {
  const std::string name = a.arg(0);
  if (name.empty()) throw Failure("which app? paperboat " + a.cmd->name + " " + a.cmd->args, 2);
  const auto apps = entries(load_toml("apps.toml"), "apps");
  const std::string bare = name.substr(0, name.find('@'));
  const bool known = std::ranges::any_of(apps, [&](const toml::table& e) { return e["name"].value_or(std::string()) == bare; });
  if (!known) throw Failure("no app named " + bare + " in the registry" + (apps.empty() ? " (it has none yet)" : "; paperboat app list shows them"), 2);
  throw Failure("paperboat " + a.cmd->name + " arrives with the first app in the registry", 2);
}

int session_list(Args& a) {
  // Sessions are apps and stations running; with no app installed, nothing can be.
  if (a.json_out) return print_json(json::array()), 0;
  std::cout << "Nothing is running.\n";
  return 0;
}

int session_one(Args& a) {
  if (a.has("--all")) return a.json_out ? (print_json(json::object()), 0) : (std::cout << "Nothing is running.\n", 0);
  throw Failure("no session named " + (a.arg(0).empty() ? std::string("<session>") : a.arg(0)) + "; paperboat session list shows them", 2);
}

int toolkit_list(Args& a) {
  json out = json::array();
  for (const auto& e : entries(load_toml("toolkits.toml"), "toolkits"))
    out.push_back({{"name", e["name"].value_or(std::string())}, {"kind", e["kind"].value_or(std::string())},
                   {"repo", e["repo"].value_or(std::string())}, {"description", e["description"].value_or(std::string())},
                   {"installed", false}});
  if (a.json_out) return print_json(out), 0;
  std::vector<std::vector<std::string>> rows;
  for (const auto& x : out) rows.push_back({x["name"], x["kind"], "available", x["description"]});
  print_table({"TOOLKIT", "KIND", "STATE", "DESCRIPTION"}, rows);
  std::cout << "\nToolkits install into Simplicial, which isn't installed yet.\n";
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

// ── packages: Julia's Pkg in the project, or a venv in the project's package volume ──

bool is_julia(const std::string& runtime) {
  const std::string name = runtime.substr(0, runtime.find('@'));
  if (name == "julia") return true;
  if (name == "python") return false;
  throw Failure("packages are for the julia and python runtimes, not " + name, 2);
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
  const bool julia = is_julia(runtime);
  std::string name, version;
  if (op != "list") {
    std::tie(name, version) = spec(a.arg(1));
    if (!safe_name(name) || (!version.empty() && !safe_name(version))) throw Failure("which package? paperboat " + a.cmd->name + " " + a.cmd->args, 2);
  }
  json policy = json::object();
  std::vector<std::string> cmd;
  if (julia) {
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
  json newest = nullptr;
  if (ch != "dev") {
    const auto r = ProcessRunner::run_sync({"curl", "-fsSL", "-H", "Accept: application/vnd.github+json",
                                            "https://api.github.com/repos/paperboatlab/paperboat/releases?per_page=30"},
                                           {}, {}, std::chrono::seconds(20));
    if (!r.ok()) throw Failure("could not reach GitHub to check for updates");
    for (const auto& rel : json::parse(r.stdout_text)) {
      if (rel.value("draft", false) || (ch == "release" && rel.value("prerelease", false))) continue;
      std::string tag = rel.value("tag_name", std::string());
      if (tag.starts_with('v')) tag.erase(0, 1);
      if (newest.is_null() || compare_versions(tag, newest["version"].get<std::string>()) > 0)
        newest = {{"version", tag}, {"url", rel.value("html_url", std::string())}};
    }
  }
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
  json about = {{"paperboat", PAPERBOAT_VERSION}, {"channel", channel()}, {"daemon", nullptr}, {"apps", json::array()}, {"toolkits", json::array()}};
  try {
    ControlClient c(a.socket, false);
    const json h = c.call("hello");
    about["daemon"] = {{"version", h["version"]}, {"pid", h["pid"]}, {"runtimes", c.call("runtimes.list")["runtimes"].size()}};
  } catch (const ControlError&) {
  }
  if (a.json_out) return print_json(about), 0;
  std::cout << "paperboat " << PAPERBOAT_VERSION << " (" << channel() << ")\n";
  if (about["daemon"].is_null()) std::cout << "paperboatd not running (it starts when needed)\n";
  else std::cout << "paperboatd " << about["daemon"]["version"].get<std::string>() << ", " << about["daemon"]["runtimes"].get<std::size_t>() << " runtimes\n";
  std::cout << "apps: none installed\ntoolkits: none installed\n";
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
        if (a.json_out) return print_json({{"id", c.id}, {"name", c.name}, {"args", c.args}, {"desc", c.desc}, {"needs", c.needs}, {"alias", c.alias}}), 0;
        std::cout << "paperboat " << c.name << (c.args.empty() ? "" : " " + c.args) << "\n  " << c.desc << "\n";
        if (!c.alias.empty()) std::cout << "  also: paperboat " << c.alias[0] << "\n";
        if (!c.needs.empty()) std::cout << "  needs " << c.needs << " installed\n";
        return 0;
      }
    throw Failure("no command '" + q + "' · paperboat help lists them", 2);
  }
  if (a.json_out) {
    json out = json::array();
    for (const auto& c : reg)
      out.push_back({{"id", c.id}, {"name", c.name}, {"args", c.args}, {"desc", c.desc}, {"group", c.group}, {"needs", c.needs},
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

const std::map<std::string, Handler>& handlers() {
  static const std::map<std::string, Handler> h = {
      {"app.list", app_list}, {"app.open", app_one}, {"app.install", app_one}, {"app.update", app_one},
      {"app.uninstall", app_one}, {"app.stop", app_one}, {"session.list", session_list}, {"session.logs", session_one},
      {"session.restart", session_one}, {"session.stop", session_one}, {"toolkit.list", toolkit_list},
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
      if (a.pos.empty()) {  // no command: the help (the TUI takes this over on a terminal, phase 3)
        a.cmd = find_id("paperboat.help");
        return paperboat_help(a);
      }
      throw Failure("no command '" + a.pos[0] + "' · paperboat help lists them", 2);
    }
    if (a.has("--help")) {
      a.pos = words(a.cmd->name);
      return paperboat_help(a);
    }
    if (!a.cmd->needs.empty() && !installed(a.cmd->needs)) {
      const std::string what = a.cmd->needs == "simplicial" ? "Simplicial" : a.cmd->needs;
      throw Failure("paperboat " + a.cmd->name + " needs " + what + ", which isn't installed yet", 2, {{"needs", a.cmd->needs}});
    }
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
