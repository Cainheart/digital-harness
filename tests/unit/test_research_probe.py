from __future__ import annotations

import sys

from app.readiness.checkers.research import LocalBrowserProbe
from app.main import _default_browser_executable


async def test_local_browser_probe_reports_available_executable():
    probe = LocalBrowserProbe(executable=sys.executable)

    assert await probe.check() is True


async def test_local_browser_probe_reports_missing_executable():
    probe = LocalBrowserProbe(executable="/path/that/does/not/exist/chromium")

    assert await probe.check() is False


def test_default_browser_discovery_accepts_macos_google_chrome_bundle():
    executable = _default_browser_executable()

    assert executable == "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
