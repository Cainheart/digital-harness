from pathlib import Path


def test_vite_dev_server_proxies_api_to_local_backend():
    config = (Path(__file__).resolve().parents[2] / "frontend" / "vite.config.ts").read_text()

    assert '"/api"' in config
    assert "http://127.0.0.1:8765" in config
