#!/usr/bin/env python3
"""Claude Code PreToolUse guard: deny host-destructive and secret-reading calls.

Wired by the dev-hooks plugin for Bash|Read|Edit|Write.

Policy:
- Allow normal development work without prompts.
- Deny secret access and host- or history-destructive operations.
- Ask only for irreversible operations (file deletion outside temp dirs,
  git clean, destructive SQL, volume or remote database resets), and when a
  substitution decides what a gated command runs or reads. Read programs skip
  that ask when the settings files prove the call runs sandboxed (`sandbox_signal`).

Contract (Claude Code hooks):
  - stdin: JSON describing the tool call (tool_name, tool_input, ...).
  - A matching rule prints a `hookSpecificOutput` decision (`deny` or `ask`)
    and exits 0; no match exits 0 silently, leaving the normal permission flow.
  - A hook decision never grants a permission that settings.json denies.

FAIL OPEN on hook errors: unreadable input or an internal error allows the call
so a guard bug never bricks the session. A matched rule always denies or asks.

This recognises literal command spellings; it is not a shell security boundary.
Keep the sandbox and settings.json permissions as the primary controls.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import sys
from pathlib import Path


def emit(decision: str, reason: str) -> None:
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": decision,
                    "permissionDecisionReason": reason,
                }
            }
        )
    )


def normalize_path(value: str) -> str:
    if not value:
        return ""
    return os.path.expanduser(value).replace("\\", "/")


PROTECTED_FRAGMENTS = (
    "/secrets/",
    "/.ssh/",
    "/.aws/",
    "/.config/gcloud/",
    "/.config/gh/hosts.yml",
    "/.netrc",
    "/id_rsa",
    "/id_ed25519",
)
PROTECTED_NAMES = {
    ".env.production",
    ".env.test",
    ".netrc",
    "id_rsa",
    "id_ed25519",
    "hosts.yml",
}


def path_is_protected(path: str) -> bool:
    """System credentials and production/test env files. Local dev `.env` stays readable."""
    p = "/" + normalize_path(path)  # leading slash so relative `secrets/x` matches `/secrets/`
    # A trailing slash lets a protected directory itself (`~/.aws`) match its `/.aws/` fragment.
    return Path(p).name in PROTECTED_NAMES or any(fragment in p + "/" for fragment in PROTECTED_FRAGMENTS)


def compact(command: str) -> str:
    return " ".join(command.strip().split())


# --- command normalisation ----------------------------------------------------
#
# The deny/ask patterns match words in the command string, so they only
# recognise the spellings they were written for:
#
# - `gh` accepts a flag between the binary and the subcommand and runs it the
#   same way: `gh --repo OWNER/REPO issue delete 1` == `gh issue delete 1`.
# - Matching the whole command string would refuse a heredoc or a quoted message
#   that merely writes *about* a gated verb, although it executes nothing.
#
# Every normalisation step is a deletion, never a reordering or re-quoting, so it
# can only make the matcher see less; it never fabricates a word sequence.

# gh flags that may legally precede the subcommand. Boolean forms take no value.
GH_LEADING_FLAGS = re.compile(
    r"\bgh(?:\s+(?:--repo|-R|--hostname)(?:=\S+|\s+\S+)|\s+(?:--help|-h|--version))+",
    flags=re.IGNORECASE,
)

# A heredoc opener: `<<TAG`, `<<'TAG'`, `<<"TAG"`, `<<-TAG`.
HEREDOC_START = re.compile(r"<<-?\s*(?P<quote>['\"]?)(?P<tag>[A-Za-z_][A-Za-z0-9_]*)(?P=quote)")

# Programs that execute what they are handed. If any appears at a command
# position, heredoc bodies stay in scope: `bash <<EOF ... EOF` runs its payload.
INTERPRETERS = {
    "ash", "bash", "csh", "dash", "env", "eval", "fish", "ksh", "node", "perl",
    "php", "python", "python3", "ruby", "sh", "source", "xargs", "zsh",
}

# A word in command position: start, or after a pipe/separator/substitution,
# optionally preceded by VAR=value assignments; quotes and backslashes around it do not hide it.
COMMAND_POSITION = re.compile(r"(?:^|[|;&\n(]|`)\s*(?:\w+=\S+\s+)*[\"'\\]*(?P<program>[\w./-]+)")

# The literal value of a message-carrying flag. Single quotes never expand; double
# quotes count only without `$`, backtick or backslash, so a payload that could
# execute something (`--body "$(cat ~/.ssh/id_rsa)"`) stays in place and is matched.
LITERAL_MESSAGE_PAYLOAD = re.compile(
    r"(?<![\w-])(?:-m|--message|-b|--body|-t|--title|--notes)(?:\s+|=)(?:'[^']*'|\"[^\"$`\\]*\")"
)


def mentions_interpreter(command: str) -> bool:
    return any(Path(match.group("program")).name in INTERPRETERS for match in COMMAND_POSITION.finditer(command))


# Programs that only store or forward what they read on stdin. A heredoc fed to
# anything else (psql, ssh, docker exec, ...) may be executed, so it stays in scope.
DATA_SINKS = {"cat", "tee", "gh", "git"}
EXPANDABLE = re.compile(r"[$`\\]")
PLAIN_ASSIGNMENT = re.compile(r"[A-Za-z_]\w*=[\w./:-]*")


def strip_heredoc_bodies(command: str) -> str:
    """Drop heredoc payloads that are verified literal data written by a data sink.

    A body stays in scope when anything in the command line could execute it, when
    its consumer is not a data sink, or when an unquoted delimiter lets the shell
    expand `$(...)`, backticks or variables inside it.
    """
    if "<<" not in command or mentions_interpreter(command):
        return command

    lines = command.split("\n")
    kept: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        kept.append(line)
        index += 1
        opener = HEREDOC_START.search(line)
        if not opener:
            continue
        tag = opener.group("tag")
        end = index
        while end < len(lines) and lines[end].strip() != tag:
            end += 1
        body = lines[index:end]
        # The body reaches every program of the opener's pipeline, so each stage, including a
        # substitution, must start with a data sink spelled literally. A quoted, escaped, expanded
        # or otherwise unrecognised program is not identified, so the body stays in scope.
        pipeline = [part for part in re.split(r"&&|\|\||;|(?<![|>])&(?!>)", line) if opener.group(0) in part][0]
        stages = [stage.split() for stage in re.split(r"[|(`]", pipeline) if stage.strip()]
        sink = all(next((word for word in words if not PLAIN_ASSIGNMENT.fullmatch(word)), "") in DATA_SINKS
                   for words in stages) and not line.rstrip().endswith(("|", "\\"))
        literal = bool(opener.group("quote")) or not EXPANDABLE.search("\n".join(body))
        if not (sink and literal):
            kept.extend(body)
        index = end
        if index < len(lines):
            kept.append(lines[index])
            index += 1
    return "\n".join(kept)


def drop_message(match: re.Match) -> str:
    # A setter's option value names variables (`unset -m 'D*'`, `declare -t 'D=x'`), not a message (I2).
    head = [word.strip("\"'\\") for word in re.split(r"[;&|\n(`]", match.string[:match.start()])[-1].split()]
    program = next((word for word in head if not (word in WRAPPERS or word.startswith("-")
                                                  or WRAPPER_VALUE.fullmatch(word))), "")
    return match.group() if program in NAME_SETTERS else " "


def normalize_command(command: str, keep_lines: bool = False) -> str:
    """Canonicalise a command for matching: inert payloads out, gh flag noise out."""
    text = strip_heredoc_bodies(command)
    text = LITERAL_MESSAGE_PAYLOAD.sub(drop_message, text)
    text = GH_LEADING_FLAGS.sub("gh", text)
    return text if keep_lines else compact(text)


# --- shell structure ----------------------------------------------------------
#
# The rules below read words as the shell splits and unquotes them, so `"--force"`,
# `git -C repo push` and `-T.env.production` are the same commands as their plain
# spellings. Unbalanced quoting cannot be read that way and asks instead.

SHELL_KEYWORDS = {"!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "time"}
# Programs that run the program named in their arguments.
WRAPPERS = {"env", "command", "builtin", "exec", "nohup", "nice", "timeout", "xargs", "stdbuf", "sudo", "doas"}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "ash"}
ASSIGNMENT = re.compile(r"^[A-Za-z_]\w*=")


def simple_commands(command: str) -> list[list[str]]:
    """The words of each simple command, unquoted; raises ValueError on unbalanced quoting."""
    # A substitution's command is a command too; splitting at it only adds commands.
    text = command.replace("`", " ; ").replace("$(", " ; ( ")
    lexer = shlex.shlex(text, posix=True, punctuation_chars=";&|()<>\n")
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    lexer.commenters = ""  # a `#` word is kept: reading more words only adds matches
    commands, words = [], []
    for token in lexer:
        if token and set(token) <= set(";&|()\n"):
            commands.append(words)
            words = []
        else:
            words.append(token)
    return [words for words in commands + [words] if words]


def invocations(command: str, names: set[str], depth: int = 0) -> list[list[str]]:
    """Arguments of every call to a program in `names`, also through wrappers, `sh -c` and `eval`."""
    found = []
    for words in simple_commands(command):
        index = 0
        while index < len(words) and (words[index] in SHELL_KEYWORDS or ASSIGNMENT.match(words[index])
                                      or set(words[index]) <= set("<>&")):
            index += 2 if set(words[index]) <= set("<>&") else 1
        words = words[index:]
        program = Path(words[0]).name if words else ""
        if program in names:
            found.append(words[1:])
        elif program in WRAPPERS:
            later = [i for i, word in enumerate(words) if Path(word).name in names]
            found.extend([words[later[0] + 1:]] if later else [])
        elif depth < 3 and program == "eval":
            found.extend(invocations(" ".join(words[1:]), names, depth + 1))
        elif depth < 3 and program in SHELLS:
            # `sh -c SCRIPT`, also with bundled options such as `bash -lc SCRIPT`.
            flag = next((i for i, word in enumerate(words[1:-1], 1) if re.fullmatch(r"-[a-z]*c[a-z]*", word)), None)
            found.extend(invocations(words[flag + 1], names, depth + 1) if flag else [])
    return found


# Git options before the subcommand that take a separate value.
GIT_VALUE_OPTIONS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"}
PUSH_VALUE_OPTIONS = {"--repo", "--receive-pack", "--exec", "--push-option", "-o"}
FORCE_OPTIONS = ("--force", "--force-with-lease", "--mirror")
DELETE_OPTIONS = ("--delete", "--prune")


def push_decision(command: str) -> tuple[str | None, str | None]:
    """Deny a force push or remote deletion in any spelling Git accepts; ask when config could imply one."""
    for args in invocations(command, {"git"}):
        index, configured = 0, False
        while index < len(args) and args[index].startswith("-"):
            name = args[index].split("=", 1)[0]
            configured |= name in ("-c", "--config-env")
            index += 2 if name in GIT_VALUE_OPTIONS and "=" not in args[index] else 1
        if args[index:index + 1] != ["push"]:
            continue
        force = delete = ended = False
        positional, rest = [], iter(args[index + 1:])
        for word in rest:
            if ended or not word.startswith("-") or word == "-":
                positional.append(word)
            elif word == "--":
                ended = True
            elif word.startswith("--"):
                name = word.split("=", 1)[0]
                if name.startswith("--no-"):
                    continue
                # Git accepts any unambiguous prefix of a long option.
                force |= any(option.startswith(name) for option in FORCE_OPTIONS) and len(name) > 3
                delete |= any(option.startswith(name) for option in DELETE_OPTIONS + ("--mirror",)) and len(name) > 3
                if name in PUSH_VALUE_OPTIONS and "=" not in word:
                    next(rest, None)
            else:
                for position, letter in enumerate(word[1:], 1):
                    if letter == "o":  # `-o` takes the rest of the word, or the next word, as its value
                        if position == len(word) - 1:
                            next(rest, None)
                        break
                    force |= letter == "f"
                    delete |= letter == "d"
        # The repository is positional only without `--repo`; no remote name starts with `+` or `:`.
        # A bare `:` is Git's matching refspec, which pushes existing branches and deletes none.
        force |= any(word.startswith("+") for word in positional)
        delete |= any(word.startswith(":") and word != ":" for word in positional)
        if force:
            return "deny", "Refusing force push."
        if delete:
            return "deny", "Refusing remote branch deletion (preserve published branch history)."
        if configured:
            return "ask", "A push with command-line Git configuration requires approval."
    return None, None


def temp_roots() -> list[str]:
    """/tmp, plus $TMPDIR only when it is set to an absolute path other than `/`."""
    tmpdir = os.path.normpath(os.environ.get("TMPDIR") or ".")
    return ["/tmp"] + ([tmpdir] if os.path.isabs(tmpdir) and tmpdir != "/" else [])


TMPDIR_PREFIX = re.compile(r"^\$(?:TMPDIR|\{TMPDIR\})/")


def rm_targets_only_temp(command: str) -> bool:
    """True when every `rm` removes only paths strictly inside /tmp or the hook's own $TMPDIR.

    Case is kept, and a command that may change TMPDIR for the shell leaves `$TMPDIR` unresolved.
    """
    roots = temp_roots()
    calls = invocations(command, {"rm"})
    words = [Path(word).name for words in simple_commands(command) for word in words]
    if not calls or words.count("rm") != len(calls):
        return False  # an `rm` this reading did not resolve, such as `find -exec rm`
    redefined = re.search(r"(?<![$\w{])(?:TMPDIR|IFS)(?!\w)", command) is not None  # IFS splits $TMPDIR
    for args in calls:
        targets = [arg for index, arg in enumerate(args) if not arg.startswith("-") or "--" in args[:index]]
        if not targets:
            return False
        for target in targets:
            prefix = TMPDIR_PREFIX.match(target)
            # An unquoted $TMPDIR holding whitespace or a glob character splits or expands into other paths.
            if prefix and (len(roots) < 2 or redefined or re.search(r"[\s*?\[]", roots[-1])):
                return False  # $TMPDIR is empty, unusable or not the hook's value
            path = (roots[-1] + "/" + target[prefix.end():] if prefix else target).rstrip("/")
            if ".." in target or "$" in path or "~" in target[:1] or \
                    not any(path.startswith(root + "/") for root in (roots[-1:] if prefix else roots)):
                return False
    return True


# A transfer or read operand may be attached to its option (`-T.env.production`,
# `--upload-file=x`), prefixed by `@` or `<`, or follow a `host:` part.
TRANSFER_PROGRAMS = {"curl", "wget", "scp", "rsync", "sftp"}
READ_PROGRAMS = {"cat", "less", "more", "head", "tail", "grep", "rg", "awk", "sed", "xxd", "od", "strings", "base64"}


def operand_forms(word: str) -> set[str]:
    forms = {word, word.split("=", 1)[-1], word.split(":", 1)[-1], word.rsplit("@", 1)[-1], word.lstrip("@<")}
    if word.startswith("-") and not word.startswith("--"):
        # Bundled short options (`-sT.env.production`) can attach the value after any letter.
        forms |= {form for start in range(2, len(word)) for form in (word[start:], word[start:].lstrip("@<"))}
    return {form for form in forms if form}


def protected_operand(command: str, programs: set[str]) -> bool:
    return any(path_is_protected(form) for args in invocations(command, programs) for word in args
               for form in operand_forms(word))


# The shell rules use the file tools' policy: a fragment matches from a path boundary
# (a directory fragment also as the directory itself), a name only as a whole path part.
SECRET_PATHS = r"(?<![\w.-])(?:" + "|".join(
    [re.escape(f.strip("/")) + (r"(?:/|(?![\w.-]))" if f.endswith("/") else "") for f in PROTECTED_FRAGMENTS]
    + [re.escape(name) + r"(?![\w.-])" for name in sorted(PROTECTED_NAMES)]
) + ")"

DENY_PATTERNS = [
    (r"\bsudo\b", "Refusing sudo from the agent."),
    (r"\bsu\s+", "Refusing su from the agent."),
    (r"\bdoas\b", "Refusing doas from the agent."),
    (r"\brm\s+-rf\s+(/|~|\$HOME)(\s|$)", "Refusing recursive deletion of root/home."),
    (r"\brm\s+-rf\s+/(?!tmp/)\S+", "Refusing recursive deletion of absolute filesystem paths."),
    (r"\bchmod\s+777\b", "Refusing chmod 777."),
    (r"\bchown\s+.*\s+(/|~|\$HOME)\b", "Refusing ownership change on broad paths."),
    (r"\bdd\s+.*\bof=/dev/", "Refusing raw disk write."),
    (r"\bmkfs(\.|\s|$)", "Refusing filesystem formatting command."),
    (r"\bshutdown\b|\breboot\b|\bhalt\b", "Refusing host power command."),
    (r"\bgit\s+filter-(branch|repo)\b", "Refusing history rewrite."),
    (
        r"\bgh\s+(issue|label|release|repo|secret|variable|webhook|ssh-key|gpg-key|cache|run)\s+delete\b",
        "Refusing permanent GitHub deletion.",
    ),
    (r"\bgh\s+extension\s+remove\b", "Refusing gh extension removal."),
    (r"\bdocker\s+run\b.*\s--privileged\b", "Refusing privileged Docker container."),
    (
        r"\b(cat|less|more|head|tail|grep|rg|awk|sed|xxd|od|strings|base64)\b.*(" + SECRET_PATHS + ")",
        "Refusing shell read of protected secrets.",
    ),
    (
        r"\b(curl|wget|scp|rsync)\b.*(" + SECRET_PATHS + r"|metadata\.google|169\.254\.169\.254)",
        "Refusing shell exfiltration/metadata access pattern.",
    ),
    # In either order: a heredoc piped into the client puts the statement first.
    (r"^(?=.*\b(psql|sqlite3|mysql)\b).*\b(drop\s+database|drop\s+schema)\b", "Refusing database/schema drop from the agent."),
]

ASK_PATTERNS = [
    (r"\brmdir\b", "Directory deletion requires approval."),
    (r"\bfind\b.*\s-delete\b", "find -delete requires approval."),
    (r"\bgit\s+clean\b", "git clean requires approval."),
    (r"\bsupabase\s+db\s+(push|reset)\b", "Remote/destructive Supabase database operation requires approval."),
    (r"^(?=.*\b(psql|sqlite3|mysql)\b).*\b(truncate|delete\s+from)\b", "Destructive SQL requires approval."),
    (r"\bdocker\s+compose\s+down\b.*\s-v\b", "Docker volume deletion requires approval."),
]


# Words whose command the structural rules must read; unreadable quoting around one asks.
STRUCTURAL_WORDS = re.compile(r"\b(?:push|rm|curl|wget|scp|rsync|sftp|cat|less|more|head|tail|grep|rg|awk|sed|xxd|od|strings|base64)\b")
# Shell text these rules cannot resolve: a command or process substitution, whose output becomes
# words or a program, and a variable or substitution in command position.
UNRESOLVED = re.compile(r"\$\(|`|[<>]\(|(?:^|[|;&\n(])\s*(?:\w+=\S*\s+)*[\"'\\]*\$")
# The same constructs inside quoted text, which a program may run as a script of its own.
RUNNABLE = re.compile(r"\$\(|`|[<>]\(|[|;&\n(]\s*(?:\w+=\S*\s+)*[\"'\\]*\$")
# The one closed literal form allowed through: `$(cat <<'TAG'` with its body already removed as data.
LITERAL_SUBSTITUTION = re.compile(r"\$\(cat <<-?\s*'(?P<tag>[A-Za-z_]\w*)'\n\s*(?P=tag)\n\s*\)")


# --- per-command reading ------------------------------------------------------
#
# The substitution rule reads one simple command at a time (#61). This reader keeps
# what the shlex reading above drops: single-quoted text and quoted heredoc bodies are
# data, the command inside each substitution is a command of its own, and a variable
# assigned a literal earlier in the same command resolves to that value. Text it cannot
# parse raises Unreadable, and the caller keeps the whole-command rule.


class Unreadable(ValueError):
    """Shell text the per-command reader does not parse."""


NAME = re.compile(r"[A-Za-z_]\w*")
# A value that stays one literal word. A leading $TMPDIR stays in the text, so that
# rm_targets_only_temp resolves it with the hook's own value, as it always has.
LITERAL_VALUE = re.compile(r"(?:\$TMPDIR|\$\{TMPDIR\})(?:/[^\s$`'\"*?\[\\#(){}<>]*)?|[^\s$`'\"*?\[\\#(){}<>]*")
# Names bash or zsh set on their own (`cd`, `read`, every command), or that refuse an assignment.
SHELL_VARIABLES = {"_", "pwd", "oldpwd", "reply", "random", "srandom", "seconds", "lineno", "histcmd", "optarg",
                   "optind", "mapfile", "match", "mbegin", "mend", "coproc", "pipestatus", "dirstack", "groups",
                   "funcname", "uid", "euid", "gid", "egid", "ppid", "status", "argv", "argc", "errno", "username",
                   "shlvl", "epochseconds", "epochrealtime"}
SHELL_PREFIXES = ("bash_", "zsh_", "try_block_", "comp_", "readline_")
SEPARATORS = ("&&", "||", ";;", "|&", ";", "&", "|")
REDIRECTION = re.compile(r"\d*(?:<<<|<<-|<<|<>|<&|>&|>>|>\||<|>)|&>>?")
KEYWORDS = SHELL_KEYWORDS | {"for", "select", "function"}
COMPOUND_OPEN, COMPOUND_CLOSE = {"if", "while", "until", "for", "select", "{"}, {"fi", "done", "}"}
STRUCTURAL_PROGRAMS = READ_PROGRAMS | TRANSFER_PROGRAMS | {"rm"}
SHELL_RUNNERS = SHELLS | {"eval", "source", "."}
# Builtins that can set a variable without naming it in the text; with one, nothing resolves.
RUNS_TEXT = {"eval", "source", ".", "trap"}
NAME_SETTERS = {"declare", "typeset", "local", "readonly", "export", "read", "mapfile", "readarray", "getopts",
                "unset", "let", "wait", "integer", "float", "vared", "zparseopts", "getln", "zstyle", "set",
                "strftime", "zstat", "sysread", "zselect", "zformat", "zregexparse", "pcre_match", "ztcp", "zsocket"}
# A wrapper's option value or duration (`nice -n 5`, `timeout 30s`), skipped to reach the program it runs.
WRAPPER_VALUE = re.compile(r"[\d.]+[smhd]?|[A-Za-z_]\w*=.*")
# Read programs that can also run text they are given (`awk` `system()`, `sed` `e`).
RUNS_GIVEN_TEXT = {"awk", "sed"}
# Heredoc consumers whose code has no backtick syntax, so a backtick in their body is Markdown text (AC1).
LANGUAGES = {"python", "python3"}
PYTHON_RUNNABLE = re.compile(RUNNABLE.pattern.replace("|`", "", 1))
SUBSTITUTION_REASON = "A substitution or variable decides what this command runs or reads; spell it out literally."


class Word:
    """One shell word: its unquoted text, with each substitution shown as `$(…)`."""

    def __init__(self, start: int):
        self.start = self.end = start
        self.parts: list[str] = []
        self.code: list[str] = []  # text outside quotes and expansions, where a variable can be named
        self.quoted: list[str] = []  # quoted or escaped text, which another program may still run
        self.names: list[str] = []  # what follows each `$`
        self.subst = self.expands = self.payload = False  # payload: read here as the commands it runs

    @property
    def text(self) -> str:
        return "".join(self.parts)

    def runnable(self) -> str:
        """Quoted text that holds a substitution or a variable in command position, or ''."""
        quoted = "".join(self.quoted)
        return quoted if not self.payload and RUNNABLE.search(quoted) else ""


class Command:
    """One simple command: its words, its redirection targets and its pipeline."""

    def __init__(self, reader: ShellReader, start: int, pipeline: list[Command]):
        self.reader, self.start, self.pipeline = reader, start, pipeline
        self.words: list[Word] = []
        self.targets: list[Word] = []
        self.body_subst = False  # an unquoted heredoc body it reads holds a substitution
        self.runnable: list[str] = []  # text it may run that this reading cannot see into
        self.written: list[str] = []  # heredoc bodies a data sink writes
        self.source = ""

    def program(self) -> Word | None:
        return next((w for w in self.words if w.text not in KEYWORDS and not ASSIGNMENT.match(w.text)), None)

    def runs(self) -> list[str]:
        """Base names of the program and, after a wrapper, of every later word."""
        program = self.program()
        if program is None:
            return []
        names = [Path(word.text).name for word in self.words[self.words.index(program):]]
        names[0] = names[0].lower()
        return names if names[0] in WRAPPERS else names[:1]

    def entry(self) -> int:
        """The index of the word naming the program it runs through its wrappers, past their options and values."""
        program, words = self.program(), self.words
        index = len(words) if program is None else words.index(program)
        while index < len(words) and Path(words[index].text).name.lower() in WRAPPERS:
            index += 1
            while index < len(words) and (words[index].text.startswith("-") or WRAPPER_VALUE.fullmatch(words[index].text)):
                index += 1
        return index

    def target(self) -> str:
        """The base name of that program; '' when there is none."""
        index = self.entry()
        return Path(self.words[index].text).name.lower() if index < len(self.words) else ""


class ShellReader:
    """The simple commands of a shell text, and the variables it assigns, names and uses."""

    def __init__(self, text: str, depth: int = 0):
        self.s = text
        self.commands: list[Command] = []
        self.uses: list[tuple[int, int, str]] = []  # (start, stop, name) of `$NAME` and `${NAME}`
        self.assigned: dict[str, list[tuple[str, int, bool]]] = {}  # name -> (raw value, end, eligible)
        self.mentions: dict[str, int] = {}  # bare names outside quotes, lowercased (zsh ties `path` to PATH)
        self.dynamic = False  # something may set a variable without naming it
        self.compound = self.quiet = 0
        self.pending: list[tuple[str, bool, bool, Command]] = []  # heredocs waiting for a newline
        self.read_list(0, None, len(text), depth)
        if self.pending:
            raise Unreadable("a heredoc has no body")

    def mention(self, text: str) -> None:
        for name in NAME.findall(text):
            self.mentions[name.lower()] = self.mentions.get(name.lower(), 0) + 1

    def use(self, name: str, start: int, stop: int) -> None:
        if not self.quiet:
            self.uses.append((start, stop, name))

    def read_list(self, i: int, close: str | None, end: int, depth: int) -> int:
        """Read commands from `i` up to `close` (`)` or a backtick) or `end`; return the index after them."""
        if depth > 30:
            raise Unreadable("nested too deep")
        s, cmd, pipeline, before = self.s, None, [], None
        while True:
            while i < end and (s[i] in " \t\r" or s.startswith("\\\n", i)):
                i += 2 if s[i] == "\\" else 1
            if i >= end or (close and s.startswith(close, i)):
                if close and i >= end:
                    raise Unreadable(f"unclosed {close}")
                self.finish(cmd, i, before, None, depth)
                return i + 1 if close else i
            char = s[i]
            separator = next((op for op in SEPARATORS if s.startswith(op, i)), None)
            redirection = None if s.startswith(("<(", ">("), i) else REDIRECTION.match(s, i)
            if char == "#":
                newline = s.find("\n", i, end)
                i = end if newline < 0 else newline
            elif char == "\n":
                joined = cmd is None and before in ("|", "|&", "&&", "||")  # the list goes on after the line
                if not joined:
                    self.finish(cmd, i, before, "\n", depth)
                    cmd, pipeline, before = None, [], "\n"
                i = self.read_bodies(i + 1, end, depth, joined)
            elif char == ")":
                raise Unreadable("unmatched )")
            elif char == "(":
                cmd = cmd or Command(self, i, pipeline)
                if s.startswith("((", i) and not cmd.words:
                    i = self.read_arithmetic(i + 2, end, close, depth)
                else:
                    i = self.read_list(i + 1, ")", end, depth + 1)
            elif redirection:
                cmd = cmd or Command(self, i, pipeline)
                i = redirection.end()
                while i < end and s[i] in " \t":
                    i += 1
                if i >= end or s[i] in "\n;&|()":
                    raise Unreadable("a redirection has no target")
                i, target = self.read_word(i, end, close, depth)
                cmd.targets.append(target)
                if redirection.group().endswith(("<<", "<<-")):
                    quoted = any(mark in s[target.start:target.end] for mark in "'\"\\")
                    self.pending.append((target.text, quoted, redirection.group().endswith("-"), cmd))
            elif separator:
                if separator == ";;":
                    raise Unreadable("case")
                self.finish(cmd, i, before, separator, depth)
                cmd, before = None, separator
                pipeline = pipeline if separator in ("|", "|&") else []
                i += len(separator)
            else:
                cmd = cmd or Command(self, i, pipeline)
                i, word = self.read_word(i, end, close, depth)
                cmd.words.append(word)

    def finish(self, cmd: Command | None, i: int, before: str | None, after: str | None, depth: int) -> None:
        """Record a finished simple command: its assignment, nesting and any payload it runs."""
        if cmd is None:
            return
        cmd.source = self.s[cmd.start:i]
        cmd.pipeline.append(cmd)
        self.commands.append(cmd)
        texts = [word.text for word in cmd.words]
        lead = next((n for n, text in enumerate(texts) if text not in KEYWORDS), len(texts))
        self.compound += sum(text in COMPOUND_OPEN for text in texts[:lead]) + texts[lead:].count("{") \
            - sum(text in COMPOUND_CLOSE for text in texts[:lead])
        if len(cmd.words) == 1 and not cmd.targets:
            word = cmd.words[0]
            name, equals, value = self.s[word.start:word.end].partition("=")
            if equals and NAME.fullmatch(name):
                # I2: a standalone assignment that always runs, in this shell, before what follows.
                eligible = depth == 0 and self.compound == 0 and before in (None, ";", "\n") \
                    and after in (None, ";", "\n", "&&", "||")
                self.assigned.setdefault(name, []).append((value, i, eligible))
        program = cmd.program()
        if program is None:
            return
        if program.text == "case":
            raise Unreadable("case")
        start, runs = cmd.words.index(program), cmd.runs()
        operands = cmd.words[start + 1:]
        if set(runs) & NAME_SETTERS or {"printf", "print"} & set(runs) and any(re.match(r"-\w*v", t) for t in texts):
            for word in operands:  # a name joined to option letters counts (`read -aD`); a quoted one already does
                for k in range(1, len(word.text)) if word.text.startswith("-") else ():
                    self.mention(word.text[k:])
            # A name from an expansion or a pattern (`set -A "$N"`, zsh's `typeset -m 'D*'`) may be any name.
            self.dynamic |= any(word.expands or re.search(r"[*?\[]", word.text) for word in operands)
        self.dynamic |= bool(set(runs) & RUNS_TEXT)
        # The payloads a shell runs here, also behind wrappers: `eval` and `trap` text and `sh -c` scripts. An
        # argument of another program (`env ssh host eval …`) is that program's text, not a local payload.
        entry, target = cmd.entry(), cmd.target()
        if target == "eval":
            payload = cmd.words[entry + 1:]
            self.read_payload(payload, " ".join(word.text for word in payload), depth)
        if target == "trap":
            action = next((word for word in cmd.words[entry + 1:] if word.text != "--"), None)
            if action is not None and not action.text.startswith("-"):
                self.read_payload([action], action.text, depth)
        flag = next((j for j in range(entry + 1, len(cmd.words) - 1)
                     if re.fullmatch(r"-[a-z]*c[a-z]*", cmd.words[j].text)), None) if target in SHELLS else None
        if flag is not None:
            self.read_payload([cmd.words[flag + 1]], cmd.words[flag + 1].text, depth)

    def read_payload(self, words: list[Word], text: str, depth: int) -> None:
        for word in words:
            word.payload = True
        child = ShellReader(text, depth + 1)
        self.commands.extend(child.commands)
        self.dynamic |= child.dynamic  # what the payload sets only ever blocks resolution here
        for name, count in child.mentions.items():
            self.mentions[name] = self.mentions.get(name, 0) + count

    def read_bodies(self, i: int, end: int, depth: int, joined: bool) -> int:
        """Read the heredoc bodies that start after a newline; return the index after the last one."""
        s = self.s
        while self.pending:
            delimiter, quoted, tabs, owner = self.pending.pop(0)
            start = i
            while True:
                if i >= end:
                    raise Unreadable("unterminated heredoc")
                newline = s.find("\n", i, end)
                stop = end if newline < 0 else newline
                if (s[i:stop].lstrip("\t") if tabs else s[i:stop]) == delimiter:
                    body_end, i = i, min(stop + 1, end)
                    break
                i = stop + 1
            targets = {c.target() for c in owner.pipeline}
            runs_shell = joined or bool(targets & SHELL_RUNNERS)  # `env sh`, but not `ssh host sh` or `$CLIENT`
            if runs_shell:  # a shell runs the body, so its commands are commands
                waiting, self.pending = self.pending, []
                self.quiet += quoted  # the outer shell does not expand a quoted body
                self.read_list(start, None, body_end, depth + 1)
                self.quiet -= quoted
                if self.pending:
                    raise Unreadable("a heredoc inside a heredoc body")
                self.pending = waiting
            if not quoted:  # the outer shell expands an unquoted body, inside its quotes too
                word, k = Word(start), start
                self.quiet += runs_shell  # the uses in a body a shell runs are already recorded
                while k < body_end:
                    if s[k] == "\\":
                        k += 2
                    elif s[k] in "$`":
                        k = self.read_expansion(k, body_end, None, depth, word)
                    else:
                        k += 1
                self.quiet -= runs_shell
                owner.body_subst |= word.subst and not runs_shell
            # Commands this reading cannot see: a substitution's output in a body a shell runs; a body fed to a
            # program that may run it (`ssh`, `psql`, `node`); shell syntax in a Python body, where a backtick is
            # Markdown (AC1); and what a data sink writes, should the text also run a script (`written`).
            body = s[start - 1:body_end]  # from its newline, so a first-line `$` is in command position
            if not quoted and runs_shell and word.subst:
                owner.runnable.append(body)
            elif not runs_shell and targets <= DATA_SINKS:
                owner.written.append(body)
            elif not runs_shell and (PYTHON_RUNNABLE if targets <= DATA_SINKS | LANGUAGES else RUNNABLE).search(body):
                owner.runnable.append(body)
        return i

    def read_word(self, i: int, end: int, close: str | None, depth: int) -> tuple[int, Word]:
        s, word = self.s, Word(i)
        while i < end:
            char = s[i]
            if char in " \t\r\n;&|()" or char == close:
                break
            if char in "<>":
                if not s.startswith("(", i + 1):
                    break
                i = self.read_list(i + 2, ")", end, depth + 1)
                word.parts.append(char + "(…)")
                word.subst = word.expands = True
            elif char == "\\":
                if not s.startswith("\n", i + 1):
                    word.parts.append(s[i + 1:i + 2])
                    word.code.append(s[i + 1:i + 2])
                    word.quoted.append(s[i + 1:i + 2])
                i += 2
            elif char == "'":
                stop = s.find("'", i + 1, end)
                if stop < 0:
                    raise Unreadable("unclosed '")
                word.parts.append(s[i + 1:stop])
                word.quoted.append(s[i + 1:stop])
                i = stop + 1
            elif char == '"':
                i = self.read_double(i + 1, end, close, depth, word)
            elif s.startswith("$'", i):
                stop = i + 2
                while stop < end and s[stop] != "'":
                    stop += 2 if s[stop] == "\\" else 1
                if stop >= end:
                    raise Unreadable("unclosed $'")
                word.parts.append(s[i + 2:stop])
                # A numeric escape may spell `$(` or a backtick (`\x24(`), so such text counts as holding one.
                word.quoted.append(s[i + 2:stop] + ("$(" if re.search(r"\\[0-7xuU]", s[i + 2:stop]) else ""))
                i = stop + 1
            elif char in "$`":
                i = self.read_expansion(i, end, close, depth, word)
            else:
                word.parts.append(char)
                word.code.append(char)
                i += 1
        word.end = i
        self.mention("".join(word.code) + " " + "".join(word.quoted))  # a builtin may name it quoted (`export 'D=x'`)
        return i, word

    def read_double(self, i: int, end: int, close: str | None, depth: int, word: Word) -> int:
        s = self.s
        while i < end:
            char = s[i]
            if char == '"':
                return i + 1
            if char == "\\" and s[i + 1:i + 2] in ("$", "`", '"', "\\", "\n"):
                word.parts.append(s[i + 1].replace("\n", ""))
                word.quoted.append(s[i + 1].replace("\n", ""))
                i += 2
            elif char == "`" and close == "`":
                raise Unreadable("a backtick inside quotes inside backticks")
            elif char in "$`":
                i = self.read_expansion(i, end, close, depth, word)
            else:
                word.parts.append(char)
                word.code.append(char)
                word.quoted.append(char)
                i += 1
        raise Unreadable('unclosed "')

    def read_expansion(self, i: int, end: int, close: str | None, depth: int, word: Word) -> int:
        """Read the `$…` or backtick expansion at `i` into `word`; return the index after it."""
        s = self.s
        if s[i] == "`":
            if close == "`":
                raise Unreadable("nested backticks")
            i = self.read_list(i + 1, "`", end, depth + 1)
            word.parts.append("$(…)")
            word.subst = word.expands = True
            return i
        if s.startswith("$((", i):
            word.parts.append("$((…))")
            word.expands = True
            return self.read_arithmetic(i + 3, end, close, depth)
        if s.startswith("$(", i):
            literal = LITERAL_SUBSTITUTION.match(s, i)
            if literal:  # the closed literal form, its body already removed as data
                word.parts.append(" ")
                return literal.end()
            i = self.read_list(i + 2, ")", end, depth + 1)
            word.parts.append("$(…)")
            word.subst = word.expands = True
            return i
        if s.startswith("${", i):
            return self.read_parameter(i, end, close, depth, word)
        name = NAME.match(s, i + 1)
        if name:
            self.use(name.group(), i, name.end())
        elif s[i + 1:i + 2] == '"':
            return i + 1  # `$"…"` is a quoted string
        elif not (s[i + 1:i + 2] and s[i + 1] in "@*#?$!-0123456789"):
            word.parts.append("$")  # a lone `$` is literal
            return i + 1
        stop = name.end() if name else i + 2
        word.names.append(s[i + 1:stop])
        word.parts.append(s[i:stop])
        word.expands = True
        return stop

    def read_parameter(self, i: int, end: int, close: str | None, depth: int, word: Word) -> int:
        """Read `${…}`: a plain `${NAME}` is a use; with an operator, NAME is also mentioned, as it may assign."""
        s, start = self.s, i
        i += 2
        while i < end:
            char = s[i]
            if char == "}":
                content = s[start + 2:i]
                lead = NAME.match(content)
                if lead and lead.end() == len(content):
                    self.use(content, start, i + 1)
                elif lead:
                    self.mention(lead.group())
                else:  # a flag or indirection first (zsh's `${(P)N::=x}`) may assign a name it computes
                    self.dynamic |= "=" in content
                word.names.append(lead.group() if lead else content[:1])
                word.parts.append(s[start:i + 1])
                word.expands = True
                return i + 1
            if char == "\\":
                i += 2
            elif char == "'":
                stop = s.find("'", i + 1, end)
                if stop < 0:
                    raise Unreadable("unclosed '")
                i = stop + 1
            elif char in "\"$`":
                inner = Word(i)
                i = self.read_double(i + 1, end, close, depth, inner) if char == '"' else \
                    self.read_expansion(i, end, close, depth, inner)
                word.subst |= inner.subst
            elif char == close:
                break
            else:
                i += 1
        raise Unreadable("unclosed ${")

    def read_arithmetic(self, i: int, end: int, close: str | None, depth: int) -> int:
        """Read an arithmetic body up to its `))`; an expansion in it may name a variable it assigns."""
        s, start, level = self.s, i, 0
        while i < end:
            char = s[i]
            if char in "$`":
                self.dynamic = True
                i = self.read_expansion(i, end, close, depth, Word(i))
                continue
            if char in "'\"\\" or char == close:
                break
            if char == "(":
                level += 1
            elif char == ")":
                if level == 0:
                    if not s.startswith("))", i):
                        break
                    self.mention(s[start:i])
                    return i + 2
                level -= 1
            i += 1
        raise Unreadable("unclosed ((")

    def resolved(self, strict: bool = True) -> str:
        """The text with variable uses replaced by assigned values.

        Strict (I2): only the one standalone literal assignment of a name that nothing else in the
        command mentions, earlier in the same top-level sequence, and only when nothing may set a
        variable unseen. Loose: the latest earlier standalone assignment, for deny checks only.
        """
        if strict and (self.dynamic or "ifs" in self.mentions):
            return self.s
        out, last = [], 0
        for start, stop, name in sorted(self.uses):
            earlier = [entry for entry in self.assigned.get(name, []) if entry[1] <= start]
            if start < last or not earlier:
                continue
            value, _, eligible = earlier[-1]
            if strict and not (eligible and name.lower() not in SHELL_VARIABLES | {"tmpdir"}
                               and not name.lower().startswith(SHELL_PREFIXES) and len(self.assigned[name]) == 1
                               and self.mentions.get(name.lower()) == 1 and LITERAL_VALUE.fullmatch(value)):
                continue
            out += [self.s[last:start], value]
            last = stop
        return "".join(out) + self.s[last:]


def read_shell(text: str) -> tuple[ShellReader | None, str, str]:
    """The per-command reading of `text` after strict resolution, and the strict and loose resolved texts.

    The reader is None when the text cannot be read; both texts are then `text` (I5).
    """
    try:
        first = ShellReader(text)
        strict, loose = first.resolved(), first.resolved(strict=False)
        return (first if strict == text else ShellReader(strict)), strict, loose
    except Exception:  # Unreadable, or a reader defect: never fail open through it (I5)
        return None, text, text


def structural_ask(reader: ShellReader, sandboxed: bool) -> bool:
    """I3 and I4: one simple command at a time, does a substitution decide what a gated command runs or reads?"""
    words = [word for cmd in reader.commands for word in cmd.words + cmd.targets]
    if any(word.subst for word in words) or any(cmd.body_subst for cmd in reader.commands):
        # A variable the text sets, while a substitution runs somewhere in it, may carry that
        # substitution's output (`F=$(…); cat "$F"`, `read f < <(…)`): it counts as one.
        for word in words:
            word.subst |= any(reader.dynamic or not NAME.fullmatch(name) or reader.mentions.get(name.lower())
                              for name in word.names)
    # A text with an interpreter in command position may run what a data sink wrote (the base's heredoc rule).
    runner = mentions_interpreter(reader.s)
    for cmd in reader.commands:
        # Text another program may run (`ssh host cat '"$(…)"'`, `watch`, `find -exec sh -c`, awk's `system()`,
        # a heredoc fed to `ssh`): this reading cannot see into it, so the command's gated words ask, signal or
        # not. A read program's own name is no gated word for its quoted operands (`grep '`x`'`).
        words = cmd.words + cmd.targets
        bodies = cmd.runnable + [body for body in cmd.written if runner and RUNNABLE.search(body)]
        own = cmd.target() if not bodies and cmd.target() in READ_PROGRAMS - RUNS_GIVEN_TEXT else ""
        if (bodies or any(word.runnable() for word in words)) and STRUCTURAL_WORDS.search(" ".join(
                bodies + [word.text for word in words if Path(word.text).name.lower() != own]).lower()):
            return True
        program = cmd.program()
        if program is None:
            continue
        if program.expands:
            # A variable or substitution in command position. The gated words of its pipeline count,
            # or of the whole text when the command also sets that variable or may set it unseen.
            owner = cmd.reader
            whole = owner is not reader or owner.dynamic or any(
                not NAME.fullmatch(name) or owner.mentions.get(name.lower()) for name in program.names)
            scope = reader.s if whole else " ".join(c.source for c in cmd.pipeline)
            found = set(STRUCTURAL_WORDS.findall(scope.lower()))
        elif cmd.body_subst or any(word.subst for word in cmd.words + cmd.targets):
            names = {Path(word.text).name for word in cmd.words[cmd.words.index(program):]}
            names.add(Path(program.text).name.lower())
            found = names & STRUCTURAL_PROGRAMS | ({"push"} if {"git", "push"} <= names else set())
        else:
            continue
        # I4: only a read program, reached through its wrappers, skips when its gated words are all read
        # programs; an unresolved program may be any, and `ssh host cat` or `find -exec cat` run another.
        if found and not (sandboxed and not program.expands and found <= READ_PROGRAMS
                          and cmd.target() in READ_PROGRAMS):
            return True
    return False


def bash_decision(command: str, sandboxed: bool = False) -> tuple[str | None, str | None]:
    """The verdict for one Bash command. `sandboxed` is the settings-evidence signal (I6): the call runs
    sandboxed with reads of the protected paths blocked, so read programs skip the substitution ask."""
    text = normalize_command(command, keep_lines=True)
    reader, resolved, loose = read_shell(text)
    texts = [text] if resolved == text else [text, resolved]
    lowered = [compact(t).lower() for t in texts]

    for pattern, reason in DENY_PATTERNS:
        if any(re.search(pattern, lc, flags=re.IGNORECASE) for lc in lowered):
            return "deny", reason
    try:  # a protected path that reaches a read or transfer program through any assigned variable
        if loose != text and protected_operand(loose, READ_PROGRAMS):
            return "deny", "Refusing shell read of protected secrets."
        if loose != text and protected_operand(loose, TRANSFER_PROGRAMS):
            return "deny", "Refusing shell exfiltration/metadata access pattern."
    except ValueError:
        pass  # the loose reading only ever adds denies

    structural = set().union(*(STRUCTURAL_WORDS.findall(lc) for lc in lowered))
    reads_only = sandboxed and structural <= READ_PROGRAMS
    try:
        decisions = [push_decision(t) for t in texts]
        decision = next((d for wanted in ("deny", "ask") for d in decisions if d[0] == wanted), None)
        if decision:
            return decision
        if any(protected_operand(t, READ_PROGRAMS) for t in texts):
            return "deny", "Refusing shell read of protected secrets."
        if any(protected_operand(t, TRANSFER_PROGRAMS) for t in texts):
            return "deny", "Refusing shell exfiltration/metadata access pattern."
        removes_outside_temp = "rm" in structural and not rm_targets_only_temp(resolved)
    except ValueError:
        if structural and not reads_only:
            return "ask", "This command's quoting cannot be read safely; split or simplify it."
        removes_outside_temp = False
    if reader is None:  # the per-command reader cannot parse it: the whole-command rule (I5)
        if structural and UNRESOLVED.search(LITERAL_SUBSTITUTION.sub(" ", text)):
            return "ask", SUBSTITUTION_REASON
    elif structural_ask(reader, sandboxed):
        return "ask", SUBSTITUTION_REASON
    if removes_outside_temp:
        return "ask", "File deletion outside /tmp or $TMPDIR requires approval."
    for pattern, reason in ASK_PATTERNS:
        if any(re.search(pattern, lc, flags=re.IGNORECASE) for lc in lowered):
            return "ask", reason

    return None, None


# --- settings evidence (I6) ---------------------------------------------------
#
# The hook input does not say whether a call runs sandboxed. The signal is on only when the settings
# files the hook can read prove it: the sandbox is on and must start, nothing exempts this call, and
# reads of every protected path in the home and project directories are blocked. Anything missing,
# unreadable or of an unexpected type turns it off.

MANAGED_DIRS = {"linux": "/etc/claude-code", "darwin": "/Library/Application Support/ClaudeCode"}
# The 11 protected names; joined to the home and project directories they give the 22 required paths.
REQUIRED_NAMES = sorted({fragment.strip("/") for fragment in PROTECTED_FRAGMENTS} | PROTECTED_NAMES)
SWITCHES = ("enabled", "failIfUnavailable", "enableWeakerNestedSandbox")
# Allow rules whose paths Claude Code adds to the sandbox's write paths, which can re-open a read.
EDIT_RULE = re.compile(r"(?:Edit|Write|MultiEdit|NotebookEdit)(?:\((?P<path>.*)\))?")


class NoEvidence(Exception):
    """The settings files do not prove that the call runs sandboxed."""


def require(condition: object) -> None:
    if not condition:
        raise NoEvidence


def strings(value: object) -> list[str]:
    require(isinstance(value, list) and all(isinstance(item, str) for item in value))
    return value


def read_settings(path: str) -> tuple[dict, dict]:
    """The `sandbox` and `permissions` objects of one settings file; empty when there is no file."""
    if not os.path.lexists(path):
        return {}, {}
    with open(path, encoding="utf-8") as handle:
        settings = json.load(handle)
    require(isinstance(settings, dict))
    sandbox, permissions = settings.get("sandbox", {}), settings.get("permissions", {})
    require(isinstance(sandbox, dict) and isinstance(permissions, dict) and all(
        isinstance(sandbox.get(key, {}), dict) for key in ("filesystem", "credentials")))
    return sandbox, permissions


def write_paths(permissions: dict) -> list[str]:
    """The paths of `additionalDirectories` and of Edit allow rules, as sandbox path entries."""
    paths = strings(permissions.get("additionalDirectories", []))
    for rule in strings(permissions.get("allow", [])):
        match = EDIT_RULE.fullmatch(rule)
        if match:  # `//path` is absolute; a bare rule or `/path` (relative to its settings file) gives off
            path = match.group("path") or ""
            require(path.startswith(("//", "~/")) or path == "~")
            paths.append(path[1:] if path.startswith("//") else path)
    return paths


def settings_files(env, platform: str, managed_dir: str | None) -> tuple[str, str, list[str]]:
    """The home and project directories, and the settings files from lowest to highest precedence."""
    home, project, config = env.get("HOME"), env.get("CLAUDE_PROJECT_DIR"), env.get("CLAUDE_CONFIG_DIR")
    require(platform in MANAGED_DIRS and all(isinstance(p, str) and os.path.isabs(p) for p in (home, project)))
    require(config is None or os.path.isabs(config))
    home, project = os.path.normpath(home), os.path.normpath(project)
    managed = managed_dir or MANAGED_DIRS[platform]
    drop_ins = os.path.join(managed, "managed-settings.d")
    names = sorted(os.listdir(drop_ins)) if os.path.lexists(drop_ins) else []
    require(not any(name.startswith(".") and name.endswith(".json") for name in names))  # read or skipped?
    return home, project, [
        os.path.join(config or os.path.join(home, ".claude"), "settings.json"),
        os.path.join(project, ".claude", "settings.json"),
        os.path.join(project, ".claude", "settings.local.json"),
        os.path.join(managed, "managed-settings.json"),
    ] + [os.path.join(drop_ins, name) for name in names if name.endswith(".json")]


def absolute(entry: str, home: str) -> str | None:
    """A sandbox path entry as a normalised absolute path; None for a glob or a relative entry."""
    if entry == "~" or entry.startswith("~/"):
        entry = home + entry[1:]
    if re.search(r"[*?\[{]", entry) or not entry.startswith("/"):
        return None
    return "/" + os.path.normpath(entry).lstrip("/")


def within(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip("/") + "/")


def call_programs(command: str) -> set[str]:
    """Every program the call may run, as written and by base name, case-folded."""
    programs = set()
    for cmd in ShellReader(normalize_command(command, keep_lines=True)).commands:
        program = cmd.program()
        if program is None:
            continue
        words = cmd.words[cmd.words.index(program):]
        words = words if Path(program.text).name.lower() in WRAPPERS else words[:1]
        require(not any(word.expands for word in words))
        programs |= {name.casefold() for word in words for name in (word.text, Path(word.text).name)}
    return programs


def sandbox_signal(tool_input: dict, env, platform: str, managed_dir: str | None = None) -> bool:
    """I6: True only when the settings files prove that this Bash call runs sandboxed with reads of the
    22 required paths blocked. Missing evidence, a doubt or any error gives False."""
    try:
        require(tool_input.get("dangerouslyDisableSandbox", False) is False)
        # A hosted session does not enforce the filesystem rules even with `failIfUnavailable`.
        require(not env.get("CLAUDE_CODE_REMOTE"))
        home, project, paths = settings_files(env, platform, managed_dir)
        switches, weakened, deny, allow, excluded = {}, False, [], [], []
        for path in paths:  # a later file overrides a switch; lists add up
            sandbox, permissions = read_settings(path)
            filesystem = sandbox.get("filesystem", {})
            found = {key: sandbox[key] for key in SWITCHES if key in sandbox}
            found.update({"filesystem.disabled": filesystem["disabled"]} if "disabled" in filesystem else {})
            require(all(isinstance(value, bool) for value in found.values()))
            # Claude Code ignores `filesystem.disabled` in repository files, so a later `false` there
            # cannot undo a `true`: a `true` of either weakening switch in any file gives off.
            weakened |= True in (found.get("enableWeakerNestedSandbox"), found.get("filesystem.disabled"))
            switches.update(found)
            deny += strings(filesystem.get("denyRead", []))
            # Write access re-opens a path as a read allow does.
            allow += strings(filesystem.get("allowRead", [])) + strings(filesystem.get("allowWrite", [])) \
                + write_paths(permissions)
            excluded += strings(sandbox.get("excludedCommands", []))
            files = sandbox.get("credentials", {}).get("files", [])
            require(isinstance(files, list) and all(isinstance(f, dict) and isinstance(f.get("path"), str)
                                                    for f in files))
            deny += [f["path"] for f in files if f.get("mode") == "deny"]  # a mask may let the real file through
        require(switches.get("enabled") is True and switches.get("failIfUnavailable") is True and not weakened)
        if excluded:
            programs = call_programs(tool_input.get("command") or "")
            for entry in excluded:
                lead = (entry.split() or [""])[0]
                require(lead and not re.search(r"[*?\[]", lead))
                require(not {lead.casefold(), Path(lead).name.casefold()} & programs)
        cover = [path for path in (absolute(entry, home) for entry in deny) if path]
        reopened = [absolute(entry, home) for entry in allow]
        require(None not in reopened)
        reopened = [path.casefold() for path in reopened]
        for path in (os.path.join(base, name) for base in (home, project) for name in REQUIRED_NAMES):
            folded = path.casefold()
            # Covered by a deny that no allow equal to, beneath, or between it and the path re-opens.
            require(any(within(path, root) and not any(
                within(other, folded) or within(folded, other) and within(other, root.casefold())
                for other in reopened) for root in cover))
        return True
    except Exception:
        return False


def main() -> int:
    payload = json.load(sys.stdin)
    tool = payload.get("tool_name", "")
    tool_input = payload.get("tool_input") or {}

    if tool in {"Read", "Edit", "Write"}:
        file_path = tool_input.get("file_path") or tool_input.get("path") or ""
        if path_is_protected(file_path):
            emit("deny", f"Protected path blocked: {file_path}")
            return 0

    if tool == "Bash":
        command = tool_input.get("command") or ""
        decision, reason = bash_decision(command)
        # The signal only ever relaxes an ask, so the settings files are read only for one.
        if decision == "ask" and sandbox_signal(tool_input, os.environ, sys.platform):
            decision, reason = bash_decision(command, sandboxed=True)
        if decision and reason:
            emit(decision, reason)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)  # fail open on hook errors (bad input, internal bug)
