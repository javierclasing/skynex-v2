# Skynex for Visual Studio Code

Shareable preview build of the Skynex VS Code extension.

## Build

```sh
pnpm install
pnpm --filter skynex-vscode build
pnpm --filter skynex-vscode package
```

Install the generated package locally:

```sh
code --install-extension apps/vscode/skynex-vscode-0.1.0.vsix
```

The extension uses the `skynex` executable from `PATH` by default. Configure
`skynex.cliPath` to use a specific executable. This preview is not published
to the Visual Studio Marketplace yet.
