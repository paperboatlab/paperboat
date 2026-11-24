// podman and docker: one backend, driven through their CLIs (ProcessRunner). The flags are the same
// apart from user mapping (podman --userns=keep-id, docker --user) and GPU syntax.

#include "paperboat/backend.hpp"

#include <algorithm>
#include <sstream>
#include <stdexcept>

#ifndef _WIN32
#include <unistd.h>
#endif

namespace paperboat {

namespace {

using json = nlohmann::json;
constexpr auto kQuick = std::chrono::seconds(20);

std::string trim(std::string s) {
  while (!s.empty() && std::isspace(static_cast<unsigned char>(s.back()))) s.pop_back();
  std::size_t i = 0;
  while (i < s.size() && std::isspace(static_cast<unsigned char>(s[i]))) ++i;
  return s.substr(i);
}

std::string last_line(const std::string& text) {
  const std::string t = trim(text);
  const auto nl = t.rfind('\n');
  return nl == std::string::npos ? t : t.substr(nl + 1);
}

// "12.5%" -> 12.5; "1.2GB / 4GB" -> bytes of the first; "--" -> -1
double percent(const std::string& s) {
  try {
    return std::stod(s);
  } catch (...) {
    return -1;
  }
}

long long bytes(const std::string& s) {
  std::istringstream in(s);
  double v = 0;
  std::string unit;
  if (!(in >> v)) return -1;
  in >> unit;
  if (const auto slash = unit.find('/'); slash != std::string::npos) unit.erase(slash);
  std::ranges::transform(unit, unit.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  double k = 1;
  if (unit.starts_with("ki")) k = 1024.0;
  else if (unit.starts_with("mi")) k = 1024.0 * 1024;
  else if (unit.starts_with("gi")) k = 1024.0 * 1024 * 1024;
  else if (unit.starts_with("k")) k = 1e3;
  else if (unit.starts_with("m")) k = 1e6;
  else if (unit.starts_with("g")) k = 1e9;
  return static_cast<long long>(v * k);
}

std::map<std::string, std::string> labels_of(const json& j) {
  std::map<std::string, std::string> out;
  if (j.is_object()) {
    for (const auto& [k, v] : j.items())
      if (v.is_string()) out[k] = v.get<std::string>();
  } else if (j.is_string()) {  // docker: "k=v,k=v"
    std::string s = j.get<std::string>();
    std::istringstream in(s);
    for (std::string kv; std::getline(in, kv, ',');)
      if (const auto eq = kv.find('='); eq != std::string::npos) out[kv.substr(0, eq)] = kv.substr(eq + 1);
  }
  return out;
}

class OciBackend final : public Backend {
 public:
  OciBackend(std::string engine, std::string exe) : engine_(std::move(engine)), exe_(std::move(exe)) {
    if (exe_.empty()) exe_ = which(engine_);
  }

  std::string name() const override { return engine_; }

  Availability probe() override {
    Availability a;
    if (exe_.empty()) {
      a.detail = engine_ + " is not installed";
      return a;
    }
    const auto r = ProcessRunner::run_sync({exe_, "info", "--format", "{{json .}}"}, {}, {}, kQuick);
    if (!r.ok()) {
      a.detail = engine_ + " info failed: " + last_line(r.stderr_text.empty() ? r.stdout_text : r.stderr_text);
      return a;
    }
    try {
      const json info = json::parse(r.stdout_text);
      if (engine_ == "podman") {
        a.rootless = info["host"]["security"].value("rootless", false);
        a.selinux = info["host"]["security"].value("selinuxEnabled", false);
        a.detail = "podman " + info["version"].value("Version", std::string("?"));
      } else {
        for (const auto& opt : info.value("SecurityOptions", json::array())) {
          const std::string o = opt.get<std::string>();
          if (o.find("name=rootless") != std::string::npos) a.rootless = true;
          if (o.find("name=selinux") != std::string::npos) a.selinux = true;
        }
        a.detail = "docker " + info.value("ServerVersion", std::string("?"));
      }
      a.ok = true;
      selinux_ = a.selinux;
    } catch (const std::exception& e) {
      a.detail = engine_ + " info: " + e.what();
    }
    return a;
  }

  bool can_run(const Manifest& m) const override { return !m.image_ref.empty(); }

  bool has_image(const Manifest& m) override {
    return !m.image_ref.empty() && ProcessRunner::run_sync({exe_, "image", "inspect", m.image()}, {}, {}, kQuick).ok();
  }

  ProcessResult pull(const Manifest& m, ProcessOutputCallback progress) override {
    ProcessResult r;
    std::string err;
    r.exit_code = ProcessRunner::run_stream({exe_, "pull", m.image()}, {}, {}, [&](std::string_view stream, std::string_view line) {
      if (stream == "stderr") err.append(line).append("\n");
      if (progress) progress(stream, line);
    });
    r.stderr_text = err;
    return r;
  }

  std::vector<std::string> command(const LaunchSpec& spec) const override {
    const Manifest& m = *spec.manifest;
    std::vector<std::string> a = {exe_, "run", "-d", "--init", "--name", spec.name};
    for (const auto& [k, v] : spec.labels) a.insert(a.end(), {"--label", k + "=" + v});
    for (auto& f : isolation_flags(spec, engine_, selinux_)) a.push_back(std::move(f));
    for (const auto& [k, v] : m.env) a.insert(a.end(), {"-e", k + "=" + v});
    a.insert(a.end(), {"-e", "PAPERBOAT_IPC=" + m.mounts.at("ipc"), "-e", "PAPERBOAT_MODE=" + spec.mode});
    if (!spec.project.empty()) a.insert(a.end(), {"-e", "PAPERBOAT_PROJECT=" + m.mounts.at("project")});
    a.push_back(m.image());
    const std::map<std::string, std::string> vars = {{"ipc", m.mounts.at("ipc")}, {"project", m.mounts.at("project")},
                                                     {"deps", m.mounts.at("deps")}, {"work", m.mounts.at("work")},
                                                     {"lib", m.mounts.at("lib")}, {"lease", spec.name}};
    const auto argv = spec.mode == "exec" ? spec.command : expand(m.entry.at(spec.mode), vars);
    a.insert(a.end(), argv.begin(), argv.end());
    return a;
  }

  Instance start(const LaunchSpec& spec) override {
    if (spec.mode == "exec" && spec.command.empty()) throw std::runtime_error("exec mode needs a command");
    if (spec.mode != "exec" && !spec.manifest->entry.contains(spec.mode))
      throw std::runtime_error(spec.manifest->id() + " has no " + spec.mode + " entry");
    const auto r = ProcessRunner::run_sync(command(spec), {}, {}, std::chrono::seconds(120));
    if (!r.ok()) {
      ProcessRunner::run_sync({exe_, "rm", "-f", spec.name}, {}, {}, kQuick);  // a created-but-failed container
      throw std::runtime_error(engine_ + " could not start " + spec.manifest->id() + ": " +
                               last_line(r.stderr_text.empty() ? r.stdout_text : r.stderr_text));
    }
    Instance i;
    i.backend = engine_;
    i.name = spec.name;
    i.state = "running";
    i.labels = spec.labels;
    return i;
  }

  bool stop(const std::string& name) override {
    const auto r = ProcessRunner::run_sync({exe_, "rm", "-f", "-t", "2", name}, {}, {}, std::chrono::seconds(30));
    return r.ok() || r.stderr_text.find("no such container") != std::string::npos ||
           r.stderr_text.find("No such container") != std::string::npos;
  }

  std::vector<Instance> list() override {
    std::vector<Instance> out;
    const auto r = ProcessRunner::run_sync(
        {exe_, "ps", "-a", "--filter", "label=paperboat.daemon", "--format", engine_ == "podman" ? "json" : "{{json .}}"},
        {}, {}, kQuick);
    if (!r.ok()) return out;
    std::vector<json> rows;
    try {
      if (engine_ == "podman") {
        for (auto& row : json::parse(r.stdout_text)) rows.push_back(row);
      } else {
        std::istringstream in(r.stdout_text);
        for (std::string line; std::getline(in, line);)
          if (!trim(line).empty()) rows.push_back(json::parse(line));
      }
    } catch (...) {
      return out;
    }
    for (const auto& row : rows) {
      Instance i;
      i.backend = engine_;
      const auto& names = row["Names"];
      i.name = names.is_array() && !names.empty() ? names[0].get<std::string>() : names.is_string() ? names.get<std::string>() : "";
      std::string state = row.value("State", std::string("unknown"));
      std::ranges::transform(state, state.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
      i.state = state;
      if (row.contains("ExitCode") && row["ExitCode"].is_number()) i.exit_code = row["ExitCode"].get<int>();
      if (row.contains("Pid") && row["Pid"].is_number()) i.pid = row["Pid"].get<int>();
      i.labels = labels_of(row["Labels"]);
      if (!i.name.empty()) out.push_back(std::move(i));
    }
    return out;
  }

  Stats stats(const std::string& name) override {
    Stats s;
    const auto r = ProcessRunner::run_sync(
        {exe_, "stats", "--no-stream", "--format", engine_ == "podman" ? "json" : "{{json .}}", name}, {}, {}, kQuick);
    if (!r.ok()) return s;
    try {
      json row = json::parse(trim(r.stdout_text));
      if (row.is_array()) row = row.empty() ? json::object() : row[0];
      s.cpu_percent = percent(row.value("cpu_percent", row.value("CPUPerc", std::string("-1"))));
      s.memory_bytes = bytes(row.value("mem_usage", row.value("MemUsage", std::string(""))));
      const auto pids = row.value("pids", row.value("PIDs", std::string("-1")));
      s.pids = std::atoll(pids.c_str());
    } catch (...) {
    }
    return s;
  }

  std::string logs(const std::string& name, int tail) override {
    const auto r = ProcessRunner::run_sync({exe_, "logs", "--tail", std::to_string(tail), name}, {}, {}, kQuick);
    return r.stdout_text + r.stderr_text;
  }

  bool signal(const std::string& name, int sig) override {
    // --init: the container's PID 1 is podman's init, which forwards the signal to the runtime
    return ProcessRunner::run_sync({exe_, "kill", "--signal", std::to_string(sig), name}, {}, {}, kQuick).ok();
  }

  std::vector<std::string> remove_command(const Instance& i) const override { return {exe_, "rm", "-f", "-t", "1", i.name}; }

 private:
  std::string engine_, exe_;
  bool selinux_ = false;
};

}  // namespace

std::vector<std::string> isolation_flags(const LaunchSpec& spec, const std::string& engine, bool selinux) {
  const Manifest& m = *spec.manifest;
  const Policy& p = spec.policy;
  std::vector<std::string> a;
  if (!p.network) a.emplace_back("--network=none");
  a.insert(a.end(), {"--read-only", "--tmpfs", "/tmp:rw,size=512m,mode=1777", "--cap-drop=all",
                     "--security-opt", "no-new-privileges"});
  a.insert(a.end(), {"--pids-limit", std::to_string(m.limits.pids > 0 ? m.limits.pids : 512)});
  if (!m.limits.memory.empty()) a.insert(a.end(), {"--memory", m.limits.memory});
  if (m.limits.cpus > 0) {
    std::ostringstream c;
    c << m.limits.cpus;
    a.insert(a.end(), {"--cpus", c.str()});
  }
  if (engine == "podman") {
    a.emplace_back("--userns=keep-id");
  } else {
#ifndef _WIN32
    a.insert(a.end(), {"--user", std::to_string(getuid()) + ":" + std::to_string(getgid())});
#endif
  }
  // SELinux: the daemon's own folders are relabelled (:Z, private to this container); a user's project
  // never is, so a project mount turns labelling off for this container (as Squero MX#73 found).
  const bool user_files = !spec.project.empty();
  if (selinux && user_files) a.insert(a.end(), {"--security-opt", "label=disable"});
  const std::string own = selinux && !user_files ? ",Z" : "";
  if (!spec.project.empty())
    a.insert(a.end(), {"-v", spec.project.string() + ":" + m.mounts.at("project") + (p.writable_project ? ":rw" : ":ro")});
  if (!spec.deps.empty()) a.insert(a.end(), {"-v", spec.deps.string() + ":" + m.mounts.at("deps") + ":rw" + own});
  if (!spec.work.empty()) a.insert(a.end(), {"-v", spec.work.string() + ":" + m.mounts.at("work") + ":rw" + own});
  if (!spec.ipc.empty()) a.insert(a.end(), {"-v", spec.ipc.string() + ":" + m.mounts.at("ipc") + ":rw" + own});
  // The library is the daemon's copy, shared by every instance of the runtime: ":z", not ":Z".
  if (!spec.lib.empty())
    a.insert(a.end(), {"-v", spec.lib.string() + ":" + m.mounts.at("lib") + ":ro" + (own.empty() ? "" : ",z")});
  for (const auto& d : p.devices) a.insert(a.end(), {"--device", d});
  if (p.gpu) {
    if (engine == "podman") a.insert(a.end(), {"--device", "nvidia.com/gpu=all"});
    else a.insert(a.end(), {"--gpus", "all"});
  }
  if (p.ipc_host) a.emplace_back("--ipc=host");
  return a;
}

std::unique_ptr<Backend> make_oci_backend(const std::string& engine, const std::string& exe) {
  return std::make_unique<OciBackend>(engine, exe);
}

std::string which(const std::string& program) {
  if (program.empty()) return {};
  if (program.find('/') != std::string::npos) return fs::exists(program) ? program : "";
  const char* path = std::getenv("PATH");
  if (!path) return {};
  std::istringstream in(path);
#ifdef _WIN32
  const char sep = ';';
  const std::vector<std::string> exts = {".exe", ".cmd", ".bat", ""};
#else
  const char sep = ':';
  const std::vector<std::string> exts = {""};
#endif
  for (std::string dir; std::getline(in, dir, sep);) {
    if (dir.empty()) continue;
    for (const auto& ext : exts) {
      const fs::path p = fs::path(dir) / (program + ext);
      std::error_code ec;
      if (fs::is_regular_file(p, ec)) return p.string();
    }
  }
  return {};
}

nlohmann::json to_json(const Instance& i) {
  return {{"backend", i.backend}, {"name", i.name}, {"state", i.state}, {"exit_code", i.exit_code}, {"pid", i.pid},
          {"labels", i.labels}};
}

nlohmann::json to_json(const Stats& s) {
  return {{"cpu_percent", s.cpu_percent}, {"memory_bytes", s.memory_bytes}, {"pids", s.pids}};
}

}  // namespace paperboat
