from dataclasses import FrozenInstanceError
from datetime import timezone

import pytest

from app.domain.common import Actor, Page, ProjectStatus, TaskStatus, new_object_id, utc_now


def test_project_and_task_statuses_match_the_frozen_task2_contract():
    assert {status.value for status in ProjectStatus} == {
        "准备中",
        "运行中",
        "等待 Boss",
        "已暂停",
        "已阻塞",
        "结项中",
        "已结项",
        "已终止",
    }
    assert {status.value for status in TaskStatus} == {
        "待处理",
        "进行中",
        "等待 Review",
        "等待审批",
        "阻塞",
        "返工",
        "已完成",
        "已终止",
    }


def test_object_ids_have_safe_type_prefix_randomness_and_time_order():
    first = new_object_id("project")
    second = new_object_id("project")

    assert first.startswith("project_")
    assert second.startswith("project_")
    assert first != second
    assert first.split("_", 1)[1][:13].isdigit()
    assert int(first.split("_", 1)[1][:13]) <= int(second.split("_", 1)[1][:13])
    assert len(first.split("_", 1)[1]) >= 30


@pytest.mark.parametrize("kind", ["", " ", "Project", "project/escape", "project..", "project$key"])
def test_object_id_rejects_an_unsafe_or_empty_kind(kind):
    with pytest.raises(ValueError):
        new_object_id(kind)


def test_utc_now_is_timezone_aware_utc():
    value = utc_now()

    assert value.tzinfo is not None
    assert value.utcoffset() == timezone.utc.utcoffset(value)


def test_actor_is_frozen_and_page_uses_a_stable_cursor():
    actor = Actor(type="boss", id="boss-local")
    page = Page(items=["event-1"], next_cursor="event-1", has_more=True)

    assert actor.type == "boss"
    assert page.items == ("event-1",)
    assert page.next_cursor == "event-1"
    with pytest.raises(FrozenInstanceError):
        actor.id = "other"


@pytest.mark.parametrize("kwargs", [{"type": "", "id": "boss"}, {"type": "boss", "id": ""}])
def test_actor_rejects_blank_identity_parts(kwargs):
    with pytest.raises(ValueError):
        Actor(**kwargs)
