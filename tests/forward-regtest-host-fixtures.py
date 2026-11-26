"""Offline: no real administrative commands, Podman, or registry."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/forward-regtest-host.py"
spec = importlib.util.spec_from_file_location("host", SCRIPT)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class HostFixtures(unittest.TestCase):
    def test_sudo_denial(self):
        denial = f"User {host.NAME} is not allowed to run sudo on parrot.\n"
        for case, code, stdout, stderr, expected in (
            ("denied exit 0", 0, denial, "", True),
            ("denied exit 1", 1, "", denial, True),
            ("allowed", 0, f"User {host.NAME} may run the following commands on parrot:\n"
                           "    (ALL) ALL\n", "", False),
            ("permissions plus denial", 1, denial + "    (ALL) ALL\n", "", False),
            ("ambiguous prefix", 0, "Warning: " + denial, "", False),
            ("ambiguous suffix", 1, denial.rstrip() + " extra\n", "", False),
            ("extra line", 0, denial + "\n", "", False),
            ("mixed streams", 1, denial, "\n", False),
            ("split streams", 1, denial[:10], denial[10:], False),
            ("wrong user", 1, denial.replace(host.NAME, "someone_else"), "", False),
            ("unrelated error", 1, "", "sudo: a password is required\n", False),
            ("empty exit 1", 1, "", "", False),
            ("unexpected exit", 2, denial, "", False),
        ):
            with self.subTest(case=case), patch.object(host.subprocess, "run") as run:
                run.return_value = subprocess.CompletedProcess([], code, stdout, stderr)
                self.assertIs(host.denied_sudo(), expected)
                self.assertEqual(run.call_args.args[0], ("/usr/bin/sudo", "-n", "-l", "-U", host.NAME))
                self.assertEqual(run.call_args.kwargs["env"]["LC_ALL"], "C")

    def test_plan_and_checkout_apply(self):
        base = (sys.executable, "-I", SCRIPT, "--id", "2100", "--subid", "800000")
        plan = subprocess.run(base, check=True, capture_output=True, text=True)
        self.assertIn("Plan sin efectos", plan.stdout)
        self.assertEqual(plan.stdout.count("@sha256:"), 2)
        refused = subprocess.run((*base, "--apply"), capture_output=True, text=True)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("copia protegida", refused.stderr)

    def test_subid_validation(self):
        own = f"{host.NAME}:800000:65536\n"
        host.check_ids(own + "other:734464:65536\nnext:865536:65536", {0, 1000}, 2100, 800000)
        for records, occupied in (
            ("other:734465:65536", {0}), ("other:865535:65536", {0}),
            ("other:2000:200", {0}), ("iso_rt_fwd_svc:1:1", {0}),
            ("02100:1:1", {0}), ("malformed", {0}), ("other:10:0", {0}),
            ("", {865535}),
        ):
            with self.subTest(records=records, occupied=occupied), self.assertRaises(ValueError):
                host.check_ids(own + records, occupied, 2100, 800000)
        with self.assertRaisesRegex(ValueError, "ausente"):
            host.check_ids("", set(), 2100, 800000)

    def test_image_metadata(self):
        ref = host.REFS[0]
        image = dict(Os="linux", Architecture="amd64", Digest=ref.split("@")[1], RepoDigests=[ref])
        host.verify_image(ref, json.dumps([image]))
        for wrong in (dict(Os="windows"), dict(Architecture="arm64"), dict(Digest="other"),
                      dict(RepoDigests=[]), dict(RepoDigests=[ref, "other"])):
            with self.subTest(wrong=wrong), self.assertRaises(ValueError):
                host.verify_image(ref, json.dumps([image | wrong]))

    def test_preflight(self):
        from types import SimpleNamespace
        for case in ("files", "mixed", "subid-backend", "missing", "ambiguous", "sudo",
                     "acl", "copy", "unattested", "partial", "group"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as tmp:
                home, runtime, installed = (Path(tmp) / name for name in ("home", "run", "copy"))
                installed.touch(mode=0o500)
                for d in (home, runtime, runtime / "storage", *(home / n for n in host.DIRS)):
                    d.mkdir(mode=0o700)
                if case == "partial":
                    (runtime / "auth.json").touch()
                passwd = f"{host.NAME}:x:2100:2100::{home}:/usr/sbin/nologin"
                group = f"{host.NAME}:x:2100:"
                def command(*args):
                    verb, *options = args
                    if verb.endswith("getfacl"):
                        return 0, "user::rwx\ngroup::---\nother::---" + (
                            "\ndefault:user::rwx" if case == "acl" else "")
                    if verb.endswith("findmnt"):
                        return 0, "7 tmpfs" if str(options[-1]).startswith(("/run", str(runtime))) else "6 btrfs"
                    if verb.endswith("getent"):
                        db, *keys = options
                        if db == "passwd" and case == "missing":
                            raise ValueError("Falló getent")
                        return 0, (passwd if db == "passwd" else group) + (
                            ":unexpected" if keys == ["2100"] and case == "ambiguous" else "")
                    if verb.endswith("/id"):
                        return 0, "2100 27" if options[0] == "-G" and case == "group" else "2100"
                    if verb.endswith("passwd"):
                        return 0, f"{host.NAME} L"
                    self.fail(f"Efecto inesperado: {verb}")
                real_lstat = Path.lstat
                def lstat(path):
                    if path == installed or str(path).startswith("/etc/sub"):
                        return SimpleNamespace(st_mode=0o100500, st_uid=0, st_gid=0,
                                               st_nlink=2 if case == "copy" else 1)
                    s = real_lstat(path)
                    return SimpleNamespace(st_mode=s.st_mode, st_uid=2100, st_gid=2100)
                def config(path):
                    if path.name == "nsswitch.conf":
                        return ("passwd: files\n group: files\n" if case == "files" else
                                "passwd: files systemd winbind\ngroup: files systemd winbind\n") + (
                                    "  subid : sss\n" if case == "subid-backend" else "")
                    return f"{host.NAME}:800000:65536\n"
                with patch.multiple(host, HOME=home, RUNTIME=runtime, INSTALLED=installed,
                                    RUN=runtime / "storage", command=command), \
                        patch.object(host, "protected"), patch.object(host, "absent", return_value=True), \
                        patch.object(host.os, "access", return_value=True), \
                        patch.object(Path, "lstat", lstat), patch.object(Path, "read_text", config), \
                        patch.object(host, "denied_sudo", return_value=case != "sudo"), \
                        patch.object(host, "acquire") as acquire:
                    if case in ("files", "mixed"):
                        host.preflight(2100, 800000, True)
                    elif case == "missing":
                        with patch.object(host.sys, "argv", [str(installed), "--apply", "--attest-op3",
                                                             "--id", "2100", "--subid", "800000"]), \
                                patch.object(host, "__file__", str(installed)), \
                                patch.object(host.os, "geteuid", return_value=0), \
                                patch.object(host.os, "umask"), patch.object(host.sys, "flags",
                                    SimpleNamespace(isolated=True)), \
                                patch.object(host.sys.stdin, "isatty", return_value=True), \
                                patch("builtins.print"), self.assertRaisesRegex(ValueError, "getent"):
                            host.main()
                    else:
                        with self.assertRaises(ValueError):
                            host.preflight(2100, 800000, case != "unattested")
                    acquire.assert_not_called()

    def test_protected_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "copy"
            for mode, uid in ((0o100500, 0), (0o100520, 0),
                              (0o100500, 2100), (0o120500, 0)):
                from types import SimpleNamespace
                with patch.object(Path, "lstat", return_value=SimpleNamespace(st_uid=uid, st_mode=mode)):
                    if (mode, uid) == (0o100500, 0):
                        host.protected(path, 0o500)
                    else:
                        with self.assertRaises(ValueError):
                            host.protected(path, 0o500)

    def test_acquisition_fixtures(self):
        for fault in ("", "rootful", "preexisting-image", "wrong-digest"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as tmp:
                home, runtime = Path(tmp) / "home", Path(tmp) / "run"
                graph, run = home / "storage", runtime / "storage"
                pulled = []
                home.mkdir()

                runtime.mkdir()
                def command(*args):
                    self.assertEqual(args[:4], ("/usr/sbin/runuser", "-u", host.NAME, "--"))
                    if args[4] == "/usr/bin/id":
                        return 0, "2100"
                    if args[4] == "/usr/bin/python3":
                        args[-1].write_text("{}\n")
                        return 0, ""
                    if args[4] == "/usr/bin/rm":
                        args[-1].unlink()
                        return 0, ""
                    self.assertEqual(args[4:6], ("/usr/bin/env", "-i"))
                    i = args.index("/usr/bin/podman")
                    self.assertFalse(any("CONTAINER_HOST" in a or "DOCKER_HOST" in a for a in args[6:i]))
                    self.assertEqual(args[i+1:i+8], ("--remote=false", "--root", graph,
                                                       "--runroot", run, "--storage-driver", "vfs"))
                    verb, *options = args[i+8:]
                    if verb == "unshare":
                        return 0, "0 2100 1\n1 800000 65536\n" * 2
                    if verb == "info":
                        return 0, f"{'false' if fault == 'rootful' else 'true'} {graph} {run}"
                    if verb in ("ps", "volume", "network"):
                        return 0, ""
                    if verb == "images":
                        return 0, "old" if fault == "preexisting-image" else "\n".join(pulled)
                    ref = options[-1]
                    self.assertIn(ref, host.REFS)
                    if verb == "pull":
                        self.assertEqual(options, ["--authfile", runtime / "auth.json",
                                                  "--tls-verify=true", "--platform", "linux/amd64", ref])
                        self.assertEqual(json.loads(options[1].read_text()), {})
                        self.assertEqual(options[1].stat().st_mode & 0o777, 0o600)
                        pulled.append(ref)
                        return 0, ""
                    self.assertEqual((verb, options[0]), ("image", "inspect"))
                    return 0, json.dumps([dict(Os="linux", Architecture="amd64",
                        Digest="wrong" if fault else ref.split("@")[1], RepoDigests=[ref])])

                old_umask = os.umask(0o077)
                try:
                    with patch.multiple(host, HOME=home, RUNTIME=runtime, GRAPH=graph, RUN=run,
                                         command=command), \
                            patch("builtins.print"):
                        if fault:
                            with self.assertRaises(ValueError):
                                host.acquire(2100, 800000)
                        else:
                            host.acquire(2100, 800000)
                finally:
                    os.umask(old_umask)
                self.assertFalse((runtime / "auth.json").exists())
                self.assertEqual(pulled, list(host.REFS[:{"": 2, "wrong-digest": 1}.get(fault, 0)]))


if __name__ == "__main__":
    unittest.main()
