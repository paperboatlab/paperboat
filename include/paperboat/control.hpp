#pragma once

// paperboat-control/0: the daemon's API. JSON lines over a Unix socket (one object per line).
//
//   request   {"id": 1, "op": "acquire", "args": {...}}
//   response  {"id": 1, "ok": true, "result": {...}}  |  {"id": 1, "ok": false, "error": "..."}
//   event     {"event": "runtime.started", ...}        (to clients that sent "subscribe")
//
// A lease belongs to the connection that acquired it: closing the connection releases it. The CLI,
// the Launcher and every app are clients; none of them talks to podman or docker itself.

#include <nlohmann/json.hpp>

#include <filesystem>
#include <functional>
#include <mutex>
#include <stdexcept>
#include <string>

namespace paperboat {

inline constexpr const char* kControlProtocol = "paperboat-control/0";

struct ControlError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

class ControlClient {
 public:
  // Connect to the daemon's socket; with autostart, start paperboatd (beside this binary, or on PATH)
  // when nobody listens and wait for it. Throws ControlError.
  explicit ControlClient(const std::filesystem::path& socket, bool autostart = true);
  ~ControlClient();
  ControlClient(const ControlClient&) = delete;
  ControlClient& operator=(const ControlClient&) = delete;

  // One request; events that arrive before its response go to on_event. Throws ControlError.
  nlohmann::json call(const std::string& op, const nlohmann::json& args = nlohmann::json::object());
  // Block reading events until on_event returns false or the daemon goes.
  void listen();

  std::function<bool(const nlohmann::json& event)> on_event;

 private:
  bool read_line(std::string& line);
  int fd_ = -1;
  long long next_id_ = 1;
  std::string buf_;
};

// Write one JSON line; false when the peer is gone.
bool write_json_line(int fd, const nlohmann::json& j);

}  // namespace paperboat
