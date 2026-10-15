"""Live-mode fixture for the fusion e2e assertions.

The backend browser fixture (tests/webui_fixture.py) registers the same routes in the
same order as converter.py's main(): the three fusion installs first, then the
management pages whose catch-all fallback would otherwise swallow them. This launcher
exists only so the integration config starts that fixture by path.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import tests.webui_fixture as fixture  # noqa: E402

if __name__ == "__main__":
    fixture.main()
