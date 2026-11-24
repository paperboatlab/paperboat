#pragma once

// The client side of paperboat-runtime/0 (docs/runtime.md): what an app links to talk to a runtime
// it holds a lease on. The control plane is length-prefixed JSON over <ipc>/runtime.sock; the fast
// path (station mode) is a shared-memory slot pair in the same folder. Linux and macOS (the fast path
// is Linux-only for now: futex).

#include <nlohmann/json.hpp>

#include <chrono>
#include <filesystem>
#include <functional>
#include <mutex>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

namespace paperboat {

inline constexpr const char* kRuntimeProtocol = "paperboat-runtime/0";

// A request the runtime answered with an error (or a dead runtime: type "Disconnected").
struct RuntimeError : std::runtime_error {
  RuntimeError(std::string type_, const std::string& message, std::string traceback_ = "")
      : std::runtime_error(message), type(std::move(type_)), traceback(std::move(traceback_)) {}
  std::string type, traceback;
};

class RuntimeClient {
 public:
  // Connect to <ipc>/runtime.sock, waiting up to `timeout` for the runtime to listen, and read its hello.
  RuntimeClient(const std::filesystem::path& ipc, std::chrono::milliseconds timeout = std::chrono::seconds(30));
  ~RuntimeClient();
  RuntimeClient(const RuntimeClient&) = delete;
  RuntimeClient& operator=(const RuntimeClient&) = delete;

  const nlohmann::json& hello() const { return hello_; }

  // One request. Notifications that arrive meanwhile (stream, display, log, ...) go to on_message.
  // Throws RuntimeError when the runtime answers with an error or goes away.
  nlohmann::json request(const std::string& op, const nlohmann::json& args = nlohmann::json::object(),
                         const std::function<void(const nlohmann::json&)>& on_message = {});

  // Ask the runtime to interrupt what it is running; safe from any thread, while request() waits.
  void interrupt();

  // Station mode's fast path: one channel per connection, `capacity` doubles each way.
  void open_fast(std::size_t capacity);
  int bind(int instance, const std::string& method);
  std::vector<double> call_fast(int handle, std::span<const double> in);
  void call_fast(int handle, std::span<const double> in, std::vector<double>& out);

 private:
  bool read_frame(nlohmann::json& out);
  void write_frame(const nlohmann::json& j);
  void close_fast();

  std::filesystem::path ipc_;
  int fd_ = -1;
  nlohmann::json hello_;
  std::mutex read_, write_;
  long long next_id_ = 1;
  // fast path
  char* shm_ = nullptr;
  std::size_t shm_bytes_ = 0, slot_ = 0, capacity_ = 0;
  std::filesystem::path shm_path_;
  std::uint32_t seq_ = 0;
};

}  // namespace paperboat
