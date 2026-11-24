"""Usage tracker: a small local page with a round gauge per account. Run it and a window opens; it stops when no page is open.

  tracker.pyw               open the window
  tracker.pyw --no-window   only serve http://127.0.0.1:4747
"""
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import providers
from providers import UsageError

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, 'web')
DATA = os.environ.get('USAGE_TRACKER_DATA') or os.path.join(
    os.environ.get('LOCALAPPDATA') or os.path.expanduser('~'), 'usage-tracker')
PORT = int(os.environ.get('USAGE_TRACKER_PORT') or 4747)
EVERY = {'claude': 300, 'chatgpt': 300, 'gemini': 900}      # seconds between automatic reads
MANUAL_GAP = 15                                             # the refresh button re-reads at most this often
VIEWER_GONE = 180                                           # no page open for this long: stop reading
ORDER = {'claude': 0, 'chatgpt': 1, 'gemini': 2}
FILES = {'/': ('index.html', 'text/html'), '/style.css': ('style.css', 'text/css'),
         '/app.js': ('app.js', 'text/javascript'), '/lang.js': ('lang.js', 'text/javascript'),
         '/scene.js': ('scene.js', 'text/javascript'), '/beans.js': ('beans.js', 'text/javascript'), '/icon.svg': ('icon.svg', 'image/svg+xml')}


def wipe(path):
    """Deletes a profile folder; a program that was just closed can hold its files for a moment."""
    def unlock(func, name, _):                    # git leaves read-only files, which Windows will not delete
        try:
            os.chmod(name, stat.S_IWRITE)
            func(name)
        except OSError:
            pass

    for _ in range(20):
        shutil.rmtree(path, onexc=unlock)
        if not os.path.exists(path):
            return
        time.sleep(0.5)


