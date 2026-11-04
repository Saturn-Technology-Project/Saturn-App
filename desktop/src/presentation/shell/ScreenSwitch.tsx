import type { Project } from "../../domain/model.js";
import { Empty } from "../ui/Parts.js";
import type { Screen } from "./navigation.js";

/** What the shell gives every screen. */
export interface ScreenProps {
  project: Project;
  assistant: boolean;
  go: (screen: Screen) => void;
  notify: (message: string) => void;
}

/** The current screen. */
export function ScreenSwitch(props: ScreenProps & { screen: Screen }) {
  return <Empty title={props.screen}>Being moved here.</Empty>;
}
