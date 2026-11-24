"""Reads plan usage for Claude, ChatGPT and Gemini, and signs accounts in.

No token is ever read or sent by this code. Each account has its own profile folder and the
vendor's own program does the talking:
  Claude   `claude -p /usage`            (CLAUDE_CONFIG_DIR = profile) - a local command, no tokens spent
  ChatGPT  `codex app-server` JSON-RPC   (CODEX_HOME = profile)        - Codex limits of the plan
  Gemini   gemini.google.com/usage       (a Chrome/Edge profile of its own)
profile = None means the login already present on this PC (Claude Code / ChatGPT desktop app).
"""
import glob
import json
import os
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from zoneinfo import ZoneInfo

NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
FIVE_HOURS, WEEK = 300, 10080          # window lengths in minutes
LOGIN_TIMEOUT = 15 * 60
GEMINI_USAGE = 'https://gemini.google.com/usage?hl=en'


class UsageError(Exception):
    """code: a key of the page's error texts (web/lang.js); detail: what goes into that text."""

    def __init__(self, code, detail=''):
        super().__init__(code)
        self.code, self.detail = code, str(detail)

    def for_page(self):
        return {'code': self.code, 'detail': self.detail}


# ── helpers ──────────────────────────────────────────────────────────────────

def _clean_env(prefixes):
    """Our environment without variables that would redirect the CLI to another login."""
    return {k: v for k, v in os.environ.items() if not k.upper().startswith(prefixes)}


def _run(cmd, env=None, timeout=60):
    try:
        return subprocess.run(cmd, env=env, cwd=tempfile.gettempdir(), stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, encoding='utf-8', errors='replace',
                              timeout=timeout, creationflags=NO_WINDOW)
    except subprocess.TimeoutExpired:
        raise UsageError('no_answer', os.path.basename(cmd[0]))
    except OSError as e:
        raise UsageError('cannot_run', '%s: %s' % (os.path.basename(cmd[0]), e))


def _kill_tree(proc):
    if proc.poll() is None:
        subprocess.run(['taskkill', '/T', '/F', '/PID', str(proc.pid)], capture_output=True,
                       creationflags=NO_WINDOW)


def claude_exe():
    return shutil.which('claude')


def codex_exe():
    found = glob.glob(os.path.join(os.environ.get('LOCALAPPDATA', ''), 'OpenAI', 'Codex', 'bin', '*', 'codex.exe'))
    if found:
        return max(found, key=os.path.getmtime)
    bundled = os.path.expanduser(r'~\.codex\plugins\.plugin-appserver\codex.exe')
    return shutil.which('codex') or (bundled if os.path.exists(bundled) else None)


def browser_exe():
    roots = [os.environ.get(v) for v in ('ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA')]
    for tail in (r'Google\Chrome\Application\chrome.exe', r'Microsoft\Edge\Application\msedge.exe'):
        for root in roots:
            if root and os.path.exists(os.path.join(root, tail)):
                return os.path.join(root, tail)
    return None


def tools():
    return {'claude': bool(claude_exe()), 'chatgpt': bool(codex_exe()), 'gemini': bool(browser_exe())}


def open_private(url):
    exe = browser_exe()
    flag = '--inprivate' if exe and exe.lower().endswith('msedge.exe') else '--incognito'
    subprocess.Popen([exe, flag, url], creationflags=NO_WINDOW)


# ── reset-time parsing ───────────────────────────────────────────────────────

_MONTHS = {m: i for i, m in enumerate('jan feb mar apr may jun jul aug sep oct nov dec'.split(), 1)}
_DAYS = {d: i for i, d in enumerate('mon tue wed thu fri sat sun'.split())}
_MONTH_RE = '(' + '|'.join(_MONTHS) + r')[a-z]*\.?'


def _zone(name):
    if name.upper() in ('UTC', 'GMT'):
        return timezone.utc
    try:
        return ZoneInfo(name)
    except Exception:          # Windows Python has no tz database; the CLI prints the PC's own zone
        return None


