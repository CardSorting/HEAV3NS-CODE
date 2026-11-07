import type { Component, Focusable } from "../tui.js";
import { Box } from "./box.js";
import { SettingsList, type SettingItem, type SettingsListTheme } from "./settings-list.js";
import { Text } from "./text.js";
import { VStack } from "./v-stack.js";

const DEFAULT_SETTINGS_THEME: SettingsListTheme = {
  label: (text, selected) => (selected ? `\x1b[1;36m${text}\x1b[0m` : text),
  value: (text, selected) => (selected ? `\x1b[1;35m${text}\x1b[0m` : `\x1b[33m${text}\x1b[0m`),
  description: (text) => `\x1b[90m${text}\x1b[0m`,
  cursor: "\x1b[1;35m▶ \x1b[0m",
  hint: (text) => `\x1b[90m${text}\x1b[0m`,
};

export class SettingsModal implements Component, Focusable {
  focused: boolean = false;
  private readonly container: Box;
  private readonly settingsList: SettingsList;
  private readonly onClose: () => void;

  constructor(
    items: SettingItem[],
    onChange: (id: string, newValue: string) => void,
    onClose: () => void
  ) {
    this.onClose = onClose;

    const bgFn = (text: string) => `\x1b[48;5;235m${text}\x1b[0m`;
    this.container = new Box(2, 1, bgFn);

    const vstack = new VStack();
    const title = new Text(
      `\x1b[1;35m━━━ LUMI MONOLITH INTERACTIVE FRAMEWORK SETTINGS ━━━\x1b[0m`,
      0,
      0
    );

    this.settingsList = new SettingsList(
      items,
      6,
      DEFAULT_SETTINGS_THEME,
      onChange,
      onClose
    );

    vstack.addChild(title);
    vstack.addChild(this.settingsList);
    this.container.addChild(vstack);
  }

  updateValue(id: string, newValue: string): void {
    this.settingsList.updateValue(id, newValue);
    this.invalidate();
  }

  invalidate(): void {
    this.container.invalidate();
    this.settingsList.invalidate();
  }

  handleInput(data: string): void {
    this.settingsList.handleInput(data);
  }

  render(width: number): string[] {
    return this.container.render(width);
  }
}
