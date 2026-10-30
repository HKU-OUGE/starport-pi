"""Trusted WSL operator bridge: Unix socket <-> bounded JSON lines on stdio.

It never connects to an Internet address. The Windows peer connects only to its
configured loopback proxy. This file is outside the task rootfs and mounts.
"""
import base64
import contextlib
import fcntl
import json
import os
import pathlib
import re
import socket
import sys
import threading


def serve(address):
    if not re.fullmatch(r'/tmp/starport-egress-[a-f0-9]{32}/proxy.sock', address):
        raise ValueError('invalid_bridge_socket')
    folder = pathlib.Path(address).parent
    folder.mkdir(mode=0o700, exist_ok=True)
    if folder.is_symlink() or folder.stat().st_uid != os.getuid():
        raise ValueError('invalid_bridge_directory')
    lock = open(folder / 'bridge.lock', 'a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    with contextlib.suppress(FileNotFoundError):
        os.unlink(address)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(address)
    os.chmod(address, 0o600)
    listener.listen(16)
    peers = {}
    mutex, output = threading.Lock(), threading.Lock()
    stopping = threading.Event()

    def send(value):
        with output:
            sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')
            sys.stdout.flush()

    def close(number):
        with mutex:
            peer = peers.pop(number, None)
        if peer:
            with contextlib.suppress(OSError):
                peer.shutdown(socket.SHUT_RDWR)
            peer.close()

    def reader(number, peer):
        try:
            send({'type': 'open', 'id': number})
            while not stopping.is_set():
                data = peer.recv(16384)
                if not data:
                    break
                send({'type': 'data', 'id': number, 'data': base64.b64encode(data).decode('ascii')})
        except (OSError, BrokenPipeError):
            pass
        finally:
            close(number)
            with contextlib.suppress(OSError):
                send({'type': 'close', 'id': number})

    def accept():
        number = 0
        while not stopping.is_set():
            try:
                peer, _ = listener.accept()
            except OSError:
                break
            with mutex:
                if len(peers) >= 32:
                    peer.close()
                    continue
                number += 1
                peers[number] = peer
            peer.settimeout(120)
            threading.Thread(target=reader, args=(number, peer), daemon=True).start()

    send({'type': 'ready'})
    threading.Thread(target=accept, daemon=True).start()
    try:
        while True:
            line = sys.stdin.buffer.readline(32769)
            if not line:
                break
            if len(line) > 32768 or not line.endswith(b'\n'):
                raise ValueError('invalid_bridge_frame')
            frame = json.loads(line)
            number = frame.get('id')
            if not isinstance(number, int) or number < 1:
                raise ValueError('invalid_bridge_frame')
            if frame.get('type') == 'close':
                close(number)
            elif frame.get('type') == 'data':
                data = base64.b64decode(frame.get('data', ''), validate=True)
                if len(data) > 16384:
                    raise ValueError('invalid_bridge_frame')
                with mutex:
                    peer = peers.get(number)
                if peer:
                    try:
                        peer.sendall(data)
                    except OSError:
                        close(number)
            else:
                raise ValueError('invalid_bridge_frame')
    finally:
        stopping.set()
        listener.close()
        for number in list(peers):
            close(number)
        with contextlib.suppress(FileNotFoundError):
            os.unlink(address)
        lock.close()


if __name__ == '__main__':
    serve(sys.argv[1])
