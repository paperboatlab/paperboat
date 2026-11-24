// paperboatd: the per-user runtime daemon. Owns every runtime instance (leases), serves
// paperboat-control/0 on a Unix socket, reaps what a previous daemon left, and exits when idle.
//
//   paperboatd [--socket PATH] [--state DIR] [--runtimes DIR]... [--idle-exit SECONDS] [--idle-timeout SECONDS]
//
// Crash safety: before any thread starts, the daemon forks a cleaner that holds one end of a pipe and
// knows every running instance. When the daemon ends in any way (kill -9 included) the pipe closes and
// the cleaner removes them. A later daemon also reaps instances labelled with a daemon that is gone.
// POSIX only for now.

#include "../lib/posix.hpp"

#ifdef __APPLE__
#include <libproc.h>
#endif
#include "paperboat/catalog.hpp"
#include "paperboat/control.hpp"
#include "paperboat/manager.hpp"
#include "paperboat/paths.hpp"

#include <nlohmann/json.hpp>

#include <atomic>
#include <csignal>
#include <cstring>
#include <fstream>
#include <iostream>
#include <list>
#include <map>
#include <mutex>
#include <set>
#include <thread>

#include <fcntl.h>
#include <pthread.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef PAPERBOAT_VERSION
#define PAPERBOAT_VERSION "0.0.0-dev"
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;
using namespace paperboat;

