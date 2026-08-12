"""Process-local audit policy and explicit artifact-handle authorization."""

from __future__ import annotations

import hashlib
import os
import re
import sys
from dataclasses import dataclass

from errors import EngineError, require

HANDLE_SCHEMA = "omnia.python-artifact-handle/v1"
MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
_UUID = re.compile(r"^[0-9a-f-]{36}$")


@dataclass(frozen=True)
class AuthorizedHandle:
    handle_id: str
    run_id: str
    path: str
    access: str
    size_bytes: int
    sha256: str


def _native_path(value: str) -> str:
    """Use the Windows extended-length namespace without changing public handle paths."""
    absolute = os.path.abspath(value)
    if os.name != "nt" or absolute.startswith("\\\\?\\"):
        return absolute
    if absolute.startswith("\\\\"):
        return "\\\\?\\UNC\\" + absolute[2:]
    return "\\\\?\\" + absolute


def _artifact_handle_public_path(value: str) -> str:
    """Remove only the Windows namespace that this Feature adds to handle paths."""
    if os.name != "nt":
        return value
    namespace = "\\\\?\\"
    if not value.startswith(namespace):
        return value
    unc_namespace = f"{namespace}UNC\\"
    if value.startswith(unc_namespace):
        return "\\\\" + value[len(unc_namespace):]
    return value[len(namespace):]


