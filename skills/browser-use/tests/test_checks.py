"""公共参数校验与目标消失判断。"""
import math
import unittest

from browser_use.checks import GONE, boolean, gone, integer, number, origin, positive, seconds, stale, string, url_origin
from browser_use.errors import BrowserUseError


class ChecksTest(unittest.TestCase):
    def rejects(self, func, *args, **kwargs):
        with self.assertRaises(BrowserUseError) as raised:
            func(*args, **kwargs)
        self.assertEqual(raised.exception.code, 2, str(raised.exception))
        return str(raised.exception)

    def test_boolean(self):
        self.assertIs(boolean(False, 'x'), False)
        for bad in (0, 1, None, 'true'):
            self.assertEqual(self.rejects(boolean, bad, 'flag'), 'flag 需要布尔值')

    def test_integer_keeps_value_and_rejects_bool_float(self):
        self.assertEqual(integer(3, 'n', 1, 3), 3)
        self.assertEqual(integer(10 ** 12, 'n', 1), 10 ** 12)
        for bad in (True, 1.0, 0, 4, None, '2'):
            self.rejects(integer, bad, 'n', 1, 3)
        self.assertEqual(self.rejects(integer, 0, 'n', 1, 3), 'n 需要 1~3 的整数')
        self.assertEqual(self.rejects(integer, 0, 'limit', 1), 'limit 需要不小于 1 的整数')

    def test_number_keeps_type_and_bounds(self):
        self.assertIsInstance(number(1, 'x', 0, 1), int)
        self.assertEqual(number(0.5, 'x', 0, 1), 0.5)
        for bad in (True, math.nan, math.inf, -0.1, 1.1, None, '1'):
            self.rejects(number, bad, 'x', 0, 1)
        self.assertEqual(self.rejects(number, 2, 'x', -1e6, 1.0), 'x 需要 -1000000~1 的有限数')
        self.assertEqual(number(1e-9, 't', 0, low_open=True), 1e-9)
        self.assertEqual(self.rejects(number, 0, 't', 0, low_open=True), 't 需要大于 0 的有限数')
        self.assertEqual(self.rejects(number, 601, 't', 0, 600, low_open=True), 't 需要大于 0、不超过 600 的有限数')

    def test_positive_integer_and_zero(self):
        self.assertEqual(positive(2.0, 'n', integer=True), 2)
        self.assertIsInstance(positive(2.0, 'n', integer=True), int)
        self.assertIsInstance(positive(2, 'n'), float)
        self.assertEqual(positive(0, 'n', integer=True, zero=True), 0)
        self.assertEqual(self.rejects(positive, 0, 'n', integer=True), 'n 需要有限的正整数')
        self.assertEqual(self.rejects(positive, 1.5, 'n', integer=True, zero=True), 'n 需要有限的非负整数')
        self.rejects(positive, 1e-13, 'n')

    def test_seconds_upper_bound(self):
        self.assertEqual(seconds(120, 'timeout', 120), 120.0)
        self.assertEqual(self.rejects(seconds, 121, 'timeout', 120), 'timeout 上限 120 秒')
        self.assertEqual(self.rejects(seconds, -1), 'timeout 需要有限的正数')

    def test_string(self):
        self.assertEqual(string('', 'v', empty=True), '')
        self.assertEqual(self.rejects(string, '', 'v'), 'v 需要非空字符串')
        self.assertEqual(self.rejects(string, 'abc', 'v', limit=2), 'v 需要非空字符串（最长 2）')
        self.assertEqual(self.rejects(string, None, 'v', empty=True), 'v 需要字符串')

    def test_origin(self):
        self.assertEqual(origin('HTTPS://A.com:443/'), 'https://a.com')
        self.assertEqual(origin('http://[::1]:8080'), 'http://[::1]:8080')
        for bad in ('http://a.com/x', 'ftp://a', 'http://u@a', 'http://a?q', 'http://a:99999', '', None):
            self.rejects(origin, bad)
        self.assertEqual(origin('http://a b.com'), 'http://a b.com')
        self.rejects(origin, 'http://a b.com', fetch_pattern=True)
        self.rejects(origin, 'http://*.a.com', fetch_pattern=True)
        self.rejects(origin, 'http://' + 'a' * 3000, limit=2048)

    def test_url_origin(self):
        self.assertEqual(url_origin('http://A.com:80/x?y'), 'http://a.com')
        for bad in ('ftp://a', '', 'http://a:99999', None):
            self.assertIsNone(url_origin(bad))

    def test_gone_and_stale(self):
        for text in GONE:
            self.assertTrue(gone(BrowserUseError('Page.enable：' + text + '.', 1)))
        self.assertFalse(gone(BrowserUseError('Cannot find context with specified id', 1)))
        self.assertTrue(stale(BrowserUseError('Cannot find context with specified id', 1)))
        self.assertFalse(stale(BrowserUseError('Target closed', 1)))


if __name__ == '__main__':
    unittest.main()
