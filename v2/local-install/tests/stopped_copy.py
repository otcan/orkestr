"""Whole-home copy for cooperative, exclusively stopped synthetic instances only."""
import shutil
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from install_state import files, fresh_path, locked, private_home
from helper import require


def copy_home(source, destination):
    source=private_home(source)
    destination=fresh_path(destination,[source])
    with locked(source):
        socket=source/'control/launcher.sock'
        require(not socket.exists() and not socket.is_symlink(),'stopped home without launcher socket required')
        before=files(source)  # Reject sockets, symlinks and special files before copying.
        shutil.copytree(source,destination)
        require(files(source)==before and files(destination)==before,'stopped whole-home copy changed or incomplete')
    return destination
