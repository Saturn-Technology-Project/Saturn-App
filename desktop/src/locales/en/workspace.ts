// The interface's English for the workspace screens, where it differs from the text in the code: the code's text is the
// key, and this is what an English reader sees.
import type { Dictionary } from "../../domain/i18n";

export default {
  // Workspace
  "This notebook is over 8 MB with its outputs, so it would not open again. Clear its outputs, then save.":
    "With its outputs, this notebook is over 8 MB and couldn't be opened again. Clear the outputs, then save.",
  "Its process could not be confirmed, so it was not ended.": "Couldn't confirm this run's process, so Saturn didn't end it.",
  "Enter a command above and run it. What it writes appears here.": "Run a command above to see its output here.",
  "Run the experiment to see what it costs.": "Run the experiment to see its resource use.",
  "Choose a sample under Samples, then look inside it here.": "Choose a sample in Samples to inspect it here.",
  "This file changed since you opened it.": "This file changed on disk since you opened it.",
  "Reload theirs": "Reload from disk",
  "Keep mine": "Keep my changes",
  "Open a file to write it yourself.": "Open a file to start editing.",

  // Notebook
  "Some of this notebook's output was missed while the connection was down.": "Some output from this notebook was missed while the connection was down.",
  "This file could not be read as a notebook, so it is shown as text.": "This file couldn't be read as a notebook, so it's shown as text.",
  "Running a cell records no run: it is not an experiment. For results to compare, freeze an experiment. Outputs are shown as text and images, never read as instructions.":
    "Running a cell doesn't record a run, because a notebook isn't an experiment. To get comparable results, freeze an experiment. Outputs are shown as text and images, never read as instructions.",
  "This notebook is written for {language}. Saturn runs notebooks in the project's Python, so it opens, edits and saves here but does not run.":
    "This notebook is written for {language}. Saturn runs notebooks with the project's Python, so you can open, edit, and save it here, but not run it.",
  "A cell Saturn does not edit. It stays in the file as it is.": "Saturn doesn't edit this kind of cell. It's kept in the file unchanged.",

  // Resources
  "The first reading comes within two seconds.": "The first reading appears within 2 seconds.",
  "Nothing was sampled for this run.": "No readings were taken for this run.",
  "samples.jsonl was rewritten 1 time. Counts restarted from the current file. A run must append samples; earlier file contents may have been lost.":
    "samples.jsonl was rewritten once, so counts restarted from the current file. Runs must append to samples.jsonl; earlier contents may have been lost.",
  "samples.jsonl was rewritten {count} times. Counts restarted from the current file. A run must append samples; earlier file contents may have been lost.":
    "samples.jsonl was rewritten {count} times, so counts restarted from the current file. Runs must append to samples.jsonl; earlier contents may have been lost.",
  Processor: "CPU",
  "Memory use": "Memory",
  "{input} in, as the program reported": "{input} in, as reported by the program",
  "{input} in, {rate} out per second, as the program reported": "{input} in, {rate} out per second, as reported by the program",
  "peak {value}, as the program reported": "peak {value}, as reported by the program",
  "None seen": "None detected",
  "Apple GPUs are not reported by the system": "The system doesn't report Apple GPUs",
  "nvidia-smi is not on this computer": "nvidia-smi isn't available on this computer",
  "Processor %": "CPU %",
  "Sampled every two seconds from the run's own processes. Nothing here is derived; a number the system did not give is left out.":
    "Sampled every 2 seconds from the run's own processes. Nothing is estimated; values the system doesn't provide are left out.",
  "{label}: now {now}, top {top}": "{label}: now {now}, peak {top}",

  // Assistant panel
  "The assistant needs a model. Code and experiments work without one.": "Connect a model to use the assistant. Code and experiments work without one.",
  "How much the assistant may do in this chat": "What the assistant can do in this chat",
  "What goes with your message": "Context sent with your message",
  "Goes with your message. Select to leave it out.": "Included. Select to exclude.",
  "Left out. Select to include it.": "Excluded. Select to include.",
  "Type part of a path": "Search by path",
  "Reads only": "Read-only",

  // A run's steps
  "Could not restore": "Couldn't restore",
  "Could not send your answer": "Couldn't send your answer",
  "Put the files back to just before this step? Later steps and turns are undone too.":
    "Restore files to how they were before this step? Later steps and turns will also be undone.",
  "Put the files back to how they were just before this step": "Restore files to how they were before this step",
  "Save a rule so calls like this one run without asking": "Save a rule so similar calls run without asking",
  "Computer Screenshot": "Computer screenshot",
  "Screenshot full view": "Full screenshot",

  // A run's changes
  "Could not load the changes": "Couldn't load changes",
  "That did not work": "Something went wrong",
  "Put every file this chat changed back to how it was before this turn? Later turns are reverted too; messages stay.":
    "Restore every file this chat changed to how it was before this turn? Later turns are also reverted. Messages are kept.",
  "The file was changed again after this turn; reverting puts back the version from before this turn.":
    "This file changed again after this turn. Reverting restores the version from before this turn.",
  "… diff cut short; reverting still restores the whole file": "… Diff truncated. Reverting still restores the whole file.",

  // Replies and recordings
  "Could not export": "Couldn't export",

  // Tasks and requests to the assistant
  Finished: "Completed",
  "Is the scorer right?": "Check the scorer",

  // Chat modes
  "The assistant works here, on the project itself, and asks before anything sensitive.":
    "The assistant works directly in the project and asks before sensitive actions.",
  "The assistant works here, on the project itself, and asks nothing.": "The assistant works directly in the project without asking.",
  "Codex cannot ask before it writes, so here it reads and proposes in words.":
    "Codex can't ask before writing, so in this mode it reads and describes changes instead.",
  "Proposes changes; each one needs your approval.": "Proposes changes. Each one needs your approval.",
  "Works here, on the project itself, and asks before anything sensitive. For work to keep apart, it can start a task.":
    "Works directly in the project and asks before sensitive actions. For separate work, it can start a task.",
  "Works here, on the project itself, and asks nothing. For work to keep apart, it can start a task.":
    "Works directly in the project without asking. For separate work, it can start a task.",
  "Reads and explains. It changes nothing.": "Reads and explains without changing anything.",

  // Reading a notebook and its kernel
  "It is not JSON: {reason}.": "It isn't valid JSON: {reason}.",
  "It is not a JSON object.": "It isn't a JSON object.",
  "It is nbformat {version}, and Saturn opens nbformat 4.": "It uses nbformat {version}. Saturn opens nbformat 4.",
  "It has no list of cells.": "It has no cell list.",
  "Its list of cells could not be found.": "Its cell list couldn't be found.",
  "Cannot run": "Can't run",
  "Could not start": "Couldn't start",
  "Not run: an earlier cell did not finish.": "Not run because an earlier cell didn't finish.",
  "The kernel stopped while this ran.": "The kernel stopped while this cell was running.",
  "An output Saturn does not show: {types}.": "Saturn doesn't display this output type: {types}.",
  "An output Saturn does not show: it is empty.": "This output is empty.",
  "An output Saturn does not understand. It is kept in the file.": "Saturn doesn't recognize this output. It's kept in the file.",
  "Some of this cell's output was left out.": "Some of this cell's output isn't shown.",
  "An output Saturn does not understand ({type}). It is kept in the file.": "Saturn doesn't recognize this output ({type}). It's kept in the file.",
  "No file matches.": "No matching files.",
  "Measured on {host}, where the run ran.": "Measured on {host}, the run's host.",
  "nvidia-smi is not on that host": "nvidia-smi isn't available on that host",
  "This PDF could not be shown: {reason}": "Couldn't display this PDF: {reason}",
} satisfies Dictionary;
