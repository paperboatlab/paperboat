#include "paperboat/policy.hpp"

#include <stdexcept>

namespace paperboat {

std::vector<std::string> Policy::weakened() const {
  std::vector<std::string> out;
  if (network) out.emplace_back("network");
  for (const auto& d : devices) out.push_back("device " + d);
  if (gpu) out.emplace_back("gpu");
  if (ipc_host) out.emplace_back("host IPC");
  if (writable_project) out.emplace_back("writable project");
  return out;
}

nlohmann::json to_json(const Policy& p) {
  return {{"network", p.network}, {"devices", p.devices}, {"gpu", p.gpu}, {"ipc_host", p.ipc_host},
          {"writable_project", p.writable_project}};
}

Policy policy_from_json(const nlohmann::json& j) {
  Policy p;
  if (j.is_null()) return p;
  if (!j.is_object()) throw std::runtime_error("policy: must be an object");
  for (const auto& [k, v] : j.items()) {
    if (k == "network") p.network = v.get<bool>();
    else if (k == "devices") p.devices = v.get<std::vector<std::string>>();
    else if (k == "gpu") p.gpu = v.get<bool>();
    else if (k == "ipc_host") p.ipc_host = v.get<bool>();
    else if (k == "writable_project") p.writable_project = v.get<bool>();
    else throw std::runtime_error("policy: unknown key \"" + k + "\"");
  }
  return p;
}

}  // namespace paperboat
