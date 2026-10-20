"""Read selected context from a user-chosen ZIP; never extract member paths."""
import codecs
from contextlib import ExitStack
import json
import re
import stat
import struct
import sys
import tempfile
import zipfile

DEFAULT_LIMITS = {
    "maxFileBytes": 256 * 1024 * 1024,
    "maxTotalBytes": 512 * 1024 * 1024,
    "maxEntries": 100000,
    "maxCentralDirectoryBytes": 64 * 1024 * 1024,
    "maxCompressionRatio": 200,
    "ratioCheckMinBytes": 1024 * 1024,
    "maxNestedZipBytes": 512 * 1024 * 1024,
}
JSON_STEMS = {
    "projects", "project", "memory", "memories", "saved_memory", "saved_memories",
    "user_model_memory", "user_model_memories", "model_memory", "model_memories",
    "instructions", "custom_instructions", "user_instructions", "user_custom_instructions",
    "project_instructions", "system_instructions",
}
TEXT_STEMS = JSON_STEMS - {"projects", "project"}
CONVERSATIONS = re.compile(r"^(?:chat_)?conversations?(?:(?:[_ .-](?:part[_ .-]?)?)?\d+)?$")
CONVERSATION_BUNDLES = re.compile(r"^(?:conversations?__[a-z0-9_-]+-chatgpt-\d+|(?:chat_)?conversations?(?:(?:[_ .-](?:part[_ .-]?)?)?\d+)?)$")
PROFILE_STEMS = {"user", "users", "account", "accounts", "profile", "profiles", "user_profile", "user_data"}
TEXT_EXTENSIONS = {"json", "txt", "md", "html", "htm", "csv", "yaml", "yml", "xml"}
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
ARTIFACT_TEXT_EXTENSIONS = {"json", "txt", "md", "html", "htm", "js", "mjs", "cjs", "css", "svg", "ts", "tsx", "jsx"}


class ExportError(Exception):
    pass


def emit_header(value):
    sys.stdout.buffer.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("ascii") + b"\n")


def artifact_scope(name):
    parts = name.replace("\\", "/").lower().split("/")
    for index, part in enumerate(parts[:-2]):
        if part in {"artifacts", "frames"} and UUID.fullmatch(parts[index + 1]):
            return "/".join(parts[:index + 2])
    return None


def entry_kind(name, artifact_scopes=None):
    parts = name.replace("\\", "/").lower().split("/")
    leaf = parts[-1]
    stem, dot, extension = leaf.rpartition(".")
    if not dot:
        return "other"
    normalized = re.sub(r"[ -]+", "_", stem)
    # Sites deployment/account metadata is not a Claude project export.
    if "sites" in parts[:-1]:
        return "other" if extension in TEXT_EXTENSIONS else "binary"
    if normalized in PROFILE_STEMS:
        return "profile"
    if extension == "zip" and CONVERSATION_BUNDLES.fullmatch(stem):
        return "bundle"
    directory_shard = re.fullmatch(r"(?:part[_ .-]?)?\d+", stem) and any(re.fullmatch(r"(?:chat_)?conversations?", part) for part in parts[:-1])
    project_shard = UUID.fullmatch(stem) and "projects" in parts[:-1]
    if extension == "json" and (CONVERSATIONS.fullmatch(stem) or normalized in JSON_STEMS or directory_shard or project_shard):
        return "context"
    if extension in {"txt", "md"} and normalized in TEXT_STEMS:
        return "context"
    # Google Takeout: <Takeout>/<My Activity>/<Gemini Apps>/MyActivity.(html|json), folder names localized.
    if extension in {"json", "html", "htm"} and re.search(r"a[ck]tivit", stem) and any(re.search(r"gemini|bard", part) for part in parts[:-1]):
        return "context"
    # xAI data export: prod-grok-backend.json holds the Grok conversations.
    if extension == "json" and "grok" in stem:
        return "context"
    # Claude's frames ZIP uses artifacts/<uuid>/artifact.json plus source files.
    # Require that metadata marker before recognizing arbitrary HTML or code.
    # These bytes remain untrusted source text; the reader never executes them.
    if extension in ARTIFACT_TEXT_EXTENSIONS and artifact_scope(name) in (artifact_scopes or set()):
        return "context"
    return "other" if extension in TEXT_EXTENSIONS else "binary"


def check_selected_path(info):
    name = info.orig_filename.replace("\\", "/")
    if len(name) > 4096 or "\0" in name or any(ord(char) < 32 for char in name):
        raise ExportError("A selected context entry has an unsafe archive name.")
    if name.startswith("/") or re.match(r"^[A-Za-z]:", name) or any(part in {".", ".."} for part in name.split("/")):
        raise ExportError("A selected context entry contains an unsafe absolute or traversal path.")
    if ":" in name:
        raise ExportError("A selected context entry contains an unsafe archive path.")
    if stat.S_ISLNK(info.external_attr >> 16):
        raise ExportError("A selected context entry is a symbolic link; linked files are not imported.")
    if info.flag_bits & 1:
        raise ExportError("The ZIP contains an encrypted context file. Export an unencrypted copy first.")
    if info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
        raise ExportError("A selected context file uses an unsupported ZIP compression method.")
    return name


