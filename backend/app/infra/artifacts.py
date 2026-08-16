from __future__ import annotations

import hashlib
import os
import shutil
import stat
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping
from uuid import uuid4

from app.domain.errors import ArtifactTooLargeError


@dataclass(frozen=True)
class ArtifactReference:
    """描述已写入 Artifact Store 的内容及其完整性元数据。"""
    artifact_id: str
    sha256: str
    media_type: str
    size: int
    created_at: datetime
    relative_path: str
    project_id: str | None = None
    metadata: Mapping[str, str] | None = None


@dataclass(frozen=True)
class ArtifactVerification:
    """描述交付物是否仍与提交时的摘要和大小一致。"""
    valid: bool
    actual_sha256: str | None
    reason: str | None = None


@dataclass(frozen=True)
class ArtifactDeleteReport:
    """报告单个项目 Artifact 文件的删除结果，不掩盖失败路径。"""

    project_id: str
    deleted_paths: tuple[str, ...] = ()
    failed_paths: tuple[str, ...] = ()


# Task 2 文档把项目级清理结果称为 DeleteReport；别名保持接口名称与实现名称兼容。
DeleteReport = ArtifactDeleteReport


class FileArtifactStore:
    """在持久化根目录内按项目和 SHA-256 保存可校验的证据文件。"""

    def __init__(self, root: Path, *, max_size_bytes: int = 64 * 1024 * 1024) -> None:
        """创建 ArtifactStore，并冻结单个证据文件的最大大小。"""
        if not isinstance(max_size_bytes, int) or max_size_bytes < 0:
            raise ValueError("max_size_bytes must be a non-negative integer")
        self.root = Path(os.path.abspath(root))
        self._assert_no_follow_path(self.root)
        self.max_size_bytes = max_size_bytes
        self.root.mkdir(parents=True, exist_ok=True)
        self._assert_no_follow_path(self.root)

    async def put(
        self,
        content: bytes,
        *,
        media_type: str,
        metadata: Mapping[str, str],
    ) -> ArtifactReference:
        """校验大小/MIME/项目元数据后，以临时文件原子提交内容寻址文件。"""
        if not isinstance(metadata, Mapping):
            raise ValueError("metadata must be a mapping")
        project_id = metadata.get("projectId")
        if not isinstance(project_id, str):
            raise ValueError("projectId must be a single path component")
        if (
            not project_id
            or Path(project_id).name != project_id
            or project_id in {".", ".."}
            or "/" in project_id
            or "\\" in project_id
            or "\x00" in project_id
        ):
            raise ValueError("projectId must be a single path component")
        if not isinstance(media_type, str) or not media_type.strip() or any(
            character in media_type for character in "\r\n\x00"
        ):
            raise ValueError("media_type must be non-empty and safe")
        if not isinstance(content, bytes):
            raise ValueError("content must be bytes")
        if len(content) > self.max_size_bytes:
            raise ArtifactTooLargeError(
                f"Artifact size {len(content)} exceeds limit {self.max_size_bytes}",
                data={"size": len(content), "limit": self.max_size_bytes},
            )
        artifact_id = f"art_{uuid4().hex}"
        digest = hashlib.sha256(content).hexdigest()
        relative_path = f"{project_id}/sha256/{digest[:2]}/{digest}"
        destination = self.root / relative_path
        self._assert_no_follow_path(destination.parent)
        destination.parent.mkdir(parents=True, exist_ok=True)
        self._assert_no_follow_path(destination.parent)
        self._assert_no_follow_path(destination)
        temporary: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb", dir=destination.parent, prefix=f".{destination.name}.", delete=False
            ) as handle:
                temporary = Path(handle.name)
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, destination)
            temporary = None
            directory_fd = os.open(destination.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return ArtifactReference(
            artifact_id=artifact_id,
            sha256=digest,
            media_type=media_type,
            size=len(content),
            created_at=datetime.now(timezone.utc),
            relative_path=relative_path,
            project_id=project_id,
            metadata=dict(metadata),
        )

    async def get(self, reference: ArtifactReference) -> bytes:
        """读取经过根目录边界校验的交付物内容。"""
        return self._path(reference).read_bytes()

    async def verify(self, reference: ArtifactReference) -> ArtifactVerification:
        """重新计算文件存在性、大小和摘要，识别缺失或内容篡改。"""
        try:
            content = await self.get(reference)
        except FileNotFoundError:
            return ArtifactVerification(False, None, "artifact is missing")
        except (IsADirectoryError, OSError) as error:
            return ArtifactVerification(False, None, f"artifact is unreadable: {type(error).__name__}")
        actual = hashlib.sha256(content).hexdigest()
        if len(content) != reference.size:
            return ArtifactVerification(False, actual, "size mismatch")
        return ArtifactVerification(
            valid=actual == reference.sha256,
            actual_sha256=actual,
            reason=None if actual == reference.sha256 else "sha256 mismatch",
        )

    async def delete_for_project(self, project_id: str) -> ArtifactDeleteReport:
        """删除一个明确项目目录下的在线 Artifact，并返回逐路径失败报告。"""
        return self.delete_for_project_sync(project_id)

    def delete_for_project_sync(self, project_id: str) -> ArtifactDeleteReport:
        """同步执行项目文件清理，供已提交数据库事务后的删除仓储调用。"""
        self._validate_project_id(project_id)
        project_root = self.root / project_id
        self._assert_no_follow_path(project_root)
        if not project_root.exists():
            return ArtifactDeleteReport(project_id)
        self._assert_no_follow_tree(project_root)
        deleted: list[str] = []
        failed: list[str] = []
        for path in sorted(project_root.rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(self.root).as_posix()
            try:
                path.unlink()
                deleted.append(relative)
            except OSError:
                failed.append(relative)
        if not failed:
            shutil.rmtree(project_root, ignore_errors=False)
        return ArtifactDeleteReport(project_id, tuple(deleted), tuple(failed))

    def project_file_count(self, project_id: str) -> int:
        """返回项目在线文件数，供删除验收和运维诊断使用。"""
        self._validate_project_id(project_id)
        project_root = self.root / project_id
        self._assert_no_follow_path(project_root)
        if not project_root.exists():
            return 0
        self._assert_no_follow_tree(project_root)
        return sum(path.is_file() for path in project_root.rglob("*"))

    @staticmethod
    def _validate_project_id(project_id: str) -> None:
        """限制项目目录名为单一安全路径组件，防止删除范围扩大。"""
        if (
            not isinstance(project_id, str)
            or not project_id
            or Path(project_id).name != project_id
            or project_id in {".", ".."}
            or "/" in project_id
            or "\\" in project_id
            or "\x00" in project_id
        ):
            raise ValueError("projectId must be a single path component")

    def _path(self, reference: ArtifactReference) -> Path:
        """严格解析项目/SHA 内容寻址路径并拒绝跟随任何符号链接。"""
        _, path = self._validate_reference_path(reference)
        self._assert_no_follow_path(path)
        return path

    def _validate_reference_path(self, reference: ArtifactReference) -> tuple[str, Path]:
        """验证引用项目、sha256、前缀和相对路径四段完全一致。"""
        relative_path = getattr(reference, "relative_path", None)
        sha256 = getattr(reference, "sha256", None)
        if not isinstance(relative_path, str) or not isinstance(sha256, str):
            raise ValueError("artifact reference is invalid")
        if (
            len(sha256) != 64
            or any(character not in "0123456789abcdef" for character in sha256)
        ):
            raise ValueError("artifact reference sha256 is invalid")
        parts = relative_path.split("/")
        if len(parts) != 4 or parts[1] != "sha256" or parts[2] != sha256[:2] or parts[3] != sha256:
            raise ValueError("artifact reference path does not match sha256")
        project_id = getattr(reference, "project_id", None)
        metadata = getattr(reference, "metadata", None)
        metadata_project_id = metadata.get("projectId") if isinstance(metadata, Mapping) else None
        if project_id is None:
            project_id = metadata_project_id or parts[0]
        if metadata_project_id is not None and metadata_project_id != project_id:
            raise ValueError("artifact reference metadata projectId does not match")
        self._validate_project_id(project_id)
        if parts[0] != project_id:
            raise ValueError("artifact reference projectId does not match path")
        if any(part in {"", ".", ".."} or "\x00" in part for part in parts):
            raise ValueError("artifact reference path contains unsafe segments")
        return project_id, self.root.joinpath(*parts)

    @classmethod
    def _assert_no_follow_path(cls, path: Path) -> Path:
        """逐级 lstat，拒绝 symlink/FIFO/设备并允许安全创建缺失尾部。"""
        absolute = Path(os.path.abspath(path))
        current = Path(absolute.anchor)
        missing_seen = False
        for component in absolute.relative_to(Path(absolute.anchor)).parts:
            current /= component
            if not os.path.lexists(current):
                missing_seen = True
                continue
            if missing_seen:
                raise ValueError("path is not safely addressable")
            mode = current.lstat().st_mode
            if stat.S_ISLNK(mode) or stat.S_ISFIFO(mode) or stat.S_ISCHR(mode) or stat.S_ISBLK(mode) or stat.S_ISSOCK(mode):
                raise ValueError("path contains symlink or special file")
            if current != absolute and not stat.S_ISDIR(mode):
                raise ValueError("path parent is not a directory")
        return absolute

    @classmethod
    def _assert_no_follow_tree(cls, root: Path) -> None:
        """预扫描项目树，防止删除/遍历过程中跟随嵌套 symlink 或特殊文件。"""
        for directory, dirnames, filenames in os.walk(root, followlinks=False):
            directory_path = Path(directory)
            cls._assert_no_follow_path(directory_path)
            for name in (*dirnames, *filenames):
                cls._assert_no_follow_path(directory_path / name)
