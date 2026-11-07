// The interface's English for the shell screens, where it differs from the text in the code: the code's text is the
// key, and this is what an English reader sees.
import type { Dictionary } from "../../domain/i18n";

export default {
  // The screens, the tour and the places the guide points at (domain/workbench.ts).
  "Read the method, write the code yourself, run the experiment and inspect every sample, on your own computer. This tour boxes each part of Saturn and says what it is for, then helps you start a piece of research. Skip it any time; it is in Commands (⌘K) as \"Take the tour\".":
    "Read the method, write your own code, run experiments, and inspect every sample, all on your own computer. This tour highlights each part of Saturn and what it's for, then helps you start your research. Skip it anytime and reopen it from Commands (⌘K) with \"Take the tour\".",
  "Saturn is organized around your research, not around chats: questions, code, models, experiments, samples, data, long tasks, protection and the environment. ⌘1 to ⌘9 switch to the first nine.":
    "Saturn is organized around your research, not chats: questions, code, models, experiments, samples, data, long-running tasks, protection, and the environment. Press ⌘1–⌘9 to switch to the first nine.",
  "Home: where the work stands": "Home: where your research stands",
  "The question you are on, its hypotheses and their verdicts, what changed since you last looked, and what is still open. You or the assistant set a verdict, and it says which of you did; a run that finishes says only that it executed.":
    "The question you are working on, its hypotheses and verdicts, what changed since your last visit, and what is still open. A verdict is set by you or the assistant, and shows which. A finished run only means it executed.",
  "Workspace: code beside its results": "Workspace: code and results side by side",
  "Open a file, write it, and run the experiment's command. Below the editor: the run, what it cost, its samples, your findings, a look inside the model, and a terminal.":
    "Open a file, edit it, and run the experiment's command. Below the editor are the run, its cost, its samples, your findings, a look inside the model, and a terminal.",
  "The research assistant": "Research assistant",
  "A panel beside your work, on every screen (⌘J). Ask it what a screen is for or how to do something, and it can walk you through it, boxing each place while you do the work. Beside its name you choose how much it may do: in Ask it only reads and explains; in Approve it proposes changes you approve; in Auto it works on the project itself and asks before anything sensitive; in Agent it asks nothing. Samples it is given are marked as data, never as instructions.":
    "A panel beside your work on every screen (⌘J). Ask what a screen is for or how to do something, and it can walk you through it, highlighting each place as you work. Next to its name, choose how much it can do: Ask only reads and explains; Approve proposes changes for you to approve; Auto works on the project directly and asks before anything sensitive; Agent asks nothing. Samples it receives are marked as data, never as instructions.",
  "Connect pretraining checkpoints to fine-tuned and preference-trained branches. Each node shows what was last measured on it, and Saturn warns when two nodes were not measured the same way, so a difference in method never reads as a difference in the model.":
    "Connect pretraining checkpoints to their fine-tuned and preference-trained branches. Each node shows its latest measurement, and Saturn warns you when two nodes weren't measured the same way, so a difference in method never looks like a difference in the model.",
  "Running freezes a version: the code, data, scorer and models exactly as they were. Here you see each model's score, where the score comes from (what the scorer judged, what you disputed, what was excluded), and you write the conclusion, kept with the run it rests on.":
    "Each run freezes a version: the code, data, scorer, and models exactly as they were. See each model's score and where it comes from (what the scorer judged, what you disputed, what was excluded), and write your conclusion, which stays with the run it's based on.",
  "One sample across every model that saw it, with the scorer's own word next to your label. Your label never overwrites a score. Keep a sample as a counterexample, or look inside: read activations at every layer, or patch a layer in from another model.":
    "See one sample across every model that saw it, with the scorer's judgment next to your label. Your label never overwrites a score. Keep a sample as a counterexample, or look inside: read activations at every layer, or patch in a layer from another model.",
  "Every file your experiments named as data: whether it changed since it was frozen, and which runs read it and when, so you can check how often test data was touched. A name is not proof, and a declared split says more. Read its rows and columns, and count the rows two files share, which finds exact duplicates only.":
    "Every file your experiments list as data: whether it changed since it was frozen, and which runs read it and when, so you can see how often test data was touched. A file name isn't proof; a declared split says more. Browse rows and columns, and count the rows two files share (exact duplicates only).",
  "Inspect: inside a model": "Inspect: look inside a model",
  "Type two prompts to see which layer and position carries the answer, read against a random control, read two models on one prompt to see where they part, or read a layer through a sparse autoencoder. Everything already looked at in the project is listed here. A prompt typed here is one case, not a measurement.":
    "Compare two prompts to find which layer and position carries the answer, measured against a random control. Run one prompt through two models to see where they diverge, or read a layer through a sparse autoencoder. Everything already inspected in the project is listed here. A prompt you type here is a single case, not a measurement.",
  "Tasks: long work, apart": "Tasks: long-running work, kept separate",
  "Batch runs and cleanups go to an agent in its own worktree. It cannot touch locked files, and nothing reaches the project until you merge it. When it wants to change a locked file, you decide: release it for the next version, keep it, or edit it yourself.":
    "Hand off batch runs and cleanups to an agent in its own worktree. It can't touch locked files, and nothing reaches the project until you merge it. When it wants to change a locked file, you decide: unlock it for the next version, keep it as is, or edit it yourself.",
  "Every refusal and every change noticed outside Saturn's tools is recorded here, with what each backend can and cannot enforce. Modes are a workflow constraint, not a security boundary, and this screen says so plainly.":
    "Every refusal, and every change Saturn notices outside its own tools, is recorded here, along with what each backend can and can't enforce. Modes are a workflow constraint, not a security boundary, and this screen says so plainly.",
  "Environment: the Python it runs in": "Environment: the Python your code runs in",
  "Name the Python your experiments run with, or have Saturn make one in the project. Ask it for its version, packages and devices, install kits of packages, and freeze the lock files with each version, so a changed environment is a new version rather than a surprise.":
    "Choose the Python your experiments run with, or let Saturn create one in the project. Check its version, packages, and devices, install package kits, and freeze lock files with each version, so a changed environment becomes a new version instead of a surprise.",
  "Start a piece of research": "Start your research",
  "Research lives in a project folder, as plain files under .saturn/research that you can keep. Choose the folder, write down the question you are trying to answer, and the rest connects back to it.":
    "Research lives in your project folder, as plain files under .saturn/research that you keep. Choose the folder and write down the question you want to answer. Everything else connects back to it.",
  "Select {screen} in the rail to open it.": "Select {screen} in the sidebar to open it.",
  "Choose the project here, or add a folder.": "Choose a project here, or add a folder.",
  "Show or hide the assistant here, or with ⌘J.": "Show or hide the assistant here, or press ⌘J.",
  "How much the assistant may do": "How much the assistant can do",
  "Choose Ask, Approve, Auto or Agent for this chat, beside the assistant's name.": "Next to the assistant's name, choose Ask, Approve, Auto, or Agent for this chat.",
  "Open every command here, or with ⌘K.": "Open the command menu here, or press ⌘K.",
  "Connect models, MCP servers and more here.": "Connect models, MCP servers, and more.",
  "Add a hypothesis, and set its verdict when you have evidence. A verdict the assistant set is marked as its own.": "Add a hypothesis and set its verdict once you have evidence. Verdicts set by the assistant are marked.",
  "Open a file to write it.": "Open a file to edit it.",
  "The experiment's command": "Experiment command",
  "Type the command that runs the experiment, starting with its Python.": "Enter the command that runs the experiment, starting with its Python interpreter.",
  "Read the run, what it costs, its samples, your findings, activations and a terminal here.": "See the run, its cost, its samples, your findings, activations, and a terminal.",
  "The selected model": "Selected model",
  "Read what was measured on it, branch from it, and keep a note.": "See its measurements, branch from it, and add a note.",
  "Write the experiment's whole record as one file in the project.": "Save the experiment's full record as a single file in the project.",
  "Compare each model's score. Only what was measured the same way shares the chart.": "Compare each model's score. Only results measured the same way share a chart.",
  "Sweep every layer": "Layer sweep",
  "Choose two models, and patch each layer of one into the other on what the scorer marked wrong.": "Choose two models and patch each layer of one into the other, on the samples the scorer marked wrong.",
  "Write what you concluded. It is kept with the run it rests on.": "Write your conclusion. It stays with the run it's based on.",
  "State the dataset, split, sample set, scorer and prompt format. Two runs compare only when these match.": "Specify the dataset, split, sample set, scorer, and prompt format. Two runs are comparable only when these match.",
  "Choose the run whose samples to read.": "Choose a run to review its samples.",
  "Show all of them, those you dispute, or those with errors.": "Show all samples, only the ones you dispute, or only the ones with errors.",
  "The samples": "Sample list",
  "Select a sample to read it across the models that saw it.": "Select a sample to compare it across every model that saw it.",
  "Read activations at every layer, or patch a layer in from another model.": "Read activations at every layer, or patch in a layer from another model.",
  "Save the sample as a counterexample, with why.": "Save the sample as a counterexample, with a reason.",
  "The data files": "Data files",
  "Read which files experiments named, whether they changed, and which runs read them. Select one to look inside it.": "See which files your experiments list, whether they changed, and which runs read them. Select a file to view its contents.",
  "Read its rows, its columns, and the runs that read it.": "Browse its rows and columns, and see which runs read it.",
  "Choose two files and compare them. It finds exact duplicates only.": "Choose two files to compare. Only exact duplicates are found.",
  "Describe long work, and start it in its own worktree.": "Describe long-running work and start it in its own worktree.",
  "What has happened": "What happened",
  "Read what was refused and what changed, and release a lock if you want a file changed.": "Review what was refused and what changed, and unlock a file if you want it changed.",
  "Make a Python environment in the project, or install more into it.": "Create a Python environment in the project, or install more packages into it.",
  "Kits": "Package kits",
  "Name the Python to use, and check what it has.": "Choose which Python to use and check what's installed.",
  "What pins it": "Lock files",
  "Runtime not answering.": "Runtime not responding.",

  // Models and permissions (domain/model.ts, domain/permissions.ts).
  "Remove {name}? {who} uses it and will no longer have its tools.": "Remove {name}? {who} uses it and will lose its tools.",
  "Remove {name}? {who} use it and will no longer have its tools.": "Remove {name}? {who} use it and will lose its tools.",
  "An action and a path glob: write src/**, read, delete *.md.": "An action and a path glob, such as write src/**, read, or delete *.md.",
  "Any tool; the pattern matches the call's first text argument, or * for every call.": "Any tool. The pattern matches the call's first text argument, or use * for every call.",
  "Matched against the call's first text argument (a URL, a path, a name), or * for every call.": "Matched against the call's first text argument (a URL, path, or name), or use * for every call.",

  // Command palette and guide.
  "Walking you through it": "Walkthrough",
  "Not on this screen yet: it appears once {condition}.": "Not on this screen yet. It appears once {condition}.",

  // The workbench's frame (shell/ResearchApp.tsx and what it shows).
  "Saturn's runtime is not answering: {reason}": "Saturn's runtime isn't responding: {reason}",
  "Use the light theme": "Switch to light theme",
  "Use the dark theme": "Switch to dark theme",
  "Research records live in a project's own folder, as plain files you can keep.": "Research records live in the project's own folder, as plain files you keep.",
  "Saturn reads and writes this folder only after you allow it.": "Saturn reads and writes this folder only after you allow access.",
  "Runtime not answering": "Runtime not responding",
  "Another Saturn is in the way": "Another Saturn is blocking the runtime",
  "Starting Saturn's runtime again": "Restarting Saturn's runtime",
  "This takes a moment.": "This may take a moment.",
  "Its last output": "Last output",
  "Start the runtime with {command}, or open Saturn's app.": "Start the runtime with {command}, or open the Saturn app.",

  // The tour's last step.
  "No model yet; code and experiments work without one": "No model yet. Code and experiments work without one.",
  "Save the question and start": "Save question and start",

  // Notifications and shared parts.
  "Reading this project's records…": "Loading project records…",

  // Home.
  "Write down the question this project is trying to answer, then work on it.": "Write down the question this project is trying to answer, then start working on it.",
  "Restored as it was": "Restored layout",
  "Records come from the project folder; what was open comes from this device.": "Records come from the project folder; what you had open comes from this device.",
  "On this device, {time}.": "Last visit on this device: {time}.",
  "First visit on this device, so everything is new.": "This is your first visit on this device, so everything is new.",
  "See": "View",
  "Open": "Open items",
  "{count} to look at": "{count} to review",
  "You or the assistant set a verdict, and it says which of you did. A run that completes says only that it executed.": "A verdict is set by you or the assistant, and shows which. A completed run only means it executed.",

  // Tasks.
  "Tasks need a model to run on.": "Connect a model to run tasks.",
  "Locked files are refused, and nothing reaches the project until you merge it.": "Changes to locked files are refused, and nothing reaches the project until you merge.",
  "Hand off batch runs, cleanups and long work here, and keep writing what you want to write yourself.": "Hand off batch runs, cleanups, and other long-running work here, and keep writing the code you want to write yourself.",
  "{path} is released for the next version: change it, and the next run freezes a new version with it.": "{path} is unlocked for the next version. Change it, and the next run freezes a new version that includes it.",
  "Nothing named; a frozen version also locks its data and scorer": "None specified. A frozen version also locks its data and scorer.",
  "Budget: none set": "Budget: not set",
  "Release {path} for the next version": "Unlock {path} for the next version",
  "Keep {path} as it is and continue without changing it.": "Keep {path} unchanged and continue.",
  "Keep it and continue": "Keep and continue",

  // Protection.
  "Modes and locks keep an agent to how you want to work. They are not a security boundary: a shell or another program can still write a file, and that is only noticed afterwards.":
    "Modes and locks keep an agent working the way you want. They aren't a security boundary: a shell or another program can still write a file, and Saturn only notices afterward.",
  "Released until the next version is frozen: {paths}. Freezing a version, as a run does, locks what it uses again.":
    "Unlocked until the next version is frozen: {paths}. Freezing a version, as every run does, locks what it uses again.",
  "Changed, by someone or something: {paths} (noticed after {tool})": "Changed by an unknown source: {paths} (noticed after {tool})",
  "Let it change {path} for the next version": "Allow changes to {path} for the next version",
  "Refused for the tools it asks about": "Refused for the tools it asks permission for",
  "Cannot be refused per file": "Can't be refused per file",
  "Saturn cannot tell what they write": "Saturn can't tell what they write",

  // Environment.
  "Making the environment": "Creating environment",
  "Syncing from the lock file": "Syncing from lock file",
  "Experiments and looking inside run with this Python. Saturn can make one in the project and fill it with what the work needs; it installs nothing you did not ask for.":
    "Experiments and model inspection run with this Python. Saturn can create one in the project and install what your work needs. It never installs anything you didn't ask for.",
  "Choose 1 to 1440 whole minutes.": "Enter a whole number of minutes from 1 to 1440.",
  "Use it": "Use",
  "Brings it to what the lock file says": "Matches it to the lock file",
  "No lock file at the project's root": "No lock file in the project root",
  "No managed environment yet. Saturn can make one in the project with {tool}:": "No managed environment yet. Saturn can create one in the project with {tool}:",
  "Install uv to pick a Python version and for faster installs.": "Install uv to choose a Python version and get faster installs.",
  "Neither uv nor python3 is on this computer's PATH. Install uv (astral.sh/uv) or Python, then come back.": "Neither uv nor python3 is on this computer's PATH. Install uv (astral.sh/uv) or Python, then try again.",
  "interrupted: the runtime that started it is gone": "interrupted: the runtime that started it is no longer running",
  "Nothing written yet.": "No output yet.",
  "The last 40 of {count} lines; the whole log is in {path}.": "Showing the last 40 of {count} lines. Full log: {path}.",
  "Packages for one kind of work. Which are installed is read from the last check of the managed environment.": "Packages for a specific kind of work. Installed status comes from the managed environment's last check.",
  "Install the rest": "Install missing",
  "Asking…": "Checking…",
  "The managed environment. Save it to keep it.": "The managed environment. Save to keep this choice.",
  "Taken from the newest experiment's command. Save it to keep it.": "From the latest experiment's command. Save to keep this choice.",
  "Give the path of the Python that runs your experiments, start an experiment's command with it, or create the managed environment above.": "Enter the path to the Python that runs your experiments, start an experiment's command with it, or create the managed environment above.",
  "What it has": "What's installed",
  "Checked": "Last checked",
  "Not checked yet. Check asks the interpreter for its version, the packages research code leans on, the devices torch can see, and which programs are on its PATH.": "Not checked yet. Checking asks the interpreter for its version, the packages research code depends on, the devices torch can see, and which programs are on its PATH.",
  "No lock file at the project's root. A uv.lock, requirements.txt or pyproject.toml here would be listed with its hash, and can be made part of what a version freezes.":
    "No lock file in the project root. A uv.lock, requirements.txt, or pyproject.toml there is listed with its hash and can be frozen with each version.",
  "A lock file frozen with a version makes a change to it a new version, so two runs with different environments never read as the same.":
    "When a lock file is frozen with a version, any change to it makes a new version, so two runs with different environments are never treated as the same.",

  // Remote execution.
  "Remote launch recorded: {run}. Closing Saturn detaches; Stop requests cancellation.": "Remote launch recorded: {run}. Closing Saturn only detaches; Stop requests cancellation.",
  "Configure the host in Environment. Remote code is not uploaded or certified identical to these local frozen files. The remote worker records its working directory and git commit. Existing remote jobs keep their original target when settings change.":
    "Set up the host in Environment. Code isn't uploaded, and the remote copy isn't verified to match these local frozen files. The remote worker records its working directory and git commit. Existing remote jobs keep their original target if settings change.",
  "Executable version": "Version to run",
  "Resume checkpoint on remote host (optional)": "Resume from checkpoint on remote host (optional)",
  "The command receives SATURN_RESUME_FROM; its framework must restore model, optimizer and random state. A new attempt is a new run. The wall-clock limit stops the process group; it is not a guarantee of GPU billing.":
    "The command receives SATURN_RESUME_FROM, and its framework must restore the model, optimizer, and random state. Each new attempt is a new run. The wall-clock limit stops the process group; it doesn't guarantee that GPU billing stops.",

  // Project folders and access (ProjectAccess.tsx).
  "Open Project Folder": "Open project folder",
  "Could not open the folder": "Couldn't open the folder",
  "You can revoke access any time from the project's menu. macOS may also ask once to let Saturn read this location.": "You can revoke access anytime from the project menu. macOS may also ask once for permission for Saturn to read this location.",
  "Allow Access": "Allow access",
  "Workspace name cannot be empty": "Workspace name can't be empty",
  "At least one folder is required": "Add at least one folder",
  "Failed to save workspace": "Couldn't save the workspace",
  "Edit Workspace": "Edit workspace",
  "Configure project name and folder paths.": "Set the project name and folder paths.",
  "Add Folder…": "Add folder…",
  "What Saturn's helpers need": "Saturn helpers",
  "Looking inside a model and the environment check load models with these. Installed with the environment unless you say not to.": "Model inspection and the environment check use these to load models. Installed with the environment unless you opt out.",
  "Jupyter and a kernel, for notebooks beside the code.": "Jupyter and a kernel, for notebooks alongside your code.",
  "Experiments and the look inside a model run with it. Saturn can make one in the project and install what research code needs.": "Experiments and model inspection run with it. Saturn can create one in the project and install what your research code needs.",
  "Write a hypothesis before any result": "Write a hypothesis before seeing results",
  "A prediction written after seeing the number is only a description. The verdict is yours to set later.": "A prediction written after you see the numbers is only a description. You set the verdict later.",
  "Bring in results you have, or write an experiment": "Import existing results, or write an experiment",
  "Results from earlier work come in marked as imported, so they are never mistaken for a run Saturn made. The assistant can find and map them for you; you approve the import.":
    "Results from earlier work are marked as imported, so they're never mistaken for a run Saturn made. The assistant can find and map them for you; you approve the import.",
  "Ask the assistant to help": "Ask the assistant for help",
  "Read the samples and label some": "Review and label samples",
  "Write what you found": "Record your findings",
  "A finding stays with the runs it rests on, so it can be checked later.": "A finding stays with the runs it's based on, so you can check it later.",
  "Read the method, write the code yourself, run the experiment and read every sample, on your own computer. Three short steps show where things are; then a checklist on Home takes you through your first study. The whole tour is in Commands (⌘K) as \"Take the tour\".":
    "Read the method, write your own code, run experiments, and read every sample, all on your own computer. Three quick steps show you around; then a checklist on Home guides you through your first study. The full tour is in Commands (⌘K) under \"Take the tour\".",
  "{done} of {count} done": "{done} of {count} complete",
  "The request opens in the assistant's box for you to read and send. It previews each file and imports only after you agree.":
    "The request opens in the assistant's message box so you can review and send it. The assistant previews each file and imports only after you agree.",
} satisfies Dictionary;
