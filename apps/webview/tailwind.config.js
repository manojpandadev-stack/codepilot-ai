/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        vscode: {
          // Surfaces
          bg: "var(--vscode-sideBar-background, #252526)",
          panel: "var(--vscode-editor-background, #1e1e1e)",
          elevated: "var(--vscode-editorWidget-background, #252526)",
          "editor-bg": "var(--vscode-editor-background, #1e1e1e)",
          "quote-bg": "var(--vscode-textBlockQuote-background, #2b2b2b)",
          activity: "var(--vscode-activityBar-background, #333333)",
          // Text
          fg: "var(--vscode-foreground, #cccccc)",
          desc: "var(--vscode-descriptionForeground, #9d9d9d)",
          title: "var(--vscode-sideBarTitle-foreground, #bbbbbb)",
          "error-fg": "var(--vscode-errorForeground, #f44747)",
          "warning-fg": "var(--vscode-warningForeground, #cca700)",
          "success-fg": "var(--vscode-successForeground, #89d185)",
          "text-link": "var(--vscode-textLink-foreground, #3794ff)",
          "charts-blue": "var(--vscode-charts-blue, #3794ff)",
          "charts-yellow": "var(--vscode-charts-yellow, #cca700)",
          "testing-run": "var(--vscode-testing-iconRun, #73c991)",
          // Borders
          border: "var(--vscode-panel-border, #3c3c3c)",
          "focus-border": "var(--vscode-focusBorder, #007fd4)",
          // Inputs
          "input-bg": "var(--vscode-input-background, #3c3c3c)",
          "input-fg": "var(--vscode-input-foreground, #cccccc)",
          "input-border": "var(--vscode-input-border, #3c3c3c)",
          "input-placeholder":
            "var(--vscode-input-placeholderForeground, #989898)",
          // Buttons
          btn: "var(--vscode-button-background, #0e639c)",
          "btn-fg": "var(--vscode-button-foreground, #ffffff)",
          "btn-hover": "var(--vscode-button-hoverBackground, #1177bb)",
          btn2: "var(--vscode-secondaryButton-background, #3a3d41)",
          "btn2-hover": "var(--vscode-secondaryButton-hoverBackground, #45494e)",
          "btn2-fg": "var(--vscode-secondaryButton-foreground, #cccccc)",
          // Badges
          "badge-bg": "var(--vscode-badge-background, #4d4d4d)",
          "badge-fg": "var(--vscode-badge-foreground, #ffffff)",
          // Lists
          "list-hover": "var(--vscode-list-hoverBackground, #2a2d2e)",
          "list-active": "var(--vscode-list-activeSelectionBackground, #04395e)",
          "list-active-fg":
            "var(--vscode-list-activeSelectionForeground, #ffffff)",
        },
      },
      fontFamily: {
        mono: ["var(--vscode-editor-font-family, monospace)"],
      },
      fontSize: {
        "2xs": ["10px", "14px"],
      },
    },
  },
  plugins: [],
};
