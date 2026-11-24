"""Lets a tablet or phone on the same network look at the page.

Off until switched on from the PC. A device gets in once with the six-digit code shown on the PC (each code
works once) and is remembered by a cookie. It can look and refresh; accounts are only managed on the PC.
Switching off closes the door and forgets every device.
"""
import ipaddress
import json
import os
import secrets
import socket
import threading
import time

HOME_NETWORKS = [ipaddress.ip_network(n) for n in ('192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12')]
TRIES, LOCKOUT = 6, 120          # wrong codes before a pause, and the pause in seconds
CHECK_EVERY = 10                 # seconds between looks at whether the PC's address changed


def lan_ip():
    """This PC's address on the home network, or None."""
    if os.environ.get('USAGE_TRACKER_LAN_IP'):
        return os.environ['USAGE_TRACKER_LAN_IP']       # for tests
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(('192.0.2.1', 9))                 # only picks the outgoing interface; nothing is sent
            ip = s.getsockname()[0]
        except OSError:
            return None
    return ip if any(ipaddress.ip_address(ip) in n for n in HOME_NETWORKS) else None


class Tablet:
    def __init__(self, data, make_server):
        self.path = os.path.join(data, 'tablet.json')
        self.make_server = make_server                  # (ip) -> a server that is not yet serving
        self.lock = threading.RLock()
        self.server, self.ip, self.failed = None, None, False
        self.checked, self.wrong, self.locked_until = 0.0, 0, 0.0
        self.code = self.new_code()
        self.on, self.token = False, None
        try:
            with open(self.path, encoding='utf-8') as f:
                saved = json.load(f)
            self.on, self.token = bool(saved['on']), str(saved['token'])
        except (OSError, ValueError, KeyError, TypeError):
            pass

    @staticmethod
    def new_code():
        return '%06d' % secrets.randbelow(1_000_000)

    def save(self):
        tmp = self.path + '.new'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump({'on': self.on, 'token': self.token}, f)
        os.replace(tmp, self.path)

    def switch(self, on):
        with self.lock:
            if on != self.on:
                self.on = on
                self.token = secrets.token_urlsafe(32) if on else None
                self.code, self.wrong, self.locked_until = self.new_code(), 0, 0.0
                self.save()
            self.checked = 0.0
            self.keep()

    def keep(self):
        """Called often: opens, moves or closes the door to match the switch and the PC's address."""
        with self.lock:
            now = time.monotonic()
            if now - self.checked < CHECK_EVERY and self.checked:
                return
            self.checked = now
            ip = lan_ip() if self.on else None
            if ip == self.ip and (self.server or not ip):
                return
            self.close()
            if ip:
                try:
                    self.server = self.make_server(ip)
                    self.ip, self.failed = ip, False
                    threading.Thread(target=self.server.serve_forever, daemon=True).start()
                except OSError:
                    self.failed = True

    def close(self):
        if self.server:
            server, self.server = self.server, None
            threading.Thread(target=lambda: (server.shutdown(), server.server_close()), daemon=True).start()
        self.ip, self.failed = None, False

    def pair(self, code):
        """The device's key for the right code; None for a wrong one; raises ValueError while paused."""
        with self.lock:
            now = time.monotonic()
            if now < self.locked_until:
                raise ValueError('pair_wait')
            if not self.on or not self.token:
                return None
            if secrets.compare_digest(str(code).strip().encode(), self.code.encode()):
                self.code, self.wrong = self.new_code(), 0
                return self.token
            self.wrong += 1
            if self.wrong >= TRIES:
                self.code, self.wrong, self.locked_until = self.new_code(), 0, now + LOCKOUT
            return None

    def knows(self, key):
        return bool(self.on and self.token and key and secrets.compare_digest(key.encode(), self.token.encode()))

    def for_pc(self):
        with self.lock:
            url = '%s:%d' % (self.ip, self.server.server_port) if self.server else None
            return {'on': self.on, 'url': url, 'code': self.code if self.server else None,
                    'problem': 'tablet_port' if self.failed else 'tablet_network' if self.on and not url else None}
