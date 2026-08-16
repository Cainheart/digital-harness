import json

import pytest
from pydantic import ValidationError

from app.domain.commands import CommandEnvelope, CommandResult, canonical_request_hash
from app.domain.common import Actor
from app.domain.errors import (
    ArtifactIntegrityError,
    ArtifactTooLargeError,
    EvidenceIncompleteError,
    IdempotencyKeyReusedError,
    InvalidArgumentError,
    NotFoundError,
    ReadOnlyProjectError,
    Task2DomainError,
    TraceLinkInvalidError,
    VersionConflictError,
)


def _command(**payload):
    return CommandEnvelope(
        commandId="cmd_01J",
        idempotencyKey="project-start-01J",
        aggregateId="project_01J",
        expectedVersion=12,
        actor={"type": "boss", "id": "boss-local"},
        payload=payload,
    )


def test_command_envelope_and_result_use_task2_fields_and_reject_extra():
    command = _command(action="start")
    result = CommandResult(
        aggregateId="project_01J",
        version=13,
        eventId="event_01J",
        allowedActions=("pause", "terminate"),
        traceId="trace_01J",
    )

    assert command.actor == Actor(type="boss", id="boss-local")
    assert command.expected_version == 12
    assert result.allowed_actions == ("pause", "terminate")
    with pytest.raises(ValidationError):
        CommandEnvelope(
            commandId="cmd_01J",
            idempotencyKey="project-start-01J",
            aggregateId="project_01J",
            expectedVersion=12,
            actor={"type": "boss", "id": "boss-local"},
            payload={"action": "start"},
            unexpected="reject",
        )
    with pytest.raises(ValidationError):
        CommandEnvelope(
            commandId="cmd_01J",
            idempotencyKey="project-start-01J",
            aggregateId="project_01J",
            expectedVersion=-1,
            actor={"type": "boss", "id": "boss-local"},
            payload={"action": "start"},
        )


@pytest.mark.parametrize(
    "reserved_key",
    [
        "commandId",
        "command_id",
        "idempotencyKey",
        "idempotency_key",
        "aggregateId",
        "aggregate_id",
        "expectedVersion",
        "expected_version",
        "actor",
        "payload",
    ],
)
def test_command_payload_rejects_camel_and_snake_reserved_envelope_keys(reserved_key):
    with pytest.raises(ValidationError):
        _command(**{reserved_key: "spoofed"})


def test_canonical_request_hash_is_stable_for_key_order_and_matches_sha256_json():
    left = _command(action="start", options={"b": 2, "a": 1})
    right = CommandEnvelope(
        payload={"options": {"a": 1, "b": 2}, "action": "start"},
        actor={"id": "boss-local", "type": "boss"},
        aggregateId="project_01J",
        commandId="cmd_01J",
        expectedVersion=12,
        idempotencyKey="project-start-01J",
    )

    assert canonical_request_hash(left) == canonical_request_hash(right)
    canonical_json = json.dumps(
        left.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    import hashlib

    assert canonical_request_hash(left) == hashlib.sha256(canonical_json.encode()).hexdigest()


@pytest.mark.parametrize(
    "error_type, code, status_code",
    [
        (InvalidArgumentError, "INVALID_ARGUMENT", 400),
        (VersionConflictError, "VERSION_CONFLICT", 409),
        (IdempotencyKeyReusedError, "IDEMPOTENCY_KEY_REUSED", 409),
        (NotFoundError, "NOT_FOUND", 404),
        (ReadOnlyProjectError, "READ_ONLY_PROJECT", 409),
        (ArtifactIntegrityError, "ARTIFACT_INTEGRITY_FAILED", 422),
        (ArtifactTooLargeError, "ARTIFACT_TOO_LARGE", 413),
        (TraceLinkInvalidError, "TRACE_LINK_INVALID", 422),
        (EvidenceIncompleteError, "EVIDENCE_INCOMPLETE", 422),
    ],
)
def test_task2_errors_have_stable_payload_and_status(error_type, code, status_code):
    error = error_type(
        trace_id="trace_test",
        message="Authorization: Bearer secret-token",
        data={"api_key": "sk-secret", "safe": "kept"},
    )

    assert isinstance(error, Task2DomainError)
    assert error.code == code
    assert error.status_code == status_code
    payload = error.to_payload()
    assert payload["code"] == code
    assert payload["dataPreserved"] is True
    assert payload["traceId"] == "trace_test"
    serialized = json.dumps(payload, ensure_ascii=False)
    assert "secret-token" not in serialized
    assert "sk-secret" not in serialized
    assert "Bearer secret-token" not in serialized
    assert payload["data"]["safe"] == "kept"


def test_error_payload_has_no_raw_sensitive_input_even_when_passed_in_next_action():
    error = VersionConflictError(
        trace_id="trace_test",
        next_action="rotate api_key=sk-secret and retry",
    )

    payload = error.to_payload()

    assert "sk-secret" not in json.dumps(payload)
    assert payload["nextAction"] != "rotate api_key=sk-secret and retry"
