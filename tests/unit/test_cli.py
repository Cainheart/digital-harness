from __future__ import annotations

import os

from app import cli


def test_cli_sets_persistent_root_before_starting_uvicorn(monkeypatch, tmp_path):
    captured = {}

    def fake_run(app, *, host, port, factory):
        captured.update({"app": app, "host": host, "port": port, "factory": factory})

    monkeypatch.setattr(cli.uvicorn, "run", fake_run)

    monkeypatch.setattr(
        "sys.argv",
        ["digital-harness", "--persistent-root", str(tmp_path), "--port", "9876"],
    )
    cli.main()

    assert os.environ["DIGITAL_HARNESS_PERSISTENT_ROOT"] == str(tmp_path)
    assert captured == {
        "app": "app.main:app",
        "host": "127.0.0.1",
        "port": 9876,
        "factory": False,
    }
