"""Source edits must not invalidate downloads; dependency edits must do so."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    'dependency_inputs', Path(__file__).resolve().parents[1] / 'dependency_inputs.py')
inputs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inputs)


class DependencyInputsTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name).resolve()
        self.manifest = self.root / 'v2/crates/example/Cargo.toml'
        self.target = self.manifest.parent / 'src/lib.rs'
        for path, data in ((self.root / 'v2/Cargo.toml', '[workspace]'),
                           (self.root / 'v2/Cargo.lock', 'version = 4'),
                           (self.manifest, '[package]\nname="example"'),
                           (self.target, 'pub fn original() {}'),
                           (self.root / 'package.json', '{"name":"example"}'),
                           (self.root / 'package-lock.json', '{"lockfileVersion":3}')):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(data)
        self.metadata = {'workspace_root': str(self.root / 'v2'), 'packages': [
            {'manifest_path': str(self.manifest), 'targets': [{'src_path': str(self.target)}]}]}

    def snapshot(self, name):
        output = self.root / name
        with patch.object(inputs.subprocess, 'check_output',
                          return_value=json.dumps(self.metadata)) as command:
            inputs.create(self.root, output)
        self.assertIn('--offline', command.call_args.args[0])
        self.assertIn('--locked', command.call_args.args[0])
        return {p.relative_to(output).as_posix(): p.read_bytes()
                for p in output.rglob('*') if p.is_file()}

    def test_source_changes_keep_identical_download_inputs_and_no_real_code(self):
        before = self.snapshot('before')
        self.target.write_text('pub fn completely_different() { panic!("new source"); }')
        after = self.snapshot('after')
        self.assertEqual(before, after)
        self.assertEqual(after['v2/crates/example/src/lib.rs'], b'')

    def test_each_manifest_and_lockfile_change_invalidates_inputs(self):
        before = self.snapshot('before')
        for index, name in enumerate(('v2/Cargo.toml', 'v2/Cargo.lock',
                                      'v2/crates/example/Cargo.toml',
                                      'package.json', 'package-lock.json')):
            path = self.root / name
            path.write_text(path.read_text() + '\n')
            after = self.snapshot('changed-' + str(index))
            self.assertNotEqual(before, after, name)
            before = after

    def test_target_selection_and_cargo_configuration_are_in_the_key(self):
        before = self.snapshot('before')
        other = self.target.with_name('main.rs')
        other.write_text('fn main() {}')
        self.metadata['packages'][0]['targets'].append({'src_path': str(other)})
        selected = self.snapshot('selected')
        self.assertNotEqual(before, selected)
        config = self.root / '.cargo/config.toml'
        config.parent.mkdir()
        config.write_text('[net]\noffline=true\n')
        self.assertNotEqual(selected, self.snapshot('configured'))

    def test_symlink_and_outside_repository_inputs_are_refused(self):
        actual = self.manifest.with_suffix('.actual')
        self.manifest.rename(actual)
        self.manifest.symlink_to(actual)
        with self.assertRaisesRegex(ValueError, 'regular in-repository'):
            self.snapshot('symlink')
        self.manifest.unlink()
        actual.rename(self.manifest)
        with tempfile.NamedTemporaryFile() as outside:
            self.metadata['packages'][0]['targets'][0]['src_path'] = outside.name
            with self.assertRaisesRegex(ValueError, 'regular in-repository'):
                self.snapshot('outside')

    def test_existing_output_is_never_reused_as_dependency_input(self):
        self.snapshot('existing')
        with self.assertRaises(FileExistsError):
            self.snapshot('existing')


if __name__ == '__main__':
    unittest.main()
