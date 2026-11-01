"""Fake Docker/gh for subprocess installer tests. Never starts real containers."""
import json
import os
from pathlib import Path
import shutil
import sys


def main():
    path = Path(os.environ['INSTALLER_FAKE_STATE'])
    state = json.loads(path.read_text())
    tool, arguments = sys.argv[1], sys.argv[2:]
    state.setdefault('calls', []).append([tool, *arguments])
    result, code = '', 0
    if tool == 'gh':
        if arguments[:2] == ['auth', 'status']:
            code = 0 if state.get('gh_auth') else 1
        elif arguments[:2] == ['run', 'download']:
            destination = Path(arguments[arguments.index('--dir') + 1])
            for source in Path(state['gh_source']).iterdir():
                shutil.copyfile(source, destination / source.name)
        else:
            code = 1
    elif arguments[0] == 'info':
        if state.get('daemon', True):
            result = state.get('engine', 'linux|x86_64')
        else:
            code = 1
    elif arguments[:2] == ['context', 'inspect']:
        result = state.get('endpoint', 'unix:///synthetic/docker.sock')
    elif arguments[:2] == ['container', 'inspect']:
        if not state.get('existing'):
            code = 1
        else:
            template = arguments[arguments.index('--format') + 1] if '--format' in arguments else None
            if template is None:
                image, binding, mode = state.get('identity', 'orkestr-oss-test:e7c3e890b9f10bd2c327d0ecdff4c41d008206ef|127.0.0.1:19822|local').split('|')
                address, port = binding.rsplit(':', 1)
                result = json.dumps([{'Config': {'Image': image, 'Env': ['ORKESTR_OSS_LOCAL_SETUP=1'] if mode == 'local' else []},
                    'HostConfig': {'PortBindings': {'19823/tcp': [{'HostIp': address, 'HostPort': port}]}}}])
            elif '.Config.Image' in template:
                result = state.get('identity', 'orkestr-oss-test:e7c3e890b9f10bd2c327d0ecdff4c41d008206ef|127.0.0.1:19822|local')
            elif '.State.Health' in template:
                result = ('true' if state.get('running') else 'false') + '|' + state.get('health', 'healthy')
            else:
                result = 'true' if state.get('running') else 'false'
    elif arguments[0] == 'ps':
        result = state.get('occupied', '')
        if result:
            result += '|127.0.0.1:19822->19823/tcp'
    elif arguments[:2] == ['image', 'inspect']:
        if state.get('image'):
            result = state.get('platform', 'linux|amd64')
        else:
            code = 1
    elif arguments[0] == 'load':
        state['image'] = True
    elif arguments[0] == 'run':
        state['existing'], state['running'] = True, True
        result = 'synthetic-container'
    elif arguments[0] == 'start':
        state['running'] = True
    else:
        code = 1
    path.write_text(json.dumps(state))
    if result:
        print(result)
    return code


if __name__ == '__main__':
    sys.exit(main())
