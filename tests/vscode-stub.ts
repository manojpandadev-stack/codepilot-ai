/**
 * Minimal `vscode` API stub for unit tests.
 *
 * Lets extension-source modules that only touch SecretStorage/globalState/
 * Uri run under Vitest without a VS Code host. Tests that exercise real
 * VS Code behaviour still run inside the extension host (integration tests).
 *
 * Each test file can import this module and mutate the stores it exposes
 * to simulate VS Code state.
 */

export const inMemorySecrets = new Map<string, string>();
export const inMemoryState = new Map<string, unknown>();

/**
 * Per-test configuration overrides consumed by the stubbed
 * `workspace.getConfiguration`. Each dynamic re-import (after
 * `vi.resetModules()`) gets a fresh map, so overrides never leak between
 * isolated hosts. Production code is untouched.
 */
export const configOverrides = new Map<string, unknown>();

export class SecretStorageStub {
  async get(key: string): Promise<string | undefined> {
    return inMemorySecrets.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    inMemorySecrets.set(key, value);
  }
  async delete(key: string): Promise<void> {
    inMemorySecrets.delete(key);
  }
  onDidChange = () => ({ dispose() {} });
}

export class MementoStub {
  get<T>(key: string, fallback?: T): T | undefined {
    const v = inMemoryState.get(key);
    return v === undefined ? fallback : (v as T);
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      inMemoryState.delete(key);
    } else {
      inMemoryState.set(key, value);
    }
  }
  keys(): readonly string[] {
    return [...inMemoryState.keys()];
  }
  setKeysForSync(): void {}
}

export const secrets = new SecretStorageStub();
export const globalState = new MementoStub();
export const workspaceState = new MementoStub();

export const context = {
  secrets,
  globalState,
  workspaceState,
  subscriptions: [] as { dispose(): unknown }[],
  extensionPath: "/tmp/extension",
  extensionUri: { fsPath: "/tmp/extension" },
  globalStoragePath: "/tmp/extension-storage",
  globalStorageUri: { fsPath: "/tmp/extension-storage" },
  extensionMode: 1,
};

export namespace Uri {
  export function file(fsPath: string) {
    return { fsPath, toString: () => `file://${fsPath}` };
  }
  export function joinPath(base: { fsPath: string }, ...parts: string[]) {
    return file([base.fsPath.replace(/\/+$/, ""), ...parts].join("/"));
  }
}

export const commands = {
  registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
    registeredCommands.set(id, handler);
    return { dispose() {} };
  },
  executeCommand: async () => undefined,
};

/** Every command id registered via the stub (integration introspection). */
export const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

/** Every webview-view provider registered via the stub, keyed by view id. */
export const registeredViewProviders = new Map<string, unknown>();

function makeWebview(outbox: unknown[]) {
  return {
    html: "",
    options: {},
    cspSource: "stub-csp",
    postMessage: async (message: unknown) => {
      outbox.push(message);
      return true;
    },
    onDidReceiveMessage: () => ({ dispose() {} }),
    asWebviewUri: (uri: { fsPath: string }) => ({
      toString: () => `stub-webview://${uri.fsPath}`,
    }),
  };
}

export const window = {
  activeTextEditor: undefined,
  showErrorMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  showOpenDialog: async () => undefined,
  createOutputChannel: () => ({
    appendLine: () => {},
    show: () => {},
    dispose: () => {},
  }),
  registerWebviewViewProvider: (viewId: string, provider: unknown) => {
    registeredViewProviders.set(viewId, provider);
    return { dispose() {} };
  },
  createWebviewPanel: (
    _viewType: string,
    _title: string,
    _showOptions: unknown,
    _options?: unknown,
  ) => {
    const outbox: unknown[] = [];
    return {
      webview: makeWebview(outbox),
      reveal: () => {},
      dispose: () => {},
      onDidDispose: () => ({ dispose() {} }),
      __outbox: outbox,
    };
  },
};

export const workspace = {
  workspaceFolders: [] as { uri: { fsPath: string } }[],
  name: undefined,
  getConfiguration: () => ({
    // Test-controlled overrides (key → value). Falls back to the caller's
    // default when unset — mirrors getConfiguration(section).get(key, def).
    get: (k: string, d?: unknown) =>
      configOverrides.has(k) ? configOverrides.get(k) : d,
    update: async () => {},
  }),
  asRelativePath: (p: string | { fsPath: string }) =>
    typeof p === "string" ? p : p.fsPath,
  openTextDocument: async () => ({
    getText: () => "",
    uri: { fsPath: "" },
  }),
  fs: {
    stat: async () => ({ type: 1, size: 0 }),
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    createDirectory: async () => {},
    delete: async () => {},
  },
};

export const extensions = {
  getExtension: () => undefined,
};

export const languages = {
  getDiagnostics: () => [],
  onDidChangeDiagnostics: () => ({ dispose() {} }),
};

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
}

export enum ExtensionMode {
  Production = 1,
  Development = 2,
  Test = 3,
}

export const env = {
  appName: "stub",
};

export default {
  context,
  secrets,
  globalState,
  workspaceState,
  Uri,
  commands,
  window,
  workspace,
  env,
  extensions,
  languages,
  registeredCommands,
  registeredViewProviders,
  configOverrides,
  ConfigurationTarget,
  DiagnosticSeverity,
  ViewColumn,
  ExtensionMode,
};
