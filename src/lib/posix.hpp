// The few POSIX calls that differ between Linux and macOS (internal; the library and the daemon).
#pragma once
#ifndef _WIN32

#include <fcntl.h>
#include <sys/socket.h>
#include <unistd.h>

#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0  // macOS: unix_socket and accept_cloexec set SO_NOSIGPIPE instead
#endif

namespace paperboat::posix {

inline void cloexec_nosigpipe([[maybe_unused]] int fd) {
#ifdef __APPLE__
  ::fcntl(fd, F_SETFD, FD_CLOEXEC);
  int on = 1;
  ::setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof on);
#endif
}

// A close-on-exec AF_UNIX stream socket whose writes never raise SIGPIPE.
inline int unix_socket() {
#ifdef __APPLE__
  const int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd >= 0) cloexec_nosigpipe(fd);
  return fd;
#else
  return ::socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
#endif
}

inline int accept_cloexec(int listen_fd) {
#ifdef __APPLE__
  const int fd = ::accept(listen_fd, nullptr, nullptr);
  if (fd >= 0) cloexec_nosigpipe(fd);
  return fd;
#else
  return ::accept4(listen_fd, nullptr, nullptr, SOCK_CLOEXEC);
#endif
}

inline int pipe_cloexec(int fds[2]) {
#ifdef __APPLE__
  if (::pipe(fds) != 0) return -1;
  ::fcntl(fds[0], F_SETFD, FD_CLOEXEC);
  ::fcntl(fds[1], F_SETFD, FD_CLOEXEC);
  return 0;
#else
  return ::pipe2(fds, O_CLOEXEC);
#endif
}

}  // namespace paperboat::posix
#endif
