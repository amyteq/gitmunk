"""Replay corpus for #61: hand-written, anonymised commands modelled on the measured prompt categories.

Data only. No test executes these strings; they are passed to `bash_decision`.
Each category list holds `(label, command)` pairs. The positive lists (A, B, C) should get
allow; the negative lists must keep asking or denying.
"""

# Category A: "A substitution or variable decides what this command runs or reads", with no other
# reason to ask. Two or more per construct, each shaped like the construct table's "Usually" example.
CATEGORY_A = [
    ("$( … ) next to an unrelated cat",
     'echo "PR: $(jq -r .url "$TMPDIR/run/pr.json")"; cat "$TMPDIR/run/notes.md"'),
    ("$( … ) next to an unrelated head",
     "printf 'Checked at %s\\n' \"$(date -u +%H:%M)\" && head -20 \"$TMPDIR/run/summary.md\""),
    ("$( … ) next to an unrelated grep",
     'echo "branch $(git branch --show-current)"; grep -c PASS "$TMPDIR/run/test.log"'),
    ("backtick in a grep pattern",
     "grep -n '`dev-hooks`' README.md docs/install.md"),
    ("backtick in a heredoc body read by python3",
     "python3 - <<'EOF' > \"$TMPDIR/run/body.md\"\n"
     "print(\"Run `make test` before you push.\")\n"
     "EOF\n"
     "cat \"$TMPDIR/run/body.md\""),
    ("backtick in a heredoc body next to node",
     "gh issue comment 1 -R example-org/example-repo --body-file - <<'EOF'\n"
     "The `guard_tool.py` check passed.\n"
     "EOF\n"
     "node scripts/report.mjs | tail -3"),
    ("( $var inside python3 -c",
     "S=$TMPDIR/run; cat $S/a.log; python3 -c \"import json; d=json.load(open('$S/b.json')); print(d['ok'])\""),
    ("( $var inside python3 -c with tail",
     "python3 -c \"print(open('$TMPDIR/run/report.txt').read()[:200])\" && tail -5 \"$TMPDIR/run/report.txt\""),
    ("$var in command position, literal",
     'T=./scripts; "$T/build.sh" && grep -c warning build.log'),
    ("$var in command position, under $TMPDIR",
     "S=$TMPDIR/run; $S/bin/run.sh --check; tail -5 $S/run.log"),
    ("<( … ) with head",
     "diff <(jq -S . a.json) <(jq -S . b.json) | head -20"),
    ("<( … ) with cat",
     'comm -13 <(sort old.txt) <(sort new.txt) > "$TMPDIR/run/added.txt"; cat "$TMPDIR/run/added.txt"'),
]

# Category B: "File deletion outside /tmp or $TMPDIR" for paths under a variable assigned literally
# from $TMPDIR or /tmp earlier in the same command.
CATEGORY_B = [
    ("rm under a $TMPDIR variable",
     "O=$TMPDIR/run; rm -rf $O/evidence/old && cp -r evidence $O/evidence/old"),
    ("rm under a /tmp variable",
     "S=/tmp/scratch-run; rm -f $S/a.json $S/b.json; ls $S"),
    ("rm under a ${TMPDIR} variable, quoted use",
     'W=${TMPDIR}/trees; rm -rf "$W/old" && mkdir -p "$W/new"'),
    ("rm under a variable holding $TMPDIR",
     'D=$TMPDIR; rm -rf "$D/cache"'),
]

# Category C: multi-line scripts whose quoting the shlex reading cannot split (an apostrophe in a
# comment or a heredoc body), and whose only structural words are read programs.
CATEGORY_C = [
    ("shell function with an apostrophe in a comment",
     "summarize() {\n"
     "  # don't print the whole log, only the failures and the tail\n"
     "  grep -n 'FAIL' \"$1\" | head -20\n"
     "  tail -n 5 \"$1\"\n"
     "}\n"
     "for log in \"$TMPDIR\"/run/*.log; do\n"
     "  summarize \"$log\"\n"
     "done"),
    ("python3 heredoc with an apostrophe, then reads",
     "python3 - \"$TMPDIR/run/results.json\" <<'EOF'\n"
     "import json, sys\n"
     "# it's fine when the list is empty\n"
     "rows = json.load(open(sys.argv[1]))\n"
     "print(len(rows))\n"
     "EOF\n"
     "grep -c '\"ok\": true' \"$TMPDIR/run/results.json\"\n"
     "cat \"$TMPDIR/run/summary.txt\""),
    ("longer script with two functions",
     "#!/usr/bin/env bash\n"
     "set -euo pipefail\n"
     "run=\"$TMPDIR/run\"\n"
     "\n"
     "# The checker log isn't stable, so only count lines.\n"
     "count() {\n"
     "  local file=\"$1\" pattern=\"$2\"\n"
     "  grep -c \"$pattern\" \"$file\" || true\n"
     "}\n"
     "\n"
     "show() {\n"
     "  # print the head and the tail, enough for a summary\n"
     "  head -n 10 \"$1\"\n"
     "  echo ...\n"
     "  tail -n 10 \"$1\"\n"
     "}\n"
     "\n"
     "for name in unit lint; do\n"
     "  echo \"== $name: $(count \"$run/$name.log\" FAIL) failures\"\n"
     "  show \"$run/$name.log\"\n"
     "done\n"
     "sed -n '1,5p' \"$run/notes.md\""),
]

