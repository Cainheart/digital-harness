from pathlib import Path


def test_pytest_config_explicitly_includes_workspace_root_and_tests():
    """标准 pytest 命令必须能导入 backend 和 tests.support。"""
    config = (Path(__file__).parents[2] / "pytest.ini").read_text(encoding="utf-8")
    pythonpath_line = next(line for line in config.splitlines() if line.startswith("pythonpath"))
    testpaths_line = next(line for line in config.splitlines() if line.startswith("testpaths"))
    assert "." in pythonpath_line.split("=", 1)[1].split()
    assert testpaths_line.split("=", 1)[1].strip() == "tests"
