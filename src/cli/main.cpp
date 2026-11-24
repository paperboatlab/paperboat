// paperboat: the CLI. Every runtime command is a paperboat-control/0 request to paperboatd (started on
// demand); with --json the CLI prints the daemon's objects unchanged, for scripts and the Launcher.

#include "paperboat/control.hpp"
#include "paperboat/paths.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <csignal>
#include <map>
#include <cstdio>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#ifndef PAPERBOAT_VERSION
#define PAPERBOAT_VERSION "0.0.0-dev"
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;
using namespace paperboat;

namespace {

const char* kUsage = R"(usage: paperboat <command> [options]

runtimes list                      the runtimes this host knows, and where each can run
runtimes backends                  podman, docker, native: available or why not
runtimes ps                        running leases
runtimes pull <runtime>            fetch a runtime's pinned image (julia, julia@1.11, ...)
runtimes run <runtime> [-- cmd]    start a runtime; with a command (exec mode) wait for it and
                                   print its output; else hold it until Ctrl-C
    --mode station|session|exec    (default: exec with a command, else station)
    --project DIR  --backend NAME  --network  --allow-unpinned
runtimes logs <lease> [--tail N]   a lease's output
runtimes stats <lease>             CPU, memory, processes
runtimes events                    follow runtime.* events
runtimes prune [--dry-run]         remove dependency volumes of projects that are gone
daemon status | stop               the paperboatd serving this user

global: --json (machine-readable output), --socket PATH, --version
)";

struct Args {
  std::vector<std::string> pos, command;
  std::map<std::string, std::string> opt;
  bool json_out = false;
  bool has(const std::string& k) const { return opt.contains(k); }
  std::string get(const std::string& k, const std::string& d = "") const {
    const auto it = opt.find(k);
    return it == opt.end() ? d : it->second;
  }
};

