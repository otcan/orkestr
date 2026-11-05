"""Provision one verified service key without replacing human credentials.

Run as the eventual credential-file owner from a pinned checkout. This command
does not change a service configuration, restart a consumer or enable password
rotation. Unknown HTTP outcomes must be reviewed rather than retried blindly.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import stat

from .rust_client import ClientError, RustSession, credentials, identity, require

KEYS = "/api/v2/browser/service-credentials"
SESSION = "/api/v2/browser/session"


def output_directory(path):
    """Retain the trusted parent FD throughout publication; never follow links."""
    path = Path(path)
    require(path.is_absolute() and ".." not in path.parts and path.name != "auth.json",
            "output_path_refused")
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
            info = os.fstat(directory)
            sticky_root = info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
            require(info.st_uid in (0, os.geteuid()) and
                    (not info.st_mode & 0o022 or sticky_root), "output_parent_refused")
        info = os.fstat(directory)
        require(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700,
                "output_directory_not_private")
        try:
            os.stat(path.name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise ClientError("output_exists")
        return directory, path
    except BaseException:
        os.close(directory)
        raise


def provision(*, output, label, **session_options):
    require(isinstance(label, str) and label.strip() and len(label.encode()) <= 128,
            "label_refused")
    require(session_options.get("peer_descriptor_path") is not None,"service_peer_descriptor_required")
    directory, path = output_directory(output)
    temporary = None
    issued = None
    published = False
    create_started = False
    session = verified = None
    try:
        # Serialize operators sharing this directory. This is not a deployment
        # lock and does not permit changing a release or a live consumer.
        lock = os.open(".service-credential-provision.lock",
                       os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK,
                       0o600, dir_fd=directory)
        try:
            info = os.fstat(lock)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and
                    stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
                    "provision_lock_refused")
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            # Check again after taking the operator lock; publication below also
            # refuses a concurrent creator outside this tool.
            require(not os.path.lexists(path), "output_exists")
            session = RustSession(**session_options)
            session.login()
            human = credentials(session.credentials_path)
            require(set(human) == {"username", "password"}, "human_credentials_required")
            session._health()
            create_started = True
            _, value, _ = session._wire("POST", KEYS, {
                "username": human["username"], "current_password": human["password"],
                "label": label,
            })
            human = None
            require(isinstance(value, dict), "service_receipt_refused")
            issued = identity(value.get("id"))
            token = value.get("service_token")
            require(isinstance(token, str) and re.fullmatch("[0-9a-f]{64}", token) and
                    value.get("expires_in") == 2592000, "service_receipt_refused")
            temporary = f".service-credential-{secrets.token_hex(16)}.tmp"
            fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
                         0o600, dir_fd=directory)
            try:
                raw = json.dumps({"service_token": token}, separators=(",", ":")).encode()
                with os.fdopen(fd, "wb", closefd=False) as stream:
                    stream.write(raw)
                    stream.flush()
                    os.fsync(fd)
            finally:
                os.close(fd)
            # Exercise the exact client used by unattended consumers before
            # publishing its file, including source, owner, cookie and CSRF checks.
            verified = RustSession(**{**session_options,
                                     "credentials_path": str(path.parent / temporary)})
            verified.login()
            verified._wire("DELETE", SESSION, allowed=(204,))
            verified = None
            # link() is an atomic no-replace publication. The temporary second
            # link is immediately removed; consumers require nlink==1.
            os.link(temporary, path.name, src_dir_fd=directory, dst_dir_fd=directory,
                    follow_symlinks=False)
            published = True
            os.unlink(temporary, dir_fd=directory)
            temporary = None
            os.fsync(directory)
            return {"status": "provisioned-not-activated", "credential_id": issued,
                    "expires_in": 2592000, "source_commit": session_options["expected_source"],
                    "owner_id": session_options["expected_owner"]}
        finally:
            os.close(lock)
    except Exception:
        if not create_started:
            raise
        revoked = False
        if issued and not published and session:
            try:
                session._wire("DELETE", f"{KEYS}/{issued}", allowed=(204,))
                revoked = True
            except Exception:
                pass
        # Never include a response, exception string, path, password or token.
        code = ("credential_published_review_required" if published else
                "provision_failed_key_revoked" if revoked else "provision_failed_review_required")
        raise ClientError(code) from None
    finally:
        for client in (verified, session):
            if client and client._cookie:
                try:
                    client._wire("DELETE", SESSION, allowed=(204,))
                except Exception:
                    pass
        if temporary:
            try:
                os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError:
                pass
        os.close(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ("origin", "loopback_url", "credentials_path", "expected_owner", "expected_source",
                  "output", "label", "peer_descriptor_path"):
        parser.add_argument("--" + field.replace("_", "-"), required=True)
    options = vars(parser.parse_args())
    try:
        print(json.dumps(provision(**options), sort_keys=True))
        return 0
    except Exception as error:
        code = error.code if isinstance(error, ClientError) else "provision_failed_review_required"
        print(json.dumps({"status": "refused", "code": code}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
