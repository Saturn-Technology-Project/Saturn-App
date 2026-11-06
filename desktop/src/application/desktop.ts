import { AdminService } from "./admin.js";
import { AssistantService } from "./assistant.js";
import { AutomationService } from "./automations.js";
import { CatalogService } from "./catalog.js";
import { NotebookService } from "./notebooks.js";
import { ProjectService } from "./projects.js";
import { ResearchService } from "./research.js";
import { RunService } from "./runs.js";
import { TelemetryService } from "./telemetry.js";
import { WorkspaceService } from "./workspace.js";
import { LiveService } from "./live.js";
import { RuntimeClient } from "../infrastructure/runtime-client.js";

/** Composition root for the desktop. Screens call these use cases and do not know the runtime URLs. */
export class DesktopApp {
  readonly catalog: CatalogService;
  readonly runs: RunService;
  readonly admin: AdminService;
  readonly workspace: WorkspaceService;
  readonly automations: AutomationService;
  readonly telemetry: TelemetryService;
  readonly projects: ProjectService;
  readonly research: ResearchService;
  readonly notebooks: NotebookService;
  readonly assistant: AssistantService;
  readonly live: LiveService;

  constructor(runtime: RuntimeClient = new RuntimeClient()) {
    this.catalog = new CatalogService(runtime);
    this.runs = new RunService(runtime);
    this.admin = new AdminService(runtime);
    this.workspace = new WorkspaceService(runtime);
    this.automations = new AutomationService(runtime);
    this.telemetry = new TelemetryService(runtime);
    this.projects = new ProjectService(runtime);
    this.research = new ResearchService(runtime);
    this.notebooks = new NotebookService(runtime);
    this.assistant = new AssistantService(this.catalog, this.runs);
    this.live = new LiveService(runtime);
  }
}

export const desktop = new DesktopApp();