def parse_when(text, now=None):
    """Epoch seconds for 'Nov 25, 3:59am (Europe/Istanbul)', '4am', 'tomorrow at 3 PM', 'in 2 hr 5 min'; or None."""
    now = time.time() if now is None else now
    tz = None
    m = re.search(r'\(([A-Za-z_]+(?:/[A-Za-z_+\-0-9]+)*)\)', text)
    if m:
        tz = _zone(m.group(1))
        text = text[:m.start()]
    t = re.sub(r'\s+', ' ', text.lower().replace('a.m.', 'am').replace('p.m.', 'pm'))

    if re.search(r'\bin (?:about )?\d', t):
        total = 0
        for n, unit in re.findall(r'(\d+) ?(d|h|m)[a-z]*', t):
            total += int(n) * {'d': 86400, 'h': 3600, 'm': 60}[unit]
        return now + total if total else None

    local = datetime.fromtimestamp(now, tz).replace(tzinfo=None)
    clock = re.search(r'\b(\d{1,2})(?::(\d{2}))? ?(am|pm)\b', t)
    if clock:
        hour, minute = int(clock.group(1)) % 12 + (12 if clock.group(3) == 'pm' else 0), int(clock.group(2) or 0)
    else:
        clock = re.search(r'\b(\d{1,2}):(\d{2})\b', t)
        hour, minute = (int(clock.group(1)), int(clock.group(2))) if clock else (0, 0)
    if hour > 23 or minute > 59:
        return None

    day = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    md = re.search(r'\b' + _MONTH_RE + r' (\d{1,2})\b', t)
    dm = None if md else re.search(r'\b(\d{1,2}) ' + _MONTH_RE, t)
    week = re.search(r'\b(mon|tue|wed|thu|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?\b', t)
    try:
        if md or dm:
            month, dom = (md.group(1), md.group(2)) if md else (dm.group(2), dm.group(1))
            day = day.replace(month=_MONTHS[month], day=int(dom))
            if day < local - timedelta(days=2):          # December -> January
                day = day.replace(year=day.year + 1)
        elif 'tomorrow' in t:
            day += timedelta(days=1)
        elif week:
            day += timedelta(days=(_DAYS[week.group(1)] - local.weekday()) % 7)
            if day <= local:
                day += timedelta(days=7)
        elif clock:
            if day <= local and 'today' not in t:
                day += timedelta(days=1)
        else:
            return None
    except ValueError:
        return None
    return (day.replace(tzinfo=tz) if tz else day.astimezone()).timestamp()


def _window(minutes, used, resets_at):
    return {'minutes': minutes, 'used': max(0.0, min(100.0, float(used))), 'resets_at': resets_at}


# ── Claude ───────────────────────────────────────────────────────────────────

_CLAUDE_LINE = re.compile(
    r'^\s*Current (session|week)(?: \(([^)]*)\))?:\s*<?\s*(\d+(?:\.\d+)?)%\s*used(?:[^\n]*?resets?\s+(?:at\s+)?([^\n]+))?',
    re.I | re.M)


def parse_claude(text, now=None):
    windows = {}
    for kind, scope, used, when in _CLAUDE_LINE.findall(text):
        if kind.lower() == 'session':
            minutes = FIVE_HOURS
        elif not scope or 'all' in scope.lower():
            minutes = WEEK
        else:                                   # per-model weekly limits are not shown
            continue
        resets = parse_when(when, now) if when else None
        if resets and resets % 3600 == 3540:    # the CLI prints the same reset as 3:59 on one read and 4:00 on the next
            resets += 60
        windows.setdefault(minutes, _window(minutes, used, resets))
    return [windows[k] for k in sorted(windows)]


def _claude_env(profile):
    env = _clean_env(('CLAUDE', 'ANTHROPIC'))
    home = profile or os.environ.get('CLAUDE_CONFIG_DIR')
    if home:
        env['CLAUDE_CONFIG_DIR'] = home
    return env


def _claude_name(profile, email):
    """The name on the account, as Claude Code noted it down at sign-in; None if it is not there."""
    home = profile or os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~')
    try:
        with open(os.path.join(home, '.claude.json'), encoding='utf-8') as f:
            account = json.load(f).get('oauthAccount') or {}
    except (OSError, ValueError, AttributeError):
        return None
    if (account.get('emailAddress') or '').lower() != (email or '').lower():
        return None
    return account.get('displayName') or account.get('fullName')


