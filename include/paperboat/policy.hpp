#pragma once

// What a runtime may do beyond the defaults. The defaults are the strictest: no network, read-only
// root, no capabilities, no new privileges, limits, project read-only. A field set here only ever
// weakens them, and every weakening is listed (weakened()) so a user sees and confirms it.

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace paperboat {

struct Policy {
  bool network = false;               // a network namespace with outbound access
  std::vector<std::string> devices;   // host devices, e.g. "/dev/video0"
  bool gpu = false;                   // GPU devices (CDI: nvidia.com/gpu=all)
  bool ipc_host = false;              // the host's IPC namespace
  bool writable_project = false;      // mount the project read-write

  std::vector<std::string> weakened() const;
  bool operator==(const Policy&) const = default;
};

nlohmann::json to_json(const Policy& p);
Policy policy_from_json(const nlohmann::json& j);  // unknown keys are an error

}  // namespace paperboat
