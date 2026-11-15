// Why commands are not sandboxed on this computer, in the interface's language.
import type { TextParams } from "./i18n";

type Words = (text: string, params?: TextParams) => string;

/**
 * The runtime's reason the sandbox is off or its setup did not finish, translated when it is one Saturn itself gives
 * (crates/saturn-tools sandbox.rs and appcontainer.rs, word for word); any other reason is shown as the runtime said it.
 */
export function sandboxReason(reason: string | null, t: Words): string {
  switch (reason) {
    case "sandbox-exec is missing":
      return t("sandbox-exec is missing");
    case "bubblewrap (bwrap) is not installed":
      return t("bubblewrap (bwrap) is not installed");
    case "this program cannot start a Windows sandbox":
      return t("this program cannot start a Windows sandbox");
    case "the Windows sandbox is not set up: Settings → General → Sandbox sets it up once, as an administrator (or `saturn-server --appcontainer-setup`; see the README)":
      return t("the Windows sandbox is not set up: Settings → General → Sandbox sets it up once, as an administrator (or `saturn-server --appcontainer-setup`; see the README)");
    case "the administrator prompt was declined":
      return t("the administrator prompt was declined");
    case "the setup could not open everything, or did not run as an administrator":
      return t("the setup could not open everything, or did not run as an administrator");
    case "This computer's sandbox has no setup to run from Saturn":
      return t("This computer's sandbox has no setup to run from Saturn");
    default:
      return reason ?? "";
  }
}