class Tracker:
    def __init__(self):
        self.lock = threading.RLock()
        self.path = os.path.join(DATA, 'accounts.json')
        self.busy, self.due = set(), set()
        self.login, self.importing = None, True
        self.last_view = time.time()
        os.makedirs(DATA, exist_ok=True)
        try:
            with open(self.path, encoding='utf-8') as f:
                saved = json.load(f)
            self.accounts, self.imported = saved['accounts'], saved.get('imported', [])
            self.drop_orphans()
        except (OSError, ValueError, KeyError):
            self.accounts, self.imported = [], []

    # ── storage ──
    def drop_orphans(self):
        """Folders of sign-ins that never finished (only called once the saved list was read)."""
        root, known = os.path.join(DATA, 'profiles'), {a['id'] for a in self.accounts}
        for name in os.listdir(root) if os.path.isdir(root) else []:
            if re.fullmatch(r'[0-9a-f]{12}', name) and name not in known:
                threading.Thread(target=wipe, args=(os.path.join(root, name),), daemon=True).start()

    def save(self):
        with self.lock:
            tmp = self.path + '.new'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump({'accounts': self.accounts, 'imported': self.imported}, f, ensure_ascii=False, indent=1)
            os.replace(tmp, self.path)

    def find(self, account_id):
        return next((a for a in self.accounts if a['id'] == account_id), None)

    @staticmethod
    def profile_dir(account_id):
        if not re.fullmatch(r'[0-9a-f]{12}', account_id):
            raise ValueError('bad id')
        return os.path.join(DATA, 'profiles', account_id)

    def profile(self, account):
        return None if account['local'] else self.profile_dir(account['id'])

    # ── reading ──
    def read(self, account_id):
        with self.lock:
            account = self.find(account_id)
            if not account or account_id in self.busy:
                return
            self.busy.add(account_id)
            provider, profile = account['provider'], self.profile(account)
        try:
            result, error = providers.READ[provider](profile), None
        except UsageError as e:
            result, error = None, e.for_page()
        except Exception as e:
            result, error = None, {'code': 'other', 'detail': type(e).__name__}
        with self.lock:
            self.busy.discard(account_id)
            account = self.find(account_id)
            if not account:
                return
            account['tried_at'], account['error'] = time.time(), error
            if result:                           # on an error the last good numbers stay on screen
                account.update(windows=result['windows'], read_at=time.time(),
                               email=result['email'] or account.get('email'), plan=result['plan'] or account.get('plan'))
            self.save()

    def is_due(self, a, now):
        if a['id'] in self.busy:
            return False
        tried = a.get('tried_at') or 0
        if a['id'] in self.due:
            self.due.discard(a['id'])
            return now - tried >= MANUAL_GAP
        if now - tried >= EVERY[a['provider']]:
            return True
        # a window just reset: read it again, once
        return any(w['resets_at'] and tried < w['resets_at'] + 5 < now for w in a.get('windows') or [])

    def loop(self):
        try:
            self.import_local()
        finally:
            self.importing = False
        while True:
            now = time.time()
            if now - self.last_view < VIEWER_GONE:
                with self.lock:
                    ready = [a['id'] for a in self.accounts if self.is_due(a, now)]
                for account_id in ready:
                    threading.Thread(target=self.read, args=(account_id,), daemon=True).start()
            time.sleep(2)

    def import_local(self):
        """First run: add the Claude Code / ChatGPT logins already on this PC."""
        for provider in ('claude', 'chatgpt'):
            if provider in self.imported or not providers.tools()[provider]:
                continue
            try:
                result = providers.READ[provider](None)
            except UsageError as e:
                if e.code != 'login':
                    continue                     # try again next start
                result = None
            except Exception:
                continue
            with self.lock:
                self.imported.append(provider)
                if result:
                    self.add(provider, True, secrets.token_hex(6), result)
                self.save()

    def add(self, provider, local, account_id, result):
        now = time.time()
        self.accounts.append({'id': account_id, 'provider': provider, 'local': local, 'email': result['email'],
                              'plan': result['plan'], 'windows': result['windows'], 'read_at': now, 'tried_at': now,
                              'error': None})

    # ── sign-in ──
    def start_login(self, provider, account_id=None):
        if provider not in providers.READ:
            raise ValueError('provider')
        old = self.login
        if old and old['state'] == 'checking':
            raise ValueError('login_busy')
        if old and old['state'] in ('starting', 'waiting'):      # left open by a page that was closed
            old['job'].cancel()
            old['thread'].join(5)
        with self.lock:
            existing = self.find(account_id) if account_id else None
            # A login that came with the PC is never touched: signing in again gives it its own profile.
            new_id = existing['id'] if existing and not existing['local'] else secrets.token_hex(6)
            job = providers.Login(provider, self.profile_dir(new_id))
            self.login = {'id': secrets.token_hex(4), 'provider': provider, 'state': 'starting', 'error': None,
                          'job': job}
            self.login['thread'] = threading.Thread(target=self._login, args=(self.login, job, new_id, existing), daemon=True)
            self.login['thread'].start()

    def _login(self, entry, job, new_id, existing):
        fresh = not existing or existing['id'] != new_id
        try:
            if not fresh:                        # do not read the profile while it is being signed in
                with self.lock:
                    self.busy.add(new_id)
            threading.Thread(target=self._mark_waiting, args=(entry, job), daemon=True).start()
            job.run()
            entry['state'] = 'checking'
            result = providers.READ[entry['provider']](job.profile)
            with self.lock:
                twin = next((a for a in self.accounts if a['provider'] == entry['provider'] and result['email']
                             and (a.get('email') or '').lower() == result['email'].lower()
                             and a['id'] not in (new_id, existing and existing['id'])), None)
                if twin:
                    raise UsageError('duplicate', result['email'])
                if existing and fresh:
                    self.accounts.remove(existing)
                if fresh:
                    self.add(entry['provider'], False, new_id, result)
                else:
                    existing.update(result, read_at=time.time(), tried_at=time.time(), error=None)
                self.save()
            entry['state'] = 'done'
        except Exception as e:
            entry['error'] = e.for_page() if isinstance(e, UsageError) else {'code': 'other', 'detail': type(e).__name__}
            entry['state'] = 'cancelled' if job.cancelled else 'error'
            if fresh:
                wipe(job.profile)
        finally:
            with self.lock:
                self.busy.discard(new_id)

    @staticmethod
    def _mark_waiting(entry, job):
        for _ in range(240):
            if entry['state'] != 'starting':
                return
            if job.url or entry['provider'] == 'gemini':
                entry['state'] = 'waiting'
                return
            time.sleep(0.25)

    def open_login(self, private):
        job = self.login and self.login['job']
        if job and job.url:
            providers.open_private(job.url) if private else webbrowser.open(job.url)

    def cancel_login(self):
        entry = self.login
        if entry and entry['state'] in ('starting', 'waiting'):
            entry['job'].cancel()
        elif entry and entry['state'] != 'checking':
            self.login = None

    def remove(self, account_id):
        with self.lock:
            account = self.find(account_id)
            if not account:
                return
            self.accounts.remove(account)
            self.save()
        if not account['local']:
            threading.Thread(target=wipe, args=(self.profile_dir(account_id),), daemon=True).start()

    # ── page ──
    def state(self):
        self.last_view = time.time()
        with self.lock:
            accounts = [{**{k: a.get(k) for k in ('id', 'provider', 'email', 'plan', 'windows', 'read_at', 'error')},
                         'busy': a['id'] in self.busy} for a in sorted(self.accounts, key=lambda a: ORDER[a['provider']])]
            login = self.login and {k: self.login[k] for k in ('id', 'provider', 'state', 'error')}
            return {'app': 'usage-tracker', 'now': time.time(), 'accounts': accounts, 'login': login,
                    'tools': providers.tools(), 'starting': self.importing}


