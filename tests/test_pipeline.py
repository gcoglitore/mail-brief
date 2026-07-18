"""Starter test suite for the Mail Brief pipeline.

Run: python -m unittest discover -s tests
Covers HTML→text extraction, quote/signature stripping, heuristic classification,
and item identity. (Failed-account merge / IMAP paths need integration fixtures
and are tracked separately.)
"""
import email.message
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "pipeline"))
import refresh_mail as rm  # noqa: E402


class HtmlToText(unittest.TestCase):
    def test_strips_tags_and_decodes_entities(self):
        out = rm.html_to_text("<p>Hello&nbsp;<b>Gio</b> &amp; team</p>")
        self.assertIn("Hello", out)
        self.assertIn("Gio", out)
        self.assertIn("& team", out)
        self.assertNotIn("<", out)

    def test_skips_style_and_script(self):
        out = rm.html_to_text("<style>.x{color:red}</style><script>alert(1)</script><p>Body</p>")
        self.assertNotIn("color:red", out)
        self.assertNotIn("alert", out)
        self.assertIn("Body", out)

    def test_block_tags_become_newlines(self):
        out = rm.html_to_text("<div>Line one</div><div>Line two</div>")
        self.assertIn("Line one", out)
        self.assertIn("Line two", out)
        self.assertIn("\n", out)

    def test_malformed_html_does_not_raise(self):
        self.assertIsInstance(rm.html_to_text("<p>unclosed <b>bold"), str)


class StripReplyChrome(unittest.TestCase):
    def test_cuts_gmail_reply_chain(self):
        t = ("Yes, that works for me.\n\n"
             "On Mon, Jul 1, 2026 at 9:00 AM Bob <b@x.com> wrote:\n> earlier stuff\n> more")
        self.assertEqual(rm.strip_reply_chrome(t), "Yes, that works for me.")

    def test_cuts_outlook_original_message(self):
        t = "Sounds good.\n\n-----Original Message-----\nFrom: Bob\nblah blah"
        self.assertEqual(rm.strip_reply_chrome(t), "Sounds good.")

    def test_cuts_standard_signature(self):
        t = "Here is the file you asked for.\n\n--\nGio\nCEO, QLAD"
        self.assertEqual(rm.strip_reply_chrome(t), "Here is the file you asked for.")

    def test_cuts_sent_from_signature(self):
        t = "On my way now, see you soon.\n\nSent from my iPhone"
        self.assertEqual(rm.strip_reply_chrome(t), "On my way now, see you soon.")

    def test_does_not_over_trim_short_body(self):
        # A marker matching near the top must not shrink the body to nothing.
        self.assertEqual(rm.strip_reply_chrome("-- hi"), "-- hi")

    def test_keeps_body_without_markers(self):
        t = "Just a normal note with no quoting or signature at all."
        self.assertEqual(rm.strip_reply_chrome(t), t)


class ExtractText(unittest.TestCase):
    def _msg(self, subtype, body):
        m = email.message.EmailMessage()
        m.set_content(body, subtype=subtype)
        return m

    def test_plain_text_strips_reply(self):
        m = self._msg("plain", "Confirmed for Tuesday.\n\nOn Jul 1 Bob <b@x.com> wrote:\n> old note")
        self.assertEqual(rm.extract_text(m), "Confirmed for Tuesday.")

    def test_html_body_becomes_clean_text(self):
        m = self._msg("html", "<div>Please <b>sign</b> page&nbsp;4.</div>")
        out = rm.extract_text(m)
        self.assertIn("sign", out)
        self.assertIn("page 4", out)
        self.assertNotIn("<", out)


class HeuristicBucket(unittest.TestCase):
    def test_junk_domain(self):
        self.assertEqual(rm.heuristic_bucket({"from_email": "promo@goalphalabs.com"}, {}), "junk")

    def test_fyi_sender(self):
        self.assertEqual(rm.heuristic_bucket({"from_email": "dse@docusign.net"}, {}), "fyi")

    def test_bulk_header_is_junk(self):
        self.assertEqual(
            rm.heuristic_bucket({"from_email": "news@acme.com"}, {"List-Unsubscribe": "<u>"}), "junk")

    def test_real_person_is_attention(self):
        self.assertEqual(rm.heuristic_bucket({"from_email": "peter@lepiscopo.com"}, {}), "attention")


class ItemId(unittest.TestCase):
    def test_prefers_message_id(self):
        self.assertEqual(rm.item_id({"msgid": "abc123"}), "abc123")

    def test_falls_back_to_composite(self):
        self.assertEqual(
            rm.item_id({"from_email": "a@b.com", "subject": "Hi", "ts": 5}), "a@b.com|Hi|5")


class ThreadKey(unittest.TestCase):
    def _m(self, refs=None, irt=None):
        m = email.message.EmailMessage()
        if refs:
            m["References"] = refs
        if irt:
            m["In-Reply-To"] = irt
        return m

    def test_uses_references_root(self):
        self.assertEqual(rm.thread_key(self._m(refs="<root@x> <b@x>"), "self@x"), "root@x")

    def test_falls_back_to_in_reply_to(self):
        self.assertEqual(rm.thread_key(self._m(irt="<parent@x>"), "self@x"), "parent@x")

    def test_singleton_uses_own_id(self):
        self.assertEqual(rm.thread_key(self._m(), "self@x"), "self@x")


class GroupThreads(unittest.TestCase):
    def test_collapses_to_latest_with_context(self):
        msgs = [
            {"msgid": "a", "thread_key": "root", "ts": 10, "unread": False, "from_name": "Bob", "snippet": "first"},
            {"msgid": "b", "thread_key": "root", "ts": 20, "unread": True, "from_name": "Bob", "snippet": "second"},
            {"msgid": "c", "thread_key": "other", "ts": 15, "unread": False, "from_name": "Ann", "snippet": "solo"},
        ]
        out = rm.group_threads(msgs)
        self.assertEqual(len(out), 2)
        root = next(x for x in out if x["msgid"] == "b")
        self.assertEqual(root["thread_count"], 2)
        self.assertEqual(len(root["thread"]), 1)
        self.assertEqual(root["thread"][0]["snippet"], "first")
        self.assertTrue(root["unread"])  # thread is unread if any message is

    def test_singleton_has_no_thread_field(self):
        out = rm.group_threads([{"msgid": "x", "thread_key": "x", "ts": 1, "unread": False}])
        self.assertNotIn("thread", out[0])


class Attachments(unittest.TestCase):
    def test_lists_named_parts_with_size(self):
        m = email.message.EmailMessage()
        m.set_content("body")
        m.add_attachment(b"PDFDATA", maintype="application", subtype="pdf", filename="contract.pdf")
        atts = rm.extract_attachments(m)
        self.assertEqual(len(atts), 1)
        self.assertEqual(atts[0]["name"], "contract.pdf")
        self.assertEqual(atts[0]["size"], 7)

    def test_plain_message_has_none(self):
        m = email.message.EmailMessage()
        m.set_content("just text")
        self.assertEqual(rm.extract_attachments(m), [])


if __name__ == "__main__":
    unittest.main()
