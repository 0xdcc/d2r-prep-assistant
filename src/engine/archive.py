"""Bounded ZIP protocol helper; never imports upstream code."""

import json
import os
import pathlib
import plistlib
import re
import stat
import sys
import zipfile


MAX_FILES = 100000
MAX_BYTES = 160 * 1024**3


def filesystem_path(filename):
    absolute = os.path.abspath(filename)
    if os.name != "nt" or absolute.startswith("\\\\?\\"):
        return absolute
    if absolute.startswith("\\\\"):
        return "\\\\?\\UNC\\" + absolute[2:]
    return "\\\\?\\" + absolute


def is_directory(member):
    return member.is_dir() or stat.S_IFMT(member.external_attr >> 16) == stat.S_IFDIR


def checked_members(archive, max_bytes):
    members = archive.infolist()
    if not members or len(members) > MAX_FILES:
        raise ValueError("Archive empty or file count limit exceeded")
    seen = set()
    total = 0
    for member in members:
        name = member.filename
        components = name.rstrip("/").split("/")
        if (not name or "\\" in name or "\x00" in name or ":" in name
                or name.startswith("/") or any(part in ("", ".", "..") for part in components)
                or any(part.endswith((" ", ".")) for part in components)
                or any(re.match(r"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)", part, re.I) for part in components)):
            raise ValueError("Unsafe archive member path")
        normalized = name.rstrip("/").casefold()
        if normalized in seen:
            raise ValueError("Duplicate or case-colliding archive member")
        seen.add(normalized)
        mode = member.external_attr >> 16
        file_type = stat.S_IFMT(mode)
        if file_type not in (0, stat.S_IFREG, stat.S_IFDIR) or member.flag_bits & 1:
            raise ValueError("Links, special files, or encrypted archives are forbidden")
        if (member.is_dir() and file_type == stat.S_IFREG) or (is_directory(member) and member.file_size != 0):
            raise ValueError("Conflicting archive file/directory metadata")
        if member.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise ValueError("Unsupported archive compression")
        total += member.file_size
        if total > max_bytes or member.file_size < 0:
            raise ValueError("Archive inflated byte budget exceeded")
        if member.file_size > 1024**3 and member.file_size > max(1, member.compress_size) * 2000:
            raise ValueError("Archive compression ratio exceeded")
    return members, total


def safe_destination(destination, name):
    root = pathlib.Path(filesystem_path(destination)).resolve()
    target = root.joinpath(*name.rstrip("/").split("/"))
    checked = pathlib.Path(filesystem_path(target)).resolve()
    if root not in checked.parents:
        raise ValueError("Archive destination escape")
    cursor = target
    while cursor != root:
        if cursor.is_symlink():
            raise ValueError("Symbolic link in extraction path")
        cursor = cursor.parent
    return pathlib.Path(filesystem_path(checked))


def extract(filename, destination, max_bytes):
    root = pathlib.Path(filesystem_path(destination))
    if root.is_symlink() or not root.is_dir() or any(root.iterdir()):
        raise ValueError("Extraction requires a new empty private directory")
    with zipfile.ZipFile(filesystem_path(filename)) as archive:
        members, total = checked_members(archive, max_bytes)
        for member in members:
            target = safe_destination(destination, member.filename)
            if is_directory(member):
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            copied = 0
            with archive.open(member) as source, open(target, "xb") as output:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    copied += len(chunk)
                    if copied > member.file_size:
                        raise ValueError("Inflation exceeded declared member size")
                    output.write(chunk)
            if copied != member.file_size:
                raise ValueError("Truncated archive member")
            os.chmod(target, 0o700 if member.external_attr >> 16 & 0o111 else 0o600)
    return {"files": len(members), "bytes": total}


def read_small(archive, names, name):
    member = names.get(name)
    if member is None or is_directory(member) or not 0 < member.file_size <= 4 * 1024 * 1024:
        raise ValueError("Missing, empty or oversized metadata: " + name)
    return archive.read(member)


def read_ini(data):
    result = {}
    for line in data.decode("utf-8").splitlines():
        if not line.strip():
            continue
        key, value = line.strip().split("=", 1)
        if key in result:
            raise ValueError("Duplicate metadata key")
        result[key] = value
    return result


def verify(filename, spec_file, shell_only=False):
    with open(filesystem_path(spec_file), encoding="utf-8") as source:
        spec = json.load(source)
    with zipfile.ZipFile(filesystem_path(filename)) as archive:
        members, total = checked_members(archive, MAX_BYTES)
        names = {member.filename: member for member in members}
        base = "Payload/DmIOS.app/"
        apps = {name.split("/")[1] for name in names if name.startswith("Payload/") and len(name.split("/")) > 2}
        if apps != {"DmIOS.app"}:
            raise ValueError("IPA must contain exactly the pinned app")
        info = plistlib.loads(read_small(archive, names, base + "Info.plist"))
        if (info.get("CFBundleExecutable") != "DmIOS" or info.get("CFBundleIdentifier") != "org.d2rmobile.app"
                or info.get("MinimumOSVersion") != spec["minimumOS"]):
            raise ValueError("IPA executable, bundle identifier or minimum OS differs from shell")
        executable = names.get(base + "DmIOS")
        if executable is None or executable.file_size < 32:
            raise ValueError("IPA executable is missing or truncated")
        with archive.open(executable) as source:
            if source.read(4) not in (b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"):
                raise ValueError("IPA executable is not Mach-O")
        shell_info = read_ini(read_small(archive, names, base + "dm/shell_info.txt"))
        for key, expected in spec["shellInfo"].items():
            if shell_info.get(key) != expected:
                raise ValueError("Shell metadata mismatch: " + key)
        manifest = read_small(archive, names, base + "dm/shell_manifest.txt").decode("utf-8").splitlines()
        manifest = [name.strip() for name in manifest if name.strip()]
        if manifest != spec["shellManifest"]:
            raise ValueError("Shell manifest differs from pinned release")
        if not shell_only:
            pack_info = read_ini(read_small(archive, names, base + "dm/pack_info.txt"))
            if pack_info.get("PRODUCT") != spec["shellInfo"]["PRODUCT"]:
                raise ValueError("Pack product differs from pinned shell")
            for name in manifest + ["Frameworks/Guest.framework/Guest"]:
                full = base + name
                if name.endswith("/"):
                    present = any(key.startswith(full) and not is_directory(value) and value.file_size > 0 for key, value in names.items())
                else:
                    present = full in names and not is_directory(names[full]) and names[full].file_size > 0
                if not present:
                    raise ValueError("Required generated member missing or empty: " + name)
            guest = names[base + "Frameworks/Guest.framework/Guest"]
            with archive.open(guest) as source:
                if source.read(4) != b"\xcf\xfa\xed\xfe":
                    raise ValueError("Guest framework executable is not arm64 Mach-O")
        for member in members:
            if is_directory(member):
                continue
            read_bytes = 0
            with archive.open(member) as source:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    read_bytes += len(chunk)
                    if read_bytes > member.file_size:
                        raise ValueError("Output member inflated beyond budget")
            if read_bytes != member.file_size:
                raise ValueError("Output member is truncated")
    return {"files": len(members), "bytes": total, "crcVerified": True, "shellMetadataVerified": True, "packProductVerified": not shell_only}


def main():
    operation = sys.argv[1]
    if operation == "extract":
        result = extract(sys.argv[2], sys.argv[3], int(sys.argv[4]))
    elif operation in ("verify", "verify-shell"):
        result = verify(sys.argv[2], sys.argv[3], operation == "verify-shell")
    else:
        raise ValueError("Unknown archive protocol operation")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