# AC2.a: a protected path that appears in the command and reaches a read program through
# `$( … )`, a variable or `<( … )`. Denied with the signal off and on.
PROTECTED_INDIRECT = [
    ("variable, literal value", 'K=~/.aws/credentials; head "$K"'),
    ("variable, $HOME value", "F=$HOME/.ssh/id_ed25519; cat $F"),
    ("command substitution", 'cat "$(echo ~/.ssh/id_rsa)"'),
    ("process substitution", "diff <(cat ~/.config/gh/hosts.yml) hosts.txt"),
    ("backtick", "head `echo ~/.netrc`"),
]

# AC2.b: a read program whose operand comes from a substitution that hides the path.
# Asks with the signal off.
HIDDEN_READ = 'cat "$(printf %s "$P" | base64 -d)"'

# AC2.c: transfer programs with a substituted target or upload operand. Ask with the signal off and on.
SUBSTITUTED_TRANSFER = [
    ("curl upload from $( … )", 'curl -T "$(ls -t "$TMPDIR"/run/*.zip | head -1)" https://example.com/upload'),
    ("wget target from $( … )", 'wget -q "$(cat url.txt)"'),
    ("scp source from $( … )", 'scp "$(printf %s "$P" | base64 -d)" backup-host:copies/'),
    ("curl data from a backtick", "curl -d @`cat payload.path` https://example.com/api"),
]

# AC2.d: rm outside /tmp and $TMPDIR. Asks with the signal off and on.
RM_OUTSIDE_TEMP = [
    ("directly", "rm -rf build/out"),
    ("variable assigned a path outside temp", 'D=./build; rm -rf "$D/out"'),
    ("variable assigned from a substitution", 'D=$(mktemp -d); rm -rf "$D"'),
    ("TMPDIR changed in the same command", "TMPDIR=/srv/cache; O=$TMPDIR/run; rm -rf $O/old"),
    ("TMPDIR exported in the same command", 'export TMPDIR=/srv; rm -rf "$TMPDIR/cache"'),
]

# AC2.e: quoting the reader cannot split around push, rm or a transfer program.
# Asks with the signal off and on.
UNREADABLE_QUOTING = [
    ("push", "git push origin 'main"),
    ("rm", 'rm -rf "$TMPDIR/x'),
    ("transfer", "curl -T 'report.zip https://example.com/upload"),
    ("rm in a script with an apostrophe in a comment",
     "cleanup() {\n"
     "  # don't keep old runs\n"
     "  rm -rf \"$TMPDIR/run/old\"\n"
     "}\n"
     "cleanup"),
]

# #81: the plain-data shapes of candidates 1–9, by candidate number, each with a near miss that must keep asking.
NOTES_HEREDOC = "cd $TMPDIR/run && cat > notes.txt <<'EOF'\nIt's ready.\nEOF\nnode gen.mjs notes.txt"
PLAIN_DATA = {
    1: (["cat notes/avoid-rm-in-sessions.md", "grep -n 'rm -rf' notes.md", 'grep -n "^| RM-2" spec.md'],
        ["grep -n 'rm -rf' notes.md; rm -rf notes/old"]),
    2: (["grep -n -e 'git clean -fd' settings.json"], ["git clean -fd"]),
    3: (["sed -i 's/`old`/`new`/' notes.md", "echo 'Run `cat x` first' >> notes.md",
         "printf '%s\\n' 'See `cat x`.' >> notes.md"],
        ['sed -i "s/$(cat old.txt)/new/" notes.md', "sed -i 's/`old`/`new`/' -e e notes.md"]),
    4: (["awk '{split($1,a,\"-\"); print a[1]}' list.txt"],
        ["awk '{print $1}' \"$(cat list-path.txt)\"", "awk '{split($1,a,\"-\"); print a[1] > \"out.txt\"}' list.txt"]),
    5: ([NOTES_HEREDOC], [NOTES_HEREDOC + "\nrm -rf ~/build"]),
    6: (["S=$TMPDIR/run; $S/tool.sh $S/w abc1234 $S/out.md; head -5 $S/out.md"],
        ["S=$(cat dir.txt); $S/tool.sh $S/w abc1234 $S/out.md; head -5 $S/out.md"]),
    7: (['for f in a.jsonl b.jsonl; do echo "$f $(stat -c %y $f)"; grep -c x $f; done',
         'CHK="$(date -u)"; cat $S/a.md | sed "s/@@CHECKED@@/$CHK/" > $S/b.md'],
        ['F="$(cat target.txt)"; cat "$F"', "for REPLY in a.jsonl; do read < <(cat target.txt); grep -c x $REPLY; done"]),
    8: (["cd $TMPDIR/run && rm -f watch.state"],
        ["cd ~/project && rm -f watch.state", "cd $TMPDIR/run && rm -f {watch.state,/srv/example/data}",
         "cd $TMPDIR/run && rm -f =example-tool", "cd $TMPDIR/run && rm -rf .?/.?/data"]),
    9: (["rm $TMPDIR/run/old.sh"], ["rm $HOME/run/old.sh"]),
}
