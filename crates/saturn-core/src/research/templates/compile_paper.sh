#!/bin/sh
# Compile a LaTeX draft into a Saturn run's output, recording whether it compiled and how many warnings it gave.
#
# How to use: put the paper's files in the experiment's inputs.code (figures and tables in inputs.data), then
#     sh compile_paper.sh paper/main.tex              # tectonic or latexmk, whichever is on PATH
#     sh compile_paper.sh paper/main.tex latexmk      # or a compiler by name or absolute path
# The PDF and the compiler's output (compile.log) go to SATURN_RUN_OUTPUT; the run's sample "paper" says in its
# scores whether it compiled and how many lines of the compiler's output mention a warning. With no compiler the
# sample carries an infrastructure error. Exits nonzero when nothing compiled. Outside Saturn it writes to ./saturn-run.
# What to change: the compiler flags in the case below, for a draft that needs shell escape or a bibliography pass.
set -u

TEX=${1:-paper/main.tex}
COMPILER=${2:-}
OUTPUT=${SATURN_RUN_OUTPUT:-saturn-run/written}
SAMPLES=${SATURN_RUN_SAMPLES:-saturn-run/samples.jsonl}
ARTIFACTS=${SATURN_RUN_ARTIFACTS:-saturn-run/artifacts.jsonl}
LOG="$OUTPUT/compile.log"
PDF="$OUTPUT/$(basename "${TEX%.tex}").pdf"
mkdir -p "$OUTPUT" "$(dirname "$SAMPLES")" "$(dirname "$ARTIFACTS")"

# A string as a JSON literal, quotes and all; python3 does the escaping.
json_string() {
    python3 -c 'import json, sys; print(json.dumps(sys.argv[1]))' "$1"
}

# The run's one sample line: compiled (true/false), the warning count, and an error literal (null or an object).
write_sample() {
    printf '{"schemaVersion":1,"sampleId":"paper","trial":0,"input":%s,"output":%s,"scores":{"compiled":%s,"warnings":%s},"error":%s}\n' \
        "$(json_string "$TEX")" "$(json_string "$PDF")" "$1" "$2" "$3" >> "$SAMPLES"
}

# Lines of the compiler's output that mention a warning, 0 when there is no log yet.
count_warnings() {
    COUNT=$(grep -ci warning "$LOG" 2>/dev/null)
    printf '%s' "${COUNT:-0}"
}

# Pick the compiler: the argument, else tectonic, else latexmk.
if [ -z "$COMPILER" ]; then
    if command -v tectonic >/dev/null 2>&1; then
        COMPILER=tectonic
    elif command -v latexmk >/dev/null 2>&1; then
        COMPILER=latexmk
    fi
fi
if [ -z "$COMPILER" ] || ! command -v "$COMPILER" >/dev/null 2>&1; then
    MESSAGE="no LaTeX compiler found: install tectonic or TeX Live (latexmk), or give one by absolute path as the second argument"
    write_sample false 0 "{\"kind\":\"infrastructure\",\"message\":$(json_string "$MESSAGE")}"
    printf '%s\n' "$MESSAGE" >&2
    exit 2
fi
if [ ! -f "$TEX" ]; then
    MESSAGE="no such file: $TEX"
    write_sample false 0 "{\"kind\":\"infrastructure\",\"message\":$(json_string "$MESSAGE")}"
    printf '%s\n' "$MESSAGE" >&2
    exit 2
fi

# Compile into the output folder; a sandboxed run cannot write beside the sources.
# Change here: flags such as --shell-escape or -bibtex, when the draft needs them.
case "$(basename "$COMPILER")" in
    tectonic*)
        "$COMPILER" --outdir "$OUTPUT" --keep-logs "$TEX" > "$LOG" 2>&1
        STATUS=$?
        ;;
    latexmk*)
        "$COMPILER" -pdf -interaction=nonstopmode -halt-on-error -outdir="$OUTPUT" "$TEX" > "$LOG" 2>&1
        STATUS=$?
        ;;
    *)
        "$COMPILER" -interaction=nonstopmode -halt-on-error -output-directory="$OUTPUT" "$TEX" > "$LOG" 2>&1
        STATUS=$?
        ;;
esac

WARNINGS=$(count_warnings)
if [ "$STATUS" -eq 0 ] && [ -f "$PDF" ]; then
    write_sample true "$WARNINGS" null
    printf '{"kind":"document","path":"written/%s"}\n' "$(basename "$PDF")" >> "$ARTIFACTS"
    printf 'compiled %s with %s warning line(s); log in %s\n' "$PDF" "$WARNINGS" "$LOG"
    exit 0
fi
write_sample false "$WARNINGS" null
printf 'compilation of %s failed (%s exited %s); last lines of %s:\n' "$TEX" "$COMPILER" "$STATUS" "$LOG" >&2
tail -n 20 "$LOG" >&2
exit 1
