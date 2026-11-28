// update.hpp on its own (pb#94): which packages a system takes, the SHA-256 they are held to, the command that
// installs them and what its exit means. Nothing here downloads or installs.

#include "update.hpp"

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_string.hpp>

#include <filesystem>
#include <fstream>
#include <random>

using namespace paperboat::update;
using Catch::Matchers::ContainsSubstring;
namespace fs = std::filesystem;

namespace {

// beta.10's files as GitHub lists them, plus a SHA256SUMS and a deb build for the Ubuntu case (#2)
const std::vector<Asset> kRelease = {
    {"paperboat-0.2.0-Darwin.pkg", "u/pkg", "sha256:8b66ee2337ffc34a070d04f1b5802f1f0396526e3e4dc103025e47fb692f784b", 1706223},
    {"paperboat-cli-0.2.0-0.beta.10.x86_64.rpm", "u/cli", "sha256:16f2f7bb3c7ea3d4668a9d4ec300e1785fa473605a95222567429ec0f38c6819", 882424},
    {"paperboat-devel-0.2.0-0.beta.10.x86_64.rpm", "u/devel", "sha256:715bdd56d5cd527f17a74db92682c141453588ba6758fd145cc01cf8e83822c9", 500354},
    {"paperboat-launcher-0.2.0-beta.10.x86_64.rpm", "u/launcher", "", 92611545},
    {"paperboat-cli_0.2.0~beta.10_amd64.deb", "u/cli.deb", "", 1},
    {"paperboat-devel_0.2.0~beta.10_amd64.deb", "u/devel.deb", "", 1},
    {"SHA256SUMS", "u/sums", "", 400},
};

std::vector<std::string> names(const std::vector<Asset>& a) {
  std::vector<std::string> out;
  for (const auto& x : a) out.push_back(x.name);
  return out;
}

}  // namespace

TEST_CASE("update: the system is read from its words", "[update]") {
  const System s = parse_system("rpm x86_64 cli devel launcher");
  CHECK(s.kind == "rpm");
  CHECK(s.arch == "x86_64");
  CHECK(s.parts == std::vector<std::string>{"cli", "devel", "launcher"});
  CHECK(parse_system("").kind.empty());
}

TEST_CASE("update: each installed package takes its own file of the release", "[update]") {
  CHECK(names(choose(kRelease, parse_system("rpm x86_64 cli devel launcher"))) ==
        std::vector<std::string>{"paperboat-cli-0.2.0-0.beta.10.x86_64.rpm", "paperboat-devel-0.2.0-0.beta.10.x86_64.rpm",
                                 "paperboat-launcher-0.2.0-beta.10.x86_64.rpm"});
  // without the Launcher installed, its 92 MB stay where they are
  CHECK(names(choose(kRelease, parse_system("rpm x86_64 cli devel"))).size() == 2);
  CHECK(names(choose(kRelease, parse_system("deb x86_64 cli devel"))) ==
        std::vector<std::string>{"paperboat-cli_0.2.0~beta.10_amd64.deb", "paperboat-devel_0.2.0~beta.10_amd64.deb"});
  CHECK(names(choose(kRelease, parse_system("pkg arm64 cli devel"))) == std::vector<std::string>{"paperboat-0.2.0-Darwin.pkg"});
}

TEST_CASE("update: a release without this system's package installs nothing, and says so", "[update]") {
  CHECK_THROWS_WITH(choose(kRelease, parse_system("rpm aarch64 cli devel")), ContainsSubstring("no rpm of paperboat-cli for aarch64"));
  CHECK_THROWS_WITH(choose(kRelease, parse_system("deb x86_64 cli devel launcher")), ContainsSubstring("paperboat-launcher"));
  CHECK_THROWS_WITH(choose(kRelease, parse_system("pkg x86_64 cli devel")), ContainsSubstring("Apple silicon"));
  CHECK_THROWS_WITH(choose({}, parse_system("pkg arm64 cli devel")), ContainsSubstring("no macOS package"));
  CHECK_THROWS(choose(kRelease, parse_system("")));                // a build from source
  CHECK_THROWS(choose(kRelease, parse_system("rpm x86_64")));      // nothing of ours installed
}

