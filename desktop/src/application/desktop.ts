import { AccountService } from "./account.js";
import { AdminService } from "./admin.js";
import { CatalogService } from "./catalog.js";
import { RunService } from "./runs.js";
import { SessionService } from "./session.js";
import { RuntimeClient } from "../infrastructure/runtime-client.js";

/** Composition root for the desktop. Screens call these use cases and do not know the runtime URLs. */
export class DesktopApp {
  readonly session: SessionService;
  readonly catalog: CatalogService;
  readonly runs: RunService;
  readonly admin: AdminService;
  readonly account: AccountService;

  constructor(runtime: RuntimeClient = new RuntimeClient()) {
    this.session = new SessionService(runtime);
    this.catalog = new CatalogService(runtime);
    this.runs = new RunService(runtime);
    this.admin = new AdminService(runtime);
    this.account = new AccountService(runtime);
  }
}

export const desktop = new DesktopApp();
