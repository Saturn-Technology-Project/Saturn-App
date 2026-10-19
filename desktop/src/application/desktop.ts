import { AdminService } from "./admin.js";
import { AutomationService } from "./automations.js";
import { CatalogService } from "./catalog.js";
import { GroupService } from "./groups.js";
import { MarketplaceService } from "./marketplace.js";
import { ProjectService } from "./projects.js";
import { RunService } from "./runs.js";
import { TelemetryService } from "./telemetry.js";
import { WorkspaceService } from "./workspace.js";
import { RuntimeClient } from "../infrastructure/runtime-client.js";

/** Composition root for the desktop. Screens call these use cases and do not know the runtime URLs. */
export class DesktopApp {
  readonly catalog: CatalogService;
  readonly runs: RunService;
  readonly admin: AdminService;
  readonly workspace: WorkspaceService;
  readonly automations: AutomationService;
  readonly telemetry: TelemetryService;
  readonly marketplace: MarketplaceService;
  readonly projects: ProjectService;
  readonly groups: GroupService;

  constructor(runtime: RuntimeClient = new RuntimeClient()) {
    this.catalog = new CatalogService(runtime);
    this.runs = new RunService(runtime);
    this.admin = new AdminService(runtime);
    this.workspace = new WorkspaceService(runtime);
    this.automations = new AutomationService(runtime);
    this.telemetry = new TelemetryService(runtime);
    this.marketplace = new MarketplaceService(runtime);
    this.projects = new ProjectService(runtime);
    this.groups = new GroupService(runtime);
  }
}

export const desktop = new DesktopApp();
