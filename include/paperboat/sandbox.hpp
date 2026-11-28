#pragma once

// A read-only project for a native process (pb#85): the project folder can be read and run, never
// written, and the rest of the file system stays as it was. Linux: Landlock (5.19+, ABI 2: it must
// allow renames across the folders it leaves writable); macOS: sandbox-exec. A container gets the same
// from its `:ro` mount, so this is the native backend's half.

#include <filesystem>
#include <functional>
#include <string>
#include <vector>

namespace paperboat {

namespace fs = std::filesystem;

class ReadOnlyProject {
 public:
  // `writable`: folders that stay writable even inside the project (the lease's work, deps, ipc).
  // Throws std::runtime_error saying what this host lacks.
  ReadOnlyProject(const fs::path& project, const std::vector<fs::path>& writable);
  ~ReadOnlyProject();
  ReadOnlyProject(const ReadOnlyProject&) = delete;
  ReadOnlyProject& operator=(const ReadOnlyProject&) = delete;

  // What to run in the child just before exec (Linux: restrict it to the ruleset); empty elsewhere.
  std::function<void()> in_child() const;

  // "Landlock" or "sandbox-exec" when this host can, else "" and `why` says why not.
  static std::string mechanism(std::string* why = nullptr);

 private:
  int ruleset_ = -1;
};

// macOS: the argv prefix that runs a command under a sandbox-exec profile denying writes to the project
// (and allowing them again in `writable`). Pure, so a test can read it anywhere.
std::vector<std::string> sandbox_exec_prefix(const fs::path& project, const std::vector<fs::path>& writable);

}  // namespace paperboat