def preflight_directory(file, limits):
    """Bound central-directory allocation before zipfile constructs ZipInfo objects."""
    file.seek(0, 2)
    length = file.tell()
    if length < 22:
        raise ExportError("The selected ZIP is incomplete or damaged.")
    tail_size = min(length, 65535 + 22)
    file.seek(length - tail_size)
    tail = file.read(tail_size)
    position = len(tail)
    while True:
        position = tail.rfind(b"PK\x05\x06", 0, position)
        if position < 0:
            raise ExportError("The selected file is not a supported ZIP export.")
        if position + 22 <= len(tail):
            fields = struct.unpack_from("<4s4H2LH", tail, position)
            if position + 22 + fields[-1] == len(tail):
                break
    _, disk, directory_disk, disk_count, count, directory_size, directory_offset, _ = fields
    end_offset = length - tail_size + position
    if disk != 0 or directory_disk != 0 or disk_count != count:
        raise ExportError("Split or multi-volume ZIP exports are not supported.")
    if count == 65535 or directory_size == 0xFFFFFFFF or directory_offset == 0xFFFFFFFF:
        if end_offset < 20:
            raise ExportError("The ZIP64 directory is invalid.")
        file.seek(end_offset - 20)
        locator = file.read(20)
        signature, locator_disk, record_offset, disk_total = struct.unpack("<4sLQL", locator)
        if signature != b"PK\x06\x07" or locator_disk != 0 or disk_total != 1 or record_offset + 56 > end_offset:
            raise ExportError("The ZIP64 directory is invalid or split across files.")
        file.seek(record_offset)
        record = file.read(56)
        if len(record) != 56:
            raise ExportError("The ZIP64 directory is incomplete.")
        signature, record_size, _, _, disk, directory_disk, disk_count, count, directory_size, directory_offset = struct.unpack("<4sQ2H2L4Q", record)
        if signature != b"PK\x06\x06" or record_size < 44 or disk != 0 or directory_disk != 0 or disk_count != count:
            raise ExportError("The ZIP64 directory is invalid or split across files.")
    if count > limits["maxEntries"]:
        raise ExportError("The ZIP contains too many entries to import safely.")
    if directory_size > limits["maxCentralDirectoryBytes"] or directory_offset + directory_size > length:
        raise ExportError("The ZIP directory is too large or inconsistent to import safely.")
    file.seek(0)
    return count, directory_size


