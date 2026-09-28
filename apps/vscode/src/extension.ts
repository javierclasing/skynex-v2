import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { SkynexDashboardProvider } from "./dashboard.js";

type SkynexCommand = "install" | "update" | "uninstall" | "doctor";
type Component = "configuration" | "agents" | "skills" | "plugins";
const output = vscode.window.createOutputChannel("Skynex");

function workspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function cliCandidates(): string[] {
  const configured = vscode.workspace.getConfiguration("skynex").get<string>("cliPath", "").trim();
  if (configured) return [configured];
  const candidates: string[] = [];
  const workspace = workspacePath();
  if (workspace) {
    const localCli = join(workspace, "node_modules", ".bin", "skynex");
    if (existsSync(localCli)) candidates.push(localCli);
  }
  if (process.platform === "win32") candidates.push("skynex.cmd");
  else candidates.push("skynex", "/usr/local/bin/skynex", "/opt/homebrew/bin/skynex");
  return candidates;
}

function cliPath(): string {
  return cliCandidates()[0] ?? "skynex";
}

async function run(command: SkynexCommand, options: { dryRun?: boolean; components?: readonly Component[] } = {}): Promise<boolean> {
  const workspace = workspacePath();
  if (!workspace) {
    void vscode.window.showErrorMessage("Abre un workspace antes de ejecutar Skynex.");
    return false;
  }
  const args = [command, "--project", workspace];
  if (options.components?.length) args.push("--components", options.components.join(","));
  args.push("--yes");
  if (options.dryRun) args.push("--dry-run");
  output.clear();
  output.show(true);
  output.appendLine(`$ ${cliPath()} ${args.join(" ")}`);
  const candidates = cliCandidates();
  return await new Promise<boolean>((resolve, reject) => {
    const tryNext = (index: number): void => {
      const executable = candidates[index];
      if (!executable) {
        reject(new Error("No se encontró el CLI de Skynex. Configura skynex.cliPath o instala @skynex-ai/cli."));
        return;
      }
      const child = spawn(executable, args, { cwd: workspace, shell: process.platform === "win32" });
      child.stdout.on("data", (data: Buffer) => output.append(data.toString()));
      child.stderr.on("data", (data: Buffer) => output.append(data.toString()));
      child.on("error", (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? tryNext(index + 1) : reject(error));
      child.on("close", (code) => code === 0 ? resolve(true) : reject(new Error(`Skynex terminó con código ${code ?? "desconocido"}.`)));
    };
    tryNext(0);
  }).then(
    () => true,
    (error: unknown) => { void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); return false; },
  );
}

async function install(): Promise<void> {
  const selected = await vscode.window.showQuickPick([
    { label: "$(file-code) Configuración", description: "Estructura base y registro de Skynex", value: "configuration" as const },
    { label: "$(organization) Agentes", description: "Colaboradores especializados", value: "agents" as const },
    { label: "$(tools) Skills", description: "Métodos de trabajo reutilizables", value: "skills" as const },
  ], { canPickMany: true, title: "Instalar Skynex", placeHolder: "Selecciona los componentes para este proyecto" });
  if (!selected?.length) return;
  const choice = await vscode.window.showInformationMessage("Skynex preparará estos componentes en el proyecto:", { modal: true }, "Previsualizar", "Instalar");
  if (!choice) return;
  if (choice === "Previsualizar") {
    await run("install", { dryRun: true, components: selected.map((item) => item.value) });
    const confirm = await vscode.window.showInformationMessage("Previsualización terminada. ¿Aplicar la instalación?", { modal: true }, "Aplicar");
    if (confirm !== "Aplicar") return;
  }
  await run("install", { components: selected.map((item) => item.value) });
  void vscode.window.showInformationMessage("Skynex está instalado en este proyecto.");
}

export function activate(context: vscode.ExtensionContext): void {
  const dashboard = new SkynexDashboardProvider();
  context.subscriptions.push(
    output,
    vscode.window.registerTreeDataProvider("skynex.dashboard", dashboard),
    vscode.commands.registerCommand("skynex.install", install),
    vscode.commands.registerCommand("skynex.update", () => run("update", { dryRun: false })),
    vscode.commands.registerCommand("skynex.uninstall", () => run("uninstall")),
    vscode.commands.registerCommand("skynex.doctor", () => run("doctor")),
    vscode.commands.registerCommand("skynex.preview", () => run("update", { dryRun: true })),
    vscode.commands.registerCommand("skynex.refresh", () => dashboard.refresh()),
  );
}

export function deactivate(): void {
  output.dispose();
}
