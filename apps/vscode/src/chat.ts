import * as vscode from "vscode";

type ChatProvider = "ollama" | "openai" | "anthropic" | "gemini" | "openrouter";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export class SkynexChatProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly history: ChatMessage[] = [];

  constructor(private readonly secrets: vscode.SecretStorage) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(async (message: { type: string; text?: string; provider?: ChatProvider; model?: string; auto?: boolean }) => {
      if (message.type === "send" && message.text?.trim()) await this.send(message.text.trim());
      if (message.type === "save-config" && message.provider && message.model) {
        await vscode.workspace.getConfiguration("skynex").update("chat.provider", message.provider, vscode.ConfigurationTarget.Global);
        await vscode.workspace.getConfiguration("skynex").update("chat.model", message.model, vscode.ConfigurationTarget.Global);
        if (message.provider !== "ollama") {
          const key = await vscode.window.showInputBox({ prompt: `${message.provider} API key`, password: true, ignoreFocusOut: true });
          if (key) await this.secrets.store(`skynex.${message.provider}Key`, key);
        }
      }
      if (message.type === "configure-openai") await this.configureOpenAI();
      if (message.type === "toggle-auto" && typeof message.auto === "boolean") await vscode.workspace.getConfiguration("skynex").update("chat.auto", message.auto, vscode.ConfigurationTarget.Global);
    });
  }

  private async configureOpenAI(): Promise<void> {
    const key = await vscode.window.showInputBox({ title: "Configurar OpenAI", prompt: "Pega tu API key de OpenAI", password: true, ignoreFocusOut: true });
    if (!key) return;
    await this.secrets.store("skynex.openaiKey", key);
    const response = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` } });
    if (!response.ok) throw new Error(`OpenAI rechazó la clave (HTTP ${response.status}).`);
    const data = await response.json() as { data?: Array<{ id?: string }> };
    const models = (data.data ?? []).map((item) => item.id).filter((id): id is string => Boolean(id)).filter((id) => id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3")).sort();
    if (!models.length) throw new Error("OpenAI no devolvió modelos compatibles.");
    const selected = await vscode.window.showQuickPick(["auto", ...models], { title: "Modelo OpenAI", placeHolder: "Selecciona un modelo o usa Auto" });
    if (!selected) return;
    await vscode.workspace.getConfiguration("skynex").update("chat.provider", "openai", vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration("skynex").update("chat.model", selected === "auto" ? models[0] : selected, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration("skynex").update("chat.auto", selected === "auto", vscode.ConfigurationTarget.Global);
    this.post({ type: "config", model: selected, auto: selected === "auto" });
  }

  private async send(text: string): Promise<void> {
    this.history.push({ role: "user", content: text });
    this.post({ type: "user", text });
    this.post({ type: "status", text: "Skynex está pensando..." });
    try {
      const config = vscode.workspace.getConfiguration("skynex");
      const provider = config.get<ChatProvider>("chat.provider", "ollama");
      const model = config.get<string>("chat.model", provider === "ollama" ? "llama3.2" : provider === "gemini" ? "gemini-2.0-flash" : "gpt-4o-mini");
      const auto = config.get<boolean>("chat.auto", false);
      const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
      const system = `Eres Skynex, un asistente de programación dentro de VS Code. Usa el agente solicitado si se indica. Workspace: ${workspace}. Sé preciso y práctico.`;
      const answer = await this.complete(provider, auto ? "auto" : model, system);
      this.history.push({ role: "assistant", content: answer });
      this.post({ type: "assistant", text: answer });
    } catch (error) {
      this.post({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.post({ type: "status", text: "" });
    }
  }

  private async ollama(model: string, system: string): Promise<string> {
    const response = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: false, messages: [{ role: "system", content: system }, ...this.history] }),
    });
    if (!response.ok) throw new Error(`Ollama no está disponible (${response.status}). Inicia Ollama y descarga el modelo '${model}'.`);
    const data = await response.json() as { message?: { content?: string } };
    return data.message?.content ?? "El modelo no devolvió una respuesta.";
  }

  private async openai(model: string, system: string): Promise<string> {
    return this.openAICompatible("openai", "https://api.openai.com/v1/chat/completions", model, system);
  }

  private async openAICompatible(provider: string, endpoint: string, model: string, system: string): Promise<string> {
    const key = await this.secrets.get(`skynex.${provider}Key`);
    if (!key) throw new Error(`Configura la clave de ${provider} desde 'Configurar modelo'.`);
    const response = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: model === "auto" ? "gpt-4o-mini" : model, messages: [{ role: "system", content: system }, ...this.history] }),
    });
    if (!response.ok) throw new Error(`OpenAI devolvió HTTP ${response.status}.`);
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? "El modelo no devolvió una respuesta.";
  }

  private async complete(provider: ChatProvider, model: string, system: string): Promise<string> {
    if (provider === "ollama") return this.ollama(model, system);
    if (provider === "openai") return this.openai(model, system);
    if (provider === "openrouter") return this.openAICompatible("openrouter", "https://openrouter.ai/api/v1/chat/completions", model, system);
    if (provider === "anthropic") {
      const key = await this.secrets.get("skynex.anthropicKey");
      if (!key) throw new Error("Configura la clave de Anthropic desde 'Configurar modelo'.");
      const response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: 2048, system, messages: this.history }) });
      if (!response.ok) throw new Error(`Anthropic devolvió HTTP ${response.status}.`);
      const data = await response.json() as { content?: Array<{ text?: string }> };
      return data.content?.[0]?.text ?? "El modelo no devolvió una respuesta.";
    }
    const key = await this.secrets.get("skynex.geminiKey");
    if (!key) throw new Error("Configura la clave de Gemini desde 'Configurar modelo'.");
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: this.history.map((item) => ({ role: item.role === "assistant" ? "model" : "user", parts: [{ text: item.content }] })) }) });
    if (!response.ok) throw new Error(`Gemini devolvió HTTP ${response.status}.`);
    const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "El modelo no devolvió una respuesta.";
  }

  private post(message: unknown): void { this.view?.webview.postMessage(message); }

  private html(webview: vscode.Webview): string {
    const nonce = Date.now().toString(36);
    return `<!doctype html><html lang="es"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>
      body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:10px}.messages{display:flex;flex-direction:column;gap:10px;margin-bottom:12px}.bubble{padding:8px 10px;border-radius:8px;white-space:pre-wrap;line-height:1.4}.user{background:var(--vscode-textBlockQuote-background);align-self:flex-end;max-width:90%}.assistant{background:var(--vscode-editor-inactiveSelectionBackground);max-width:95%}.error{color:var(--vscode-errorForeground)}textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:62px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:8px;border-radius:4px}button,select{margin-top:6px;padding:5px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:3px}select{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border)}.row{display:flex;gap:6px;align-items:center}.status{font-size:11px;opacity:.75;min-height:16px}.settings{border-top:1px solid var(--vscode-panel-border);margin-top:12px;padding-top:8px;font-size:12px}</style></head><body><div id="messages" class="messages"><div class="bubble assistant">Hola. Soy Skynex. Pídeme revisar, explicar o modificar tu código.</div></div><div class="status" id="status"></div><select id="agent"><option value="">Skynex general</option><option>coder</option><option>security</option><option>diagnostic-researcher</option><option>mentor</option><option>pr-reviewer</option></select><textarea id="input" placeholder="Escribe tu mensaje..."></textarea><div class="row"><button id="send">Enviar</button><button id="config">Conectar OpenAI</button></div><div class="settings"><label><input id="auto" type="checkbox"> Auto: elegir modelo automáticamente</label><button id="models">Cargar modelos OpenAI</button></div><script nonce="${nonce}">const vscode=acquireVsCodeApi(),messages=document.getElementById('messages'),input=document.getElementById('input'),agent=document.getElementById('agent');function add(c,t){const d=document.createElement('div');d.className='bubble '+c;d.textContent=t;messages.appendChild(d);d.scrollIntoView()}document.getElementById('send').onclick=()=>{let t=input.value.trim();if(!t)return;const a=agent.value;t=a?'['+a+'] '+t:t;vscode.postMessage({type:'send',text:t});input.value=''};input.onkeydown=e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();document.getElementById('send').click()}};document.getElementById('config').onclick=()=>vscode.postMessage({type:'configure-openai'});document.getElementById('models').onclick=()=>vscode.postMessage({type:'configure-openai'});document.getElementById('auto').onchange=e=>vscode.postMessage({type:'toggle-auto',auto:e.target.checked});window.addEventListener('message',e=>{const m=e.data;if(m.type==='user')add('user',m.text);if(m.type==='assistant')add('assistant',m.text);if(m.type==='error')add('error',m.text);if(m.type==='status')document.getElementById('status').textContent=m.text;if(m.type==='config'){document.getElementById('auto').checked=m.auto}})</script></body></html>`;
  }
}
