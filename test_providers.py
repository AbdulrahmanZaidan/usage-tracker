"""py -3 test_providers.py"""
import unittest
from datetime import datetime

from providers import (FIVE_HOURS, WEEK, page_text, parse_claude, parse_claude_resets, parse_codex, parse_codex_resets,
                       parse_gemini, parse_when)

NOW = datetime(2026, 11, 24, 23, 0).timestamp()          # a Tuesday


def at(*parts):
    return datetime(*parts).timestamp()


class When(unittest.TestCase):
    def test_forms(self):
        for text, want in [
            ('Nov 25, 3:59am (Nowhere/City)', at(2026, 11, 25, 3, 59)),
            ('Nov 25, 4am (Nowhere/City)', at(2026, 11, 25, 4)),
            ('Nov 25 at 12:30 AM', at(2026, 11, 25, 0, 30)),
            ('25 November, 18:05', at(2026, 11, 25, 18, 5)),
            ('Jan 2, 1pm', at(2027, 1, 2, 13)),
            ('11:30pm', at(2026, 11, 24, 23, 30)),
            ('4am', at(2026, 11, 25, 4)),
            ('tomorrow at 3 PM', at(2026, 11, 25, 15)),
            ('Saturday at 3:00 p.m.', at(2026, 11, 28, 15)),
            ('in 2 hr 5 min', NOW + 7500),
            ('in 3 days 4 hours', NOW + 3 * 86400 + 4 * 3600),
            ('soon', None),
            ('', None),
        ]:
            self.assertEqual(parse_when(text, NOW), want, text)

    def test_named_zone(self):
        self.assertEqual(parse_when('Nov 25, 4am (UTC)', NOW), 1795579200.0)


class Claude(unittest.TestCase):
    def test_real_output(self):
        text = ('You are currently using your subscription to power your Claude Code usage\n\n'
                'Current session: 2% used · resets Nov 25, 3:59am (Nowhere/City)\n'
                'Current week (all models): 81% used · resets Nov 25, 4:59am (Nowhere/City)\n'
                'Current week (Opus): 12% used · resets Nov 25, 4:59am (Nowhere/City)\n\n'
                "What's contributing to your usage?\n  100%  Review sessions active over many hours\n")
        self.assertEqual(parse_claude(text, NOW), [
            {'minutes': FIVE_HOURS, 'used': 2.0, 'resets_at': at(2026, 11, 25, 4)},
            {'minutes': WEEK, 'used': 81.0, 'resets_at': at(2026, 11, 25, 5)}])

    def test_window_not_started(self):
        self.assertEqual(parse_claude('Current session: 0% used\nCurrent week (all models): 5% used', NOW), [
            {'minutes': FIVE_HOURS, 'used': 0.0, 'resets_at': None}, {'minutes': WEEK, 'used': 5.0, 'resets_at': None}])

    def test_nothing(self):
        self.assertEqual(parse_claude('Failed to load usage data', NOW), [])


class Codex(unittest.TestCase):
    def test_windows_sorted_by_length(self):
        limits = {'primary': {'usedPercent': 69, 'windowDurationMins': 10080, 'resetsAt': 2},
                  'secondary': {'usedPercent': 14, 'windowDurationMins': 300, 'resetsAt': 1}}
        self.assertEqual(parse_codex(limits), [{'minutes': 300, 'used': 14.0, 'resets_at': 1},
                                               {'minutes': 10080, 'used': 69.0, 'resets_at': 2}])

    def test_one_window_or_none(self):
        self.assertEqual(len(parse_codex({'primary': {'usedPercent': 1, 'windowDurationMins': 43200}, 'secondary': None})), 1)
        self.assertEqual(parse_codex(None), [])


