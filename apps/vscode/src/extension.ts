import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { SkynexDashboardProvider } from "./dashboard.js";
import { SkynexChatProvider } from "./chat.js";

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

function cleanOutput(value: string): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
      child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
      child.on("error", (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? tryNext(index + 1) : reject(error));
      child.on("close", (code) => {
        const result = cleanOutput(stdout || stderr);
        if (result) output.appendLine(result);
        if (code === 0) resolve(true);
        else reject(new Error(result || `Skynex terminó con código ${code ?? "desconocido"}.`));
      });
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

async function update(): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    "Buscaré cambios de Skynex y actualizaré solo los recursos seleccionados.",
    { modal: true },
    "Previsualizar",
    "Actualizar",
  );
  if (!choice) return;
  if (choice === "Previsualizar") {
    await run("update", { dryRun: true });
    const apply = await vscode.window.showInformationMessage("Previsualización terminada. ¿Aplicar cambios?", { modal: true }, "Aplicar");
    if (apply !== "Aplicar") return;
  }
  if (await run("update")) void vscode.window.showInformationMessage("Skynex está actualizado.");
}

async function uninstall(): Promise<void> {
  const choice = await vscode.window.showWarningMessage("¿Eliminar los recursos gestionados por Skynex de este proyecto?", { modal: true }, "Eliminar");
  if (choice === "Eliminar" && await run("uninstall")) void vscode.window.showInformationMessage("Recursos de Skynex eliminados.");
}

async function doctor(): Promise<void> {
  if (await run("doctor")) void vscode.window.showInformationMessage("Diagnóstico completado. Consulta el canal Skynex para ver el resultado.");
}

export function activate(context: vscode.ExtensionContext): void {
  const dashboard = new SkynexDashboardProvider();
  const chat = new SkynexChatProvider(context.secrets);
  const openChat = vscode.commands.registerCommand("skynex.openChat", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.skynex");
    await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
  });
  const configureChat = vscode.commands.registerCommand("skynex.configureChat", async () => {
    const provider = await vscode.window.showQuickPick([
      { label: "OpenAI", value: "openai", model: "gpt-4o-mini" },
      { label: "Anthropic", value: "anthropic", model: "claude-3-5-sonnet-latest" },
      { label: "Google Gemini", value: "gemini", model: "gemini-2.0-flash" },
      { label: "OpenRouter", value: "openrouter", model: "openai/gpt-4o-mini" },
      { label: "Ollama local", value: "ollama", model: "llama3.2" },
    ], { title: "Configurar Skynex Chat", placeHolder: "Elige tu proveedor" });
    if (!provider) return;
    const model = await vscode.window.showInputBox({ title: `${provider.label}: modelo`, value: provider.model, prompt: "Puedes cambiar el modelo predeterminado" });
    if (!model) return;
    await vscode.workspace.getConfiguration("skynex").update("chat.provider", provider.value, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration("skynex").update("chat.model", model, vscode.ConfigurationTarget.Global);
    if (provider.value !== "ollama") {
      const key = await vscode.window.showInputBox({ title: `${provider.label}: API key`, prompt: "La clave se guardará de forma segura en VS Code", password: true, ignoreFocusOut: true });
      if (key) await context.secrets.store(`skynex.${provider.value}Key`, key);
    }
    void vscode.window.showInformationMessage(`${provider.label} configurado para Skynex Chat.`);
  });
  context.subscriptions.push(
    output,
    vscode.window.registerTreeDataProvider("skynex.dashboard", dashboard),
    vscode.window.registerWebviewViewProvider("skynex.chat", chat),
    openChat,
    configureChat,
    vscode.commands.registerCommand("skynex.install", install),
    vscode.commands.registerCommand("skynex.update", update),
    vscode.commands.registerCommand("skynex.uninstall", uninstall),
    vscode.commands.registerCommand("skynex.doctor", doctor),
    vscode.commands.registerCommand("skynex.preview", () => run("update", { dryRun: true }).then((ok) => {
      if (ok) void vscode.window.showInformationMessage("Previsualización completada. No se modificaron archivos.");
      return ok;
    })),
    vscode.commands.registerCommand("skynex.refresh", () => dashboard.refresh()),
  );
}

export function deactivate(): void {
  output.dispose();
}
