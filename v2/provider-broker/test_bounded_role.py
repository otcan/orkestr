"""The opt-in role alone disables plugins; no native/provider process runs."""
import sys
import unittest
from unittest.mock import patch

from isolation import supervisor


class ExecObserved(Exception):
    pass


class RoleTests(unittest.TestCase):
    def test_exact_native_modes_preserve_legacy_command(self):
        code_mode = ["-c", "features.code_mode=false", "-c", "features.code_mode_host=false"]
        for mode, options in (("native", code_mode),
                              ("native-bounded", ["-c", "features.plugins=false", *code_mode])):
            with self.subTest(mode=mode), \
                 patch.object(sys,"argv",["supervisor.py",mode,"9"]), \
                 patch.object(supervisor,"install_filter") as filter_install, \
                 patch.object(supervisor.os,"execve",side_effect=ExecObserved) as execute:
                with self.assertRaises(ExecObserved):supervisor.main()
                filter_install.assert_called_once_with(9)
                arguments=execute.call_args.args
                self.assertEqual(arguments[:2],("/opt/provider/native",
                    ["native",*options,"app-server","--listen","stdio://"]))


if __name__=="__main__":unittest.main()
