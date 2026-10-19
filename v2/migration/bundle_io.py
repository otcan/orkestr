"""Copy validated inert bundles, not a live database exporter or Core restore."""
import os
from pathlib import Path
import shutil
import tempfile
from ledger_io import checked_output, locked
from snapshot import canonical, load, need, safe_file


def copy_bundle(source, destination):
    source = Path(source).absolute()
    need(source.resolve() == source, 'snapshot_root_alias')
    need(not Path(destination).exists(), 'bundle_target_exists')
    destination = checked_output(destination)
    need(not destination.is_relative_to(source) and not source.is_relative_to(destination),
         'source_output_overlap')
    document = load(source)
    with locked(destination):
        need(not destination.exists(), 'bundle_target_exists')
        temporary = Path(tempfile.mkdtemp(prefix='.migration-bundle-', dir=destination.parent))
        try:
            for artifact in document['artifacts']:
                data = safe_file(source, artifact['path']).read_bytes()
                target = temporary / artifact['path']
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with target.open('xb') as stream:
                    os.chmod(target, 0o600)
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
            manifest = temporary / 'snapshot.json'
            with manifest.open('xb') as stream:
                os.chmod(manifest, 0o600)
                stream.write(canonical(document) + b'\n')
                stream.flush()
                os.fsync(stream.fileno())
            # Revalidate the copy and source before publishing the fresh directory.
            need(load(temporary) == document and load(source) == document, 'source_changed')
            for directory in sorted((p for p in temporary.rglob('*') if p.is_dir()), reverse=True):
                sync_directory(directory)
            sync_directory(temporary)
            os.rename(temporary, destination)
            sync_directory(destination.parent)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
    return document['counts']


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