class AuditPolicy:
    def __init__(self, package_root: str) -> None:
        self.package_root = os.path.realpath(_native_path(package_root))
        self.runtime_root = os.path.realpath(sys.base_prefix)
        configured_temp = os.environ.get("OMNIA_PYTHON_TEMP_ROOT", "")
        if not configured_temp or not os.path.isabs(configured_temp):
            raise EngineError("SIDECAR.TEMP_ROOT_INVALID", "Managed Python temp root is unavailable.")
        self.temp_root = os.path.realpath(_native_path(configured_temp))
        require(os.path.isdir(self.temp_root), "SIDECAR.TEMP_ROOT_INVALID", "Managed Python temp root is unavailable.")
        self.read_paths: set[str] = set()
        self.write_paths: set[str] = set()
        self.invocation_run_id = ""
        self._installed = False

    def install(self) -> None:
        if self._installed:
            return
        sys.addaudithook(self._audit)
        self._installed = True

    def bind_invocation(self, run_id: str) -> None:
        require(_UUID.fullmatch(run_id) is not None, "HANDLE.RUN_ID_INVALID", "Sidecar invocation Run identity is invalid.")
        self.invocation_run_id = run_id
        self.read_paths.clear()
        self.write_paths.clear()

    def authorize(self, descriptor: dict, *, required_access: str) -> AuthorizedHandle:
        require(isinstance(descriptor, dict) and descriptor.get("schemaVersion") == HANDLE_SCHEMA, "HANDLE.SCHEMA_INVALID", "Artifact handle schema is invalid.")
        handle_id = str(descriptor.get("handleId") or "")
        run_id = str(descriptor.get("runId") or "")
        raw_path = descriptor.get("path")
        access = str(descriptor.get("access") or "")
        require(_UUID.fullmatch(handle_id) is not None and _UUID.fullmatch(run_id) is not None, "HANDLE.ID_INVALID", "Artifact Run or handle identity is invalid.")
        require(run_id == self.invocation_run_id, "HANDLE.RUN_BINDING_MISMATCH", "Artifact handle is not bound to the active invocation Run.")
        require(isinstance(raw_path, str) and os.path.isabs(raw_path), "HANDLE.PATH_INVALID", "Artifact handle path must be absolute.")
        require(access in ("read", "write", "readwrite"), "HANDLE.ACCESS_INVALID", "Artifact handle access is invalid.")
        expected_root = os.path.realpath(_native_path(os.path.join(self.temp_root, run_id, handle_id)))
        require(_inside_authorized_root(expected_root, self.temp_root) and os.path.isdir(expected_root), "HANDLE.ROOT_INVALID", "Artifact handle root is unavailable.")
        if required_access == "read":
            require(access in ("read", "readwrite"), "HANDLE.READ_FORBIDDEN", "Artifact handle does not grant read access.")
            path = os.path.realpath(_native_path(raw_path))
            require(_inside_authorized_root(path, expected_root) and os.path.dirname(path) == expected_root, "HANDLE.PATH_OUTSIDE_RUN", "Artifact handle escaped its Feature/Run temp root.")
            require(os.path.isfile(path), "HANDLE.FILE_MISSING", "Artifact handle does not resolve to a regular file.")
            self.read_paths.add(path)
        else:
            require(access in ("write", "readwrite"), "HANDLE.WRITE_FORBIDDEN", "Artifact handle does not grant write access.")
            parent = os.path.realpath(_native_path(os.path.dirname(raw_path)))
            require(_inside_authorized_root(parent, expected_root) and parent == expected_root, "HANDLE.PATH_OUTSIDE_RUN", "Artifact handle escaped its Feature/Run temp root.")
            require(os.path.isdir(parent), "HANDLE.PARENT_MISSING", "Artifact handle parent directory is unavailable.")
            path = os.path.join(parent, os.path.basename(raw_path))
            require(os.path.realpath(path) == path, "HANDLE.PATH_INVALID", "Artifact handle path contains an unresolved alias.")
            require(_inside_authorized_root(path, expected_root), "HANDLE.PATH_OUTSIDE_RUN", "Artifact handle escaped its Feature/Run temp root.")
            self.write_paths.add(path)
            if access == "readwrite":
                self.read_paths.add(path)
        size = int(descriptor.get("sizeBytes") or 0)
        digest = str(descriptor.get("sha256") or "").lower()
        return AuthorizedHandle(handle_id, run_id, path, access, size, digest)

    def read(self, descriptor: dict, *, max_bytes: int = MAX_ARTIFACT_BYTES) -> bytes:
        handle = self.authorize(descriptor, required_access="read")
        require(0 <= handle.size_bytes <= max_bytes, "HANDLE.SIZE_INVALID", "Artifact handle size exceeds the operation limit.")
        require(len(handle.sha256) == 64 and all(char in "0123456789abcdef" for char in handle.sha256), "HANDLE.DIGEST_INVALID", "Artifact handle sha256 is invalid.")
        try:
            actual_size = os.path.getsize(handle.path)
            require(actual_size == handle.size_bytes, "HANDLE.SIZE_MISMATCH", "Artifact handle size does not match the file.")
            digest = hashlib.sha256()
            chunks: list[bytes] = []
            total = 0
            with open(handle.path, "rb") as stream:
                while True:
                    chunk = stream.read(min(1024 * 1024, max_bytes + 1 - total))
                    if not chunk:
                        break
                    total += len(chunk)
                    require(total <= max_bytes, "HANDLE.SIZE_EXCEEDED", "Artifact exceeds the operation limit.")
                    digest.update(chunk)
                    chunks.append(chunk)
        except EngineError:
            raise
        except OSError as exc:
            raise EngineError("HANDLE.READ_FAILED", "Artifact handle could not be read.") from exc
        require(digest.hexdigest() == handle.sha256, "HANDLE.DIGEST_MISMATCH", "Artifact handle digest does not match the file.")
        return b"".join(chunks)

    def write(self, descriptor: dict, data: bytes) -> dict:
        require(isinstance(data, bytes) and len(data) <= MAX_ARTIFACT_BYTES, "HANDLE.WRITE_SIZE_EXCEEDED", "Artifact output exceeds 64 MiB.")
        handle = self.authorize(descriptor, required_access="write")
        try:
            with open(handle.path, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        except OSError as exc:
            raise EngineError("HANDLE.WRITE_FAILED", "Artifact handle could not be written.") from exc
        digest = hashlib.sha256(data).hexdigest()
        return {"schemaVersion": HANDLE_SCHEMA, "handleId": handle.handle_id, "runId": handle.run_id, "path": _artifact_handle_public_path(handle.path), "access": "read", "sizeBytes": len(data), "sha256": digest}

    def _audit(self, event: str, args: tuple) -> None:
        if event.startswith("socket.") or event in {"subprocess.Popen", "os.system", "os.posix_spawn", "os.posix_spawnp", "pty.spawn"} or event.startswith("os.spawn"):
            raise PermissionError("sidecar capability denied")
        if event in {"ctypes.dlopen", "ctypes.dlsym", "ctypes.call_function", "ctypes.set_exception"}:
            raise PermissionError("sidecar native loading denied")
        if event == "open" and args:
            raw_path = args[0]
            if isinstance(raw_path, int):
                return
            try:
                path = os.path.realpath(os.fspath(raw_path))
            except (TypeError, ValueError, OSError):
                raise PermissionError("sidecar file access denied") from None
            mode = args[1] if len(args) > 1 else "r"
            flags = args[2] if len(args) > 2 else 0
            writing = (isinstance(mode, str) and any(char in mode for char in "wax+")) or (isinstance(flags, int) and bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)))
            if writing:
                if path not in self.write_paths:
                    raise PermissionError("sidecar write path denied")
            elif not self._read_allowed(path):
                raise PermissionError("sidecar read path denied")
        if event in {"os.remove", "os.rename", "os.replace", "os.rmdir", "os.mkdir", "os.truncate", "os.chmod", "os.chown", "os.link", "os.symlink"}:
            raise PermissionError("sidecar filesystem mutation denied")

    def _read_allowed(self, path: str) -> bool:
        return path in self.read_paths or _inside_authorized_root(path, self.package_root) or _inside_authorized_root(path, self.runtime_root)


def _inside_authorized_root(path: str, root: str) -> bool:
    try:
        relative = os.path.relpath(path, root)
    except ValueError:
        return False
    return relative == os.curdir or (
        not os.path.isabs(relative)
        and relative != os.pardir
        and not relative.startswith(os.pardir + os.sep)
    )
