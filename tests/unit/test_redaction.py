from app.security.redaction import redact


def test_redactor_masks_api_keys_and_bearer_tokens():
    text = "Authorization: Bearer abc123secret; key=sk-test-DoNotLeak"

    redacted = redact(text)

    assert "abc123secret" not in redacted
    assert "sk-test-DoNotLeak" not in redacted
    assert "[REDACTED]" in redacted


def test_redactor_masks_explicit_configured_secrets():
    redacted = redact("request failed for secret-value", secrets=["secret-value"])

    assert redacted == "request failed for [REDACTED]"
