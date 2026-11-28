// The native read-only project (pb#85) against the real kernel: Landlock here, skipped where there is none.

#include "paperboat/process.hpp"
#include "paperboat/sandbox.hpp"

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_string.hpp>

#include <fstream>
#include <random>
#include <thread>

#ifndef _WIN32
#include <sys/wait.h>
#endif

using namespace paperboat;
using Catch::Matchers::ContainsSubstring;

namespace {

std::string slurp(const fs::path& p) {
  std::ifstream in(p);
  return std::string(std::istreambuf_iterator<char>(in), {});
}

}  // namespace

#ifdef __linux__
TEST_CASE("Landlock: the project can be read, not written; the rest stays writable", "[sandbox]") {
  std::string why;
  if (ReadOnlyProject::mechanism(&why).empty()) SKIP(why);
  const fs::path root = fs::temp_directory_path() / ("pb-sandbox-" + std::to_string(std::random_device{}()));
  const fs::path project = root / "examples" / "demo", work = project / "out", beside = root / "mine", log = root / "log.txt";
  fs::create_directories(work);  // a writable folder inside the project, as a lease's may be
  fs::create_directories(beside);
  std::ofstream(project / "data.csv") << "1,2\n";
  fs::create_symlink(project, root / "link");  // a way in by another name must not open it
  const std::string script =
      "cat data.csv; "
      "echo x > new.txt && echo wrote-new; "
      "echo x >> data.csv && echo appended; "
      "truncate -s 0 data.csv && echo truncated; "
      "rm -f data.csv && echo removed; "
      "mkdir sub && echo made-dir; "
      "echo x > ../../link/via-link && echo wrote-via-link; "
      "echo ok > out/result.txt && echo wrote-work; "
      "echo ok > " + (beside / "f").string() + " && echo wrote-beside; "
      "mv " + (beside / "f").string() + " " + (root / "examples" / "moved").string() + " ; "
      "echo ok > " + (root / "examples" / "beside-file").string() + " ; true";
  int pid = -1;
  {
    ReadOnlyProject sandbox(project, {work});
    pid = ProcessRunner::run_detached({"sh", "-c", script}, project, {}, log, sandbox.in_child());
  }
  REQUIRE(pid > 0);
  int status = 0;
  ::waitpid(pid, &status, 0);
  const std::string out = slurp(log);
  INFO(out << " status " << status);
  CHECK_THAT(out, ContainsSubstring("1,2"));  // read
  CHECK_THAT(out, ContainsSubstring("Permission denied"));
  for (const char* never : {"wrote-new", "appended", "truncated", "removed", "made-dir", "wrote-via-link"})
    CHECK_THAT(out, !ContainsSubstring(never));
  CHECK(slurp(project / "data.csv") == "1,2\n");
  CHECK_FALSE(fs::exists(project / "new.txt"));
  CHECK_FALSE(fs::exists(project / "sub"));
  CHECK_FALSE(fs::exists(project / "via-link"));
  CHECK(slurp(work / "result.txt") == "ok\n");  // the lease's folder, though inside the project
  CHECK_THAT(out, ContainsSubstring("wrote-beside"));  // beside it: as before
  CHECK(slurp(beside / "f") == "ok\n");
  // A new entry directly in an ancestor of the project is the one thing Landlock can't leave open.
  CHECK_FALSE(fs::exists(root / "examples" / "moved"));
  CHECK_FALSE(fs::exists(root / "examples" / "beside-file"));
  fs::remove_all(root);
}
#endif

TEST_CASE("sandbox-exec's profile denies writes under the project, then allows the lease's folders", "[sandbox]") {
  const auto p = sandbox_exec_prefix("/Users/u/ex \"q\"", {"/Users/u/state/work", "", "/Users"});
  REQUIRE(p.size() == 3);
  CHECK(p[0] == "/usr/bin/sandbox-exec");
  CHECK(p[1] == "-p");
  CHECK_THAT(p[2], ContainsSubstring("(allow default)(deny file-write* (subpath \"/Users/u/ex \\\"q\\\"\"))"));
  CHECK_THAT(p[2], ContainsSubstring("(allow file-write* (subpath \"/Users/u/state/work\"))"));
  CHECK_THAT(p[2], !ContainsSubstring("(subpath \"/Users\")"));  // one that holds the project is never allowed
}
