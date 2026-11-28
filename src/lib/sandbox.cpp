// A read-only project for a native process (pb#85). Linux: a Landlock ruleset. Landlock only grants, so
// "everything but the project" is spelled out: every entry beside each folder on the way from / to the
// project is granted the write rights, the project's own branch is not, and the lease's folders are
// granted again even when they lie inside it. What it cannot grant is a new entry directly in one of
// those ancestors (a new file in $HOME itself); that is the price, and the runtimes do not need it.
// The ruleset is built in the daemon (it lists folders, which is no work for a forked child) and the
// child only restricts itself to it before exec. macOS: sandbox-exec with a profile that denies writes
// under the project.

#include "paperboat/sandbox.hpp"

#include <cerrno>
#include <cstring>
#include <stdexcept>
#include <system_error>

#ifdef __linux__
#include <fcntl.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <cstdint>
#endif

namespace paperboat {

namespace {

// `inner` is `outer` or lies under it (both canonical).
bool within(const fs::path& inner, const fs::path& outer) {
  const fs::path r = inner.lexically_relative(outer);
  return !r.empty() && *r.begin() != "..";
}

fs::path canonical_or_self(const fs::path& p) {
  std::error_code ec;
  const fs::path c = fs::weakly_canonical(p, ec);
  return ec ? p : c;
}

}  // namespace

#ifdef __linux__

namespace {

#ifndef SYS_landlock_create_ruleset
#define SYS_landlock_create_ruleset 444  // the same on every architecture
#endif
#ifndef SYS_landlock_add_rule
#define SYS_landlock_add_rule 445
#endif
#ifndef SYS_landlock_restrict_self
#define SYS_landlock_restrict_self 446
#endif

// <linux/landlock.h>, spelled out so an older header builds: ABI 1 rights, REFER (2), TRUNCATE (3).
constexpr std::uint64_t kWriteFile = 1ull << 1, kRemoveDir = 1ull << 4, kRemoveFile = 1ull << 5, kMakeChar = 1ull << 6,
                        kMakeDir = 1ull << 7, kMakeReg = 1ull << 8, kMakeSock = 1ull << 9, kMakeFifo = 1ull << 10,
                        kMakeBlock = 1ull << 11, kMakeSym = 1ull << 12, kRefer = 1ull << 13, kTruncate = 1ull << 14;
constexpr unsigned kCreateRulesetVersion = 1u << 0;
constexpr int kRulePathBeneath = 1;

struct RulesetAttr {
  std::uint64_t handled_access_fs;  // the kernel takes a prefix of its struct: the later fields stay 0
};

struct __attribute__((packed)) PathBeneath {
  std::uint64_t allowed_access;
  std::int32_t parent_fd;
};

int abi() { return static_cast<int>(::syscall(SYS_landlock_create_ruleset, nullptr, 0, kCreateRulesetVersion)); }

}  // namespace

std::string ReadOnlyProject::mechanism(std::string* why) {
  const int v = abi();
  std::string no;
  if (v < 0 && errno == EOPNOTSUPP) no = "Landlock is turned off in this kernel (it needs landlock in the lsm= boot list)";
  else if (v < 0) no = "this kernel has no Landlock (Linux 5.19 or later has it)";
  else if (v < 2) no = "this kernel's Landlock is ABI " + std::to_string(v) + "; renames across folders need ABI 2 (Linux 5.19)";
  if (why) *why = no;
  return no.empty() ? "Landlock" : "";
}

ReadOnlyProject::ReadOnlyProject(const fs::path& project_in, const std::vector<fs::path>& writable) {
  std::string why;
  if (mechanism(&why).empty()) throw std::runtime_error(why);
  const int v = abi();
  std::uint64_t handled = kWriteFile | kRemoveDir | kRemoveFile | kMakeChar | kMakeDir | kMakeReg | kMakeSock | kMakeFifo |
                          kMakeBlock | kMakeSym | kRefer;
  if (v >= 3) handled |= kTruncate;
  const std::uint64_t file_rights = handled & (kWriteFile | kTruncate);  // all a non-folder can be granted

  const RulesetAttr attr{handled};
  ruleset_ = static_cast<int>(::syscall(SYS_landlock_create_ruleset, &attr, sizeof attr, 0));  // O_CLOEXEC
  if (ruleset_ < 0) throw std::runtime_error(std::string("Landlock: cannot create a ruleset: ") + std::strerror(errno));

  auto grant = [&](const fs::path& p) {
    const int fd = ::open(p.c_str(), O_PATH | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return;  // gone, or not ours to see: nothing to grant
    struct stat st {};
    if (::fstat(fd, &st) == 0 && !S_ISLNK(st.st_mode)) {
      const PathBeneath rule{S_ISDIR(st.st_mode) ? handled : file_rights, fd};
      ::syscall(SYS_landlock_add_rule, ruleset_, kRulePathBeneath, &rule, 0);
    }
    ::close(fd);
  };

  const fs::path project = canonical_or_self(project_in);
  // Every entry beside the way down to the project. A symbolic link is skipped: what it points at is
  // granted (or not) where it really is, and one that points into the project must not open it.
  fs::path at = project.root_path();
  const fs::path down = project.relative_path();
  for (auto part = down.begin(); part != down.end(); ++part) {
    std::error_code ec;
    for (const auto& e : fs::directory_iterator(at, ec)) {
      if (e.path().filename() == *part) continue;
      std::error_code lec;
      if (e.is_symlink(lec)) continue;
      grant(e.path());
    }
    at /= *part;
  }
  for (const auto& w : writable)
    if (!w.empty() && !within(project, canonical_or_self(w))) grant(canonical_or_self(w));  // never one that holds the project
}

ReadOnlyProject::~ReadOnlyProject() {
  if (ruleset_ >= 0) ::close(ruleset_);
}

std::function<void()> ReadOnlyProject::in_child() const {
  const int fd = ruleset_;
  return [fd] {
    // Async-signal-safe only: this runs between fork and exec in a threaded daemon.
    if (::prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 || ::syscall(SYS_landlock_restrict_self, fd, 0) != 0) {
      static const char msg[] = "paperboat: could not make the project read-only (Landlock); not starting\n";
      [[maybe_unused]] const auto n = ::write(STDERR_FILENO, msg, sizeof msg - 1);
      ::_exit(126);
    }
    ::close(fd);
  };
}

#elif defined(__APPLE__)

std::string ReadOnlyProject::mechanism(std::string* why) {
  std::error_code ec;
  const bool ok = fs::exists("/usr/bin/sandbox-exec", ec);
  if (why) *why = ok ? "" : "/usr/bin/sandbox-exec is missing";
  return ok ? "sandbox-exec" : "";
}

ReadOnlyProject::ReadOnlyProject(const fs::path&, const std::vector<fs::path>&) {
  std::string why;
  if (mechanism(&why).empty()) throw std::runtime_error(why);
}

ReadOnlyProject::~ReadOnlyProject() = default;

std::function<void()> ReadOnlyProject::in_child() const { return nullptr; }

#else

std::string ReadOnlyProject::mechanism(std::string* why) {
  if (why) *why = "this system has no way to make a native process's project read-only";
  return "";
}

ReadOnlyProject::ReadOnlyProject(const fs::path&, const std::vector<fs::path>&) {
  std::string why;
  mechanism(&why);
  throw std::runtime_error(why);
}

ReadOnlyProject::~ReadOnlyProject() = default;

std::function<void()> ReadOnlyProject::in_child() const { return nullptr; }

#endif

std::vector<std::string> sandbox_exec_prefix(const fs::path& project, const std::vector<fs::path>& writable) {
  auto quoted = [](const fs::path& p) {
    std::string out = "\"";
    for (const char c : canonical_or_self(p).string()) {
      if (c == '"' || c == '\\') out += '\\';
      out += c;
    }
    return out + "\"";
  };
  // The last rule that matches wins: everything, then not the project, then the lease's folders again.
  std::string profile = "(version 1)(allow default)(deny file-write* (subpath " + quoted(project) + "))";
  for (const auto& w : writable)
    if (!w.empty() && !within(canonical_or_self(project), canonical_or_self(w)))
      profile += "(allow file-write* (subpath " + quoted(w) + "))";
  return {"/usr/bin/sandbox-exec", "-p", profile};
}

}  // namespace paperboat
