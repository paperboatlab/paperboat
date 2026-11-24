#include "paperboat/backend.hpp"
#include "paperboat/catalog.hpp"
#include "paperboat/manifest.hpp"

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_string.hpp>

#include <algorithm>
#include <fstream>

using namespace paperboat;
using Catch::Matchers::ContainsSubstring;

namespace {

const char* kMinimal = R"(
name = "tiny"
version = "1.2.3"
protocol = "paperboat-runtime/0"
modes = ["station", "exec"]
[image]
ref = "example.org/tiny:1.2.3"
digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
[entry]
station = ["tiny", "--serve", "{ipc}/control.sock", "--lease={lease}"]
)";

bool has(const std::vector<std::string>& v, const std::string& s) { return std::ranges::find(v, s) != v.end(); }

}  // namespace

TEST_CASE("a manifest parses with defaults", "[manifest]") {
  const Manifest m = parse_manifest(kMinimal);
  CHECK(m.id() == "tiny@1.2.3");
  CHECK(m.pinned());
  CHECK(m.image() == "example.org/tiny@sha256:0000000000000000000000000000000000000000000000000000000000000000");
  CHECK(m.mounts.at("ipc") == "/run/pb");
  CHECK(m.mounts.at("project") == "/work/project");
  CHECK(m.has_mode("station"));
  CHECK_FALSE(m.has_mode("session"));
}

TEST_CASE("an image ref with a registry port keeps it", "[manifest]") {
  Manifest m;
  m.image_ref = "localhost:5000/x/tiny:1";
  m.image_digest = "sha256:ab";
  CHECK(m.image() == "localhost:5000/x/tiny@sha256:ab");
  m.image_ref = "localhost:5000/x/tiny";
  CHECK(m.image() == "localhost:5000/x/tiny@sha256:ab");
}

TEST_CASE("manifest errors name the key", "[manifest]") {
  CHECK_THROWS_WITH(parse_manifest("name='x'\nversion='1'\nprotocol='p'\nmodes=['exec']\n"),
                    ContainsSubstring("a runtime needs an [image] or a [native] recipe"));
  CHECK_THROWS_WITH(parse_manifest("name='X'\nversion='1'\nprotocol='p'\nmodes=['exec']\n[native]\nrequires='x'\n"),
                    ContainsSubstring("name"));
  CHECK_THROWS_WITH(parse_manifest("name='x'\nversion='1'\nprotocol='p'\nmodes=['fly']\n[native]\nrequires='x'\n"),
                    ContainsSubstring("unknown mode"));
  CHECK_THROWS_WITH(parse_manifest("name='x'\nversion='1'\nprotocol='p'\nmodes=['station']\n[image]\nref='r'\n"),
                    ContainsSubstring("entry.station"));
  CHECK_THROWS_WITH(parse_manifest("name='x'\nversion='1'\nprotocol='p'\nmodes=['exec']\n[image]\nref='r'\ndigest='sha256:XY'\n"),
                    ContainsSubstring("image.digest"));
  CHECK_THROWS_WITH(parse_manifest("name='x'\nversion='1'\nprotocol='p'\nmodes=['exec']\nshell=true\n[image]\nref='r'\n"),
                    ContainsSubstring("shell: unknown key"));
  CHECK_THROWS_WITH(parse_manifest("name='x'\nversion='1'\nprotocol='p'\nmodes=['exec']\n[image]\nref='r'\n[mounts]\nipc='rel'\n"),
                    ContainsSubstring("mounts.ipc"));
}

TEST_CASE("versions compare numerically and match by prefix", "[manifest]") {
  CHECK(compare_versions("1.11.6", "1.9.3") > 0);
  CHECK(compare_versions("1.11", "1.11.0") < 0);
  CHECK(compare_versions("3.12", "3.12") == 0);
  CHECK(version_matches("1.11", "1.11.6"));
  CHECK(version_matches("1.11", "1.11.6-r2"));
  CHECK_FALSE(version_matches("1.1", "1.11.6"));
  CHECK_FALSE(version_matches("1.11.6.1", "1.11.6"));
  CHECK(version_matches("", "anything"));
}

TEST_CASE("placeholders expand", "[manifest]") {
  const auto out = expand({"a", "{ipc}/s.sock", "--x={lease}-{lease}", "{nope}"}, {{"ipc", "/run/pb"}, {"lease", "L"}});
  CHECK(out == std::vector<std::string>{"a", "/run/pb/s.sock", "--x=L-L", "{nope}"});
}

