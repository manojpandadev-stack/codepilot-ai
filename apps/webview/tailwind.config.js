/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        vscode: {
          bg: "var(--vscode-sideBar-background, #252526)",
          fg: "var(--vscode-foreground, #cccccc)",
          border: "var(--vscode-panel-border, #3c3c3c)",
          "input-bg": "var(--vscode-input-background, #3c3c3c)",
          "input-fg": "var(--vscode-input-foreground, #cccccc)",
          "input-border": "var(--vscode-input-border, #3c3c3c)",
          btn: "var(--vscode-button-background, #0e639c)",
          "btn-fg": "var(--vscode-button-foreground, #ffffff)",
          "btn-hover": "var(--vscode-button-hoverBackground, #1177bb)",
          "text-link": "var(--vscode-textLink-foreground, #3794ff)",
          "error-fg": "var(--vscode-errorForeground, #f44747)",
          "warning-fg": "var(--vscode-warningForeground, #cca700)",
          "success-fg": "var(--vscode-successForeground, #89d185)",
          "badge-bg": "var(--vscode-badge-background, #4d4d4d)",
          "badge-fg": "var(--vscode-badge-foreground, #ffffff)",
          "quote-bg": "var(--vscode-textBlockQuote-background, #3c3c3c)",
          "editor-bg": "var(--vscode-editor-background, #1e1e1e)",
          desc: "var(--vscode-descriptionForeground, #999999)",
          "focus-border": "var(--vscode-focusBorder, #007fd4)",
          activity: "var(--vscode-activityBar-background, #333333)",
          title: "var(--vscode-sideBarTitle-foreground, #bbbbbb)",
        },
      },
      fontFamily: {
        mono: ["var(--vscode-editor-font-family, monospace)"],
      },
    },
  },
  plugins: [],
};
