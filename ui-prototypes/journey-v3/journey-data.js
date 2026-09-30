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
    "title": "Start with a conversation",
    "phase": "Talk to LUMI",
    "goal": "Describe the task in the central conversation.",
    "detail": "Chat and its composer lead. Projects and conversations stay on the left; supporting task context stays on the right.",
    "next": "symbols",
    "action": "Ask about the layout",
    "file": "assets/08-workspace.png",
    "prompt": "prompts/08-workspace.txt",
    "approved": false,
    "hotspots": [
      {
        "label": "Projects",
        "to": "projects",
        "x": 1,
        "y": 86,
        "w": 16,
        "h": 5
      },
      {
        "label": "Account",
        "to": "@account",
        "x": 1,
        "y": 91.5,
        "w": 16,
        "h": 5
      },
      {
        "label": "New conversation",
        "to": "workspace",
        "x": 1,
        "y": 13.5,
        "w": 16,
        "h": 6
      },
      {
        "label": "Preview walkthrough",
        "to": "working",
        "x": 73,
        "y": 12.5,
        "w": 8.7,
        "h": 4.5
      },
      {
        "label": "Preview recent changes",
        "to": "changes",
        "x": 81.8,
        "y": 12.5,
        "w": 7,
        "h": 4.5
      },
      {
        "label": "Preview code context",
        "to": "symbols",
        "x": 89,
        "y": 12.5,
        "w": 6.5,
        "h": 4.5
      },
      {
        "label": "Browse code context",
        "to": "symbols",
        "x": 92,
        "y": 42.5,
        "w": 7,
        "h": 5
      },
      {
        "label": "Ask about the layout",
        "to": "symbols",
        "x": 62.8,
        "y": 87,
        "w": 7.7,
        "h": 5
      },
      {
        "label": "Open previous conversation",
        "to": "sessions",
        "x": 0.5,
        "y": 24.5,
        "w": 17,
        "h": 6
      }
    ]
  },
  {
    "n": 9,
    "id": "symbols",
    "title": "Conversation with code context",
    "phase": "Talk to LUMI",
    "goal": "Ask a question and inspect the relevant file without leaving the conversation.",
    "detail": "The agent explains in the center. The right Code tab holds folders, classes, methods, and a read-only preview.",
    "next": "approval",
    "action": "Ask LUMI to refine spacing",
    "file": "assets/09-symbols.png",
    "prompt": "prompts/09-symbols.txt",
    "approved": false,
    "hotspots": [
      {
        "label": "Projects",
        "to": "projects",
        "x": 1,
        "y": 86,
        "w": 16,
        "h": 5
      },
      {
        "label": "Account",
        "to": "@account",
        "x": 1,
        "y": 91.5,
        "w": 16,
        "h": 5
      },
      {
        "label": "New conversation",
        "to": "workspace",
        "x": 1,
        "y": 13.5,
        "w": 16,
        "h": 6
      },
      {
        "label": "Preview walkthrough",
        "to": "working",
        "x": 71,
        "y": 12.5,
        "w": 8.7,
        "h": 4.5
      },
      {
        "label": "Preview recent changes",
        "to": "changes",
        "x": 79.8,
        "y": 12.5,
        "w": 7,
        "h": 4.5
      },
      {
        "label": "Preview code context",
        "to": "symbols",
        "x": 87,
        "y": 12.5,
        "w": 6.5,
        "h": 4.5
      },
      {
        "label": "Send the spacing request",
        "to": "approval",
        "x": 59.5,
        "y": 86.5,
        "w": 8.5,
        "h": 6
      },
      {
        "label": "Inspect build method",
        "to": "@outline",
        "x": 73,
        "y": 54,
        "w": 24,
        "h": 3.5
      },
      {
        "label": "Manage usage",
        "to": "@usage",
        "x": 30,
        "y": 88.5,
        "w": 15,
        "h": 4
      }
    ]
  },
  {
    "n": 10,
    "id": "approval",
    "title": "A decision in the conversation",
    "phase": "Work together",
    "goal": "See why an operation is needed and decide within the conversation.",
    "detail": "The approval stays beside the agent’s request. The right walkthrough records that work is waiting for the user.",
    "next": "working",
    "action": "Allow once · simulated",
    "file": "assets/10-approval.png",
    "prompt": "prompts/10-approval-refinement.txt",
    "approved": false,
    "hotspots": [
      {
        "label": "Projects",
        "to": "projects",
        "x": 1,
        "y": 86,
        "w": 16,
        "h": 5
      },
      {
        "label": "Account",
        "to": "@account",
        "x": 1,
        "y": 91.5,
        "w": 16,
        "h": 5
      },
      {
        "label": "New conversation",
        "to": "workspace",
        "x": 1,
        "y": 13.5,
        "w": 16,
        "h": 6
      },
      {
        "label": "Allow Once · simulated",
        "to": "working",
        "x": 59.3,
        "y": 62.2,
        "w": 8.5,
        "h": 4.7
      },
      {
        "label": "Deny this operation",
        "to": "@deny",
        "x": 51,
        "y": 62.2,
        "w": 7.5,
        "h": 4.7
      },
      {
        "label": "Close review without deciding",
        "to": "@closeReview",
        "x": 26.3,
        "y": 62.2,
        "w": 7.3,
        "h": 4.7
      }
    ]
  },
  {
    "n": 11,
    "id": "working",
    "title": "Follow the agent’s work",
    "phase": "Work together",
    "goal": "Stay in the conversation while a clear walkthrough shows what is happening.",
    "detail": "The center carries intent, updates, and follow-up instructions. The right panel shows observable steps, touched files, and recent changes.",
    "next": "changes",
    "action": "Preview the finished result",
    "file": "assets/11-working.png",
    "prompt": "prompts/11-working.txt",
    "approved": false,
    "hotspots": [
      {
        "label": "Projects",
        "to": "projects",
        "x": 1,
        "y": 86,
        "w": 16,
        "h": 5
      },
      {
        "label": "Account",
        "to": "@account",
        "x": 1,
        "y": 91.5,
        "w": 16,
        "h": 5
      },
      {
        "label": "New conversation",
        "to": "workspace",
        "x": 1,
        "y": 13.5,
        "w": 16,
        "h": 6
      },
      {
        "label": "Preview walkthrough",
        "to": "working",
        "x": 74,
        "y": 12.5,
        "w": 8.7,
        "h": 4.5
      },
      {
        "label": "Preview recent changes",
        "to": "changes",
        "x": 82.8,
        "y": 12.5,
        "w": 7,
        "h": 4.5
      },
      {
        "label": "Preview code context",
        "to": "symbols",
        "x": 90,
        "y": 12.5,
        "w": 6.5,
        "h": 4.5
      },
      {
        "label": "Queue a follow-up · simulated",
        "to": "@queue",
        "x": 64.5,
        "y": 87.5,
        "w": 7.4,
        "h": 5
      },
      {
        "label": "Stop & Send · explanation",
        "to": "@stopSend",
        "x": 54.3,
        "y": 87.5,
        "w": 9.8,
        "h": 5
      },
      {
        "label": "Stop · explanation",
        "to": "@stop",
        "x": 65.5,
        "y": 8,
        "w": 6.6,
        "h": 4.8
      },
      {
        "label": "Preview code context",
        "to": "symbols",
        "x": 75,
        "y": 52.3,
        "w": 23.5,
        "h": 10
      },
      {
        "label": "Read activity details",
        "to": "@activity",
        "x": 24.5,
        "y": 39,
        "w": 46.5,
        "h": 5.5
      }
    ]
  },
  {
    "n": 12,
    "id": "changes",
    "title": "Discuss and review the result",
    "phase": "Review and return",
    "goal": "Understand the outcome in chat, then inspect the supporting changes.",
    "detail": "The result and next instruction stay central. The right Changes panel provides a file list, explicit comparison baseline, and read-only diff.",
    "next": "sessions",
    "action": "Open the saved conversation",
    "file": "assets/12-changes.png",
    "prompt": "prompts/12-changes.txt",
    "approved": false,
    "hotspots": [
      {
        "label": "Projects",
        "to": "projects",
        "x": 1,
        "y": 86,
        "w": 16,
        "h": 5
      },
      {
        "label": "Account",
        "to": "@account",
        "x": 1,
        "y": 91.5,
        "w": 16,
        "h": 5
      },
      {
        "label": "New conversation",
        "to": "workspace",
        "x": 1,
        "y": 13.5,
        "w": 16,
        "h": 6
      },
      {
        "label": "Preview walkthrough",
        "to": "working",
        "x": 73,
        "y": 12.5,
        "w": 8.7,
        "h": 4.5
      },
      {
        "label": "Preview recent changes",
        "to": "changes",
        "x": 81.8,
        "y": 12.5,
        "w": 7,
        "h": 4.5
      },
      {
        "label": "Preview code context",
        "to": "symbols",
        "x": 89,
        "y": 12.5,
        "w": 6.5,
        "h": 4.5
      },
      {
        "label": "Preview asking for checks",
        "to": "@checks",
        "x": 62.3,
        "y": 87.5,
        "w": 7.8,
        "h": 5
      },
      {
        "label": "Inspect change details",
        "to": "@diff",
        "x": 73,
        "y": 41.5,
        "w": 26,
        "h": 45
      },
      {
        "label": "Open saved conversation",
        "to": "sessions",
        "x": 0.5,
        "y": 23.5,
        "w": 17,
        "h": 6
      }
    ]
  },
  {
    "n": 13,
    "id": "sessions",
    "title": "Return to a conversation",
    "phase": "Review and return",
    "goal": "Resume the human–agent thread with its previous work and evidence in context.",
    "detail": "Conversation history replaces a detached run-log screen. Selecting a previous thread is read-only until the user explicitly sends a follow-up.",
    "next": "projects",
    "action": "Back to projects",
    "file": "assets/13-sessions.png",
    "prompt": "prompts/13-sessions.txt",
    "approved": false,
    "hotspots": [
      {
        "label": "Projects",
        "to": "projects",
        "x": 1,
        "y": 86,
        "w": 16,
        "h": 5
      },
      {
        "label": "Account",
        "to": "@account",
        "x": 1,
        "y": 91.5,
        "w": 16,
        "h": 5
      },
      {
        "label": "New conversation",
        "to": "workspace",
        "x": 1,
        "y": 13.5,
        "w": 16,
        "h": 6
      },
      {
        "label": "Preview walkthrough",
        "to": "working",
        "x": 74,
        "y": 12.5,
        "w": 8.7,
        "h": 4.5
      },
      {
        "label": "Preview recent changes",
        "to": "changes",
        "x": 82.8,
        "y": 12.5,
        "w": 7,
        "h": 4.5
      },
      {
        "label": "Preview code context",
        "to": "symbols",
        "x": 90,
        "y": 12.5,
        "w": 6.5,
        "h": 4.5
      },
      {
        "label": "View recorded output",
        "to": "@output",
        "x": 75,
        "y": 66.4,
        "w": 23.8,
        "h": 5.3
      },
      {
        "label": "Start a follow-up · simulated",
        "to": "@followup",
        "x": 64.2,
        "y": 88.2,
        "w": 7.6,
        "h": 4.8
      }
    ]
  }
];