namespace {

void log(const std::string& line) { std::cerr << "paperboatd: " << line << std::endl; }

// --- the cleaner: a child that removes the daemon's instances once the daemon is gone ---

void run_cleaner(int in) {
  for (int s : {SIGINT, SIGTERM, SIGHUP}) std::signal(s, SIG_IGN);  // a terminal's Ctrl-C must not take it too
  std::map<std::string, std::vector<std::string>> live;  // instance -> its remove command
  std::string buf;
  char chunk[4096];
  for (;;) {
    const ssize_t r = ::read(in, chunk, sizeof chunk);
    if (r <= 0) break;
    buf.append(chunk, static_cast<std::size_t>(r));
    for (auto nl = buf.find('\n'); nl != std::string::npos; nl = buf.find('\n')) {
      try {
        const json msg = json::parse(buf.substr(0, nl));
        if (msg["op"] == "+") live[msg["name"]] = msg["cmd"].get<std::vector<std::string>>();
        else live.erase(msg["name"].get<std::string>());
      } catch (...) {
      }
      buf.erase(0, nl + 1);
    }
  }
  for (const auto& [name, cmd] : live) {
    const pid_t pid = fork();
    if (pid == 0) {
      const int null = ::open("/dev/null", O_RDWR);
      dup2(null, 1);
      dup2(null, 2);
      std::vector<char*> argv;
      for (const auto& a : cmd) argv.push_back(const_cast<char*>(a.c_str()));
      argv.push_back(nullptr);
      execvp(argv[0], argv.data());
      _exit(127);
    }
    if (pid > 0) waitpid(pid, nullptr, 0);
  }
  _exit(0);
}

// --- daemon identity: "<boot id>:<pid>" ---

bool daemon_alive(const std::string& id) {
  const auto colon = id.rfind(':');
  if (colon == std::string::npos) return false;
  if (id.substr(0, colon) != paths::boot_id()) return false;  // a previous boot: certainly gone
  const int pid = std::atoi(id.c_str() + colon + 1);
  if (pid <= 0 || ::kill(pid, 0) != 0) return false;
#ifdef __APPLE__
  char name[64] = {};
  ::proc_name(pid, name, sizeof name);
  return std::string(name) == "paperboatd";
#else
  std::ifstream comm("/proc/" + std::to_string(pid) + "/comm");
  std::string name;
  std::getline(comm, name);
  return name == "paperboatd";
#endif  // a reused pid is someone else
}

// --- clients ---

struct Client {
  int id = 0;
  int fd = -1;
  std::mutex write;
  bool subscribed = false;
  bool send(const json& j) {
    std::lock_guard lock(write);
    return write_json_line(fd, j);
  }
};

std::mutex g_clients_mutex;
std::list<std::shared_ptr<Client>> g_clients;
std::atomic<bool> g_stop{false};
std::atomic<long long> g_last_activity{0};

long long now_s() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

void broadcast(const json& event) {
  std::vector<std::shared_ptr<Client>> to;
  {
    std::lock_guard lock(g_clients_mutex);
    for (const auto& c : g_clients)
      if (c->subscribed) to.push_back(c);
  }
  for (const auto& c : to) c->send(event);
}

AcquireRequest acquire_request(const json& a, const std::string& fallback_owner) {
  AcquireRequest r;
  r.runtime = a.at("runtime").get<std::string>();
  r.mode = a.value("mode", std::string("station"));
  r.command = a.value("command", std::vector<std::string>{});
  r.project = a.value("project", std::string());
  r.work = a.value("work", std::string());
  r.policy = policy_from_json(a.value("policy", json::object()));
  r.backend = a.value("backend", std::string());
  r.owner = a.value("owner", fallback_owner);
  r.allow_unpinned = a.value("allow_unpinned", false);
  r.allow_unverified = a.value("allow_unverified", false);
  return r;
}

json handle(Manager& m, Client& c, const std::string& op, const json& args, const std::string& daemon_id) {
  if (op == "hello" || op == "ping")
    return {{"protocol", kControlProtocol}, {"version", PAPERBOAT_VERSION}, {"daemon", daemon_id}, {"pid", ::getpid()},
            {"backends", m.backends()}};
  if (op == "runtimes.list") {
    json r = m.runtimes();
    r["backends"] = m.backends();
    return r;
  }
  if (op == "backends") return m.backends();
  if (op == "ps") return m.ps();
  if (op == "stats") return m.stats(args.at("lease").get<std::string>());
  if (op == "interrupt") return {{"delivered", m.interrupt(args.at("lease").get<std::string>())}};
  if (op == "logs") return {{"text", m.logs(args.at("lease").get<std::string>(), args.value("tail", 200))}};
  if (op == "pull")
    return m.pull(args.at("runtime").get<std::string>(), args.value("backend", std::string()),
                  [&](std::string_view stream, std::string_view line) {
                    c.send({{"event", "pull.progress"}, {"stream", stream}, {"line", line}});
                  });
  if (op == "acquire") return m.acquire(acquire_request(args, "client-" + std::to_string(c.id)), c.id);
  if (op == "release") {
    m.release(args.at("lease").get<std::string>(), c.id);
    return json::object();
  }
  if (op == "prune") return m.prune(args.value("dry_run", false));
  if (op == "subscribe") {
    c.subscribed = true;
    return json::object();
  }
  if (op == "shutdown") {
    g_stop = true;
    return json::object();
  }
  throw std::runtime_error("unknown op \"" + op + "\"");
}

void serve_client(Manager& m, std::shared_ptr<Client> c, const std::string& daemon_id) {
  std::string buf;
  char chunk[16384];
  for (;;) {
    const ssize_t r = ::read(c->fd, chunk, sizeof chunk);
    if (r <= 0) break;
    buf.append(chunk, static_cast<std::size_t>(r));
    for (auto nl = buf.find('\n'); nl != std::string::npos; nl = buf.find('\n')) {
      const std::string line = buf.substr(0, nl);
      buf.erase(0, nl + 1);
      g_last_activity = now_s();
      json req;
      try {
        req = json::parse(line);
      } catch (const json::exception&) {
        c->send({{"id", nullptr}, {"ok", false}, {"error", "malformed JSON line"}});
        continue;
      }
      const json id = req.value("id", json());
      try {
        const json result = handle(m, *c, req.value("op", std::string()), req.value("args", json::object()), daemon_id);
        c->send({{"id", id}, {"ok", true}, {"result", result}});
      } catch (const std::exception& e) {
        c->send({{"id", id}, {"ok", false}, {"error", e.what()}});
      }
    }
  }
  m.drop_client(c->id);  // a client that goes away releases what it held
  {
    std::lock_guard lock(g_clients_mutex);
    g_clients.remove(c);
  }
  ::close(c->fd);
  g_last_activity = now_s();
}

int listen_on(const fs::path& socket) {
  const int fd = posix::unix_socket();
  sockaddr_un sa{};
  sa.sun_family = AF_UNIX;
  const std::string p = socket.string();
  if (fd < 0 || p.size() >= sizeof sa.sun_path) return -1;
  std::memcpy(sa.sun_path, p.c_str(), p.size() + 1);
  ::unlink(p.c_str());  // stale: we hold the lock, so no other daemon is listening on it
  const mode_t old = ::umask(0177);  // the socket is the user's alone
  const int ok = ::bind(fd, reinterpret_cast<sockaddr*>(&sa), sizeof sa);
  ::umask(old);
  if (ok != 0 || ::listen(fd, 64) != 0) {
    ::close(fd);
    return -1;
  }
  return fd;
}

}  // namespace