Args parse(int argc, char** argv) {
  static const std::vector<std::string> valued = {"--mode", "--project", "--backend", "--tail", "--socket"};
  Args a;
  for (int i = 1; i < argc; ++i) {
    const std::string s = argv[i];
    if (s == "--") {
      for (++i; i < argc; ++i) a.command.emplace_back(argv[i]);
      break;
    }
    if (s == "--json") a.json_out = true;
    else if (std::ranges::find(valued, s) != valued.end() && i + 1 < argc) a.opt[s] = argv[++i];
    else if (s.starts_with("--")) a.opt[s] = "1";
    else a.pos.push_back(s);
  }
  return a;
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

void print_json(const json& j) { std::cout << j.dump(2) << "\n"; }

int cmd_runtimes(ControlClient& c, const Args& a) {
  const std::string sub = a.pos.size() > 1 ? a.pos[1] : "list";
  const std::string arg = a.pos.size() > 2 ? a.pos[2] : "";

  if (sub == "list") {
    const json r = c.call("runtimes.list");
    if (a.json_out) return print_json(r), 0;
    std::printf("%-22s %-10s %-24s %s\n", "RUNTIME", "MODES", "WHERE", "IMAGE");
    for (const auto& rt : r["runtimes"]) {
      std::string modes, where;
      for (const auto& m : rt["modes"]) modes += (modes.empty() ? "" : ",") + m.get<std::string>();
      for (const auto& [b, s] : rt["backends"].items())
        if (s["usable"].get<bool>()) where += (where.empty() ? "" : " ") + b + (s["ready"].get<bool>() ? "" : "(pull)");
      std::string image = rt["image"]["ref"].get<std::string>();
      if (!rt["pinned"].get<bool>() && !image.empty()) image += "  UNPINNED";
      std::printf("%-22s %-10s %-24s %s\n", rt["id"].get<std::string>().c_str(), modes.c_str(),
                  where.empty() ? "-" : where.c_str(), image.c_str());
    }
    for (const auto& e : r["errors"]) std::fprintf(stderr, "skipped: %s\n", e.get<std::string>().c_str());
    return 0;
  }
  if (sub == "backends") {
    const json r = c.call("backends");
    if (a.json_out) return print_json(r), 0;
    for (const auto& b : r)
      std::printf("%-8s %-4s %s%s%s\n", b["name"].get<std::string>().c_str(), b["available"].get<bool>() ? "yes" : "no",
                  b["detail"].get<std::string>().c_str(), b["rootless"].get<bool>() ? ", rootless" : "",
                  b["selinux"].get<bool>() ? ", SELinux" : "");
    return 0;
  }
  if (sub == "ps") {
    const json r = c.call("ps");
    if (a.json_out) return print_json(r), 0;
    std::printf("%-12s %-20s %-8s %-8s %-8s %-12s %-6s %s\n", "LEASE", "RUNTIME", "MODE", "BACKEND", "STATE", "OWNER", "UP",
                "INSTANCE");
    for (const auto& l : r)
      std::printf("%-12s %-20s %-8s %-8s %-8s %-12s %-6s %s\n", l["id"].get<std::string>().c_str(),
                  l["runtime"].get<std::string>().c_str(), l["mode"].get<std::string>().c_str(),
                  l["backend"].get<std::string>().c_str(), l["state"].get<std::string>().c_str(),
                  l["owner"].get<std::string>().c_str(), fmt_secs(l["uptime_s"].get<double>()).c_str(),
                  l["instance"].get<std::string>().c_str());
    return 0;
  }
  if (sub == "pull") {
    if (arg.empty()) throw ControlError("pull needs a runtime");
    if (!a.json_out) c.on_event = [](const json& e) {
      if (e["event"] == "pull.progress") std::cerr << e["line"].get<std::string>() << "\n";
      return true;
    };
    json args = {{"runtime", arg}};
    if (a.has("--backend")) args["backend"] = a.get("--backend");
    const json r = c.call("pull", args);
    if (a.json_out) return print_json(r), 0;
    std::cout << "pulled " << r["runtime"].get<std::string>() << " (" << r["image"].get<std::string>() << ")\n";
    return 0;
  }
  if (sub == "logs") {
    const json r = c.call("logs", {{"lease", arg}, {"tail", std::stoi(a.get("--tail", "200"))}});
    if (a.json_out) return print_json(r), 0;
    std::cout << r["text"].get<std::string>();
    return 0;
  }
  if (sub == "stats") {
    const json r = c.call("stats", {{"lease", arg}});
    if (a.json_out) return print_json(r), 0;
    const auto& s = r["stats"];
    std::printf("cpu %.1f%%  memory %s  processes %lld\n", s["cpu_percent"].get<double>(),
                fmt_bytes(s["memory_bytes"].get<long long>()).c_str(), s["pids"].get<long long>());
    return 0;
  }
  if (sub == "prune") {
    const json r = c.call("prune", {{"dry_run", a.has("--dry-run")}});
    if (a.json_out) return print_json(r), 0;
    for (const auto& x : r["removed"])
      std::cout << (a.has("--dry-run") ? "would remove " : "removed ") << x["path"].get<std::string>() << " (project "
                << x["project"].get<std::string>() << " is gone)\n";
    if (r["removed"].empty()) std::cout << "nothing to prune\n";
    return 0;
  }
  if (sub == "events") {
    c.call("subscribe");
    c.on_event = [&](const json& e) {
      if (a.json_out) std::cout << e.dump() << std::endl;
      else std::cout << e["event"].get<std::string>() << "  " << e.dump() << std::endl;
      return true;
    };
    c.listen();
    return 0;
  }
  if (sub == "run") {
    if (arg.empty()) throw ControlError("run needs a runtime");
    json args = {{"runtime", arg}, {"owner", "cli"}};
    const std::string mode = a.get("--mode", a.command.empty() ? "station" : "exec");
    args["mode"] = mode;
    if (!a.command.empty()) args["command"] = a.command;
    if (a.has("--project")) args["project"] = fs::absolute(a.get("--project")).string();
    if (a.has("--backend")) args["backend"] = a.get("--backend");
    if (a.has("--network")) args["policy"] = {{"network", true}};
    if (a.has("--allow-unpinned")) args["allow_unpinned"] = true;
    c.call("subscribe");
    std::string lease_id;
    int exit_code = -1;
    bool ended = false;
    c.on_event = [&](const json& e) {
      if (e["event"] == "runtime.pulling" && !a.json_out) std::cerr << "pulling " << e["runtime"].get<std::string>() << "...\n";
      if (e["event"] == "policy.weakened" && !a.json_out) std::cerr << "warning: allows " << e["what"].get<std::string>() << "\n";
      if (e["event"] == "runtime.exited" && e["lease"] == lease_id) {
        exit_code = e["exit_code"].get<int>();
        ended = true;
        return false;
      }
      return true;
    };
    const json lease = c.call("acquire", args);
    lease_id = lease["id"].get<std::string>();
    if (a.json_out) print_json(lease);
    else std::cerr << "lease " << lease_id << ": " << lease["runtime"].get<std::string>() << " on "
                   << lease["backend"].get<std::string>() << " (" << lease["instance"].get<std::string>() << ")\n";
    if (mode != "exec") {
      if (!a.json_out) std::cerr << "holding; Ctrl-C releases it\n";
      c.listen();  // until the daemon goes or the runtime ends; Ctrl-C ends the process, which releases
      return ended ? exit_code : 0;
    }
    c.listen();
    if (!ended) throw ControlError("paperboatd went away");
    const json logs = c.call("logs", {{"lease", lease_id}, {"tail", 1000}});
    if (!a.json_out) std::cout << logs["text"].get<std::string>();
    c.call("release", {{"lease", lease_id}});
    return exit_code < 0 ? 1 : exit_code;
  }
  throw ControlError("unknown runtimes command \"" + sub + "\"");
}

}  // namespace

int main(int argc, char** argv) {
  const Args a = parse(argc, argv);
  if (a.has("--version")) {
    std::cout << "paperboat " << PAPERBOAT_VERSION << "\n";
    return 0;
  }
  if (a.pos.empty() || a.has("--help")) {
    std::cout << kUsage;
    return a.pos.empty() && !a.has("--help") ? 2 : 0;
  }
  const fs::path socket = a.has("--socket") ? fs::path(a.get("--socket")) : paths::control_socket();
  try {
    if (a.pos[0] == "runtimes") {
      ControlClient c(socket);
      return cmd_runtimes(c, a);
    }
    if (a.pos[0] == "daemon") {
      const std::string sub = a.pos.size() > 1 ? a.pos[1] : "status";
      if (sub == "status") {
        try {
          ControlClient c(socket, false);
          const json r = c.call("hello");
          if (a.json_out) return print_json(r), 0;
          std::cout << "paperboatd " << r["version"].get<std::string>() << " (pid " << r["pid"] << ") on " << socket.string() << "\n";
        } catch (const ControlError&) {
          if (a.json_out) return print_json({{"running", false}}), 1;
          std::cout << "paperboatd is not running\n";
          return 1;
        }
        return 0;
      }
      if (sub == "stop") {
        try {
          ControlClient c(socket, false);
          c.call("shutdown");
        } catch (const ControlError&) {
        }
        return 0;
      }
    }
    std::cerr << kUsage;
    return 2;
  } catch (const std::exception& e) {
    if (a.json_out) print_json({{"error", e.what()}});
    else std::cerr << "paperboat: " << e.what() << "\n";
    return 1;
  }
}
