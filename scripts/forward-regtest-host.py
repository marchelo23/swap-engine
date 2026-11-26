#!/usr/bin/python3 -I
"""E1 only: acquire images under a prevalidated service account."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import sys

NAME = "iso_rt_fwd_svc"
HOME = Path("/home") / NAME
RUNTIME = Path("/run") / NAME
GRAPH = HOME / "storage"
RUN = RUNTIME / "storage"
INSTALLED = Path("/root/forward-regtest-host.py")
PATH = "/usr/sbin:/usr/bin"
COUNT = 65536
REFS = (
    "docker.io/btcpayserver/bitcoin@sha256:cc070dffde3073154b508e95ae64b39f433b41874dd8f2cd49c0d1b4d16a15ff",
    "docker.io/lightninglabs/lnd@sha256:8d830eaad90dce0be3aab2d3c07afbd24b92732927228e83486f91c4925d556d",
)
DIRS = ("bitcoin", "lnd-payer", "lnd-payee", "state", "secrets", "profile",
        "auth", "forward-payers", "storage", "config", "data", "cache")


def require(ok, message):
    if not ok:
        raise ValueError(message)


def command(*args):
    result = subprocess.run(args, cwd="/", env={"PATH": PATH, "LC_ALL": "C"},
                            stdin=subprocess.DEVNULL, capture_output=True,
                            text=True, check=False)
    require(result.returncode == 0, f"Falló {Path(args[0]).name} (salida omitida).")
    return result.returncode, result.stdout.strip()


def denied_sudo():
    result = subprocess.run(("/usr/bin/sudo", "-n", "-l", "-U", NAME), cwd="/",
                            env={"PATH": PATH, "LC_ALL": "C"}, stdin=subprocess.DEVNULL,
                            capture_output=True, text=True, check=False)
    return (result.returncode == 1 and not (result.stdout.strip() and result.stderr.strip())
            and re.fullmatch(rf"User {NAME} is not allowed to run sudo on \S+\.",
                             (result.stdout + result.stderr).strip()) is not None)


def absent(path):
    try:
        path.lstat()
    except FileNotFoundError:
        return True
    return False


def protected(path, mode=None):
    s = path.lstat()
    require(s.st_uid == 0 and not s.st_mode & 0o022 and not stat.S_ISLNK(s.st_mode)
            and (mode is None or stat.S_IMODE(s.st_mode) == mode),
            "Ruta administrativa no protegida.")


def check_ids(records, occupied, uid, start):
    end = start + COUNT
    require(not start <= uid < end
             and not any(start <= value < end for value in occupied),
             "Rango delegado intersecta una identidad visible.")
    own = []
    for line in records.splitlines():
        if not line.strip():
            continue
        fields = line.split(":")
        require(len(fields) == 3 and fields[0] and
                all(re.fullmatch(r"[0-9]+", x) for x in fields[1:]),
                "Registro subid ambiguo.")
        owner, a, count = fields
        a, count = int(a), int(count)
        require(count > 0 and a + count <= 2**32 - 1, "Registro subid inválido.")
        if owner == NAME or (owner.isascii() and owner.isdecimal() and int(owner) == uid):
            own.append((a, count))
        else:
            require(not a <= uid < a + count and (end <= a or a + count <= start),
                    "Asignación subid ajena solapada.")
    require(own == [(start, COUNT)], "Asignación subid de servicio ausente o ambigua.")


def verify_image(ref, output):
    images = json.loads(output)
    digest = ref.split("@")[1]
    require(isinstance(images, list) and len(images) == 1, "Inspección ambigua.")
    image = images[0]
    require((image.get("Os"), image.get("Architecture"), image.get("Digest")) ==
            ("linux", "amd64", digest) and image.get("RepoDigests") == [ref],
            "Digest, RepoDigests o plataforma inesperados.")


def simple_acl(path):
    acl = command("/usr/bin/getfacl", "-cp", path)[1]
    require(re.fullmatch(r"user::[r-][w-][x-]\ngroup::[r-][w-][x-]\nother::[r-][w-][x-]",
                         acl) is not None, "ACL extendida, heredable o no verificable.")


def check_nss(nss):
    # passwd/group may be mixed; only the custodian can attest directory-wide
    # uniqueness. The subordinate-ID backend, by contrast, must be local.
    rules = re.findall(r"^[ \t]*subid[ \t]*:[ \t]*([^#\n]*)", nss, re.MULTILINE)
    require(not rules or (len(rules) == 1 and rules[0].split() == ["files"]),
            "Backend subid no local o ambiguo.")


def preflight(uid, subid, attested):
    require(attested, "Falta atestación administrativa OP3/E2.")
    require(platform.system() == "Linux" and platform.machine() == "x86_64",
            "Sólo Linux amd64.")
    for parent in (Path("/"), Path("/root"), Path("/home"), Path("/run"), Path("/etc")):
        protected(parent)
        simple_acl(parent)
    protected(INSTALLED, 0o500)
    s = INSTALLED.lstat()
    require(stat.S_ISREG(s.st_mode) and s.st_gid == 0 and s.st_nlink == 1,
            "Copia instalada inválida.")
    simple_acl(INSTALLED)
    require(absent(Path(f"/run/user/{uid}"))
            and absent(Path("/var/lib/systemd/linger") / NAME),
            "Runtime de login o linger preexistente.")
    fs = lambda path: command("/usr/bin/findmnt", "-n", "-o", "ID,FSTYPE", "-T", path)[1].split()
    home_fs, runtime_fs = fs("/home"), fs("/run")
    require(len(home_fs) == len(runtime_fs) == 2 and home_fs[0].isdigit()
            and runtime_fs[0].isdigit()
            and home_fs[1] in {"btrfs", "ext4", "xfs"} and runtime_fs[1] == "tmpfs",
            "Se requiere home persistente local y /run tmpfs.")
    for tool in ("/usr/sbin/runuser", "/usr/sbin/nologin", "/usr/bin/passwd",
                 "/usr/bin/sudo", "/usr/bin/podman", "/usr/bin/newuidmap", "/usr/bin/newgidmap"):
        require(os.access(tool, os.X_OK), "Falta un binario administrativo requerido.")
    nss = Path("/etc/nsswitch.conf")
    protected(nss)
    check_nss(nss.read_text())
    for database, filename in (("passwd", "subuid"), ("group", "subgid")):
        lookup = lambda *keys: command("/usr/bin/getent", database, *keys)[1]
        entry = lookup(NAME)
        fields = entry.split(":")
        require("\n" not in entry and fields[0] == NAME and lookup(str(uid)) == entry and
                ((database == "passwd" and len(fields) == 7 and
                  fields[2:4] == [str(uid)] * 2 and fields[5:] == [str(HOME), "/usr/sbin/nologin"])
                 or (database == "group" and len(fields) == 4 and fields[2:] == [str(uid), ""])),
                "Identidad efectiva ausente, ambigua o inesperada.")
        occupied = set()
        seen = 0
        for line in lookup().splitlines():
            record = line.split(":")
            require(len(record) == len(fields), "Enumeración NSS ambigua.")
            if record[0] == NAME or int(record[2]) == uid:
                require(line == entry, "Identidad NSS visible en conflicto.")
                seen += 1
            else:
                occupied.add(int(record[2]))
            if database == "passwd":
                require(record[0] == NAME or int(record[3]) != uid,
                        "Grupo primario compartido.")
                occupied.add(int(record[3]))
        require(seen <= 1, "Identidad NSS visible duplicada.")
        path = Path("/etc") / filename
        protected(path)
        require(stat.S_ISREG(path.lstat().st_mode), "Archivo subid no regular.")
        check_ids(path.read_text(), occupied, uid, subid)
    status = command("/usr/bin/passwd", "-S", NAME)[1].split()
    require(command("/usr/bin/id", "-u", NAME)[1] == str(uid)
            and command("/usr/bin/id", "-G", NAME)[1] == str(uid)
            and status[:2] == [NAME, "L"] and denied_sudo(),
            "Cuenta con grupos, contraseña o sudo no conformes.")
    for path, children in ((HOME, set(DIRS)), (RUNTIME, {"storage"}),
                           *((HOME / name, set()) for name in DIRS), (RUN, set())):
        s = path.lstat()
        require(stat.S_ISDIR(s.st_mode) and stat.S_IMODE(s.st_mode) == 0o700
                and (s.st_uid, s.st_gid) == (uid, uid)
                and fs(str(path)) == (runtime_fs if path.is_relative_to(RUNTIME) else home_fs),
                "Custodia, modo o filesystem de directorio inesperado.")
        simple_acl(path)
        require({child.name for child in path.iterdir()} == children,
                "Directorio no vacío o árbol no conforme; no se adopta.")


def acquire(uid, subid):
    auth = RUNTIME / "auth.json"

    def service(*args):
        return command("/usr/sbin/runuser", "-u", NAME, "--", *args)[1]

    def podman(*args):
        return service("/usr/bin/env", "-i", f"PATH={PATH}", "LC_ALL=C",
                       f"HOME={HOME}", f"USER={NAME}", f"LOGNAME={NAME}",
                       f"XDG_RUNTIME_DIR={RUNTIME}", f"XDG_CONFIG_HOME={HOME / 'config'}",
                       f"XDG_DATA_HOME={HOME / 'data'}", f"XDG_CACHE_HOME={HOME / 'cache'}",
                       "/usr/bin/podman", "--remote=false", "--root", GRAPH,
                       "--runroot", RUN, "--storage-driver", "vfs", *args)

    def inventory():
        return [podman("ps", "-aq"), podman("volume", "ls", "-q"), podman("network", "ls", "-q")]

    require(service("/usr/bin/id", "-u") == str(uid)
            and service("/usr/bin/id", "-G") == str(uid),
            "El contexto efectivo de runuser no coincide.")
    service("/usr/bin/python3", "-I", "-c",
            "import os,sys; os.umask(0o077); f=open(sys.argv[1],'x'); f.write('{}\\n'); f.close()",
            auth)
    try:
        maps = podman("unshare", "/usr/bin/cat", "/proc/self/uid_map", "/proc/self/gid_map")
        expected = [0, uid, 1, 1, subid, COUNT] * 2
        require([int(x) for x in maps.split()] == expected, "Mapeo rootless inesperado.")
        info = podman("info", "--format", "{{.Host.Security.Rootless}} {{.Store.GraphRoot}} {{.Store.RunRoot}}")
        require(info == f"true {GRAPH} {RUN}", "Almacén no dedicado.")
        before = inventory()
        require(before[:2] == ["", ""] and not podman("images", "-aq"),
                "Almacén nuevo no está vacío.")
        print(f"{info}; disponible antes: {available_bytes(HOME)} bytes.")
        for ref in REFS:
            podman("pull", "--authfile", auth, "--tls-verify=true", "--platform", "linux/amd64", ref)
            verify_image(ref, podman("image", "inspect", ref))
        require(len(podman("images", "-aq", "--no-trunc").splitlines()) == 2
                and inventory() == before, "Inventario final inesperado.")
        for ref in REFS:
            print(f"linux/amd64 {ref}")
        print(f"Disponible después: {available_bytes(HOME)} bytes; sin cambio en contenedores, redes ni volúmenes.")
    finally:
        service("/usr/bin/rm", "--", auth)


def available_bytes(path):
    fs = os.statvfs(path)
    return fs.f_bavail * fs.f_frsize


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--preflight", action="store_true")
    parser.add_argument("--attest-op3", action="store_true",
                        help="El custodio atestigua OP3/E2 y exclusión administrativa")
    parser.add_argument("--id", type=int, required=True, help="UID y GID exclusivos aprobados")
    parser.add_argument("--subid", type=int, required=True, help="Inicio de 65536 subuid y subgid")
    args = parser.parse_args()
    require(1000 <= args.id < 60000 and 65536 <= args.subid <= 2**32 - 1 - COUNT,
            "ID o inicio subid fuera de límites.")
    print(f"{NAME}: UID/GID {args.id}; subuid/subgid {args.subid}:{COUNT}; {HOME}; {RUNTIME}")
    print("\n".join(REFS))
    if not (args.apply or args.preflight):
        print("Plan sin efectos; no valida disponibilidad ni autoriza apply.")
        return
    require(os.geteuid() == 0 and sys.flags.isolated and sys.stdin.isatty()
            and os.path.abspath(__file__) == str(INSTALLED),
            "Preflight/E1 exige terminal local y copia protegida con Python aislado.")
    os.umask(0o077)
    preflight(args.id, args.subid, args.attest_op3)
    with INSTALLED.open("rb") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Recheck after acquiring the one-invocation lock.
        preflight(args.id, args.subid, args.attest_op3)
        print("Preflight local conforme; OP3/E2 atestiguado por el custodio.")
        if args.apply:
            try:
                acquire(args.id, args.subid)
            except Exception:
                raise RuntimeError("E1 iniciado; resultado parcial o incierto.") from None
            except KeyboardInterrupt:
                raise RuntimeError("E1 interrumpido; resultado parcial o incierto.") from None


if __name__ == "__main__":
    try:
        main()
    except RuntimeError:
        sys.exit("E1 iniciado; resultado parcial o incierto. Inventariar y reconciliar como "
                 "custodio; no reintentar ni limpiar automáticamente.")
    except (ValueError, OSError, IndexError, AttributeError, KeyboardInterrupt) as error:
        # Do not echo raw subprocess output or exception data (e.g. JSON).
        message = str(error) if type(error) is ValueError else "Error o interrupción."
        sys.exit(f"Preflight rechazado; E1 no inició. {message}")
