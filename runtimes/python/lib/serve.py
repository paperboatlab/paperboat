"""Entry point: python3 serve.py <socket> [session|station]  (the mode defaults to $PAPERBOAT_MODE)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import paperboat_runtime  # noqa: E402

if __name__ == "__main__":
    mode = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("PAPERBOAT_MODE", "session")
    paperboat_runtime.serve(sys.argv[1], mode)
