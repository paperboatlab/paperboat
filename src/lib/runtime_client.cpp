#include "paperboat/runtime.hpp"

#include <atomic>
#include <cstring>
#include <thread>

#ifndef _WIN32
#include <fcntl.h>
#include <poll.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#endif
#ifdef __linux__
#include <linux/futex.h>
#include <sys/syscall.h>
#endif

namespace paperboat {

namespace {

using json = nlohmann::json;
namespace fs = std::filesystem;

#ifdef __linux__
void futex_wait(std::uint32_t* addr, std::uint32_t expected) {
  timespec ts{0, 50'000'000};  // wake to check the runtime is still there
  syscall(SYS_futex, addr, FUTEX_WAIT, expected, &ts, nullptr, 0);
}
void futex_wake(std::uint32_t* addr) { syscall(SYS_futex, addr, FUTEX_WAKE, 1, nullptr, nullptr, 0); }
#endif

[[noreturn]] void gone() { throw RuntimeError("Disconnected", "the runtime went away"); }

}  // namespace

RuntimeClient::RuntimeClient(const fs::path& ipc, std::chrono::milliseconds timeout) : ipc_(ipc) {
#ifdef _WIN32
  (void)timeout;
  throw RuntimeError("Unsupported", "paperboat-runtime/0 clients are not ported to Windows yet");
#else
  const std::string path = (ipc / "runtime.sock").string();
  sockaddr_un sa{};
  sa.sun_family = AF_UNIX;
  if (path.size() >= sizeof sa.sun_path) throw RuntimeError("Unsupported", "socket path too long: " + path);
  std::memcpy(sa.sun_path, path.c_str(), path.size() + 1);
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  for (;;) {
    fd_ = ::socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (::connect(fd_, reinterpret_cast<sockaddr*>(&sa), sizeof sa) == 0) break;
    ::close(fd_);
    fd_ = -1;
    if (std::chrono::steady_clock::now() > deadline)
      throw RuntimeError("Timeout", "the runtime did not listen on " + path + " within " +
                                        std::to_string(timeout.count() / 1000) + " s");
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  if (!read_frame(hello_) || hello_.value("type", "") != "hello") gone();
  if (hello_.value("protocol", "") != kRuntimeProtocol)
    throw RuntimeError("Protocol", "the runtime speaks " + hello_.value("protocol", std::string("?")) + ", not " + kRuntimeProtocol);
#endif
}

RuntimeClient::~RuntimeClient() {
#ifndef _WIN32
  close_fast();
  if (fd_ >= 0) ::close(fd_);
#endif
}

bool RuntimeClient::read_frame(json& out) {
#ifdef _WIN32
  (void)out;
  return false;
#else
  auto exact = [&](void* buf, std::size_t n) {
    char* p = static_cast<char*>(buf);
    while (n > 0) {
      const ssize_t r = ::read(fd_, p, n);
      if (r <= 0) return false;
      p += r;
      n -= static_cast<std::size_t>(r);
    }
    return true;
  };
  std::uint32_t n = 0;
  if (!exact(&n, 4)) return false;
  std::string body(n, '\0');
  if (!exact(body.data(), n)) return false;
  out = json::parse(body);
  return true;
#endif
}

void RuntimeClient::write_frame(const json& j) {
#ifndef _WIN32
  const std::string body = j.dump(-1, ' ', false, json::error_handler_t::replace);
  std::string frame(4, '\0');
  const auto n = static_cast<std::uint32_t>(body.size());
  std::memcpy(frame.data(), &n, 4);
  frame += body;
  std::lock_guard lock(write_);
  const char* p = frame.data();
  std::size_t left = frame.size();
  while (left > 0) {
    const ssize_t w = ::send(fd_, p, left, MSG_NOSIGNAL);
    if (w <= 0) gone();
    p += w;
    left -= static_cast<std::size_t>(w);
  }
#else
  (void)j;
#endif
}

json RuntimeClient::request(const std::string& op, const json& args, const std::function<void(const json&)>& on_message) {
  long long id;
  {
    std::lock_guard lock(write_);
    id = next_id_++;
  }
  write_frame({{"id", id}, {"op", op}, {"args", args}});
  std::lock_guard lock(read_);
  for (json msg; read_frame(msg);) {
    if (msg.contains("ok") && msg.value("id", -1LL) == id) {
      if (msg["ok"].get<bool>()) return msg.value("result", json());
      const json& e = msg["error"];
      throw RuntimeError(e.value("type", std::string("Error")), e.value("message", std::string("error")),
                         e.value("traceback", std::string()));
    }
    if (!msg.contains("ok") && on_message) on_message(msg);  // a reply to another id (an interrupt) is dropped
  }
  gone();
}

void RuntimeClient::interrupt() {
  long long id;
  {
    std::lock_guard lock(write_);
    id = next_id_++;
  }
  write_frame({{"id", id}, {"op", "interrupt"}, {"args", json::object()}});
}

void RuntimeClient::open_fast(std::size_t capacity) {
#ifndef __linux__
  (void)capacity;
  throw RuntimeError("Unsupported", "the shared-memory fast path is Linux-only for now");
#else
  if (shm_) throw RuntimeError("State", "this connection already has a fast channel");
  slot_ = (64 + 8 * capacity + 63) / 64 * 64;
  shm_bytes_ = 2 * slot_;
  capacity_ = capacity;
  static std::atomic<int> n{0};
  shm_path_ = ipc_ / ("fast-" + std::to_string(::getpid()) + "-" + std::to_string(++n) + ".shm");
  const int fd = ::open(shm_path_.c_str(), O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd < 0 || ::ftruncate(fd, static_cast<off_t>(shm_bytes_)) != 0) throw RuntimeError("IO", "cannot create " + shm_path_.string());
  void* p = ::mmap(nullptr, shm_bytes_, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  ::close(fd);
  if (p == MAP_FAILED) throw RuntimeError("IO", "cannot map " + shm_path_.string());
  shm_ = static_cast<char*>(p);
  request("shm", {{"path", shm_path_.filename().string()}, {"capacity", capacity}});
#endif
}

int RuntimeClient::bind(int instance, const std::string& method) {
  return request("bind", {{"instance", instance}, {"method", method}})["handle"].get<int>();
}

std::vector<double> RuntimeClient::call_fast(int handle, std::span<const double> in) {
  std::vector<double> out;
  call_fast(handle, in, out);
  return out;
}

void RuntimeClient::call_fast(int handle, std::span<const double> in, std::vector<double>& out) {
#ifndef __linux__
  (void)handle;
  (void)in;
  (void)out;
  throw RuntimeError("Unsupported", "the shared-memory fast path is Linux-only for now");
#else
  if (!shm_) throw RuntimeError("State", "open_fast first");
  if (in.size() > capacity_) throw RuntimeError("Capacity", "more inputs than the channel's capacity");
  auto* req_seq = reinterpret_cast<std::uint32_t*>(shm_);
  auto* rep_seq = reinterpret_cast<std::uint32_t*>(shm_ + slot_);
  std::memcpy(shm_ + 4, &handle, 4);
  const auto n = static_cast<std::uint32_t>(in.size());
  std::memcpy(shm_ + 8, &n, 4);
  std::memcpy(shm_ + 64, in.data(), in.size() * sizeof(double));
  seq_ = seq_ + 1 == 0xFFFFFFFFu ? 1 : seq_ + 1;
  std::atomic_ref<std::uint32_t>(*req_seq).store(seq_, std::memory_order_release);
  futex_wake(req_seq);
  for (std::uint64_t i = 0;; ++i) {
    const std::uint32_t got = std::atomic_ref<std::uint32_t>(*rep_seq).load(std::memory_order_acquire);
    if (got == seq_) break;
    if (i > 200) {
      futex_wait(rep_seq, got);
      if (i % 64 == 0) {  // the runtime still there? (a dead one closes the socket)
        pollfd p{fd_, POLLRDHUP, 0};
        if (::poll(&p, 1, 0) == 1 && (p.revents & (POLLRDHUP | POLLHUP | POLLERR))) gone();
      }
    }
  }
  std::uint32_t status = 0, outs = 0;
  std::memcpy(&status, shm_ + slot_ + 4, 4);
  std::memcpy(&outs, shm_ + slot_ + 8, 4);
  if (status != 0) {  // the message follows on the socket
    std::lock_guard lock(read_);
    for (json msg; read_frame(msg);)
      if (msg.value("type", "") == "fast_error") throw RuntimeError("FastCallError", msg.value("message", std::string("error")));
    gone();
  }
  out.resize(outs);
  std::memcpy(out.data(), shm_ + slot_ + 64, outs * sizeof(double));
#endif
}

void RuntimeClient::close_fast() {
#ifdef __linux__
  if (!shm_) return;
  auto* req_seq = reinterpret_cast<std::uint32_t*>(shm_);
  std::atomic_ref<std::uint32_t>(*req_seq).store(0xFFFFFFFFu, std::memory_order_release);
  futex_wake(req_seq);
  ::munmap(shm_, shm_bytes_);
  shm_ = nullptr;
  std::error_code ec;
  fs::remove(shm_path_, ec);
#endif
}

}  // namespace paperboat
