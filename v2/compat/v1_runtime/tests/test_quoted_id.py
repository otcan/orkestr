import unittest

from v2.compat.v1_runtime.intake import with_quoted_id


QUOTED = dict(message_id="true_chat_3EB0ABC_51346837356638@lid", author="orkestr", sent_at="2026-10-30T19:13:06Z",
              text="Caddy reload", is_own_reply=True, unavailable=False)


class QuotedIdTest(unittest.TestCase):
    def test_id_joins_the_reply_line(self):
        text = '[WhatsApp: Orkestr Rust]\n\n[Replying to Orkestr message from 20:13: "Caddy reload"]\n\nwhere did this come from?'
        out = with_quoted_id(text, QUOTED)
        self.assertEqual(out, '[WhatsApp: Orkestr Rust]\n\n[Replying to Orkestr message from 20:13: "Caddy reload"] '
                              '[quoted message id: true_chat_3EB0ABC_51346837356638@lid]\n\nwhere did this come from?')
        # Still one bracketed line, so the UI's quote bubble keeps hiding it.
        line = out.split("\n\n")[1]
        self.assertTrue(line.startswith("[Replying to ") and line.endswith("]") and "\n" not in line)
        self.assertEqual(with_quoted_id(out, QUOTED), out)

    def test_unchanged_without_id_or_reply_line(self):
        text = '[WhatsApp: Orkestr Rust]\n\nhello'
        self.assertEqual(with_quoted_id(text, QUOTED), text)
        self.assertEqual(with_quoted_id('[Replying to an unavailable message]\n\nx', dict(QUOTED, message_id=None)),
                         '[Replying to an unavailable message]\n\nx')
        self.assertEqual(with_quoted_id(text, None), text)


if __name__ == "__main__":
    unittest.main()