def read_export(file_path, limits):
    # Open only named conversation bundles in the new OpenAI wrapper export.
    # A bounded temporary transport file makes a compressed inner ZIP seekable;
    # no member paths, attachments, financial or authentication files are extracted.
    with ExitStack() as stack:
        selected = []
        names = set()
        totals = {"text": 0, "nested": 0, "entries": 0, "directory": 0}
        skipped = {"binary": 0, "profile": 0, "other": 0}
        bundle_count = 0

        def collect(file, prefix="", depth=0):
            nonlocal bundle_count
            count, directory_bytes = preflight_directory(file, limits)
            totals["entries"] += count
            totals["directory"] += directory_bytes
            if totals["entries"] > limits["maxEntries"]:
                raise ExportError("Combined ZIPs contain too many entries to import safely.")
            if totals["directory"] > limits["maxCentralDirectoryBytes"]:
                raise ExportError("Combined ZIP directories are too large to import safely.")
            archive = stack.enter_context(zipfile.ZipFile(file))
            entries = archive.infolist()
            if len(entries) > limits["maxEntries"]:
                raise ExportError("The ZIP contains too many entries to import safely.")
            artifact_scopes = set()
            for info in entries:
                scope = artifact_scope(info.filename)
                normalized_name = info.filename.replace("\\", "/").lower()
                if scope and normalized_name in {scope + "/artifact.json", scope + "/frame.json"}:
                    artifact_scopes.add(scope)
            for info in entries:
                if info.is_dir():
                    continue
                kind = entry_kind(info.filename, artifact_scopes)
                if kind not in {"context", "bundle"}:
                    skipped[kind] += 1
                    continue
                member_name = check_selected_path(info)
                name = prefix + member_name
                if len(name) > 4096:
                    raise ExportError("A selected context entry has an unsafe archive name.")
                if name.casefold() in names:
                    raise ExportError("The ZIP contains duplicate context filenames and cannot be imported unambiguously.")
                names.add(name.casefold())
                if kind == "bundle":
                    if depth >= 1:
                        raise ExportError("Conversation ZIPs nested more than one level are not supported. Choose the inner conversation ZIP directly.")
                    if info.file_size > limits["maxNestedZipBytes"] or totals["nested"] + info.file_size > limits["maxNestedZipBytes"]:
                        raise ExportError("Nested conversation ZIPs exceed the permitted size limit.")
                    if info.file_size >= limits["ratioCheckMinBytes"] and (info.compress_size == 0 or info.file_size > info.compress_size * limits["maxCompressionRatio"]):
                        raise ExportError("A nested conversation ZIP has a suspicious compression ratio.")
                    transport = stack.enter_context(tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024))
                    nested_bytes = 0
                    with archive.open(info, "r") as entry:
                        while True:
                            chunk = entry.read(65536)
                            if not chunk:
                                break
                            nested_bytes += len(chunk)
                            totals["nested"] += len(chunk)
                            if nested_bytes > info.file_size or totals["nested"] > limits["maxNestedZipBytes"]:
                                raise ExportError("Nested conversation ZIPs exceed the permitted size limit.")
                            transport.write(chunk)
                    if nested_bytes != info.file_size:
                        raise ExportError("A nested conversation ZIP has inconsistent size metadata.")
                    bundle_count += 1
                    collect(transport, name + "!/", depth + 1)
                    continue
                if info.file_size > limits["maxFileBytes"]:
                    raise ExportError("A context file exceeds the 256 MiB per-file import limit.")
                totals["text"] += info.file_size
                if totals["text"] > limits["maxTotalBytes"]:
                    raise ExportError("Combined context files exceed the 512 MiB import limit.")
                if info.file_size >= limits["ratioCheckMinBytes"] and (info.compress_size == 0 or info.file_size > info.compress_size * limits["maxCompressionRatio"]):
                    raise ExportError("A context file has a suspicious compression ratio. Import its uncompressed JSON or text file instead.")
                selected.append((archive, info, name))

        collect(stack.enter_context(open(file_path, "rb")))
        if not selected:
            raise ExportError("No supported conversation, memory, project, or instruction files were found in this ZIP. Choose the export you downloaded from ChatGPT, Claude, Gemini (Google Takeout) or Grok.")
        # Validate metadata for ALL selected entries before returning any text.
        read_total = 0
        for archive, info, name in selected:
            emit_header({"type": "file", "source": name, "bytes": info.file_size})
            decoder = codecs.getincrementaldecoder("utf-8")("strict")
            count = 0
            with archive.open(info, "r") as entry:
                while True:
                    chunk = entry.read(65536)
                    if not chunk:
                        break
                    count += len(chunk)
                    read_total += len(chunk)
                    if count > limits["maxFileBytes"] or count > info.file_size or read_total > limits["maxTotalBytes"]:
                        raise ExportError("Decompressed export text exceeds the permitted size limit.")
                    decoder.decode(chunk, final=False)
                    sys.stdout.buffer.write(chunk)
            decoder.decode(b"", final=True)
            if count != info.file_size:
                raise ExportError("A context file has inconsistent ZIP size metadata.")
            sys.stdout.buffer.write(b"\n")
        warnings = []
        if bundle_count:
            warnings.append(f"Opened {bundle_count} nested conversation ZIP(s) from the OpenAI export. Only supported context files were read.")
        if skipped["binary"]:
            warnings.append(f"Skipped {skipped['binary']} binary attachment or non-text file(s); attachment contents were not imported.")
        if skipped["profile"]:
            warnings.append(f"Skipped {skipped['profile']} account/profile file(s); account details were not imported as context.")
        if skipped["other"]:
            warnings.append(f"Skipped {skipped['other']} unrecognized text or metadata file(s).")
        emit_header({"type": "done", "bytes": read_total, "inputCount": len(selected), "warnings": warnings})
        sys.stdout.buffer.flush()


def main():
    try:
        if len(sys.argv) != 3:
            raise ExportError("The export reader was called with invalid arguments.")
        requested = json.loads(sys.argv[2])
        if not isinstance(requested, dict):
            raise ExportError("The export reader limits are invalid.")
        limits = {}
        for key, maximum in DEFAULT_LIMITS.items():
            value = requested.get(key, maximum)
            if type(value) is not int or value < 1 or value > maximum:
                raise ExportError("The export reader limits are invalid.")
            limits[key] = value
        read_export(sys.argv[1], limits)
        return 0
    except ExportError as error:
        message = str(error)
    except UnicodeDecodeError:
        message = "A selected context file is not valid UTF-8 text."
    except (zipfile.BadZipFile, zipfile.LargeZipFile, EOFError, struct.error):
        message = "The ZIP is damaged or has inconsistent archive metadata."
    except (OSError, RuntimeError, NotImplementedError):
        message = "The ZIP export could not be read safely."
    except Exception:
        message = "The export reader could not process this ZIP safely."
    # Fixed messages only: do not leak file contents, member names or tracebacks.
    sys.stderr.write("EXPORT_ERROR: " + message + "\n")
    return 1


if __name__ == "__main__":
    sys.exit(main())