TEST_CASE("update: the SHA-256 is GitHub's digest, else the release's SHA256SUMS", "[update]") {
  const auto sums = parse_sums(
      "AA4E2BEFF55A14420B4829DD6385058C44DB5ED4BCBBC208599BE095D897A0FD  paperboat-launcher-0.2.0-beta.10.x86_64.rpm\r\n"
      "16f2f7bb3c7ea3d4668a9d4ec300e1785fa473605a95222567429ec0f38c6819 *paperboat-cli_0.2.0~beta.10_amd64.deb\n"
      "not a sum  paperboat-devel_0.2.0~beta.10_amd64.deb\n\n");
  CHECK(sums.size() == 2);
  CHECK(expected_sha256(kRelease[1], sums) == "16f2f7bb3c7ea3d4668a9d4ec300e1785fa473605a95222567429ec0f38c6819");
  CHECK(expected_sha256(kRelease[3], sums) == "aa4e2beff55a14420b4829dd6385058c44db5ed4bcbbc208599be095d897a0fd");
  CHECK(expected_sha256(kRelease[4], sums) == "16f2f7bb3c7ea3d4668a9d4ec300e1785fa473605a95222567429ec0f38c6819");
  CHECK(expected_sha256(kRelease[5], sums).empty());  // neither: refused
  CHECK(expected_sha256({"x", "u", "sha256:short", 0}, {}).empty());
}

TEST_CASE("update: SHA-256 matches FIPS 180-4's examples", "[update]") {
  CHECK(sha256_hex("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  CHECK(sha256_hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  CHECK(sha256_hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq") == "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  CHECK(sha256_hex(std::string(1000000, 'a')) == "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  // 55 and 56 bytes: the length fits after the padding, or takes one more block
  CHECK(sha256_hex(std::string(55, 'a')) == "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318");
  CHECK(sha256_hex(std::string(56, 'a')) == "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a");
  const fs::path f = fs::temp_directory_path() / ("pb-sha-" + std::to_string(std::random_device{}()));
  std::ofstream(f, std::ios::binary) << std::string(200000, 'x') << '\0' << "tail";
  std::string all(200000, 'x');
  all += '\0';
  all += "tail";
  CHECK(sha256_file(f) == sha256_hex(all));
  fs::remove(f);
  CHECK_THROWS(sha256_file(f));
}

TEST_CASE("update: the install asks for the password the system's way, the paths as arguments", "[update]") {
  const std::vector<fs::path> rpms = {"/home/u/cache/a b.rpm", "/home/u/cache/c.rpm"};
  CHECK(install_argv(parse_system("rpm x86_64 cli"), rpms) ==
        std::vector<std::string>{"pkexec", "dnf", "install", "-y", "/home/u/cache/a b.rpm", "/home/u/cache/c.rpm"});
  CHECK(install_argv(parse_system("deb x86_64 cli"), {"/c/x.deb"}) == std::vector<std::string>{"pkexec", "apt-get", "install", "-y", "/c/x.deb"});
  const auto mac = install_argv(parse_system("pkg arm64 cli devel"), {"/Users/u/it's here/p.pkg"});
  CHECK(mac.front() == "osascript");
  CHECK(mac.back() == "/Users/u/it's here/p.pkg");  // an argument of the script, never spliced into it
  CHECK_THAT(mac[4], ContainsSubstring("quoted form of (item 1 of argv)"));
  CHECK_THAT(mac[4], ContainsSubstring("with administrator privileges"));
  CHECK_THAT(mac[4], ContainsSubstring("/usr/sbin/installer -pkg"));
  CHECK_THROWS(install_argv(parse_system("pkg arm64 cli"), {"a.pkg", "b.pkg"}));
  CHECK_THROWS(install_argv(parse_system(""), rpms));
}

TEST_CASE("update: dismissing or refusing the password is a cancel, not a failure", "[update]") {
  const System rpm = parse_system("rpm x86_64 cli"), mac = parse_system("pkg arm64 cli");
  CHECK(outcome(rpm, 0, "") == Outcome::installed);
  CHECK(outcome(rpm, 126, "") == Outcome::cancelled);  // the dialog dismissed
  CHECK(outcome(rpm, 127, "Error executing command as another user: Not authorized") == Outcome::cancelled);
  CHECK(outcome(rpm, 1, "Error: Transaction test error") == Outcome::failed);
  CHECK(outcome(mac, 1, "0:113: execution error: User canceled. (-128)") == Outcome::cancelled);
  CHECK(outcome(mac, 1, "installer: Error - the package path specified was invalid") == Outcome::failed);
}
