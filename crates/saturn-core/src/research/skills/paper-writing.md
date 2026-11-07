---
name: paper-writing
description: Turn a study report into a paper draft whose every number and figure traces to a run, leaving the author's decisions to the person. Read when a study is to be written up for others.
---
# Paper writing

The draft is a project file, Markdown or LaTeX, for example `paper/draft.md` or `paper/main.tex`, built from the study report (`study-report`) and the records. It must survive a reader who checks it against `.saturn/research`.

## Claims first
1. List the claims, each in one sentence with its number, interval and n. Three is plenty.
2. For each, name the finding, the run ids, and the figure or table that shows it. A claim without a run is not in the paper.
3. Order the paper around them: the abstract and introduction state them, the results show them, the discussion bounds them.
Mark each claim confirmatory or exploratory, as the findings do. An exploratory claim is written as a lead, not as a result.

## Figures and tables
- Regenerate every figure from the analysis script with run ids as arguments, never from a saved image, and register it with `research_evidence`, `action: "artifact_register"`, `kind: "figure"`, `runId`. Put the artifact id in the figure's source or a comment beside it, so a figure in the draft points at a hash.
- Tables are written by a script from `what: "summary"` and `what: "paired"` into a file the draft includes. A table typed by hand is a table with typos.
- Axes, units, n and intervals as in `plots-and-analysis`, and error counts next to means.

## Numbers
Copy every number from a record at the moment of writing: `what: "summary"`, `what: "paired"`, the finding's text. Do not retype from memory or from the report, which may be a draft behind. Round to what the interval justifies, the same way everywhere. Before handing back, read each number in the draft against its record again; a script that pulls the numbers out of the draft and the records and compares them is worth its hour.

## Method
From the records: models with `weightsRevision` and lineage, data with hashes and datasheet (`data-provenance`), the scorer and its validation, seeds, environment and hardware from `what: "evidence"`. Write `reported` seeds and revisions as reported, and a `null` as not reported, never as the expected value.

## Limitations
Write them from the evidence, not from a template:
- Each run whose `inputs` verdict is `partial` or `unverified`, and what was uncontrolled.
- Each `reported` field that is `null`: what the program did not say about itself.
- Single seeds, a floating model, a scorer whose agreement with labels is unknown, a test split touched before the end.
- Counterexamples kept on the runs, by count and kind.
- What was not replicated: see `replication-review`.
A limitation known and left out is the one a reviewer finds.

## Related work
Only sources from a `literature-review` finding that the person confirmed, each opened in this session or in that review. No citation from memory, no filled-in venue or year, no URL that was not visited. A gap in the related work is written as a gap.

## Compiling
A LaTeX draft is compiled as a run, so the PDF is tied to the sources that made it. `research_template` with `name: "compile_paper"` is that run's command: it picks tectonic or latexmk, compiles into the run's output and writes the sample line and the artifact entry below.
- The command is the project's own compiler, `tectonic main.tex` or `latexmk -pdf main.tex`, with the paper's files in
  `inputs.code` and the figures and tables in `inputs.data`. A sandboxed run cannot write beside the sources: compile
  into `SATURN_RUN_OUTPUT` (`tectonic --outdir "$SATURN_RUN_OUTPUT" main.tex`, or `latexmk -outdir=...`), and write one
  sample line saying whether it compiled, with the warning count in `scores`.
- The PDF stays in the run's `written/` folder with the run's record; `research_read { what: "output", run }` lists it
  and reads the compile log. Register the PDF and the draft as `document` artifacts with `research_evidence`,
  `action: "artifact_register"`, `kind: "document"`, `runId`: the PDF by its path in the run's manifest through
  `artifacts_from_run` (`{"path":"written/main.pdf","kind":"document"}`), the `.tex` or `.md` by its project path. Each
  is kept with its hash, so a finding can name the artifact that a reader opens in Experiments.
- Saturn does not bring a TeX distribution: ask the person to install tectonic or TeX Live, and name the program in the
  command by absolute path when the shell's `PATH` is bare. A formula in a finding or a chat is written in `$…$` and is
  shown set; the `.tex` file is highlighted in the Workspace.

## The person's decisions
Authorship and its order, the venue, which claims to make and how strongly, whether a dataset's terms allow publication, and whether to release weights or data are theirs. Write the draft with the claims the findings support, and mark each place where a decision is needed with a visible note. Do not fill in authors, affiliations or acknowledgements.

## Before handing back
- Every number traced to a run id or finding, and read from the record today.
- Every figure regenerated and registered, its artifact id in the source.
- Every claim marked confirmatory or exploratory, with only `completed` runs, `inputsChanged` false, behind it.
- Compared versions `comparable`.
- Limitations cover each `partial` or `unverified` input and each `null` in `reported`.
- Every citation opened, and confirmed by the person.
- Failed and invalid runs in the deviations, not left out.
- The decision notes listed in the message that hands the draft back: see `handing-back`.
