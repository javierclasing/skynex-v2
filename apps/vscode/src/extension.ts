import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";

type SkynexCommand = "install" | "update" | "uninstall" | "doctor";
const output = vscode.window.createOutputChannel("Skynex");

function workspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function cliPath(): string {
  const configured = vscode.workspace.getConfiguration("skynex").get<string>("cliPath", "").trim();
  if (configured) return configured;
  const workspace = workspacePath();
  if (workspace) {
    const localCli = join(workspace, "node_modules", ".bin", "skynex");
    if (existsSync(localCli)) return localCli;
  }
  return process.platform === "win32" ? "skynex.cmd" : "skynex";
}

async function run(command: SkynexCommand, dryRun = false): Promise<void> {
  const workspace = workspacePath();
  if (!workspace) {
    void vscode.window.showErrorMessage("Abre un workspace antes de ejecutar Skynex.");
    return;
  }
  const args = [command, "--project", workspace];
  if (dryRun) args.push("--dry-run");
  output.clear();
  output.show(true);
  output.appendLine(`$ ${cliPath()} ${args.join(" ")}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cliPath(), args, { cwd: workspace, shell: process.platform === "win32" });
    child.stdout.on("data", (data: Buffer) => output.append(data.toString()));
    child.stderr.on("data", (data: Buffer) => output.append(data.toString()));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Skynex terminó con código ${code ?? "desconocido"}.`)));
  }).then(
    () => void vscode.window.showInformationMessage(`Skynex: ${command} completado.`),
    (error: unknown) => void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)),
  );
}

async function install(): Promise<void> {
  const choice = await vscode.window.showInformationMessage("¿Quieres previsualizar los cambios antes de instalar Skynex?", "Previsualizar", "Instalar");
  if (!choice) return;
  if (choice === "Previsualizar") {
    await run("install", true);
    const confirm = await vscode.window.showInformationMessage("Preview terminada. ¿Aplicar la instalación?", "Aplicar");
    if (confirm !== "Aplicar") return;
  }
  await run("install");
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("skynex.install", install),
    vscode.commands.registerCommand("skynex.update", () => run("update")),
    vscode.commands.registerCommand("skynex.uninstall", () => run("uninstall")),
    vscode.commands.registerCommand("skynex.doctor", () => run("doctor")),
    vscode.commands.registerCommand("skynex.preview", () => run("update", true)),
  );
}

export function deactivate(): void {
  output.dispose();
}