class Handler(BaseHTTPRequestHandler):
    tracker = None
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def reply(self, body, kind='application/json', status=200):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', kind + '; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy',
                         "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; "
                         "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(data)

    def ours(self):
        """Only this PC's own page: refuses other sites that point a name at 127.0.0.1 or post to us."""
        hosts = {'127.0.0.1:%d' % self.server.server_port, 'localhost:%d' % self.server.server_port}
        origin = self.headers.get('Origin')
        return self.headers.get('Host') in hosts and (not origin or origin in {'http://' + h for h in hosts})

    def do_GET(self):
        if not self.ours():
            return self.reply({'error': 'forbidden'}, status=403)
        path = self.path.split('?')[0]
        if path == '/api/state':
            return self.reply(self.tracker.state())
        if path in FILES:
            name, kind = FILES[path]
            with open(os.path.join(WEB, name), 'rb') as f:
                return self.reply(f.read(), kind)
        self.reply({'error': 'not found'}, status=404)

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(min(length, 10_000))
        if not self.ours() or self.headers.get('X-Usage-Tracker') != '1':
            return self.reply({'error': 'forbidden'}, status=403)
        t = self.tracker
        try:
            body = json.loads(raw or b'{}')
            if self.path == '/api/refresh':
                t.due.update(a['id'] for a in t.accounts)
            elif self.path == '/api/login':
                t.start_login(body['provider'], body.get('account'))
            elif self.path == '/api/login/open':
                t.open_login(bool(body.get('private')))
            elif self.path == '/api/login/cancel':
                t.cancel_login()
            elif self.path == '/api/remove':
                t.remove(body['account'])
            else:
                return self.reply({'error': 'not found'}, status=404)
        except (ValueError, KeyError, TypeError, AttributeError) as e:
            return self.reply({'error': str(e)}, status=400)
        self.reply(t.state())


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False          # on Windows reuse would let two copies share the port


def already_running(port):
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d/api/state' % port, timeout=3) as r:
            return json.load(r).get('app') == 'usage-tracker'
    except (OSError, ValueError):
        return False


def open_window(port):
    """The page in a window of its own; returns its process, or None if it opened in the default browser."""
    exe, url = providers.browser_exe(), 'http://127.0.0.1:%d/' % port
    if not exe:
        webbrowser.open(url)
        return None
    return subprocess.Popen([exe, '--app=' + url, '--user-data-dir=' + os.path.join(DATA, 'window'), '--no-first-run',
                             '--no-default-browser-check', '--disable-background-mode', '--window-size=1080,800'])


def main():
    window = '--no-window' not in sys.argv
    server, port = None, PORT
    for port in range(PORT, PORT + 10):
        try:
            server = Server(('127.0.0.1', port), Handler)
            break
        except OSError:
            if already_running(port):
                if window:
                    open_window(port)
                return
    if not server:
        return
    Handler.tracker = Tracker()
    threading.Thread(target=Handler.tracker.loop, daemon=True).start()
    if window:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        proc = open_window(port)
        if proc:
            proc.wait()                  # closing the window stops the program,
            seen, quiet = 0, 0           # unless the page is still open somewhere else
            while quiet < 8:
                time.sleep(2)
                quiet = quiet + 1 if Handler.tracker.last_view == seen else 0
                seen = Handler.tracker.last_view
            login = Handler.tracker.login
            if login:
                login['job'].cancel()
            return
        threading.Event().wait()
    print('http://127.0.0.1:%d/' % port, flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