TEST_CASE("a runtime is added by file alone", "[catalog]") {
  const fs::path dir = fs::temp_directory_path() / "pb-catalog-test";
  fs::remove_all(dir);
  fs::create_directories(dir / "tiny");
  std::ofstream(dir / "tiny" / "runtime.toml") << kMinimal;
  std::ofstream(dir / "newer.runtime.toml") << std::string(kMinimal).replace(std::string(kMinimal).find("1.2.3"), 5, "1.10.0");
  std::ofstream(dir / "broken.runtime.toml") << "name = ";
  Catalog c;
  c.add_dir(dir);
  REQUIRE(c.all().size() == 2);
  CHECK(c.errors().size() == 1);
  CHECK(c.resolve("tiny")->version == "1.10.0");  // newest
  CHECK(c.resolve("tiny@1.2")->version == "1.2.3");
  CHECK(c.resolve("tiny@2") == nullptr);
  CHECK(c.resolve("other") == nullptr);
  fs::remove_all(dir);
}

TEST_CASE("the shipped runtimes parse and are pinned", "[catalog]") {
  Catalog c;
  c.add_dir(PAPERBOAT_SOURCE_RUNTIMES);
  CHECK(c.errors().empty());
  for (const char* name : {"julia", "python", "omc"}) {
    const Manifest* m = c.resolve(name);
    REQUIRE(m);
    CHECK(m->pinned());
    CHECK(m->has_mode("exec"));
    CHECK_FALSE(m->native_requires.empty());
  }
}

TEST_CASE("isolation defaults are the strictest", "[policy]") {
  const Manifest m = parse_manifest(kMinimal);
  LaunchSpec spec;
  spec.manifest = &m;
  spec.mode = "station";
  spec.ipc = "/state/leases/L/ipc";
  spec.deps = "/state/deps/tiny/none";

  const auto podman = isolation_flags(spec, "podman", false);
  for (const char* f : {"--network=none", "--read-only", "--cap-drop=all", "no-new-privileges", "--userns=keep-id"})
    CHECK(has(podman, f));
  CHECK(has(podman, "/state/leases/L/ipc:/run/pb:rw"));
  CHECK_FALSE(has(podman, "label=disable"));

  const auto docker = isolation_flags(spec, "docker", false);
  CHECK(has(docker, "--user"));
  CHECK_FALSE(has(docker, "--userns=keep-id"));

  SECTION("SELinux relabels only the daemon's own folders") {
    const auto f = isolation_flags(spec, "podman", true);
    CHECK(has(f, "/state/leases/L/ipc:/run/pb:rw,Z"));
    CHECK_FALSE(has(f, "label=disable"));
    spec.project = "/home/u/project";
    const auto g = isolation_flags(spec, "podman", true);
    CHECK(has(g, "label=disable"));
    CHECK(has(g, "/home/u/project:/work/project:ro"));
    CHECK(has(g, "/state/leases/L/ipc:/run/pb:rw"));  // no relabel once labelling is off
  }
  SECTION("a policy only weakens what it names") {
    spec.policy.network = true;
    spec.policy.devices = {"/dev/video0"};
    spec.project = "/p";
    spec.policy.writable_project = true;
    const auto f = isolation_flags(spec, "podman", false);
    CHECK_FALSE(has(f, "--network=none"));
    CHECK(has(f, "--read-only"));
    CHECK(has(f, "/dev/video0"));
    CHECK(has(f, "/p:/work/project:rw"));
    CHECK(spec.policy.weakened() == std::vector<std::string>{"network", "device /dev/video0", "writable project"});
  }
}

TEST_CASE("the OCI command carries labels, env and the entry", "[backend]") {
  const Manifest m = parse_manifest(kMinimal);
  auto b = make_oci_backend("podman", "/usr/bin/podman");
  LaunchSpec spec;
  spec.manifest = &m;
  spec.mode = "station";
  spec.name = "pb-tiny-1-2-3-none-1";
  spec.labels = {{"paperboat.daemon", "boot:1"}};
  const auto cmd = b->command(spec);
  CHECK(cmd[0] == "/usr/bin/podman");
  CHECK(has(cmd, "--init"));
  CHECK(has(cmd, "paperboat.daemon=boot:1"));
  CHECK(has(cmd, "PAPERBOAT_IPC=/run/pb"));
  CHECK(has(cmd, m.image()));
  CHECK(cmd.back() == "--lease=pb-tiny-1-2-3-none-1");
  CHECK(has(cmd, "/run/pb/control.sock"));
}
