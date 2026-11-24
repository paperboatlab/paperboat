# Findings the image scan ignores, each with its reason (GUIDELINES: a CVE is fixed by a newer pin, or
# ignored here with why; never silenced in the workflow). Trivy reads this with --ignore-policy.
package trivy

import rego.v1

default ignore := false

# linux-libc-dev holds the kernel's header files. A container runs on the host's kernel: these headers
# ship no kernel code, so a kernel CVE in them can't be reached from the image (OpenModelica's base).
ignore if input.PkgName == "linux-libc-dev"
