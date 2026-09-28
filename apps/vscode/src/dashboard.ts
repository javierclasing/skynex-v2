import * as vscode from "vscode";

export class SkynexDashboardProvider implements vscode.TreeDataProvider<DashboardItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(element: DashboardItem): vscode.TreeItem {
    return element;
  }

  getChildren(): DashboardItem[] {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      return [new DashboardItem("Abre un workspace para usar Skynex", "skynex.doctor", vscode.TreeItemCollapsibleState.None)];
    }

    return [
      new DashboardItem("Workspace", undefined, vscode.TreeItemCollapsibleState.None, workspace.uri.fsPath),
      new DashboardItem("Instalar recursos", "skynex.install", vscode.TreeItemCollapsibleState.None),
      new DashboardItem("Previsualizar cambios", "skynex.preview", vscode.TreeItemCollapsibleState.None),
      new DashboardItem("Actualizar recursos", "skynex.update", vscode.TreeItemCollapsibleState.None),
      new DashboardItem("Diagnóstico", "skynex.doctor", vscode.TreeItemCollapsibleState.None),
      new DashboardItem("Desinstalar recursos", "skynex.uninstall", vscode.TreeItemCollapsibleState.None),
    ];
  }
}

class DashboardItem extends vscode.TreeItem {
  constructor(
    label: string,
    commandId: string | undefined,
    state: vscode.TreeItemCollapsibleState,
    description?: string,
  ) {
    super(label, state);
    if (description) this.description = description;
    if (commandId) {
      this.command = { command: commandId, title: label };
      this.contextValue = "skynexAction";
    }
    this.iconPath = new vscode.ThemeIcon(commandId ? "play" : "folder-opened");
  }
}