class Resets(unittest.TestCase):
    def claude(self, **more):
        return parse_claude_resets({'oauthAccount': {'accountUuid': 'me'}, **more}, NOW)

    def cached(self, block, uuid='me'):
        return {'cachedUsageUtilization': {'accountUuid': uuid, 'utilization': {'cedar_ember': block}}}

    def test_codex(self):
        self.assertIsNone(parse_codex_resets(None))
        self.assertEqual(parse_codex_resets({'availableCount': 0, 'credits': []}), {'count': 0, 'until': None})
        self.assertEqual(parse_codex_resets({'availableCount': 2, 'credits': [
            {'status': 'available', 'expiresAt': 900}, {'status': 'available', 'expiresAt': 500},
            {'status': 'redeemed', 'expiresAt': 100}]}), {'count': 2, 'until': 500})

    def test_claude_not_asked_is_not_zero(self):
        self.assertIsNone(self.claude())
        self.assertIsNone(self.claude(**self.cached(None)))
        self.assertIsNone(self.claude(**self.cached({'grants': []}, uuid='someone else')))
        self.assertIsNone(parse_claude_resets({}, NOW))

    def test_claude_grants(self):
        self.assertEqual(self.claude(**self.cached({'eligible': False, 'grants': []})), {'count': 0, 'until': None})
        grants = [{'resets_left': 1, 'ends_at': '2026-12-10T22:00:00+00:00'}, {'resets_left': 2, 'ends_at': None},
                  {'resets_left': 3, 'ends_at': '2026-11-01T00:00:00+00:00'},
                  {'resets_left': 4, 'ends_at': None, 'paused': True}]
        self.assertEqual(self.claude(**self.cached({'grants': grants})), {'count': 3, 'until': 1796940000.0})

    def test_claude_note(self):
        note = {'accountUuid': 'me', 'holdsUnusedReset': False, 'checkedAt': (NOW - 60) * 1000, 'validUntil': (NOW + 60) * 1000}
        self.assertEqual(self.claude(unusedLimitResetStatusCache=note), {'count': 0, 'until': None})
        self.assertEqual(self.claude(unusedLimitResetStatusCache={**note, 'holdsUnusedReset': True}), {'count': None, 'until': None})
        self.assertIsNone(self.claude(unusedLimitResetStatusCache={**note, 'checkedAt': (NOW - 4 * 86400) * 1000}))
        self.assertIsNone(self.claude(unusedLimitResetStatusCache={**note, 'accountUuid': 'someone else'}))


class Gemini(unittest.TestCase):
    """Layouts the usage page might use; the real one has not been seen yet."""
    WANT = [{'minutes': FIVE_HOURS, 'used': 12.0, 'resets_at': at(2026, 11, 25, 1, 45)},
            {'minutes': WEEK, 'used': 40.0, 'resets_at': at(2026, 11, 28, 3)}]

    def test_percent_then_reset(self):
        text = ('Usage limits\nYour limit refreshes every 5 hours until you reach your weekly limit.\n'
                'Current usage\n12% used\nResets at 1:45 AM\nWeekly limit\n40% used\nResets Nov 28 at 3:00 AM')
        self.assertEqual(parse_gemini(text, NOW), self.WANT)

    def test_reset_then_percent(self):
        text = 'Current usage\nResets in 2 hr 45 min\n12% used\nWeekly limit\nResets Saturday at 3:00 AM\n40% used'
        self.assertEqual(parse_gemini(text, NOW), self.WANT)

    def test_weekly_first_and_remaining(self):
        text = 'Weekly limit\n60% remaining\nResets Nov 28, 3 AM\n5-hour limit\n88%\nleft\nResets\nin 2 hours 45 minutes'
        self.assertEqual(parse_gemini(text, NOW), self.WANT)

    def test_page_without_numbers(self):
        self.assertEqual(parse_gemini("Hi, I'm Gemini.\nSign in", NOW), [])

    def test_page_text(self):
        html = '<head><title>x</title></head><body><script>1%</script><div>Weekly <b>limit</b></div><p>40% used</p></body>'
        self.assertEqual(page_text(html), 'Weekly limit\n40% used')


if __name__ == '__main__':
    unittest.main()