def read_claude(profile):
    exe = claude_exe()
    if not exe:
        raise UsageError('missing_claude')
    env = _claude_env(profile)
    try:
        who = json.loads(_run([exe, 'auth', 'status'], env).stdout)
    except ValueError:
        raise UsageError('no_answer', 'Claude Code')
    if not who.get('loggedIn'):
        raise UsageError('login')
    r = _run([exe, '-p', '/usage', '--output-format', 'json', '--safe-mode', '--no-session-persistence'], env, 90)
    try:
        text = json.loads(r.stdout).get('result') or ''
    except (ValueError, AttributeError):
        text = r.stdout or r.stderr
    windows = parse_claude(text)
    if not windows:
        low = text.lower()
        if 'login' in low or 'expired' in low or 'authenticat' in low:
            raise UsageError('login')
        raise UsageError('no_numbers')
    return {'email': who.get('email'), 'name': _claude_name(profile, who.get('email')),
            'plan': who.get('subscriptionType'), 'windows': windows}


# ── ChatGPT (Codex) ──────────────────────────────────────────────────────────

NO_PLUGINS = ['-c', 'features.plugins=false']    # or every new profile downloads the plugin store

class _Codex:
    """One `codex app-server` process, spoken to over JSON lines."""

    def __init__(self, profile):
        exe = codex_exe()
        if not exe:
            raise UsageError('missing_codex')
        env = _clean_env(('CODEX', 'OPENAI'))
        if profile:
            os.makedirs(profile, exist_ok=True)
            config = os.path.join(profile, 'config.toml')
            if not os.path.exists(config):       # keep this login in its own folder, not a shared keyring
                with open(config, 'w', encoding='utf-8') as f:
                    f.write('cli_auth_credentials_store = "file"\n')
            env['CODEX_HOME'] = profile
        elif os.environ.get('CODEX_HOME'):
            env['CODEX_HOME'] = os.environ['CODEX_HOME']
        try:
            self.proc = subprocess.Popen([exe, *NO_PLUGINS, 'app-server'], env=env, cwd=tempfile.gettempdir(),
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                         text=True, encoding='utf-8', errors='replace', creationflags=NO_WINDOW)
        except OSError as e:
            raise UsageError('cannot_run', 'Codex: %s' % e)
        self.inbox, self.seen, self.next_id = queue.Queue(), [], 0
        threading.Thread(target=self._pump, daemon=True).start()
        try:
            self.call('initialize', {'clientInfo': {'name': 'usage-tracker', 'version': '1.0'}})
            self._send({'method': 'initialized'})
        except BaseException:
            self.close()
            raise

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def close(self):
        _kill_tree(self.proc)

    def _pump(self):
        for line in self.proc.stdout:
            try:
                self.inbox.put(json.loads(line))
            except ValueError:
                pass
        self.inbox.put(None)

    def _send(self, obj):
        try:
            self.proc.stdin.write(json.dumps(obj) + '\n')
            self.proc.stdin.flush()
        except OSError:
            raise UsageError('no_answer', 'Codex')

    def wait(self, match, timeout):
        """First message satisfying match; messages that arrive meanwhile are kept for later waits."""
        for i, msg in enumerate(self.seen):
            if match(msg):
                return self.seen.pop(i)
        end = time.monotonic() + timeout
        while True:
            try:
                msg = self.inbox.get(timeout=max(0.01, end - time.monotonic()))
            except queue.Empty:
                raise UsageError('no_answer', 'Codex')
            if msg is None:
                self.inbox.put(None)
                raise UsageError('no_answer', 'Codex')
            if match(msg):
                return msg
            self.seen.append(msg)
            if time.monotonic() > end:
                raise UsageError('no_answer', 'Codex')

    def call(self, method, params=None, timeout=40):
        self.next_id += 1
        mine = self.next_id
        self._send({'id': mine, 'method': method, **({'params': params} if params is not None else {})})
        msg = self.wait(lambda m: m.get('id') == mine and ('result' in m or 'error' in m), timeout)
        if 'error' in msg:
            text = str((msg['error'] or {}).get('message') or '')
            low = text.lower()
            login = 'authentication' in low or 'token' in low or '401' in low or 'sign in' in low
            raise UsageError('login') if login else UsageError('other', text or 'Codex')
        return msg['result']


