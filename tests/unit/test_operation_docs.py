from pathlib import Path


OPERATIONS = Path(__file__).resolve().parents[2] / "docs" / "operations"


def test_operation_documents_cover_task1_required_topics():
    content = "\n".join(path.read_text() for path in OPERATIONS.glob("*.md"))

    for required in (
        "Python 3.12",
        "Node.js",
        "Docker Desktop",
        "Docker Engine",
        "Keychain",
        "persistent-root",
        "Schema",
        "readiness",
        "工作区",
        "secretRef",
    ):
        assert required in content
