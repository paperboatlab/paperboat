#include "paperboat/control.hpp"

#include "paperboat/backend.hpp"
#include "paperboat/paths.hpp"
#include "paperboat/process.hpp"

#include <chrono>
#include <cstring>
#include <thread>

#ifndef _WIN32
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#endif

namespace paperboat {

namespace {

using json = nlohmann::json;

#ifndef _WIN32
int connect_to(const std::filesystem::path& socket) {
  const int fd = ::socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) return -1;
  sockaddr_un sa{};
  sa.sun_family = AF_UNIX;
  const std::string p = socket.string();
  if (p.size() >= sizeof sa.sun_path) {
    ::close(fd);
    return -1;
  }
  std::memcpy(sa.sun_path, p.c_str(), p.size() + 1);
  if (::connect(fd, reinterpret_cast<sockaddr*>(&sa), sizeof sa) != 0) {
    ::close(fd);
    return -1;
  }
  return fd;
}
#endif

}  // namespace

bool write_json_line(int fd, const json& j) {
#ifdef _WIN32
  (void)fd;
  (void)j;
  return false;
#else
  const std::string line = j.dump(-1, ' ', false, json::error_handler_t::replace) + "\n";
  const char* p = line.data();
  std::size_t left = line.size();
  while (left > 0) {
    const ssize_t w = ::send(fd, p, left, MSG_NOSIGNAL);
    if (w <= 0) return false;
    p += w;
    left -= static_cast<std::size_t>(w);
  }
  return true;
#endif
}

ControlClient::ControlClient(const std::filesystem::path& socket, bool autostart) {
#ifdef _WIN32
  (void)socket;
  (void)autostart;
  throw ControlError("paperboatd is not ported to Windows yet");
#else
  fd_ = connect_to(socket);
  if (fd_ >= 0 || !autostart) {
    if (fd_ < 0) throw ControlError("paperboatd is not running (" + socket.string() + ")");
    return;
  }
  std::string daemon = (paths::exe_dir() / "paperboatd").string();
  if (!std::filesystem::exists(daemon)) daemon = which("paperboatd");
  if (daemon.empty()) throw ControlError("paperboatd not found beside " + paths::exe_dir().string() + " or on PATH");
  std::filesystem::create_directories(socket.parent_path());
  const int pid = ProcessRunner::run_detached({daemon, "--socket", socket.string()}, {}, {}, socket.parent_path() / "paperboatd.log");
  if (pid <= 0) throw ControlError("could not start " + daemon);
  for (int i = 0; i < 200 && fd_ < 0; ++i) {  // up to 20 s: a first start probes podman and docker
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    fd_ = connect_to(socket);
  }
  if (fd_ < 0) throw ControlError("paperboatd did not start; see " + (socket.parent_path() / "paperboatd.log").string());
#endif
}

ControlClient::~ControlClient() {
#ifndef _WIN32
  if (fd_ >= 0) ::close(fd_);
#endif
}

bool ControlClient::read_line(std::string& line) {
#ifdef _WIN32
  (void)line;
  return false;
#else
  for (;;) {
    if (const auto nl = buf_.find('\n'); nl != std::string::npos) {
      line.assign(buf_, 0, nl);
      buf_.erase(0, nl + 1);
      return true;
    }
    char chunk[16384];
    const ssize_t r = ::read(fd_, chunk, sizeof chunk);
    if (r <= 0) return false;
    buf_.append(chunk, static_cast<std::size_t>(r));
  }
#endif
}

json ControlClient::call(const std::string& op, const json& args) {
  const long long id = next_id_++;
  if (!write_json_line(fd_, {{"id", id}, {"op", op}, {"args", args}})) throw ControlError("paperboatd went away");
  for (std::string line; read_line(line);) {
    json msg;
    try {
      msg = json::parse(line);
    } catch (const json::exception&) {
      throw ControlError("paperboatd sent a malformed line");
    }
    if (msg.contains("event")) {
      if (on_event) on_event(msg);
      continue;
    }
    if (msg.value("id", -1LL) != id) continue;
    if (!msg.value("ok", false)) throw ControlError(msg.value("error", std::string("request failed")));
    return msg.value("result", json::object());
  }
  throw ControlError("paperboatd went away");
}

void ControlClient::listen() {
  for (std::string line; read_line(line);) {
    try {
      const json msg = json::parse(line);
      if (msg.contains("event") && on_event && !on_event(msg)) return;
    } catch (const json::exception&) {
      return;
    }
  }
}

}  // namespace paperboat
