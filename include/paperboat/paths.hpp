#pragma once

#include <filesystem>
#include <string>

namespace paperboat::paths {

namespace fs = std::filesystem;

fs::path home();            // $PAPERBOAT_HOME, else $XDG_DATA_HOME/paperboat, else ~/.local/share/paperboat
fs::path runtime_dir();     // $PAPERBOAT_RUNTIME_DIR, else $XDG_RUNTIME_DIR/paperboat, else <tmp>/paperboat-<uid>
fs::path control_socket();  // runtime_dir()/control.sock
fs::path exe_dir();         // the folder of the running binary
std::string boot_id();      // this boot's id ("" where the OS has none)

}  // namespace paperboat::paths
