from app.infra.keychain import KeyringCredentialAdapter, MemoryCredentialAdapter
from app.main import create_app


def test_production_app_uses_os_keychain_adapter(tmp_path):
    app = create_app(persistent_root=tmp_path, test_mode=False)

    assert isinstance(app.state.credentials, KeyringCredentialAdapter)
    assert not isinstance(app.state.credentials, MemoryCredentialAdapter)
