window.JOURNEY_DATA = [
  {
    "n": 1,
    "id": "splash",
    "title": "Launch",
    "phase": "Start",
    "goal": "Recognize the app while it prepares the local session.",
    "detail": "A brief launch state. Returning users skip welcome and sign-in when their connection is valid.",
    "next": "welcome",
    "action": "Continue to welcome",
    "file": "assets/01-splash.png",
    "prompt": "prompts/01-splash.txt",
    "hotspots": []
  },
  {
    "n": 2,
    "id": "welcome",
    "title": "Welcome",
    "phase": "Start",
    "goal": "Understand the product and begin setup.",
    "detail": "Introduce directing LUMI, navigating the project, and reviewing work in one short screen.",
    "next": "signin",
    "action": "Get started",
    "file": "assets/02-welcome.png",
    "prompt": "prompts/02-welcome.txt",
    "hotspots": [
      {
        "label": "Get started",
        "to": "signin",
        "x": 40,
        "y": 72,
        "w": 20,
        "h": 6
      },
      {
        "label": "Use an existing connection",
        "to": "projects",
        "x": 42,
        "y": 79,
        "w": 26,
        "h": 5
      }
    ]
  },
  {
    "n": 3,
    "id": "signin",
    "title": "Sign in with ChatGPT",
    "phase": "Connect",
    "goal": "Connect the account through a clear browser-based entry point.",
    "detail": "Prototype-only handoff. No credentials are collected. Identity and permission to use the plan are separate.",
    "next": "browser",
    "action": "Sign in with ChatGPT",
    "back": "welcome",
    "file": "assets/03-signin.png",
    "prompt": "prompts/03-signin.txt",
    "hotspots": [
      {
        "label": "Sign in with ChatGPT",
        "to": "browser",
        "x": 33,
        "y": 44,
        "w": 34,
        "h": 6
      },
      {
        "label": "Use an existing connection",
        "to": "projects",
        "x": 38,
        "y": 67,
        "w": 24,
        "h": 6
      },
      {
        "label": "Back to welcome",
        "to": "welcome",
        "x": 1.5,
        "y": 6,
        "w": 7,
        "h": 5
      }
    ]
  },
  {
    "n": 4,
    "id": "browser",
    "title": "Browser handoff",
    "phase": "Connect",
    "goal": "Know that sign-in is waiting in the system browser.",
    "detail": "The walkthrough simulates the return from authorization. Retry and Cancel are explicit routes.",
    "next": "connected",
    "action": "Simulate authorized return",
    "back": "signin",
    "file": "assets/04-browser.png",
    "prompt": "prompts/04-browser.txt",
    "hotspots": [
      {
        "label": "Open browser again",
        "to": "@browserRetry",
        "x": 31,
        "y": 60,
        "w": 18,
        "h": 7
      },
      {
        "label": "Cancel sign-in",
        "to": "signin",
        "x": 51,
        "y": 60,
        "w": 18,
        "h": 7
      }
    ]
  },
  {
    "n": 5,
    "id": "connected",
    "title": "Connection ready",
    "phase": "Connect",
    "goal": "Confirm the authorized connection and make plan usage understandable.",
    "detail": "This illustrative branch assumes account verification and plan permission both succeeded. Identity-only sign-in stays separate.",
    "next": "projects",
    "action": "Open projects",
    "file": "assets/05-connected.png",
    "prompt": "prompts/05-connected.txt",
    "hotspots": [
      {
        "label": "Open projects",
        "to": "projects",
        "x": 33,
        "y": 71,
        "w": 34,
        "h": 6
      },
      {
        "label": "Use a different account",
        "to": "signin",
        "x": 33,
        "y": 76,
        "w": 34,
        "h": 6
      },
      {
        "label": "Manage usage",
        "to": "@usage",
        "x": 38,
        "y": 59,
        "w": 16,
        "h": 5
      }
    ]
  },
  {
    "n": 6,
    "id": "projects",
    "title": "Your projects",
    "phase": "Choose a project",
    "goal": "Open an existing folder or return to a recent project.",
    "detail": "A dedicated project area separates pinned and recent work. Returning users land here directly.",
    "next": "workspace",
    "action": "Open LUMI-NEW",
    "file": "assets/06-projects.png",
    "prompt": "prompts/06-projects.txt",
    "hotspots": [
      {
        "label": "Open existing workspace",
        "to": "folder",
        "x": 77,
        "y": 15,
        "w": 22,
        "h": 6
      },
      {
        "label": "Open pinned LUMI-NEW",
        "to": "workspace",
        "x": 22,
        "y": 28,
        "w": 76,
        "h": 9
      },
      {
        "label": "Open recent LUMI-NEW",
        "to": "workspace",
        "x": 22,
        "y": 44,
        "w": 76,
        "h": 9
      },
      {
        "label": "Manage connection",
        "to": "@account",
        "x": 2,
        "y": 92,
        "w": 17,
        "h": 6
      }
    ]
  },
  {
    "n": 7,
    "id": "folder",
    "title": "Open an existing workspace",
    "phase": "Choose a project",
    "goal": "Choose an existing directory through the native file picker.",
    "detail": "Opening a workspace points at its directory. It does not import, copy, or reorganize files.",
    "next": "workspace",
    "action": "Open Workspace",
    "back": "projects",
    "file": "assets/07-folder.png",
    "prompt": "prompts/07-folder.txt",
    "hotspots": [
      {
        "label": "Open Workspace",
        "to": "workspace",
        "x": 71.5,
        "y": 83.5,
        "w": 12.5,
        "h": 4.8
      },
      {
        "label": "Cancel folder selection",
        "to": "projects",
        "x": 61.5,
        "y": 83.5,
        "w": 10,
        "h": 4.8
      }
    ]
  },
  {
    "n": 8,
    "id": "workspace",
    "title": "Workspace overview",
    "phase": "Explore",
    "goal": "See the project structure and start a task without losing file context.",
    "detail": "IDE-style rail and hierarchical Explorer replace the ambiguous flat list. README opens as context; LUMI remains ready on the right.",
    "next": "symbols",
    "action": "Inspect WorkspaceWindow.swift",
    "file": "assets/08-workspace.png",
    "prompt": "prompts/08-workspace.txt",
    "hotspots": [
      {
        "label": "Inspect WorkspaceWindow.swift",
        "to": "symbols",
        "x": 10,
        "y": 30,
        "w": 16.5,
        "h": 4.3
      },
      {
        "label": "Projects",
        "to": "projects",
        "x": 0.4,
        "y": 78.6,
        "w": 5.1,
        "h": 7.8
      },
      {
        "label": "Account",
        "to": "@account",
        "x": 0.4,
        "y": 87,
        "w": 5.1,
        "h": 7.8
      }
    ]
  },
  {
    "n": 9,
    "id": "symbols",
    "title": "Files, classes, and methods",
    "phase": "Explore",
    "goal": "Follow the actual folder path, open a file, then jump to a class or method.",
    "detail": "Disk folders remain in Explorer. Class, property, initializer, and method symbols appear in the active file’s Outline.",
    "next": "approval",
    "action": "Ask LUMI to refine spacing",
    "file": "assets/09-symbols.png",
    "prompt": "prompts/09-symbols.txt",
    "hotspots": [
      {
        "label": "Ask LUMI to refine the sidebar",
        "to": "approval",
        "x": 93.4,
        "y": 86,
        "w": 5,
        "h": 5.5
      },
      {
        "label": "Inspect build method",
        "to": "@outline",
        "x": 6,
        "y": 83.6,
        "w": 20.2,
        "h": 4
      },
      {
        "label": "Back to project overview",
        "to": "workspace",
        "x": 7,
        "y": 58,
        "w": 18,
        "h": 4.3
      },
      {
        "label": "Projects",
        "to": "projects",
        "x": 0.4,
        "y": 79,
        "w": 5.1,
        "h": 7.2
      }
    ]
  },
  {
    "n": 10,
    "id": "approval",
    "title": "Review an operation",
    "phase": "Work and review",
    "goal": "Inspect a requested command before deciding whether it may run.",
    "detail": "Review is bound to one operation. Allow Once is neutral and never the default Return action.",
    "next": "changes",
    "action": "Allow once · simulated",
    "back": "symbols",
    "file": "assets/10-approval.png",
    "prompt": "prompts/10-approval.txt",
    "hotspots": [
      {
        "label": "Allow Once · simulated",
        "to": "changes",
        "x": 62.5,
        "y": 70.5,
        "w": 8.2,
        "h": 4.5
      },
      {
        "label": "Deny this operation",
        "to": "@deny",
        "x": 54.6,
        "y": 70.5,
        "w": 7,
        "h": 4.5
      },
      {
        "label": "Close review without deciding",
        "to": "@closeReview",
        "x": 29.5,
        "y": 70.5,
        "w": 7,
        "h": 4.5
      }
    ]
  },
  {
    "n": 11,
    "id": "changes",
    "title": "Inspect the changes",
    "phase": "Work and review",
    "goal": "Review changed files and recorded evidence before continuing.",
    "detail": "The diff names its baseline. Completion is separate from checks and review; no stage, commit, or Apply is implied.",
    "next": "sessions",
    "action": "Open session history",
    "file": "assets/11-changes.png",
    "prompt": "prompts/11-changes.txt",
    "hotspots": [
      {
        "label": "Session history",
        "to": "sessions",
        "x": 0.4,
        "y": 32.6,
        "w": 5.1,
        "h": 7.5
      },
      {
        "label": "Explorer",
        "to": "symbols",
        "x": 0.4,
        "y": 7.4,
        "w": 5.1,
        "h": 7.5
      },
      {
        "label": "Projects",
        "to": "projects",
        "x": 0.4,
        "y": 79,
        "w": 5.1,
        "h": 7.5
      }
    ]
  },
  {
    "n": 12,
    "id": "sessions",
    "title": "Return to previous work",
    "phase": "Work and review",
    "goal": "Find a recorded session, inspect its outcome, and continue deliberately.",
    "detail": "Returning users can open projects or inspect a prior run. Reading a session never silently resumes execution.",
    "next": "projects",
    "action": "Back to projects",
    "file": "assets/12-sessions.png",
    "prompt": "prompts/12-sessions.txt",
    "hotspots": [
      {
        "label": "View recorded output",
        "to": "@output",
        "x": 30,
        "y": 54,
        "w": 15.2,
        "h": 5.5
      },
      {
        "label": "Projects",
        "to": "projects",
        "x": 0.4,
        "y": 79,
        "w": 5.1,
        "h": 7.5
      },
      {
        "label": "Inspect changes",
        "to": "changes",
        "x": 0.4,
        "y": 23.6,
        "w": 5.1,
        "h": 7.5
      }
    ]
  }
];