int main(int argc, char** argv) {
  fs::path socket = paths::control_socket();
  fs::path state = paths::home() / "state";
  std::vector<fs::path> runtime_dirs;
  long long idle_exit = 600, idle_timeout = 300;
  bool idle_timeout_set = false;
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    const bool more = i + 1 < argc;
    if (a == "--socket" && more) socket = argv[++i];
    else if (a == "--state" && more) state = argv[++i];
    else if (a == "--runtimes" && more) runtime_dirs.emplace_back(argv[++i]);
    else if (a == "--idle-exit" && more) idle_exit = std::atoll(argv[++i]);
    else if (a == "--idle-timeout" && more) idle_timeout = std::atoll(argv[++i]), idle_timeout_set = true;
    else if (a == "--version") {
      std::cout << "paperboatd " << PAPERBOAT_VERSION << "\n";
      return 0;
    } else {
      std::cerr << "usage: paperboatd [--socket PATH] [--state DIR] [--runtimes DIR]... [--idle-exit S] [--idle-timeout S]\n";
      return 2;
    }
  }
  if (!idle_timeout_set)
    if (const char* v = std::getenv("PAPERBOAT_IDLE_TIMEOUT")) idle_timeout = std::atoll(v);

  // One daemon per socket.
  fs::create_directories(socket.parent_path());
  ::chmod(socket.parent_path().c_str(), 0700);
  const fs::path lock_file = socket.string() + ".lock";
  const int lock_fd = ::open(lock_file.c_str(), O_RDWR | O_CREAT | O_CLOEXEC, 0600);
  if (lock_fd < 0 || ::flock(lock_fd, LOCK_EX | LOCK_NB) != 0) {
    log("another paperboatd serves " + socket.string());
    return 0;
  }

  // The cleaner, forked while this process has one thread.
  int pipefd[2];
  if (posix::pipe_cloexec(pipefd) != 0) {
    log("pipe failed");
    return 1;
  }
  const pid_t cleaner = ::fork();
  if (cleaner == 0) {
    ::close(pipefd[1]);
    ::close(lock_fd);
    ::setsid();  // not in the daemon's process group: a group kill must not take it along
    run_cleaner(pipefd[0]);
  }
  ::close(pipefd[0]);
  const int cleaner_fd = pipefd[1];
  std::mutex cleaner_mutex;

  // Signals go to one thread that asks the loop to stop.
  sigset_t sigs;
  sigemptyset(&sigs);
  for (int s : {SIGINT, SIGTERM, SIGHUP}) sigaddset(&sigs, s);
  pthread_sigmask(SIG_BLOCK, &sigs, nullptr);
  std::signal(SIGPIPE, SIG_IGN);

  const std::string daemon_id = paths::boot_id() + ":" + std::to_string(::getpid());
  Catalog catalog = default_catalog();
  for (const auto& d : runtime_dirs) catalog.add_dir(d);
  for (const auto& e : catalog.errors()) log("runtime manifest skipped: " + e);

  std::vector<std::unique_ptr<Backend>> backends;
  backends.push_back(make_oci_backend("podman"));
  backends.push_back(make_oci_backend("docker"));
  backends.push_back(make_native_backend(state / "native"));
  ManagerOptions options;
  options.daemon_id = daemon_id;
  options.state = state;
  options.idle_timeout = std::chrono::seconds(idle_timeout);
  if (const char* order = std::getenv("PAPERBOAT_BACKENDS")) {  // "native" or "docker,native"
    options.backend_order.clear();
    std::string s = order;
    for (std::size_t at = 0; at <= s.size();) {
      const auto comma = s.find(',', at);
      options.backend_order.push_back(s.substr(at, comma - at));
      if (comma == std::string::npos) break;
      at = comma + 1;
    }
  }
  Manager manager(std::move(catalog), std::move(backends), options, broadcast);
  manager.on_instance = [&](const Instance& i, const Backend& b, bool started) {
    std::lock_guard lock(cleaner_mutex);
    const json msg = started ? json{{"op", "+"}, {"name", i.name}, {"cmd", b.remove_command(i)}} : json{{"op", "-"}, {"name", i.name}};
    const std::string line = msg.dump() + "\n";
    if (::write(cleaner_fd, line.data(), line.size()) < 0) log("cleaner is gone");
  };

  for (const auto& name : manager.reap(daemon_alive)) log("reaped " + name + " (its daemon is gone)");

  const int listen_fd = listen_on(socket);
  if (listen_fd < 0) {
    log("cannot listen on " + socket.string() + ": " + std::strerror(errno));
    return 1;
  }
  log("serving " + std::string(kControlProtocol) + " on " + socket.string() + " as " + daemon_id);
  g_last_activity = now_s();

  std::thread signals([&] {
    int sig = 0;
    sigwait(&sigs, &sig);
    g_stop = true;
  });
  signals.detach();

  std::thread ticker([&] {
    while (!g_stop) {
      std::this_thread::sleep_for(std::chrono::seconds(1));
      static int n = 0;
      if (++n % 2 == 0) manager.tick();
      bool clients = false;
      {
        std::lock_guard lock(g_clients_mutex);
        clients = !g_clients.empty();
      }
      if (!clients && manager.empty() && idle_exit > 0 && now_s() - g_last_activity >= idle_exit) {
        log("idle for " + std::to_string(idle_exit) + " s: exiting");
        g_stop = true;
      }
    }
    ::shutdown(listen_fd, SHUT_RDWR);  // wakes accept()
  });

  int next_client = 0;
  while (!g_stop) {
    const int fd = posix::accept_cloexec(listen_fd);
    if (fd < 0) {
      if (g_stop) break;
      continue;
    }
    auto c = std::make_shared<Client>();
    c->id = ++next_client;
    c->fd = fd;
    {
      std::lock_guard lock(g_clients_mutex);
      g_clients.push_back(c);
    }
    std::thread(serve_client, std::ref(manager), c, daemon_id).detach();
  }
  ticker.join();

  log("stopping every runtime");
  manager.stop_all();
  {
    std::lock_guard lock(g_clients_mutex);
    for (const auto& c : g_clients) ::shutdown(c->fd, SHUT_RDWR);
  }
  ::unlink(socket.c_str());
  ::close(cleaner_fd);  // nothing left for it to remove; it exits
  ::waitpid(cleaner, nullptr, 0);
  ::close(listen_fd);
  std::_Exit(0);  // client threads are detached and may still hold the manager
}