def parse_codex(limits):
    windows = []
    for key in ('primary', 'secondary'):
        w = (limits or {}).get(key)
        if w and w.get('usedPercent') is not None:
            windows.append(_window(w.get('windowDurationMins') or (FIVE_HOURS if key == 'primary' else WEEK),
                                   w['usedPercent'], w.get('resetsAt')))
    return sorted(windows, key=lambda w: w['minutes'])


def read_chatgpt(profile):
    with _Codex(profile) as rpc:
        account = (rpc.call('account/read', {'refreshToken': False}) or {}).get('account')
        if not account or account.get('type') != 'chatgpt':
            raise UsageError('login')
        windows = parse_codex(rpc.call('account/rateLimits/read').get('rateLimits'))
    if not windows:
        raise UsageError('no_limits')
    return {'email': account.get('email'), 'name': account.get('workspaceName'), 'plan': account.get('planType'),
            'windows': windows}


# ── Gemini ───────────────────────────────────────────────────────────────────

class _Text(HTMLParser):
    SKIP = {'script', 'style', 'svg', 'template', 'noscript', 'head'}
    BLOCK = {'div', 'p', 'li', 'section', 'h1', 'h2', 'h3', 'h4', 'h5', 'tr', 'td', 'br', 'button', 'header', 'main'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.skipping = [], []

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skipping.append(tag)
        elif tag in self.BLOCK:
            self.out.append('\n')

    def handle_endtag(self, tag):
        if self.skipping and tag == self.skipping[-1]:
            self.skipping.pop()
        elif tag in self.BLOCK:
            self.out.append('\n')

    def handle_data(self, data):
        if not self.skipping:
            self.out.append(data)


def page_text(html):
    p = _Text()
    p.feed(html)
    lines = (re.sub(r'\s+', ' ', s).strip() for s in ''.join(p.out).split('\n'))
    return '\n'.join(s for s in lines if s)


_WEEKLY = re.compile(r'week', re.I)
_SHORT = re.compile(r'current|session|5[ -]?h|five[ -]h|hour', re.I)
_RESET = re.compile(r'(?:resets?|refresh(?:es)?|renews?|available again)\b[: ]*(.*)', re.I)


def parse_gemini(text, now=None):
    """Finds the five-hour and weekly percentages and their reset times in the usage page's text."""
    lines = text.split('\n')
    found, section = {}, None
    for i, line in enumerate(lines):
        if len(line) <= 60 and not re.search(r'every', line, re.I):
            # a reset line may say "in 2 hours" or name a weekday: only other lines can be headings
            if not _RESET.search(line):
                if _WEEKLY.search(line):
                    section = WEEK
                elif _SHORT.search(line):
                    section = FIVE_HOURS
        pct = re.search(r'(\d+(?:\.\d+)?) ?%', line)
        if pct and len(line) <= 80:
            key = section
            if key is None or 'used' in found.get(key, {}):
                key = next((k for k in (FIVE_HOURS, WEEK) if 'used' not in found.get(k, {})), None)
            if key is None:
                continue
            section = key
            value = float(pct.group(1))
            near = line + ' ' + (lines[i + 1] if i + 1 < len(lines) and len(lines[i + 1]) < 20 else '')
            left = re.search(r'\b(left|remaining)\b', near, re.I) and not re.search(r'\bused\b', line, re.I)
            found.setdefault(key, {})['used'] = 100 - value if left else value
        reset = _RESET.search(line)
        if reset and len(line) <= 90 and not re.search(r'every', line, re.I) and section:
            # the time may be on the same line or the next one
            when = parse_when(reset.group(1), now) or (parse_when(lines[i + 1], now) if i + 1 < len(lines) else None)
            if when:
                found.setdefault(section, {}).setdefault('resets_at', when)
    return [_window(k, found[k]['used'], found[k].get('resets_at')) for k in (FIVE_HOURS, WEEK)
            if 'used' in found.get(k, {})]


def _gemini_flags(profile):
    return ['--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
            '--disable-background-mode', '--lang=en-US']


def read_gemini(profile):
    exe = browser_exe()
    if not exe:
        raise UsageError('missing_browser')
    if not profile:
        raise UsageError('login')
    html = _run([exe, '--headless=new', *_gemini_flags(profile), '--disable-extensions', '--mute-audio',
                 '--virtual-time-budget=25000', '--dump-dom', GEMINI_USAGE], timeout=90).stdout
    text = page_text(html)
    windows = parse_gemini(text)
    if not windows:
        if 'ServiceLogin' in html or re.search(r'^Sign in$', text, re.M) or not html.strip():
            raise UsageError('login')
        with open(os.path.join(profile, 'last-page.txt'), 'w', encoding='utf-8') as f:
            f.write(text)                       # so an unexpected page layout can be looked at
        raise UsageError('gemini_page')
    who = re.search(r'Google Account: ?[^"<>]*?([\w.+-]+@[\w-]+\.[\w.-]+)', html)
    return {'email': who.group(1).lower() if who else None, 'name': None, 'plan': None, 'windows': windows}


READ = {'claude': read_claude, 'chatgpt': read_chatgpt, 'gemini': read_gemini}


# ── sign-in ──────────────────────────────────────────────────────────────────

class Login:
    """One sign-in. run() blocks until it ends; raises UsageError if it did not succeed."""

    def __init__(self, provider, profile):
        self.provider, self.profile = provider, profile
        self.url, self.cancelled, self._stop = None, False, None

    def cancel(self):
        self.cancelled = True
        if self._stop:
            self._stop()

    def run(self):
        os.makedirs(self.profile, exist_ok=True)
        try:
            getattr(self, '_' + self.provider)()
        finally:
            if self._stop:
                self._stop()
        if self.cancelled:
            raise UsageError('cancelled')

    def _wait(self, proc):
        try:
            return proc.wait(LOGIN_TIMEOUT)
        except subprocess.TimeoutExpired:
            raise UsageError('login_timeout')

    def _claude(self):
        exe = claude_exe()
        if not exe:
            raise UsageError('missing_claude')
        # Claude Code hands its sign-in link to %BROWSER%: ours only notes it down, so the person can
        # choose a normal or a private window.
        hook, note = os.path.join(self.profile, 'browser.cmd'), os.path.join(self.profile, 'login-url.txt')
        with open(hook, 'w', encoding='ascii') as f:
            f.write('@echo off\r\necho %* > "%USAGE_TRACKER_URL%"\r\n')
        if os.path.exists(note):
            os.remove(note)
        env = _claude_env(self.profile)
        env.update(BROWSER=hook, USAGE_TRACKER_URL=note)
        proc = subprocess.Popen([exe, 'auth', 'login', '--claudeai'], env=env, cwd=tempfile.gettempdir(),
                                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                creationflags=NO_WINDOW)
        self._stop = lambda: _kill_tree(proc)
        try:
            for _ in range(120):
                if self.cancelled or proc.poll() is not None:
                    break
                if os.path.exists(note):
                    with open(note, encoding='utf-8', errors='replace') as f:
                        m = re.search(r'https://(?:claude\.com|claude\.ai|platform\.claude\.com)/[^\s"]+', f.read())
                    if m:
                        self.url = m.group(0)
                        break
                time.sleep(0.25)
            if not self.url and not self.cancelled:
                raise UsageError('no_link')
            if self._wait(proc) != 0 and not self.cancelled:
                raise UsageError('login_failed')
        finally:
            for path in (hook, note):
                if os.path.exists(path):
                    os.remove(path)

    def _chatgpt(self):
        with _Codex(self.profile) as rpc:
            self._stop = rpc.close
            started = rpc.call('account/login/start', {'type': 'chatgpt'})
            if not str(started.get('authUrl', '')).startswith('https://auth.openai.com/'):
                raise UsageError('no_link')
            self.url = started['authUrl']
            done = rpc.wait(lambda m: m.get('method') == 'account/login/completed', LOGIN_TIMEOUT)['params']
            if not done.get('success'):
                raise UsageError('login_failed', done.get('error') or '')
            time.sleep(0.5)                     # let it finish writing auth.json

    def _gemini(self):
        exe = browser_exe()
        if not exe:
            raise UsageError('missing_browser')
        # A window of its own profile; Google sign-in happens there and the person closes it when done.
        proc = subprocess.Popen([exe, *_gemini_flags(self.profile), '--new-window', GEMINI_USAGE])
        self._stop = lambda: _kill_tree(proc)
        self._wait(proc)
        time.sleep(1.5)                         # the profile is unlocked a moment after the window closes
